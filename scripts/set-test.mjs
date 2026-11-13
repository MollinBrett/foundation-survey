// Fills in the test version's settings in wrangler.toml, so nobody has to edit the file by hand.
//   node scripts/set-test.mjs db <database id>            the ID printed by `wrangler d1 create`
//   node scripts/set-test.mjs url <https://...>            the address printed by `npm run deploy:test`
//   node scripts/set-test.mjs access <team domain> <aud>   Cloudflare Access, for the results page
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../wrangler.toml", import.meta.url);
const [kind, a, b] = process.argv.slice(2).map((s) => s.trim());
const fail = (msg) => { console.error(`set-test: ${msg}`); process.exit(1); };

let text = readFileSync(file, "utf8");
const start = text.indexOf("[[env.test.d1_databases]]");
if (start < 0) fail("wrangler.toml has no test section");
let head = text.slice(0, start), test = text.slice(start);

// Replace the value of one setting inside the test section only.
function set(key, value) {
  const re = new RegExp(`^(${key} = )"[^"]*"`, "m");
  if (!re.test(test)) fail(`could not find ${key} in the test section`);
  test = test.replace(re, `$1"${value}"`);
  console.log(`set-test: ${key} = "${value}"`);
}

if (kind === "db") {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a ?? "")) fail("the database ID looks like 1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f");
  set("database_id", a.toLowerCase());
} else if (kind === "url") {
  let url;
  try { url = new URL(a); } catch { fail("give the full address, starting with https://"); }
  if (url.protocol !== "https:") fail("the address must start with https://");
  set("PUBLIC_BASE_URL", url.origin);
  console.log(`set-test: GitHub callback URL is ${url.origin}/auth/github/callback`);
} else if (kind === "access") {
  const domain = (a ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(domain)) fail("the team domain looks like your-team.cloudflareaccess.com");
  if (!/^[0-9a-f]{32,}$/i.test(b ?? "")) fail("the AUD tag is a long string of letters and digits from the Access application's page");
  set("ACCESS_TEAM_DOMAIN", domain.toLowerCase());
  set("ACCESS_AUD", b);
} else {
  fail("usage: node scripts/set-test.mjs db <id> | url <https://...> | access <team domain> <aud>");
}
writeFileSync(file, head + test);
