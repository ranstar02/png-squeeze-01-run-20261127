// Local grader for png-squeeze-01 (dev tooling only, NOT part of the entry).
// Usage: node grade.mjs <output-dir> [label]
// Decodes each output PNG with its own small decoder, compares RGBA bytes
// exactly against the practice input decoded the same way, and scores
// from practice/reference/manifest.json.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const KIT = '/home/hatch/workspace/makefun/png-squeeze-01-run-20261127/kit/png-squeeze-01-run-20261127-kit';
const INPUT_DIR = join(KIT, 'practice/input');
const MANIFEST = JSON.parse(readFileSync(join(KIT, 'practice/reference/manifest.json'), 'utf8'));

const outDir = process.argv[2];
const label = process.argv[3] ?? 'run';
if (!outDir) {
  console.error('usage: node grade.mjs <output-dir> [label]');
  process.exit(2);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Minimal PNG -> RGBA decoder, written independently for grading.
function decode(buf) {
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) throw new Error('bad signature');
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const t = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (t === 'PLTE') plte = data;
    else if (t === 'tRNS') trns = data;
    else if (t === 'IDAT') idat.push(data);
    else if (t === 'IEND') break;
    else throw new Error(`unexpected chunk ${t}`);
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced');
  const ch = CHANNELS[type];
  if (ch === undefined) throw new Error(`colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const rgba = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rec = Buffer.from(row);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? rec[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      if (f === 1) rec[i] = (rec[i] + a) & 0xff;
      else if (f === 2) rec[i] = (rec[i] + b) & 0xff;
      else if (f === 3) rec[i] = (rec[i] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) rec[i] = (rec[i] + paeth(a, b, c)) & 0xff;
      else if (f !== 0) throw new Error(`filter ${f}`);
    }
    prev.set(rec);
    let d = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (type === 6) {
        rgba[d] = rec[x * 4];
        rgba[d + 1] = rec[x * 4 + 1];
        rgba[d + 2] = rec[x * 4 + 2];
        rgba[d + 3] = rec[x * 4 + 3];
      } else if (type === 2) {
        rgba[d] = rec[x * 3];
        rgba[d + 1] = rec[x * 3 + 1];
        rgba[d + 2] = rec[x * 3 + 2];
        rgba[d + 3] = 255;
      } else if (type === 0) {
        const g = rec[x];
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = 255;
      } else if (type === 4) {
        const g = rec[x * 2];
        rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = rec[x * 2 + 1];
      } else {
        const idx = rec[x];
        rgba[d] = plte[idx * 3];
        rgba[d + 1] = plte[idx * 3 + 1];
        rgba[d + 2] = plte[idx * 3 + 2];
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
      d += 4;
    }
  }
  return { width: w, height: h, rgba };
}

let totalPoints = 0;
console.log(`== ${label} ==`);
for (const inst of MANIFEST.instances) {
  const { id, key } = inst;
  const inRgba = decode(readFileSync(join(INPUT_DIR, id, 'image.png'))).rgba;
  let outBytes = 0;
  let exact = false;
  let why = '';
  try {
    const file = readFileSync(join(outDir, id, 'image.png'));
    outBytes = statSync(join(outDir, id, 'image.png')).size;
    const got = decode(file);
    exact = got.width === 1280 && got.height === 720 && got.rgba.equals(inRgba);
    if (!exact) why = 'PIXELS DIFFER';
  } catch (e) {
    why = `UNREADABLE: ${e.message}`;
  }
  const floor = key.floor_bytes;
  const target = key.target_bytes;
  let points = 0;
  if (exact) {
    points = Math.max(0, Math.min(1000, (1000 * (floor - outBytes)) / (floor - target)));
  }
  totalPoints += points;
  console.log(
    `${id} theme=${key.theme.padEnd(5)} bytes=${String(outBytes).padStart(7)} ` +
    `scale=${key.scale_bytes} floor=${floor} target=${target} ` +
    `points=${points.toFixed(2).padStart(7)} ${exact ? 'EXACT' : 'FAIL ' + why}`,
  );
}
const total = Math.round(1000 * (totalPoints / 8));
console.log(`TOTAL: ${total} / 1000000  (mean points ${totalPoints / 8})`);
