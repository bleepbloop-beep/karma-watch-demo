#!/usr/bin/env node
// Parses the built page's script and confirms required markup is present.
const vm = require("vm");
const { buildHtml } = require("./build-site");

const html = buildHtml({ url: "", key: "" });
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) throw new Error("index.html is missing its module script");
new vm.Script(`(async () => {${moduleMatch[1]}\n})()`, { filename: "dist/index.html" });

for (const fragment of ['<meta name="description"', '<main id="root"', 'rel="noopener noreferrer"']) {
  if (!html.includes(fragment)) throw new Error(`index.html is missing required fragment: ${fragment}`);
}
if (/__SUPABASE_|build:demo/.test(html)) throw new Error("A build placeholder was not replaced.");

console.log("Static checks passed.");
