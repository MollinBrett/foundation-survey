// The private results page (/results). The only thing a person needs to look at.
// Access: Cloudflare Access sits in front of it; this module verifies the Access token itself,
// so the page stays closed even if the Access rule is removed by mistake.
import { type Env, isConfigured } from "./env";
import { base64urlDecode } from "./crypto";
import { type FullResults, type Tally, loadResults } from "./results";
import { esc } from "./views";

// ---------- Cloudflare Access ----------

let certCache: { domain: string; at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;

async function accessKeys(domain: string, force: boolean) {
  if (!force && certCache && certCache.domain === domain && Date.now() - certCache.at < 3_600_000) return certCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const keys = ((await res.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys ?? [];
  certCache = { domain, at: Date.now(), keys };
  return keys;
}

/** Returns the viewer's email if the Cloudflare Access token is valid for this application, else null. */
export async function verifyAccessToken(env: Env, token: string | undefined): Promise<string | null> {
  if (!isConfigured(env.ACCESS_TEAM_DOMAIN) || !isConfigured(env.ACCESS_AUD) || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(base64urlDecode(parts[0]!))) as { alg?: string; kid?: string };
    const claims = JSON.parse(dec.decode(base64urlDecode(parts[1]!))) as { aud?: string | string[]; iss?: string; exp?: number; email?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;

    let jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? (claims.email ?? "verified") : null;
  } catch {
    return null;
  }
}

// ---------- Data ----------

interface Activity {
  at: string;
  actor: string;
  action: string;
  detail: string | null;
}

interface PageData {
  results: FullResults;
  received: number;
  screened: number;
  removed: number;
  restored: number;
  blocks: number;
  overrides: number;
  report: { kind: string; text: string; themes: string; created_at: string } | null;
  activity: Activity[];
  announcements: { kind: string; channel: string; status: string; scheduled_for: string }[];
  activeBlocks: { scope: string; value: string; expires_at: string }[];
}

export async function loadPageData(env: Env): Promise<PageData> {
  const db = env.SURVEY_DB;
  const [totals, blocks, overrides, report, activity, announcements, activeBlocks] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS received,
              SUM(reviewed) AS screened,
              SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS removed,
              SUM(CASE WHEN status = 'accepted' AND audited = 1 THEN 1 ELSE 0 END) AS restored
       FROM responses`,
    ),
    db.prepare("SELECT COUNT(*) AS n FROM blocks"),
    db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor LIKE 'slack:%' AND action IN ('restore_batch', 'lift_block')"),
    db.prepare("SELECT kind, text, themes, created_at FROM reports ORDER BY created_at DESC LIMIT 1"),
    db.prepare("SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 40"),
    db.prepare("SELECT kind, channel, status, scheduled_for FROM announcements ORDER BY scheduled_for"),
    db.prepare("SELECT scope, value, expires_at FROM blocks WHERE expires_at > ?1 ORDER BY expires_at").bind(new Date().toISOString()),
  ]);
  const t = (totals!.results[0] ?? {}) as Record<string, number | null>;
  return {
    results: await loadResults(env),
    received: t.received ?? 0,
    screened: t.screened ?? 0,
    removed: t.removed ?? 0,
    restored: t.restored ?? 0,
    blocks: (blocks!.results[0] as { n: number }).n,
    overrides: (overrides!.results[0] as { n: number }).n,
    report: (report!.results[0] as PageData["report"]) ?? null,
    activity: activity!.results as unknown as Activity[],
    announcements: announcements!.results as PageData["announcements"],
    activeBlocks: activeBlocks!.results as PageData["activeBlocks"],
  };
}

// ---------- Rendering ----------

const SHORT: Record<string, string> = {
  satisfaction: "Overall satisfaction",
  impact: "Impact on the ecosystem",
  independence: "Independence from Ripple",
  transparency_decisions: "Transparency: decisions",
  transparency_finances: "Transparency: finances",
  listening: "Listens to the community",
  leadership: "Leadership team performance",
};

const fmtPct = (n: number | null) => (n === null ? "n/a" : `${n % 1 === 0 ? n : n.toFixed(1)}%`);
const fmtInt = (n: number) => n.toLocaleString("en-US");
const fmtTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function describe(a: Activity): { who: string; what: string } {
  let d: Record<string, any> = {};
  try {
    d = a.detail ? JSON.parse(a.detail) : {};
  } catch {
    /* keep empty */
  }
  const who = a.actor.startsWith("agent:") ? `${a.actor.slice(6)} agent` : a.actor.startsWith("slack:") ? "a person" : "the app";
  const what: Record<string, string> = {
    review: `screened ${d.reviewed ?? 0} response(s) and removed ${d.removed ?? 0}`,
    apply_block: `blocked ${d.scope} = ${d.value} for ${d.hours}h: ${d.reason ?? ""}`,
    audit: `re-checked removals: confirmed ${d.confirmed ?? 0}, restored ${d.restored ?? 0}`,
    report: `posted the ${d.kind} report`,
    draft_announcements: `drafted ${d.saved ?? 0} announcement(s) for approval`,
    announcement_approved: `approved the ${d.kind} announcement for ${d.channel}`,
    announcement_edited_and_approved: `edited and approved the ${d.kind} announcement for ${d.channel}`,
    announcement_skipped: `skipped an announcement${d.kind ? ` (${d.kind} for ${d.channel})` : ""}`,
    announcement_posted: `posted the ${d.kind} announcement on ${d.channel}`,
    announcement_handed_off: `asked for the ${d.kind} announcement to be posted on ${d.channel} by hand`,
    announcement_failed: `could not post an announcement on ${d.channel}`,
    restore_batch: `restored ${d.count ?? 0} response(s), overriding the watchdog`,
    lift_block: `lifted the block on ${d.scope} = ${d.value} early`,
    self_check_alert: `raised an alert: ${d.text ?? d.key}`,
    identity_data_deleted: `deleted the account hashes and network details (${d.identities ?? 0} accounts)`,
    scheduled_job_error: `hit an error in its ${d.job} job`,
  };
  return { who, what: what[a.action] ?? a.action.replace(/_/g, " ") };
}

function bar(t: Tally, label: string): string {
  if (t.answered === 0 || t.pct_positive === null) return `<div class="bar empty">No answers yet</div>`;
  const parts = [
    { cls: "neg", pct: t.pct_negative ?? 0, n: t.negative, name: "Negative" },
    { cls: "neu", pct: t.pct_neutral ?? 0, n: t.neutral, name: "Neutral" },
    { cls: "pos", pct: t.pct_positive, n: t.positive, name: "Positive" },
  ].filter((x) => x.pct > 0);
  const segs = parts
    .map((x, i) => {
      const ends = `${i === 0 ? " first" : ""}${i === parts.length - 1 ? " last" : ""}`;
      return `<span class="seg ${x.cls}${ends}" style="width:${(x.pct / 2).toFixed(2)}%" tabindex="0" role="img" aria-label="${esc(`${label}: ${x.name} ${fmtPct(x.pct)}, ${x.n} of ${t.answered}`)}" data-tip="${esc(`${x.name} ${fmtPct(x.pct)} (${x.n} of ${t.answered})`)}"></span>`;
    })
    .join("");
  // The bar is centred on the neutral answers: negative grows left of centre, positive right.
  // The full width is a -100% to +100% scale, so the spacer pushes the bar to its starting point.
  const offset = ((100 - (t.pct_negative ?? 0) - (t.pct_neutral ?? 0) / 2) / 2).toFixed(2);
  return `<div class="bar"><span class="axis" aria-hidden="true"></span><span class="segs"><span class="sp" style="width:${offset}%"></span>${segs}</span></div>`;
}

export function renderResultsPage(d: PageData, now = new Date()): string {
  const r = d.results;
  const headline = r.kpis.find((k) => k.headline) ?? r.kpis[0]!;
  const withRemoved = new Map(r.including_removed.map((x) => [x.id, x]));
  const h = headline.all;
  const meets = h.meets_target;
  const windowText = { before: "Not open yet", open: "Open", closed: "Closed" }[r.window];

  const hero = `
<section class="hero card">
  <p class="eyebrow">Headline KPI · ${esc(SHORT[headline.id] ?? headline.id)}</p>
  <p class="figure">${h.pct_positive === null ? "–" : fmtPct(h.pct_positive)}<span class="unit"> positive</span></p>
  ${
    meets === null
      ? `<p class="muted">No answers yet. The target is ${r.target_pct_positive}% positive.</p>`
      : `<p><span class="status ${meets ? "good" : "below"}"><span aria-hidden="true">${meets ? "✓" : "▼"}</span> ${meets ? "Meets" : "Below"} the ${r.target_pct_positive}% target</span></p>
  <p class="muted">${fmtPct(h.pct_negative)} negative · ${fmtPct(h.pct_neutral)} neutral · ${fmtInt(h.answered)} answered · ${fmtInt(h.dont_know)} said "don't know"</p>
  <p class="muted">With the removed responses counted back in: ${fmtPct(withRemoved.get(headline.id)?.pct_positive ?? null)} positive.</p>`
  }
</section>`;

  const tile = (label: string, value: string, note = "") => `<div class="tile"><p class="tlabel">${esc(label)}</p><p class="tvalue">${esc(value)}</p>${note ? `<p class="tnote">${esc(note)}</p>` : ""}</div>`;
  const ran = `
<section>
  <h2>How this ran</h2>
  <div class="tiles">
    ${tile("Responses received", fmtInt(d.received))}
    ${tile("Screened by the watchdog", fmtInt(d.screened))}
    ${tile("Removed as spam or abuse", fmtInt(d.removed))}
    ${tile("Restored on second review", fmtInt(d.restored))}
    ${tile("Temporary blocks applied", fmtInt(d.blocks))}
    ${tile("Times a person stepped in", fmtInt(d.overrides), "moderation overrides")}
  </div>
  ${d.activeBlocks.length ? `<p class="muted">Active block${d.activeBlocks.length > 1 ? "s" : ""}: ${d.activeBlocks.map((b) => `${esc(b.scope)} = ${esc(b.value)} until ${esc(fmtTime(b.expires_at))}`).join("; ")}.</p>` : ""}
</section>`;

  const rows = r.kpis
    .map(
      (k) => `
  <div class="krow">
    <div class="kname">${esc(SHORT[k.id] ?? k.id)}${k.headline ? ' <span class="tag">headline</span>' : ""}</div>
    <div class="kneg">${fmtPct(k.all.pct_negative)}</div>
    ${bar(k.all, SHORT[k.id] ?? k.id)}
    <div class="kpos">${fmtPct(k.all.pct_positive)}</div>
  </div>`,
    )
    .join("");
  const table = r.kpis
    .map((k) => {
      const w = withRemoved.get(k.id);
      return `<tr><th scope="row">${esc(SHORT[k.id] ?? k.id)}</th><td>${fmtInt(k.all.positive)}</td><td>${fmtInt(k.all.neutral)}</td><td>${fmtInt(k.all.negative)}</td><td>${fmtInt(k.all.dont_know)}</td><td>${fmtPct(k.all.pct_positive)}</td><td>${fmtPct(k.familiar.pct_positive)}</td><td>${fmtPct(w?.pct_positive ?? null)}</td></tr>`;
    })
    .join("");
  const kpis = `
<section>
  <h2>The seven KPI questions</h2>
  <p class="muted">Share of people who answered each question. Target: ${r.target_pct_positive}% positive.</p>
  <div class="legend" aria-hidden="true"><span><i class="sw neg"></i>Negative</span><span><i class="sw neu"></i>Neutral</span><span><i class="sw pos"></i>Positive</span></div>
  <div class="khead" aria-hidden="true"><span></span><span>Negative</span><span></span><span>Positive</span></div>
  <div class="kpis">${rows}</div>
  <details>
    <summary>Show the numbers</summary>
    <div class="scroll"><table>
      <thead><tr><th scope="col">Question</th><th scope="col">Positive</th><th scope="col">Neutral</th><th scope="col">Negative</th><th scope="col">Don't know</th><th scope="col">% positive</th><th scope="col">% positive, familiar respondents</th><th scope="col">% positive, removed responses counted</th></tr></thead>
      <tbody>${table}</tbody>
    </table></div>
    <p class="muted">Familiar respondents: the ${fmtInt(r.familiar_respondents)} of ${fmtInt(r.respondents)} who said they are at least moderately familiar with the Foundation.</p>
  </details>
</section>`;

  const reported = r.roles.filter((x) => x.reported);
  const small = r.roles.filter((x) => !x.reported);
  const roles = `
<section>
  <h2>By role</h2>
  ${
    reported.length
      ? `<div class="scroll"><table>
      <thead><tr><th scope="col">% positive</th>${reported.map((x) => `<th scope="col">${esc(x.role)} <span class="muted">(${fmtInt(x.respondents)})</span></th>`).join("")}</tr></thead>
      <tbody>${r.kpis.map((k) => `<tr><th scope="row">${esc(SHORT[k.id] ?? k.id)}</th>${reported.map((x) => `<td>${fmtPct(k.by_role[x.role]?.pct_positive ?? null)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`
      : `<p class="muted">No role has ${r.min_group_report_size} responses yet, so nothing is broken out by role.</p>`
  }
  ${small.length ? `<p class="muted">Too few to report separately (under ${r.min_group_report_size}): ${small.map((x) => `${esc(x.role)} (${fmtInt(x.respondents)})`).join(", ")}.</p>` : ""}
  <p class="muted">Respondents by channel: ${Object.entries(r.respondents_by_channel).map(([c, n]) => `${esc(c)} ${fmtInt(n)}`).join(", ") || "none yet"}.</p>
</section>`;

  let themes: { title: string; summary: string; mentions: number | null }[] = [];
  try {
    themes = d.report ? JSON.parse(d.report.themes) : [];
  } catch {
    /* keep empty */
  }
  const said = `
<section>
  <h2>What people said</h2>
  ${
    d.report
      ? `${themes.length ? `<div class="themes">${themes.map((t) => `<div class="card theme"><h3>${esc(t.title)}</h3><p>${esc(t.summary)}</p>${t.mentions !== null ? `<p class="muted">About ${fmtInt(t.mentions)} mention(s)</p>` : ""}</div>`).join("")}</div>` : ""}
  <details ${themes.length ? "" : "open"}><summary>Latest ${esc(d.report.kind)} report, ${esc(fmtTime(d.report.created_at))}</summary><p class="report">${esc(d.report.text)}</p></details>`
      : `<p class="muted">The reporter agent has not posted a report yet.</p>`
  }
</section>`;

  const log = `
<section>
  <h2>What the agents did</h2>
  ${
    d.activity.length
      ? `<div class="scroll"><table class="log"><tbody>${d.activity
          .map((a) => {
            const x = describe(a);
            return `<tr><td class="when">${esc(fmtTime(a.at))}</td><td>${esc(x.who[0]!.toUpperCase() + x.who.slice(1))} ${esc(x.what)}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="muted">Nothing yet.</p>`
  }
</section>`;

  const posts = d.announcements.length
    ? `
<section>
  <h2>Announcements</h2>
  <div class="scroll"><table><thead><tr><th scope="col">When</th><th scope="col">Post</th><th scope="col">Channel</th><th scope="col">Status</th></tr></thead>
  <tbody>${d.announcements.map((a) => `<tr><td class="when">${esc(fmtTime(a.scheduled_for))}</td><td>${esc(a.kind.replace(/_/g, " "))}</td><td>${esc(a.channel)}</td><td>${esc(a.status.replace(/_/g, " "))}</td></tr>`).join("")}</tbody></table></div>
</section>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><meta name="robots" content="noindex">
<title>Survey results</title><style>${CSS}</style></head><body><main class="viz-root">
<header>
  <h1>Community survey results</h1>
  <p class="muted"><span class="pill">${windowText}</span> Official 2026 KPI · ${fmtInt(r.respondents)} respondents counted · updated ${esc(fmtTime(now.toISOString()))}</p>
</header>
${hero}${ran}${kpis}${roles}${said}${log}${posts}
<footer class="muted">
  <p>${esc(r.scoring)}</p>
  <p>Results describe the people who chose to respond, not the whole XRPL community, so no margin of error applies. Each respondent was verified and could answer once.</p>
</footer>
</main></body></html>`;
}

const CSS = `
.viz-root{color-scheme:light;--page:#f6f5f2;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#6f6d68;--line:#e1e0d9;--neg:#e34948;--pos:#2a78d6;--neu:#d9d7cf;--good:#0ca30c;--good-bg:#e6f4e6;--below-bg:#fdeceb}
@media (prefers-color-scheme:dark){.viz-root{color-scheme:dark;--page:#121211;--surface-1:#1a1a19;--text-primary:#f0efec;--text-secondary:#c3c2b7;--muted:#a19f97;--line:#2c2c2a;--neg:#e66767;--pos:#3987e5;--neu:#4a4a46;--good:#0ca30c;--good-bg:#12301a;--below-bg:#3a1c1b}}
*{box-sizing:border-box}html{background:#f6f5f2}@media (prefers-color-scheme:dark){html{background:#121211}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{background:var(--page);color:var(--text-primary);max-width:1040px;margin:0 auto;padding:28px 16px 56px}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 4px}h3{font-size:.95rem;margin:0 0 4px}
p{margin:0 0 8px}section{margin-top:32px}.muted{color:var(--muted);font-size:.875rem}
.card{background:var(--surface-1);border:1px solid var(--line);border-radius:10px;padding:16px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;margin-right:6px;color:var(--text-secondary);background:var(--surface-1)}
.hero{margin-top:20px;padding:20px}.eyebrow{color:var(--text-secondary);font-size:.875rem;margin:0}
.figure{font-size:56px;line-height:1.1;font-weight:600;margin:4px 0 8px}.figure .unit{font-size:1.1rem;font-weight:400;color:var(--text-secondary)}
.status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-weight:600;font-size:.9rem}
.status.good{background:var(--good-bg)}.status.good span{color:var(--good)}.status.below{background:var(--below-bg)}.status.below span{color:var(--neg)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
.tile{background:var(--surface-1);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tlabel{color:var(--text-secondary);font-size:.8rem;margin:0}.tvalue{font-size:1.6rem;font-weight:600;line-height:1.2;margin:2px 0 0}.tnote{color:var(--muted);font-size:.75rem;margin:0}
.legend{display:flex;gap:16px;font-size:.8rem;color:var(--text-secondary);margin:8px 0}.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px}.sw.neg,.seg.neg{background:var(--neg)}.sw.neu,.seg.neu{background:var(--neu)}.sw.pos,.seg.pos{background:var(--pos)}
.kpis{background:var(--surface-1);border:1px solid var(--line);border-radius:10px;padding:6px 14px}
.krow,.khead{display:grid;grid-template-columns:minmax(150px,220px) 52px 1fr 52px;align-items:center;gap:10px}
.krow{padding:10px 0;border-top:1px solid var(--line)}.krow:first-child{border-top:0}
.khead{padding:0 15px;font-size:.75rem;color:var(--muted)}.khead span:nth-child(2){text-align:right}
.kname{font-size:.9rem}.tag{font-size:.7rem;color:var(--text-secondary);border:1px solid var(--line);border-radius:999px;padding:0 6px;margin-left:4px;white-space:nowrap}
.kneg,.kpos{font-variant-numeric:tabular-nums;font-size:.9rem;color:var(--text-secondary)}.kneg{text-align:right}.kpos{font-weight:600;color:var(--text-primary)}
.bar{position:relative;height:20px;min-width:0}.bar.empty{height:auto;color:var(--muted);font-size:.8rem}
.axis{position:absolute;left:50%;top:-4px;bottom:-4px;width:1px;background:var(--line)}
.segs{position:relative;display:flex;gap:2px;height:20px;width:100%}
.seg{position:relative;display:block;height:20px;flex:none;min-width:2px;outline-offset:2px}
.sp{flex:none;margin-right:-2px}.seg.first{border-radius:4px 0 0 4px}.seg.last{border-radius:0 4px 4px 0}.seg.first.last{border-radius:4px}
.seg:hover::after,.seg:focus-visible::after{content:attr(data-tip);position:absolute;z-index:2;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;background:var(--text-primary);color:var(--surface-1);font-size:.75rem;padding:3px 8px;border-radius:6px;pointer-events:none}
details{margin-top:10px}summary{cursor:pointer;color:var(--text-secondary);font-size:.875rem}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.85rem;margin:8px 0;background:var(--surface-1)}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}td{font-variant-numeric:tabular-nums}thead th{color:var(--text-secondary);font-weight:600}tbody th{font-weight:400}
.when{white-space:nowrap;color:var(--muted)}
.themes{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:10px 0}.theme p{font-size:.9rem}
.report{white-space:pre-wrap;font-size:.9rem;background:var(--surface-1);border:1px solid var(--line);border-radius:10px;padding:12px}
footer{margin-top:36px;border-top:1px solid var(--line);padding-top:12px}
@media (max-width:640px){.krow{grid-template-columns:44px 1fr 44px;row-gap:4px}.kname{grid-column:1/-1}.khead{display:none}.figure{font-size:48px}}
`;
