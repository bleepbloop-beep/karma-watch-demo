/**
 * Turns the hand-written fictional posts into dashboard rows. Location, market,
 * commodity, country, and keyword match come from the real scanner code.
 * Intent, customer intent, recommended action, and brand tolerance are labelled
 * by hand in sample-posts.json, standing in for the AI classifier.
 */
const { classifyCommodity, classifyGeo } = require("../scanner/lib/classify");
const { findMatchedKeyword } = require("../scanner/lib/matching");
const sample = require("../demo/sample-posts.json");

function buildDemoData() {
  const monitors = new Map(sample.monitors.map((monitor) => [monitor.id, monitor]));
  const enrich = (post) => {
    const monitor = monitors.get(post.monitor_id);
    if (!monitor) throw new Error(`Unknown monitor for sample post: ${post.title}`);
    const text = `${post.title} ${post.body}`;
    const matched = findMatchedKeyword(text, monitor.keywords);
    if (!matched) throw new Error(`Sample post matches no keyword of "${monitor.name}": ${post.title}`);
    if (!monitor.subreddits.includes(post.subreddit)) throw new Error(`r/${post.subreddit} is not tracked by "${monitor.name}"`);
    return { ...post, ...classifyGeo(post.subreddit), commodity: classifyCommodity(text), matched_keyword: matched };
  };
  return { monitors: sample.monitors, threads: sample.threads.map(enrich), scan_results: sample.scan_results.map(enrich) };
}

module.exports = { buildDemoData };
