// Announcements: launch and reminder posts.
// The announcer agent drafts them, the announcement owner approves them in Slack,
// and this module publishes approved posts when they are due. The agent never posts.
import { type Env, isConfigured } from "./env";
import { base64url } from "./crypto";
import { audit, nowIso, surveyWindow } from "./db";

export type AnnounceChannel = "x" | "discord" | "slack" | "mattermost";
export const ANNOUNCE_CHANNELS: AnnounceChannel[] = ["x", "discord", "slack", "mattermost"];
export type AnnouncementKind = "launch" | "reminder" | "last_call" | "thanks";
export const ANNOUNCEMENT_KINDS: AnnouncementKind[] = ["launch", "reminder", "last_call", "thanks"];
export const LINK_PLACEHOLDER = "{link}";
export const MAX_LENGTH: Record<AnnounceChannel, number> = { x: 280, discord: 2000, slack: 3000, mattermost: 4000 };

export interface AnnouncementRow {
  id: string;
  kind: AnnouncementKind;
  channel: AnnounceChannel;
  text: string;
  scheduled_for: string;
  status: string;
}

/** Each post gets its own link so responses can be traced to the post that brought them. */
export function announcementLink(env: Env, channel: string, kind: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/?src=${channel}-${kind.replace(/_/g, "-")}`;
}

/** X counts every link as 23 characters. */
function weightedLength(channel: string, text: string): number {
  return channel === "x" ? text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length : text.length;
}

/** Returns a problem description, or null if the final text is fine for the channel. */
export function checkAnnouncementText(channel: string, text: string): string | null {
  if (!text.trim()) return "The text is empty.";
  const max = MAX_LENGTH[channel as AnnounceChannel];
  if (max && weightedLength(channel, text) > max) return `Too long for ${channel}: the limit is ${max} characters.`;
  if (/@(everyone|here|channel)\b/i.test(text)) return "Mass mentions (@everyone, @here, @channel) are not allowed.";
  return null;
}

export function canPostAutomatically(env: Env, channel: AnnounceChannel): boolean {
  if (channel === "slack") return isConfigured(env.SLACK_BOT_TOKEN) && isConfigured(env.SLACK_ANNOUNCE_CHANNEL_ID);
  if (channel === "discord") return isConfigured(env.DISCORD_ANNOUNCE_WEBHOOK_URL);
  if (channel === "mattermost") return isConfigured(env.MATTERMOST_ANNOUNCE_WEBHOOK_URL);
  return (
    isConfigured(env.X_POST_API_KEY) && isConfigured(env.X_POST_API_SECRET) && isConfigured(env.X_POST_ACCESS_TOKEN) && isConfigured(env.X_POST_ACCESS_SECRET)
  );
}

// ---------- Posting ----------

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a header for a JSON request (the JSON body is not part of the signature). */
export async function oauth1Header(
  method: string,
  url: string,
  creds: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string },
  nonce = base64url(crypto.getRandomValues(new Uint8Array(16))),
  timestamp = Math.floor(Date.now() / 1000).toString(),
  signedParams: Record<string, string> = {}, // query or form parameters; empty for a JSON body
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all: Record<string, string> = { ...signedParams, ...oauth };
  const params = Object.keys(all)
    .map((k) => [rfc3986(k), rfc3986(all[k]!)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(params)].join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  oauth.oauth_signature = btoa(bin);
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k]!)}"`)
    .join(", ")}`;
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function postTo(env: Env, channel: AnnounceChannel, text: string): Promise<void> {
  const json = { "Content-Type": "application/json" };
  if (channel === "discord") {
    // allowed_mentions: [] stops the post from pinging anyone.
    await expectOk(
      await fetch(env.DISCORD_ANNOUNCE_WEBHOOK_URL!, { method: "POST", headers: json, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) }),
      "Discord webhook",
    );
  } else if (channel === "mattermost") {
    await expectOk(await fetch(env.MATTERMOST_ANNOUNCE_WEBHOOK_URL!, { method: "POST", headers: json, body: JSON.stringify({ text }) }), "Mattermost webhook");
  } else if (channel === "slack") {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: env.SLACK_ANNOUNCE_CHANNEL_ID, text }),
    });
    const body = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(`Slack chat.postMessage: ${body.error}`);
  } else {
    const url = "https://api.x.com/2/tweets";
    const auth = await oauth1Header("POST", url, {
      consumerKey: env.X_POST_API_KEY!,
      consumerSecret: env.X_POST_API_SECRET!,
      token: env.X_POST_ACCESS_TOKEN!,
      tokenSecret: env.X_POST_ACCESS_SECRET!,
    });
    await expectOk(await fetch(url, { method: "POST", headers: { ...json, Authorization: auth }, body: JSON.stringify({ text }) }), "X");
  }
}

/**
 * Publish every approved announcement that is due. Runs from the scheduled handler.
 * `tell` posts a note to the team's Slack channel (passed in to avoid a module cycle).
 */
export async function publishDue(env: Env, tell: (text: string) => Promise<void>): Promise<number> {
  const db = env.SURVEY_DB;
  const { results } = await db
    .prepare("SELECT * FROM announcements WHERE status = 'approved' AND scheduled_for <= ?1 ORDER BY scheduled_for LIMIT 20")
    .bind(nowIso())
    .all<AnnouncementRow>();
  const window = surveyWindow(env);
  let done = 0;
  for (const a of results) {
    const set = (status: string, error: string | null = null) =>
      db.prepare("UPDATE announcements SET status = ?2, posted_at = ?3, error = ?4 WHERE id = ?1").bind(a.id, status, nowIso(), error).run();

    // Never invite people to a survey that is not open.
    const needsOpen = a.kind !== "thanks";
    if ((needsOpen && window !== "open") || (!needsOpen && window !== "closed")) {
      if (window === "before" || (!needsOpen && window === "open")) continue; // not yet
      await set("skipped", "survey already closed");
      await audit(env, "system", "announcement_skipped", { id: a.id, reason: "survey already closed" });
      continue;
    }
    if (!canPostAutomatically(env, a.channel)) {
      await set("handed_off");
      await audit(env, "system", "announcement_handed_off", { id: a.id, channel: a.channel, kind: a.kind });
      await tell(`Automatic posting to ${a.channel} is not set up. Please post this approved ${a.kind} announcement there by hand:\n>>> ${a.text}`);
      continue;
    }
    try {
      await postTo(env, a.channel, a.text);
      await set("posted");
      await audit(env, "system", "announcement_posted", { id: a.id, channel: a.channel, kind: a.kind });
      done++;
    } catch (err) {
      await set("failed", String(err).slice(0, 300));
      await audit(env, "system", "announcement_failed", { id: a.id, channel: a.channel, error: String(err).slice(0, 300) });
      await tell(`Posting the ${a.kind} announcement to ${a.channel} failed. It was not retried. Text:\n>>> ${a.text}`);
    }
  }
  return done;
}
