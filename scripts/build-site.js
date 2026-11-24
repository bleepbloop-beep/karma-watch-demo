#!/usr/bin/env node
/**
 * Builds dist/index.html, the only file that is ever deployed.
 *
 *   npm run build        uses SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY if set
 *   npm run build:demo   ignores them, so the result cannot reach a database
 */
const fs = require("fs");
const path = require("path");
const { buildDemoData } = require("./demo-data");

const root = path.resolve(__dirname, "..");
const PRIVATE_CREDENTIAL = /SUPABASE_SERVICE_ROLE_KEY|\bservice_role\b|sb_secret_|sk-ant-|sk-proj-/i;

function readConfig(env) {
  const url = (env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (Boolean(url) !== Boolean(key)) throw new Error("Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, or neither.");
  if (url && new URL(url).protocol !== "https:") throw new Error("SUPABASE_URL must use https.");
  // An allowlist: secret keys and legacy JWT keys are both rejected.
  if (key && !key.startsWith("sb_publishable_")) throw new Error("SUPABASE_PUBLISHABLE_KEY must start with sb_publishable_.");
  return { url, key };
}

function replaceOnce(html, marker, value) {
  if (html.split(marker).length !== 2) throw new Error(`Expected exactly one ${marker} in index.html`);
  return html.replace(marker, () => value);
}

// Escaping "<" keeps any text in the data from closing the script tag.
const inlineJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

function buildHtml({ url, key }) {
  let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  html = replaceOnce(html, '"__SUPABASE_URL__"', inlineJson(url));
  html = replaceOnce(html, '"__SUPABASE_PUBLISHABLE_KEY__"', inlineJson(key));
  html = replaceOnce(html, "null; /* build:demo-data */", `${inlineJson(buildDemoData())};`);
  html = replaceOnce(html, "/* build:demo-client */", fs.readFileSync(path.join(root, "demo", "client.js"), "utf8"));
  if (PRIVATE_CREDENTIAL.test(html)) throw new Error("Refusing to build: the page appears to contain a private credential.");
  return html;
}

if (require.main === module) {
  const config = process.argv.includes("--demo") ? { url: "", key: "" } : readConfig(process.env);
  const html = buildHtml(config);
  const outputDir = path.join(root, "dist");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "index.html"), html);
  console.log(`Built dist/index.html (${config.url ? "live, with demo at ?demo" : "demo only"}).`);
}

module.exports = { buildHtml, readConfig };
