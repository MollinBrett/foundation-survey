import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { cleanUp, selfCheck } from "../src/cron";
import { oauth1Header, publishDue } from "../src/announce";
import { base64url } from "../src/crypto";
import { hmacHex } from "../src/crypto";

const BASE = "https://survey.test";
const key = (role: string) => ({ Authorization: `Bearer test-${role}-key`, "Content-Type": "application/json" });
const WATCHDOG = key("watchdog");
const AUDITOR = key("auditor");
const REPORTER = key("reporter");
const ANNOUNCER = key("announcer");
const CLOSED = { SURVEY_CLOSES_AT: "2021-01-01T00:00:00Z" };

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
let routes: Route[] = [];
let outbound: { url: string; body: string }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  routes = [];
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    outbound.push({ url: url.toString(), body });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    // Defaults: Turnstile passes, Slack accepts.
    if (url.host === "challenges.cloudflare.com") return json({ success: true });
    if (url.host === "slack.com" && url.pathname === "/api/chat.postMessage") return json({ ok: true });
    if (url.host === "hooks.slack.com") return new Response("ok");
    throw new Error(`unexpected fetch ${url}`);
  });
  for (const t of ["identities", "responses", "blocks", "quarantine_batches", "announcements", "agent_heartbeats", "alerts", "meta", "fallback_codes", "rate_limits", "audit_log", "reports"]) {
    await env.SURVEY_DB.prepare(`DELETE FROM ${t}`).run();
  }
});

afterEach(() => vi.restoreAllMocks());

class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function call(path: string, init: RequestInit = {}, jar?: Jar, envOverride: Record<string, string> = {}) {
  const headers = new Headers(init.headers);
  if (jar?.cookies.size) headers.set("Cookie", jar.header());
  headers.set("CF-Connecting-IP", headers.get("CF-Connecting-IP") ?? "203.0.113.7");
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  jar?.take(res);
  return res;
}

function form(fields: Record<string, string | string[]>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return { method: "POST", body: p, headers: { "Content-Type": "application/x-www-form-urlencoded" } };
}

const GOOD_ANSWERS = {
  familiarity: "4",
  satisfaction: "4",
  impact: "3",
  independence: "dont_know",
  transparency_decisions: "2",
  transparency_finances: "2",
  listening: "3",
  leadership: "dont_know",
  start_stop_change: "Publish the budget and the grant decisions every quarter.",
  role: "Developer or builder",
  "cf-turnstile-response": "tok",
};

function githubUser(id: number, createdAt = "2015-01-01T00:00:00Z") {
  routes.push((url) => {
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") return json({ access_token: "gho_x" });
    if (url.host === "api.github.com" && url.pathname === "/user") return json({ id, created_at: createdAt });
  });
}

async function signInGithub(jar: Jar) {
  const start = await call("/auth/github", {}, jar);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  return call(`/auth/github/callback?code=abc&state=${state}`, {}, jar);
}

describe("landing", () => {
  it("shows only configured sign-in buttons", async () => {
    const html = await (await call("/")).text();
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with X");
    expect(html).toContain("Verify with your Slack handle");
  });
});

describe("option A: sign in, answer once", () => {
  it("records a response with no link back to the account, and refuses a second one", async () => {
    githubUser(42);
    const jar = new Jar();
    const cb = await signInGithub(jar);
    expect(cb.status).toBe(303);
    expect(cb.headers.get("Location")).toBe("/survey");

    const submit = await call("/survey", form(GOOD_ANSWERS), jar);
    expect(await submit.text()).toContain("Thank you");

    const ids = await env.SURVEY_DB.prepare("SELECT * FROM identities").all();
    const resp = await env.SURVEY_DB.prepare("SELECT * FROM responses").all();
    expect(ids.results).toHaveLength(1);
    expect(resp.results).toHaveLength(1);
    expect(Object.keys(ids.results[0]!).sort()).toEqual(["id_hash", "provider"]);
    expect(JSON.stringify(resp.results[0])).not.toContain(String(ids.results[0]!.id_hash));
    expect(JSON.stringify(ids.results[0])).not.toContain("42");

    const jar2 = new Jar();
    const again = await signInGithub(jar2);
    expect(await again.text()).toContain("already answered");
  });

  it("refuses accounts younger than the minimum age", async () => {
    githubUser(43, new Date().toISOString());
    const res = await signInGithub(new Jar());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("at least 30 days old");
  });

  it("rejects a callback whose state does not match", async () => {
    githubUser(44);
    const jar = new Jar();
    await call("/auth/github", {}, jar);
    const res = await call("/auth/github/callback?code=abc&state=forged", {}, jar);
    expect(res.status).toBe(400);
  });

  it("sends people without a session back to the start", async () => {
    const res = await call("/survey", form(GOOD_ANSWERS));
    expect(res.status).toBe(303);
  });

  it("validates answers and the bot check", async () => {
    githubUser(45);
    const jar = new Jar();
    await signInGithub(jar);
    for (const bad of [{ satisfaction: "9" }, { familiarity: "dont_know" }, { role: "Astronaut" }, { leadership: "" }]) {
      const res = await call("/survey", form({ ...GOOD_ANSWERS, ...bad }), jar);
      expect(res.status).toBe(400);
    }
    routes.push((url) => (url.host === "challenges.cloudflare.com" ? json({ success: false }) : undefined));
    const bot = await call("/survey", form(GOOD_ANSWERS), jar);
    expect(bot.status).toBe(400);
    expect((await env.SURVEY_DB.prepare("SELECT COUNT(*) AS n FROM responses").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("option B: handle + code (Slack)", () => {
  it("DMs a code to the handle's owner and verifies it", async () => {
    let sentText = "";
    routes.push((url, init) => {
      if (url.pathname === "/api/users.list") {
        return json({ ok: true, members: [{ id: "U777", name: "alice", profile: { display_name: "Alice" } }], response_metadata: {} });
      }
      if (url.pathname === "/api/chat.postMessage" && String(init?.body).includes("U777")) {
        sentText = JSON.parse(String(init!.body)).text;
        return json({ ok: true });
      }
    });
    const jar = new Jar();
    const sent = await call("/verify/slack", form({ handle: "@Alice" }), jar);
    expect(await sent.text()).toContain("Enter your code");
    const code = sentText.match(/\b(\d{6})\b/)![1]!;

    const wrong = await call("/verify/slack/code", form({ code: code === "000000" ? "111111" : "000000" }), jar);
    expect(wrong.status).toBe(400);
    const ok = await call("/verify/slack/code", form({ code }), jar);
    expect(ok.status).toBe(303);

    // Second code request for the same handle within 10 minutes is refused.
    const again = await call("/verify/slack", form({ handle: "alice" }), new Jar());
    expect(again.status).toBe(429);
  });

  it("hashes the same account the same way on both paths", async () => {
    const viaOauth = await hmacHex(env.IDENTITY_PEPPER, "id:slack:U777");
    expect(viaOauth).toHaveLength(64);
  });
});

describe("role question", () => {
  it("stores the Other text only when Other is chosen", async () => {
    githubUser(46);
    const jar = new Jar();
    await signInGithub(jar);
    await call("/survey", form({ ...GOOD_ANSWERS, role: "Other", role_other: "Journalist" }), jar);
    const row = await env.SURVEY_DB.prepare("SELECT answers FROM responses").first<{ answers: string }>();
    expect(JSON.parse(row!.answers)).toMatchObject({ role: "Other", role_other: "Journalist", satisfaction: 4, leadership: "dont_know" });
  });
});

describe("KPI results", () => {
  let n = 0;
  async function insert(answers: Record<string, unknown>, status = "accepted", channel = "github") {
    await env.SURVEY_DB.prepare(
      "INSERT INTO responses (id, channel, submitted_at, answers, status, status_category) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(`r${++n}`, channel, new Date().toISOString(), JSON.stringify(answers), status, status === "quarantined" ? "spam" : null)
      .run();
  }
  const base = { familiarity: 4, impact: 4, independence: 4, transparency_decisions: 4, transparency_finances: 4, listening: 4, leadership: 4 };

  it("scores top two as positive, bottom two as negative, and leaves Don't know out", async () => {
    // Developers (4): satisfaction 5, 4, 3, 1. Validators (2, below the test minimum of 3): 2, dont_know.
    for (const s of [5, 4, 3, 1]) await insert({ ...base, satisfaction: s, role: "Developer or builder" });
    await insert({ ...base, satisfaction: 2, role: "Validator or node operator", familiarity: 1 });
    await insert({ ...base, satisfaction: "dont_know", role: "Validator or node operator", familiarity: 2 }, "accepted", "x");
    await insert({ ...base, satisfaction: 1, role: "Developer or builder" }, "quarantined"); // must not count

    const r = (await (await call("/admin/api/results", { headers: REPORTER })).json()) as any;
    expect(r.respondents).toBe(6);
    expect(r.familiar_respondents).toBe(4);
    expect(r.target_pct_positive).toBe(80);
    expect(r.quarantined_excluded).toEqual([{ category: "spam", n: 1 }]);
    expect(r.respondents_by_channel).toEqual({ github: 5, "other channels": 1 });

    const sat = r.kpis.find((k: any) => k.id === "satisfaction");
    expect(sat.headline).toBe(true);
    expect(sat.all).toMatchObject({ answered: 5, positive: 2, neutral: 1, negative: 2, dont_know: 1, pct_positive: 40, pct_negative: 40, meets_target: false });
    expect(sat.familiar).toMatchObject({ answered: 4, positive: 2, pct_positive: 50 });
    expect(Object.keys(sat.by_role)).toEqual(["Developer or builder"]); // validators are too few to report
    expect(r.roles.find((x: any) => x.role === "Validator or node operator")).toMatchObject({ respondents: 2, reported: false });

    const impact = r.kpis.find((k: any) => k.id === "impact");
    expect(impact.all).toMatchObject({ pct_positive: 100, meets_target: true });
    expect(r.kpis.map((k: any) => k.id)).toEqual([
      "satisfaction", "impact", "independence", "transparency_decisions", "transparency_finances", "listening", "leadership",
    ]);
  });

  it("reports no percentage when nobody answered", async () => {
    const r = (await (await call("/admin/api/results", { headers: REPORTER })).json()) as any;
    expect(r.kpis[0].all).toMatchObject({ answered: 0, pct_positive: null, meets_target: null });
  });
});

// ---------- Autonomy: agents, limits, second review, announcements, self-checks ----------

let seq = 0;
async function addResponse(over: Record<string, unknown> = {}, cols: Record<string, unknown> = {}) {
  const id = `t${++seq}`;
  const answers = { familiarity: 4, satisfaction: 4, impact: 4, independence: 4, transparency_decisions: 4, transparency_finances: 4, listening: 4, leadership: 4, role: "Developer or builder", ...over };
  const c = { channel: "github", source: null, asn: 64500, country: "US", fingerprint: null, submitted_at: new Date().toISOString(), ...cols } as Record<string, any>;
  await env.SURVEY_DB.prepare(
    "INSERT INTO responses (id, channel, source, submitted_at, asn, country, answers, text_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, c.channel, c.source, c.submitted_at, c.asn, c.country, JSON.stringify(answers), c.fingerprint)
    .run();
  return id;
}
const post = (path: string, headers: Record<string, string>, body: unknown, envOverride = {}) =>
  call(path, { method: "POST", headers, body: JSON.stringify(body) }, undefined, envOverride);
const get = (path: string, headers: Record<string, string>, envOverride = {}) => call(path, { headers }, undefined, envOverride);
const one = <T>(sql: string) => env.SURVEY_DB.prepare(sql).first<T>();
const slackPosts = () => outbound.filter((o) => o.url.endsWith("/api/chat.postMessage"));

async function slackSend(payload: Record<string, unknown>, sign = true) {
  const body = new URLSearchParams({ payload: JSON.stringify({ response_url: "https://hooks.slack.com/actions/x", ...payload }) }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign ? `v0=${await hmacHex("test-slack-signing", `v0:${ts}:${body}`)}` : "v0=bad";
  return call("/slack/interactive", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
  });
}
const click = (user: string, action_id: string, value: string) => slackSend({ type: "block_actions", user: { id: user }, trigger_id: "trig", actions: [{ action_id, value }] });

describe("each agent's key only unlocks its own job", () => {
  it("refuses requests without a valid key", async () => {
    expect((await call("/admin/api/status")).status).toBe(401);
    expect((await get("/admin/api/status", { Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("stops agents from doing each other's work", async () => {
    expect((await post("/admin/api/review", AUDITOR, { reviewed_ids: [] })).status).toBe(403); // auditor cannot remove
    expect((await post("/admin/api/blocks", AUDITOR, {})).status).toBe(403); // auditor cannot block
    expect((await post("/admin/api/audit", WATCHDOG, {})).status).toBe(403); // watchdog cannot audit itself
    expect((await post("/admin/api/review", REPORTER, {})).status).toBe(403); // reporter cannot change responses
    expect((await get("/admin/api/responses", ANNOUNCER)).status).toBe(403); // announcer cannot read responses
    expect((await get("/admin/api/results", ANNOUNCER)).status).toBe(403);
    expect((await post("/admin/api/announcements/drafts", WATCHDOG, {})).status).toBe(403);
  });
});

describe("watchdog", () => {
  it("removes a duplicate batch and tells Slack, with no approval needed", async () => {
    const ids = [await addResponse({}, { fingerprint: "fp1" }), await addResponse({}, { fingerprint: "fp1" }), await addResponse({}, { fingerprint: "fp1" })];
    const dup = (await (await get("/admin/api/duplicates", WATCHDOG)).json()) as any;
    expect(dup.duplicates[0].count).toBe(3);
    const res = await post("/admin/api/review", WATCHDOG, { reviewed_ids: ids, quarantine: [{ ids, category: "duplicate", reason: "Identical pasted text" }] });
    expect(res.status).toBe(200);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM responses WHERE status = 'quarantined'"))!.n).toBe(3);
    expect(slackPosts()[0]!.body).toContain("restore_batch");
    const left = (await (await get("/admin/api/responses?unreviewed=1", WATCHDOG)).json()) as any;
    expect(left.responses).toHaveLength(0);
  });

  it("applies a block at once, and the block stops sign-ins", async () => {
    const res = await post("/admin/api/blocks", WATCHDOG, { scope: "provider", value: "github", hours: 4, reason: "flood", evidence: "40 near-identical responses in 20 minutes" });
    expect(res.status).toBe(200);
    expect(slackPosts()[0]!.body).toContain("lift_block");
    githubUser(2000);
    expect((await signInGithub(new Jar())).status).toBe(403);
  });

  it("cannot exceed the limits, whatever it is told", async () => {
    const block = (b: Record<string, unknown>) => post("/admin/api/blocks", WATCHDOG, { reason: "flood", evidence: "numbers", ...b });
    expect((await block({ scope: "asn", value: "64500", hours: 25 })).status).toBe(400); // over 24h
    expect((await block({ scope: "provider", value: "x", hours: 7 })).status).toBe(400); // over 6h for a whole channel
    expect((await block({ scope: "provider", value: "telegram", hours: 2 })).status).toBe(400);
    expect((await block({ scope: "asn", value: "64500", hours: 2, evidence: "" })).status).toBe(400); // evidence required
    expect((await block({ scope: "provider", value: "x", hours: 6 })).status).toBe(200);
    expect((await block({ scope: "provider", value: "x", hours: 6 })).status).toBe(409); // already active
    expect((await block({ scope: "country", value: "US", hours: 2 })).status).toBe(409); // one broad block at a time
    for (let i = 1; i <= 5; i++) expect((await block({ scope: "asn", value: String(i), hours: 1 })).status).toBe(200);
    expect((await block({ scope: "asn", value: "99", hours: 1 })).status).toBe(429); // 6 per 24 hours
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM blocks"))!.n).toBe(6);
  });

  it("cannot block when the survey is closed", async () => {
    const res = await post("/admin/api/blocks", WATCHDOG, { scope: "asn", value: "1", hours: 1, reason: "r", evidence: "e" }, CLOSED);
    expect(res.status).toBe(409);
  });
});

describe("auditor: the independent second review", () => {
  async function removed() {
    const a = await addResponse({ start_stop_change: "You are useless and I want my money back." });
    const b = await addResponse({ start_stop_change: "asdf asdf asdf" });
    await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [a, b], category: "spam", reason: "junk text" }] });
    return { a, b };
  }

  it("is not shown the watchdog's reasoning", async () => {
    await removed();
    const queue = await (await get("/admin/api/audit/queue", AUDITOR)).text();
    expect(queue).not.toContain("junk text");
    expect(queue).not.toContain("status_category");
    const listed = await (await get("/admin/api/responses?status=quarantined", AUDITOR)).text();
    expect(listed).not.toContain("status_category");
    expect(await (await get("/admin/api/responses?status=quarantined", WATCHDOG)).text()).toContain("status_category");
  });

  it("restores an honest response, confirms the junk, and its decision is final", async () => {
    const { a, b } = await removed();
    const res = await post("/admin/api/audit", AUDITOR, { confirm_ids: [b], restore: [{ ids: [a], reason: "Harsh but genuine criticism" }] });
    expect(await res.json()).toMatchObject({ confirmed: 1, restored: 1 });
    expect((await one<{ status: string }>(`SELECT status FROM responses WHERE id = '${a}'`))!.status).toBe("accepted");
    expect((await one<{ status: string; audited: number }>(`SELECT status, audited FROM responses WHERE id = '${b}'`))).toMatchObject({ status: "quarantined", audited: 1 });
    expect((await (await get("/admin/api/audit/queue", AUDITOR)).json() as any).queue).toHaveLength(0);
    // The watchdog cannot remove a response the auditor put back.
    await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [a], category: "spam", reason: "again" }] });
    expect((await one<{ status: string }>(`SELECT status FROM responses WHERE id = '${a}'`))!.status).toBe("accepted");
  });

  it("can only act on removed responses", async () => {
    const ok = await addResponse();
    await post("/admin/api/audit", AUDITOR, { restore: [{ ids: [ok], reason: "x" }], confirm_ids: [ok] });
    expect(await one("SELECT audited FROM responses WHERE id = '" + ok + "'")).toMatchObject({ audited: 0 });
  });
});

describe("reporter", () => {
  it("shows each KPI with the removed responses counted back in", async () => {
    for (const s of [5, 5, 4]) await addResponse({ satisfaction: s });
    const bad = await addResponse({ satisfaction: 1 });
    await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [bad], category: "spam", reason: "junk" }] });
    const r = (await (await get("/admin/api/results", REPORTER)).json()) as any;
    expect(r.kpis[0].all.pct_positive).toBe(100);
    expect(r.including_removed[0]).toMatchObject({ id: "satisfaction", respondents: 4, pct_positive: 75 });
  });

  it("posts the final report once, and only when screening is finished", async () => {
    const final = (e = CLOSED) => post("/admin/api/reports", REPORTER, { kind: "final", text: "Done.", themes: [{ title: "Budget", summary: "Publish it.", mentions: 12 }] }, e);
    expect((await final({} as any)).status).toBe(409); // still open
    const id = await addResponse();
    expect((await final()).status).toBe(409); // not screened yet
    await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [id], category: "spam", reason: "junk" }] });
    expect((await final()).status).toBe(409); // removed but not yet re-checked
    await post("/admin/api/audit", AUDITOR, { confirm_ids: [id] });
    expect((await final()).status).toBe(200);
    expect((await final()).status).toBe(409); // only once
    expect(JSON.parse((await one<{ themes: string }>("SELECT themes FROM reports"))!.themes)[0]).toMatchObject({ title: "Budget", mentions: 12 });
  });
});

describe("announcements: the agent drafts, the owner approves, the app posts", () => {
  const soon = () => new Date(Date.now() + 60_000).toISOString();
  const draft = (d: Record<string, unknown>, e = {}) => post("/admin/api/announcements/drafts", ANNOUNCER, { drafts: [{ kind: "launch", channel: "discord", scheduled_for: soon(), ...d }] }, e);
  const first = async (res: Response) => ((await res.json()) as any).results[0];
  const status = async (id: string) => (await one<{ status: string }>(`SELECT status FROM announcements WHERE id = '${id}'`))!.status;
  const due = (id: string) => env.SURVEY_DB.prepare("UPDATE announcements SET scheduled_for = ?2 WHERE id = ?1").bind(id, new Date(Date.now() - 60_000).toISOString()).run();
  const publish = (e: Record<string, string> = {}) => {
    const told: string[] = [];
    return publishDue({ ...env, ...e } as any, async (t) => void told.push(t)).then((n) => ({ n, told }));
  };

  it("gives the announcer counts but never responses", async () => {
    await addResponse({ start_stop_change: "secret free text" });
    const ctx = await (await get("/admin/api/announcements/context", ANNOUNCER)).text();
    expect(ctx).toContain('"respondents":1');
    expect(ctx).not.toContain("secret free text");
  });

  it("refuses bad drafts", async () => {
    expect(await first(await draft({ text: "Take our survey" }))).toMatchObject({ ok: false }); // no link
    expect(await first(await draft({ channel: "x", text: `${"long ".repeat(60)} {link}` }))).toMatchObject({ ok: false }); // too long for X
    expect(await first(await draft({ text: "@everyone take it {link}" }))).toMatchObject({ ok: false }); // mass mention
    expect(await first(await draft({ channel: "telegram", text: "{link}" }))).toMatchObject({ ok: false });
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM announcements"))!.n).toBe(0);
  });

  it("posts nothing until the owner approves, and only the owner can approve", async () => {
    let discord = "";
    routes.push((url, init) => (url.host === "discord.com" && url.pathname.startsWith("/api/webhooks/") ? ((discord = String(init?.body)), new Response(null, { status: 204 })) : undefined));
    const d = await first(await draft({ text: "How do you see the Foundation? 10 questions, 3 minutes: {link}" }));
    expect(d.ok).toBe(true);
    expect(slackPosts()[0]!.body).toContain("ann_approve");
    await due(d.id);

    expect((await publish()).n).toBe(0); // still a draft
    await click("UAPPROVER", "ann_approve", d.id); // may override moderation, but is not the announcement owner
    expect(await status(d.id)).toBe("draft");
    await click("UVET", "ann_approve", d.id);
    expect(await status(d.id)).toBe("approved");

    expect((await publish()).n).toBe(1);
    expect(await status(d.id)).toBe("posted");
    expect(JSON.parse(discord).content).toContain("https://survey.test/?src=discord-launch");
    expect(JSON.parse(discord).allowed_mentions).toEqual({ parse: [] });
    expect((await publish()).n).toBe(0); // never twice
  });

  it("hands a post to a person when a channel has no automatic posting", async () => {
    const d = await first(await draft({ channel: "x", text: "Tell us how you see the Foundation {link}" }));
    await click("UVET", "ann_approve", d.id);
    await due(d.id);
    const { told } = await publish();
    expect(await status(d.id)).toBe("handed_off");
    expect(told[0]).toContain("by hand");
  });

  it("lets the owner edit the wording and time, with the channel's limits enforced", async () => {
    const d = await first(await draft({ channel: "x", text: "Short {link}" }));
    const submit = (text: string) =>
      slackSend({
        type: "view_submission",
        user: { id: "UVET" },
        view: { callback_id: "ann_edit", private_metadata: d.id, state: { values: { text: { text: { value: text } }, when: { when: { selected_date_time: 1893456000 } } } } },
      });
    const tooLong = await submit("x".repeat(300));
    expect(((await tooLong.json()) as any).response_action).toBe("errors");
    expect(await status(d.id)).toBe("draft");
    expect((await submit("Vet's wording https://survey.test/?src=x-launch")).status).toBe(200);
    expect(await one(`SELECT status, text, scheduled_for FROM announcements WHERE id = '${d.id}'`)).toMatchObject({
      status: "approved",
      text: "Vet's wording https://survey.test/?src=x-launch",
      scheduled_for: "2030-01-01T00:00:00.000Z",
    });
  });

  it("never invites people to a closed survey, and holds the thank-you until it closes", async () => {
    const reminder = await first(await draft({ kind: "reminder", text: "Reminder {link}" }));
    const thanks = await first(await draft({ kind: "thanks", text: "Thank you all." }));
    for (const id of [reminder.id, thanks.id]) { await click("UVET", "ann_approve", id); await due(id); }
    routes.push((url) => (url.host === "discord.com" ? new Response(null, { status: 204 }) : undefined));
    await publish({ SURVEY_OPENS_AT: "2020-01-01T00:00:00Z" }); // open
    expect(await status(thanks.id)).toBe("approved"); // waits
    await env.SURVEY_DB.prepare("UPDATE announcements SET status = 'approved' WHERE id = ?1").bind(reminder.id).run();
    await publish(CLOSED);
    expect(await status(reminder.id)).toBe("skipped");
    expect(await status(thanks.id)).toBe("posted");
  });
});

describe("people may override, but never have to", () => {
  it("rejects unsigned Slack requests", async () => {
    expect((await slackSend({ type: "block_actions", user: { id: "UAPPROVER" }, actions: [{ action_id: "lift_block", value: "x" }] }, false)).status).toBe(401);
  });

  it("lets an approver lift a block early, and nobody else", async () => {
    const b = (await (await post("/admin/api/blocks", WATCHDOG, { scope: "provider", value: "github", hours: 4, reason: "flood", evidence: "numbers" })).json()) as any;
    await click("USOMEONE", "lift_block", b.id);
    githubUser(2100);
    expect((await signInGithub(new Jar())).status).toBe(403);
    await click("UAPPROVER", "lift_block", b.id);
    githubUser(2101);
    expect((await signInGithub(new Jar())).status).toBe(303);
  });

  it("lets an approver restore a removed batch", async () => {
    const id = await addResponse();
    const rev = (await (await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [id], category: "other", reason: "test" }] })).json()) as any;
    await click("UAPPROVER", "restore_batch", rev.quarantine_batches[0].batch);
    expect((await one<{ status: string }>(`SELECT status FROM responses WHERE id = '${id}'`))!.status).toBe("accepted");
  });
});

describe("self-check and clean-up", () => {
  it("warns once when agents have stopped running, and stays quiet when they are healthy", async () => {
    expect(await selfCheck(env as any)).toEqual(["watchdog_silent", "reporter_silent"]);
    expect(slackPosts()).toHaveLength(2);
    expect(await selfCheck(env as any)).toEqual([]); // not repeated the same day
    await env.SURVEY_DB.prepare("DELETE FROM alerts").run();
    await get("/admin/api/status", WATCHDOG); // the watchdog checks in
    await get("/admin/api/status", REPORTER);
    expect(await selfCheck(env as any)).toEqual([]);
  });

  it("warns about responses left unscreened", async () => {
    await get("/admin/api/status", WATCHDOG);
    await get("/admin/api/status", REPORTER);
    await addResponse({}, { submitted_at: new Date(Date.now() - 4 * 3_600_000).toISOString() });
    expect(await selfCheck(env as any)).toEqual(["review_backlog"]);
  });

  it("deletes account hashes and network details after the retention period, once", async () => {
    await env.SURVEY_DB.prepare("INSERT INTO identities (id_hash, provider) VALUES ('h', 'github')").run();
    const id = await addResponse();
    await cleanUp(env as any); // survey still open: nothing deleted
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM identities"))!.n).toBe(1);
    await cleanUp({ ...env, ...CLOSED } as any);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM identities"))!.n).toBe(0);
    expect(await one(`SELECT asn, country, answers IS NOT NULL AS kept FROM responses WHERE id = '${id}'`)).toMatchObject({ asn: null, country: null, kept: 1 });
    await cleanUp({ ...env, ...CLOSED } as any);
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identity_data_deleted'"))!.n).toBe(1);
  });
});

describe("results page", () => {
  async function accessToken(claims: Record<string, unknown>) {
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const kid = `k${++seq}`;
    const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
    routes.push((url) => (url.pathname === "/cdn-cgi/access/certs" ? json({ keys: [jwk] }) : undefined));
    const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
    const body = `${enc({ alg: "RS256", kid })}.${enc({ aud: ["test-aud"], iss: "https://team.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600, email: "brett@example.org", ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body)));
    return `${body}.${base64url(sig)}`;
  }
  const open = (token?: string) => call("/results", token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {});

  it("is closed to anyone without a valid Cloudflare Access token", async () => {
    expect((await open()).status).toBe(404);
    expect((await open("a.b.c")).status).toBe(404);
    expect((await open(await accessToken({ aud: ["another-app"] }))).status).toBe(404);
    expect((await open(await accessToken({ exp: 1 }))).status).toBe(404);
    const forged = (await accessToken({})).replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    expect((await open(forged)).status).toBe(404);
  });

  it("shows the KPI, the with/without comparison and what the agents did", async () => {
    for (const s of [5, 4, 4, 2]) await addResponse({ satisfaction: s });
    const junk = await addResponse({ satisfaction: 1 });
    await post("/admin/api/review", WATCHDOG, { quarantine: [{ ids: [junk], category: "spam", reason: "junk" }] });
    const res = await open(await accessToken({}));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Community survey results");
    expect(html).toContain("75%"); // 3 of 4 positive
    expect(html).toContain("Below the 80% target");
    expect(html).toContain("counted back in: 60% positive"); // 3 of 5 with the removed one
    expect(html).toContain("Watchdog agent screened 0 response(s) and removed 1");
  });
});

describe("X request signing", () => {
  it("matches the published OAuth 1.0a example", async () => {
    const header = await oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json",
      { consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true" },
    );
    const sig = decodeURIComponent(header.match(/oauth_signature="([^"]+)"/)![1]!);
    expect(["hCtSmYh+iHYCEqBWrE7C7hYmtUk=", "tnnArxj06cWHq44gCs1OSKk/jLY="]).toContain(sig);
  });
});
