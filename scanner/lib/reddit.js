const USER_AGENT = "KarmaWatch/1.0 (Reddit metadata lookup)";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchSubmissionById(redditId, options = {}) {
  const id = String(redditId ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(id)) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 600;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sources = [
    `https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${encodeURIComponent(id)}`,
    `https://api.pullpush.io/reddit/search/submission/?ids=${encodeURIComponent(id)}`,
  ];

  for (const url of sources) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          const payload = await response.json();
          const match = (Array.isArray(payload?.data) ? payload.data : []).find(
            (post) => String(post?.id ?? "").toLowerCase() === id
          );
          if (match) return match;
          break;
        }
        if (response.status !== 429 && response.status < 500) break;
      } catch {
        // Retry transient network failures below.
      }
      if (attempt < retries && retryDelayMs > 0) await delay(retryDelayMs * (attempt + 1));
    }
  }
  return null;
}

module.exports = { fetchSubmissionById };
