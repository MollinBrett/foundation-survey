import type { Env } from "./env";

export const nowIso = () => new Date().toISOString();

/** Increment a per-hour counter. Returns true if still under the limit. */
export async function rateLimit(env: Env, key: string, limit: number): Promise<boolean> {
  const window = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const row = await env.SURVEY_DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, window)
    .first<{ count: number }>();
  if (Math.random() < 0.05) {
    const cutoff = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 13);
    await env.SURVEY_DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(cutoff).run();
  }
  return (row?.count ?? 1) <= limit;
}

export interface BlockContext {
  provider?: string;
  asn?: number | null;
  country?: string | null;
  source?: string | null;
}

/** Returns the reason of an active block matching this request, or null. */
export async function activeBlock(env: Env, ctx: BlockContext): Promise<string | null> {
  const pairs: [string, string][] = [];
  if (ctx.provider) pairs.push(["provider", ctx.provider]);
  if (ctx.asn != null) pairs.push(["asn", String(ctx.asn)]);
  if (ctx.country) pairs.push(["country", ctx.country]);
  if (ctx.source) pairs.push(["source", ctx.source]);
  if (!pairs.length) return null;
  const clauses = pairs.map((_, i) => `(scope = ?${i * 2 + 2} AND value = ?${i * 2 + 3})`).join(" OR ");
  const row = await env.SURVEY_DB.prepare(`SELECT reason FROM blocks WHERE expires_at > ?1 AND (${clauses}) LIMIT 1`)
    .bind(nowIso(), ...pairs.flat())
    .first<{ reason: string }>();
  return row?.reason ?? null;
}

export async function audit(env: Env, actor: string, action: string, detail: unknown): Promise<void> {
  await env.SURVEY_DB.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?1, ?2, ?3, ?4)")
    .bind(nowIso(), actor, action, JSON.stringify(detail))
    .run();
}

export function surveyWindow(env: Env): "before" | "open" | "closed" {
  const now = Date.now();
  if (now < Date.parse(env.SURVEY_OPENS_AT)) return "before";
  if (now > Date.parse(env.SURVEY_CLOSES_AT)) return "closed";
  return "open";
}
