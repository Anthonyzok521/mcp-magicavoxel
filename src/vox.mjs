// In-memory voxel scene plus MagicaVoxel .vox (version 200) reader/writer.
// Coordinates follow MagicaVoxel: x = right, y = depth, z = up.

export const MAX_DIM = 256;

const DEFAULT_MATERIAL = { _type: '_diffuse', _rough: '0.1', _ior: '0.3', _ri: '1.3', _d: '0.05' };

export function parseColor(input) {
  const s = String(input).trim().replace(/^#/, '');
  let hex = s;
  if (/^[0-9a-f]{3}$/i.test(s)) hex = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid color "${input}". Use "#rrggbb" or "#rgb".`);
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export class Model {
  constructor(name, size, position = [0, 0, 0]) {
    size.forEach((d) => {
      if (!Number.isInteger(d) || d < 1 || d > MAX_DIM) throw new Error(`Model dimensions must be integers from 1 to ${MAX_DIM}.`);
    });
    this.name = name;
    this.size = size;
    this.position = position; // world coordinate of local voxel (0,0,0)
    this.voxels = new Uint8Array(size[0] * size[1] * size[2]); // palette index, 0 = empty
    this.pivot = null; // world-space joint position; null means the center of the model box
    this.parent = null; // name of the parent model in the rig
  }

  clone(name = this.name) {
    const m = new Model(name, [...this.size], [...this.position]);
    m.voxels.set(this.voxels);
    m.pivot = this.pivot && [...this.pivot];
    m.parent = this.parent;
    return m;
  }

  inBounds(x, y, z) {
    const [sx, sy, sz] = this.size;
    return x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz;
  }

  index(x, y, z) {
    return x + this.size[0] * (y + this.size[1] * z);
  }

  get(x, y, z) {
    return this.inBounds(x, y, z) ? this.voxels[this.index(x, y, z)] : 0;
  }

  // Returns true when the coordinate was inside the model.
  set(x, y, z, c) {
    if (!this.inBounds(x, y, z)) return false;
    this.voxels[this.index(x, y, z)] = c;
    return true;
  }

  count() {
    let n = 0;
    for (const v of this.voxels) if (v) n++;
    return n;
  }

  // Tight bounds of occupied voxels in local coordinates, or null when empty.
  bounds() {
    const [sx, sy, sz] = this.size;
    const min = [sx, sy, sz];
    const max = [-1, -1, -1];
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++)
          if (this.voxels[this.index(x, y, z)]) {
            if (x < min[0]) min[0] = x;
            if (y < min[1]) min[1] = y;
            if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x;
            if (y > max[1]) max[1] = y;
            if (z > max[2]) max[2] = z;
          }
    return max[0] < 0 ? null : { min, max };
  }
}

export class Scene {
  constructor() {
    this.models = new Map();
    // palette[i] = [r,g,b,a] for i in 1..255; index 0 is always empty.
    this.palette = Array.from({ length: 256 }, () => [255, 255, 255, 255]);
    this.used = new Array(256).fill(false);
    this.materials = new Map(); // palette index -> MATL dict
    this.attachments = new Map(); // name -> { parent, position } world-space mount points
  }

  clone() {
    const s = new Scene();
    for (const [name, m] of this.models) s.models.set(name, m.clone());
    s.palette = this.palette.map((c) => [...c]);
    s.used = [...this.used];
    for (const [i, d] of this.materials) s.materials.set(i, { ...d });
    for (const [n, a] of this.attachments) s.attachments.set(n, { parent: a.parent, position: [...a.position] });
    return s;
  }

  addModel(name, size, position) {
    if (this.models.has(name)) throw new Error(`A model named "${name}" already exists.`);
    const m = new Model(name, size, position);
    this.models.set(name, m);
    return m;
  }

  model(name) {
    const m = this.models.get(name);
    if (!m) throw new Error(`No model named "${name}". Existing: ${[...this.models.keys()].join(', ') || '(none)'}.`);
    return m;
  }

  // Map a hex color to a palette index, allocating a slot when needed.
  // Falls back to the nearest existing color once all 255 slots are taken.
  colorIndex(color) {
    if (color === 'empty' || color === null) return 0;
    const rgb = parseColor(color);
    for (let i = 1; i < 256; i++) {
      const p = this.palette[i];
      if (this.used[i] && p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) return i;
    }
    for (let i = 1; i < 256; i++) {
      if (!this.used[i]) {
        this.used[i] = true;
        this.palette[i] = [...rgb, 255];
        return i;
      }
    }
    let best = 1;
    let bestD = Infinity;
    for (let i = 1; i < 256; i++) {
      const p = this.palette[i];
      const d = (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    }
    return best;
  }

  // Drop palette slots no voxel references any more, so they can be reused.
  compactPalette() {
    const live = new Array(256).fill(false);
    for (const m of this.models.values()) for (const v of m.voxels) live[v] = true;
    for (let i = 1; i < 256; i++) {
      if (!live[i]) {
        this.used[i] = false;
        this.materials.delete(i);
      }
    }
  }

  // Sorted world-space bounds of every occupied voxel, or null when the scene is empty.
  worldBounds(names) {
    let min = null;
    let max = null;
    for (const m of this.models.values()) {
      if (names && !names.includes(m.name)) continue;
      const b = m.bounds();
      if (!b) continue;
      const lo = b.min.map((v, i) => v + m.position[i]);
      const hi = b.max.map((v, i) => v + m.position[i]);
      min = min ? min.map((v, i) => Math.min(v, lo[i])) : lo;
      max = max ? max.map((v, i) => Math.max(v, hi[i])) : hi;
    }
    return min ? { min, max } : null;
  }
}

// ---------- writer ----------

class Writer {
  constructor() {
    this.parts = [];
  }
  int(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
  }
  bytes(b) {
    this.parts.push(Buffer.from(b));
  }
  string(s) {
    const b = Buffer.from(s, 'utf8');
    this.int(b.length);
    this.parts.push(b);
  }
  dict(d) {
    const entries = Object.entries(d);
    this.int(entries.length);
    for (const [k, v] of entries) {
      this.string(k);
      this.string(String(v));
    }
  }
  buffer() {
    return Buffer.concat(this.parts);
  }
}

function chunk(id, content, children = Buffer.alloc(0)) {
  const head = Buffer.alloc(12);
  head.write(id, 0, 'ascii');
  head.writeInt32LE(content.length, 4);
  head.writeInt32LE(children.length, 8);
  return Buffer.concat([head, content, children]);
}

export function encodeVox(scene) {
  const models = [...scene.models.values()];
  if (models.length === 0) throw new Error('The scene has no models to save.');
  const chunks = [];

  for (const m of models) {
    const size = new Writer();
    size.int(m.size[0]);
    size.int(m.size[1]);
    size.int(m.size[2]);
    chunks.push(chunk('SIZE', size.buffer()));

    const n = m.count();
    const xyzi = Buffer.alloc(4 + n * 4);
    xyzi.writeInt32LE(n, 0);
    let o = 4;
    const [sx, sy, sz] = m.size;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const c = m.voxels[m.index(x, y, z)];
          if (!c) continue;
          xyzi[o++] = x;
          xyzi[o++] = y;
          xyzi[o++] = z;
          xyzi[o++] = c;
        }
    chunks.push(chunk('XYZI', xyzi));
  }

  // Scene graph: root transform(0) -> group(1) -> [transform -> shape] per model.
  const root = new Writer();
  root.int(0);
  root.dict({});
  root.int(1);
  root.int(-1);
  root.int(-1);
  root.int(1);
  root.dict({});
  chunks.push(chunk('nTRN', root.buffer()));

  const group = new Writer();
  group.int(1);
  group.dict({});
  group.int(models.length);
  models.forEach((_, i) => group.int(2 + i * 2));
  chunks.push(chunk('nGRP', group.buffer()));

  models.forEach((m, i) => {
    const id = 2 + i * 2;
    // MagicaVoxel stores the translation of the model's center: local voxel v sits at
    // world v - floor(size/2) + _t.
    const t = m.position.map((p, k) => p + Math.floor(m.size[k] / 2));
    const trn = new Writer();
    trn.int(id);
    trn.dict({ _name: m.name });
    trn.int(id + 1);
    trn.int(-1);
    trn.int(0);
    trn.int(1);
    trn.dict({ _t: t.join(' ') });
    chunks.push(chunk('nTRN', trn.buffer()));

    const shp = new Writer();
    shp.int(id + 1);
    shp.dict({});
    shp.int(1);
    shp.int(i);
    shp.dict({});
    chunks.push(chunk('nSHP', shp.buffer()));
  });

  const layer = new Writer();
  layer.int(0);
  layer.dict({ _name: 'voxel-mcp' });
  layer.int(-1);
  chunks.push(chunk('LAYR', layer.buffer()));

  // RGBA entry k holds palette index k+1.
  const rgba = Buffer.alloc(256 * 4);
  for (let i = 1; i < 256; i++) Buffer.from(scene.palette[i]).copy(rgba, (i - 1) * 4);
  chunks.push(chunk('RGBA', rgba));

  for (let i = 0; i < 256; i++) {
    const w = new Writer();
    w.int(i);
    w.dict(scene.materials.get(i) ?? DEFAULT_MATERIAL);
    chunks.push(chunk('MATL', w.buffer()));
  }

  const header = Buffer.alloc(8);
  header.write('VOX ', 0, 'ascii');
  header.writeInt32LE(200, 4);
  return Buffer.concat([header, chunk('MAIN', Buffer.alloc(0), Buffer.concat(chunks))]);
}

// ---------- reader ----------

export function decodeVox(buf) {
  if (buf.toString('ascii', 0, 4) !== 'VOX ') throw new Error('Not a .vox file (missing "VOX " header).');
  let p = 0;
  const int = () => {
    const v = buf.readInt32LE(p);
    p += 4;
    return v;
  };
  const str = () => {
    const n = int();
    const s = buf.toString('utf8', p, p + n);
    p += n;
    return s;
  };
  const dict = () => {
    const d = {};
    for (let n = int(); n > 0; n--) {
      const k = str();
      d[k] = str();
    }
    return d;
  };

  const sizes = [];
  const voxelLists = [];
  const transforms = new Map(); // node id -> { child, name, t }
  const groups = new Map();
  const shapes = new Map(); // node id -> model id
  let rgba = null;
  const materials = new Map();

  let o = 20; // skip header and MAIN chunk header
  while (o + 12 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const n = buf.readInt32LE(o + 4);
    const m = buf.readInt32LE(o + 8);
    p = o + 12;
    if (id === 'SIZE') sizes.push([int(), int(), int()]);
    else if (id === 'XYZI') {
      const count = int();
      voxelLists.push(buf.subarray(p, p + count * 4));
    } else if (id === 'RGBA') rgba = buf.subarray(p, p + 1024);
    else if (id === 'nTRN') {
      const nid = int();
      const attrs = dict();
      const child = int();
      int();
      int();
      const frames = int();
      const f = frames > 0 ? dict() : {};
      const t = f._t ? f._t.split(' ').map(Number) : [0, 0, 0];
      transforms.set(nid, { child, name: attrs._name, t, rotated: Boolean(f._r) });
    } else if (id === 'nGRP') {
      const nid = int();
      dict();
      const kids = [];
      for (let k = int(); k > 0; k--) kids.push(int());
      groups.set(nid, kids);
    } else if (id === 'nSHP') {
      const nid = int();
      dict();
      int();
      shapes.set(nid, int());
    } else if (id === 'MATL') {
      const mid = int();
      materials.set(mid, dict());
    }
    o += 12 + n + m;
  }

  const scene = new Scene();
  if (rgba) {
    for (let i = 1; i < 256; i++) scene.palette[i] = [...rgba.subarray((i - 1) * 4, i * 4)];
  }
  for (const [i, d] of materials) if (i > 0 && d._type && d._type !== '_diffuse') scene.materials.set(i, d);

  // Walk the scene graph to accumulate translations (rotations are not applied).
  const placements = new Map(); // model id -> { name, t }
  const warnings = [];
  const walk = (nodeId, offset, name) => {
    if (transforms.has(nodeId)) {
      const tr = transforms.get(nodeId);
      if (tr.rotated) warnings.push(`Rotation on "${tr.name ?? nodeId}" was ignored.`);
      walk(tr.child, offset.map((v, k) => v + tr.t[k]), tr.name ?? name);
    } else if (groups.has(nodeId)) {
      for (const c of groups.get(nodeId)) walk(c, offset, name);
    } else if (shapes.has(nodeId)) {
      placements.set(shapes.get(nodeId), { name, t: offset });
    }
  };
  if (transforms.has(0)) walk(0, [0, 0, 0], undefined);

  const taken = new Set();
  sizes.forEach((size, i) => {
    const place = placements.get(i) ?? { t: size.map((s) => Math.floor(s / 2)) };
    let name = place.name || `model${i}`;
    while (taken.has(name)) name += '_';
    taken.add(name);
    const position = place.t.map((v, k) => v - Math.floor(size[k] / 2));
    const model = scene.addModel(name, size, position);
    const list = voxelLists[i];
    for (let k = 0; k < list.length; k += 4) {
      model.set(list[k], list[k + 1], list[k + 2], list[k + 3]);
      scene.used[list[k + 3]] = true;
    }
  });
  scene.used[0] = false;
  if (!rgba) warnings.push('File has no RGBA palette chunk; colors are placeholders.');
  return { scene, warnings };
}
