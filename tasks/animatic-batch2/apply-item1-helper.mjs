import * as fs from "node:fs";
const p = "app/src/renderer/src/components/production/animatic.tsx";
let s = fs.readFileSync(p, "utf8");
function rep(find, replace, label) {
  const n = s.split(find).length - 1;
  if (n !== 1) { console.log(`FAIL ${label}: ${n}`); process.exit(1); }
  s = s.replace(find, replace);
  console.log(`ok ${label}`);
}
rep(
  'import type { TimelineOverride } from "./timeline-preview.js";',
  'import { blendUnderShouldSeek, type TimelineOverride } from "./timeline-preview.js";',
  "import helper",
);
rep(
  "        if (!playing || Math.abs(bv.currentTime - want) > 0.4) bv.currentTime = want;",
  "        if (blendUnderShouldSeek(playing, bv.currentTime, want)) bv.currentTime = want;",
  "use helper",
);
fs.writeFileSync(p, s, "utf8");
console.log("done");
