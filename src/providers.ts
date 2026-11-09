// Sign-in providers (option A). Endpoints are from each vendor's OAuth docs; confirm them during setup
// (README "Smoke test") since vendors move them.
import { type Env, type Provider, intVar, isConfigured, listVar } from "./env";

export interface ProviderUser {
  userId: string;
  createdAt?: Date; // account creation time, when the provider gives it
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

interface ProviderConfig {
  authorizeUrl(env: Env): string;
  tokenUrl(env: Env): string;
  scope(env: Env): string;
  clientId(env: Env): string | undefined;
  clientSecret(env: Env): string | undefined;
  pkce: boolean;
  /** Send client credentials as HTTP Basic instead of form fields. */
  basicAuth?: boolean;
  fetchUser(env: Env, token: string): Promise<ProviderUser & { extra?: Record<string, unknown> }>;
  eligibility(env: Env, user: ProviderUser & { extra?: Record<string, unknown> }, token: string): Promise<Eligibility>;
}

const DISCORD_EPOCH = 1420070400000n;

export function discordCreatedAt(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH));
}

function ageCheck(env: Env, createdAt: Date | undefined, label: string): Eligibility {
  const days = intVar(env.MIN_ACCOUNT_AGE_DAYS, 30);
  if (!createdAt || Number.isNaN(createdAt.getTime())) return { ok: false, reason: `We could not confirm your ${label} account's age.` };
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  if (ageDays < days) return { ok: false, reason: `${label} accounts must be at least ${days} days old to take part.` };
  return { ok: true };
}

async function getJson(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "foundation-survey", ...extraHeaders },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

const mmBase = (env: Env) => (env.MATTERMOST_URL ?? "").replace(/\/+$/, "");

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  x: {
    authorizeUrl: () => "https://x.com/i/oauth2/authorize",
    tokenUrl: () => "https://api.x.com/2/oauth2/token",
    scope: () => "users.read tweet.read",
    clientId: (env) => env.X_CLIENT_ID,
    clientSecret: (env) => env.X_CLIENT_SECRET,
    pkce: true,
    basicAuth: true,
    async fetchUser(_env, token) {
      const body = await getJson("https://api.x.com/2/users/me?user.fields=created_at", token);
      return { userId: String(body.data.id), createdAt: new Date(body.data.created_at) };
    },
    async eligibility(env, user) {
      return ageCheck(env, user.createdAt, "X");
    },
  },
  discord: {
    authorizeUrl: () => "https://discord.com/oauth2/authorize",
    tokenUrl: () => "https://discord.com/api/oauth2/token",
    scope: (env) => (isConfigured(env.DISCORD_REQUIRED_GUILD_ID) ? "identify guilds" : "identify"),
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    pkce: true,
    async fetchUser(_env, token) {
      const body = await getJson("https://discord.com/api/users/@me", token);
      return { userId: String(body.id), createdAt: discordCreatedAt(String(body.id)) };
    },
    async eligibility(env, user, token) {
      const age = ageCheck(env, user.createdAt, "Discord");
      if (!age.ok) return age;
      if (isConfigured(env.DISCORD_REQUIRED_GUILD_ID)) {
        const guilds = (await getJson("https://discord.com/api/users/@me/guilds", token)) as { id: string }[];
        if (!guilds.some((g) => g.id === env.DISCORD_REQUIRED_GUILD_ID)) {
          return { ok: false, reason: "Please join the XRPL Discord server first, then try again." };
        }
      }
      return { ok: true };
    },
  },
  slack: {
    // Sign in with Slack (OpenID Connect)
    authorizeUrl: () => "https://slack.com/openid/connect/authorize",
    tokenUrl: () => "https://slack.com/api/openid.connect.token",
    scope: () => "openid",
    clientId: (env) => env.SLACK_CLIENT_ID,
    clientSecret: (env) => env.SLACK_CLIENT_SECRET,
    pkce: false,
    async fetchUser(_env, token) {
      const body = await getJson("https://slack.com/api/openid.connect.userInfo", token);
      if (!body.ok) throw new Error(`slack userInfo: ${body.error}`);
      return { userId: String(body.sub), extra: { teamId: body["https://slack.com/team_id"] } };
    },
    async eligibility(env, user) {
      const allowed = listVar(env.SLACK_ALLOWED_TEAM_IDS);
      if (!allowed.includes(String(user.extra?.teamId))) {
        return { ok: false, reason: "That Slack workspace is not one of the community workspaces for this survey." };
      }
      return { ok: true };
    },
  },
  github: {
    authorizeUrl: () => "https://github.com/login/oauth/authorize",
    tokenUrl: () => "https://github.com/login/oauth/access_token",
    scope: () => "",
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    pkce: false,
    async fetchUser(_env, token) {
      const body = await getJson("https://api.github.com/user", token, { Accept: "application/vnd.github+json" });
      return { userId: String(body.id), createdAt: new Date(body.created_at) };
    },
    async eligibility(env, user) {
      return ageCheck(env, user.createdAt, "GitHub");
    },
  },
  mattermost: {
    // Needs the Mattermost server admin to enable the OAuth 2.0 service provider and register this app.
    authorizeUrl: (env) => `${mmBase(env)}/oauth/authorize`,
    tokenUrl: (env) => `${mmBase(env)}/oauth/access_token`,
    scope: () => "",
    clientId: (env) => env.MATTERMOST_CLIENT_ID,
    clientSecret: (env) => env.MATTERMOST_CLIENT_SECRET,
    pkce: false,
    async fetchUser(env, token) {
      const body = await getJson(`${mmBase(env)}/api/v4/users/me`, token);
      return { userId: String(body.id), extra: { isBot: !!body.is_bot } };
    },
    async eligibility(_env, user) {
      // Members of a private server are already vetted. Bots are refused.
      if (user.extra?.isBot) return { ok: false, reason: "Bot accounts cannot take part." };
      return { ok: true };
    },
  },
};

export function oauthEnabled(env: Env, provider: Provider): boolean {
  const cfg = PROVIDER_CONFIG[provider];
  if (provider === "mattermost" && !isConfigured(env.MATTERMOST_URL)) return false;
  return isConfigured(cfg.clientId(env)) && isConfigured(cfg.clientSecret(env));
}

export function redirectUri(env: Env, provider: Provider): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/auth/${provider}/callback`;
}

export function authorizeUrl(env: Env, provider: Provider, state: string, challenge?: string): string {
  const cfg = PROVIDER_CONFIG[provider];
  const url = new URL(cfg.authorizeUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId(env)!);
  url.searchParams.set("redirect_uri", redirectUri(env, provider));
  url.searchParams.set("state", state);
  const scope = cfg.scope(env);
  if (scope) url.searchParams.set("scope", scope);
  if (cfg.pkce && challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export async function exchangeCode(env: Env, provider: Provider, code: string, verifier?: string): Promise<string> {
  const cfg = PROVIDER_CONFIG[provider];
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env, provider),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "foundation-survey",
  };
  if (cfg.basicAuth) {
    headers.Authorization = `Basic ${btoa(`${cfg.clientId(env)}:${cfg.clientSecret(env)}`)}`;
    form.set("client_id", cfg.clientId(env)!);
  } else {
    form.set("client_id", cfg.clientId(env)!);
    form.set("client_secret", cfg.clientSecret(env)!);
  }
  if (cfg.pkce && verifier) form.set("code_verifier", verifier);
  const res = await fetch(cfg.tokenUrl(env), { method: "POST", headers, body: form });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token exchange failed: ${res.status} ${body.error ?? ""}`);
  return body.access_token;
}
