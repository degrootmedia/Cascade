const fs = require("fs"), path = require("path");
const dir = "C:\\Users\\degro\\AppData\\Roaming\\cascade-app\\sessions";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
  .slice(0, 14);
for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const hist = s.history || [];
    let img = 0, big = 0, tool = 0;
    for (const m of hist) {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (/image_url|data:image/.test(c)) img++;
      if (c.length > 5000) big++;
      if (m.role === "tool") tool++;
    }
    console.log(JSON.stringify({ file: f, title: (s.title || "").slice(0, 30), updated: s.updatedAt, histLen: hist.length, imgMsgs: img, bigMsgs: big, toolMsgs: tool, lastRoles: hist.slice(-4).map((m) => m.role).join(",") }));
  } catch (e) { console.log(f, "ERR", e.message); }
}