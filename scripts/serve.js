#!/usr/bin/env node
// Serves dist/index.html on this machine only.
const fs = require("fs");
const http = require("http");
const path = require("path");

const page = path.resolve(__dirname, "..", "dist", "index.html");
const port = Number(process.env.PORT) || 4173;
http.createServer((request, response) => {
  if (new URL(request.url, "http://localhost").pathname !== "/") { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(fs.readFileSync(page));
}).listen(port, "127.0.0.1", () => console.log(`Karma Watch demo: http://localhost:${port}`));
