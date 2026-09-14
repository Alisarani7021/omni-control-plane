import { nowIso } from "./security";
import type { Env } from "./types";

/**
 * Network-mode classification layer.
 *
 * Everything else in the "net intel" stack hangs off this sphere: two real
 * eyes are combined into one honest verdict per deployment.
 *
 *  - EDGE eye  : this Worker (Cloudflare edge) fetches the deployment's
 *                data-plane `/healthz` on every cron tick -> edge_probes.
 *                Answers "is my node reachable from outside?".
 *  - INNER eye : the VPS agent health report (agent_reports) plus
 *                deployments.last_seen_at. Answers "is the inside path alive?".
 *
 * Four network states plus an explicit no-data verdict (the repository never
 * guesses: unmeasured stays unmeasured).
 */

export type NetMode = "open" | "throttled" | "national-only" | "blackout" | "nodata";

export const NET_MODE_LABELS: Record<NetMode, string> = {
  open: "🟢 باز (لبه و داخل هر دو سالم)",
  throttled: "🟡 مختل (یک چشم degrader شده)",
  "national-only": "🇮🇷 فقط ملی (لبه بسته، داخل زنده)",
  blackout: "⚫ قطع کامل (هر دو چشم تاریک)",
  nodata: "⚪ بدون داده (هنوز اندازه‌گیری نشده)",
};

export const EDGE_PROBE_TIMEOUT_MS = 5_000;
export const EDGE_PROBE_RETENTION_HOURS = 24;
export const EDGE_WINDOW_HOURS = 6;
export const EDGE_OK_RATIO = 0.8;
export const EDGE_DEGRADED_RATIO = 0.4;
export const EDGE_SLOW_MS = 900;
export const EDGE_PROBES_PER_TICK = 20;

export interface EdgeProbeInput {
  okRatio: number;
  medianLatencyMs: number | null;
  samples: number;
}

export interface InnerProbeInput {
  alive: boolean;
  degraded: boolean;
}

/** Pure classification: documented thresholds, no hidden state. */
export function classifyNetMode(edge: EdgeProbeInput | null, inner: InnerProbeInput | null): NetMode {
  if (!edge || edge.samples === 0 || !inner) return "nodata";
  const edgeOk =
    edge.okRatio >= EDGE_OK_RATIO &&
    (edge.medianLatencyMs === null || edge.medianLatencyMs <= EDGE_SLOW_MS);
  const edgeDead = edge.okRatio < EDGE_DEGRADED_RATIO;
  if (inner.alive) {
    if (edgeDead) return "national-only";
    if (!edgeOk || inner.degraded) return "throttled";
    return "open";
  }
  return edgeDead ? "blackout" : "throttled";
}

export interface EdgeProbeOutcome {
  deploymentId: string;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
}

/** One honest edge probe: real fetch from the edge, real latency, no simulation. */
export async function probeDeploymentEdge(workerHostname: string, deploymentId: string): Promise<EdgeProbeOutcome> {
  const started = Date.now();
  try {
    const response = await fetch(`https://${workerHostname}/healthz`, {
      signal: AbortSignal.timeout(EDGE_PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    return { deploymentId, ok: response.ok, httpStatus: response.status, latencyMs };
  } catch {
    return { deploymentId, ok: false, httpStatus: null, latencyMs: null };
  }
}

export async function recordEdgeProbe(env: Env, outcome: EdgeProbeOutcome): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO edge_probes (id, deployment_id, ok, http_status, latency_ms, probed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    outcome.deploymentId,
    outcome.ok ? 1 : 0,
    outcome.httpStatus,
    outcome.latencyMs,
    nowIso(),
    new Date(now + EDGE_PROBE_RETENTION_HOURS * 3_600_000).toISOString(),
  ).run();
}

interface ReadyDeployment {
  id: string;
  worker_hostname: string;
}

/** Cron entry point: probe ready deployments (bounded per tick). */
export async function runEdgeProbes(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, worker_hostname FROM deployments WHERE status = 'ready' ORDER BY updated_at DESC LIMIT ?",
  ).bind(EDGE_PROBES_PER_TICK).all<ReadyDeployment>();
  const targets = rows.results ?? [];
  await Promise.all(
    targets.map(async (deployment) => {
      const outcome = await probeDeploymentEdge(deployment.worker_hostname, deployment.id);
      await recordEdgeProbe(env, outcome);
    }),
  );
  return targets.length;
}

export interface EdgeStats {
  samples: number;
  okRatio: number;
  medianLatencyMs: number | null;
}

export async function edgeStats(env: Env, deploymentId: string, windowHours = EDGE_WINDOW_HOURS): Promise<EdgeStats | null> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT ok, latency_ms FROM edge_probes WHERE deployment_id = ? AND probed_at > ? ORDER BY probed_at DESC",
  ).bind(deploymentId, since).all<{ ok: number; latency_ms: number | null }>();
  const results = rows.results ?? [];
  if (results.length === 0) return null;
  const okCount = results.filter((row) => row.ok === 1).length;
  const latencies = results
    .map((row) => row.latency_ms)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  return {
    samples: results.length,
    okRatio: okCount / results.length,
    medianLatencyMs: latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? null) : null,
  };
}

export interface InnerStats {
  alive: boolean;
  degraded: boolean;
}

export async function innerStats(env: Env, deploymentId: string, freshHours = 6): Promise<InnerStats | null> {
  const row = await env.DB.prepare(
    `SELECT status, last_seen_at,
            (SELECT a.status FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS agent_status,
            (SELECT a.reported_at FROM agent_reports a WHERE a.deployment_id = d.id ORDER BY a.reported_at DESC LIMIT 1) AS agent_reported_at
     FROM deployments d WHERE d.id = ?`,
  ).bind(deploymentId).first<{ status: string; last_seen_at: string | null; agent_status: string | null; agent_reported_at: string | null }>();
  if (!row) return null;
  if (row.status !== "ready") return null;
  const seen = Date.parse(row.agent_reported_at ?? row.last_seen_at ?? "");
  const fresh = Number.isFinite(seen) && seen >= Date.now() - freshHours * 3_600_000;
  return { alive: fresh && row.agent_status !== "failed", degraded: row.agent_status === "degraded" };
}

export async function netModeForDeployment(env: Env, deploymentId: string): Promise<NetMode> {
  const [edge, inner] = await Promise.all([edgeStats(env, deploymentId), innerStats(env, deploymentId)]);
  const edgeInput: EdgeProbeInput | null = edge ? { okRatio: edge.okRatio, medianLatencyMs: edge.medianLatencyMs, samples: edge.samples } : null;
  return classifyNetMode(edgeInput, inner);
}

export function netModeLine(mode: NetMode, extra?: string): string {
  return `🧭 حالت شبکه: ${NET_MODE_LABELS[mode]}${extra ? ` · ${extra}` : ""}`;
}

export async function purgeExpiredEdgeProbes(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM edge_probes WHERE expires_at <= ?").bind(nowIso()).run();
  return result.meta.changes ?? 0;
}
