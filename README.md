# XRPL Foundation community survey

A public survey on how the XRPL community sees the Foundation, built to run itself. Every respondent is verified as a real person on one of five channels (X, Discord, Slack, GitHub, Mattermost), can answer once, and their answers are stored apart from who they are. Four Claude Managed Agents do the work a person used to do. The only thing a person needs to do is open the results page.

Status: built and tested locally (37 automated tests). **Not deployed.** The 10 questions in `src/survey.ts` were approved on 2026-11-12, and this survey is the Foundation's official 2026 KPI measure.

## Who does what

| Job | Done by | A person is needed? |
|---|---|---|
| Verify each respondent, one answer each, bot check, rate limits | The app | No |
| Screen every response; remove spam, abuse, duplicates and coordinated floods | **Watchdog agent**, hourly | No |
| Stop a flood that is still going on with a temporary block | **Watchdog agent**, within limits set in code | No |
| Re-check every removal and restore honest responses | **Auditor agent**, twice a day | No |
| Calculate the KPI figures | The app (`src/results.ts`) | No |
| Summarize results and free-text themes, daily and at close | **Reporter agent** | No |
| Draft the launch, reminder, last-call and thank-you posts | **Announcer agent**, daily | The announcement owner approves each post in Slack |
| Publish approved posts at their scheduled time | The app | No |
| Notice when something breaks and say so in Slack | The app, every 15 minutes | Only if it reports a problem |
| Delete account hashes and network details 30 days after close | The app | No |

People can step in from Slack (restore a removed batch, lift a block early), but never have to. The results page counts how many times anyone did.

## Why the numbers can be trusted without a person checking

Agents decide which responses count toward an official KPI, so the design replaces a person's review with controls that do not depend on anyone's good behaviour:

- **Each agent has its own key, and each key only unlocks that agent's job.** The watchdog can remove and block. The auditor can restore but cannot remove or block. The reporter can read and report but cannot change a response. The announcer can draft posts and cannot read responses. This is enforced in `src/admin.ts` and tested.
- **Blocks have hard limits in code.** A block on one network or one launch-post link lasts at most 24 hours. A block on a whole channel or country lasts at most 6 hours, and only one of those can be active at a time. At most 6 blocks in any 24 hours. Every block needs stated evidence and ends by itself.
- **Every removal gets an independent second review.** The auditor is not shown the watchdog's category or reason. What the auditor restores, the watchdog cannot remove again.
- **Every KPI is shown both ways.** The results page and the reports give each figure with the removed responses excluded and with them counted back in, so anyone can see how much the moderation moved the number.
- **The KPI figures come from code, not from an agent.** The reporter relays them and is told not to recalculate.
- **The final report waits** until every response has been screened and every removal re-checked.
- **Everything is logged** and shown on the results page: what each agent did, when, and why.

## How it works

```
respondent ──► landing page (?src=<post tag>)
                 ├─ A: "Continue with X / Discord / Slack / GitHub / Mattermost"  (OAuth sign-in)
                 └─ B: "Verify with your handle"  → our bot DMs a 6-digit code → respondent enters it
                 ▼
          checks: account age, membership, active blocks, rate limits
                 ▼
          survey form + Cloudflare Turnstile ──► D1 database
                                                   identities: one-way hash of the account (no names, no times)
                                                   responses:  answers, channel, network, time (no account link)

watchdog (hourly)    ──► removes junk, applies bounded temporary blocks
auditor (twice daily)──► re-checks every removal blind, restores honest responses
reporter (daily)     ──► daily report, then one final report, with free-text themes
announcer (daily)    ──► drafts posts ──► owner approves in Slack ──► the app publishes when due
the app (every 15 min) ► publishes due posts, self-checks, cleans up

/results (private, behind Cloudflare Access) ◄── live KPIs, themes, and the log of everything the agents did
```

- **One response per account.** The account hash is the identities table's primary key, written in the same transaction as the response.
- **Anonymity.** The two tables share no column, and the identities table holds no timestamp, so they cannot be joined. The same account hashes the same way on paths A and B.

## The questions and how they are scored

Ten questions: familiarity (a filter), seven KPI ratings, one optional free-text question, and role.

| KPI question | Answers (worst to best) |
|---|---|
| Overall satisfaction (**headline**) | Very dissatisfied to Very satisfied |
| Impact on the XRP Ledger ecosystem | Very negative to Very positive |
| Independence from Ripple | Not at all to Completely independent |
| Transparency about decisions | Not at all to Extremely transparent |
| Transparency about finances | Not at all to Extremely transparent |
| Listening to community input | Not at all well to Extremely well |
| Leadership team performance | Very poor to Very good |

- Every answer is labeled in words. Each KPI question also offers "Don't know enough to say".
- **Positive** = top two answers, **negative** = bottom two, **neutral** = the middle one. "Don't know" is left out of the percentages and counted separately.
- Each KPI is reported for all respondents, for respondents at least "Moderately familiar" with the Foundation, and by role for roles with at least `MIN_GROUP_REPORT_SIZE` responses (default 30).
- The target is `KPI_TARGET_PCT` percent positive (default 80, taken from the 2027 budget workbook; confirm it for 2026).
- The free-text question is used for themes only and never counts as positive or negative.
- Respondents choose to take part, so results describe respondents, not the whole community, and no margin of error applies.

Keep the wording and the order fixed: later surveys must match for results to be comparable.

## Repository

| Path | What |
|---|---|
| `src/index.ts` | Routes: landing, sign-in (A), handle + code (B), survey, Slack, results page, scheduled jobs |
| `src/survey.ts` | The approved questions |
| `src/results.ts` | KPI scoring |
| `src/admin.ts` | The agents' API (`/admin/api/*`), per-agent keys, block limits |
| `src/dashboard.ts` | The private results page and Cloudflare Access check |
| `src/announce.ts` | Publishing approved posts to Slack, Discord, Mattermost and X |
| `src/cron.ts` | Every 15 minutes: publish due posts, self-check, clean up |
| `src/slack.ts` | Slack notices, optional overrides, the announcement owner's Approve / Edit / Skip |
| `src/providers.ts`, `src/fallback.ts` | Sign-in per channel; bot lookup and DM for path B |
| `migrations/0001_init.sql` | Database tables |
| `agents/survey-*/` | The four agents: instructions (`agent.md`), vault, schedule. The shared environment is in `survey-watchdog/` |
| `test/app.test.ts` | 37 tests |
| `test/fixtures/watchdog-samples.*`, `scripts/score-watchdog.mjs` | 50 labeled responses and a scorer, for testing the watchdog and auditor on staging |

```bash
npm install
```

```bash
npm test
```

## Setup (once)

Values to replace are marked `YOUR_...` in `wrangler.toml` and `agents/`. Secrets go in with `npx wrangler secret put NAME`, never in a file. Each channel works independently: the landing page only shows channels whose keys are set.

### 1. Cloudflare (Foundation account)

1. `npx wrangler login`
2. `npx wrangler d1 create foundation-survey`. Put the returned ID in `wrangler.toml` as `database_id`.
3. `npm run db:migrate:remote`
4. Pick the survey's address and set `PUBLIC_BASE_URL`. Add it as a custom domain on the Worker after the first deploy.
5. Turnstile: create a widget for that hostname. Site key in `TURNSTILE_SITE_KEY`, secret in `TURNSTILE_SECRET`.
6. Generate and store six random secrets (for example `openssl rand -base64 48` for each): `IDENTITY_PEPPER`, `SESSION_SECRET`, `WATCHDOG_API_KEY`, `AUDITOR_API_KEY`, `REPORTER_API_KEY`, `ANNOUNCER_API_KEY`. The four agent keys must all be different. **Keep `IDENTITY_PEPPER` stable for the life of the survey.** Changing it lets everyone answer again.
7. Results page: in Cloudflare Zero Trust, add a self-hosted Access application for `YOUR_SURVEY_HOST/results` with a policy listing who may see results. Put the team domain in `ACCESS_TEAM_DOMAIN` and the application's audience tag in `ACCESS_AUD`. Until both are set, `/results` stays closed.
8. Set `SURVEY_OPENS_AT`, `SURVEY_CLOSES_AT` and `KPI_TARGET_PCT`.

Every sign-in app below uses the redirect URI `PUBLIC_BASE_URL/auth/<channel>/callback`.

### 2. Sign-in apps (one per channel)

| Channel | Where | Settings | Secrets |
|---|---|---|---|
| GitHub | Foundation GitHub org, Settings, Developer settings, OAuth Apps | Callback `/auth/github/callback`. No scopes | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Discord | Discord Developer Portal, new application | OAuth2 redirect `/auth/discord/callback`. For path B, add a bot with the Server Members intent, invite it to the XRPL server, set `DISCORD_FALLBACK_GUILD_ID`. Optional: `DISCORD_REQUIRED_GUILD_ID` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` |
| Slack | api.slack.com/apps, new app | "Sign in with Slack" (scope `openid`), redirect `/auth/slack/callback`. Bot scopes `chat:write`, `users:read`. Interactivity on, request URL `PUBLIC_BASE_URL/slack/interactive`. Invite the bot to the team's survey channel. Set `SLACK_ALLOWED_TEAM_IDS`, `SLACK_WATCHDOG_CHANNEL_ID`, `SLACK_APPROVER_USER_IDS`, `SLACK_ANNOUNCEMENT_APPROVER_IDS` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| X | X developer portal | OAuth 2.0, confidential client, callback `/auth/x/callback`, scopes `users.read tweet.read`. Check the access tier and its cost first | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| Mattermost | **The server's administrator** | Enable the OAuth 2.0 service provider and register an app with callback `/auth/mattermost/callback`. For path B: enable bot accounts and create a bot. Set `MATTERMOST_URL` | `MATTERMOST_CLIENT_ID`, `MATTERMOST_CLIENT_SECRET`, `MATTERMOST_BOT_TOKEN` |

The code assumes one Slack workspace holds both the community members and the team's survey channel.

### 3. Announcements

`SLACK_ANNOUNCEMENT_APPROVER_IDS` is the Slack user ID of the announcement owner. Each draft arrives in the team's survey channel with **Approve**, **Edit** (wording and time) and **Skip**. Nothing is posted without an approval.

Automatic posting is optional per channel. A channel without it is handed off: at the scheduled time the app asks in Slack for the approved text to be posted by hand.

| Channel | To post automatically |
|---|---|
| Slack | `SLACK_ANNOUNCE_CHANNEL_ID` (community channel ID); invite the bot to it |
| Discord | Channel settings, Integrations, Webhooks. Store the URL as `DISCORD_ANNOUNCE_WEBHOOK_URL` |
| Mattermost | An incoming webhook (the server admin may need to enable them). Store the URL as `MATTERMOST_ANNOUNCE_WEBHOOK_URL` |
| X | A developer app with write access and OAuth 1.0a user tokens for the Foundation's account: `X_POST_API_KEY`, `X_POST_API_SECRET`, `X_POST_ACCESS_TOKEN`, `X_POST_ACCESS_SECRET` |

Each post carries its own link (`?src=discord-launch`, `?src=x-reminder`, and so on), so responses can be traced to the post that brought them and a flood from one post can be blocked without touching the rest.

### 4. Agents (Claude Managed Agents)

Needs the `ant` CLI signed in to the Foundation's Anthropic organization. All four agents can reach only `YOUR_SURVEY_HOST`: the environment's network is limited to it, and web search and fetch are off.

| Agent | Its credential | Sent only to | What the key allows |
|---|---|---|---|
| survey-watchdog | `WATCHDOG_API_KEY` | `YOUR_SURVEY_HOST` | Read responses, remove responses, apply bounded blocks |
| survey-auditor | `AUDITOR_API_KEY` | `YOUR_SURVEY_HOST` | Read responses, confirm or restore removals |
| survey-reporter | `REPORTER_API_KEY` | `YOUR_SURVEY_HOST` | Read results and responses, post reports |
| survey-announcer | `ANNOUNCER_API_KEY` | `YOUR_SURVEY_HOST` | Read headline counts, draft announcements |

1. Replace `YOUR_SURVEY_HOST` in `agents/survey-watchdog/environment.yaml` and in the four `agent.md` files.
2. Create the agents, the environment and the four vaults. Review the dry run first:
   ```bash
   ant apply --dry-run -v agents/survey-watchdog/environment.yaml agents/survey-{watchdog,auditor,reporter,announcer}/agent.md agents/survey-{watchdog,auditor,reporter,announcer}/vault.yaml
   ```
   ```bash
   ant apply agents/survey-watchdog/environment.yaml agents/survey-{watchdog,auditor,reporter,announcer}/agent.md agents/survey-{watchdog,auditor,reporter,announcer}/vault.yaml
   ```
3. Give each agent its key. Do these three blocks four times, once per agent, in your own terminal. Set the agent name, then paste that agent's key at the silent prompt:
   ```bash
   AGENT=watchdog
   ```
   ```bash
   read -rs CMA_SURVEY_KEY && export CMA_SURVEY_KEY
   ```
   ```bash
   jq -n -f /dev/stdin <<'JQ' | ant beta:vaults:credentials create --vault-id "$(jq -r ".resources[\"./agents/survey-$AGENT/vault.yaml\"].id" claude-lock.json)" && unset CMA_SURVEY_KEY
   {
     display_name: "Survey API",
     auth: {
       type: "environment_variable",
       secret_name: "SURVEY_API_KEY",
       secret_value: (env.CMA_SURVEY_KEY // error("CMA_SURVEY_KEY is not set")),
       networking: {type: "limited", allowed_hosts: ["YOUR_SURVEY_HOST"]},
       injection_location: {header: true, body: false}
     }
   }
   JQ
   ```
   Repeat with `AGENT=auditor`, `AGENT=reporter` and `AGENT=announcer`. The watchdog's vault gets `WATCHDOG_API_KEY`'s value, and so on. Giving an agent another agent's key would give it that agent's powers.
4. In each agent's deployment file, put that agent's own `vlt_...` ID in `vault_ids`. Then create the schedules and **pause them until launch**:
   ```bash
   ant apply agents/survey-watchdog/deployment-hourly.yaml agents/survey-auditor/deployment-twice-daily.yaml agents/survey-reporter/deployment-daily.yaml agents/survey-announcer/deployment-daily.yaml
   ```
   ```bash
   for f in survey-watchdog/deployment-hourly survey-auditor/deployment-twice-daily survey-reporter/deployment-daily survey-announcer/deployment-daily; do ant beta:deployments pause --deployment-id "$(jq -r ".resources[\"./agents/$f.yaml\"].id" claude-lock.json)"; done
   ```
5. Commit `claude-lock.json`.

Schedules (UTC): watchdog every hour at :07, auditor at 05:37 and 17:37, announcer at 12:11, reporter at 13:00. Change the times in the deployment files if you want others.

## Before launch: test the watchdog and auditor on staging

Use a separate staging Worker and database, never production.

```bash
node scripts/make-watchdog-fixtures.mjs
```
```bash
npx wrangler d1 execute foundation-survey-staging --remote --file test/fixtures/watchdog-samples.sql
```

Run the watchdog once against staging (start a session for `survey-watchdog` from the Console with the message in its deployment file), then the auditor the same way, then score the outcome with the reporter's or watchdog's staging key:

```bash
SURVEY_URL=https://YOUR_STAGING_HOST SURVEY_API_KEY=... node scripts/score-watchdog.mjs
```

The bar, after both agents have run: **zero genuine responses removed** (30 of the 50 are genuine, including harsh criticism and profanity), and all spam and abuse caught. If it misses, tune the instructions in the agents' `agent.md` files, re-apply, and re-run.

## Launch checklist

- [x] Questions approved (2026-11-12)
- [ ] Settings confirmed: KPI target, account age (`MIN_ACCOUNT_AGE_DAYS`, default 30), open and close times
- [ ] Each channel signed in end to end on staging
- [ ] Watchdog and auditor scored on staging
- [ ] Pilot with 10 to 25 people to catch confusing wording, then clear the pilot responses
- [ ] The announcement owner knows drafts will arrive in Slack
- [ ] `npm run deploy`, then unpause the four schedules

After that, open `PUBLIC_BASE_URL/results`.

## After the survey

All automatic:

- The final report posts once, after close, when every response has been screened and every removal re-checked.
- `IDENTITY_RETENTION_DAYS` (default 30) after close, the app deletes the account hashes and the network details stored with responses. Answers are kept.
- Pause or archive the four schedules when the final report is in. This is the one manual step left, and skipping it only costs a few idle agent runs.

## Not yet verified

Everything here has been exercised against simulated services only:

- Sign-in with each platform, and the bot DMs for path B.
- Posting to Slack, Discord, Mattermost and X. The X request signing matches X's published example.
- The Cloudflare Access check on `/results`.
- The four agents have never been run, and `ant apply` has not been run on these files.

Sign in once per channel, post one test announcement per channel, and run each agent once on staging before launch.
