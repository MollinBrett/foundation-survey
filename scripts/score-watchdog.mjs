// After a watchdog run against the staging database, compare its decisions with the labels.
// Usage: SURVEY_URL=https://staging-host SURVEY_ADMIN_KEY=... node scripts/score-watchdog.mjs
import { readFileSync } from "node:fs";

const url = process.env.SURVEY_URL;
const key = process.env.SURVEY_ADMIN_KEY;
if (!url || !key) throw new Error("set SURVEY_URL and SURVEY_ADMIN_KEY");
const labels = JSON.parse(readFileSync("test/fixtures/watchdog-samples.json", "utf8"));
const res = await fetch(`${url}/admin/api/responses?status=quarantined&limit=500`, { headers: { Authorization: `Bearer ${key}` } });
const quarantined = new Set((await res.json()).responses.map((r) => r.id));

let wrongRemovals = 0, missed = 0;
for (const l of labels) {
  const removed = quarantined.has(l.id);
  if (l.label === "keep" && removed) { wrongRemovals++; console.log(`WRONGLY REMOVED ${l.id} (genuine response)`); }
  if (l.label !== "keep" && !removed) { missed++; console.log(`missed ${l.id} (${l.label})`); }
}
const bad = labels.filter((l) => l.label !== "keep").length;
console.log(`\nGenuine responses wrongly removed: ${wrongRemovals} of ${labels.length - bad}  (target: 0)`);
console.log(`Junk/abuse caught: ${bad - missed} of ${bad}  (target: all spam and abuse; most coordinated)`);
process.exit(wrongRemovals > 0 ? 1 : 0);
