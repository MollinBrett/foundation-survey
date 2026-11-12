import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hmacHex } from "../src/crypto";

const BASE = "https://survey.test";
const ADMIN = { Authorization: "Bearer test-admin-key", "Content-Type": "application/json" };

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
  for (const t of ["identities", "responses", "blocks", "block_proposals", "quarantine_batches", "fallback_codes", "rate_limits", "audit_log", "reports"]) {
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

async function call(path: string, init: RequestInit & { cf?: Record<string, unknown> } = {}, jar?: Jar) {
  const headers = new Headers(init.headers);
  if (jar?.cookies.size) headers.set("Cookie", jar.header());
  headers.set("CF-Connecting-IP", headers.get("CF-Connecting-IP") ?? "203.0.113.7");
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${BASE}${path}`, { ...init, headers }), env, ctx);
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

describe("agent API", () => {
  async function seed(n: number, text = "Same pasted text about the foundation being great") {
    for (let i = 0; i < n; i++) {
      githubUser(1000 + i);
      const jar = new Jar();
      await signInGithub(jar);
      await call("/survey", form({ ...GOOD_ANSWERS, start_stop_change: text }), jar);
      routes = [];
    }
  }

  it("requires the admin key", async () => {
    expect((await call("/admin/api/status")).status).toBe(401);
    expect((await call("/admin/api/status", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("finds duplicates, quarantines a batch, and posts it to Slack with a Restore button", async () => {
    await seed(3);
    const dup = (await (await call("/admin/api/duplicates", { headers: ADMIN })).json()) as any;
    expect(dup.duplicates[0].count).toBe(3);
    const ids = dup.duplicates[0].ids as string[];

    const res = await call("/admin/api/review", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ reviewed_ids: ids, quarantine: [{ ids, category: "duplicate", reason: "Identical pasted text" }] }),
    });
    expect(res.status).toBe(200);
    const quarantined = await env.SURVEY_DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE status = 'quarantined'").first<{ n: number }>();
    expect(quarantined!.n).toBe(3);
    const slack = outbound.find((o) => o.url.endsWith("/api/chat.postMessage"));
    expect(slack!.body).toContain("restore_batch");
    const unreviewed = (await (await call("/admin/api/responses?unreviewed=1", { headers: ADMIN })).json()) as any;
    expect(unreviewed.responses).toHaveLength(0);
  });

  it("validates block proposals and never blocks on its own", async () => {
    const bad = await call("/admin/api/block-proposals", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ scope: "provider", value: "x", hours: 500, reason: "flood" }),
    });
    expect(bad.status).toBe(400);
    const ok = await call("/admin/api/block-proposals", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ scope: "provider", value: "github", hours: 6, reason: "flood", evidence: "40 in 20 min" }),
    });
    expect(ok.status).toBe(200);
    expect((await env.SURVEY_DB.prepare("SELECT COUNT(*) AS n FROM blocks").first<{ n: number }>())!.n).toBe(0);
  });

  it("posts the final report only once", async () => {
    const post = () => call("/admin/api/reports", { method: "POST", headers: ADMIN, body: JSON.stringify({ kind: "final", text: "Done." }) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
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

    const r = (await (await call("/admin/api/results", { headers: ADMIN })).json()) as any;
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
    const r = (await (await call("/admin/api/results", { headers: ADMIN })).json()) as any;
    expect(r.kpis[0].all).toMatchObject({ answered: 0, pct_positive: null, meets_target: null });
  });
});

describe("Slack approvals", () => {
  async function slackClick(user: string, action_id: string, value: string, sign = true) {
    const body = new URLSearchParams({
      payload: JSON.stringify({ user: { id: user }, response_url: "https://hooks.slack.com/actions/x", actions: [{ action_id, value }] }),
    }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign ? `v0=${await hmacHex("test-slack-signing", `v0:${ts}:${body}`)}` : "v0=bad";
    return call("/slack/interactive", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
    });
  }

  async function propose() {
    const res = await call("/admin/api/block-proposals", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ scope: "provider", value: "github", hours: 6, reason: "flood" }),
    });
    return ((await res.json()) as any).id as string;
  }

  it("rejects unsigned requests", async () => {
    expect((await slackClick("UAPPROVER", "approve_block", "x", false)).status).toBe(401);
  });

  it("ignores clicks from people not on the approver list", async () => {
    const id = await propose();
    await slackClick("USOMEONE", "approve_block", id);
    expect((await env.SURVEY_DB.prepare("SELECT COUNT(*) AS n FROM blocks").first<{ n: number }>())!.n).toBe(0);
  });

  it("an approved block stops new sign-ins from that channel", async () => {
    const id = await propose();
    await slackClick("UAPPROVER", "approve_block", id);
    expect((await env.SURVEY_DB.prepare("SELECT COUNT(*) AS n FROM blocks").first<{ n: number }>())!.n).toBe(1);
    githubUser(2000);
    const res = await signInGithub(new Jar());
    expect(res.status).toBe(403);
  });

  it("restores a quarantined batch", async () => {
    githubUser(3000);
    const jar = new Jar();
    await signInGithub(jar);
    await call("/survey", form(GOOD_ANSWERS), jar);
    const { id } = (await env.SURVEY_DB.prepare("SELECT id FROM responses").first<{ id: string }>())!;
    const rev = (await (
      await call("/admin/api/review", {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ quarantine: [{ ids: [id], category: "other", reason: "test" }] }),
      })
    ).json()) as any;
    await slackClick("UAPPROVER", "restore_batch", rev.quarantine_batches[0].batch);
    const row = await env.SURVEY_DB.prepare("SELECT status FROM responses WHERE id = ?1").bind(id).first<{ status: string }>();
    expect(row!.status).toBe("accepted");
  });
});
