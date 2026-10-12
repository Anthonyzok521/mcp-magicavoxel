// glTF 2.0 binary (.glb) export: one greedy-meshed node per model, arranged in the rig hierarchy.
// Colors come from a 256x1 palette texture (UVs point at palette entries), so a game can
// recolor skins or teams by swapping that texture.
import { pivotOf } from './rig.mjs';
import { encodePng } from './render.mjs';

// MagicaVoxel is z-up with the front facing -y; glTF is y-up with the front facing +z.
const toGltf = (v, s) => [v[0] * s, v[2] * s, -v[1] * s];

// Greedy meshing: merges coplanar faces of the same color into rectangles.
function meshModel(m) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const size = m.size;
  const at = (p) => (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= size[0] || p[1] >= size[1] || p[2] >= size[2] ? 0 : m.voxels[m.index(...p)]);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const mask = new Int16Array(size[u] * size[v]);
    for (const s of [-1, 1]) {
      for (let i = 0; i < size[d]; i++) {
        for (let b = 0; b < size[v]; b++)
          for (let a = 0; a < size[u]; a++) {
            const p = [0, 0, 0];
            p[d] = i;
            p[u] = a;
            p[v] = b;
            const c = at(p);
            p[d] = i + s;
            mask[a + b * size[u]] = c && !at(p) ? c : 0;
          }
        for (let b = 0; b < size[v]; b++)
          for (let a = 0; a < size[u]; ) {
            const c = mask[a + b * size[u]];
            if (!c) {
              a++;
              continue;
            }
            let w = 1;
            while (a + w < size[u] && mask[a + w + b * size[u]] === c) w++;
            let h = 1;
            grow: while (b + h < size[v]) {
              for (let k = 0; k < w; k++) if (mask[a + k + (b + h) * size[u]] !== c) break grow;
              h++;
            }
            for (let y = 0; y < h; y++) for (let k = 0; k < w; k++) mask[a + k + (b + y) * size[u]] = 0;

            const corner = (du, dv) => {
              const p = [0, 0, 0];
              p[d] = s > 0 ? i + 1 : i;
              p[u] = a + du;
              p[v] = b + dv;
              return p;
            };
            let quad = [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)];
            const n = [0, 0, 0];
            n[d] = s;
            // Order vertices counter-clockwise when seen from outside.
            const e1 = quad[1].map((x, k) => x - quad[0][k]);
            const e2 = quad[2].map((x, k) => x - quad[0][k]);
            const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            if (cr[d] * s < 0) quad = [quad[0], quad[3], quad[2], quad[1]];
            const base = positions.length;
            for (const q of quad) {
              positions.push(q);
              normals.push(n);
              uvs.push([(c + 0.5) / 256, 0.5]);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            a += w;
          }
      }
    }
  }
  return { positions, normals, uvs, indices };
}


// Bones in parent-before-child order.
function orderBones(skeleton) {
  const all = [...skeleton.models.values()];
  const names = new Set(all.map((m) => m.name));
  const ordered = [];
  const visit = (m) => {
    if (ordered.includes(m)) return;
    if (m.parent && names.has(m.parent)) visit(skeleton.model(m.parent));
    ordered.push(m);
  };
  all.forEach(visit);
  return ordered;
}

// origin "feet": the occupied voxels are centered on x/y and rest on z = 0 (the ground);
// origin "world": MagicaVoxel world coordinates are kept as they are.
// skeleton: a Scene whose models become bones (a glTF skin). Each exported model is then a
// mesh rigidly bound to the bone of the same name, or to the bone named by its parent, so
// clothing exported with the body's skeleton deforms with the body. Bounds for "feet" come
// from the skeleton, so every file bound to the same skeleton lines up.
export function buildGlb(scene, { voxelSize = 0.05, models, name = 'voxel_scene', origin = 'feet', skeleton = null } = {}) {
  const selected = [...scene.models.values()].filter((m) => !models || models.includes(m.name));
  if (!selected.length) throw new Error('No models to export.');
  const names = new Set(selected.map((m) => m.name));
  const bounds = skeleton ? skeleton.worldBounds() : scene.worldBounds([...names]);
  const rootOrigin =
    origin === 'feet' && bounds ? [(bounds.min[0] + bounds.max[0] + 1) / 2, (bounds.min[1] + bounds.max[1] + 1) / 2, bounds.min[2]] : [0, 0, 0];
  const rel = (p, base) => toGltf(p.map((x, k) => x - base[k]), voxelSize);

  const bin = [];
  let binLength = 0;
  const bufferViews = [];
  const accessors = [];
  const addView = (buf, target) => {
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      bin.push(Buffer.alloc(pad));
      binLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: buf.length, ...(target ? { target } : {}) });
    bin.push(buf);
    binLength += buf.length;
    return bufferViews.length - 1;
  };
  const typed = { 5125: Uint32Array, 5123: Uint16Array, 5126: Float32Array };
  const addAccessor = (rows, type, componentType, target, withBounds) => {
    const width = rows[0].length ?? 1;
    const buf = Buffer.from(new typed[componentType](rows.flat()).buffer);
    const acc = { bufferView: addView(buf, target), componentType, count: rows.length, type };
    if (withBounds) {
      acc.min = Array(width).fill(Infinity);
      acc.max = Array(width).fill(-Infinity);
      for (const r of rows)
        for (let k = 0; k < width; k++) {
          if (r[k] < acc.min[k]) acc.min[k] = r[k];
          if (r[k] > acc.max[k]) acc.max[k] = r[k];
        }
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // Palette texture: entry i lives at pixel i (index 0 is unused/transparent).
  const pal = Buffer.alloc(256 * 4);
  for (let i = 1; i < 256; i++) Buffer.from(scene.palette[i]).copy(pal, i * 4);
  const imageView = addView(encodePng(pal, 256, 1, 4));

  const meshes = [];
  // Greedy mesh of model m with vertices placed relative to `base` (world voxel coordinates).
  const addMesh = (m, base, extra = {}) => {
    const mesh = meshModel(m);
    if (!mesh.indices.length) return null;
    const pos = mesh.positions.map((p) => rel(p.map((x, k) => x + m.position[k]), base));
    const attributes = {
      POSITION: addAccessor(pos, 'VEC3', 5126, 34962, true),
      NORMAL: addAccessor(mesh.normals.map((n) => toGltf(n, 1)), 'VEC3', 5126, 34962),
      TEXCOORD_0: addAccessor(mesh.uvs, 'VEC2', 5126, 34962),
    };
    if (extra.joint !== undefined) {
      attributes.JOINTS_0 = addAccessor(pos.map(() => [extra.joint, 0, 0, 0]), 'VEC4', 5123, 34962);
      attributes.WEIGHTS_0 = addAccessor(pos.map(() => [1, 0, 0, 0]), 'VEC4', 5126, 34962);
    }
    meshes.push({
      name: m.name,
      primitives: [{ attributes, indices: addAccessor(mesh.indices.map((i) => [i]), 'SCALAR', 5125, 34963), material: 0 }],
    });
    return meshes.length - 1;
  };

  const nodes = [];
  const sceneRoots = [];
  let skins;
  const addChild = (parentIndex, childIndex) => (nodes[parentIndex].children ??= []).push(childIndex);

  if (skeleton) {
    const bones = orderBones(skeleton);
    const boneIndex = new Map();
    for (const b of bones) {
      nodes.push({ name: b.name });
      boneIndex.set(b.name, nodes.length - 1);
    }
    for (const b of bones) {
      const parent = b.parent && boneIndex.has(b.parent) ? skeleton.model(b.parent) : null;
      nodes[boneIndex.get(b.name)].translation = rel(pivotOf(b), parent ? pivotOf(parent) : rootOrigin);
      if (parent) addChild(boneIndex.get(parent.name), boneIndex.get(b.name));
      else sceneRoots.push(boneIndex.get(b.name));
    }
    for (const [attachName, a] of scene.attachments) {
      if (!a.parent || !boneIndex.has(a.parent)) continue;
      nodes.push({ name: attachName, translation: rel(a.position, pivotOf(skeleton.model(a.parent))) });
      addChild(boneIndex.get(a.parent), nodes.length - 1);
    }
    // Rest pose has no rotations, so each inverse bind matrix is a translation (column-major).
    const ibm = bones.map((b) => {
      const g = rel(pivotOf(b), rootOrigin);
      return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -g[0], -g[1], -g[2], 1];
    });
    skins = [{ name: 'skeleton', joints: bones.map((b) => boneIndex.get(b.name)), inverseBindMatrices: addAccessor(ibm, 'MAT4', 5126) }];
    if (sceneRoots.length === 1) skins[0].skeleton = sceneRoots[0];
    for (const m of selected) {
      const bone = boneIndex.has(m.name) ? m.name : m.parent;
      if (!bone || !boneIndex.has(bone)) throw new Error(`"${m.name}" is not a bone and its parent is not a bone of the skeleton.`);
      const mesh = addMesh(m, rootOrigin, { joint: bones.findIndex((b) => b.name === bone) });
      if (mesh === null) continue;
      // Skinned mesh nodes are scene roots: glTF ignores their transform anyway.
      nodes.push({ name: boneIndex.has(m.name) ? `${m.name}_mesh` : m.name, mesh, skin: 0 });
      sceneRoots.push(nodes.length - 1);
    }
  } else {
    nodes.push({ name, children: [] });
    sceneRoots.push(0);
    const nodeIndex = new Map();
    for (const m of selected) {
      const node = { name: m.name };
      const mesh = addMesh(m, pivotOf(m));
      if (mesh !== null) node.mesh = mesh;
      nodes.push(node);
      nodeIndex.set(m.name, nodes.length - 1);
    }
    // Parent each node and express its pivot relative to the parent's pivot.
    for (const m of selected) {
      const parent = m.parent && names.has(m.parent) ? scene.model(m.parent) : null;
      nodes[nodeIndex.get(m.name)].translation = rel(pivotOf(m), parent ? pivotOf(parent) : rootOrigin);
      addChild(parent ? nodeIndex.get(parent.name) : 0, nodeIndex.get(m.name));
    }
    for (const [attachName, a] of scene.attachments) {
      if (a.parent && !names.has(a.parent)) continue;
      nodes.push({ name: attachName, translation: rel(a.position, a.parent ? pivotOf(scene.model(a.parent)) : rootOrigin) });
      addChild(a.parent ? nodeIndex.get(a.parent) : 0, nodes.length - 1);
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'mcp-magicavoxel' },
    scene: 0,
    scenes: [{ name, nodes: sceneRoots }],
    nodes,
    ...(skins ? { skins } : {}),
    meshes,
    materials: [
      {
        name: 'voxel_palette',
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    images: [{ name: 'palette', bufferView: imageView, mimeType: 'image/png' }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  if (!meshes.length) {
    for (const key of ['meshes', 'materials', 'textures', 'samplers', 'images']) delete json[key];
  }

  const pad4 = (buf, fill) => {
    const pad = (4 - (buf.length % 4)) % 4;
    return pad ? Buffer.concat([buf, Buffer.alloc(pad, fill)]) : buf;
  };
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBuf = pad4(Buffer.concat(bin), 0);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const body = Buffer.concat([chunk(0x4e4f534a, jsonBuf), chunk(0x004e4942, binBuf)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  const stats = {
    nodes: nodes.length,
    meshes: meshes.length,
    bones: skins ? skins[0].joints.length : 0,
    triangles: meshes.reduce((n, mm) => n + accessors[mm.primitives[0].indices].count / 3, 0),
  };
  return { glb: Buffer.concat([header, body]), stats };
}
