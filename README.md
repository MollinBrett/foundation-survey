# XRPL Foundation community survey

A public survey on how the XRPL community sees the Foundation. Every respondent is verified as a real person on one of five channels (X, Discord, Slack, GitHub, Mattermost), can answer once, and their answers are stored apart from who they are. Two Claude Managed Agents watch the responses: a **watchdog** that quarantines spam and abuse every hour, and a **reporter** that posts results daily. Blocking anything takes a human click in Slack.

Status: built and tested locally. **Not deployed.** The questions in `src/survey.ts` are a draft awaiting approval.

## How it works

```
respondent ──► landing page (?src=<post tag>)
                 │
                 ├─ A: "Continue with X / Discord / Slack / GitHub / Mattermost"  (OAuth sign-in)
                 └─ B: "Verify with your handle"  → our bot DMs a 6-digit code → respondent enters it
                 │
                 ▼
          checks: account age, workspace/server membership, active blocks, rate limits
                 │
                 ▼
          survey form + Cloudflare Turnstile ──► D1 database
                                                   identities: one-way hash of the account (no names, no times)
                                                   responses:  answers, channel, network, time (no account link)

watchdog agent (hourly) ──► /admin/api ──► quarantine junk (reversible) ──► Slack message with [Restore all]
                                       └─► propose a block           ──► Slack message with [Approve] [Reject]
reporter agent (daily)  ──► /admin/api ──► daily report, then one final report ──► Slack
```

- **One response per account.** The account hash is the identities table's primary key, written in the same transaction as the response.
- **Anonymity.** The two tables share no column, and the identities table holds no timestamp, so they cannot be joined. The same account hashes the same way on paths A and B, so nobody answers twice by switching paths.
- **Agents can't overreach.** The admin API lets agents read, quarantine and propose. Restoring and blocking exist only behind Slack buttons that check the clicker against `SLACK_APPROVER_USER_IDS`.

## Repository

| Path | What |
|---|---|
| `src/index.ts` | Routes: landing, sign-in (A), handle + code (B), survey, Slack buttons |
| `src/survey.ts` | **The questions (draft).** Edit here; form and validation follow |
| `src/providers.ts` | OAuth settings per channel, account-age and membership checks |
| `src/fallback.ts` | Bot lookup and DM for path B (Discord, Slack, Mattermost) |
| `src/admin.ts` | The agents' API (`/admin/api/*`) |
| `src/slack.ts` | Slack messages, request signing, Approve / Reject / Restore |
| `migrations/0001_init.sql` | Database tables |
| `agents/survey-watchdog/` | Watchdog agent, shared environment and vault, hourly schedule |
| `agents/survey-reporter/` | Reporter agent, daily schedule |
| `test/app.test.ts` | 16 tests: one-response rule, anonymity, age checks, code path, agent API limits, Slack approvals |
| `test/fixtures/watchdog-samples.*` | 50 labeled responses for testing the watchdog on staging |
| `scripts/score-watchdog.mjs` | Scores a watchdog run against those labels |

```bash
npm install
```

```bash
npm test
```

## Setup

Values to replace are marked `YOUR_...` in `wrangler.toml` and `agents/`. Secrets go in with `npx wrangler secret put NAME`, never in a file.

Each channel works independently: the landing page only shows channels whose keys are set, so you can launch with some and add the rest later.

### 1. Cloudflare (Foundation account)

1. `npx wrangler login`
2. `npx wrangler d1 create foundation-survey`. Put the returned ID in `wrangler.toml` as `database_id`.
3. `npm run db:migrate:remote`
4. Pick the survey's address (for example a subdomain of the Foundation's domain) and set `PUBLIC_BASE_URL`. Add it as a custom domain on the Worker after the first deploy.
5. Turnstile: create a widget for that hostname. Put the site key in `TURNSTILE_SITE_KEY` and the secret in `TURNSTILE_SECRET`.
6. Generate three random secrets and store them: `IDENTITY_PEPPER`, `SESSION_SECRET`, `ADMIN_API_KEY` (for example `openssl rand -base64 48` for each). **Keep `IDENTITY_PEPPER` stable for the life of the survey.** Changing it lets everyone answer again.
7. Set `SURVEY_OPENS_AT` / `SURVEY_CLOSES_AT`.

Every sign-in app below uses the redirect URI `PUBLIC_BASE_URL/auth/<channel>/callback`.

### 2. Sign-in apps (one per channel)

| Channel | Where | Settings | Secrets |
|---|---|---|---|
| GitHub | Foundation GitHub org, Settings, Developer settings, OAuth Apps | Callback `/auth/github/callback`. No scopes needed | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Discord | Discord Developer Portal, new application | OAuth2 redirect `/auth/discord/callback`. For path B, add a bot, turn on the Server Members intent, and invite it to the XRPL server; set `DISCORD_FALLBACK_GUILD_ID`. Optional: `DISCORD_REQUIRED_GUILD_ID` to require server membership | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` |
| Slack | api.slack.com/apps, new app in the community workspace | "Sign in with Slack" (OpenID, scope `openid`), redirect `/auth/slack/callback`. Bot scopes `chat:write`, `users:read`. Interactivity on, request URL `PUBLIC_BASE_URL/slack/interactive`. Invite the bot to the watchdog channel. Set `SLACK_ALLOWED_TEAM_IDS`, `SLACK_WATCHDOG_CHANNEL_ID`, `SLACK_APPROVER_USER_IDS` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| X | X developer portal, a project and app | OAuth 2.0, confidential client, callback `/auth/x/callback`, scopes `users.read tweet.read`. Check which access tier is needed and what it costs before relying on X | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| Mattermost | **The server's administrator** | System Console: enable the OAuth 2.0 service provider, register an app with callback `/auth/mattermost/callback`. For path B: enable bot accounts and create a bot. Set `MATTERMOST_URL` | `MATTERMOST_CLIENT_ID`, `MATTERMOST_CLIENT_SECRET`, `MATTERMOST_BOT_TOKEN` |

The Slack app can be the Foundation's own workspace app if the community and watchdog channels are in the same workspace. If they are not, the watchdog channel needs its own bot token, which the code does not support yet.

### 3. Agents (Claude Managed Agents)

Needs the `ant` CLI signed in to the Foundation's Anthropic organization.

**What the agents can touch:** only `YOUR_SURVEY_HOST` (the environment's network is limited to it, and web search and fetch are off). The one credential:

| Secret | Sent only to | Used for | Scope |
|---|---|---|---|
| `ADMIN_API_KEY` (as `SURVEY_ADMIN_KEY`) | `YOUR_SURVEY_HOST` | Every `/admin/api` call | Read responses, quarantine, propose blocks, post reports. Cannot restore, block or delete |

Steps:

1. Replace `YOUR_SURVEY_HOST` in `agents/survey-watchdog/environment.yaml` and both `agent.md` files.
2. Create the agents, environment and vault (review the dry run first):
   ```bash
   ant apply --dry-run -v agents/survey-watchdog/agent.md agents/survey-reporter/agent.md agents/survey-watchdog/environment.yaml agents/survey-watchdog/vault.yaml
   ```
   ```bash
   ant apply agents/survey-watchdog/agent.md agents/survey-reporter/agent.md agents/survey-watchdog/environment.yaml agents/survey-watchdog/vault.yaml
   ```
3. Store the admin key in the vault. Run in your own terminal and paste the key at the silent prompt:
   ```bash
   VAULT_ID=$(jq -r '.resources["./agents/survey-watchdog/vault.yaml"].id' claude-lock.json)
   ```
   ```bash
   read -rs CMA_SURVEY_ADMIN_KEY && export CMA_SURVEY_ADMIN_KEY
   ```
   ```bash
   jq -n -f /dev/stdin <<'JQ' | env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN ant beta:vaults:credentials create --vault-id "$VAULT_ID"
   {
     display_name: "Survey admin API",
     auth: {
       type: "environment_variable",
       secret_name: "SURVEY_ADMIN_KEY",
       secret_value: (env.CMA_SURVEY_ADMIN_KEY // error("CMA_SURVEY_ADMIN_KEY is not set")),
       networking: {type: "limited", allowed_hosts: ["YOUR_SURVEY_HOST"]},
       injection_location: {header: true, body: false}
     }
   }
   JQ
   ```
   ```bash
   unset CMA_SURVEY_ADMIN_KEY
   ```
   If your `ant` login uses `ANTHROPIC_API_KEY` rather than `ant auth login`, drop the `env -u ...` prefix.
4. Put the `vlt_...` ID in `vault_ids` in both deployment files, then create the schedules and **pause them until launch**:
   ```bash
   ant apply agents/survey-watchdog/deployment-hourly.yaml agents/survey-reporter/deployment-daily.yaml
   ```
   ```bash
   ant beta:deployments pause --deployment-id "$(jq -r '.resources["./agents/survey-watchdog/deployment-hourly.yaml"].id' claude-lock.json)"
   ```
   ```bash
   ant beta:deployments pause --deployment-id "$(jq -r '.resources["./agents/survey-reporter/deployment-daily.yaml"].id' claude-lock.json)"
   ```
5. Commit `claude-lock.json`.

The reporter runs at 13:00 UTC as a placeholder. Change `deployment-daily.yaml` to the time you want.

## Before launch: test the watchdog on staging

Use a separate staging Worker and database, never production.

```bash
node scripts/make-watchdog-fixtures.mjs
```
```bash
npx wrangler d1 execute foundation-survey-staging --remote --file test/fixtures/watchdog-samples.sql
```

Run the watchdog once against staging (start a session for `survey-watchdog` from the Console with the kickoff message in `deployment-hourly.yaml`), then:

```bash
SURVEY_URL=https://YOUR_STAGING_HOST SURVEY_ADMIN_KEY=... node scripts/score-watchdog.mjs
```

The bar: **zero genuine responses removed** (30 of the 50 are genuine, including harsh criticism and profanity), and all spam and abuse caught. If it misses, tune the prompt in `agents/survey-watchdog/agent.md`, re-apply, and re-run.

## Launch checklist

- [ ] Questions in `src/survey.ts` approved
- [ ] Settings confirmed: account age (`MIN_ACCOUNT_AGE_DAYS`, default 30), rate limits, open and close times
- [ ] Each channel signed in end to end on staging
- [ ] Watchdog scored on staging
- [ ] `npm run deploy`, schedules unpaused
- [ ] Launch posts use `?src=` tags per post (for example `?src=x-launch`, `?src=discord-announce`)

## After the survey

- The final report posts once, automatically, after `SURVEY_CLOSES_AT`.
- The identities table is only needed during the survey. Clear it 30 days after close (not automated):
  ```bash
  npx wrangler d1 execute foundation-survey --remote --command "DELETE FROM identities; DELETE FROM fallback_codes;"
  ```
- Responses keep a network number (ASN) and country for flood detection. Drop those columns before sharing raw data outside leadership.

## Not yet verified

The sign-in endpoints in `src/providers.ts` and the bot calls in `src/fallback.ts` follow each vendor's documented APIs but have only been exercised against mocks. Sign in once per channel on staging before launch.
