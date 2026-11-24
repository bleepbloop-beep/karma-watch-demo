const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyCommodity, classifyGeo } = require("../lib/classify");

test("classifyGeo normalizes subreddit names", () => {
  assert.deepEqual(classifyGeo(" r/Houston/ "), {
    us_state: "TX",
    geo_location: "Houston, TX — ERCOT",
    energy_market: "ERCOT",
    country: "US",
  });
});

test("classifyGeo recognizes non-US subreddits", () => {
  assert.equal(classifyGeo("r/PersonalFinanceCanada").country, "CA");
});

test("classifyCommodity handles electricity, gas, both, and unknown", () => {
  assert.equal(classifyCommodity("My electricity rate is high"), "electricity");
  assert.equal(classifyCommodity("My natural gas bill is high"), "gas");
  assert.equal(classifyCommodity("electricity and natural gas supplier"), "both");
  assert.equal(classifyCommodity("water service"), "unknown");
});

