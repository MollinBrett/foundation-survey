export interface Env {
  SURVEY_DB: D1Database;

  PUBLIC_BASE_URL: string;
  SURVEY_OPENS_AT: string;
  SURVEY_CLOSES_AT: string;
  MIN_ACCOUNT_AGE_DAYS?: string;
  RATE_LIMIT_SIGNIN_PER_HOUR?: string;
  RATE_LIMIT_SUBMIT_PER_HOUR?: string;
  MIN_CHANNEL_REPORT_SIZE?: string;
  MIN_GROUP_REPORT_SIZE?: string;
  KPI_TARGET_PCT?: string;
  // Limits on blocks the watchdog may apply without a person.
  MAX_BLOCK_HOURS_NARROW?: string; // network (asn) or launch-post link (source)
  MAX_BLOCK_HOURS_BROAD?: string; // whole channel (provider) or country
  MAX_AUTO_BLOCKS_PER_DAY?: string;
  IDENTITY_RETENTION_DAYS?: string;
  TURNSTILE_SITE_KEY?: string;
  SLACK_ALLOWED_TEAM_IDS?: string;
  SLACK_WATCHDOG_CHANNEL_ID?: string;
  SLACK_APPROVER_USER_IDS?: string; // may override the agents (restore, lift a block)
  SLACK_ANNOUNCEMENT_APPROVER_IDS?: string; // may approve, edit or skip announcements
  SLACK_ANNOUNCE_CHANNEL_ID?: string; // community Slack channel that receives announcements
  DISCORD_REQUIRED_GUILD_ID?: string;
  DISCORD_FALLBACK_GUILD_ID?: string;
  MATTERMOST_URL?: string;
  // Cloudflare Access in front of /results.
  ACCESS_TEAM_DOMAIN?: string; // e.g. xrplf.cloudflareaccess.com
  ACCESS_AUD?: string;

  // Secrets
  IDENTITY_PEPPER: string;
  SESSION_SECRET: string;
  // One key per agent. Each key only unlocks that agent's part of /admin/api.
  WATCHDOG_API_KEY?: string;
  AUDITOR_API_KEY?: string;
  REPORTER_API_KEY?: string;
  ANNOUNCER_API_KEY?: string;
  TURNSTILE_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MATTERMOST_CLIENT_ID?: string;
  MATTERMOST_CLIENT_SECRET?: string;
  MATTERMOST_BOT_TOKEN?: string;
  // Posting announcements
  DISCORD_ANNOUNCE_WEBHOOK_URL?: string;
  MATTERMOST_ANNOUNCE_WEBHOOK_URL?: string;
  X_POST_API_KEY?: string;
  X_POST_API_SECRET?: string;
  X_POST_ACCESS_TOKEN?: string;
  X_POST_ACCESS_SECRET?: string;

  // Tests only
  TEST_MIGRATIONS?: unknown;
}

export type Provider = "x" | "discord" | "slack" | "github" | "mattermost";
export const PROVIDERS: Provider[] = ["x", "discord", "slack", "github", "mattermost"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  x: "X",
  discord: "Discord",
  slack: "Slack",
  github: "GitHub",
  mattermost: "Mattermost",
};

export type AgentRole = "watchdog" | "auditor" | "reporter" | "announcer";
export const AGENT_ROLES: AgentRole[] = ["watchdog", "auditor", "reporter", "announcer"];

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function listVar(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("YOUR_"));
}

export function isConfigured(value: string | undefined): value is string {
  return !!value && !value.startsWith("YOUR_");
}
