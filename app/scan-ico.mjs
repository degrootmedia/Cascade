import { readFileSync } from 'fs';

const targets = process.argv.slice(2);
const icoSig = Buffer.from([0,0,1,0,0]);
const pngSig = Buffer.from([0x89,0x50,0x4e,0x47]);

for (const t of targets) {
  const b = readFileSync(t);
  let ico = b.indexOf(icoSig);
  let count = 0;
  let pos = b.indexOf(pngSig);
  while (pos !== -1) { count++; pos = b.indexOf(pngSig, pos + 4); }
  console.log(`${t}`);
  console.log(`  size=${b.length}`);
  console.log(`  ICONDIR header byte offset=${ico}`);
  console.log(`  PNG image blobs found=${count} (first at ${count ? b.indexOf(pngSig) : 'n/a'})`);
}