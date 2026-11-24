#!/usr/bin/env node
/**
 * Karma Watch — local Reddit scanner
 *
 * Reads your active monitors from Supabase, fetches recent posts for each
 * tracked subreddit from the PullPush archive, matches your keywords, dedupes,
 * classifies intent, and writes matches into the same database the Karma Watch
 * dashboard reads. It does not call Reddit's own endpoints.
 *
 * Usage:  node scan.js
 * Config: copy config.example.json -> config.json and fill in your keys.
 *
 * Requires Node 18+ (for built-in fetch). No npm install needed.
 */

const fs = require("fs");
const path = require("path");
const { classifyGeo, classifyCommodity } = require("./lib/classify");
const { findMatchedKeyword, heuristicIntent, normalizeSubreddit } = require("./lib/matching");
const { redditUrl, toIsoDate } = require("./lib/normalize");

// ---- load config ----
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
const ANTHROPIC_KEY = cfg.ANTHROPIC_API_KEY || "";
const UA = "KarmaWatch/1.0 (keyword monitoring)";
const FETCH_TIMEOUT_MS = 20_000;
const BLOCKED_SUBREDDITS = new Set(["scams", "samsclub"]); // noisy for this vertical
const fetchWithTimeout = (url, options = {}, timeout = FETCH_TIMEOUT_MS) => fetch(url, {
  ...options,
  signal: AbortSignal.timeout(timeout),
});

if (!SUPABASE_URL || !SERVICE_KEY || SERVICE_KEY.includes("PASTE")) {
  console.error("Fill in SUPABASE_URL and SUPABASE_SECRET_KEY in config.json first.");
  process.exit(1);
}

const sbHeaders = {
  apikey: SERVICE_KEY,
  ...(SERVICE_KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${SERVICE_KEY}` }),
  "Content-Type": "application/json",
};

// ---- supabase REST helpers ----
async function sbGet(pathAndQuery) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${res.status} ${await res.text()}`);
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
  // ignore-duplicates so re-scans don't error on the unique (monitor_id, reddit_id)
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

// ---- posts (via PullPush, a third-party archive of public submissions) ----
async function fetchSubreddit(sub) {
  const clean = normalizeSubreddit(sub);
  if (!clean || !/^[a-z0-9_]{2,21}$/i.test(clean) || BLOCKED_SUBREDDITS.has(clean)) {
    return { posts: [], ok: false, error: "invalid or blocked subreddit" };
  }
  const url = `https://api.pullpush.io/reddit/search/submission/?subreddit=${encodeURIComponent(clean)}&size=100&sort=desc&sort_type=created_utc`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`  r/${clean}: HTTP ${res.status}`);
      return { posts: [], ok: false, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const posts = (Array.isArray(json?.data) ? json.data : []).map((p) => ({
      id: p.id,
      subreddit: p.subreddit,
      title: p.title ?? "",
      selftext: p.selftext ?? "",
      permalink: p.permalink ?? `/r/${p.subreddit}/comments/${p.id}/`,
      author: p.author ?? "",
      ups: p.score ?? 0,
      num_comments: p.num_comments ?? 0,
      created_utc: p.created_utc ?? 0,
      over_18: Boolean(p.over_18),
    }));
    return { posts, ok: true, error: null };
  } catch (e) {
    console.warn(`  r/${clean}: ${String(e).slice(0, 120)}`);
    return { posts: [], ok: false, error: e.message ?? String(e) };
  }
}

// ---- intent classification ----
async function classifyBatch(items) {
  const out = {};
  if (!ANTHROPIC_KEY || items.length === 0) {
    for (const it of items) out[it.id] = heuristicIntent(it.text);
    return out;
  }
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              "Classify each Reddit thread by intent. Categories: question, pain_point, buying_signal, comparison, informational, other.\nRespond ONLY with JSON mapping id to category.\n\n" +
              JSON.stringify(items.map((i) => ({ id: i.id, text: i.text.slice(0, 500) }))),
          },
        ],
      }),
    }, 30_000);
    if (!res.ok) throw new Error("api " + res.status);
    const data = await res.json();
    const text = data.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const valid = ["question", "pain_point", "buying_signal", "comparison", "informational", "other"];
    for (const it of items) {
      const v = String(parsed[it.id] ?? "").toLowerCase();
      out[it.id] = valid.includes(v) ? v : heuristicIntent(it.text);
    }
  } catch (e) {
    console.warn("  AI classify failed, using heuristics:", String(e).slice(0, 80));
    for (const it of items) out[it.id] = heuristicIntent(it.text);
  }
  return out;
}

async function classify(items) {
  const combined = {};
  const batchSize = 20;
  for (let index = 0; index < items.length; index += batchSize) {
    Object.assign(combined, await classifyBatch(items.slice(index, index + batchSize)));
  }
  return combined;
}

// ---- main ----
async function main() {
  const started = Date.now();
  const monitors = await sbGet("monitors?active=eq.true&select=*");
  console.log(`Scanning ${monitors.length} active monitor(s)…`);

  const subCache = new Map();
  const newThreads = [];
  let inserted = 0;

  for (const mon of monitors) {
    let monitorScanSucceeded = true;
    const uniqueSubreddits = [...new Set((mon.subreddits ?? []).map(normalizeSubreddit).filter(Boolean))];
    if (uniqueSubreddits.length === 0) {
      console.warn(`  ${mon.name ?? mon.id}: skipped (no valid subreddits)`);
      continue;
    }

    for (const clean of uniqueSubreddits) {
      if (!clean) continue;
      if (!subCache.has(clean)) subCache.set(clean, await fetchSubreddit(clean));
      const result = subCache.get(clean);
      if (!result.ok) monitorScanSucceeded = false;
      const posts = result.posts;
      for (const p of posts) {
        if (p.over_18 || !p.id) continue;
        const hay = `${p.title} ${p.selftext ?? ""}`;
        const matched = findMatchedKeyword(hay, mon.keywords);
        if (!matched) continue;
        const geo = classifyGeo(p.subreddit);
        const commodity = classifyCommodity(hay);
        const createdUtc = toIsoDate(p.created_utc, { unixSeconds: true });
        const url = redditUrl(p.permalink, normalizeSubreddit(p.subreddit) || clean, p.id);
        if (!createdUtc || !url) continue;
        const rows = await sbUpsertThread({
          monitor_id: mon.id,
          user_id: mon.user_id,
          reddit_id: p.id,
          subreddit: normalizeSubreddit(p.subreddit) || clean,
          title: p.title,
          body: (p.selftext ?? "").slice(0, 2000),
          url,
          author: p.author,
          upvotes: p.ups ?? 0,
          num_comments: p.num_comments ?? 0,
          matched_keyword: matched,
          created_utc: createdUtc,
          us_state: geo.us_state,
          geo_location: geo.geo_location,
          energy_market: geo.energy_market,
          country: geo.country,
          commodity,
        });
        if (rows.length > 0) {
          inserted++;
          newThreads.push({ id: rows[0].id, text: `${p.title}\n${(p.selftext ?? "").slice(0, 400)}` });
        }
      }
    }
    if (monitorScanSucceeded) {
      await sbPatch(`monitors?id=eq.${encodeURIComponent(mon.id)}`, { last_scanned_at: new Date().toISOString() });
    } else {
      console.warn(`  ${mon.name ?? mon.id}: last_scanned_at unchanged because at least one source failed`);
    }
  }

  if (newThreads.length > 0) {
    const intents = await classify(newThreads);
    for (const [id, intent] of Object.entries(intents)) {
      await sbPatch(`threads?id=eq.${encodeURIComponent(id)}`, { intent });
    }
  }

  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${inserted} new thread(s) across ${subCache.size} subreddit(s).`
  );
}

main().catch((e) => {
  console.error("Scan failed:", e.message);
  process.exit(1);
});
