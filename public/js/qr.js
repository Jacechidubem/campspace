// QR Code encoder (byte mode, versions 1-10, error-correction L/M/Q/H).
// Shared by the browser (ticket display) and the server (PDF tickets). No dependencies.

const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver, ecl) =>
  Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const res = new Array(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < res.length; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < res.length) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 2);
  }
  return res;
}
function rsRemainder(data, divisor) {
  const res = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    divisor.forEach((c, i) => { res[i] ^= gfMul(c, factor); });
  }
  return res;
}

function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const size = ver * 4 + 17;
  const res = [6];
  for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
  return res;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m, size) {
  let p = 0;
  // N1: runs of 5+ same-coloured modules, rows and columns
  for (let a = 0; a < size; a++) {
    for (const rowMode of [true, false]) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = rowMode ? m[a][b] : m[b][a];
        const prev = rowMode ? m[a][b - 1] : m[b - 1][a];
        if (cur === prev) {
          run++;
          if (run === 5) p += 3;
          else if (run > 5) p += 1;
        } else run = 1;
      }
    }
  }
  // N2: 2x2 blocks
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++)
      if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  // N3: finder-like 1:1:3:1:1 patterns with 4 light modules on a side
  const pats = ['10111010000', '00001011101'];
  for (let a = 0; a < size; a++) {
    for (const rowMode of [true, false]) {
      let s = '';
      for (let b = 0; b < size; b++) s += (rowMode ? m[a][b] : m[b][a]) ? '1' : '0';
      for (const pt of pats) {
        let i = s.indexOf(pt);
        while (i !== -1) { p += 40; i = s.indexOf(pt, i + 1); }
      }
    }
  }
  // N4: dark/light balance
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = size * size;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * Encode text as a QR code.
 * @returns {{size:number, version:number, modules:boolean[][]}} modules[y][x] === true for dark modules
 */
export function qrEncode(text, ecl = 'M') {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(v, ecl) * 8) { version = v; break; }
  }
  if (!version) throw new RangeError('Text is too long for this QR encoder');
  const size = version * 4 + 17;

  // 1. bit stream
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCodewords(version, ecl) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // 2. Reed-Solomon + interleave
  const nBlocks = NUM_BLOCKS[ecl][version];
  const eccLen = ECC_PER_BLOCK[ecl][version];
  const rawCw = Math.floor(rawModules(version) / 8);
  const nShort = nBlocks - (rawCw % nBlocks);
  const shortLen = Math.floor(rawCw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= nShort) cw.push(blk[i]); });

  // 3. matrix with function patterns
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const ap = alignPositions(version);
  for (let i = 0; i < ap.length; i++)
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask) => {
    const d = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bs = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bs, i));
    setFn(8, 7, bit(bs, 6)); setFn(8, 8, bit(bs, 7)); setFn(7, 8, bit(bs, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bs, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bs, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bs, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bs = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bs, i)); setFn(b, a, bit(bs, i));
    }
  }

  // 4. place data (zig-zag)
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && idx < cw.length * 8) {
          m[y][x] = bit(cw[idx >>> 3], 7 - (idx & 7));
          idx++;
        }
      }
  }

  // 5. choose the best mask
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  };
  let best = 0, bestPen = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(m, size);
    if (p < bestPen) { bestPen = p; best = mask; }
    applyMask(mask); // undo (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { size, version, modules: m };
}

/** SVG path data (one square per dark module, with a quiet zone) for rendering. */
export function qrPath(qr, quiet = 4) {
  let d = '';
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return { d, viewBox: `0 0 ${qr.size + quiet * 2} ${qr.size + quiet * 2}`, total: qr.size + quiet * 2 };
}
