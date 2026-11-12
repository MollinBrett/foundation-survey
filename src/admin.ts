// The agents' API. Bearer ADMIN_API_KEY. The agents can read, quarantine and PROPOSE blocks.
// They cannot restore, block, or delete; only a human in Slack can.
import { Hono } from "hono";
import { type Env, PROVIDERS, intVar } from "./env";
import { randomToken, timingSafeEqual } from "./crypto";
import { audit, nowIso, surveyWindow } from "./db";
import { postToWatchdogChannel, proposalBlocks, quarantineBlocks, slackEscape } from "./slack";
import { freeText, type Answers } from "./survey";
import { computeResults } from "./results";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!c.env.ADMIN_API_KEY || !token || !timingSafeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

const CATEGORIES = ["spam", "abuse", "duplicate", "coordinated", "other"] as const;
const BLOCK_SCOPES = ["provider", "asn", "country", "source"] as const;

function rowOut(r: any) {
  return {
    id: r.id,
    channel: r.channel,
    source: r.source,
    submitted_at: r.submitted_at,
    asn: r.asn,
    country: r.country,
    text_fingerprint: r.text_fingerprint,
    status: r.status,
    status_category: r.status_category,
    answers: JSON.parse(r.answers) as Answers,
  };
}

admin.get("/status", async (c) => {
  const db = c.env.SURVEY_DB;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [byStatus, byChannel, lastHourChannel, lastHourAsn, unreviewed, pending, blocks, finalReport] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM responses GROUP BY status"),
    db.prepare("SELECT channel, status, COUNT(*) AS n FROM responses GROUP BY channel, status"),
    db.prepare("SELECT channel, COUNT(*) AS n FROM responses WHERE submitted_at > ?1 GROUP BY channel").bind(hourAgo),
    db.prepare("SELECT asn, country, COUNT(*) AS n FROM responses WHERE submitted_at > ?1 GROUP BY asn, country ORDER BY n DESC LIMIT 10").bind(hourAgo),
    db.prepare("SELECT COUNT(*) AS n FROM responses WHERE reviewed = 0"),
    db.prepare("SELECT id, scope, value, hours, reason, created_at FROM block_proposals WHERE status = 'pending'"),
    db.prepare("SELECT scope, value, reason, expires_at FROM blocks WHERE expires_at > ?1").bind(nowIso()),
    db.prepare("SELECT created_at FROM reports WHERE kind = 'final' LIMIT 1"),
  ]);
  return c.json({
    window: surveyWindow(c.env),
    opens_at: c.env.SURVEY_OPENS_AT,
    closes_at: c.env.SURVEY_CLOSES_AT,
    min_channel_report_size: intVar(c.env.MIN_CHANNEL_REPORT_SIZE, 5),
    channels: PROVIDERS,
    by_status: byStatus!.results,
    by_channel: byChannel!.results,
    last_hour_by_channel: lastHourChannel!.results,
    last_hour_top_networks: lastHourAsn!.results,
    unreviewed: (unreviewed!.results[0] as any)?.n ?? 0,
    pending_block_proposals: pending!.results,
    active_blocks: blocks!.results,
    final_report_posted: finalReport!.results.length > 0,
  });
});

admin.get("/responses", async (c) => {
  const limit = Math.min(Math.max(intVar(c.req.query("limit"), 200), 1), 500);
  const unreviewed = c.req.query("unreviewed") === "1";
  const since = c.req.query("since");
  const status = c.req.query("status");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (unreviewed) where.push("reviewed = 0");
  if (since) {
    binds.push(since);
    where.push(`submitted_at > ?${binds.length}`);
  }
  if (status === "accepted" || status === "quarantined") {
    binds.push(status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(limit);
  const sql = `SELECT * FROM responses ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY submitted_at ASC LIMIT ?${binds.length}`;
  const { results } = await c.env.SURVEY_DB.prepare(sql).bind(...binds).all();
  return c.json({ responses: results.map(rowOut) });
});

/** KPI results over accepted responses only. All percentages are computed here, not by an agent. */
admin.get("/results", async (c) => {
  const db = c.env.SURVEY_DB;
  const [accepted, quarantined, channels] = await db.batch([
    db.prepare("SELECT answers FROM responses WHERE status = 'accepted'"),
    db.prepare("SELECT status_category AS category, COUNT(*) AS n FROM responses WHERE status = 'quarantined' GROUP BY status_category"),
    db.prepare("SELECT channel, COUNT(*) AS n FROM responses WHERE status = 'accepted' GROUP BY channel"),
  ]);
  const answers = (accepted!.results as { answers: string }[]).map((r) => JSON.parse(r.answers) as Answers);
  const results = computeResults(answers, {
    target: intVar(c.env.KPI_TARGET_PCT, 80),
    minGroup: intVar(c.env.MIN_GROUP_REPORT_SIZE, 30),
  });
  // Channels below the minimum are folded together so small groups cannot be singled out.
  const minChannel = intVar(c.env.MIN_CHANNEL_REPORT_SIZE, 5);
  const by_channel: Record<string, number> = {};
  let other = 0;
  for (const r of channels!.results as { channel: string; n: number }[]) {
    if (r.n >= minChannel) by_channel[r.channel] = r.n;
    else other += r.n;
  }
  if (other > 0) by_channel["other channels"] = other;
  return c.json({
    window: surveyWindow(c.env),
    ...results,
    respondents_by_channel: by_channel,
    quarantined_excluded: quarantined!.results,
  });
});

/** Free-text fingerprints shared by more than one response: copy-paste detector. */
admin.get("/duplicates", async (c) => {
  const since = c.req.query("since") ?? "1970-01-01T00:00:00Z";
  const { results } = await c.env.SURVEY_DB.prepare(
    `SELECT text_fingerprint, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
     FROM responses WHERE text_fingerprint IS NOT NULL AND submitted_at > ?1
     GROUP BY text_fingerprint HAVING n > 1 ORDER BY n DESC LIMIT 50`,
  )
    .bind(since)
    .all();
  return c.json({
    duplicates: results.map((r: any) => ({ fingerprint: r.text_fingerprint, count: r.n, ids: String(r.ids).split(",") })),
  });
});

interface ReviewBody {
  reviewed_ids?: unknown;
  quarantine?: { ids?: unknown; category?: unknown; reason?: unknown }[];
}

/** Mark responses reviewed, and quarantine groups of them. One Slack message per group, with a Restore button. */
admin.post("/review", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ReviewBody | null;
  if (!body) return c.json({ error: "invalid JSON" }, 400);
  const db = c.env.SURVEY_DB;
  const reviewed = Array.isArray(body.reviewed_ids) ? body.reviewed_ids.filter((x): x is string => typeof x === "string") : [];
  const groups = Array.isArray(body.quarantine) ? body.quarantine : [];

  for (const g of groups) {
    if (!Array.isArray(g.ids) || !g.ids.every((x) => typeof x === "string") || g.ids.length === 0) {
      return c.json({ error: "each quarantine group needs ids: string[]" }, 400);
    }
    if (!CATEGORIES.includes(g.category as any)) return c.json({ error: `category must be one of ${CATEGORIES.join(", ")}` }, 400);
    if (typeof g.reason !== "string" || !g.reason.trim()) return c.json({ error: "each quarantine group needs a reason" }, 400);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const id of reviewed) stmts.push(db.prepare("UPDATE responses SET reviewed = 1 WHERE id = ?1").bind(id));

  const posted: { batch: string; count: number }[] = [];
  const slackJobs: (() => Promise<void>)[] = [];
  for (const g of groups) {
    const ids = [...new Set(g.ids as string[])];
    const category = g.category as string;
    const reason = (g.reason as string).slice(0, 500);
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const existing = await db.prepare(`SELECT id, answers FROM responses WHERE id IN (${placeholders})`).bind(...ids).all();
    const found = existing.results as { id: string; answers: string }[];
    if (!found.length) continue;
    const batchId = randomToken(12);
    for (const r of found) {
      stmts.push(
        db
          .prepare("UPDATE responses SET status = 'quarantined', status_category = ?2, status_reason = ?3, reviewed = 1 WHERE id = ?1")
          .bind(r.id, category, reason),
      );
    }
    stmts.push(
      db
        .prepare("INSERT INTO quarantine_batches (id, response_ids, category, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(batchId, JSON.stringify(found.map((r) => r.id)), category, reason, nowIso()),
    );
    const excerpts = found.slice(0, 10).map((r) => {
      const text = freeText(JSON.parse(r.answers));
      return text ? `“${text.slice(0, 140)}”` : "(no free text)";
    });
    posted.push({ batch: batchId, count: found.length });
    slackJobs.push(() =>
      postToWatchdogChannel(
        c.env,
        `Watchdog quarantined ${found.length} response(s): ${category}`,
        quarantineBlocks(batchId, category, reason, excerpts, found.length),
      ),
    );
  }
  if (stmts.length) await db.batch(stmts);
  await audit(c.env, "agent", "review", { reviewed: reviewed.length, quarantined: posted });
  for (const job of slackJobs) await job();
  return c.json({ ok: true, reviewed: reviewed.length, quarantine_batches: posted });
});

admin.post("/block-proposals", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return c.json({ error: "invalid JSON" }, 400);
  const scope = b.scope;
  const value = typeof b.value === "string" || typeof b.value === "number" ? String(b.value) : "";
  const hours = Number(b.hours);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  const evidence = typeof b.evidence === "string" ? b.evidence.trim().slice(0, 1000) : "";
  if (!BLOCK_SCOPES.includes(scope as any)) return c.json({ error: `scope must be one of ${BLOCK_SCOPES.join(", ")}` }, 400);
  if (!value || value.length > 64) return c.json({ error: "value required" }, 400);
  if (scope === "provider" && !PROVIDERS.includes(value as any)) return c.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) return c.json({ error: "hours must be 1-72" }, 400);
  if (!reason) return c.json({ error: "reason required" }, 400);

  const id = randomToken(12);
  await c.env.SURVEY_DB.prepare(
    "INSERT INTO block_proposals (id, scope, value, hours, reason, evidence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, scope, value, hours, reason, evidence, nowIso())
    .run();
  await audit(c.env, "agent", "propose_block", { id, scope, value, hours });
  await postToWatchdogChannel(
    c.env,
    `Watchdog proposes blocking ${scope} = ${value} for ${hours}h`,
    proposalBlocks(id, scope as string, value, hours, reason, evidence),
  );
  return c.json({ ok: true, id, status: "pending", note: "A human must approve this in Slack before it takes effect." });
});

admin.post("/reports", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { kind?: unknown; text?: unknown } | null;
  if (!b || (b.kind !== "daily" && b.kind !== "final") || typeof b.text !== "string" || !b.text.trim()) {
    return c.json({ error: "body must be {kind: daily|final, text}" }, 400);
  }
  const db = c.env.SURVEY_DB;
  if (b.kind === "final") {
    const done = await db.prepare("SELECT id FROM reports WHERE kind = 'final' LIMIT 1").first();
    if (done) return c.json({ error: "final report already posted" }, 409);
  }
  const id = randomToken(12);
  await db.prepare("INSERT INTO reports (id, kind, created_at) VALUES (?1, ?2, ?3)").bind(id, b.kind, nowIso()).run();
  await audit(c.env, "agent", "report", { id, kind: b.kind });
  const title = b.kind === "final" ? "*Final survey report*" : "*Daily survey report*";
  await postToWatchdogChannel(c.env, `${b.kind} survey report`, [
    { type: "section", text: { type: "mrkdwn", text: `${title}\n${slackEscape(b.text).slice(0, 2800)}` } },
  ]);
  return c.json({ ok: true, id });
});
