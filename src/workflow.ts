import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { audit } from "./db";
import {
  attachWorkerDomain,
  getConnection,
  getValidAccessToken,
  uploadWorkerScript,
  upsertARecord,
  verifyZoneOwnership,
} from "./cloudflare-api";
import { DATA_PLANE_SOURCE } from "./data-plane-source";
import { buildPendingBundle, buildReadyBundle } from "./profiles";
import { decryptJson, nowIso, randomToken, sha256 } from "./security";
import { sendTelegramMessage } from "./telegram";
import type { DeploymentRow, Env, SecretBundle, WorkflowParams } from "./types";

const STEP_CONFIG = {
  retries: { limit: 5, delay: "5 seconds" as const, backoff: "exponential" as const },
  timeout: "3 minutes" as const,
};

async function loadDeployment(env: Env, deploymentId: string): Promise<DeploymentRow> {
  const deployment = await env.DB.prepare("SELECT * FROM deployments WHERE id = ?")
    .bind(deploymentId).first<DeploymentRow>();
  if (!deployment) throw new Error("Deployment not found");
  return deployment;
}

async function updateStatus(env: Env, deploymentId: string, status: string, detail: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE deployments SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?")
    .bind(status, detail, nowIso(), deploymentId).run();
}

async function telegramUserId(env: Env, tenantId: string): Promise<string | null> {
  const tenant = await env.DB.prepare("SELECT telegram_user_id FROM tenants WHERE id = ?")
    .bind(tenantId).first<{ telegram_user_id: string }>();
  return tenant?.telegram_user_id ?? null;
}

async function notify(env: Env, deployment: DeploymentRow, text: string): Promise<void> {
  const userId = await telegramUserId(env, deployment.tenant_id);
  if (userId) await sendTelegramMessage(env, userId, text);
}

export class ProvisionWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<{ status: string }> {
    const { action, deploymentId } = event.payload;
    let deployment: DeploymentRow | null = null;
    try {
      const loaded = await step.do("load deployment", async () => loadDeployment(this.env, deploymentId));
      deployment = loaded;
      if (action === "prepare") return await this.prepare(loaded, step);
      if (action === "finalize") return await this.finalize(loaded, step);
      return await this.revoke(loaded, step);
    } catch (error) {
      await updateStatus(this.env, deploymentId, "failed", `workflow_${action}_failed`);
      await audit(this.env, {
        tenantId: deployment?.tenant_id ?? null,
        actorType: "workflow",
        actorId: event.instanceId,
        action: `deployment.${action}`,
        resourceType: "deployment",
        resourceId: deploymentId,
        outcome: "failure",
        metadata: { errorType: error instanceof Error ? error.name : "unknown" },
      });
      if (deployment) {
        try {
          await notify(this.env, deployment, "عملیات خودکار V13 ناموفق بود. جزئیات امن در پنل ثبت شده است؛ از گزینهٔ تلاش مجدد استفاده کنید.");
        } catch {
          // Notification failure must not hide the provisioning failure.
        }
      }
      throw error;
    }
  }

  private async prepare(deployment: DeploymentRow, step: WorkflowStep): Promise<{ status: string }> {
    await step.do("mark preparing", async () => updateStatus(this.env, deployment.id, "preparing"));
    await step.do("verify zone and configure node DNS", STEP_CONFIG, async () => {
      const connection = await getConnection(this.env, deployment.oauth_connection_id);
      const token = await getValidAccessToken(this.env, connection);
      await verifyZoneOwnership(token, deployment.zone_id, deployment.account_id);
      const dnsRecordId = await upsertARecord(token, deployment.zone_id, deployment.node_hostname, deployment.vps_ipv4);
      return { dnsRecordId };
    });
    await step.do("deploy private pending data plane", STEP_CONFIG, async () => {
      const connection = await getConnection(this.env, deployment.oauth_connection_id);
      const token = await getValidAccessToken(this.env, connection);
      await uploadWorkerScript(token, deployment.account_id, deployment.worker_name, DATA_PLANE_SOURCE, {
        SUB_TOKEN_HASH: deployment.subscription_token_hash,
        CONFIG_BUNDLE: JSON.stringify(buildPendingBundle(deployment)),
      });
      await attachWorkerDomain(token, deployment.account_id, deployment.zone_id, deployment.worker_hostname, deployment.worker_name);
      return { sourceSha256: await sha256(DATA_PLANE_SOURCE) };
    });
    await step.do("mark awaiting node", async () => {
      await updateStatus(this.env, deployment.id, "awaiting_agent");
      await audit(this.env, {
        tenantId: deployment.tenant_id,
        actorType: "workflow",
        action: "deployment.prepare",
        resourceType: "deployment",
        resourceId: deployment.id,
        outcome: "success",
      });
      await notify(this.env, deployment, "مرحلهٔ Cloudflare با موفقیت انجام شد. اکنون اسکریپت یک‌بارمصرف VPS را از پنل دریافت، بررسی و اجرا کنید.");
    });
    return { status: "awaiting_agent" };
  }

  private async finalize(deployment: DeploymentRow, step: WorkflowStep): Promise<{ status: string }> {
    await step.do("mark finalizing", async () => updateStatus(this.env, deployment.id, "finalizing"));
    await step.do("publish validated protocol profiles", STEP_CONFIG, async () => {
      const current = await loadDeployment(this.env, deployment.id);
      if (!current.agent_token_hash) throw new Error("Agent bootstrap has not completed");
      const secretRow = await this.env.DB.prepare("SELECT bundle_enc FROM deployment_secrets WHERE deployment_id = ?")
        .bind(current.id).first<{ bundle_enc: string }>();
      if (!secretRow) throw new Error("Deployment secrets not found");
      const secrets = await decryptJson<SecretBundle>(secretRow.bundle_enc, this.env.TOKEN_ENCRYPTION_KEY, `deployment:${current.id}`);
      const connection = await getConnection(this.env, current.oauth_connection_id);
      const token = await getValidAccessToken(this.env, connection);
      await uploadWorkerScript(token, current.account_id, current.worker_name, DATA_PLANE_SOURCE, {
        SUB_TOKEN_HASH: current.subscription_token_hash,
        CONFIG_BUNDLE: JSON.stringify(buildReadyBundle(current, secrets)),
      });
      return { sourceSha256: await sha256(DATA_PLANE_SOURCE), protocols: ["vless-reality", "hysteria2"] };
    });
    await step.do("mark ready and notify", async () => {
      await updateStatus(this.env, deployment.id, "ready");
      await audit(this.env, {
        tenantId: deployment.tenant_id,
        actorType: "workflow",
        action: "deployment.finalize",
        resourceType: "deployment",
        resourceId: deployment.id,
        outcome: "success",
      });
      await notify(this.env, deployment, "V13 آماده است. لینک‌های خصوصی VLESS Reality و Hysteria2 فقط داخل پنل امن نمایش داده می‌شوند.");
    });
    return { status: "ready" };
  }

  private async revoke(deployment: DeploymentRow, step: WorkflowStep): Promise<{ status: string }> {
    const replacementHash = await step.do("invalidate subscription credential", async () => sha256(randomToken(32)));
    await step.do("disable data plane", STEP_CONFIG, async () => {
      const connection = await getConnection(this.env, deployment.oauth_connection_id);
      const token = await getValidAccessToken(this.env, connection);
      await uploadWorkerScript(token, deployment.account_id, deployment.worker_name, DATA_PLANE_SOURCE, {
        SUB_TOKEN_HASH: replacementHash,
        CONFIG_BUNDLE: JSON.stringify(buildPendingBundle(deployment)),
      });
    });
    await step.do("mark revoked", async () => {
      await this.env.DB.prepare(
        "UPDATE deployments SET status = 'revoked', status_detail = NULL, subscription_token_hash = ?, agent_token_hash = NULL, updated_at = ? WHERE id = ?",
      ).bind(replacementHash, nowIso(), deployment.id).run();
      await this.env.DB.prepare("DELETE FROM bootstrap_tokens WHERE deployment_id = ?").bind(deployment.id).run();
      await audit(this.env, {
        tenantId: deployment.tenant_id,
        actorType: "workflow",
        action: "deployment.revoke",
        resourceType: "deployment",
        resourceId: deployment.id,
        outcome: "success",
      });
      await notify(this.env, deployment, "دسترسی اشتراک V13 باطل شد. برای حذف سرویس از VPS، دستورهای پاک‌سازی داخل راهنمای عملیات را اجرا کنید.");
    });
    return { status: "revoked" };
  }
}
