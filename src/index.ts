import { completeBootstrap, receiveAgentReport, serveBootstrap } from "./agent";
import { authenticated, loginFromOneTimeLink, loginRateLimit, logout } from "./auth";
import { eraseExpiredApiTokens } from "./cloudflare-api";
import { appPage, landingPage, legalPage, logoSvg } from "./dashboard";
import {
  createDeployment,
  getDeployment,
  listDeployments,
  retryDeployment,
  revokeDeployment,
  rotateBootstrapToken,
} from "./deployments";
import { createTemporaryApiTokenConnection } from "./api-token";
import { HttpError, json, methodNotAllowed, requireSameOrigin } from "./http";
import {
  disconnectCloudflareConnection,
  listCloudflareAccounts,
  listCloudflareConnections,
  listCloudflareZones,
} from "./oauth";
import { handleTelegramWebhook } from "./telegram";
import type { Env } from "./types";
export { ProvisionWorkflow } from "./workflow";

function only(request: Request, methods: string[]): Response | null {
  return methods.includes(request.method) ? null : methodNotAllowed(methods);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? json({ ok: true, service: "v13-control-plane", version: 13 });
  }
  if (path === "/logo.svg") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? logoSvg();
  }
  if (path === "/telegram/webhook") {
    const wrongMethod = only(request, ["POST"]);
    return wrongMethod ?? handleTelegramWebhook(request, env);
  }
  if (path === "/api/v1/agent/bootstrap") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? serveBootstrap(request, env);
  }
  if (path === "/api/v1/agent/complete") {
    const wrongMethod = only(request, ["POST"]);
    return wrongMethod ?? completeBootstrap(request, env);
  }
  if (path === "/api/v1/agent/report") {
    const wrongMethod = only(request, ["POST"]);
    return wrongMethod ?? receiveAgentReport(request, env);
  }
  if (path === "/login") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    await loginRateLimit(request, env);
    return loginFromOneTimeLink(request, env);
  }
  if (path === "/") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? landingPage(env);
  }
  if (["/setwebhook", "/sub", "/profile", "/panel", "/api/login", "/api/users"].includes(path)) {
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  }
  if (path === "/privacy" || path === "/terms") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? legalPage(path === "/privacy" ? "privacy" : "terms");
  }
  if (path === "/oauth/cloudflare/start" || path === "/oauth/cloudflare/callback") {
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  }

  const principal = await authenticated(request, env);
  if (path === "/app") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? appPage(principal);
  }
  if (path === "/logout") {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    requireSameOrigin(request, env);
    return logout(request, env, principal);
  }
  if (path === "/api/v1/cloudflare/connections") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? listCloudflareConnections(env, principal);
  }
  if (path === "/api/v1/cloudflare/api-token") {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    requireSameOrigin(request, env);
    return createTemporaryApiTokenConnection(request, env, principal);
  }
  const disconnectMatch = /^\/api\/v1\/cloudflare\/connections\/([0-9a-f-]{36})\/disconnect$/u.exec(path);
  if (disconnectMatch?.[1]) {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    requireSameOrigin(request, env);
    return disconnectCloudflareConnection(request, env, principal, disconnectMatch[1]);
  }
  if (path === "/api/v1/cloudflare/accounts") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    const connectionId = url.searchParams.get("connectionId") ?? "";
    if (!/^[0-9a-f-]{36}$/u.test(connectionId)) throw new HttpError(400, "invalid_connection", "Connection ID is invalid");
    return listCloudflareAccounts(env, principal, connectionId);
  }
  if (path === "/api/v1/cloudflare/zones") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const accountId = url.searchParams.get("accountId") ?? "";
    if (!/^[0-9a-f-]{36}$/u.test(connectionId) || !/^[a-f0-9]{32}$/u.test(accountId)) {
      throw new HttpError(400, "invalid_cloudflare_resource", "Cloudflare resource ID is invalid");
    }
    return listCloudflareZones(env, principal, connectionId, accountId);
  }
  if (path === "/api/v1/deployments") {
    const wrongMethod = only(request, ["GET", "POST"]);
    if (wrongMethod) return wrongMethod;
    if (request.method === "GET") return listDeployments(env, principal);
    requireSameOrigin(request, env);
    return createDeployment(request, env, principal);
  }

  const deploymentMatch = /^\/api\/v1\/deployments\/([0-9a-f-]{36})(?:\/(bootstrap-token|retry|revoke))?$/u.exec(path);
  if (deploymentMatch?.[1]) {
    const deploymentId = deploymentMatch[1];
    const action = deploymentMatch[2];
    if (!action) {
      const wrongMethod = only(request, ["GET"]);
      return wrongMethod ?? getDeployment(env, principal, deploymentId);
    }
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    requireSameOrigin(request, env);
    if (action === "bootstrap-token") return rotateBootstrapToken(request, env, principal, deploymentId);
    if (action === "retry") return retryDeployment(request, env, principal, deploymentId);
    return revokeDeployment(request, env, principal, deploymentId);
  }

  return json({ error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      console.error("request_failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const erased = await eraseExpiredApiTokens(env);
    if (erased > 0) console.log("expired_api_tokens_erased", { count: erased });
  },
};
