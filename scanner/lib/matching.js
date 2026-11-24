function normalizeSubreddit(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/?r\//i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function isWordCharacter(character) {
  return character != null && /[a-z0-9]/i.test(character);
}

function findMatchedKeyword(text, keywords) {
  const haystack = String(text ?? "").toLowerCase();
  for (const rawKeyword of keywords ?? []) {
    const keyword = String(rawKeyword ?? "").trim().toLowerCase();
    if (!keyword) continue;

    let index = haystack.indexOf(keyword);
    while (index !== -1) {
      const before = haystack[index - 1];
      const after = haystack[index + keyword.length];
      const startIsValid = !isWordCharacter(keyword[0]) || !isWordCharacter(before);
      const endIsValid = !isWordCharacter(keyword[keyword.length - 1]) || !isWordCharacter(after);
      if (startIsValid && endIsValid) return String(rawKeyword).trim();
      index = haystack.indexOf(keyword, index + 1);
    }
  }
  return null;
}

function heuristicIntent(text) {
  const value = String(text ?? "").toLowerCase();
  if (/\b(vs\.?|versus|alternative to|compared? to|better than)\b/.test(value)) return "comparison";
  if (/\b(frustrat|annoy|hate|sucks?|paywall|scam|disappoint|terrible|awful|tired of)\b/.test(value)) return "pain_point";
  if (/\b(worth (it|buying)|should i (buy|get|pay)|discount|pricing|is it worth)\b/.test(value)) return "buying_signal";
  if (/\?|^(how|what|which|where|why|can i|does anyone|any recommend|best )/m.test(value) || /\b(recommend|suggest|looking for|best app|best way)\b/.test(value)) return "question";
  return "informational";
}

module.exports = { findMatchedKeyword, heuristicIntent, normalizeSubreddit };

