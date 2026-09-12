import { completeBootstrap, receiveAgentReport, serveBootstrap } from "./agent";
import { purgeExpiredCleanIpReports } from "./clean-ip";
import { purgeExpiredMapReports } from "./censorship-map";
import { purgeExpiredDonations } from "./ai-donate";
import {
  parseMtuReport,
  parsePoisonReport,
  purgeExpiredMtuReports,
  purgeExpiredPoisonReports,
  recordMtuReport,
  recordPoisonReport,
  renderDnsTestScript,
} from "./dns-poison";
import {
  buildDomainRuleSet,
  directRaceDomains,
  parseRaceReport,
  purgeExpiredRaceReports,
  recordRaceReport,
} from "./domestic-race";
import { buildRuleSet, currentIrRanges, purgeOldRirSnapshots, refreshGeoipIr } from "./geoip-ir";
import { purgeExpiredEdgeProbes, runEdgeProbes } from "./net-mode";
import { enableDnsTunnel } from "./dns-tunnel";
import { queueSleeperCommand, publishSleeperBeacon, setDeploymentRole } from "./sleeper";
import type { SleeperCommand } from "./sleeper";
import {
  cleanIpFeed,
  mapFeed,
  submitCleanIpReport,
  submitMapReport,
  whiteHoleReader,
} from "./telemetry-routes";
import { purgeExpiredWhiteHoleDrops } from "./whitehole";
import { authenticated, loginFromOneTimeLink, loginRateLimit, logout } from "./auth";
import { rateLimit } from "./db";
import { sha256 } from "./security";
import { eraseExpiredApiTokens } from "./cloudflare-api";
import { appPage, landingPage, legalPage, logoSvg, omniPage } from "./dashboard";
import {
  createDeployment,
  getDeployment,
  listDeployments,
  retryDeployment,
  revokeDeployment,
  rotateBootstrapToken,
  rotateSubscriptionToken,
} from "./deployments";
import { createTemporaryApiTokenConnection } from "./api-token";
import { HttpError, json, methodNotAllowed, readJson, requireSameOrigin } from "./http";
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
  if (path === "/api/v1/telemetry/clean-ip") {
    const wrongMethod = only(request, ["POST"]);
    return wrongMethod ?? submitCleanIpReport(request, env);
  }
  if (path === "/api/v1/clean-ip") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? cleanIpFeed(request, env);
  }
  if (path === "/api/v1/telemetry/map") {
    const wrongMethod = only(request, ["POST"]);
    return wrongMethod ?? submitMapReport(request, env);
  }
  if (path === "/api/v1/map") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? mapFeed(request, env);
  }
  if (path === "/api/v1/whitehole/fetch.sh") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? whiteHoleReader(request, env);
  }
  if (path === "/api/v1/dns-test.sh") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    return new Response(renderDnsTestScript(new URL(env.PUBLIC_BASE_URL).origin), {
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    });
  }
  if (path === "/api/v1/telemetry/dns-poison") {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const allowed = await rateLimit(env, `poison:${await sha256(ip)}`, 10, 3_600);
    if (!allowed) throw new HttpError(429, "rate_limited", "Too many poison reports");
    const report = parsePoisonReport(await readJson<unknown>(request, 32_768));
    const verdict = await recordPoisonReport(env, report);
    return json(verdict);
  }
  if (path === "/api/v1/telemetry/mtu") {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const allowed = await rateLimit(env, `mtu:${await sha256(ip)}`, 20, 3_600);
    if (!allowed) throw new HttpError(429, "rate_limited", "Too many MTU reports");
    await recordMtuReport(env, parseMtuReport(await readJson<unknown>(request, 4_096)));
    return json({ ok: true });
  }
  if (path === "/api/v1/geoip-ir.json") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    const cidrs = await currentIrRanges(env);
    return new Response(JSON.stringify(buildRuleSet(cidrs)), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }
  if (path === "/api/v1/telemetry/race") {
    const wrongMethod = only(request, ["POST"]);
    if (wrongMethod) return wrongMethod;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const allowed = await rateLimit(env, `race:${await sha256(ip)}`, 60, 3_600);
    if (!allowed) throw new HttpError(429, "rate_limited", "Too many race reports");
    await recordRaceReport(env, parseRaceReport(await readJson<unknown>(request, 4_096)));
    return json({ ok: true });
  }
  if (path === "/api/v1/race-direct.json") {
    const wrongMethod = only(request, ["GET"]);
    if (wrongMethod) return wrongMethod;
    return new Response(JSON.stringify(buildDomainRuleSet(await directRaceDomains(env))), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
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
  if (path === "/omni") {
    const wrongMethod = only(request, ["GET"]);
    return wrongMethod ?? omniPage(env);
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

  const deploymentMatch = /^\/api\/v1\/deployments\/([0-9a-f-]{36})(?:\/(bootstrap-token|subscription-token|retry|revoke|dns-tunnel|role|beacon|sleeper-command))?$/u.exec(path);
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
    if (action === "subscription-token") return rotateSubscriptionToken(request, env, principal, deploymentId);
    if (action === "retry") return retryDeployment(request, env, principal, deploymentId);
    if (action === "revoke") return revokeDeployment(request, env, principal, deploymentId);
    if (action === "dns-tunnel") {
      const result = await enableDnsTunnel(env, principal, deploymentId);
      return json(result);
    }
    if (action === "role") {
      const body = await readJson<{ role?: unknown; consent?: unknown }>(request, 2_048);
      const role = body.role === "sleeper" ? "sleeper" : body.role === "standard" ? "standard" : null;
      if (!role) throw new HttpError(400, "invalid_input", "role must be standard or sleeper");
      const updated = await setDeploymentRole(env, principal, deploymentId, role, body.consent === true);
      return json({ ok: true, role: updated.role });
    }
    if (action === "beacon") {
      const name = await publishSleeperBeacon(env, principal, deploymentId);
      return json({ ok: true, record: name });
    }
    const body = await readJson<{ command?: unknown }>(request, 1_024);
    const command: SleeperCommand | null =
      body.command === "wake" || body.command === "report-now" ? body.command : null;
    if (!command) throw new HttpError(400, "invalid_input", "command must be report-now or wake");
    await queueSleeperCommand(env, principal, deploymentId, command);
    return json({ ok: true });
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
    const [cleanIp, map, drops, donations, poison, mtu, probes, race] = await Promise.all([
      purgeExpiredCleanIpReports(env),
      purgeExpiredMapReports(env),
      purgeExpiredWhiteHoleDrops(env),
      purgeExpiredDonations(env),
      purgeExpiredPoisonReports(env),
      purgeExpiredMtuReports(env),
      purgeExpiredEdgeProbes(env),
      purgeExpiredRaceReports(env),
    ]);
    if (cleanIp + map + drops + donations + poison + mtu + probes + race > 0) {
      console.log("telemetry_purged", { cleanIp, map, drops, donations, poison, mtu, probes, race });
    }
    const probed = await runEdgeProbes(env);
    if (probed > 0) console.log("edge_probes_run", { count: probed });
    const rir = await refreshGeoipIr(env);
    if (rir.updated) console.log("rir_snapshot_refreshed", { added: rir.added, removed: rir.removed, sha256: rir.sha256 });
    const pruned = await purgeOldRirSnapshots(env);
    if (pruned > 0) console.log("rir_snapshots_pruned", { count: pruned });
  },
};
