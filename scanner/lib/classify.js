/**
 * Subreddit -> geo/energy-market lookup, and text -> commodity classifier.
 *
 * No AI key needed — this is what fills in us_state/geo_location/energy_market/
 * commodity/country for threads found by scan.js and discover-keywords.js.
 *
 * Deliberately a static table over the subreddits actually in play (monitor
 * lists + subreddits discover-keywords.js has turned up). Unknown subreddits
 * fall through with everything null rather than guessing.
 */

const STATE_BY_SUBREDDIT = {
  texas: "TX", houston: "TX", askhouston: "TX", dallas: "TX", fortworth: "TX",
  austin: "TX", sanantonio: "TX", corpuschristi: "TX", corpus: "TX",
  riograndevalley: "TX", templetx: "TX", hutto: "TX", arlington: "TX",
  askdfw: "TX", texasenergyshopping: "TX", texassolar: "TX",

  pennsylvania: "PA", philadelphia: "PA", philly: "PA", pittsburgh: "PA",
  ohio: "OH", columbus: "OH", cleveland: "OH",
  newjersey: "NJ",
  illinois: "IL", chicago: "IL",
  newyork: "NY", nyc: "NY",
  massachusetts: "MA", boston: "MA",
  connecticut: "CT",
  michigan: "MI",
  maryland: "MD", baltimore: "MD",
  washingtondc: "DC",
};

const CITY_BY_SUBREDDIT = {
  houston: "Houston, TX", askhouston: "Houston, TX", dallas: "Dallas, TX",
  fortworth: "Fort Worth, TX", austin: "Austin, TX", sanantonio: "San Antonio, TX",
  corpuschristi: "Corpus Christi, TX", corpus: "Corpus Christi, TX",
  riograndevalley: "Rio Grande Valley, TX", templetx: "Temple, TX", hutto: "Hutto, TX",
  arlington: "Arlington, TX", askdfw: "Dallas–Fort Worth, TX",
  philadelphia: "Philadelphia, PA", philly: "Philadelphia, PA", pittsburgh: "Pittsburgh, PA",
  columbus: "Columbus, OH", cleveland: "Cleveland, OH",
  chicago: "Chicago, IL", nyc: "New York, NY", boston: "Boston, MA",
  baltimore: "Baltimore, MD", washingtondc: "Washington, DC",
};

// Simplified — good enough for a heuristic tag, not a utility-territory lookup.
const MARKET_BY_STATE = {
  TX: "ERCOT", PA: "PJM", OH: "PJM", NJ: "PJM", IL: "PJM (ComEd)",
  NY: "NYISO", MA: "ISO-NE", CT: "ISO-NE", MI: "MISO", MD: "PJM", DC: "PJM",
};

// Subreddits that are clearly non-US, so they get excluded from US-market
// views (dashboard filters out any thread whose country is in NON_US).
const NON_US_BY_SUBREDDIT = {
  germany: "EU", de: "EU", europe: "EU",
  uk: "UK", askuk: "UK", ukpersonalfinance: "UK", unitedkingdom: "UK",
  canada: "CA", personalfinancecanada: "CA", montreal: "CA", askquebec: "CA", quebec: "CA",
};

function classifyGeo(subreddit) {
  const key = String(subreddit || "")
    .trim()
    .toLowerCase()
    .replace(/^\/?r\//, "")
    .replace(/^\/+|\/+$/g, "");

  const nonUs = NON_US_BY_SUBREDDIT[key];
  if (nonUs) {
    return { us_state: null, geo_location: null, energy_market: null, country: nonUs };
  }

  const state = STATE_BY_SUBREDDIT[key];
  if (!state) {
    return { us_state: null, geo_location: null, energy_market: null, country: null };
  }

  const market = MARKET_BY_STATE[state];
  const city = CITY_BY_SUBREDDIT[key];
  const geo_location = market ? `${city || state} — ${market}` : (city || state);
  return { us_state: state, geo_location, energy_market: market, country: "US" };
}

const ELECTRICITY_TERMS = /\b(electric(?:ity)?|kwh|kw\/h|power bill|power company|ercot|kilowatt)\b/i;
const GAS_TERMS = /\b(natural gas|gas bill|gas supplier|gas company|\btherm(s)?\b|propane)\b/i;

function classifyCommodity(text) {
  const t = String(text || "");
  const hasElectricity = ELECTRICITY_TERMS.test(t);
  const hasGas = GAS_TERMS.test(t);
  if (hasElectricity && hasGas) return "both";
  if (hasElectricity) return "electricity";
  if (hasGas) return "gas";
  return "unknown";
}

module.exports = { classifyGeo, classifyCommodity };
