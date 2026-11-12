import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUBLIC_BASE_URL: "https://survey.test",
            SURVEY_OPENS_AT: "2020-01-01T00:00:00Z",
            SURVEY_CLOSES_AT: "2099-01-01T00:00:00Z",
            IDENTITY_PEPPER: "test-pepper-test-pepper-test-pepper",
            SESSION_SECRET: "test-session-secret-test-session-secret",
            WATCHDOG_API_KEY: "test-watchdog-key",
            AUDITOR_API_KEY: "test-auditor-key",
            REPORTER_API_KEY: "test-reporter-key",
            ANNOUNCER_API_KEY: "test-announcer-key",
            SLACK_ANNOUNCEMENT_APPROVER_IDS: "UVET",
            SLACK_ANNOUNCE_CHANNEL_ID: "CCOMMUNITY",
            DISCORD_ANNOUNCE_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
            ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            TURNSTILE_SECRET: "test-turnstile",
            SLACK_SIGNING_SECRET: "test-slack-signing",
            SLACK_BOT_TOKEN: "xoxb-test",
            SLACK_WATCHDOG_CHANNEL_ID: "CWATCH",
            SLACK_APPROVER_USER_IDS: "UAPPROVER",
            SLACK_ALLOWED_TEAM_IDS: "TTEAM",
            MIN_GROUP_REPORT_SIZE: "3",
            GITHUB_CLIENT_ID: "gh-id",
            GITHUB_CLIENT_SECRET: "gh-secret",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
