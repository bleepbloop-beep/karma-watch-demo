#!/usr/bin/env node
/**
 * Karma Watch — keyword/subreddit discovery via the last30days skill
 *
 * Separate from scan.js (which watches your *configured* monitors every 15
 * min). This one runs 1-2x/day, asks last30days for recent Reddit discussion
 * around the topics in QUERIES below, and writes the results into a
 * dedicated "Keyword Discovery (last30days)" monitor so they show up in the
 * dashboard for you to review and mine for new keywords/subreddits to add
 * to the real monitors.
 *
 * Usage:  node discover-keywords.js
 * Config: reuses scanner/config.json (same Supabase creds as scan.js).
 *
 * Requires Node 18+, python3, and the last30days skill installed at
 * ~/.claude/skills/last30days. Reddit search auth comes from the skill's
 * default config (~/.config/last30days/.env, OPENAI_API_KEY).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { classifyGeo, classifyCommodity } = require("./lib/classify");
const { heuristicIntent, normalizeSubreddit } = require("./lib/matching");
const { redditUrl, toIsoDate } = require("./lib/normalize");
const { fetchSubmissionById } = require("./lib/reddit");

const cfgPath = path.join(__dirname, "config.json");
if (!fs.existsSync(cfgPath)) {
  console.error("Missing config.json — copy config.example.json to config.json and fill it in.");
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch (error) {
  console.error(`Could not parse config.json: ${error.message}`);
  process.exit(1);
}
const SUPABASE_URL = cfg.SUPABASE_URL;
const SERVICE_KEY = cfg.SUPABASE_SECRET_KEY || cfg.SUPABASE_SERVICE_ROLE_KEY;
const CONFIGURED_USER_ID = String(cfg.USER_ID ?? "").trim();
const FETCH_TIMEOUT_MS = 20_000;
const fetchWithTimeout = (url, options = {}) => fetch(url, {
  ...options,
  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
});

if (!SUPABASE_URL || !SERVICE_KEY || SERVICE_KEY.includes("PASTE")) {
  console.error("Fill in SUPABASE_URL and SUPABASE_SECRET_KEY in config.json first.");
  process.exit(1);
}

const MONITOR_NAME = "Keyword Discovery (last30days)";
const LAST30DAYS_SCRIPT = path.join(os.homedir(), ".claude/skills/last30days/scripts/last30days.py");
const STATE_PATH = path.join(__dirname, ".discover-state.json");
const QUERIES_PER_RUN = 2;

// Rotates so repeated runs cover different angles over time. These are
// examples for a fictional energy retailer; replace them with your own.
const QUERIES = [
  "electricity bill switching provider complaints reddit",
  "ohmbrook power reviews complaints reddit",
  "deregulated energy market ercot pjm switch provider complaints",
  "best retail electricity provider comparison reddit",
  "commercial business electricity bill demand charge complaints reddit",
  "door to door energy sales scam switch reddit",
];

const sbHeaders = {
  apikey: SERVICE_KEY,
  ...(SERVICE_KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${SERVICE_KEY}` }),
  "Content-Type": "application/json",
};

async function sbGet(pathAndQuery) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbPost(pathAndQuery, body, prefer = "return=representation") {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${pathAndQuery}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbPatch(pathAndQuery, body) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${pathAndQuery}: ${res.status} ${await res.text()}`);
}
async function sbUpsertThread(row) {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/threads?on_conflict=monitor_id,reddit_id`,
    {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(row),
    }
  );
  if (!res.ok) throw new Error(`Supabase upsert thread: ${res.status} ${await res.text()}`);
  return res.json(); // [] if it was a duplicate, [row] if newly inserted
}

async function resolveUserId() {
  if (CONFIGURED_USER_ID) return CONFIGURED_USER_ID;

  const monitors = await sbGet("monitors?select=user_id&user_id=not.is.null&limit=1000");
  const userIds = [...new Set(monitors.map((monitor) => monitor.user_id).filter(Boolean))];
  if (userIds.length === 1) return userIds[0];
  if (userIds.length === 0) {
    throw new Error("No monitor owner found. Add USER_ID to config.json before running discovery.");
  }
  throw new Error("Multiple monitor owners found. Add USER_ID to config.json so discovery writes to the correct account.");
}

async function getOrCreateDiscoveryMonitor(userId) {
  const existing = await sbGet(`monitors?name=eq.${encodeURIComponent(MONITOR_NAME)}&user_id=eq.${encodeURIComponent(userId)}&select=*`);
  if (existing.length > 0) return existing[0];
  const [created] = await sbPost("monitors", {
    user_id: userId,
    name: MONITOR_NAME,
    type: "industry",
    keywords: [],
    subreddits: [],
    active: true,
    email_alerts: false,
  });
  return created;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { index: 0 };
  }
}
function saveState(state) {
  const temporaryPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`);
  fs.renameSync(temporaryPath, STATE_PATH);
}

function nextQueries() {
  const state = loadState();
  const picked = [];
  for (let i = 0; i < QUERIES_PER_RUN; i++) {
    picked.push(QUERIES[(state.index + i) % QUERIES.length]);
  }
  state.index = (state.index + QUERIES_PER_RUN) % QUERIES.length;
  saveState(state);
  return picked;
}

function runLast30days(topic) {
  const args = ["--search", "reddit", "--emit", "json", "--quick", "--no-native-web", topic];
  const out = execFileSync("python3", [LAST30DAYS_SCRIPT, ...args], {
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function redditIdFromUrl(url) {
  // Matches both .../comments/<id>/<slug>/ and bare .../comments/<id>
  const m = String(url).match(/\/comments\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

function subredditFromUrl(url) {
  const match = String(url).match(/\/r\/([^/]+)/i);
  return normalizeSubreddit(match?.[1]);
}

async function main() {
  const started = Date.now();
  if (!fs.existsSync(LAST30DAYS_SCRIPT)) {
    throw new Error(`last30days script not found at ${LAST30DAYS_SCRIPT}`);
  }
  const userId = await resolveUserId();
  const monitor = await getOrCreateDiscoveryMonitor(userId);
  const queries = nextQueries();
  console.log(`Discovery run — monitor ${monitor.id}, queries: ${queries.join(" | ")}`);

  let inserted = 0;
  let skipped = 0;
  let successfulQueries = 0;

  for (const topic of queries) {
    let result;
    try {
      result = runLast30days(topic);
    } catch (e) {
      console.warn(`  "${topic}": last30days failed — ${String(e.message ?? e).slice(0, 200)}`);
      continue;
    }
    const items = Array.isArray(result?.reddit) ? result.reddit : [];
    successfulQueries++;
    console.log(`  "${topic}": ${items.length} Reddit result(s)`);

    for (const item of items.filter(Boolean)) {
      const redditId = redditIdFromUrl(item.url);
      if (!redditId) {
        skipped++;
        continue;
      }
      const subreddit = normalizeSubreddit(item.subreddit) || subredditFromUrl(item.url) || "unknown";
      const canonicalUrl = redditUrl(item.url, subreddit === "unknown" ? null : subreddit, redditId);
      if (!canonicalUrl) {
        skipped++;
        continue;
      }
      const text = `${item.title} ${item.why_relevant ?? ""}`;
      const geo = classifyGeo(subreddit);
      let createdUtc = toIsoDate(item.date);
      if (!createdUtc) {
        const submission = await fetchSubmissionById(redditId);
        createdUtc = toIsoDate(submission?.created_utc, { unixSeconds: true });
      }
      const row = {
        monitor_id: monitor.id,
        user_id: monitor.user_id,
        reddit_id: redditId,
        subreddit,
        title: item.title ?? "(untitled)",
        body: item.why_relevant ?? null,
        url: canonicalUrl,
        matched_keyword: topic,
        upvotes: 0,
        num_comments: 0,
        intent: heuristicIntent(text),
        created_utc: createdUtc,
        us_state: geo.us_state,
        geo_location: geo.geo_location,
        energy_market: geo.energy_market,
        country: geo.country,
        commodity: classifyCommodity(text),
      };
      const rows = await sbUpsertThread(row);
      if (rows.length > 0) inserted++;
    }
  }

  if (successfulQueries > 0) {
    await sbPatch(`monitors?id=eq.${encodeURIComponent(monitor.id)}`, { last_scanned_at: new Date().toISOString() });
  } else {
    console.warn("Discovery sources all failed; last_scanned_at was not changed.");
  }

  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${inserted} new thread(s) found` +
      (skipped ? `, ${skipped} skipped (no parseable reddit id)` : "")
  );
}

main().catch((e) => {
  console.error("Discovery run failed:", e.message);
  process.exit(1);
});
