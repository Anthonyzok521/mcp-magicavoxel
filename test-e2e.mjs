// End-to-end smoke test: drives the server over stdio like Claude Code does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Usage: node test-e2e.mjs [outputDir] [magicaVoxelSamplesDir]
const out = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-mcp-'));
const samples = process.argv[3];
console.log('output:', out);
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.mjs'], env: { ...process.env, VOX_OUTPUT_DIR: out } }));
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) {
    if (c.type === 'text') console.log(`[${name}]${r.isError ? ' ERROR' : ''} ${c.text}`);
    else fs.writeFileSync(path.join(out, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`), Buffer.from(c.data, 'base64'));
  }
  return r;
};

// A small tree with a glowing lantern.
await call('create_model', { name: 'tree', size: [21, 21, 30] });
await call('fill_box', { model: 'tree', from: [0, 0, 0], to: [20, 20, 0], color: '#4a7a2c' });
await call('fill_cylinder', { model: 'tree', base: [10, 10, 1], axis: 'z', length: 14, radius: 2, top_radius: 1.5, color: '#6b4226' });
await call('fill_sphere', { model: 'tree', center: [10, 10, 18], radius: [8, 8, 7], color: '#2f8f3a' });
await call('fill_expression', { model: 'tree', code: "current === '#2f8f3a' && (x * 7 + y * 13 + z * 5) % 9 === 0 ? '#58c24a' : null" });
await call('create_model', { name: 'lantern', size: [3, 3, 4], position: [24, 9, 1] });
await call('fill_box', { model: 'lantern', from: [0, 0, 0], to: [2, 2, 3], color: '#ffd27a' });
await call('set_material', { color: '#ffd27a', type: 'emit', power: 3 });
await call('set_voxels', { model: 'lantern', voxels: [{ x: 9, y: 9, z: 9, color: '#fff' }] });
await call('fill_box', { model: 'nope', from: [0, 0, 0], to: [1, 1, 1], color: '#fff' });
await call('get_scene_info');
await call('render_preview', { views: ['iso', 'front', 'top'] });
await call('save_vox', { file: 'tree' });
await call('save_vox', { file: 'tree' });
await call('load_vox', { file: 'tree' });
await call('get_scene_info');

for (const f of samples ? ['chr_knight.vox', 'castle.vox', 'cars.vox'] : []) {
  await call('load_vox', { file: path.join(samples, f) });
  const t = Date.now();
  await call('render_preview', { views: ['iso'] });
  console.log(`  render ${f}: ${Date.now() - t} ms`);
}
await client.close();
