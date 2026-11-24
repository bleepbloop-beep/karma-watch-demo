#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { fetchSubmissionById } = require("./lib/reddit");
const { toIsoDate } = require("./lib/normalize");

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const serviceKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;

if (!config.SUPABASE_URL || !serviceKey) {
  console.error("Fill in SUPABASE_URL and SUPABASE_SECRET_KEY in config.json first.");
  process.exit(1);
}

const headers = {
  apikey: serviceKey,
  ...(serviceKey.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${serviceKey}` }),
  "Content-Type": "application/json",
};

async function supabase(pathAndQuery, options = {}) {
  const response = await fetch(`${config.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const rows = await supabase("threads?created_utc=is.null&reddit_id=not.is.null&select=id,reddit_id&limit=1000");
  console.log(`Repairing ${rows.length} thread(s) with missing Reddit post dates…`);

  let repaired = 0;
  let unresolved = 0;
  for (const row of rows) {
    const post = await fetchSubmissionById(row.reddit_id);
    const createdUtc = toIsoDate(post?.created_utc, { unixSeconds: true });
    if (!createdUtc) {
      unresolved++;
      continue;
    }
    await supabase(`threads?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ created_utc: createdUtc }),
    });
    repaired++;
  }

  console.log(`Post-date repair complete — ${repaired} repaired, ${unresolved} unresolved.`);
}

main().catch((error) => {
  console.error("Post-date repair failed:", error.message);
  process.exit(1);
});

