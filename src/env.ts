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
  TURNSTILE_SITE_KEY?: string;
  SLACK_ALLOWED_TEAM_IDS?: string;
  SLACK_WATCHDOG_CHANNEL_ID?: string;
  SLACK_APPROVER_USER_IDS?: string;
  DISCORD_REQUIRED_GUILD_ID?: string;
  DISCORD_FALLBACK_GUILD_ID?: string;
  MATTERMOST_URL?: string;

  // Secrets
  IDENTITY_PEPPER: string;
  SESSION_SECRET: string;
  ADMIN_API_KEY: string;
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
