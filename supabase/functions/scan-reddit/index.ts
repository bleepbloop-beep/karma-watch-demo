import { createClient } from "jsr:@supabase/supabase-js@2";

const SERVICE_KEY = Deno.env.get("KARMA_WATCH_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY);
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const UA = { "User-Agent": "KarmaWatch/1.0 (keyword monitoring)" };
let startedAt = Date.now();
const BUDGET_MS = 100000;
function timeLeft() { return BUDGET_MS - (Date.now() - startedAt); }

// Run async tasks with bounded concurrency so we don't burst-trigger the free
// archive APIs' own rate limiters (fast, but polite).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

// Rotate array order based on the current 15-min cron bucket so that, across
// consecutive scan cycles, every subreddit/keyword eventually gets first crack
// at the time budget instead of the same first N always winning.
function rotateForFairness<T>(arr: T[]): T[] {
  if (arr.length === 0) return arr;
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const offset = bucket % arr.length;
  return [...arr.slice(offset), ...arr.slice(0, offset)];
}

type Post = { id: string; subreddit: string; title: string; selftext: string; permalink: string; author: string; ups: number; num_comments: number; created_utc: number; over_18: boolean; kind: string; };
type Fields = { intent: string; geo_location: string; us_state: string; energy_market: string; commodity: string; customer_intent: string; recommended_action: string; brand_tolerance: string; country: string; };

let diag: Record<string, string> = {};
let sourceCounts = { pullpush: 0, arctic: 0 };
const SUB_BLOCKLIST = new Set(["scams","samsclub"]);

function mapPosts(arr: any[]): Post[] {
  return (arr ?? []).map((p: any) => ({ id: p.id, subreddit: p.subreddit, title: p.title ?? "", selftext: p.selftext ?? "", permalink: p.permalink ?? `/r/${p.subreddit}/comments/${p.id}/`, author: p.author ?? "", ups: p.score ?? 0, num_comments: p.num_comments ?? 0, created_utc: p.created_utc ?? 0, over_18: !!p.over_18, kind: "post" }));
}
function mapComments(arr: any[]): Post[] {
  return (arr ?? []).map((c: any) => {
    const linkId = String(c.link_id ?? "").replace(/^t3_/, "");
    const body = c.body ?? "";
    return { id: c.id, subreddit: c.subreddit, title: "💬 " + body.slice(0, 90), selftext: body, permalink: c.permalink ?? `/r/${c.subreddit}/comments/${linkId}/comment/${c.id}/`, author: c.author ?? "", ups: c.score ?? 0, num_comments: 0, created_utc: c.created_utc ?? 0, over_18: false, kind: "comment" };
  });
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: UA, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fromPullPush(sub: string): Promise<Post[]> {
  const res = await fetchWithTimeout(`https://api.pullpush.io/reddit/search/submission/?subreddit=${encodeURIComponent(sub)}&size=100&sort=desc&sort_type=created_utc`, 12000);
  if (!res.ok) throw new Error(`pullpush ${res.status}`);
  return mapPosts((await res.json())?.data);
}
async function fromArcticShift(sub: string): Promise<Post[]> {
  const res = await fetchWithTimeout(`https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=100&sort=desc`, 12000);
  if (!res.ok) throw new Error(`arctic ${res.status}`);
  return mapPosts((await res.json())?.data);
}
async function fetchSubreddit(sub: string): Promise<Post[]> {
  const clean = String(sub).replace(/^r\//i, "").trim();
  try { const p = await fromPullPush(clean); diag[clean] = `pullpush ${p.length}`; if (p.length) { sourceCounts.pullpush++; return p; } } catch (e) { diag[clean] = `pullpush err ${String(e).slice(0,40)}`; }
  try { const p = await fromArcticShift(clean); diag[clean] = (diag[clean]??"") + ` | arctic ${p.length}`; if (p.length) sourceCounts.arctic++; return p; } catch (e) { diag[clean] = (diag[clean]??"") + ` | arctic err ${String(e).slice(0,40)}`; return []; }
}

const CONCURRENCY = 4;

async function searchPosts(mon: any): Promise<Post[]> {
  const results = new Map<string, Post>();
  const keywords: string[] = mon.keywords ?? [];
  const ppResults = await mapLimit(keywords, CONCURRENCY, async (kw) => {
    try {
      const res = await fetchWithTimeout(`https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(kw)}&size=100&sort=desc&sort_type=created_utc`, 10000);
      if (res.ok) { const p = mapPosts((await res.json())?.data); diag[`pp-post:${kw}`] = `${p.length}`; if (p.length) sourceCounts.pullpush++; return p; }
      diag[`pp-post:${kw}`] = `${res.status}`; return [] as Post[];
    } catch { diag[`pp-post:${kw}`] = `err`; return [] as Post[]; }
  });
  for (const arr of ppResults) for (const x of arr) results.set(x.id, x);
  if (results.size > 0) return [...results.values()];

  const orQ = keywords.map((k) => `\"${k}\"`).join(" OR ");
  const subs = rotateForFairness<string>((mon.subreddits ?? []).map((s: string) => String(s).replace(/^r\//i, "").trim().toLowerCase()).filter((s: string) => s && !SUB_BLOCKLIST.has(s)));
  const asResults = await mapLimit(subs, CONCURRENCY, async (clean: string) => {
    try {
      const res = await fetchWithTimeout(`https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(clean)}&query=${encodeURIComponent(orQ)}&limit=100&sort=desc`, 10000);
      if (res.ok) { const p = mapPosts((await res.json())?.data); diag[`as-post:${clean}`] = `${p.length}`; if (p.length) { sourceCounts.arctic++; return p; } }
      else diag[`as-post:${clean}`] = `${res.status}`;
    } catch { diag[`as-post:${clean}`] = `err`; }
    return [] as Post[];
  });
  for (const arr of asResults) for (const x of arr) results.set(x.id, x);
  return [...results.values()];
}
async function searchComments(mon: any): Promise<Post[]> {
  const results = new Map<string, Post>();
  const keywords: string[] = mon.keywords ?? [];
  const ppResults = await mapLimit(keywords, CONCURRENCY, async (kw) => {
    try {
      const res = await fetchWithTimeout(`https://api.pullpush.io/reddit/search/comment/?q=${encodeURIComponent(kw)}&size=100&sort=desc&sort_type=created_utc`, 10000);
      if (res.ok) { const p = mapComments((await res.json())?.data); diag[`pp-cmt:${kw}`] = `${p.length}`; if (p.length) sourceCounts.pullpush++; return p; }
      diag[`pp-cmt:${kw}`] = `${res.status}`; return [] as Post[];
    } catch { diag[`pp-cmt:${kw}`] = `err`; return [] as Post[]; }
  });
  for (const arr of ppResults) for (const x of arr) results.set(x.id, x);
  if (results.size > 0) return [...results.values()];

  const orQ = keywords.map((k) => `\"${k}\"`).join(" OR ");
  const subs = rotateForFairness<string>((mon.subreddits ?? []).map((s: string) => String(s).replace(/^r\//i, "").trim().toLowerCase()).filter((s: string) => s && !SUB_BLOCKLIST.has(s)));
  const asResults = await mapLimit(subs, CONCURRENCY, async (clean: string) => {
    try {
      const res = await fetchWithTimeout(`https://arctic-shift.photon-reddit.com/api/comments/search?subreddit=${encodeURIComponent(clean)}&body=${encodeURIComponent(orQ)}&limit=100&sort=desc`, 10000);
      if (res.ok) { const p = mapComments((await res.json())?.data); diag[`as-cmt:${clean}`] = `${p.length}`; if (p.length) { sourceCounts.arctic++; return p; } }
      else diag[`as-cmt:${clean}`] = `${res.status}`;
    } catch { diag[`as-cmt:${clean}`] = `err`; }
    return [] as Post[];
  });
  for (const arr of asResults) for (const x of arr) results.set(x.id, x);
  return [...results.values()];
}

const STATES: Record<string,string> = { alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY" };
const DEREG: Record<string,string> = { TX:"ERCOT", PA:"PJM", OH:"PJM", IL:"PJM/MISO", NJ:"PJM", MD:"PJM", DE:"PJM", NY:"NYISO", ME:"ISO-NE", NH:"ISO-NE", MA:"ISO-NE", RI:"ISO-NE", CT:"ISO-NE", MI:"MISO" };
function detectCountry(t: string): string {
  if (/[£€]|\bofgem\b|\bnational grid\b|british gas|octopus energy|\bpostcode\b|\bcouncil\b|\bquid\b|\bpence\b|standing charge|moneysavingexpert/i.test(t)) return "UK";
  if (/\b(bc hydro|hydro one|ontario|quebec|alberta|enbridge|loonie)\b/i.test(t)) return "CA";
  if (/\b(euro|germany|france|spain|netherlands|ireland|europe)\b/i.test(t)) return "EU";
  return "US";
}
function heuristic(text: string): Fields {
  const t = text.toLowerCase();
  let intent = "informational";
  if (/\b(vs\.?|versus|alternative to|compared? to|better than)\b/.test(t)) intent = "comparison";
  else if (/\b(frustrat|annoy|hate|sucks?|paywall|scam|disappoint|terrible|awful|tired of|ripoff|rip off)\b/.test(t)) intent = "pain_point";
  else if (/\b(worth (it|switching)|should i (switch|sign|lock)|cheapest|best rate|lowest rate)\b/.test(t)) intent = "buying_signal";
  else if (/\?|^(how|what|which|where|why|can i|does anyone)/m.test(t)) intent = "question";
  let us_state = ""; let loc = "Unknown";
  for (const [name, ab] of Object.entries(STATES)) { if (new RegExp(`\\b${name}\\b`).test(t)) { us_state = ab; break; } }
  const market = us_state ? (DEREG[us_state] ?? "Regulated") : "Unknown";
  if (us_state) loc = `${us_state}${DEREG[us_state] ? " — " + DEREG[us_state] : ""}`;
  const elec = /\b(electric|electricity|kwh|power company|power bill|retail electric)\b/.test(t);
  const gas = /\b(natural gas|gas bill|therm|gas company|gas supplier)\b/.test(t);
  const commodity = elec && gas ? "both" : elec ? "electricity" : gas ? "gas" : "unknown";
  let ci = "research";
  if (/\b(bill|billing|charge|overcharge|refund|deposit|late fee)\b/.test(t)) ci = "billing";
  else if (/\b(scam|fraud|lied|misled|terrible|worst|complaint|ripoff)\b/.test(t)) ci = "complaint";
  else if (/\b(myth|not true|actually|misinformation|false)\b/.test(t)) ci = "misinformation";
  let action = "monitor";
  if (ci === "complaint" || ci === "billing") action = "escalate";
  else if (intent === "question" || intent === "buying_signal") action = "respond";
  else if (intent === "comparison") action = "seo_insight";
  return { intent, geo_location: loc, us_state, energy_market: market, commodity, customer_intent: ci, recommended_action: action, brand_tolerance: "medium", country: detectCountry(t) };
}

const SYS = `You classify Reddit threads/comments for a US energy retailer monitoring deregulated electricity & gas markets (residential and commercial). For EACH item return a JSON object keyed by its id. Fields:\n- intent: question, pain_point, buying_signal, comparison, informational, other\n- geo_location: short display of location + market if inferable, e.g. \"Houston, TX — ERCOT\"; \"Unknown\" if not stated\n- us_state: 2-letter US state code if inferable else \"\"\n- energy_market: ERCOT, PJM, NYISO, ISO-NE, MISO, CAISO, SPP, Regulated, Unknown\n- commodity: electricity, gas, both, unknown\n- customer_intent: research, complaint, billing, misinformation, other\n- recommended_action: respond, monitor, escalate, seo_insight\n- brand_tolerance: low, medium, high\n- country: US, UK, EU, CA, or Other. Use US if clearly American.\nReturn ONLY a JSON object mapping id to fields.`;

async function callOpenAI(items: { id: string; text: string }[]): Promise<any | null> {
  if (!OPENAI_KEY) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" }, messages: [ { role: "system", content: SYS }, { role: "user", content: "Items (json):\n" + JSON.stringify(items.map(i => ({ id: i.id, text: i.text.slice(0,600) }))) } ] }) });
  if (!res.ok) throw new Error("openai " + res.status);
  return JSON.parse(((await res.json()).choices?.[0]?.message?.content ?? "{}").match(/\{[\s\S]*\}/)?.[0] ?? "{}");
}
async function callAnthropic(items: { id: string; text: string }[]): Promise<any | null> {
  if (!ANTHROPIC_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages: [{ role: "user", content: SYS + "\n\nItems:\n" + JSON.stringify(items.map(i => ({ id: i.id, text: i.text.slice(0,600) }))) }] }) });
  if (!res.ok) throw new Error("anthropic " + res.status);
  return JSON.parse(((await res.json()).content?.[0]?.text ?? "{}").match(/\{[\s\S]*\}/)?.[0] ?? "{}");
}
async function classifyChunk(items: { id: string; text: string }[]): Promise<Record<string, Fields>> {
  const out: Record<string, Fields> = {};
  if (!OPENAI_KEY && !ANTHROPIC_KEY) { for (const it of items) out[it.id] = heuristic(it.text); return out; }
  let parsed: any = null;
  try { parsed = await callOpenAI(items); } catch { parsed = null; }
  if (!parsed) { try { parsed = await callAnthropic(items); } catch { parsed = null; } }
  if (!parsed) { for (const it of items) out[it.id] = heuristic(it.text); return out; }
  for (const it of items) {
    const p = parsed[it.id];
    if (p && typeof p === "object") {
      const h = heuristic(it.text);
      const c = String(p.country ?? h.country ?? "US").toUpperCase();
      out[it.id] = { intent: p.intent ?? h.intent, geo_location: p.geo_location ?? h.geo_location, us_state: (p.us_state ?? h.us_state ?? "").toString().toUpperCase().slice(0,2), energy_market: p.energy_market ?? h.energy_market, commodity: p.commodity ?? h.commodity, customer_intent: p.customer_intent ?? h.customer_intent, recommended_action: p.recommended_action ?? h.recommended_action, brand_tolerance: p.brand_tolerance ?? h.brand_tolerance, country: ["US","UK","EU","CA","OTHER"].includes(c) ? (c === "OTHER" ? "Other" : c) : "US" };
    } else out[it.id] = heuristic(it.text);
  }
  return out;
}
async function classifyAll(items: { id: string; text: string }[]): Promise<Record<string, Fields>> {
  const out: Record<string, Fields> = {};
  const chunks: { id: string; text: string }[][] = [];
  for (let i = 0; i < items.length; i += 20) chunks.push(items.slice(i, i + 20));
  const results = await mapLimit(chunks, CONCURRENCY, (c) => classifyChunk(c));
  for (const r of results) Object.assign(out, r);
  return out;
}
async function writeFields(id: string, f: Fields) {
  await supabase.from("threads").update({ intent: f.intent, geo_location: f.geo_location, us_state: f.us_state, energy_market: f.energy_market, commodity: f.commodity, customer_intent: f.customer_intent, recommended_action: f.recommended_action, brand_tolerance: f.brand_tolerance, country: f.country }).eq("id", id);
}

// The scheduler proves itself with a shared secret and may scan every monitor.
// A signed-in user may scan only their own monitors. Everyone else is refused.
type Caller = { userId: string | null };
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
async function authorize(req: Request): Promise<Caller | null> {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (CRON_SECRET && secret && await secretsMatch(secret, CRON_SECRET)) return { userId: null };
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : { userId: data.user.id };
}
function json(body: unknown, status = 200): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type";
    headers["Access-Control-Allow-Methods"] = "POST";
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({});
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const caller = await authorize(req);
  if (!caller) return json({ error: "Not authorized" }, 401);
  const isScheduler = caller.userId === null;

  // Function instances are reused between requests, so reset per-scan state.
  startedAt = Date.now();
  diag = {};
  sourceCounts = { pullpush: 0, arctic: 0 };

  let monitorFilter: string | null = null; let debug = false; let reclassify = false;
  try { const b = await req.json(); monitorFilter = b?.monitor_id ?? null; debug = isScheduler && !!b?.debug; reclassify = isScheduler && !!b?.reclassify; } catch { /**/ }

  if (reclassify) {
    const { data: rows } = await supabase.from("threads").select("id,title,body").is("country", null).limit(200);
    const items = (rows ?? []).map((r: any) => ({ id: r.id, text: `${r.title}\n${(r.body ?? "").slice(0,400)}` }));
    const fields = await classifyAll(items);
    for (const [id, f] of Object.entries(fields)) await writeFields(id, f);
    return json({ reclassified: items.length, classifier: OPENAI_KEY ? "openai" : (ANTHROPIC_KEY ? "anthropic" : "heuristic") });
  }

  let query = supabase.from("monitors").select("*").eq("active", true);
  if (caller.userId) query = query.eq("user_id", caller.userId);
  if (monitorFilter) query = query.eq("id", monitorFilter);
  const { data: monitors, error } = await query;
  if (error) { console.error(error.message); return json({ error: "Could not load monitors" }, 500); }

  const subCache = new Map<string, Post[]>();
  const newThreads: { id: string; text: string }[] = [];
  let inserted = 0; let skippedNsfw = 0; let comments = 0; let skippedBudget = 0;

  async function ingest(mon: any, posts: Post[], matchByKeyword: boolean) {
    for (const p of posts) {
      if (p.over_18) { skippedNsfw++; continue; }
      if (SUB_BLOCKLIST.has(String(p.subreddit).toLowerCase())) continue;
      const hay = `${p.title} ${p.selftext ?? ""}`.toLowerCase();
      const matched = (mon.keywords ?? []).find((k: string) => hay.includes(String(k).toLowerCase()));
      if (matchByKeyword && !matched) continue;
      const { data: ins, error: insErr } = await supabase.from("threads").upsert({ monitor_id: mon.id, user_id: mon.user_id, reddit_id: p.id, subreddit: p.subreddit, title: p.title, body: (p.selftext ?? "").slice(0, 2000), url: `https://www.reddit.com${p.permalink}`, author: p.author, upvotes: p.ups ?? 0, num_comments: p.num_comments ?? 0, matched_keyword: matched ?? null, created_utc: new Date((p.created_utc ?? 0) * 1000).toISOString() }, { onConflict: "monitor_id,reddit_id", ignoreDuplicates: true }).select("id");
      if (!insErr && ins && ins.length > 0) { inserted++; if (p.kind === "comment") comments++; newThreads.push({ id: ins[0].id, text: `${p.title}\n${(p.selftext ?? "").slice(0, 400)}` }); if (mon.email_alerts) await supabase.from("alert_log").insert({ user_id: mon.user_id, thread_id: ins[0].id, channel: "email", status: "pending" }); }
    }
  }

  for (const mon of monitors ?? []) {
    if (timeLeft() < 15000) { skippedBudget++; continue; }
    if (mon.search_mode) {
      await ingest(mon, await searchPosts(mon), true);
      if (timeLeft() > 15000) await ingest(mon, await searchComments(mon), true);
    } else {
      const cleanSubs = rotateForFairness<string>((mon.subreddits ?? []).map((s: string) => String(s).replace(/^r\//i, "").trim().toLowerCase()).filter((s: string) => s && !SUB_BLOCKLIST.has(s)));
      const toFetch = cleanSubs.filter((s: string) => !subCache.has(s));
      const fetched = await mapLimit(toFetch, CONCURRENCY, (s: string) => fetchSubreddit(s));
      toFetch.forEach((s: string, i: number) => subCache.set(s, fetched[i]));
      for (const s of cleanSubs) await ingest(mon, subCache.get(s) ?? [], true);
    }
    await supabase.from("monitors").update({ last_scanned_at: new Date().toISOString() }).eq("id", mon.id);
  }

  if (newThreads.length > 0) {
    const fields = await classifyAll(newThreads);
    for (const [id, f] of Object.entries(fields)) await writeFields(id, f);
  }

  const payload: Record<string, unknown> = { monitors_scanned: (monitors?.length ?? 0) - skippedBudget, monitors_deferred: skippedBudget, new_threads: inserted, new_comments: comments, skipped_nsfw: skippedNsfw, source: "pullpush+arctic", source_breakdown: sourceCounts, classifier: OPENAI_KEY ? "openai" : (ANTHROPIC_KEY ? "anthropic" : "heuristic"), elapsed_ms: Date.now() - startedAt };
  if (debug) payload.diag = diag;
  return json(payload);
});
