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

const OUTPUT_DIR = process.env.VOX_OUTPUT_DIR || process.cwd();
let scene = new Scene();

const vec3 = z.array(z.number().int()).length(3);
const color = z
  .string()
  .describe('Hex color like "#ff8800", or "empty" to erase voxels.');
const modelName = z.string().describe('Name of a model created with create_model.');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return fail(e);
    }
  });
}

// Applies color index c to every voxel where test(x,y,z) is true, inside the given local box.
function paint(model, c, lo, hi, test) {
  const from = lo.map((v) => Math.max(0, Math.floor(v)));
  const to = hi.map((v, k) => Math.min(model.size[k] - 1, Math.ceil(v)));
  let n = 0;
  for (let z = from[2]; z <= to[2]; z++)
    for (let y = from[1]; y <= to[1]; y++)
      for (let x = from[0]; x <= to[0]; x++)
        if (test(x, y, z)) {
          model.voxels[model.index(x, y, z)] = c;
          n++;
        }
  return n;
}

const done = (model, n, c) =>
  text(`${c ? 'Painted' : 'Erased'} ${n} voxels in "${model.name}" (now ${model.count()} voxels).`);

const server = new McpServer({ name: 'voxel', version: '1.0.0' });

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
    scene.compactPalette();
    return text(`Deleted "${model}".`);
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
  'Fill (or erase) an axis-aligned box between two corners, inclusive. Parts outside the model are clipped.',
  {
    model: modelName,
    from: vec3,
    to: vec3,
    color,
    hollow: z.boolean().optional().describe('Only paint the outer shell, one voxel thick.'),
  },
  async ({ model, from, to, color, hollow }) => {
    const m = scene.model(model);
    const c = scene.colorIndex(color);
    const lo = from.map((v, k) => Math.min(v, to[k]));
    const hi = from.map((v, k) => Math.max(v, to[k]));
    const n = paint(m, c, lo, hi, (x, y, z) =>
      !hollow || x === lo[0] || x === hi[0] || y === lo[1] || y === hi[1] || z === lo[2] || z === hi[2],
    );
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
    const r = (thickness - 1) / 2;
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const p = from.map((v, k) => v + ((to[k] - v) * i) / steps);
      for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++)
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
            if (Math.hypot(dx, dy, dz) <= r + 0.01 && m.set(Math.round(p[0]) + dx, Math.round(p[1]) + dy, Math.round(p[2]) + dz, c)) n++;
    }
    return text(`Drew a line of ${steps + 1} steps in "${model}" (now ${m.count()} voxels).`);
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
        m.voxels[m.index(x, y, z)] = c;
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
  'get_scene_info',
  'Describe the current scene: models, sizes, positions, voxel counts, occupied bounds and colors in use.',
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
          (b ? `, occupied local ${b.min.join(',')} to ${b.max.join(',')}` : ''),
      );
    }
    const colors = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([i, n]) => `${toHex(scene.palette[i])} x${n}${scene.materials.has(i) ? ` (${scene.materials.get(i)._type.slice(1)})` : ''}`);
    return text(`Models:\n${lines.join('\n')}\nColors (${colors.length}/255): ${colors.join(', ')}`);
  },
);

tool(
  'render_preview',
  'Render the scene (or chosen models) to PNG images so you can check the result. Simple flat shading, not ' +
    `MagicaVoxel's path tracer. Views: ${VIEW_NAMES.join(', ')}.`,
  {
    views: z.array(z.enum(VIEW_NAMES)).min(1).max(4).optional().describe('Default ["iso"].'),
    models: z.array(z.string()).optional().describe('Only render these models. Default: all.'),
    size: z.number().int().min(64).max(1024).optional().describe('Image width/height in pixels. Default 512.'),
  },
  async ({ views = ['iso'], models, size = 512 }) => {
    const content = [];
    for (const view of views) {
      content.push({ type: 'text', text: `View: ${view}` });
      content.push({ type: 'image', data: render(scene, { view, size, models }).toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  },
);

function resolvePath(file) {
  let p = path.isAbsolute(file) ? file : path.join(OUTPUT_DIR, file);
  if (!p.toLowerCase().endsWith('.vox')) p += '.vox';
  return p;
}

tool(
  'save_vox',
  `Save the whole scene as a MagicaVoxel .vox file. Relative names are saved in ${OUTPUT_DIR}.`,
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
    return text(`Saved ${p} (${buf.length} bytes, ${scene.models.size} model(s)).`);
  },
);

tool(
  'load_vox',
  'Replace the current scene with the contents of a .vox file so it can be edited. Translations are kept; ' +
    'model rotations, animation frames and render settings are not.',
  { file: z.string().describe('File name or absolute path.') },
  async ({ file }) => {
    const p = resolvePath(file);
    const { scene: loaded, warnings } = decodeVox(fs.readFileSync(p));
    scene = loaded;
    const names = [...scene.models.values()].map((m) => `${m.name} (${m.size.join('x')}, ${m.count()} voxels)`);
    return text(`Loaded ${p}: ${names.join(', ')}.${warnings.length ? `\nWarnings: ${[...new Set(warnings)].join(' ')}` : ''}`);
  },
);

await server.connect(new StdioServerTransport());
