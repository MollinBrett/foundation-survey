// Slack: the watchdog channel, and the human Approve / Reject / Restore buttons.
import { type Env, isConfigured, listVar } from "./env";
import { hmacHex, randomToken, timingSafeEqual } from "./crypto";
import { audit, nowIso } from "./db";

/** Escape user-supplied text for Slack mrkdwn so it cannot @-mention or inject links. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function postToWatchdogChannel(env: Env, text: string, blocks?: unknown[]): Promise<void> {
  if (!isConfigured(env.SLACK_BOT_TOKEN) || !isConfigured(env.SLACK_WATCHDOG_CHANNEL_ID)) return;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: env.SLACK_WATCHDOG_CHANNEL_ID, text, blocks, unfurl_links: false }),
  });
  const body = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`slack chat.postMessage: ${body.error}`);
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });

export function quarantineBlocks(batchId: string, category: string, reason: string, excerpts: string[], total: number) {
  const list = excerpts.map((e) => `• ${slackEscape(e)}`).join("\n");
  return [
    section(`*Watchdog quarantined ${total} response(s)* (${slackEscape(category)})\n${slackEscape(reason)}`),
    ...(list ? [section(`${list}${total > excerpts.length ? `\n…and ${total - excerpts.length} more` : ""}`)] : []),
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Restore all" }, action_id: "restore_batch", value: batchId }],
    },
  ];
}

export function proposalBlocks(id: string, scope: string, value: string, hours: number, reason: string, evidence: string) {
  return [
    section(
      `*Watchdog proposes a block*\nBlock *${slackEscape(scope)} = ${slackEscape(value)}* for *${hours}h*\n` +
        `Reason: ${slackEscape(reason)}${evidence ? `\nEvidence: ${slackEscape(evidence)}` : ""}`,
    ),
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_block", value: id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "reject_block", value: id },
      ],
    },
  ];
}

/** Slack request signing: v0=HMAC(signing_secret, "v0:{ts}:{body}"). Rejects anything older than 5 minutes. */
export async function verifySlackRequest(env: Env, rawBody: string, timestamp: string | null, signature: string | null): Promise<boolean> {
  if (!isConfigured(env.SLACK_SIGNING_SECRET) || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = `v0=${await hmacHex(env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(expected, signature);
}

interface InteractivePayload {
  user: { id: string };
  response_url?: string;
  actions?: { action_id: string; value: string }[];
}

async function respond(url: string | undefined, text: string) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

/** Handles a verified interactive payload. Returns the text shown in Slack. */
export async function handleInteractive(env: Env, payload: InteractivePayload): Promise<string> {
  const action = payload.actions?.[0];
  if (!action) return "No action.";
  const who = payload.user.id;
  if (!listVar(env.SLACK_APPROVER_USER_IDS).includes(who)) {
    return "You are not on the approver list for the survey watchdog. Nothing was changed.";
  }
  const db = env.SURVEY_DB;
  let text: string;

  if (action.action_id === "approve_block" || action.action_id === "reject_block") {
    const p = await db
      .prepare("SELECT * FROM block_proposals WHERE id = ?1")
      .bind(action.value)
      .first<{ id: string; scope: string; value: string; hours: number; reason: string; status: string }>();
    if (!p) text = "That proposal no longer exists.";
    else if (p.status !== "pending") text = `Already ${p.status}.`;
    else if (action.action_id === "reject_block") {
      await db
        .prepare("UPDATE block_proposals SET status = 'rejected', decided_by = ?2, decided_at = ?3 WHERE id = ?1")
        .bind(p.id, who, nowIso())
        .run();
      await audit(env, `slack:${who}`, "reject_block", { proposal: p.id });
      text = `Rejected by <@${who}>: block ${slackEscape(p.scope)} = ${slackEscape(p.value)}.`;
    } else {
      const expires = new Date(Date.now() + p.hours * 3_600_000).toISOString();
      await db.batch([
        db
          .prepare("UPDATE block_proposals SET status = 'approved', decided_by = ?2, decided_at = ?3 WHERE id = ?1")
          .bind(p.id, who, nowIso()),
        db
          .prepare("INSERT INTO blocks (id, scope, value, reason, expires_at, approved_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(randomToken(12), p.scope, p.value, p.reason, expires, who, nowIso()),
      ]);
      await audit(env, `slack:${who}`, "approve_block", { proposal: p.id, expires });
      text = `Approved by <@${who}>: ${slackEscape(p.scope)} = ${slackEscape(p.value)} blocked until ${expires}.`;
    }
  } else if (action.action_id === "restore_batch") {
    const b = await db
      .prepare("SELECT * FROM quarantine_batches WHERE id = ?1")
      .bind(action.value)
      .first<{ id: string; response_ids: string; restored_by: string | null }>();
    if (!b) text = "That batch no longer exists.";
    else if (b.restored_by) text = `Already restored by <@${b.restored_by}>.`;
    else {
      const ids = JSON.parse(b.response_ids) as string[];
      await db.batch([
        ...ids.map((id) =>
          db
            .prepare("UPDATE responses SET status = 'accepted', status_category = NULL, status_reason = ?2 WHERE id = ?1")
            .bind(id, `restored by slack:${who}`),
        ),
        db.prepare("UPDATE quarantine_batches SET restored_by = ?2 WHERE id = ?1").bind(b.id, who),
      ]);
      await audit(env, `slack:${who}`, "restore_batch", { batch: b.id, count: ids.length });
      text = `Restored ${ids.length} response(s), by <@${who}>.`;
    }
  } else {
    text = "Unknown action.";
  }
  await respond(payload.response_url, text);
  return text;
}
