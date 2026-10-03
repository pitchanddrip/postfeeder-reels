// Makes Facebook reels without your phone. It opens your own PostFeeder site in a headless Chrome on GitHub,
// signs in as you, and runs the app's own "Make reel" code, so the video is identical to the one your phone makes.
//   node reels.mjs check    -> prints has_work=true/false (fast, no browser)
//   node reels.mjs render   -> makes + posts the reels
import { appendFileSync } from "node:fs";

const SB = "https://jniqkxtxskqyboxmsvql.supabase.co";
const KEY = "sb_publishable_Oo79PtyZgpJxEr1qRSLNjg_0RHavDuf"; // public key, same one the website uses
const SITE = process.env.SITE_URL || "https://postfeeder.netlify.app";
const { OWNER_EMAIL, OWNER_PASSWORD } = process.env;
const MAX_AGE_MS = 12 * 3600e3, MAX_PER_24H = 10, MAX_PER_RUN = 2, REEL_TIMEOUT_MS = 15 * 60e3;

const out = (k, v) => { console.log(`${k}=${v}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

async function login() {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) throw new Error("Add the OWNER_EMAIL and OWNER_PASSWORD secrets in GitHub (Settings > Secrets and variables > Actions).");
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Login failed: " + (d.error_description || d.msg || r.status));
  return d;
}
async function fn(sess, name, body) {
  const r = await fetch(`${SB}/functions/v1/${name}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json", Authorization: "Bearer " + sess.access_token }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${name}/${body.action}: ${d.error || r.status}`);
  return d;
}
const published = async (sess) => (await fn(sess, "api", { action: "stories", status: "published" })).stories || [];

// same rules as the app's Auto reels: important, already posted, no reel yet, under 12 h old, max 10 reels per 24 h
export function choose(list, min, now = Date.now()) {
  const recent = list.filter((s) => (s.reel_status === "published" || s.reel_status === "processing") && now - Date.parse(s.updated_at) < 24 * 3600e3).length;
  if (recent >= MAX_PER_24H) return [];
  return list
    .filter((s) => s.post_text && s.importance != null && s.importance >= min && !s.reel_status && now - Date.parse(s.first_seen) < MAX_AGE_MS)
    .sort((a, b) => b.importance - a.importance || Date.parse(b.first_seen) - Date.parse(a.first_seen));
}

async function candidates(sess) {
  const rs = await fn(sess, "reel", { action: "reel_settings_get" });
  if (!rs.auto_upload) { console.log('"Post to Facebook automatically when the reel is ready" is off in Settings > Reels, so nothing to do.'); return []; }
  let list = await published(sess);
  const unscored = list.filter((s) => s.importance == null && s.post_text && Date.now() - Date.parse(s.first_seen) < MAX_AGE_MS).slice(0, 5).map((s) => s.id);
  if (unscored.length) { try { await fn(sess, "reel", { action: "score", ids: unscored }); list = await published(sess); } catch (e) { console.log("Scoring skipped:", e.message); } }
  return choose(list, rs.min_importance ?? 8);
}

async function main(mode) {
  const sess = await login();
  const list = await candidates(sess);
  console.log(`Important stories waiting for a reel: ${list.length}`);
  if (mode === "check") return out("has_work", list.length ? "true" : "false");

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  await ctx.addInitScript((s) => { try { localStorage.setItem("gn_session", JSON.stringify(s)); } catch (e) {} }, sess);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[page error]", String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text().slice(0, 200)); });
  await page.goto(SITE, { waitUntil: "load" });
  await page.waitForFunction(() => typeof makeReel === "function" && typeof loadReel === "function", null, { timeout: 60000 });
  await page.evaluate(() => loadReel());

  let fails = 0, made = 0;
  for (const s of list.slice(0, MAX_PER_RUN)) {
    console.log(`Making reel for story ${s.id}: ${String(s.headline || "").slice(0, 70)}`);
    const t0 = Date.now();
    try {
      await Promise.race([
        page.evaluate((id) => { window.__autoReel = true; return makeReel(id); }, s.id),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 15 minutes")), REEL_TIMEOUT_MS)),
      ]);
    } catch (e) { console.log("Render error:", e.message); }
    const now = (await published(sess)).find((x) => x.id === s.id);
    const st = now?.reel_status || "none";
    console.log(`  -> reel status: ${st} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (st === "published" || st === "processing") { made++; fails = 0; }
    else { fails++; if (st === "none") { try { await fn(sess, "reel", { action: "reel_fail", id: s.id, error: "GitHub runner did not finish the reel" }); } catch (e) {} } if (fails >= 2) break; }
  }
  await browser.close();
  console.log(`Done. Reels posted this run: ${made}`);
  if (!made && fails) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] || "check").catch((e) => { console.error(e.message || e); process.exit(1); });
  }
