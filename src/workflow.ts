import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { audit } from "./db";
import {
  attachWorkerDomain,
  disconnectConnectionIfIdle,
  getConnection,
  getValidCloudflareAuth,
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
          await disconnectConnectionIfIdle(this.env, deployment.oauth_connection_id, deployment.id);
        } catch {
          // Credential cleanup is retried by the expiry cron for temporary scoped API tokens.
        }
        try {
          await notify(this.env, deployment, "عملیات خودکار V13 ناموفق بود و دسترسی موقت در صورت نبود کار فعال دیگر پاک شد. برای تلاش مجدد، اتصال تازه بسازید.");
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
      const auth = await getValidCloudflareAuth(this.env, connection);
      await verifyZoneOwnership(auth, deployment.zone_id, deployment.account_id);
      const dnsRecordId = await upsertARecord(auth, deployment.zone_id, deployment.node_hostname, deployment.vps_ipv4);
      return { dnsRecordId };
    });
    await step.do("deploy private pending data plane", STEP_CONFIG, async () => {
      const connection = await getConnection(this.env, deployment.oauth_connection_id);
      const auth = await getValidCloudflareAuth(this.env, connection);
      await uploadWorkerScript(auth, deployment.account_id, deployment.worker_name, DATA_PLANE_SOURCE, {
        SUB_TOKEN_HASH: deployment.subscription_token_hash,
        CONFIG_BUNDLE: JSON.stringify(buildPendingBundle(deployment)),
      });
      await attachWorkerDomain(auth, deployment.account_id, deployment.zone_id, deployment.worker_hostname, deployment.worker_name);
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
      const auth = await getValidCloudflareAuth(this.env, connection);
      await uploadWorkerScript(auth, current.account_id, current.worker_name, DATA_PLANE_SOURCE, {
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
    try {
      const disconnected = await step.do("erase temporary Cloudflare access", STEP_CONFIG, async () => {
        return disconnectConnectionIfIdle(this.env, deployment.oauth_connection_id, deployment.id);
      });
      if (disconnected) await notify(this.env, deployment, "نسخهٔ موقت و رمز‌شدهٔ Cloudflare API Token از V13 پاک شد؛ Token اصلی در Cloudflare حذف نشده است.");
    } catch (error) {
      await audit(this.env, {
        tenantId: deployment.tenant_id,
        actorType: "workflow",
        action: "cloudflare.connection.auto_disconnect",
        resourceType: "cloudflare_connection",
        resourceId: deployment.oauth_connection_id,
        outcome: "failure",
        metadata: { errorType: error instanceof Error ? error.name : "unknown" },
      });
      await notify(this.env, deployment, "سرویس آماده است، اما قطع خودکار Cloudflare ناموفق بود. از دکمهٔ «قطع دسترسی» در پنل استفاده کنید.");
    }
    return { status: "ready" };
  }

  private async revoke(deployment: DeploymentRow, step: WorkflowStep): Promise<{ status: string }> {
    const replacementHash = await step.do("invalidate subscription credential", async () => sha256(randomToken(32)));
    await step.do("disable data plane", STEP_CONFIG, async () => {
      const connection = await getConnection(this.env, deployment.oauth_connection_id);
      const auth = await getValidCloudflareAuth(this.env, connection);
      await uploadWorkerScript(auth, deployment.account_id, deployment.worker_name, DATA_PLANE_SOURCE, {
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
    try {
      await step.do("erase temporary Cloudflare access", STEP_CONFIG, async () => {
        return disconnectConnectionIfIdle(this.env, deployment.oauth_connection_id, deployment.id);
      });
    } catch (error) {
      await audit(this.env, {
        tenantId: deployment.tenant_id,
        actorType: "workflow",
        action: "cloudflare.connection.auto_disconnect",
        resourceType: "cloudflare_connection",
        resourceId: deployment.oauth_connection_id,
        outcome: "failure",
        metadata: { errorType: error instanceof Error ? error.name : "unknown" },
      });
    }
    return { status: "revoked" };
  }
}
