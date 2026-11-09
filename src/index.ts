import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { type Env, type Provider, PROVIDERS, PROVIDER_LABELS, intVar, isConfigured } from "./env";
import { identityHash, ipHash, pkceChallenge, randomCode, randomToken, sha256Hex, hmacHex, signValue, verifyValue, timingSafeEqual } from "./crypto";
import { activeBlock, audit, nowIso, rateLimit, surveyWindow } from "./db";
import { PROVIDER_CONFIG, authorizeUrl, exchangeCode, oauthEnabled } from "./providers";
import { fallbackEnabled, lookupHandle, normalizeHandle, sendCode, type FallbackProvider } from "./fallback";
import { freeText, parseAnswers } from "./survey";
import { codeForm, handleForm, landingPage, messagePage, surveyPage } from "./views";
import { admin } from "./admin";
import { handleInteractive, verifySlackRequest } from "./slack";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const COOKIE = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };
const SESSION_TTL = 60 * 60; // 1 hour to fill in the survey after verifying
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

interface Session {
  idHash: string;
  provider: Provider;
}

function isProvider(p: string): p is Provider {
  return (PROVIDERS as string[]).includes(p);
}

function clientIp(c: C): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

function cfInfo(c: C): { asn: number | null; country: string | null } {
  const cf = (c.req.raw as unknown as { cf?: { asn?: number; country?: string } }).cf;
  return { asn: typeof cf?.asn === "number" ? cf.asn : null, country: cf?.country ?? null };
}

function enabledProviders(env: Env) {
  return {
    oauth: PROVIDERS.filter((p) => oauthEnabled(env, p)),
    fallback: PROVIDERS.filter((p) => fallbackEnabled(env, p)),
  };
}

function landing(c: C, error?: string, status: 200 | 400 | 403 | 429 = 200) {
  return c.html(landingPage({ ...enabledProviders(c.env), error, window: surveyWindow(c.env), opensAt: c.env.SURVEY_OPENS_AT }), status);
}

async function signinAllowed(c: C): Promise<boolean> {
  const key = `signin:${await ipHash(c.env.IDENTITY_PEPPER, clientIp(c))}`;
  return rateLimit(c.env, key, intVar(c.env.RATE_LIMIT_SIGNIN_PER_HOUR, 30));
}

/** Common end of both verification paths. */
async function finishVerification(c: C, provider: Provider, providerUserId: string) {
  const { asn, country } = cfInfo(c);
  const source = getCookie(c, "src") ?? null;
  const blocked = await activeBlock(c.env, { provider, asn, country, source });
  if (blocked) return c.html(messagePage("Temporarily unavailable", "Sign-ins from here are paused for now. Please try again later."), 403);

  const idHash = await identityHash(c.env.IDENTITY_PEPPER, provider, providerUserId);
  const done = await c.env.SURVEY_DB.prepare("SELECT 1 FROM identities WHERE id_hash = ?1").bind(idHash).first();
  if (done) return c.html(messagePage("Already responded", "Thank you, this account has already answered the survey."));

  setCookie(c, "session", await signValue(c.env.SESSION_SECRET, { idHash, provider } satisfies Session, SESSION_TTL), {
    ...COOKIE,
    maxAge: SESSION_TTL,
  });
  return c.redirect("/survey", 303);
}

app.get("/", (c) => {
  const src = c.req.query("src");
  if (src && /^[a-z0-9_-]{1,32}$/.test(src)) setCookie(c, "src", src, { ...COOKIE, maxAge: 7 * 86_400 });
  return landing(c);
});

app.get("/healthz", (c) => c.json({ ok: true }));

// ---------- Option A: sign in with the channel ----------

app.get("/auth/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider) || !oauthEnabled(c.env, provider)) return c.notFound();
  if (surveyWindow(c.env) !== "open") return landing(c);
  if (!(await signinAllowed(c))) return landing(c, "Too many attempts from your network. Please try again in an hour.", 429);

  const state = randomToken();
  const verifier = PROVIDER_CONFIG[provider].pkce ? randomToken(48) : undefined;
  setCookie(c, "oauth", await signValue(c.env.SESSION_SECRET, { state, verifier, provider }, 600), { ...COOKIE, maxAge: 600 });
  return c.redirect(authorizeUrl(c.env, provider, state, verifier ? await pkceChallenge(verifier) : undefined), 302);
});

app.get("/auth/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider) || !oauthEnabled(c.env, provider)) return c.notFound();
  const saved = await verifyValue<{ state: string; verifier?: string; provider: string }>(c.env.SESSION_SECRET, getCookie(c, "oauth"));
  deleteCookie(c, "oauth", COOKIE);
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code");
  if (!saved || saved.provider !== provider || !timingSafeEqual(saved.state, state)) {
    return landing(c, "Your sign-in expired. Please try again.", 400);
  }
  if (!code) return landing(c, "Sign-in was cancelled.", 400);
  try {
    const token = await exchangeCode(c.env, provider, code, saved.verifier);
    const cfg = PROVIDER_CONFIG[provider];
    const user = await cfg.fetchUser(c.env, token);
    const ok = await cfg.eligibility(c.env, user, token);
    if (!ok.ok) return landing(c, ok.reason, 403);
    return finishVerification(c, provider, user.userId);
  } catch (err) {
    console.error(`oauth ${provider}`, err);
    return landing(c, `We could not complete sign-in with ${PROVIDER_LABELS[provider]}. Please try again.`, 400);
  }
});

// ---------- Option B: handle + one-time code ----------

app.get("/verify/:provider", (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider) || !fallbackEnabled(c.env, provider)) return c.notFound();
  if (surveyWindow(c.env) !== "open") return landing(c);
  return c.html(handleForm(provider));
});

app.post("/verify/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider) || !fallbackEnabled(c.env, provider)) return c.notFound();
  if (surveyWindow(c.env) !== "open") return landing(c);
  if (!(await signinAllowed(c))) return c.html(handleForm(provider, "Too many attempts from your network. Please try again in an hour."), 429);

  const form = await c.req.parseBody();
  const handle = normalizeHandle(String(form.handle ?? ""));
  const handleHash = await hmacHex(c.env.IDENTITY_PEPPER, `handle:${provider}:${handle}`);
  // One code per handle per 10 minutes, so nobody can spam someone else's DMs through us.
  const recent = await c.env.SURVEY_DB.prepare("SELECT 1 FROM fallback_codes WHERE handle_hash = ?1 AND created_at > ?2")
    .bind(handleHash, new Date(Date.now() - CODE_TTL_MS).toISOString())
    .first();
  if (recent) return c.html(handleForm(provider, "A code was sent to that handle in the last 10 minutes. Check your direct messages."), 429);

  try {
    const found = await lookupHandle(c.env, provider as FallbackProvider, handle);
    if (!found.ok) return c.html(handleForm(provider, found.reason), 400);
    const code = randomCode();
    const id = randomToken(12);
    await c.env.SURVEY_DB.prepare(
      "INSERT INTO fallback_codes (id, provider, handle_hash, user_id, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(id, provider, handleHash, found.userId, await sha256Hex(`${id}:${code}`), new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso())
      .run();
    await sendCode(c.env, provider as FallbackProvider, found.userId, code);
    setCookie(c, "fb", await signValue(c.env.SESSION_SECRET, { id, provider }, 600), { ...COOKIE, maxAge: 600 });
    await c.env.SURVEY_DB.prepare("DELETE FROM fallback_codes WHERE expires_at < ?1").bind(nowIso()).run();
    return c.html(codeForm(provider));
  } catch (err) {
    console.error(`fallback ${provider}`, err);
    return c.html(handleForm(provider, "We could not send a code right now. Please use the sign-in button instead."), 502);
  }
});

app.post("/verify/:provider/code", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider) || !fallbackEnabled(c.env, provider)) return c.notFound();
  const saved = await verifyValue<{ id: string; provider: string }>(c.env.SESSION_SECRET, getCookie(c, "fb"));
  if (!saved || saved.provider !== provider) return c.html(handleForm(provider, "Your code expired. Please start again."), 400);
  const db = c.env.SURVEY_DB;
  const row = await db
    .prepare("SELECT * FROM fallback_codes WHERE id = ?1")
    .bind(saved.id)
    .first<{ id: string; user_id: string; code_hash: string; attempts: number; expires_at: string }>();
  if (!row || row.expires_at < nowIso() || row.attempts >= MAX_CODE_ATTEMPTS) {
    deleteCookie(c, "fb", COOKIE);
    return c.html(handleForm(provider, "Your code expired. Please start again."), 400);
  }
  const code = String((await c.req.parseBody()).code ?? "").trim();
  if (!timingSafeEqual(await sha256Hex(`${row.id}:${code}`), row.code_hash)) {
    await db.prepare("UPDATE fallback_codes SET attempts = attempts + 1 WHERE id = ?1").bind(row.id).run();
    return c.html(codeForm(provider, "That code is not right. Please check and try again."), 400);
  }
  // Keep the row until it expires so the per-handle throttle still applies, but drop the account ID now.
  await db.prepare("UPDATE fallback_codes SET attempts = ?2, user_id = '', code_hash = '' WHERE id = ?1").bind(row.id, MAX_CODE_ATTEMPTS).run();
  deleteCookie(c, "fb", COOKIE);
  return finishVerification(c, provider, row.user_id);
});

// ---------- The survey ----------

async function session(c: C): Promise<Session | null> {
  return verifyValue<Session>(c.env.SESSION_SECRET, getCookie(c, "session"));
}

app.get("/survey", async (c) => {
  if (surveyWindow(c.env) !== "open") return landing(c);
  if (!(await session(c))) return c.redirect("/", 303);
  return c.html(surveyPage({ siteKey: c.env.TURNSTILE_SITE_KEY ?? "" }));
});

async function turnstileOk(env: Env, token: string, ip: string): Promise<boolean> {
  if (!isConfigured(env.TURNSTILE_SECRET) || !token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  return body.success === true;
}

app.post("/survey", async (c) => {
  if (surveyWindow(c.env) !== "open") return landing(c);
  const s = await session(c);
  if (!s) return c.redirect("/", 303);
  const form = (await c.req.parseBody({ all: true })) as Record<string, string | string[]>;
  const parsed = parseAnswers(form);
  const siteKey = c.env.TURNSTILE_SITE_KEY ?? "";
  if (!parsed.ok) return c.html(surveyPage({ siteKey, error: parsed.error }), 400);

  const ip = clientIp(c);
  const turnstile = Array.isArray(form["cf-turnstile-response"]) ? form["cf-turnstile-response"][0] : form["cf-turnstile-response"];
  if (!(await turnstileOk(c.env, turnstile ?? "", ip))) {
    return c.html(surveyPage({ siteKey, values: parsed.answers, error: "Please complete the check above the Submit button." }), 400);
  }
  const submitKey = `submit:${await ipHash(c.env.IDENTITY_PEPPER, ip)}`;
  if (!(await rateLimit(c.env, submitKey, intVar(c.env.RATE_LIMIT_SUBMIT_PER_HOUR, 10)))) {
    return c.html(surveyPage({ siteKey, values: parsed.answers, error: "Too many submissions from your network. Please try again in an hour." }), 429);
  }
  const { asn, country } = cfInfo(c);
  const source = getCookie(c, "src") ?? null;
  if (await activeBlock(c.env, { provider: s.provider, asn, country, source })) {
    return c.html(messagePage("Temporarily unavailable", "Submissions from here are paused for now. Please try again later."), 403);
  }

  const text = freeText(parsed.answers);
  const fingerprint = text.length >= 20 ? await sha256Hex(text) : null;
  const db = c.env.SURVEY_DB;
  try {
    // Atomic: the identity row's PRIMARY KEY makes a second response from the same account fail as a whole.
    await db.batch([
      db.prepare("INSERT INTO identities (id_hash, provider) VALUES (?1, ?2)").bind(s.idHash, s.provider),
      db
        .prepare(
          "INSERT INTO responses (id, channel, source, submitted_at, asn, country, answers, text_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(randomToken(16), s.provider, source, nowIso(), asn, country, JSON.stringify(parsed.answers), fingerprint),
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE") || String(err).includes("PRIMARY KEY")) {
      deleteCookie(c, "session", COOKIE);
      return c.html(messagePage("Already responded", "Thank you, this account has already answered the survey."));
    }
    throw err;
  }
  deleteCookie(c, "session", COOKIE);
  return c.html(messagePage("Thank you", "Your response was recorded. Thank you for helping shape the XRPL Foundation."));
});

// ---------- Agents and Slack ----------

app.route("/admin/api", admin);

app.post("/slack/interactive", async (c) => {
  const raw = new TextDecoder().decode(await c.req.arrayBuffer());
  if (!(await verifySlackRequest(c.env, raw, c.req.header("X-Slack-Request-Timestamp") ?? null, c.req.header("X-Slack-Signature") ?? null))) {
    return c.text("invalid signature", 401);
  }
  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  c.executionCtx.waitUntil(
    handleInteractive(c.env, payload).catch((err) => audit(c.env, "system", "slack_interactive_error", { error: String(err) })),
  );
  return c.body(null, 200);
});

app.onError((err, c) => {
  console.error(err);
  return c.html(messagePage("Something went wrong", "Please try again in a few minutes."), 500);
});

export default app;
