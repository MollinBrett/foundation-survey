import { DONT_KNOW, DONT_KNOW_LABEL, INTRO, QUESTIONS, type Answers } from "./survey";
import { PROVIDER_LABELS, type Provider } from "./env";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--bg:#fff;--fg:#14171a;--muted:#5b6670;--line:#d9dee3;--accent:#1f5eff;--accent-fg:#fff;--card:#f6f8fa;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8ecf0;--muted:#9aa5b1;--line:#2a313a;--accent:#6b93ff;--accent-fg:#0f1216;--card:#171b21;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;line-height:1.25;margin:0 0 12px}
p{margin:0 0 16px}.muted{color:var(--muted)}.err{color:var(--err);font-weight:600}
.btns{display:grid;gap:10px;margin:24px 0}.btn{display:block;text-align:center;padding:12px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none;font-weight:600;cursor:pointer;font-size:1rem;width:100%}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.alt{font-size:.9rem}.alt a{color:var(--accent)}
fieldset{border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 16px}legend{font-weight:600;padding:0 4px}
label{display:block;padding:4px 0}.dk{margin-top:6px;padding-top:8px;border-top:1px dashed var(--line);color:var(--muted)}
fieldset input.other-text{margin:4px 0 0 24px;width:calc(100% - 24px)}fieldset.single:not(:has(input[data-other]:checked)) .other-text{display:none}
input[type=text],textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:96px}`;

export function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>${head}</head><body><main>${body}</main></body></html>`;
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

export function landingPage(opts: {
  oauth: Provider[];
  fallback: Provider[];
  error?: string;
  window: "before" | "open" | "closed";
  opensAt: string;
}): string {
  if (opts.window === "before") return messagePage("Not open yet", `The survey opens ${new Date(opts.opensAt).toUTCString()}.`);
  if (opts.window === "closed") return messagePage("Survey closed", "Thank you. This survey is now closed.");
  const buttons = opts.oauth
    .map((p) => `<a class="btn primary" href="/auth/${p}">Continue with ${esc(PROVIDER_LABELS[p])}</a>`)
    .join("");
  const alts = opts.fallback
    .map((p) => `<a href="/verify/${p}">Verify with your ${esc(PROVIDER_LABELS[p])} handle instead</a>`)
    .join(" · ");
  return page(
    "XRPL Foundation community survey",
    `<h1>How do you see the XRPL Foundation?</h1>
<p>${esc(INTRO)}</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<div class="btns">${buttons || '<p class="muted">Sign-in is not set up yet.</p>'}</div>
${alts ? `<p class="alt muted">${alts}</p>` : ""}
<p class="muted alt">Sign-in is used only to make sure each person answers once. We store a one-way code for your account, never your name or handle, and it is kept apart from your answers.</p>`,
  );
}

export function handleForm(provider: Provider, error?: string): string {
  const label = PROVIDER_LABELS[provider];
  return page(
    `Verify with ${label}`,
    `<h1>Verify with your ${esc(label)} handle</h1>
<p>Our bot will send a 6-digit code to that ${esc(label)} account. Enter it on the next screen.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/verify/${provider}">
<label for="handle">${esc(label)} username</label>
<input type="text" id="handle" name="handle" autocomplete="username" required maxlength="64">
<div class="btns"><button class="btn primary" type="submit">Send my code</button></div>
</form><p class="alt"><a href="/">Back</a></p>`,
  );
}

export function codeForm(provider: Provider, error?: string): string {
  const label = PROVIDER_LABELS[provider];
  return page(
    "Enter your code",
    `<h1>Enter your code</h1>
<p>We sent a code to your ${esc(label)} direct messages. It expires in 10 minutes.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/verify/${provider}/code">
<label for="code">6-digit code</label>
<input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required>
<div class="btns"><button class="btn primary" type="submit">Continue</button></div>
</form>`,
  );
}

function questionHtml(q: (typeof QUESTIONS)[number], values: Answers): string {
  const v = values[q.id];
  if (q.kind === "rating") {
    const opts = q.labels.map(
      (label, i) => `<label><input type="radio" name="${q.id}" value="${i + 1}"${v === i + 1 ? " checked" : ""} required> ${esc(label)}</label>`,
    );
    if (q.allowDontKnow) {
      opts.push(`<label class="dk"><input type="radio" name="${q.id}" value="${DONT_KNOW}"${v === DONT_KNOW ? " checked" : ""}> ${esc(DONT_KNOW_LABEL)}</label>`);
    }
    return `<fieldset><legend>${esc(q.text)}</legend>${opts.join("")}</fieldset>`;
  }
  if (q.kind === "single") {
    const opts = q.options
      .map((o) => `<label><input type="radio" name="${q.id}" value="${esc(o)}"${v === o ? " checked" : ""} required> ${esc(o)}</label>`)
      .join("");
    const other =
      `<label><input type="radio" name="${q.id}" value="${esc(q.otherOption)}"${v === q.otherOption ? " checked" : ""} data-other> ${esc(q.otherOption)} (please specify)</label>` +
      `<input class="other-text" type="text" name="${q.id}_other" maxlength="${q.otherMaxLength}" aria-label="${esc(q.otherOption)}: please specify" value="${esc(values[`${q.id}_other`] ?? "")}">`;
    return `<fieldset class="single"><legend>${esc(q.text)}</legend>${opts}${other}</fieldset>`;
  }
  return `<fieldset><legend><label for="${q.id}">${esc(q.text)}</label></legend><textarea id="${q.id}" name="${q.id}" maxlength="${q.maxLength}"${q.required ? " required" : ""}>${esc(v ?? "")}</textarea></fieldset>`;
}

export function surveyPage(opts: { siteKey: string; error?: string; values?: Answers }): string {
  const head = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  return page(
    "XRPL Foundation community survey",
    `<h1>Community survey</h1>
<p class="muted">You're verified. Your answers are stored without your name or handle.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<form method="post" action="/survey">
${QUESTIONS.map((q) => questionHtml(q, opts.values ?? {})).join("")}
<div class="cf-turnstile" data-sitekey="${esc(opts.siteKey)}"></div>
<div class="btns"><button class="btn primary" type="submit">Submit</button></div>
</form>`,
    head,
  );
}
