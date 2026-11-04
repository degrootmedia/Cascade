import * as fs from "node:fs";
const p = "app/src/renderer/src/styles.css";
let s = fs.readFileSync(p, "utf8");
const E = s.includes("\r\n") ? "\r\n" : "\n";
const find = [
  ".prod-animatic-preview .prod-timeline-thumb {",
  "  width: 100%;",
  "  height: 100%;",
  "  border: none;",
  "  border-radius: 0;",
  "  object-fit: contain;",
  "  background: var(--media-bg);",
  "}",
].join(E);
const replace = [
  ".prod-animatic-preview .prod-timeline-thumb {",
  "  width: 100%;",
  "  height: 100%;",
  "  border: none;",
  "  border-radius: 0;",
  "  object-fit: contain;",
  "  background: var(--media-bg);",
  "  /* Above the dissolve under-layer (z-index 1), level with the live",
  "     video, so an incoming still fades OVER the outgoing clip. */",
  "  position: relative;",
  "  z-index: 2;",
  "}",
].join(E);
const n = s.split(find).length - 1;
if (n !== 1) { console.log(`FAIL ${n}`); process.exit(1); }
s = s.replace(find, replace);
fs.writeFileSync(p, s, "utf8");
console.log("ok");
