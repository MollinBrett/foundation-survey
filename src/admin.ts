// The agents' API. Each agent has its own key, and each key only unlocks that agent's routes:
//
//   watchdog   read responses, remove (quarantine) responses, apply temporary blocks within limits
//   auditor    read responses, re-check removals, restore wrongly removed responses. Cannot remove or block.
//   reporter   read results and responses, post reports. Cannot change any response.
//   announcer  read headline counts, draft announcements. Cannot read responses or post anything.
//
// The limits on blocks are enforced here, not in the agents' instructions.
import { Hono, type MiddlewareHandler } from "hono";
import { type AgentRole, AGENT_ROLES, type Env, PROVIDERS, intVar, isConfigured } from "./env";
import { randomToken, timingSafeEqual } from "./crypto";
import { audit, nowIso, surveyWindow } from "./db";
import { announcementBlocks, blockAppliedBlocks, notify, quarantineBlocks, slackEscape } from "./slack";
import { freeText, type Answers } from "./survey";
import { loadResults } from "./results";
import {
  ANNOUNCE_CHANNELS,
  ANNOUNCEMENT_KINDS,
  LINK_PLACEHOLDER,
  MAX_LENGTH,
  type AnnounceChannel,
  type AnnouncementKind,
  announcementLink,
  canPostAutomatically,
  checkAnnouncementText,
} from "./announce";

type AdminEnv = { Bindings: Env; Variables: { role: AgentRole } };
export const admin = new Hono<AdminEnv>();

const KEY_VARS: Record<AgentRole, keyof Env> = {
  watchdog: "WATCHDOG_API_KEY",
  auditor: "AUDITOR_API_KEY",
  reporter: "REPORTER_API_KEY",
  announcer: "ANNOUNCER_API_KEY",
};

admin.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  let role: AgentRole | null = null;
  for (const r of AGENT_ROLES) {
    const key = c.env[KEY_VARS[r]] as string | undefined;
    if (token && isConfigured(key) && timingSafeEqual(token, key)) role = r;
  }
  if (!role) return c.json({ error: "unauthorized" }, 401);
  c.set("role", role);
  await c.env.SURVEY_DB.prepare(
    "INSERT INTO agent_heartbeats (role, last_seen) VALUES (?1, ?2) ON CONFLICT (role) DO UPDATE SET last_seen = ?2",
  )
    .bind(role, nowIso())
    .run();
  await next();
});

const only = (...roles: AgentRole[]): MiddlewareHandler<AdminEnv> => async (c, next) => {
  if (!roles.includes(c.get("role"))) return c.json({ error: `the ${c.get("role")} agent is not allowed to do this` }, 403);
  await next();
};

const CATEGORIES = ["spam", "abuse", "duplicate", "coordinated", "other"] as const;
const NARROW_SCOPES = ["asn", "source"];
const BROAD_SCOPES = ["provider", "country"];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function counts(env: Env) {
  const row = await env.SURVEY_DB.prepare(
    `SELECT
       SUM(CASE WHEN reviewed = 0 THEN 1 ELSE 0 END) AS unreviewed,
       SUM(CASE WHEN status = 'quarantined' AND audited = 0 THEN 1 ELSE 0 END) AS unaudited
     FROM responses`,
  ).first<{ unreviewed: number | null; unaudited: number | null }>();
  return { unreviewed: row?.unreviewed ?? 0, unaudited: row?.unaudited ?? 0 };
}

// ---------- Reading ----------

admin.get("/status", only("watchdog", "auditor", "reporter"), async (c) => {
  const db = c.env.SURVEY_DB;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [byStatus, byChannel, lastHourChannel, lastHourAsn, lastHourSource, blocks, blocksToday, finalReport] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM responses GROUP BY status"),
    db.prepare("SELECT channel, status, COUNT(*) AS n FROM responses GROUP BY channel, status"),
    db.prepare("SELECT channel, COUNT(*) AS n FROM responses WHERE submitted_at > ?1 GROUP BY channel").bind(hourAgo),
    db.prepare("SELECT asn, country, COUNT(*) AS n FROM responses WHERE submitted_at > ?1 GROUP BY asn, country ORDER BY n DESC LIMIT 10").bind(hourAgo),
    db.prepare("SELECT source, COUNT(*) AS n FROM responses WHERE submitted_at > ?1 GROUP BY source ORDER BY n DESC LIMIT 10").bind(hourAgo),
    db.prepare("SELECT scope, value, reason, expires_at FROM blocks WHERE expires_at > ?1").bind(nowIso()),
    db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE created_at > ?1").bind(dayAgo),
    db.prepare("SELECT created_at FROM reports WHERE kind = 'final' LIMIT 1"),
  ]);
  return c.json({
    now: nowIso(),
    window: surveyWindow(c.env),
    opens_at: c.env.SURVEY_OPENS_AT,
    closes_at: c.env.SURVEY_CLOSES_AT,
    channels: PROVIDERS,
    by_status: byStatus!.results,
    by_channel: byChannel!.results,
    last_hour_by_channel: lastHourChannel!.results,
    last_hour_top_networks: lastHourAsn!.results,
    last_hour_top_sources: lastHourSource!.results,
    ...(await counts(c.env)),
    active_blocks: blocks!.results,
    block_limits: {
      max_hours: { asn: intVar(c.env.MAX_BLOCK_HOURS_NARROW, 24), source: intVar(c.env.MAX_BLOCK_HOURS_NARROW, 24), provider: intVar(c.env.MAX_BLOCK_HOURS_BROAD, 6), country: intVar(c.env.MAX_BLOCK_HOURS_BROAD, 6) },
      max_blocks_per_24h: intVar(c.env.MAX_AUTO_BLOCKS_PER_DAY, 6),
      blocks_applied_last_24h: (blocksToday!.results[0] as { n: number } | undefined)?.n ?? 0,
      one_channel_or_country_block_at_a_time: true,
    },
    final_report_posted: finalReport!.results.length > 0,
  });
});

admin.get("/responses", only("watchdog", "auditor", "reporter"), async (c) => {
  const limit = Math.min(Math.max(intVar(c.req.query("limit"), 200), 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (c.req.query("unreviewed") === "1") where.push("reviewed = 0");
  const since = c.req.query("since");
  if (since) {
    binds.push(since);
    where.push(`submitted_at > ?${binds.length}`);
  }
  const status = c.req.query("status");
  if (status === "accepted" || status === "quarantined") {
    binds.push(status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(limit);
  const sql = `SELECT * FROM responses ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY submitted_at ASC LIMIT ?${binds.length}`;
  const { results } = await c.env.SURVEY_DB.prepare(sql).bind(...binds).all();
  // The auditor must judge removals without seeing the watchdog's reasoning.
  const blind = c.get("role") === "auditor";
  return c.json({
    responses: results.map((r: any) => ({
      id: r.id,
      channel: r.channel,
      source: r.source,
      submitted_at: r.submitted_at,
      asn: r.asn,
      country: r.country,
      text_fingerprint: r.text_fingerprint,
      status: r.status,
      ...(blind ? {} : { status_category: r.status_category }),
      answers: JSON.parse(r.answers) as Answers,
    })),
  });
});

/** Free-text fingerprints shared by more than one response: copy-paste detector. */
admin.get("/duplicates", only("watchdog", "auditor"), async (c) => {
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

// ---------- Watchdog ----------

interface ReviewBody {
  reviewed_ids?: unknown;
  quarantine?: { ids?: unknown; category?: unknown; reason?: unknown }[];
}

/** Mark responses reviewed, and remove (quarantine) groups of them. One Slack note per group. */
admin.post("/review", only("watchdog"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as ReviewBody | null;
  if (!body) return c.json({ error: "invalid JSON" }, 400);
  const db = c.env.SURVEY_DB;
  const reviewed = strings(body.reviewed_ids);
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
    // A response the auditor has already restored cannot be removed again by the watchdog.
    const existing = await db.prepare(`SELECT id, answers FROM responses WHERE audited = 0 AND status = 'accepted' AND id IN (${placeholders})`).bind(...ids).all();
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
      notify(c.env, `Watchdog removed ${found.length} response(s): ${category}`, quarantineBlocks(batchId, category, reason, excerpts, found.length)),
    );
  }
  if (stmts.length) await db.batch(stmts);
  await audit(c.env, "agent:watchdog", "review", { reviewed: reviewed.length, removed: posted.reduce((n, p) => n + p.count, 0), batches: posted });
  for (const job of slackJobs) await job().catch((err) => console.error("slack notify", err));
  return c.json({ ok: true, reviewed: reviewed.length, quarantine_batches: posted });
});

/** Apply a temporary block. Takes effect at once. Every limit below is enforced here. */
admin.post("/blocks", only("watchdog"), async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return c.json({ error: "invalid JSON" }, 400);
  const scope = String(b.scope ?? "");
  const value = typeof b.value === "string" || typeof b.value === "number" ? String(b.value).trim() : "";
  const hours = Number(b.hours);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
  const evidence = typeof b.evidence === "string" ? b.evidence.trim().slice(0, 1000) : "";
  const broad = BROAD_SCOPES.includes(scope);
  if (!broad && !NARROW_SCOPES.includes(scope)) return c.json({ error: "scope must be one of asn, source, provider, country" }, 400);
  if (!value || value.length > 64) return c.json({ error: "value required" }, 400);
  if (scope === "provider" && !PROVIDERS.includes(value as any)) return c.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
  if (scope === "asn" && !/^\d+$/.test(value)) return c.json({ error: "asn must be a number" }, 400);
  if (scope === "country" && !/^[A-Z]{2}$/.test(value)) return c.json({ error: "country must be a 2-letter code" }, 400);
  if (!reason) return c.json({ error: "reason required" }, 400);
  if (!evidence) return c.json({ error: "evidence required: give the numbers that justify the block" }, 400);
  if (surveyWindow(c.env) !== "open") return c.json({ error: "the survey is not open" }, 409);

  const maxHours = broad ? intVar(c.env.MAX_BLOCK_HOURS_BROAD, 6) : intVar(c.env.MAX_BLOCK_HOURS_NARROW, 24);
  if (!Number.isInteger(hours) || hours < 1 || hours > maxHours) {
    return c.json({ error: `hours must be 1-${maxHours} for a ${scope} block` }, 400);
  }
  const db = c.env.SURVEY_DB;
  const now = nowIso();
  const [same, broadActive, today] = await db.batch([
    db.prepare("SELECT 1 FROM blocks WHERE scope = ?1 AND value = ?2 AND expires_at > ?3 LIMIT 1").bind(scope, value, now),
    db.prepare("SELECT 1 FROM blocks WHERE scope IN ('provider', 'country') AND expires_at > ?1 LIMIT 1").bind(now),
    db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE created_at > ?1").bind(new Date(Date.now() - 86_400_000).toISOString()),
  ]);
  if (same!.results.length) return c.json({ error: "that block is already active" }, 409);
  if (broad && broadActive!.results.length) {
    return c.json({ error: "a channel or country block is already active; only one may be active at a time" }, 409);
  }
  const maxPerDay = intVar(c.env.MAX_AUTO_BLOCKS_PER_DAY, 6);
  if (((today!.results[0] as { n: number }).n ?? 0) >= maxPerDay) {
    return c.json({ error: `limit reached: ${maxPerDay} blocks in 24 hours. Keep removing bad responses instead.` }, 429);
  }

  const id = randomToken(12);
  const expires = new Date(Date.now() + hours * 3_600_000).toISOString();
  await db
    .prepare("INSERT INTO blocks (id, scope, value, hours, reason, evidence, expires_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'agent:watchdog', ?8)")
    .bind(id, scope, value, hours, reason, evidence, expires, now)
    .run();
  await audit(c.env, "agent:watchdog", "apply_block", { id, scope, value, hours, reason });
  await notify(c.env, `Watchdog blocked ${scope} = ${value} for ${hours}h`, blockAppliedBlocks(id, scope, value, hours, reason, evidence, expires)).catch((err) =>
    console.error("slack notify", err),
  );
  return c.json({ ok: true, id, expires_at: expires });
});

// ---------- Auditor ----------

/** Removed responses the auditor has not re-checked yet. The watchdog's category and reason are withheld. */
admin.get("/audit/queue", only("auditor"), async (c) => {
  const { results } = await c.env.SURVEY_DB.prepare(
    `SELECT r.id, r.channel, r.source, r.submitted_at, r.asn, r.country, r.answers, r.text_fingerprint,
            (SELECT COUNT(*) FROM responses d WHERE d.text_fingerprint = r.text_fingerprint) AS same_text_count
     FROM responses r WHERE r.status = 'quarantined' AND r.audited = 0 ORDER BY r.submitted_at LIMIT 300`,
  ).all();
  return c.json({
    queue: results.map((r: any) => ({
      id: r.id,
      channel: r.channel,
      source: r.source,
      submitted_at: r.submitted_at,
      asn: r.asn,
      country: r.country,
      same_text_count: r.text_fingerprint ? r.same_text_count : 0,
      answers: JSON.parse(r.answers) as Answers,
    })),
  });
});

interface AuditBody {
  confirm_ids?: unknown;
  restore?: { ids?: unknown; reason?: unknown }[];
}

/** Confirm removals or restore them. The auditor cannot remove anything. */
admin.post("/audit", only("auditor"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as AuditBody | null;
  if (!body) return c.json({ error: "invalid JSON" }, 400);
  const db = c.env.SURVEY_DB;
  const confirm = strings(body.confirm_ids);
  const groups = Array.isArray(body.restore) ? body.restore : [];
  for (const g of groups) {
    if (strings(g.ids).length === 0) return c.json({ error: "each restore group needs ids: string[]" }, 400);
    if (typeof g.reason !== "string" || !g.reason.trim()) return c.json({ error: "each restore group needs a reason" }, 400);
  }
  const pending = "status = 'quarantined' AND audited = 0";
  const stmts: D1PreparedStatement[] = [];
  let restored = 0;
  const notes: string[] = [];
  for (const g of groups) {
    const reason = (g.reason as string).trim().slice(0, 500);
    for (const id of new Set(strings(g.ids))) {
      const row = await db.prepare(`SELECT 1 FROM responses WHERE id = ?1 AND ${pending}`).bind(id).first();
      if (!row) continue;
      restored++;
      stmts.push(
        db
          .prepare(`UPDATE responses SET status = 'accepted', status_category = NULL, status_reason = NULL, audited = 1, audit_note = ?2 WHERE id = ?1 AND ${pending}`)
          .bind(id, `restored by auditor: ${reason}`),
      );
    }
    notes.push(reason);
  }
  for (const id of confirm) {
    stmts.push(db.prepare(`UPDATE responses SET audited = 1, audit_note = 'removal confirmed by auditor' WHERE id = ?1 AND ${pending}`).bind(id));
  }
  if (stmts.length) await db.batch(stmts);
  await audit(c.env, "agent:auditor", "audit", { confirmed: confirm.length, restored, reasons: notes });
  if (restored > 0) {
    await notify(c.env, `Auditor restored ${restored} response(s) the watchdog had removed. ${notes.map(slackEscape).join(" / ")}`).catch((err) =>
      console.error("slack notify", err),
    );
  }
  return c.json({ ok: true, confirmed: confirm.length, restored });
});

// ---------- Reporter ----------

/** KPI results over accepted responses only. All percentages are computed here, not by an agent. */
admin.get("/results", only("reporter"), async (c) => c.json(await loadResults(c.env)));

admin.post("/reports", only("reporter"), async (c) => {
  const b = (await c.req.json().catch(() => null)) as { kind?: unknown; text?: unknown; themes?: unknown } | null;
  if (!b || (b.kind !== "daily" && b.kind !== "final") || typeof b.text !== "string" || !b.text.trim()) {
    return c.json({ error: "body must be {kind: daily|final, text, themes?}" }, 400);
  }
  const themes = (Array.isArray(b.themes) ? b.themes : [])
    .filter((t: any) => t && typeof t.title === "string" && typeof t.summary === "string")
    .slice(0, 8)
    .map((t: any) => ({
      title: String(t.title).slice(0, 80),
      summary: String(t.summary).slice(0, 400),
      mentions: Number.isInteger(t.mentions) && t.mentions >= 0 ? (t.mentions as number) : null,
    }));
  const db = c.env.SURVEY_DB;
  if (b.kind === "final") {
    if (surveyWindow(c.env) !== "closed") return c.json({ error: "the survey has not closed yet" }, 409);
    if (await db.prepare("SELECT id FROM reports WHERE kind = 'final' LIMIT 1").first()) return c.json({ error: "final report already posted" }, 409);
    const open = await counts(c.env);
    if (open.unreviewed > 0 || open.unaudited > 0) {
      return c.json({ error: "not final yet: some responses are still waiting for the watchdog or the auditor", ...open }, 409);
    }
  }
  const id = randomToken(12);
  await db
    .prepare("INSERT INTO reports (id, kind, text, themes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, b.kind, b.text.trim().slice(0, 6000), JSON.stringify(themes), nowIso())
    .run();
  await audit(c.env, "agent:reporter", "report", { id, kind: b.kind });
  const title = b.kind === "final" ? "*Final survey report*" : "*Daily survey report*";
  const link = `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/results`;
  await notify(c.env, `${b.kind} survey report`, [
    { type: "section", text: { type: "mrkdwn", text: `${title}\n${slackEscape(b.text).slice(0, 2700)}\n<${link}|Open the results page>` } },
  ]).catch((err) => console.error("slack notify", err));
  return c.json({ ok: true, id });
});

// ---------- Announcer ----------

/** What the announcer needs to write good posts. No responses, no free text. */
admin.get("/announcements/context", only("announcer"), async (c) => {
  const db = c.env.SURVEY_DB;
  const r = await loadResults(c.env);
  const { results } = await db.prepare("SELECT id, kind, channel, text, scheduled_for, status FROM announcements ORDER BY scheduled_for").all();
  return c.json({
    now: nowIso(),
    window: r.window,
    opens_at: c.env.SURVEY_OPENS_AT,
    closes_at: c.env.SURVEY_CLOSES_AT,
    respondents: r.respondents,
    roles: r.roles.map((x) => ({ role: x.role, respondents: x.respondents, below_minimum: !x.reported })),
    minimum_per_role: r.min_group_report_size,
    channels: ANNOUNCE_CHANNELS.map((ch) => ({ channel: ch, max_length: MAX_LENGTH[ch], posts_automatically: canPostAutomatically(c.env, ch) })),
    kinds: ANNOUNCEMENT_KINDS,
    link_placeholder: LINK_PLACEHOLDER,
    max_announcements_per_channel: 6,
    announcements: results,
  });
});

interface DraftBody {
  drafts?: { kind?: unknown; channel?: unknown; text?: unknown; scheduled_for?: unknown }[];
}

/** Save drafts and send each one to the announcement owner in Slack. Nothing is posted here. */
admin.post("/announcements/drafts", only("announcer"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as DraftBody | null;
  const drafts = Array.isArray(body?.drafts) ? body!.drafts! : [];
  if (!drafts.length || drafts.length > 8) return c.json({ error: "send 1-8 drafts" }, 400);
  const db = c.env.SURVEY_DB;
  const closes = Date.parse(c.env.SURVEY_CLOSES_AT);
  const out: { kind: string; channel: string; ok: boolean; id?: string; error?: string }[] = [];

  for (const d of drafts) {
    const kind = String(d.kind ?? "") as AnnouncementKind;
    const channel = String(d.channel ?? "") as AnnounceChannel;
    const fail = (error: string) => out.push({ kind, channel, ok: false, error });
    if (!ANNOUNCEMENT_KINDS.includes(kind)) { fail(`kind must be one of ${ANNOUNCEMENT_KINDS.join(", ")}`); continue; }
    if (!ANNOUNCE_CHANNELS.includes(channel)) { fail(`channel must be one of ${ANNOUNCE_CHANNELS.join(", ")}`); continue; }
    const raw = typeof d.text === "string" ? d.text.trim() : "";
    if (kind !== "thanks" && !raw.includes(LINK_PLACEHOLDER)) { fail(`text must contain ${LINK_PLACEHOLDER} where the survey link goes`); continue; }
    const text = raw.split(LINK_PLACEHOLDER).join(announcementLink(c.env, channel, kind));
    const problem = checkAnnouncementText(channel, text);
    if (problem) { fail(problem); continue; }
    const when = Date.parse(String(d.scheduled_for ?? ""));
    if (!Number.isFinite(when)) { fail("scheduled_for must be an ISO timestamp"); continue; }
    if (when < Date.now() - 3_600_000 || when > closes + 7 * 86_400_000) { fail("scheduled_for must be between now and 7 days after the survey closes"); continue; }
    if (kind !== "thanks" && when > closes) { fail("only a thanks post may be scheduled after the survey closes"); continue; }
    const scheduled = new Date(when).toISOString();

    const [dupe, total] = await db.batch([
      db
        .prepare("SELECT 1 FROM announcements WHERE kind = ?1 AND channel = ?2 AND status != 'skipped' AND substr(scheduled_for, 1, 10) = ?3 LIMIT 1")
        .bind(kind, channel, scheduled.slice(0, 10)),
      db.prepare("SELECT COUNT(*) AS n FROM announcements WHERE channel = ?1 AND status != 'skipped'").bind(channel),
    ]);
    if (dupe!.results.length) { fail("there is already an announcement of this kind for this channel on that day"); continue; }
    if (((total!.results[0] as { n: number }).n ?? 0) >= 6) { fail("this channel already has 6 announcements; that is the limit"); continue; }

    const id = randomToken(12);
    await db
      .prepare("INSERT INTO announcements (id, kind, channel, text, scheduled_for, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(id, kind, channel, text, scheduled, nowIso())
      .run();
    await notify(c.env, `Announcement draft for approval: ${kind} on ${channel}`, announcementBlocks({ id, kind, channel, text, scheduled_for: scheduled, status: "draft" })).catch(
      (err) => console.error("slack notify", err),
    );
    out.push({ kind, channel, ok: true, id });
  }
  await audit(c.env, "agent:announcer", "draft_announcements", { saved: out.filter((o) => o.ok).length, rejected: out.filter((o) => !o.ok).length });
  return c.json({ results: out });
});
