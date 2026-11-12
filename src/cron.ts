// Runs every 15 minutes (see wrangler.toml). Three jobs, none of which needs a person:
//   1. publish approved announcements that are due
//   2. self-check: tell the team in Slack only when something is wrong
//   3. clean up: expired codes and counters, and the identity data after the retention period
import { type Env, intVar } from "./env";
import { audit, nowIso, surveyWindow } from "./db";
import { publishDue } from "./announce";
import { notify } from "./slack";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Send an alert at most once per day per problem. */
async function alertOnce(env: Env, key: string, text: string): Promise<boolean> {
  const res = await env.SURVEY_DB.prepare("INSERT OR IGNORE INTO alerts (key, day) VALUES (?1, ?2)").bind(key, nowIso().slice(0, 10)).run();
  if (!res.meta.changes) return false;
  await audit(env, "system", "self_check_alert", { key, text });
  await notify(env, `:warning: Survey self-check: ${text}`).catch((err) => console.error("slack notify", err));
  return true;
}

export async function selfCheck(env: Env): Promise<string[]> {
  const db = env.SURVEY_DB;
  const now = Date.now();
  const window = surveyWindow(env);
  const opened = Date.parse(env.SURVEY_OPENS_AT);
  const closed = Date.parse(env.SURVEY_CLOSES_AT);
  const problems: [string, string][] = [];
  if (window === "before") return [];

  const beats = new Map(
    ((await db.prepare("SELECT role, last_seen FROM agent_heartbeats").all()).results as { role: string; last_seen: string }[]).map((r) => [r.role, Date.parse(r.last_seen)]),
  );
  const silentFor = (role: string) => now - (beats.get(role) ?? opened);

  const oldest = await db
    .prepare(
      `SELECT MIN(CASE WHEN reviewed = 0 THEN submitted_at END) AS unreviewed,
              MIN(CASE WHEN status = 'quarantined' AND audited = 0 THEN submitted_at END) AS unaudited
       FROM responses`,
    )
    .first<{ unreviewed: string | null; unaudited: string | null }>();

  if (window === "open" && silentFor("watchdog") > 3 * HOUR) {
    problems.push(["watchdog_silent", "the watchdog agent has not run for over 3 hours. New responses are not being screened."]);
  }
  if (oldest?.unreviewed && now - Date.parse(oldest.unreviewed) > 3 * HOUR) {
    problems.push(["review_backlog", "some responses have waited over 3 hours for the watchdog."]);
  }
  if (oldest?.unaudited && now - Date.parse(oldest.unaudited) > 36 * HOUR) {
    problems.push(["audit_backlog", "some removed responses have waited over 36 hours for the auditor's second review."]);
  }
  if (window === "open" && now - opened > 36 * HOUR && silentFor("reporter") > 36 * HOUR) {
    problems.push(["reporter_silent", "the reporter agent has not run for over 36 hours."]);
  }
  if (window === "closed" && now - closed > 2 * DAY) {
    const final = await db.prepare("SELECT 1 FROM reports WHERE kind = 'final' LIMIT 1").first();
    if (!final) problems.push(["final_report_missing", "the survey closed over 2 days ago and the final report has not been posted."]);
  }
  if (window === "open") {
    const { results } = await db
      .prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'signin_error:%' AND window_start = ?1 AND count >= 10")
      .bind(nowIso().slice(0, 13))
      .all<{ key: string; count: number }>();
    for (const r of results) {
      const provider = r.key.slice("signin_error:".length);
      problems.push([`signin_errors_${provider}`, `sign-in with ${provider} failed ${r.count} times in the last hour. People on that channel may not be able to take the survey.`]);
    }
  }

  const sent: string[] = [];
  for (const [key, text] of problems) if (await alertOnce(env, key, text)) sent.push(key);
  return sent;
}

export async function cleanUp(env: Env): Promise<void> {
  const db = env.SURVEY_DB;
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM fallback_codes WHERE expires_at < ?1").bind(nowIso()),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(new Date(now - 3 * HOUR).toISOString().slice(0, 13)),
    db.prepare("DELETE FROM alerts WHERE day < ?1").bind(new Date(now - 7 * DAY).toISOString().slice(0, 10)),
  ]);

  // After the retention period, delete everything that could tie a response to a person or a network.
  const retentionDays = intVar(env.IDENTITY_RETENTION_DAYS, 30);
  if (now > Date.parse(env.SURVEY_CLOSES_AT) + retentionDays * DAY) {
    const done = await db.prepare("SELECT 1 FROM meta WHERE key = 'identities_purged_at'").first();
    if (!done) {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM identities").first<{ n: number }>();
      await db.batch([
        db.prepare("DELETE FROM identities"),
        db.prepare("DELETE FROM fallback_codes"),
        db.prepare("UPDATE responses SET asn = NULL, country = NULL"),
        db.prepare("INSERT INTO meta (key, value) VALUES ('identities_purged_at', ?1)").bind(nowIso()),
      ]);
      await audit(env, "system", "identity_data_deleted", { identities: n?.n ?? 0, retention_days: retentionDays });
      await notify(env, `Survey clean-up done: the account hashes and network details were deleted ${retentionDays} days after close, as planned. Answers are kept.`).catch(
        (err) => console.error("slack notify", err),
      );
    }
  }
}

export async function runScheduled(env: Env): Promise<void> {
  // Each job is independent: one failing must not stop the others.
  const jobs: [string, () => Promise<unknown>][] = [
    ["publish", () => publishDue(env, (text) => notify(env, text))],
    ["self_check", () => selfCheck(env)],
    ["clean_up", () => cleanUp(env)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      console.error(`scheduled ${name}`, err);
      await audit(env, "system", "scheduled_job_error", { job: name, error: String(err).slice(0, 300) }).catch(() => {});
    }
  }
}
