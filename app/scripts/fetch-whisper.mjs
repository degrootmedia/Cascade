/**
 * Download a prebuilt whisper.cpp CLI + its DLLs into `app/resources/whisper/`
 * for local dev and packaging (electron-builder copies the dir via
 * `extraResources`, and `main/voice.ts` resolves it there).
 *
 * whisper.cpp publishes its prebuilt binaries on NIGHTLY (`b####`) tags, not on
 * the `latest` tag, so this queries the releases list and takes the newest one
 * carrying the platform's asset. Only the binary is fetched here; the ggml
 * model is downloaded at runtime on first use.
 *
 * Usage:  node scripts/fetch-whisper.mjs
 * Re-run to update. Requires `tar` (Windows 10+ ships bsdtar; macOS/Linux have
 * it) and network access to api.github.com / github.com.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const outDir = path.join(appDir, "resources", "whisper");

const platform = process.platform;
const assetName =
  platform === "win32" ? "whisper-bin-x64.zip" : platform === "linux" ? "whisper-bin-ubuntu-x64.tar.gz" : null;

if (!assetName) {
  console.error(
    `Unsupported platform "${platform}". Download a whisper.cpp build manually and place whisper-cli and its libraries in ${outDir}.`
  );
  process.exit(1);
}

async function findAsset() {
  const res = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=40", {
    headers: { "User-Agent": "cascade-fetch-whisper" },
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  const releases = await res.json();
  for (const rel of releases) {
    const asset = (rel.assets ?? []).find((a) => a.name === assetName);
    if (asset) return { url: asset.browser_download_url, tag: rel.tag_name };
  }
  throw new Error(`No whisper.cpp release carries "${assetName}"`);
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": "cascade-fetch-whisper" } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const out = fs.createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const buf = Buffer.from(value);
    if (!out.write(buf)) await new Promise((r) => out.once("drain", () => r()));
    received += buf.length;
    if (total) process.stdout.write(`\r  ${((received / total) * 100).toFixed(0)}%`);
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  process.stdout.write("\n");
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("tar", ["-xf", archive, "-C", dir], { stdio: "inherit" });
  if (r.error) throw new Error(`Failed to run tar: ${r.error.message}. Extract ${archive} manually into ${outDir}.`);
  if (r.status !== 0) throw new Error(`tar exited with code ${r.status}`);
}

/** Recursively collect files whose name matches `pred`. */
function walk(dir, pred, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pred, acc);
    else if (pred(entry.name)) acc.push(full);
  }
  return acc;
}

async function main() {
  console.log(`Fetching whisper.cpp binary for ${platform}...`);
  const { url, tag } = await findAsset();
  console.log(`  release ${tag}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-whisper-"));
  const archive = path.join(work, assetName);
  try {
    await download(url, archive);
    const extracted = path.join(work, "x");
    extract(archive, extracted);
    const isExe = platform === "win32" ? (n) => n.toLowerCase() === "whisper-cli.exe" : (n) => n === "whisper-cli";
    const binaries = walk(extracted, isExe);
    if (!binaries.length) throw new Error("whisper-cli was not found in the archive");
    const binDir = path.dirname(binaries[0]);
    const libs = walk(binDir, (n) => /\.(dll|so|dylib)$/i.test(n));
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of [binaries[0], ...libs]) {
      fs.copyFileSync(f, path.join(outDir, path.basename(f)));
      console.log(`  + ${path.basename(f)}`);
    }
    console.log(`Installed into ${outDir}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
