// Minimal asar reader: list files matching main bundle, print matching lines.
const fs = require("fs");
const path = require("path");
const ASAR = "C:\\Users\\degro\\AppData\\Local\\Programs\\cascade-app\\resources\\app.asar";

const fd = fs.openSync(ASAR, "r");
const headerStart = 16; // JSON header begins at offset 16
const probe = Buffer.alloc(1000000);
fs.readSync(fd, probe, 0, 1000000, headerStart);
const s = probe.toString("utf8");
// Find end of the JSON object by brace-balancing (start assumes leading `{`).
let depth = 0, inStr = false, jsonEnd = -1;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (inStr) {
    if (c === "\\") { i++; continue; }
    if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') { inStr = true; continue; }
  if (c === "{") depth++;
  else if (c === "}") { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
}
if (jsonEnd < 0) { console.log("JSON END NOT FOUND"); process.exit(1); }
const header = JSON.parse(s.slice(0, jsonEnd));
const headerSize = jsonEnd;
const dataBase = headerStart + headerSize + ((4 - ((headerStart + headerSize) % 4)) % 4); // 4-byte align

function fileMap(node, prefix = "") {
  let out = {};
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) fileMap(child, prefix + "/" + name, out);
  } else if (typeof node.offset === "number") {
    out[prefix] = node;
  }
  return { ...out, [prefix]: node };
}

function extract(relPath) {
  const clean = relPath.replace(/^\//, "");
  let node = header;
  for (const part of clean.split("/")) {
    node = node.files[part];
    if (!node) return null;
  }
  const buf = Buffer.alloc(node.size);
  const abs = dataBase + Number(node.offset);
  fs.readSync(fd, buf, 0, node.size, abs);
  return buf.toString("utf8");
}

// Collect all file paths
function collect(node, prefix = "") {
  const res = [];
  const children = node.files || node; // allow either root or dir node
  for (const [name, child] of Object.entries(children)) {
    if (child.files) {
      for (const p of collect(child, prefix + "/" + name)) res.push(p);
    } else if (typeof child.offset !== "undefined") {
      res.push(prefix + "/" + name);
    }
  }
  return res;
}
const all = collect(header);
// Find the main bundle
const main = all.find((p) => p.endsWith("/out/main/index.js")) || all.find((p) => /main.*index\.js|index\.js.*main/.test(p));
console.log("TOTAL FILES:", all.length);
console.log("CANDIDATE MAIN:", main);
const js = all.filter((p) => p.endsWith(".js")).slice(0, 40);
console.log("SOME JS:", JSON.stringify(js, null, 0));

if (main) {
  const text = extract(main);
  fs.writeFileSync(path.join(__dirname, "installed-main.txt"), text);
  console.log("WROTE installed-main.txt, length =", text.length);
}

// Also extract renderer bundles and search for error strings.
const rendererJs = all.filter((p) => p.includes("/out/renderer/") && p.endsWith(".js"));
console.log("RENDERER JS COUNT:", rendererJs.length, JSON.stringify(rendererJs.slice(0, 10)));
for (const p of rendererJs) {
  const body = extract(p);
  if (!body) continue;
  for (const c of ["failed to generate", "Please try again", "gab.ai error", "model failed to respond"]) {
    const idx = body.indexOf(c);
    if (idx >= 0) console.log(`RENDERER ${p} contains "${c}" @ ${idx}`);
  }
  if (p.includes("index-") && body.length < 200000) {
    fs.writeFileSync(path.join(__dirname, "installed-" + p.split("/").pop()), body);
  }
}
fs.closeSync(fd);