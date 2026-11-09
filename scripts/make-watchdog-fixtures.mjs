// Builds the watchdog test set: 50 responses with the label a careful human would give.
// Output: test/fixtures/watchdog-samples.json (with labels) and watchdog-samples.sql (to load into a STAGING database).
// Usage: node scripts/make-watchdog-fixtures.mjs
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const base = Date.parse("2026-12-02T15:00:00Z");
let t = 0;
const at = (minutes) => new Date(base + minutes * 60_000).toISOString();
const r = (label, channel, text, scores = {}, extra = {}) => ({
  label, // keep | spam | abuse | duplicate | coordinated
  channel,
  minutes: (t += 7),
  asn: 7922,
  country: "US",
  answers: {
    participation: ["Community member / holder"],
    familiarity: 3, impact: 3, independence: 3, transparency: 3,
    priorities: ["Security"], news_sources: ["X"], recommend: 6,
    ...scores,
    ...(text ? { start_stop_change: text } : {}),
  },
  ...extra,
});

const keep = [
  r("keep", "github", "Publish the grant decisions and the reasons behind them every quarter.", { impact: 4, recommend: 8 }),
  r("keep", "discord", "Honestly the Foundation feels like a Ripple department with a different logo. Prove me wrong with an independent board.", { independence: 1, transparency: 1, recommend: 2 }),
  r("keep", "x", "Stop the endless panels and ship better validator docs.", { impact: 2, recommend: 3 }),
  r("keep", "slack", "", { impact: 5, recommend: 10 }),
  r("keep", "x", "The amendment process is a black box. Nobody outside knows who decides what gets voted on.", { transparency: 1, recommend: 4 }),
  r("keep", "github", "Fund the boring infrastructure: clio, xrpl.js maintenance, test networks.", { priorities: ["Developer docs and tools", "Network health and validators"] }),
  r("keep", "discord", "This is a damn good start but you need to talk to builders more, not just institutions.", { recommend: 7 }),
  r("keep", "mattermost", "Keep the UNL drills going. The Oct outage response was slow.", { impact: 3, recommend: 6 }),
  r("keep", "x", "", { familiarity: 1, impact: 3, recommend: 5, independence: "dont_know", transparency: "dont_know" }),
  r("keep", "slack", "Run more events outside the US and Europe. Asia and Africa are where growth is.", { priorities: ["Community events", "Education"] }),
  r("keep", "x", "You guys are useless. Zero impact on anything I care about.", { impact: 1, recommend: 0 }),
  r("keep", "github", "Security audits should be published in full, not summarized.", { priorities: ["Security", "Governance"] }),
  r("keep", "discord", "Grants take forever to get a decision. Set a deadline and stick to it.", { recommend: 5 }),
  r("keep", "x", "Love what you're doing with the docs rewrite.", { impact: 5, recommend: 9 }),
  r("keep", "slack", "Explain where the money comes from. If it is mostly Ripple, say so plainly.", { transparency: 2, independence: 2 }),
  r("keep", "x", "", { impact: 1, independence: 1, transparency: 1, recommend: 0, familiarity: 1 }),
  r("keep", "github", "Start a public roadmap. Stop announcing things on X first and documenting later.", { recommend: 6 }),
  r("keep", "discord", "The executive director should do AMAs here, not just at conferences.", { recommend: 7 }),
  r("keep", "x", "XRPL is the best ledger and the foundation should market it harder!!!", { impact: 5, recommend: 10 }),
  r("keep", "mattermost", "Validator onboarding is painful. Write a step-by-step guide with real configs.", { priorities: ["Network health and validators", "Developer docs and tools"] }),
  r("keep", "x", "Ripple's lapdog. Change my mind.", { independence: 1, recommend: 1 }),
  r("keep", "github", "", { impact: 4, recommend: 8 }),
  r("keep", "slack", "Stop: duplicating what XRPL Commons does. Start: coordinating with them.", { recommend: 6 }),
  r("keep", "discord", "Education for non-English speakers. Spanish, Portuguese, Japanese, Korean at minimum.", { priorities: ["Education"] }),
  r("keep", "x", "Your comms are terrible, I found out about the amendment vote from a random tweet.", { transparency: 2, recommend: 3 }),
  r("keep", "github", "Make the Foundation's votes on amendments public with reasoning.", { transparency: 2, recommend: 6 }),
  r("keep", "x", "keep it up", { impact: 4, recommend: 8 }),
  r("keep", "discord", "Fees for new projects to get listed in your directory are a bad look. Drop them.", { recommend: 4 }),
  r("keep", "slack", "Good governance work this year. More of it.", { impact: 4, recommend: 8 }),
  r("keep", "x", "Do something about the scam projects using the XRPL name.", { priorities: ["Security", "Community events"] }),
];

const spam = [
  r("spam", "x", "asdfasdf qwerty asdf asdfjkl;", {}),
  r("spam", "x", "BUY $MOONXRP NOW 1000x GUARANTEED visit moonxrp-airdrop.example", {}),
  r("spam", "discord", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {}),
  r("spam", "x", "Free crypto giveaway, DM me your seed phrase to claim", {}),
  r("spam", "github", "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod", {}),
  r("spam", "x", "Best VPN deals 2026 click here bestvpn.example/promo", {}),
  r("spam", "discord", "test test test test test test test test", {}),
  r("spam", "x", "jsjsjsjsjs hdhdhdhd kdkdkdkd", {}),
];

const abuse = [
  r("abuse", "x", "I know where the foundation staff live and they should be scared.", { recommend: 0 }),
  r("abuse", "discord", "Call the director at 555-0147, his home address is 12 Example Lane, make his life hell.", { recommend: 0 }),
  r("abuse", "x", "Whoever runs the discord should kill themselves.", { recommend: 0 }),
  r("abuse", "x", "Post the home address of everyone on the board so we can visit them.", { recommend: 0 }),
  r("abuse", "github", "The community manager is a [explicit sexual insult directed at a named staff member].", { recommend: 0 }),
];

const brigadeText = "The XRPL Foundation must be dissolved immediately and all funds returned to the community. #DissolveXRPLF";
const coordinated = Array.from({ length: 7 }, (_, i) =>
  r("coordinated", "x", i % 2 ? brigadeText : brigadeText.replace("immediately", "now"), { impact: 1, independence: 1, transparency: 1, recommend: 0 }, { asn: 64512, country: "ZZ", minutes: 400 + i, source: "x-post-2" }),
);

const all = [...keep, ...spam, ...abuse, ...coordinated].map((x, i) => ({ id: `fixture-${String(i + 1).padStart(2, "0")}`, ...x }));
if (all.length !== 50) throw new Error(`expected 50 fixtures, got ${all.length}`);

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const q = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql = all
  .map((x) => {
    const text = norm(x.answers.start_stop_change ?? "");
    const fp = text.length >= 20 ? createHash("sha256").update(text).digest("hex") : null;
    return `INSERT INTO responses (id, channel, source, submitted_at, asn, country, answers, text_fingerprint) VALUES (${q(x.id)}, ${q(x.channel)}, ${q(x.source ?? null)}, ${q(at(x.minutes))}, ${q(x.asn)}, ${q(x.country)}, ${q(JSON.stringify(x.answers))}, ${q(fp)});`;
  })
  .join("\n");

writeFileSync("test/fixtures/watchdog-samples.json", JSON.stringify(all.map(({ id, label, channel }) => ({ id, label, channel })), null, 2) + "\n");
writeFileSync("test/fixtures/watchdog-samples.sql", `-- STAGING ONLY. Generated by scripts/make-watchdog-fixtures.mjs\n${sql}\n`);
console.log(`wrote 50 fixtures: ${keep.length} keep, ${spam.length} spam, ${abuse.length} abuse, ${coordinated.length} coordinated`);
