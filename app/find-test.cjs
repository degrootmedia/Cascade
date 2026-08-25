const fs = require("fs"), path = require("path");
const dir = "C:\\Users\\degro\\AppData\\Roaming\\cascade-app\\sessions";
function cc(m) {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
  return c;
}
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const hist = s.history || [];
    for (let i = 0; i < hist.length; i++) {
      const m = hist[i];
      const text = cc(m);
      if (m.role === "user" && /^\s*test\s*$/i.test(text)) {
        const hasImgBefore = hist.slice(0, i).some((x) => /image_url|data:image/.test(cc(x)));
        const imgThis = /image_url|data:image/.test(text);
        console.log(JSON.stringify({ file: f, title: s.title, atIdx: i, totalLen: hist.length, histLenAtTest: i, hasImgEarlier: hasImgBefore, imgThis: imgThis }));
      }
    }
  } catch (e) {}
}