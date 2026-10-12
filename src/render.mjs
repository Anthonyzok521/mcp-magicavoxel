// Orthographic voxel ray caster that produces PNG previews, optionally posed through the rig.
import zlib from 'node:zlib';
import { poseTransforms, matVec } from './rig.mjs';

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const transpose = (A) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => A[c][r]));

// View direction (camera looks along d) and screen-right vector. MagicaVoxel's
// "front" looks from -y toward +y with x to the right and z up.
const VIEWS = {
  iso: { d: [-1, 1, -1], right: [1, 1, 0] },
  iso_back: { d: [1, -1, -1], right: [-1, -1, 0] },
  front: { d: [0, 1, 0], right: [1, 0, 0] },
  back: { d: [0, -1, 0], right: [-1, 0, 0] },
  right: { d: [-1, 0, 0], right: [0, 1, 0] },
  left: { d: [1, 0, 0], right: [0, -1, 0] },
  top: { d: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
};
export const VIEW_NAMES = Object.keys(VIEWS);

// Brightness from a world-space normal so the three visible sides read clearly.
const shade = (n) => Math.abs(n[0]) * 0.8 + Math.abs(n[1]) * 0.62 + (n[2] > 0 ? n[2] : -n[2] * 0.45);

// Amanatides-Woo traversal of one model in its local grid. o and d are local.
function castModel(m, o, d, best) {
  const size = m.size;
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < 0 || o[k] >= size[k]) return false;
      continue;
    }
    let t0 = -o[k] / d[k];
    let t1 = (size[k] - o[k]) / d[k];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tNear) [tNear, axis] = [t0, k];
    if (t1 < tFar) tFar = t1;
  }
  if (tNear > tFar || tNear >= best.t) return false;

  const p = [0, 1, 2].map((k) => o[k] + d[k] * (tNear + 1e-6));
  const cell = p.map((v, k) => Math.min(Math.max(Math.floor(v), 0), size[k] - 1));
  const step = d.map((v) => (v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0));
  const tDelta = d.map((v, k) => (step[k] === 0 ? Infinity : Math.abs(1 / v)));
  const tMax = [0, 1, 2].map((k) =>
    step[k] === 0 ? Infinity : tNear + ((step[k] > 0 ? cell[k] + 1 : cell[k]) - p[k]) / d[k],
  );
  let t = tNear;
  let k = axis;
  let sign = d[axis] > 0 ? -1 : 1;
  for (;;) {
    if (t >= best.t) return false;
    const c = m.voxels[cell[0] + size[0] * (cell[1] + size[1] * cell[2])];
    if (c) {
      Object.assign(best, { t, c, k, sign });
      return true;
    }
    k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    cell[k] += step[k];
    if (cell[k] < 0 || cell[k] >= size[k]) return false;
    t = tMax[k];
    tMax[k] += tDelta[k];
    sign = -step[k];
  }
}

export function render(scene, { view = 'iso', size = 512, models, pose } = {}) {
  const v = VIEWS[view];
  if (!v) throw new Error(`Unknown view "${view}". Use one of: ${VIEW_NAMES.join(', ')}.`);
  const transforms = poseTransforms(scene, pose);

  // Per-model world transform: local voxel coordinate l maps to A·l + b.
  const list = [];
  let lo = null;
  let hi = null;
  for (const m of scene.models.values()) {
    if (models && !models.includes(m.name)) continue;
    const bounds = m.bounds();
    if (!bounds) continue;
    const { A, b: tb } = transforms.get(m.name);
    const b = matVec(A, m.position).map((x, k) => x + tb[k]);
    list.push({ m, A, AT: transpose(A), b });
    for (const cx of [bounds.min[0], bounds.max[0] + 1])
      for (const cy of [bounds.min[1], bounds.max[1] + 1])
        for (const cz of [bounds.min[2], bounds.max[2] + 1]) {
          const w = matVec(A, [cx, cy, cz]).map((x, k) => x + b[k]);
          lo = lo ? lo.map((x, k) => Math.min(x, w[k])) : w;
          hi = hi ? hi.map((x, k) => Math.max(x, w[k])) : w;
        }
  }
  if (!list.length) throw new Error('Nothing to render: the selected models are empty.');

  const d = norm(v.d);
  const right = norm(v.right);
  const up = v.up ? norm(v.up) : norm(cross(right, d));

  // Fit the occupied bounding box into the image with a small margin.
  const center = lo.map((x, k) => (x + hi[k]) / 2);
  let extent = 0;
  for (const cx of [lo[0], hi[0]])
    for (const cy of [lo[1], hi[1]])
      for (const cz of [lo[2], hi[2]]) {
        const rel = [cx - center[0], cy - center[1], cz - center[2]];
        extent = Math.max(extent, Math.abs(dot(rel, right)), Math.abs(dot(rel, up)));
      }
  const scale = (extent * 2 * 1.1) / size; // world units per pixel
  const back = Math.hypot(...hi.map((x, k) => x - lo[k])) + 1;
  for (const e of list) e.d = matVec(e.AT, d);

  const rgb = Buffer.alloc(size * size * 3);
  const best = {};
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sxw = (px + 0.5 - size / 2) * scale;
      const syw = (size / 2 - py - 0.5) * scale;
      const o = [0, 1, 2].map((k) => center[k] + right[k] * sxw + up[k] * syw - d[k] * back);
      best.t = Infinity;
      let hit = null;
      for (const e of list) {
        const local = matVec(e.AT, [o[0] - e.b[0], o[1] - e.b[1], o[2] - e.b[2]]);
        if (castModel(e.m, local, e.d, best)) hit = e;
      }
      const i = (py * size + px) * 3;
      if (!hit) {
        const checker = ((px >> 4) + (py >> 4)) & 1;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = checker ? 46 : 38;
      } else {
        const col = scene.palette[best.c];
        const s = shade([0, 1, 2].map((r) => hit.A[r][best.k] * best.sign));
        rgb[i] = Math.min(255, col[0] * s);
        rgb[i + 1] = Math.min(255, col[1] * s);
        rgb[i + 2] = Math.min(255, col[2] * s);
      }
    }
  }
  return encodePng(rgb, size, size, 3);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// channels: 3 = RGB, 4 = RGBA.
export function encodePng(pixels, w, h, channels) {
  const row = w * channels;
  const raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // RGBA or RGB truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
