const test = require("node:test");
const assert = require("node:assert/strict");

const { createDemoClient } = require("../../demo/client");
const { buildDemoData } = require("../../scripts/demo-data");
const { buildHtml, readConfig } = require("../../scripts/build-site");

test("every sample post passes through the real matcher and classifier", () => {
  const data = buildDemoData();
  assert.ok(data.threads.length >= 20);
  for (const thread of data.threads) assert.ok(thread.matched_keyword && thread.commodity);
  assert.equal(data.threads.find((thread) => thread.subreddit === "houston").energy_market, "ERCOT");
});

test("demo threads never link to a real Reddit post", async () => {
  const { data } = await createDemoClient(buildDemoData()).from("threads").select("*");
  assert.ok(data.every((thread) => thread.url === null));
});

test("demo client sorts, limits, updates, and cascades deletes", async () => {
  const client = createDemoClient(buildDemoData());
  const { data: top } = await client.from("threads").select("*").order("created_utc", { ascending: false }).limit(2);
  assert.equal(top.length, 2);
  assert.ok(top[0].created_utc >= top[1].created_utc);

  await client.from("threads").update({ status: "read" }).eq("id", top[0].id);
  const { data: read } = await client.from("threads").select("*").eq("status", "read");
  assert.deepEqual(read.map((thread) => thread.id), [top[0].id]);

  await client.from("monitors").delete().eq("id", "mon-comp");
  const { data: orphans } = await client.from("threads").select("*").eq("monitor_id", "mon-comp");
  assert.equal(orphans.length, 0);
});

test("demo scan reveals queued posts and then runs out", async () => {
  const client = createDemoClient(buildDemoData());
  assert.match(await client.demoScan(), /2 new sample threads/);
  assert.match(await client.demoScan(), /2 new sample threads/);
  assert.match(await client.demoScan(), /no new sample threads/);
});

test("build rejects secret, legacy, and incomplete credentials", () => {
  const url = "https://example.supabase.co";
  assert.throws(() => readConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: "sb_secret_x" }), /sb_publishable_/);
  assert.throws(() => readConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: "eyJhbGciOi.x.y" }), /sb_publishable_/);
  assert.throws(() => readConfig({ SUPABASE_URL: url }), /both/);
  assert.deepEqual(readConfig({}), { url: "", key: "" });
});

test("demo build contains no database address or key", () => {
  assert.doesNotMatch(buildHtml({ url: "", key: "" }), /[a-z]{20}\.supabase\.co|sb_publishable_/);
});
