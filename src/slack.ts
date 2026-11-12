// Slack: notifications about what the agents did, optional overrides for people,
// and the announcement owner's Approve / Edit / Skip controls.
import { type Env, isConfigured, listVar } from "./env";
import { hmacHex, timingSafeEqual } from "./crypto";
import { audit, nowIso } from "./db";
import { checkAnnouncementText, type AnnouncementRow } from "./announce";

/** Escape user-supplied text for Slack mrkdwn so it cannot @-mention or inject links. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function slackCall(env: Env, method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string };
  if (!out.ok) throw new Error(`slack ${method}: ${out.error}`);
  return out;
}

export async function postToSlackChannel(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
  await slackCall(env, "chat.postMessage", { channel, text, blocks, unfurl_links: false });
}

/** Post to the team's survey channel. Does nothing if Slack is not set up. */
export async function notify(env: Env, text: string, blocks?: unknown[]): Promise<void> {
  if (!isConfigured(env.SLACK_BOT_TOKEN) || !isConfigured(env.SLACK_WATCHDOG_CHANNEL_ID)) return;
  await postToSlackChannel(env, env.SLACK_WATCHDOG_CHANNEL_ID, text, blocks);
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });
const button = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id,
  value,
  ...(style ? { style } : {}),
});
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

export function quarantineBlocks(batchId: string, category: string, reason: string, excerpts: string[], total: number) {
  const list = excerpts.map((e) => `• ${slackEscape(e)}`).join("\n");
  return [
    section(`*Watchdog removed ${total} response(s)* (${slackEscape(category)})\n${slackEscape(reason)}`),
    ...(list ? [section(`${list}${total > excerpts.length ? `\n…and ${total - excerpts.length} more` : ""}`)] : []),
    context("No action needed. The auditor agent re-checks every removal. Override only if you want to."),
    { type: "actions", elements: [button("Restore all", "restore_batch", batchId)] },
  ];
}

export function blockAppliedBlocks(id: string, scope: string, value: string, hours: number, reason: string, evidence: string, expires: string) {
  return [
    section(
      `*Watchdog applied a temporary block*\n*${slackEscape(scope)} = ${slackEscape(value)}* for *${hours}h* (ends ${expires})\n` +
        `Reason: ${slackEscape(reason)}\nEvidence: ${slackEscape(evidence)}`,
    ),
    context("No action needed. The block ends by itself. Lift it early only if you want to."),
    { type: "actions", elements: [button("Lift block now", "lift_block", id, "danger")] },
  ];
}

export function announcementBlocks(a: AnnouncementRow) {
  return [
    section(`*Announcement draft: ${slackEscape(a.kind)} on ${slackEscape(a.channel)}*\nScheduled for ${a.scheduled_for}`),
    section(`>>> ${slackEscape(a.text)}`),
    context("Nothing is posted until you approve it."),
    {
      type: "actions",
      elements: [
        button("Approve", "ann_approve", a.id, "primary"),
        button("Edit", "ann_edit", a.id),
        button("Skip", "ann_skip", a.id, "danger"),
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

export interface InteractivePayload {
  type?: string;
  user: { id: string };
  trigger_id?: string;
  response_url?: string;
  actions?: { action_id: string; value: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null; selected_date_time?: number | null }>> };
  };
}

async function respond(url: string | undefined, text: string) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

function editModal(a: AnnouncementRow) {
  return {
    type: "modal",
    callback_id: "ann_edit",
    private_metadata: a.id,
    title: { type: "plain_text", text: "Edit announcement" },
    submit: { type: "plain_text", text: "Save and approve" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "text",
        label: { type: "plain_text", text: `${a.kind} on ${a.channel}` },
        element: { type: "plain_text_input", action_id: "text", multiline: true, initial_value: a.text },
      },
      {
        type: "input",
        block_id: "when",
        label: { type: "plain_text", text: "Post at" },
        element: { type: "datetimepicker", action_id: "when", initial_date_time: Math.floor(Date.parse(a.scheduled_for) / 1000) },
      },
    ],
  };
}

const getAnnouncement = (env: Env, id: string) =>
  env.SURVEY_DB.prepare("SELECT * FROM announcements WHERE id = ?1").bind(id).first<AnnouncementRow>();

/**
 * Handles a verified interactive payload. Returns the text shown in Slack, and for a modal
 * submission optionally a response body (validation errors) that must be sent back to Slack.
 */
export async function handleInteractive(env: Env, payload: InteractivePayload): Promise<{ text: string; body?: unknown }> {
  const who = payload.user.id;
  const db = env.SURVEY_DB;
  const mayOverride = listVar(env.SLACK_APPROVER_USER_IDS).includes(who);
  const mayAnnounce = listVar(env.SLACK_ANNOUNCEMENT_APPROVER_IDS).includes(who);

  // ----- Edit modal submitted -----
  if (payload.type === "view_submission" && payload.view?.callback_id === "ann_edit") {
    if (!mayAnnounce) return { text: "Not allowed.", body: { response_action: "errors", errors: { text: "You are not the announcement owner." } } };
    const a = await getAnnouncement(env, payload.view.private_metadata ?? "");
    if (!a || !["draft", "approved"].includes(a.status)) {
      return { text: "Too late.", body: { response_action: "errors", errors: { text: "This announcement can no longer be edited." } } };
    }
    const values = payload.view.state?.values ?? {};
    const text = (values.text?.text?.value ?? "").trim();
    const when = values.when?.when?.selected_date_time;
    const problem = checkAnnouncementText(a.channel, text);
    if (problem) return { text: problem, body: { response_action: "errors", errors: { text: problem } } };
    if (!when) return { text: "No time.", body: { response_action: "errors", errors: { when: "Pick a time." } } };
    const scheduled = new Date(when * 1000).toISOString();
    await db
      .prepare("UPDATE announcements SET text = ?2, scheduled_for = ?3, status = 'approved', decided_by = ?4 WHERE id = ?1")
      .bind(a.id, text, scheduled, `slack:${who}`)
      .run();
    await audit(env, `slack:${who}`, "announcement_edited_and_approved", { id: a.id, channel: a.channel, kind: a.kind, scheduled });
    await notify(env, `Announcement (${a.kind} on ${a.channel}) edited and approved by <@${who}>. It posts at ${scheduled}.`);
    return { text: "Saved." };
  }

  const action = payload.actions?.[0];
  if (!action) return { text: "No action." };
  let text: string;

  // ----- Announcements: only the announcement owner -----
  if (action.action_id.startsWith("ann_")) {
    if (!mayAnnounce) return { text: "Only the announcement owner can do that. Nothing was changed." };
    const a = await getAnnouncement(env, action.value);
    if (!a) text = "That announcement no longer exists.";
    else if (action.action_id === "ann_edit") {
      if (!["draft", "approved"].includes(a.status)) text = `Already ${a.status}.`;
      else {
        await slackCall(env, "views.open", { trigger_id: payload.trigger_id, view: editModal(a) });
        return { text: "Opened editor." };
      }
    } else if (a.status !== "draft") text = `Already ${a.status}.`;
    else {
      const status = action.action_id === "ann_approve" ? "approved" : "skipped";
      await db.prepare("UPDATE announcements SET status = ?2, decided_by = ?3 WHERE id = ?1").bind(a.id, status, `slack:${who}`).run();
      await audit(env, `slack:${who}`, `announcement_${status}`, { id: a.id, channel: a.channel, kind: a.kind });
      text =
        status === "approved"
          ? `Approved by <@${who}>: ${a.kind} on ${a.channel}, posts at ${a.scheduled_for}.\n>>> ${slackEscape(a.text)}`
          : `Skipped by <@${who}>: ${a.kind} on ${a.channel}.`;
    }
    await respond(payload.response_url, text);
    return { text };
  }

  // ----- Overrides of the agents: optional, approver list only -----
  if (!mayOverride) return { text: "You are not on the override list for the survey. Nothing was changed." };

  if (action.action_id === "lift_block") {
    const b = await db
      .prepare("SELECT id, scope, value, expires_at, lifted_at FROM blocks WHERE id = ?1")
      .bind(action.value)
      .first<{ id: string; scope: string; value: string; expires_at: string; lifted_at: string | null }>();
    if (!b) text = "That block no longer exists.";
    else if (b.lifted_at || b.expires_at <= nowIso()) text = "That block has already ended.";
    else {
      await db.prepare("UPDATE blocks SET expires_at = ?2, lifted_by = ?3, lifted_at = ?2 WHERE id = ?1").bind(b.id, nowIso(), `slack:${who}`).run();
      await audit(env, `slack:${who}`, "lift_block", { block: b.id, scope: b.scope, value: b.value });
      text = `Block on ${slackEscape(b.scope)} = ${slackEscape(b.value)} lifted by <@${who}>.`;
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
            .prepare("UPDATE responses SET status = 'accepted', status_category = NULL, status_reason = NULL, audited = 1, audit_note = ?2 WHERE id = ?1")
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
  return { text };
}

