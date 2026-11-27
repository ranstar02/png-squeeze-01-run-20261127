// PNG Squeezer — palette, grey and adaptive-filter lossless re-encoder.
//
// Reads /input/<id>/image.png (1280x720 RGBA stored PNGs) and writes a
// lossless re-encoding to /output/<id>/image.png, as small as it can:
//
//   1. Decodes the PNG with its own decoder (any bit-depth-8 colour type).
//   2. Analyses the pixels once: unique colours, opaque?, grey?
//   3. Tries every colour-type reduction that applies (palette by count
//      and by luminance, grey, grey+alpha, RGB, RGBA).
//   4. Ranks candidates by a fast deflate of their fixed-None,
//      fixed-Up and per-row minsum filter streams.
//   5. For the winner, also builds fixed-Sub, fixed-Paeth and per-row
//      fewest-pairs filter streams, and writes the smallest of the best
//      streams at zlib level 9 (plus a Z_FILTERED try of the best one).
//
// Deterministic: fixed amount of work, no clock, no randomness, no
// environment-dependent branching. Node 22 built-ins only.
//
// Notes vs the design brief (measured on the practice set, see README):
//   - fixed-None beats minsum by a wide margin on screenshots with large
//     flat areas (i007: 60,890 vs 78,486 bytes), so fixed filters are
//     tried per candidate, not just minsum vs fixed-Paeth.
//   - the fewest-distinct-pairs heuristic beats minsum on most images
//     (i002 RGB: 56,311 vs 61,185), so it is tried for the winner.
//   - a palette ordered by luminance is tried next to the by-count one.
//   - per-row brute-force filter search (deflate trials) is tried for
//     non-palette winners: it wins on smooth grey screenshots (i004:
//     106,248 vs 110,259) and never wins on palette ones, so it is
//     skipped there.
//   - zlib level 6 is also tried on the best stream: it occasionally
//     beats level 9 (i003 pairs: 107,892 vs 108,381).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- PNG decode

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function chunkType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function decodePng(file: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) {
    if (file[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG file');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let idatLen = 0;
  let at = 8;
  while (at + 8 <= file.length) {
    const len =
      (file[at] << 24) | (file[at + 1] << 16) | (file[at + 2] << 8) | file[at + 3];
    const type = chunkType(file, at + 4);
    const data = file.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
      idatLen += len;
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = CHANNELS[colourType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colourType}`);
  const idat = new Uint8Array(idatLen);
  let put = 0;
  for (const part of idatParts) {
    idat.set(part, put);
    put += part.length;
  }
  const raw = inflateSync(idat);
  const stride = width * channels;
  const rowBytes = stride + 1;
  if (raw.length !== height * rowBytes) throw new Error('unexpected inflated size');
  // Unfilter in place, row by row; `prev` is the reconstructed row above.
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowAt = y * rowBytes;
    const filter = raw[rowAt];
    const row = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    if (filter === 0) {
      // None: nothing to do.
    } else if (filter === 1) {
      for (let i = channels; i < stride; i++) row[i] = (row[i] + row[i - channels]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const pred = paethPredictor(a, b, c);
        row[i] = (row[i] + pred) & 0xff;
      }
    } else {
      throw new Error(`unknown filter ${filter}`);
    }
    prev.set(row);
  }
  // Expand the unfiltered samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  if (colourType === 6) {
    for (let y = 0; y < height; y++) {
      rgba.set(raw.subarray(y * rowBytes + 1, y * rowBytes + 1 + stride), y * stride);
    }
  } else if (colourType === 2) {
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes + 1;
      let d = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = src + x * 3;
        rgba[d] = raw[s];
        rgba[d + 1] = raw[s + 1];
        rgba[d + 2] = raw[s + 2];
        rgba[d + 3] = 255;
        d += 4;
      }
    }
  } else if (colourType === 0) {
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes + 1;
      let d = y * width * 4;
      for (let x = 0; x < width; x++) {
        const g = raw[src + x];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
        d += 4;
      }
    }
  } else if (colourType === 4) {
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes + 1;
      let d = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = src + x * 2;
        const g = raw[s];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = raw[s + 1];
        d += 4;
      }
    }
  } else {
    // Colour type 3: palette index, alpha from tRNS (opaque past its end).
    if (palette === null) throw new Error('palette PNG without PLTE');
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes + 1;
      let d = y * width * 4;
      for (let x = 0; x < width; x++) {
        const idx = raw[src + x];
        const p = idx * 3;
        rgba[d] = palette[p];
        rgba[d + 1] = palette[p + 1];
        rgba[d + 2] = palette[p + 2];
        rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
        d += 4;
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Analysis

interface ColourEntry {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

interface Analysis {
  allOpaque: boolean;
  isGrey: boolean;
  // All distinct colours when the image holds at most 256, else null.
  colours: ColourEntry[] | null;
}

function analyse(rgba: Uint8Array): Analysis {
  const pixels = rgba.length >>> 2;
  let allOpaque = true;
  let isGrey = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  for (let i = 0, d = 0; i < pixels; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || r !== b) isGrey = false;
    if (!tooMany) {
      const key = (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      const prev = counts.get(key);
      if (prev === undefined) {
        if (counts.size === 256) tooMany = true;
        else counts.set(key, 1);
      } else {
        counts.set(key, prev + 1);
      }
    }
  }
  let colours: Analysis['colours'] = null;
  if (!tooMany) {
    colours = [...counts.entries()].map(([key, count]) => ({
      r: (key >>> 24) & 0xff,
      g: (key >>> 16) & 0xff,
      b: (key >>> 8) & 0xff,
      a: key & 0xff,
      count,
    }));
  }
  return { allOpaque, isGrey, colours };
}

// ---------------------------------------------------------------- Candidates

interface Candidate {
  colourType: number;
  bytesPerPixel: number;
  data: Uint8Array; // width*height*bytesPerPixel, row-major, no filter bytes
  palette: Uint8Array | null; // PLTE bytes (3 per entry) for type 3
  trns: Uint8Array | null; // tRNS bytes for type 3
  overhead: number; // chunk overhead of PLTE/tRNS beyond the fixed chunks
}

function colourKey(c: ColourEntry): number {
  return (((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a) >>> 0);
}

function paletteCandidate(
  rgba: Uint8Array,
  pixels: number,
  ordered: ColourEntry[],
): Candidate {
  const indexOf = new Map<number, number>();
  for (let i = 0; i < ordered.length; i++) indexOf.set(colourKey(ordered[i]), i);
  const data = new Uint8Array(pixels);
  for (let i = 0, d = 0; i < pixels; i++, d += 4) {
    const key = (((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
    data[i] = indexOf.get(key) as number;
  }
  const palette = new Uint8Array(ordered.length * 3);
  for (let i = 0; i < ordered.length; i++) {
    palette[i * 3] = ordered[i].r;
    palette[i * 3 + 1] = ordered[i].g;
    palette[i * 3 + 2] = ordered[i].b;
  }
  let trns: Uint8Array | null = null;
  let lastAlpha = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].a !== 255) lastAlpha = i;
  }
  if (lastAlpha >= 0) {
    trns = new Uint8Array(lastAlpha + 1);
    for (let i = 0; i <= lastAlpha; i++) trns[i] = ordered[i].a;
  }
  return {
    colourType: 3,
    bytesPerPixel: 1,
    data,
    palette,
    trns,
    overhead: 12 + palette.length + (trns === null ? 0 : 12 + trns.length),
  };
}

function buildCandidates(img: DecodedImage, info: Analysis): Candidate[] {
  const { width, height, rgba } = img;
  const pixels = width * height;
  const out: Candidate[] = [];
  if (info.colours !== null) {
    const colours = info.colours;
    // By frequency descending (ties: colour key ascending).
    const byCount = [...colours].sort((x, y) => {
      if (y.count !== x.count) return y.count - x.count;
      return colourKey(x) - colourKey(y);
    });
    out.push(paletteCandidate(rgba, pixels, byCount));
    // By luminance ascending, transparent entries first (short tRNS).
    const byLuminance = [...colours].sort((x, y) => {
      const tx = x.a === 255 ? 1 : 0;
      const ty = y.a === 255 ? 1 : 0;
      if (tx !== ty) return tx - ty;
      if (tx === 0 && x.a !== y.a) return x.a - y.a;
      const lx = 299 * x.r + 587 * x.g + 114 * x.b;
      const ly = 299 * y.r + 587 * y.g + 114 * y.b;
      return lx - ly || colourKey(x) - colourKey(y);
    });
    out.push(paletteCandidate(rgba, pixels, byLuminance));
  }
  if (info.isGrey && info.allOpaque) {
    const data = new Uint8Array(pixels);
    for (let i = 0, d = 0; i < pixels; i++, d += 4) data[i] = rgba[d];
    out.push({ colourType: 0, bytesPerPixel: 1, data, palette: null, trns: null, overhead: 0 });
  }
  if (info.isGrey) {
    const data = new Uint8Array(pixels * 2);
    for (let i = 0, d = 0, s = 0; i < pixels; i++, d += 4, s += 2) {
      data[s] = rgba[d];
      data[s + 1] = rgba[d + 3];
    }
    out.push({ colourType: 4, bytesPerPixel: 2, data, palette: null, trns: null, overhead: 0 });
  }
  if (info.allOpaque) {
    const data = new Uint8Array(pixels * 3);
    for (let i = 0, d = 0, s = 0; i < pixels; i++, d += 4, s += 3) {
      data[s] = rgba[d];
      data[s + 1] = rgba[d + 1];
      data[s + 2] = rgba[d + 2];
    }
    out.push({ colourType: 2, bytesPerPixel: 3, data, palette: null, trns: null, overhead: 0 });
  }
  out.push({ colourType: 6, bytesPerPixel: 4, data: rgba, palette: null, trns: null, overhead: 0 });
  return out;
}

// ---------------------------------------------------------------- Filtering

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p - a < 0 ? a - p : p - a;
  const pb = p - b < 0 ? b - p : p - b;
  const pc = p - c < 0 ? c - p : p - c;
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Filters one row with the given filter type into `dst`, returning the
// minsum cost: the sum of |signed byte| over the filtered bytes.
function filterOneRow(
  row: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  filter: number,
  dst: Uint8Array,
): number {
  const n = row.length;
  let cost = 0;
  if (filter === 0) {
    for (let i = 0; i < n; i++) {
      const v = row[i];
      dst[i] = v;
      cost += v > 127 ? 256 - v : v;
    }
  } else if (filter === 1) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const v = (row[i] - left) & 0xff;
      dst[i] = v;
      cost += v > 127 ? 256 - v : v;
    }
  } else if (filter === 2) {
    if (prev === null) {
      for (let i = 0; i < n; i++) {
        const v = row[i];
        dst[i] = v;
        cost += v > 127 ? 256 - v : v;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = (row[i] - prev[i]) & 0xff;
        dst[i] = v;
        cost += v > 127 ? 256 - v : v;
      }
    }
  } else if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      const v = (row[i] - ((left + up) >> 1)) & 0xff;
      dst[i] = v;
      cost += v > 127 ? 256 - v : v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      const upLeft = i >= bpp && prev !== null ? prev[i - bpp] : 0;
      const v = (row[i] - paethPredictor(left, up, upLeft)) & 0xff;
      dst[i] = v;
      cost += v > 127 ? 256 - v : v;
    }
  }
  return cost;
}

// A filtered stream: every row behind one filter byte.
// `mode` is a fixed filter (0, 1, 2 or 4 — Average/3 is never competitive
// on these screenshots), 'minsum' (per-row minimum absolute sum, ties to
// the lowest filter number) or 'pairs' (per-row fewest distinct adjacent
// byte pairs, ties to the lowest filter number).
type FilterMode = number | 'minsum' | 'pairs';

function filterStream(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  mode: FilterMode,
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  if (typeof mode === 'number' && mode === 0) {
    // Unfiltered: just copy the rows behind a zero filter byte each.
    for (let y = 0; y < height; y++) {
      const at = y * (stride + 1);
      out[at] = 0;
      out.set(data.subarray(y * stride, (y + 1) * stride), at + 1);
    }
    return out;
  }
  const cur = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  if (mode === 'pairs') {
    const seen = new Uint32Array(65536);
    let stamp = 0;
    const trials: Uint8Array[] = [];
    for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
    for (let y = 0; y < height; y++) {
      const rowStart = y * stride;
      const row = data.subarray(rowStart, rowStart + stride);
      const prev = y === 0 ? null : data.subarray(rowStart - stride, rowStart);
      let bestPairs = Infinity;
      let chosen = 0;
      for (let t = 0; t < 5; t++) {
        filterOneRow(row, prev, bpp, t, trials[t]);
        stamp++;
        let n = 0;
        const trial = trials[t];
        for (let i = 1; i < trial.length; i++) {
          const pair = (trial[i - 1] << 8) | trial[i];
          if (seen[pair] !== stamp) {
            seen[pair] = stamp;
            n++;
          }
        }
        if (n < bestPairs) {
          bestPairs = n;
          chosen = t;
        }
      }
      const outAt = y * (stride + 1);
      out[outAt] = chosen;
      out.set(trials[chosen], outAt + 1);
    }
    return out;
  }
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const row = data.subarray(rowStart, rowStart + stride);
    const prev = y === 0 ? null : data.subarray(rowStart - stride, rowStart);
    let chosen = 0;
    if (typeof mode === 'number') {
      filterOneRow(row, prev, bpp, mode, best);
      chosen = mode;
    } else {
      let bestCost = Infinity;
      for (let f = 0; f < 5; f++) {
        const cost = filterOneRow(row, prev, bpp, f, cur);
        if (cost < bestCost) {
          bestCost = cost;
          chosen = f;
          best.set(cur);
        }
      }
    }
    const outAt = y * (stride + 1);
    out[outAt] = chosen;
    out.set(best, outAt + 1);
  }
  return out;
}

// ---------------------------------------------------------------- PNG encode

function chunk(out: Uint8Array, at: number, type: string, data: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, data.length);
  out[at + 4] = type.charCodeAt(0);
  out[at + 5] = type.charCodeAt(1);
  out[at + 6] = type.charCodeAt(2);
  out[at + 7] = type.charCodeAt(3);
  out.set(data, at + 8);
  view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
  return at + 12 + data.length;
}

function writePng(
  cand: Candidate,
  width: number,
  height: number,
  zlibStream: Uint8Array,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = cand.colourType;
  const plteLen = cand.palette === null ? 0 : 12 + cand.palette.length;
  const trnsLen = cand.trns === null ? 0 : 12 + cand.trns.length;
  const total = 8 + 25 + plteLen + trnsLen + 12 + zlibStream.length + 12;
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let at = 8;
  at = chunk(out, at, 'IHDR', ihdr);
  if (cand.palette !== null) at = chunk(out, at, 'PLTE', cand.palette);
  if (cand.trns !== null) at = chunk(out, at, 'tRNS', cand.trns);
  at = chunk(out, at, 'IDAT', zlibStream);
  at = chunk(out, at, 'IEND', new Uint8Array(0));
  return out;
}

// ---------------------------------------------------------------- Per image

function squeezeImage(img: DecodedImage): Uint8Array {
  const { width, height } = img;
  const info = analyse(img.rgba);
  const candidates = buildCandidates(img, info);
  // Rank each candidate by the smallest of its fixed-None, fixed-Up and
  // minsum streams at zlib level 1, plus its PLTE/tRNS overhead.
  const rankModes: FilterMode[] = [0, 2, 'minsum'];
  let bestIdx = -1;
  let bestRank = Infinity;
  const rankedStreams: Uint8Array[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const streams: Uint8Array[] = [];
    let rank = Infinity;
    for (const mode of rankModes) {
      const stream = filterStream(cand.data, width, height, cand.bytesPerPixel, mode);
      streams.push(stream);
      const z = deflateSync(stream, { level: 1, memLevel: 9 });
      if (z.length < rank) rank = z.length;
    }
    rankedStreams.push(streams);
    const total = rank + cand.overhead;
    if (total < bestRank) {
      bestRank = total;
      bestIdx = i;
    }
  }
  const winner = candidates[bestIdx];
  let smallest = finishCandidate(winner, width, height, rankedStreams[bestIdx]);
  // The two palette orderings rank close together and level 1 sometimes
  // orders them wrongly, so when a palette wins, finish its sibling
  // ordering too (cheap: 1 byte/pixel) and keep the smaller file.
  if (winner.colourType === 3) {
    for (let i = 0; i < candidates.length; i++) {
      if (i !== bestIdx && candidates[i].colourType === 3) {
        const alt = finishCandidate(candidates[i], width, height, rankedStreams[i]);
        if (alt.length < smallest.length) smallest = alt;
      }
    }
  }
  return smallest;
}

// Builds the brute-force filter stream: each row tries all five filters
// and keeps the one whose level-4 deflate, with the preceding 32 KiB of
// the chosen stream as dictionary, is smallest. Measured to win mainly
// on smooth grey screenshots (practice i004: 106,248 vs 110,259 bytes);
// skipped for palette winners, where it never won.
function bruteStream(
  data: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const row = data.subarray(rowStart, rowStart + stride);
    const prev = y === 0 ? null : data.subarray(rowStart - stride, rowStart);
    const at = y * (stride + 1);
    const before = out.subarray(Math.max(0, at - 32768), at);
    let bestLen = Infinity;
    let chosen = 0;
    for (let t = 0; t < 5; t++) {
      filterOneRow(row, prev, bpp, t, trials[t].subarray(1));
      const opts =
        before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before };
      const len = deflateSync(trials[t], opts).length;
      if (len < bestLen) {
        bestLen = len;
        chosen = t;
      }
    }
    out[at] = chosen;
    out.set(trials[chosen].subarray(1), at + 1);
  }
  return out;
}

// Builds the winner-only extra streams (fixed-Sub, fixed-Paeth,
// fewest-pairs) for a candidate, then encodes every stream at level 9
// (default strategy) — level 1 sizes mis-order streams whose long matches
// only level 9's deeper search finds (fixed-None on flat screenshots is
// the classic case) — plus a Z_FILTERED try of the best one.
function finishCandidate(
  cand: Candidate,
  width: number,
  height: number,
  rankStreams: Uint8Array[],
): Uint8Array {
  const streams = [...rankStreams];
  const extraModes: FilterMode[] = [1, 4, 'pairs'];
  for (const mode of extraModes) {
    streams.push(filterStream(cand.data, width, height, cand.bytesPerPixel, mode));
  }
  if (cand.colourType !== 3) {
    streams.push(bruteStream(cand.data, width, height, cand.bytesPerPixel));
  }
  let smallest: Uint8Array | null = null;
  let bestStream = streams[0];
  let bestLen = Infinity;
  for (const stream of streams) {
    const png = writePng(
      cand,
      width,
      height,
      deflateSync(stream, { level: 9, memLevel: 9 }),
    );
    if (png.length < bestLen) {
      bestLen = png.length;
      smallest = png;
      bestStream = stream;
    }
  }
  const pngFiltered = writePng(
    cand,
    width,
    height,
    deflateSync(bestStream, {
      level: 9,
      memLevel: 9,
      strategy: zlibConstants.Z_FILTERED,
    }),
  );
  if (pngFiltered.length < (smallest as Uint8Array).length) smallest = pngFiltered;
  // Level 6 occasionally beats level 9 on the same stream (practice i003
  // pairs: 107,892 vs 108,381), and costs ~30 ms, so try it on the best.
  const pngLevel6 = writePng(
    cand,
    width,
    height,
    deflateSync(bestStream, { level: 6, memLevel: 8 }),
  );
  if (pngLevel6.length < (smallest as Uint8Array).length) smallest = pngLevel6;
  return smallest as Uint8Array;
}

// ---------------------------------------------------------------- Main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const squeezed = squeezeImage(image);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeezed);
}
