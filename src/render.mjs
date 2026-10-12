// Orthographic voxel ray caster that produces PNG previews.
import zlib from 'node:zlib';

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

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

// Brightness per hit face so the three visible sides read clearly.
const SHADE = { '2+': 1.0, '2-': 0.45, '0+': 0.8, '0-': 0.8, '1+': 0.62, '1-': 0.62 };

function castModel(m, o, d, best) {
  const [sx, sy, sz] = m.size;
  const lo = m.position;
  const hi = [lo[0] + sx, lo[1] + sy, lo[2] + sz];
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) {
      if (o[k] < lo[k] || o[k] >= hi[k]) return;
      continue;
    }
    let t0 = (lo[k] - o[k]) / d[k];
    let t1 = (hi[k] - o[k]) / d[k];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tNear) [tNear, axis] = [t0, k];
    if (t1 < tFar) tFar = t1;
  }
  if (tNear > tFar || tNear >= best.t) return;

  const p = [0, 1, 2].map((k) => o[k] + d[k] * (tNear + 1e-6) - lo[k]);
  const cell = p.map((v, k) => Math.min(Math.max(Math.floor(v), 0), m.size[k] - 1));
  const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
  const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
  const tMax = [0, 1, 2].map((k) =>
    d[k] === 0 ? Infinity : tNear + ((step[k] > 0 ? cell[k] + 1 : cell[k]) - p[k]) / d[k],
  );
  let t = tNear;
  let face = `${axis}${d[axis] > 0 ? '-' : '+'}`;
  for (;;) {
    if (t >= best.t) return;
    const c = m.voxels[cell[0] + sx * (cell[1] + sy * cell[2])];
    if (c) {
      best.t = t;
      best.c = c;
      best.face = face;
      return;
    }
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    cell[k] += step[k];
    if (cell[k] < 0 || cell[k] >= m.size[k]) return;
    t = tMax[k];
    tMax[k] += tDelta[k];
    face = `${k}${step[k] > 0 ? '-' : '+'}`;
  }
}

export function render(scene, { view = 'iso', size = 512, models } = {}) {
  const v = VIEWS[view];
  if (!v) throw new Error(`Unknown view "${view}". Use one of: ${VIEW_NAMES.join(', ')}.`);
  const list = [...scene.models.values()].filter((m) => !models || models.includes(m.name));
  const bounds = scene.worldBounds(models);
  if (!bounds) throw new Error('Nothing to render: the selected models are empty.');

  const d = norm(v.d);
  const right = norm(v.right);
  const up = v.up ? norm(v.up) : norm(cross(right, d));

  // Fit the occupied bounding box into the image with a small margin.
  const lo = bounds.min;
  const hi = bounds.max.map((x) => x + 1);
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

  const rgb = Buffer.alloc(size * size * 3);
  const best = {};
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sxw = (px + 0.5 - size / 2) * scale;
      const syw = (size / 2 - py - 0.5) * scale;
      const o = [0, 1, 2].map((k) => center[k] + right[k] * sxw + up[k] * syw - d[k] * back);
      best.t = Infinity;
      for (const m of list) castModel(m, o, d, best);
      const i = (py * size + px) * 3;
      if (best.t === Infinity) {
        const checker = ((px >> 4) + (py >> 4)) & 1;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = checker ? 46 : 38;
      } else {
        const col = scene.palette[best.c];
        const s = SHADE[best.face];
        rgb[i] = Math.min(255, col[0] * s);
        rgb[i + 1] = Math.min(255, col[1] * s);
        rgb[i + 2] = Math.min(255, col[2] * s);
      }
    }
  }
  return encodePng(rgb, size, size);
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
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
