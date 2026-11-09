// Option B: handle + one-time code. Our bot DMs a code to the claimed handle; only the real owner can read it.
import { discordCreatedAt } from "./providers";
import { type Env, type Provider, intVar, isConfigured } from "./env";

export type FallbackProvider = Extract<Provider, "discord" | "slack" | "mattermost">;
export const FALLBACK_PROVIDERS: FallbackProvider[] = ["discord", "slack", "mattermost"];

export type LookupResult = { ok: true; userId: string } | { ok: false; reason: string };

export function fallbackEnabled(env: Env, provider: Provider): provider is FallbackProvider {
  if (provider === "discord") return isConfigured(env.DISCORD_BOT_TOKEN) && isConfigured(env.DISCORD_FALLBACK_GUILD_ID);
  if (provider === "slack") return isConfigured(env.SLACK_BOT_TOKEN);
  if (provider === "mattermost") return isConfigured(env.MATTERMOST_URL) && isConfigured(env.MATTERMOST_BOT_TOKEN);
  return false;
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

const NOT_FOUND = "We could not find that handle. Check the spelling, or use the sign-in button instead.";

async function discordApi(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://discord.com/api${path}`, {
    ...init,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`discord ${path} ${res.status}`);
  return res.json();
}

async function slackApi(env: Env, method: string, params: Record<string, string>, post = false): Promise<any> {
  const url = `https://slack.com/api/${method}`;
  const res = post
    ? await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
      })
    : await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  const body = (await res.json()) as any;
  if (!body.ok) throw new Error(`slack ${method}: ${body.error}`);
  return body;
}

async function mmApi(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${env.MATTERMOST_URL!.replace(/\/+$/, "")}/api/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.MATTERMOST_BOT_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export async function lookupHandle(env: Env, provider: FallbackProvider, rawHandle: string): Promise<LookupResult> {
  const handle = normalizeHandle(rawHandle);
  if (!/^[\p{L}\p{N}._\-]{2,64}$/u.test(handle)) return { ok: false, reason: "That does not look like a valid handle." };

  if (provider === "discord") {
    const members = (await discordApi(
      env,
      `/guilds/${env.DISCORD_FALLBACK_GUILD_ID}/members/search?${new URLSearchParams({ query: handle, limit: "10" })}`,
    )) as { user: { id: string; username: string; bot?: boolean } }[];
    const m = members.find((x) => x.user.username.toLowerCase() === handle && !x.user.bot);
    if (!m) return { ok: false, reason: NOT_FOUND };
    const days = intVar(env.MIN_ACCOUNT_AGE_DAYS, 30);
    if ((Date.now() - discordCreatedAt(m.user.id).getTime()) / 86_400_000 < days) {
      return { ok: false, reason: `Discord accounts must be at least ${days} days old to take part.` };
    }
    return { ok: true, userId: m.user.id };
  }

  if (provider === "slack") {
    let cursor = "";
    for (let page = 0; page < 50; page++) {
      const body = await slackApi(env, "users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
      for (const u of body.members as any[]) {
        if (u.deleted || u.is_bot || u.id === "USLACKBOT") continue;
        const names = [u.name, u.profile?.display_name].filter(Boolean).map((s: string) => s.toLowerCase());
        if (names.includes(handle)) return { ok: true, userId: u.id };
      }
      cursor = body.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return { ok: false, reason: NOT_FOUND };
  }

  const res = await mmApi(env, `/users/username/${encodeURIComponent(handle)}`);
  if (res.status === 404) return { ok: false, reason: NOT_FOUND };
  if (!res.ok) throw new Error(`mattermost lookup ${res.status}`);
  const user = (await res.json()) as { id: string; is_bot?: boolean; delete_at?: number };
  if (user.is_bot || (user.delete_at ?? 0) > 0) return { ok: false, reason: NOT_FOUND };
  return { ok: true, userId: user.id };
}

export async function sendCode(env: Env, provider: FallbackProvider, userId: string, code: string): Promise<void> {
  const text =
    `Your XRPL Foundation community survey code is ${code}. It expires in 10 minutes. ` +
    `If you did not ask for this, ignore this message.`;

  if (provider === "discord") {
    const channel = await discordApi(env, "/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: userId }) });
    await discordApi(env, `/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ content: text }) });
    return;
  }
  if (provider === "slack") {
    await slackApi(env, "chat.postMessage", { channel: userId, text }, true);
    return;
  }
  const me = await mmApi(env, "/users/me");
  if (!me.ok) throw new Error(`mattermost bot ${me.status}`);
  const botId = ((await me.json()) as { id: string }).id;
  const dm = await mmApi(env, "/channels/direct", { method: "POST", body: JSON.stringify([botId, userId]) });
  if (!dm.ok) throw new Error(`mattermost dm ${dm.status}`);
  const channelId = ((await dm.json()) as { id: string }).id;
  const post = await mmApi(env, "/posts", { method: "POST", body: JSON.stringify({ channel_id: channelId, message: text }) });
  if (!post.ok) throw new Error(`mattermost post ${post.status}`);
}
