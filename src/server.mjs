#!/usr/bin/env node
// MCP server that lets an agent build voxel models and save them as MagicaVoxel .vox files.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Scene, MAX_DIM, encodeVox, decodeVox, toHex } from './vox.mjs';
import { render, VIEW_NAMES } from './render.mjs';
import { pivotOf, poseTransforms, hasRig, writeRig, readRig } from './rig.mjs';
import { buildGlb } from './glb.mjs';

const OUTPUT_DIR = process.env.VOX_OUTPUT_DIR || process.cwd();
const UNDO_LIMIT = 30;
const UNDO_BYTES = 256 * 1024 * 1024;
let scene = new Scene();
const history = []; // scene snapshots taken before each change, newest last

const vec3 = z.array(z.number().int()).length(3);
const color = z
  .string()
  .describe('Hex color like "#ff8800", or "empty" to erase voxels.');
const modelName = z.string().describe('Name of a model created with create_model.');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

// Registers a tool. Tools that change the scene snapshot it first so undo can restore it,
// and a failing change rolls back automatically.
function tool(name, description, inputSchema, handler, { readOnly = false } = {}) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    const before = readOnly ? null : scene.clone();
    try {
      const result = await handler(args);
      if (before) {
        history.push(before);
        const bytes = (s) => [...s.models.values()].reduce((n, m) => n + m.voxels.length, 0);
        let total = history.reduce((n, s) => n + bytes(s), 0);
        while (history.length > 1 && (history.length > UNDO_LIMIT || total > UNDO_BYTES)) total -= bytes(history.shift());
      }
      return result;
    } catch (e) {
      if (before) scene = before;
      return fail(e);
    }
  });
}

// Applies color index c to every voxel where test(x,y,z) is true, inside the given local box.
// Returns how many voxels actually changed.
function paint(model, c, lo, hi, test) {
  const from = lo.map((v) => Math.max(0, Math.floor(v)));
  const to = hi.map((v, k) => Math.min(model.size[k] - 1, Math.ceil(v)));
  let n = 0;
  for (let z = from[2]; z <= to[2]; z++)
    for (let y = from[1]; y <= to[1]; y++)
      for (let x = from[0]; x <= to[0]; x++) {
        const i = model.index(x, y, z);
        if (model.voxels[i] !== c && test(x, y, z)) {
          model.voxels[i] = c;
          n++;
        }
      }
  return n;
}

const done = (model, n, c) =>
  text(`${c ? 'Painted' : 'Erased'} ${n} voxels in "${model.name}" (now ${model.count()} voxels).`);

const server = new McpServer({ name: 'voxel', version: '1.1.0' });

tool(
  'new_scene',
  'Discard every model and start an empty scene.',
  {},
  async () => {
    scene = new Scene();
    return text('Started a new empty scene.');
  },
);

tool(
  'create_model',
  `Create an empty model (one MagicaVoxel object). Axes: x = right, y = depth (front is low y), z = up. ` +
    `Each dimension is 1-${MAX_DIM}. Use several models with different positions for scenes larger than ${MAX_DIM}.`,
  {
    name: z.string(),
    size: vec3.describe('[x, y, z] dimensions in voxels.'),
    position: vec3.optional().describe('World position of the model\'s corner voxel (0,0,0). Default [0,0,0].'),
  },
  async ({ name, size, position }) => {
    const m = scene.addModel(name, size, position ?? [0, 0, 0]);
    return text(`Created "${m.name}" with size ${size.join('x')} at ${m.position.join(',')}.`);
  },
);

tool(
  'delete_model',
  'Remove a model from the scene.',
  { model: modelName },
  async ({ model }) => {
    scene.model(model);
    scene.models.delete(model);
    const orphans = [...scene.models.values()].filter((m) => m.parent === model);
    for (const m of orphans) m.parent = null;
    for (const [name, a] of scene.attachments) if (a.parent === model) scene.attachments.delete(name);
    scene.compactPalette();
    return text(`Deleted "${model}".${orphans.length ? ` ${orphans.map((m) => m.name).join(', ')} no longer have a parent.` : ''}`);
  },
);

tool(
  'move_model',
  'Set the world position of a model (its local voxel (0,0,0)).',
  { model: modelName, position: vec3 },
  async ({ model, position }) => {
    scene.model(model).position = position;
    return text(`Moved "${model}" to ${position.join(',')}.`);
  },
);

tool(
  'set_voxels',
  'Set individual voxels. Coordinates are local to the model.',
  {
    model: modelName,
    voxels: z
      .array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), color }))
      .describe('List of voxels to set.'),
  },
  async ({ model, voxels }) => {
    const m = scene.model(model);
    let n = 0;
    let outside = 0;
    for (const v of voxels) (m.set(v.x, v.y, v.z, scene.colorIndex(v.color)) ? n++ : outside++);
    return text(`Set ${n} voxels in "${model}"${outside ? `; ${outside} were outside the model and ignored` : ''}.`);
  },
);

tool(
  'fill_box',
  'Fill (or erase) an axis-aligned box between two corners, inclusive. Parts outside the model are clipped. ' +
    'bevel cuts its edges at 45 degrees for a chunky low-poly look.',
  {
    model: modelName,
    from: vec3,
    to: vec3,
    color,
    hollow: z.boolean().optional().describe('Only paint the outer shell, one voxel thick.'),
    bevel: z.number().int().min(0).optional().describe('Voxels cut from every edge at 45 degrees. Default 0.'),
    bevel_axes: z
      .enum(['all', 'x', 'y', 'z'])
      .optional()
      .describe('"all" (default) bevels every edge; "z" only the vertical edges (edges parallel to z), and so on.'),
  },
  async ({ model, from, to, color, hollow, bevel = 0, bevel_axes = 'all' }) => {
    const m = scene.model(model);
    const c = scene.colorIndex(color);
    const lo = from.map((v, k) => Math.min(v, to[k]));
    const hi = from.map((v, k) => Math.max(v, to[k]));
    // An edge parallel to axis k is cut where the distances to the two other faces add up to less than bevel.
    const edges = bevel_axes === 'all' ? [0, 1, 2] : [{ x: 0, y: 1, z: 2 }[bevel_axes]];
    const inside = (p) => {
      if (p.some((v, k) => v < lo[k] || v > hi[k])) return false;
      if (!bevel) return true;
      const d = p.map((v, k) => Math.min(v - lo[k], hi[k] - v));
      return edges.every((k) => {
        const [a, b] = [0, 1, 2].filter((j) => j !== k);
        return d[a] + d[b] >= bevel;
      });
    };
    const n = paint(m, c, lo, hi, (x, y, z) => {
      if (!inside([x, y, z])) return false;
      if (!hollow) return true;
      return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, e]) => !inside([x + a, y + b, z + e]));
    });
    return done(m, n, c);
  },
);

tool(
  'fill_sphere',
  'Fill (or erase) a sphere or ellipsoid. Parts outside the model are clipped.',
  {
    model: modelName,
    center: z.array(z.number()).length(3).describe('Center in local voxel coordinates (fractions allowed, e.g. 7.5).'),
    radius: z.union([z.number().positive(), z.array(z.number().positive()).length(3)]).describe('Radius, or [rx, ry, rz] for an ellipsoid.'),
    color,
    hollow: z.boolean().optional().describe('Only paint a one-voxel shell.'),
  },
  async ({ model, center, radius, color, hollow }) => {
    const m = scene.model(model);
    const c = scene.colorIndex(color);
    const r = Array.isArray(radius) ? radius : [radius, radius, radius];
    const inside = (x, y, z) =>
      ((x - center[0]) / r[0]) ** 2 + ((y - center[1]) / r[1]) ** 2 + ((z - center[2]) / r[2]) ** 2 <= 1;
    const n = paint(
      m,
      c,
      center.map((v, k) => v - r[k]),
      center.map((v, k) => v + r[k]),
      (x, y, z) =>
        inside(x, y, z) &&
        (!hollow || !(inside(x + 1, y, z) && inside(x - 1, y, z) && inside(x, y + 1, z) && inside(x, y - 1, z) && inside(x, y, z + 1) && inside(x, y, z - 1))),
    );
    return done(m, n, c);
  },
);

tool(
  'fill_cylinder',
  'Fill (or erase) a cylinder or cone along an axis. Parts outside the model are clipped.',
  {
    model: modelName,
    base: z.array(z.number()).length(3).describe('Center of the base disc in local coordinates.'),
    axis: z.enum(['x', 'y', 'z']).describe('Direction the cylinder extends from the base (positive direction).'),
    length: z.number().int().positive(),
    radius: z.number().positive(),
    top_radius: z.number().min(0).optional().describe('Radius at the far end; set it to make a cone or tapered shape. Default = radius.'),
    color,
    hollow: z.boolean().optional().describe('Only paint the side wall, one voxel thick.'),
  },
  async ({ model, base, axis, length, radius, top_radius, color, hollow }) => {
    const m = scene.model(model);
    const c = scene.colorIndex(color);
    const a = { x: 0, y: 1, z: 2 }[axis];
    const [u, w] = [0, 1, 2].filter((k) => k !== a);
    const r1 = top_radius ?? radius;
    const rAt = (p) => radius + (r1 - radius) * (length > 1 ? (p - base[a]) / (length - 1) : 0);
    const dist = (p) => Math.hypot(p[u] - base[u], p[w] - base[w]);
    const R = Math.max(radius, r1);
    const lo = [...base];
    const hi = [...base];
    lo[u] -= R;
    hi[u] += R;
    lo[w] -= R;
    hi[w] += R;
    hi[a] = base[a] + length - 1;
    const n = paint(m, c, lo, hi, (x, y, z) => {
      const p = [x, y, z];
      if (p[a] < base[a] || p[a] > base[a] + length - 1) return false;
      const r = rAt(p[a]);
      const d = dist(p);
      return d <= r && (!hollow || d > r - 1);
    });
    return done(m, n, c);
  },
);

tool(
  'draw_line',
  'Draw a straight line of voxels between two points, optionally thick.',
  {
    model: modelName,
    from: vec3,
    to: vec3,
    color,
    thickness: z.number().int().min(1).optional().describe('Line diameter in voxels. Default 1.'),
  },
  async ({ model, from, to, color, thickness = 1 }) => {
    const m = scene.model(model);
    const c = scene.colorIndex(color);
    const steps = Math.max(...from.map((v, k) => Math.abs(to[k] - v)), 1);
    // Brush of `thickness` voxels per axis (even sizes extend toward +), trimmed to a ball.
    const lo = -Math.floor((thickness - 1) / 2);
    const hi = Math.ceil((thickness - 1) / 2);
    const mid = (lo + hi) / 2;
    const reach = thickness / 2 + 0.01;
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const p = from.map((v, k) => Math.round(v + ((to[k] - v) * i) / steps));
      for (let dz = lo; dz <= hi; dz++)
        for (let dy = lo; dy <= hi; dy++)
          for (let dx = lo; dx <= hi; dx++) {
            if (Math.hypot(dx - mid, dy - mid, dz - mid) > reach) continue;
            const [x, y, z] = [p[0] + dx, p[1] + dy, p[2] + dz];
            if (m.inBounds(x, y, z) && m.get(x, y, z) !== c) {
              m.set(x, y, z, c);
              n++;
            }
          }
    }
    return text(`Drew a line of ${steps + 1} steps in "${model}", changing ${n} voxels (now ${m.count()} voxels).`);
  },
);

tool(
  'fill_expression',
  'Procedurally paint voxels with a JavaScript expression evaluated for every voxel in a region. ' +
    'Variables: x, y, z (local coords), sx, sy, sz (model size), current (current color hex or null), and Math. ' +
    'Return a hex color to paint, "empty" to erase, or null/undefined/false to leave the voxel unchanged. ' +
    'A plain expression is used as the return value; a body containing "return" runs as a function body. ' +
    'Example: "(x+y+z) % 2 === 0 ? \'#ffffff\' : \'#000000\'". Limited to 20 seconds.',
  {
    model: modelName,
    code: z.string(),
    from: vec3.optional().describe('Region start (inclusive). Default: whole model.'),
    to: vec3.optional().describe('Region end (inclusive). Default: whole model.'),
  },
  async ({ model, code, from, to }) => {
    const m = scene.model(model);
    const body = /\breturn\b/.test(code) ? code : `return (${code});`;
    const lo = (from ?? [0, 0, 0]).map((v) => Math.max(0, v));
    const hi = (to ?? m.size.map((s) => s - 1)).map((v, k) => Math.min(m.size[k] - 1, v));
    let painted = 0;
    let erased = 0;
    const cache = new Map();
    const context = vm.createContext({
      lo,
      hi,
      sx: m.size[0],
      sy: m.size[1],
      sz: m.size[2],
      get: (x, y, z) => {
        const c = m.get(x, y, z);
        return c ? toHex(scene.palette[c]) : null;
      },
      put: (x, y, z, result) => {
        if (result === null || result === undefined || result === false) return;
        let c = cache.get(result);
        if (c === undefined) cache.set(result, (c = scene.colorIndex(result)));
        const i = m.index(x, y, z);
        if (m.voxels[i] === c) return;
        m.voxels[i] = c;
        c ? painted++ : erased++;
      },
    });
    const script = new vm.Script(`
      const f = function (x, y, z, sx, sy, sz, current) { ${body} };
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let x = lo[0]; x <= hi[0]; x++)
            put(x, y, z, f(x, y, z, sx, sy, sz, get(x, y, z)));
    `);
    script.runInContext(context, { timeout: 20000 });
    return text(`Expression painted ${painted} and erased ${erased} voxels in "${model}" (now ${m.count()} voxels).`);
  },
);

tool(
  'mirror',
  'Mirror one half of a model onto the other half (useful for symmetric characters and buildings).',
  {
    model: modelName,
    axis: z.enum(['x', 'y', 'z']),
    keep: z.enum(['low', 'high']).describe('"low" copies the low-coordinate half onto the high half; "high" does the opposite.'),
  },
  async ({ model, axis, keep }) => {
    const m = scene.model(model);
    const a = { x: 0, y: 1, z: 2 }[axis];
    const s = m.size[a];
    const [sx, sy, sz] = m.size;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const p = [x, y, z];
          const isSource = keep === 'low' ? p[a] < Math.floor(s / 2) : p[a] >= Math.ceil(s / 2);
          if (!isSource) continue;
          const q = [...p];
          q[a] = s - 1 - p[a];
          m.voxels[m.index(...q)] = m.voxels[m.index(...p)];
        }
    scene.compactPalette();
    return text(`Mirrored "${model}" across ${axis} keeping the ${keep} half (now ${m.count()} voxels).`);
  },
);

tool(
  'set_material',
  'Give a color a MagicaVoxel render material. Materials belong to palette colors, so every voxel with this ' +
    'exact color shares it. Values are 0-1 unless noted.',
  {
    color: z.string().describe('Hex color the material applies to.'),
    type: z.enum(['diffuse', 'metal', 'glass', 'emit']),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional().describe('metal only. Default 1.'),
    transparency: z.number().min(0).max(1).optional().describe('glass only. Default 0.5.'),
    ior: z.number().min(1).max(3).optional().describe('glass refractive index. Default 1.3.'),
    emission: z.number().min(0).max(1).optional().describe('emit only. Default 1.'),
    power: z.number().int().min(0).max(4).optional().describe('emit only: light power (flux) 0-4. Default 2.'),
  },
  async ({ color, type, roughness, metalness, transparency, ior, emission, power }) => {
    if (color === 'empty') throw new Error('Materials need a real color, not "empty".');
    const i = scene.colorIndex(color);
    const ri = ior ?? 1.3;
    const mat = { _type: `_${type}`, _rough: String(roughness ?? 0.1), _ri: String(ri), _ior: String(+(ri - 1).toFixed(3)) };
    if (type === 'metal') Object.assign(mat, { _metal: String(metalness ?? 1), _sp: '1' });
    if (type === 'glass') Object.assign(mat, { _trans: String(transparency ?? 0.5), _d: '0.05' });
    if (type === 'emit') Object.assign(mat, { _emit: String(emission ?? 1), _flux: String(power ?? 2), _ldr: '0' });
    if (type === 'diffuse') scene.materials.delete(i);
    else scene.materials.set(i, mat);
    return text(`Color ${color} (palette index ${i}) now uses the ${type} material.`);
  },
);

tool(
  'replace_color',
  'Swap colors in one or more models, e.g. to make team or skin variants. Use "empty" as the target to delete ' +
    'every voxel of a color.',
  {
    pairs: z.array(z.object({ from: z.string(), to: color })).min(1).describe('Colors to replace, applied together.'),
    models: z.array(modelName).optional().describe('Models to change. Default: all.'),
  },
  async ({ pairs, models }) => {
    const targets = models ? models.map((n) => scene.model(n)) : [...scene.models.values()];
    const map = new Map();
    for (const { from, to } of pairs) map.set(scene.colorIndex(from), scene.colorIndex(to));
    const counts = new Map();
    for (const m of targets)
      for (let i = 0; i < m.voxels.length; i++) {
        const to = map.get(m.voxels[i]);
        if (to === undefined || to === m.voxels[i]) continue;
        counts.set(m.voxels[i], (counts.get(m.voxels[i]) ?? 0) + 1);
        m.voxels[i] = to;
      }
    const report = pairs.map(({ from, to }) => `${from} -> ${to}: ${counts.get(scene.colorIndex(from)) ?? 0}`);
    scene.compactPalette();
    return text(`Replaced colors in ${targets.map((m) => m.name).join(', ')}.\n${report.join('\n')}`);
  },
);

tool(
  'duplicate_model',
  'Copy a model under a new name, optionally mirrored. With mirror_plane the copy is placed on the other side of ' +
    'that world plane (e.g. axis "x" and plane 16 turns a right arm at x=0 into a left arm at x=25); its pivot is ' +
    'mirrored too, so it stays rig-ready.',
  {
    model: modelName,
    new_name: z.string(),
    mirror: z.enum(['x', 'y', 'z']).optional().describe('Flip the voxels along this axis.'),
    mirror_plane: z.number().optional().describe('World coordinate of the mirror plane along the mirror axis.'),
    position: vec3.optional().describe('Explicit world position for the copy (overrides mirror_plane placement).'),
    parent: z.string().nullable().optional().describe('Rig parent for the copy. Default: same as the source.'),
  },
  async ({ model, new_name, mirror, mirror_plane, position, parent }) => {
    const src = scene.model(model);
    if (scene.models.has(new_name)) throw new Error(`A model named "${new_name}" already exists.`);
    if (mirror_plane !== undefined && !mirror) throw new Error('mirror_plane needs mirror (the axis).');
    const copy = src.clone(new_name);
    const a = mirror ? { x: 0, y: 1, z: 2 }[mirror] : -1;
    if (mirror) {
      const [sx, sy, sz] = src.size;
      for (let z = 0; z < sz; z++)
        for (let y = 0; y < sy; y++)
          for (let x = 0; x < sx; x++) {
            const p = [x, y, z];
            p[a] = src.size[a] - 1 - p[a];
            copy.voxels[copy.index(...p)] = src.voxels[src.index(x, y, z)];
          }
    }
    // Keep the pivot at the same spot relative to the voxels.
    const localPivot = src.pivot ? src.pivot.map((v, k) => v - src.position[k]) : null;
    if (localPivot && mirror) localPivot[a] = src.size[a] - localPivot[a];
    if (mirror_plane !== undefined) copy.position[a] = 2 * mirror_plane - (src.position[a] + src.size[a]);
    if (position) copy.position = [...position];
    copy.pivot = localPivot && localPivot.map((v, k) => v + copy.position[k]);
    if (parent !== undefined) {
      if (parent !== null) scene.model(parent);
      copy.parent = parent;
    }
    scene.models.set(new_name, copy);
    poseTransforms(scene);
    return text(
      `Created "${new_name}" from "${model}"${mirror ? ` mirrored on ${mirror}` : ''} at ${copy.position.join(',')}` +
        `${copy.parent ? `, parent "${copy.parent}"` : ''}.`,
    );
  },
);

tool(
  'import_model',
  'Bring models from another .vox file into the current scene (for example an accessory designed separately). ' +
    'Colors are merged into the current palette; pivots and parents come along when the file has a .rig.json.',
  {
    file: z.string().describe('File name or absolute path.'),
    models: z.array(z.string()).optional().describe('Models to import from that file. Default: all.'),
    prefix: z.string().optional().describe('Text prepended to each imported model name to avoid clashes.'),
    offset: vec3.optional().describe('World offset added to the imported positions and pivots.'),
  },
  async ({ file, models, prefix = '', offset = [0, 0, 0] }) => {
    const p = resolvePath(file);
    const { scene: other } = decodeVox(fs.readFileSync(p));
    readRig(other, p);
    const picked = models ? models.map((n) => other.model(n)) : [...other.models.values()];
    const renamed = new Map(picked.map((m) => [m.name, prefix + m.name]));
    for (const name of renamed.values()) if (scene.models.has(name)) throw new Error(`A model named "${name}" already exists; use prefix.`);
    const remap = new Map();
    const indexFor = (i) => {
      if (!remap.has(i)) {
        const j = scene.colorIndex(toHex(other.palette[i]));
        if (other.materials.has(i) && !scene.materials.has(j)) scene.materials.set(j, { ...other.materials.get(i) });
        remap.set(i, j);
      }
      return remap.get(i);
    };
    for (const src of picked) {
      const m = scene.addModel(renamed.get(src.name), [...src.size], src.position.map((v, k) => v + offset[k]));
      for (let i = 0; i < src.voxels.length; i++) if (src.voxels[i]) m.voxels[i] = indexFor(src.voxels[i]);
      m.pivot = src.pivot && src.pivot.map((v, k) => v + offset[k]);
      m.parent = src.parent ? (renamed.get(src.parent) ?? src.parent) : null;
    }
    poseTransforms(scene);
    return text(`Imported ${[...renamed.values()].join(', ')} from ${p}.`);
  },
);

tool(
  'set_pivot',
  'Set the rig data of a model: its pivot (the joint it rotates around, in world coordinates) and its parent ' +
    'model. Children follow their parent in posed previews and in export_glb. Use anchor to place the pivot ' +
    'automatically at the top, bottom or center of the occupied voxels.',
  {
    model: modelName,
    pivot: z.array(z.number()).length(3).optional().describe('World coordinates; fractions allowed, e.g. [3.5, 6.5, 30].'),
    anchor: z.enum(['top', 'bottom', 'center']).optional().describe('Compute the pivot from the occupied bounds instead.'),
    parent: z.string().nullable().optional().describe('Parent model name, or null for a root. Omit to keep it.'),
  },
  async ({ model, pivot, anchor, parent }) => {
    const m = scene.model(model);
    if (pivot && anchor) throw new Error('Pass pivot or anchor, not both.');
    if (pivot) m.pivot = pivot;
    if (anchor) {
      const b = m.bounds();
      if (!b) throw new Error(`"${model}" is empty, so it has no bounds to anchor to.`);
      const c = b.min.map((v, k) => m.position[k] + (v + b.max[k] + 1) / 2);
      if (anchor === 'top') c[2] = m.position[2] + b.max[2] + 1;
      if (anchor === 'bottom') c[2] = m.position[2] + b.min[2];
      m.pivot = c;
    }
    if (parent !== undefined) {
      if (parent === model) throw new Error('A model cannot be its own parent.');
      if (parent !== null) scene.model(parent);
      m.parent = parent;
    }
    poseTransforms(scene); // throws on cycles, which rolls the change back
    return text(`"${model}": pivot ${pivotOf(m).join(', ')}, parent ${m.parent ?? '(none)'}.`);
  },
);

tool(
  'set_attachment',
  'Define (or remove) a named mount point such as "hat", "weapon_r" or "back". It follows its parent model in ' +
    'poses and becomes an empty node in export_glb, so accessories can be attached in the game.',
  {
    name: z.string(),
    parent: modelName.optional().describe('Model the point moves with. Required unless removing.'),
    position: z.array(z.number()).length(3).optional().describe('World coordinates. Required unless removing.'),
    remove: z.boolean().optional(),
  },
  async ({ name, parent, position, remove }) => {
    if (remove) {
      if (!scene.attachments.delete(name)) throw new Error(`No attachment named "${name}".`);
      return text(`Removed attachment "${name}".`);
    }
    if (!parent || !position) throw new Error('parent and position are required.');
    scene.model(parent);
    scene.attachments.set(name, { parent, position });
    return text(`Attachment "${name}" on "${parent}" at ${position.join(', ')}.`);
  },
);

tool(
  'undo',
  `Revert the last change to the scene (up to ${UNDO_LIMIT} steps).`,
  {},
  async () => {
    if (!history.length) throw new Error('Nothing to undo.');
    scene = history.pop();
    return text(`Undid the last change (${history.length} more step(s) available).`);
  },
  { readOnly: true },
);

tool(
  'get_scene_info',
  'Describe the current scene: models, sizes, positions, voxel counts, occupied bounds, rig and colors in use.',
  {},
  async () => {
    if (scene.models.size === 0) return text('The scene is empty. Use create_model to start.');
    const counts = new Map();
    const lines = [];
    for (const m of scene.models.values()) {
      for (const v of m.voxels) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      const b = m.bounds();
      lines.push(
        `- ${m.name}: size ${m.size.join('x')}, position ${m.position.join(',')}, ${m.count()} voxels` +
          (b ? `, occupied local ${b.min.join(',')} to ${b.max.join(',')}` : '') +
          (m.pivot || m.parent ? `; pivot ${pivotOf(m).join(',')}, parent ${m.parent ?? '(none)'}` : ''),
      );
    }
    const attach = [...scene.attachments].map(([n, a]) => `- ${n} on ${a.parent} at ${a.position.join(',')}`);
    const colors = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([i, n]) => `${toHex(scene.palette[i])} x${n}${scene.materials.has(i) ? ` (${scene.materials.get(i)._type.slice(1)})` : ''}`);
    return text(
      `Models:\n${lines.join('\n')}\n` +
        (attach.length ? `Attachments:\n${attach.join('\n')}\n` : '') +
        `Colors (${colors.length}/255): ${colors.join(', ')}`,
    );
  },
  { readOnly: true },
);

const rotation = z.array(z.number()).length(3);

tool(
  'render_preview',
  'Render the scene (or chosen models) to PNG images so you can check the result. Simple flat shading, not ' +
    `MagicaVoxel's path tracer. Views: ${VIEW_NAMES.join(', ')}. Pass pose to rotate models around their pivots ` +
    '(children follow their parents) and check how joints bend.',
  {
    views: z.array(z.enum(VIEW_NAMES)).min(1).max(4).optional().describe('Default ["iso"].'),
    models: z.array(z.string()).optional().describe('Only render these models. Default: all.'),
    size: z.number().int().min(64).max(1024).optional().describe('Image width/height in pixels. Default 512.'),
    pose: z
      .record(z.string(), rotation)
      .optional()
      .describe('Model name -> [rx, ry, rz] degrees around the MagicaVoxel x, y, z axes (applied x, then y, then z).'),
  },
  async ({ views = ['iso'], models, size = 512, pose }) => {
    const content = [];
    for (const view of views) {
      content.push({ type: 'text', text: `View: ${view}` });
      content.push({ type: 'image', data: render(scene, { view, size, models, pose }).toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  },
  { readOnly: true },
);

function resolvePath(file, ext = '.vox') {
  let p = path.isAbsolute(file) ? file : path.join(OUTPUT_DIR, file);
  if (!p.toLowerCase().endsWith(ext)) p += ext;
  return p;
}

tool(
  'save_vox',
  `Save the whole scene as a MagicaVoxel .vox file. Relative names are saved in ${OUTPUT_DIR}. When the scene ` +
    'has rig data (pivots, parents, attachments) a <name>.rig.json file is written next to it.',
  {
    file: z.string().describe('File name or absolute path. ".vox" is added if missing.'),
    overwrite: z.boolean().optional().describe('Replace an existing file. Default false.'),
  },
  async ({ file, overwrite }) => {
    const p = resolvePath(file);
    if (fs.existsSync(p) && !overwrite) throw new Error(`${p} already exists. Pass overwrite: true to replace it.`);
    scene.compactPalette();
    const buf = encodeVox(scene);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    const rig = hasRig(scene) ? `\nRig: ${writeRig(scene, p)}` : '';
    return text(`Saved ${p} (${buf.length} bytes, ${scene.models.size} model(s)).${rig}`);
  },
  { readOnly: true },
);

tool(
  'load_vox',
  'Replace the current scene with the contents of a .vox file so it can be edited. Translations are kept; ' +
    'model rotations, animation frames and render settings are not. A <name>.rig.json next to it is loaded too.',
  { file: z.string().describe('File name or absolute path.') },
  async ({ file }) => {
    const p = resolvePath(file);
    const { scene: loaded, warnings } = decodeVox(fs.readFileSync(p));
    const rig = readRig(loaded, p);
    scene = loaded;
    const names = [...scene.models.values()].map((m) => `${m.name} (${m.size.join('x')}, ${m.count()} voxels)`);
    return text(
      `Loaded ${p}: ${names.join(', ')}.` +
        (rig ? `\nRig loaded from ${rig}.` : '') +
        (warnings.length ? `\nWarnings: ${[...new Set(warnings)].join(' ')}` : ''),
    );
  },
);

tool(
  'export_glb',
  'Export the scene (or chosen models) as a glTF binary (.glb) for Godot or other engines. Each model becomes an ' +
    'optimized mesh node placed in the rig hierarchy with its origin at its pivot, so it can be rotated directly; ' +
    'attachments become empty nodes. Colors use a 256x1 palette texture (swap it in the engine to recolor). ' +
    'Axes are converted to glTF (y up, front facing +z). Render materials (metal, glass, emit) are not exported.',
  {
    file: z.string().describe('File name or absolute path. ".glb" is added if missing.'),
    voxel_size: z.number().positive().optional().describe('Meters per voxel. Default 0.05.'),
    models: z.array(z.string()).optional().describe('Only export these models. Default: all.'),
    origin: z
      .enum(['feet', 'world'])
      .optional()
      .describe('"feet" (default) centers the model and puts its lowest voxel on the ground (y = 0); "world" keeps MagicaVoxel coordinates.'),
    skinned: z
      .boolean()
      .optional()
      .describe(
        'Export a skeleton (glTF skin) instead of a node hierarchy: models become bones and each mesh is rigidly bound to ' +
          'its bone, so engines import a Skeleton3D that animation tools can drive. Attachments become bone attachments.',
      ),
    skeleton_from: z
      .string()
      .optional()
      .describe(
        'With skinned: .vox file (with .rig.json) whose models define the bones, e.g. the base character when exporting ' +
          'clothing. Each exported model is bound to the bone named by its parent. Default: the scene itself.',
      ),
    overwrite: z.boolean().optional().describe('Replace an existing file. Default false.'),
  },
  async ({ file, voxel_size = 0.05, models, origin = 'feet', skinned, skeleton_from, overwrite }) => {
    const p = resolvePath(file, '.glb');
    if (fs.existsSync(p) && !overwrite) throw new Error(`${p} already exists. Pass overwrite: true to replace it.`);
    if (models) models.forEach((n) => scene.model(n));
    if (skeleton_from && !skinned) throw new Error('skeleton_from needs skinned: true.');
    poseTransforms(scene);
    let skeleton = null;
    if (skinned) {
      if (skeleton_from) {
        const sp = resolvePath(skeleton_from);
        skeleton = decodeVox(fs.readFileSync(sp)).scene;
        readRig(skeleton, sp);
      } else skeleton = scene;
    }
    const { glb, stats } = buildGlb(scene, { voxelSize: voxel_size, models, origin, skeleton, name: path.basename(p, '.glb') });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, glb);
    return text(
      `Exported ${p} (${glb.length} bytes, ${stats.meshes} meshes, ${stats.triangles} triangles, ${stats.nodes} nodes` +
        `${stats.bones ? `, ${stats.bones} bones` : ''}).`,
    );
  },
  { readOnly: true },
);

await server.connect(new StdioServerTransport());
