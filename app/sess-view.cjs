const fs = require("fs");
const s = JSON.parse(fs.readFileSync("C:\\Users\\degro\\AppData\\Roaming\\cascade-app\\sessions\\msqqltum-7jx9w3.json", "utf8"));
const hist = s.history || [];
console.log("TITLE:", s.title, "| updated:", s.updatedAt, "| workspace:", s.workspace);
function preview(m) {
  let c = typeof m.content === "string" ? m.content : m.content;
  if (Array.isArray(c)) {
    return c.map((p) => p.type === "image_url" ? "[IMAGE]" : (p.text || "")).join(" | ").slice(0, 80);
  }
  return String(c).slice(0, 80);
}
for (let i = 0; i < hist.length; i++) {
  const m = hist[i];
  const isImg = /image_url|data:image/.test(JSON.stringify(m.content || ""));
  const tc = m.tool_calls?.map((t) => t.function?.name).join(",") || "";
  console.log(`[${i}] ${m.role}${isImg ? " [IMG]" : ""}${tc ? " calls:" + tc : ""} :: ${preview(m)}`);
  if (i > 20 && i >= hist.length - 24) {}
}