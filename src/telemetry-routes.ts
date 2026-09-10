import { rateLimit } from "./db";
import { cleanIpFormatText, parseCleanIpReport, rankCleanIps, recordCleanIpReport } from "./clean-ip";
import { aggregateMap, parseMapReport, recordMapReport } from "./censorship-map";
import { HttpError, json, readJson, secureHeaders } from "./http";
import { sha256 } from "./security";
import { renderFetchScript, validateDropDomain } from "./whitehole";
import type { Env } from "./types";

/**
 * HTTP surface for the ported panel sections: the clean-IP radar and the live
 * censorship map both need a place where clients can publish measurements, and
 * clients inside a shutdown need the WhiteHole reader without any credentials.
 *
 * Everything here is anonymous, strictly validated and rate limited per IP by a
 * day-salted hash; no IP address is ever stored.
 */

async function telemetryBucket(request: Request, env: Env, kind: string, limit: number, windowSeconds: number): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `${kind}:${day}:${(await sha256(`${day}|${ip}`)).slice(0, 32)}`;
  if (!(await rateLimit(env, key, limit, windowSeconds))) {
    throw new HttpError(429, "rate_limited", "Too many telemetry reports from this address; try again later");
  }
}

export async function submitCleanIpReport(request: Request, env: Env): Promise<Response> {
  await telemetryBucket(request, env, "rum", 30, 3_600);
  const report = parseCleanIpReport(await readJson<unknown>(request, 2_048));
  await recordCleanIpReport(env, report);
  return json({
    ok: true,
    ip: report.ip,
    operator: report.operator,
    city: report.city,
    note: "Values are stored as client self-reports and merged with an exponential moving average.",
  }, 201);
}

export async function cleanIpFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  const ranking = await rankCleanIps(env, {
    operator: url.searchParams.get("operator") ?? "mci",
    city: url.searchParams.get("city") ?? "tehran",
    limit: Number(url.searchParams.get("limit") ?? "12") || 12,
  });
  if (format === "text") {
    return new Response(cleanIpFormatText(ranking), {
      headers: secureHeaders({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      }),
    });
  }
  return json({
    operator: ranking.operator.key,
    city: ranking.city.key,
    pool: ranking.poolSize,
    measured: ranking.measured,
    generatedAt: ranking.generatedAt,
    ranked: ranking.rows,
  }, 200, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
}

export async function submitMapReport(request: Request, env: Env): Promise<Response> {
  await telemetryBucket(request, env, "map", 20, 3_600);
  const report = parseMapReport(await readJson<unknown>(request, 2_048));
  await recordMapReport(env, report);
  return json({ ok: true, stored: "anonymous aggregate only", retention_hours: 24 }, 201);
}

export async function mapFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const windowHours = Math.min(24, Math.max(1, Number(url.searchParams.get("windowHours") ?? "6") || 6));
  return json(await aggregateMap(env, windowHours), 200, {
    "Cache-Control": "public, max-age=30",
    "Access-Control-Allow-Origin": "*",
  });
}

/** Public reassembler script for the tenant's own DNS dead-drop. */
export async function whiteHoleReader(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const domain = validateDropDomain(url.searchParams.get("domain") ?? "");
  await telemetryBucket(request, env, "wh-reader", 60, 3_600);
  return new Response(renderFetchScript(domain), {
    headers: secureHeaders({ "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "public, max-age=300" }),
  });
}
