import * as fs from "node:fs";
const p = "app/src/renderer/src/components/production/animatic.tsx";
let s = fs.readFileSync(p, "utf8");
const find = '      const thumb = previewRef.current?.querySelector("img.prod-timeline-thumb") as HTMLImageElement | null;';
const replace = '      const thumb = previewRef.current?.querySelector(".prod-timeline-thumb") as HTMLElement | null;';
const n = s.split(find).length - 1;
if (n !== 1) { console.log(`FAIL ${n}`); process.exit(1); }
s = s.replace(find, replace);
fs.writeFileSync(p, s, "utf8");
console.log("ok");
