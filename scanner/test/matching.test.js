const test = require("node:test");
const assert = require("node:assert/strict");

const { findMatchedKeyword, heuristicIntent, normalizeSubreddit } = require("../lib/matching");
const { redditUrl, toIsoDate } = require("../lib/normalize");
const { fetchSubmissionById } = require("../lib/reddit");

test("keyword matching respects word boundaries", () => {
  assert.equal(findMatchedKeyword("Natural gas prices", ["gas"]), "gas");
  assert.equal(findMatchedKeyword("A trip to Las Vegas", ["gas"]), null);
  assert.equal(findMatchedKeyword("Ohmbrook's latest plan", ["ohmbrook"]), "ohmbrook");
  assert.equal(findMatchedKeyword("ratepayer notice", ["rate"]), null);
});

test("normalizes subreddit input", () => {
  assert.equal(normalizeSubreddit(" /r/Houston/ "), "houston");
});

test("heuristic intent handles empty and high-signal text", () => {
  assert.equal(heuristicIntent(null), "informational");
  assert.equal(heuristicIntent("Is this plan worth it?"), "buying_signal");
  assert.equal(heuristicIntent("This provider is terrible"), "pain_point");
});

test("date normalization rejects invalid values", () => {
  assert.equal(toIsoDate("not-a-date"), null);
  assert.equal(toIsoDate(1_700_000_000, { unixSeconds: true }), "2023-11-14T22:13:20.000Z");
});

test("Reddit URLs are restricted to HTTPS Reddit hosts", () => {
  assert.equal(redditUrl("/r/test/comments/abc/title", "test", "abc"), "https://www.reddit.com/r/test/comments/abc/title");
  assert.equal(redditUrl("javascript:alert(1)", "test", "abc"), "https://www.reddit.com/r/test/comments/abc/");
  assert.equal(redditUrl("https://example.com/post", "test", "abc"), "https://www.reddit.com/r/test/comments/abc/");
});

test("fetchSubmissionById returns matching archived Reddit metadata", async (t) => {
  const fetchImpl = t.mock.fn(async () => new Response(JSON.stringify({
    data: [{ id: "abc123", created_utc: 1_700_000_000 }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const post = await fetchSubmissionById("ABC123", { fetchImpl, retries: 0 });
  assert.equal(post.id, "abc123");
  assert.equal(post.created_utc, 1_700_000_000);
  assert.match(fetchImpl.mock.calls[0].arguments[0], /arctic-shift/);
});

test("fetchSubmissionById falls back when the primary archive is unavailable", async (t) => {
  const fetchImpl = t.mock.fn(async (url) => {
    if (url.includes("arctic-shift")) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({
      data: [{ id: "abc123", created_utc: 1_700_000_000 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const post = await fetchSubmissionById("abc123", { fetchImpl, retries: 0 });
  assert.equal(post.id, "abc123");
  assert.equal(fetchImpl.mock.calls.length, 2);
  assert.match(fetchImpl.mock.calls[1].arguments[0], /pullpush/);
});

test("fetchSubmissionById rejects malformed IDs", async () => {
  let called = false;
  const post = await fetchSubmissionById("bad/id", { fetchImpl: async () => { called = true; } });
  assert.equal(post, null);
  assert.equal(called, false);
});
