function toIsoDate(value, { unixSeconds = false } = {}) {
  if (value == null || value === "") return null;
  const normalized = unixSeconds && Number.isFinite(Number(value)) ? Number(value) * 1000 : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function redditUrl(value, subreddit, redditId) {
  try {
    const url = new URL(String(value ?? ""), "https://www.reddit.com");
    const host = url.hostname.toLowerCase();
    if (url.protocol === "https:" && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
      return url.href;
    }
  } catch {
    // Fall through to a canonical Reddit URL.
  }

  if (!subreddit || !redditId) return null;
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${encodeURIComponent(redditId)}/`;
}

module.exports = { redditUrl, toIsoDate };

