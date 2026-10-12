// End-to-end test: drives the server over stdio like Claude Code does and checks the results.
import assert from 'node:assert/strict';
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

let images = 0;
// Calls a tool, saves any images, and returns its text. Fails unless the error state matches.
const call = async (name, args = {}, { error = false } = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const texts = [];
  for (const c of r.content) {
    if (c.type === 'text') texts.push(c.text);
    else fs.writeFileSync(path.join(out, `${name}-${++images}.png`), Buffer.from(c.data, 'base64'));
  }
  const t = texts.join('\n');
  console.log(`[${name}]${r.isError ? ' ERROR' : ''} ${t}`);
  assert.equal(Boolean(r.isError), error, `${name} error state`);
  return t;
};

// --- Basic modelling: a small tree with a glowing lantern.
await call('create_model', { name: 'tree', size: [21, 21, 30] });
assert.match(await call('fill_box', { model: 'tree', from: [0, 0, 0], to: [20, 20, 0], color: '#4a7a2c' }), /Painted 441 /);
await call('fill_cylinder', { model: 'tree', base: [10, 10, 1], axis: 'z', length: 14, radius: 2, top_radius: 1.5, color: '#6b4226' });
await call('fill_sphere', { model: 'tree', center: [10, 10, 18], radius: [8, 8, 7], color: '#2f8f3a' });
await call('fill_expression', { model: 'tree', code: "current === '#2f8f3a' && (x * 7 + y * 13 + z * 5) % 9 === 0 ? '#58c24a' : null" });
await call('create_model', { name: 'lantern', size: [3, 3, 4], position: [24, 9, 1] });
await call('fill_box', { model: 'lantern', from: [0, 0, 0], to: [2, 2, 3], color: '#ffd27a' });
await call('set_material', { color: '#ffd27a', type: 'emit', power: 3 });
assert.match(await call('set_voxels', { model: 'lantern', voxels: [{ x: 9, y: 9, z: 9, color: '#fff' }] }), /1 were outside/);
await call('fill_box', { model: 'nope', from: [0, 0, 0], to: [1, 1, 1], color: '#fff' }, { error: true });
await call('render_preview', { views: ['iso', 'front'] });
await call('save_vox', { file: 'tree' });
await call('save_vox', { file: 'tree' }, { error: true });
assert.match(await call('load_vox', { file: 'tree' }), /tree \(21x21x30, 2402 voxels\), lantern \(3x3x4, 36 voxels\)/);

// --- Counts report only voxels that actually changed.
await call('new_scene');
await call('create_model', { name: 'box', size: [10, 10, 10] });
assert.match(await call('fill_box', { model: 'box', from: [0, 0, 0], to: [1, 1, 1], color: '#ff0000' }), /Painted 8 /);
assert.match(await call('fill_box', { model: 'box', from: [0, 0, 0], to: [1, 1, 1], color: '#ff0000' }), /Painted 0 /);
assert.match(await call('fill_box', { model: 'box', from: [0, 0, 0], to: [9, 9, 9], color: 'empty' }), /Erased 8 /);

// --- Beveled boxes: 5x5x5 = 125; bevel 1 drops the 12 edges (44 voxels), only vertical edges drops 20.
await call('create_model', { name: 'bev', size: [5, 5, 5], position: [20, 0, 0] });
assert.match(await call('fill_box', { model: 'bev', from: [0, 0, 0], to: [4, 4, 4], color: '#ff0000', bevel: 1 }), /Painted 81 /);
await call('fill_box', { model: 'bev', from: [0, 0, 0], to: [4, 4, 4], color: 'empty' });
assert.match(await call('fill_box', { model: 'bev', from: [0, 0, 0], to: [4, 4, 4], color: '#ff0000', bevel: 1, bevel_axes: 'z' }), /Painted 105 /);
await call('delete_model', { model: 'bev' });

// --- draw_line thickness 2 is really two voxels thick.
assert.match(await call('draw_line', { model: 'box', from: [0, 0, 0], to: [3, 0, 0], color: '#00ff00', thickness: 2 }), /changing 20 /);
assert.match(await call('draw_line', { model: 'box', from: [0, 5, 5], to: [4, 5, 5], color: '#0000ff', thickness: 3 }), /changing 50 /);

// --- Undo, and failed changes leave no trace.
assert.match(await call('fill_box', { model: 'box', from: [0, 0, 9], to: [9, 9, 9], color: '#ffffff' }), /now 170 voxels/);
await call('fill_expression', { model: 'box', code: 'throw new Error("boom")' }, { error: true });
assert.match(await call('undo'), /Undid/);
assert.match(await call('get_scene_info'), /box: size 10x10x10, position 0,0,0, 70 voxels/);

// --- replace_color.
assert.match(await call('replace_color', { pairs: [{ from: '#00ff00', to: '#123456' }, { from: '#0000ff', to: 'empty' }] }), /#00ff00 -> #123456: 20\n#0000ff -> empty: 50/);

// --- Rig: pivots, parents, mirrored duplicates, attachments and cycles.
await call('new_scene');
await call('create_model', { name: 'body', size: [8, 4, 10], position: [4, 0, 6] });
await call('fill_box', { model: 'body', from: [0, 0, 0], to: [7, 3, 9], color: '#a33a2f' });
await call('create_model', { name: 'arm_r', size: [2, 2, 8], position: [1, 1, 8] });
await call('fill_box', { model: 'arm_r', from: [0, 0, 0], to: [1, 1, 7], color: '#e8b48a' });
await call('fill_box', { model: 'arm_r', from: [0, 0, 0], to: [1, 1, 1], color: '#2e2b26' });
assert.match(await call('set_pivot', { model: 'arm_r', anchor: 'top', parent: 'body' }), /pivot 2, 2, 16, parent body/);
assert.match(await call('duplicate_model', { model: 'arm_r', new_name: 'arm_l', mirror: 'x', mirror_plane: 8 }), /at 13,1,8, parent "body"/);
assert.match(await call('get_scene_info'), /arm_l: .*pivot 14,2,16, parent body/);
await call('set_pivot', { model: 'body', parent: 'arm_l' }, { error: true });
assert.match(await call('get_scene_info'), /body: [^\n]*\n/);
assert.doesNotMatch(await call('get_scene_info'), /body: [^\n]*parent arm_l/);
await call('set_attachment', { name: 'hand_r', parent: 'arm_r', position: [2, 2, 9] });
await call('render_preview', { views: ['front'], pose: { arm_r: [0, -90, 0], arm_l: [-90, 0, 0], body: [0, 0, 20] } });
await call('render_preview', { views: ['front'], pose: { ghost: [0, 0, 0] } }, { error: true });

// --- Rig survives save/load through the .rig.json sidecar, and import_model brings it along.
assert.match(await call('save_vox', { file: 'rigged' }), /Rig: .*rigged\.rig\.json/);
await call('new_scene');
assert.match(await call('load_vox', { file: 'rigged' }), /Rig loaded/);
assert.match(await call('get_scene_info'), /arm_l: .*pivot 14,2,16, parent body[\s\S]*hand_r on arm_r at 2,2,9/);
assert.match(await call('import_model', { file: 'rigged', models: ['arm_r'], prefix: 'copy_', offset: [0, 10, 0] }), /Imported copy_arm_r/);
assert.match(await call('get_scene_info'), /copy_arm_r: .*position 1,11,8.*pivot 2,12,16, parent body/);
await call('delete_model', { model: 'copy_arm_r' });

// --- glTF export.
assert.match(await call('export_glb', { file: 'rigged', voxel_size: 0.1 }), /3 meshes, \d+ triangles, 5 nodes/);
const glb = fs.readFileSync(path.join(out, 'rigged.glb'));
assert.equal(glb.readUInt32LE(0), 0x46546c67);
const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
const node = (n) => gltf.nodes.find((x) => x.name === n);
assert.deepEqual(gltf.nodes[0].children.map((i) => gltf.nodes[i].name), ['body']);
assert.deepEqual(node('body').children.map((i) => gltf.nodes[i].name).sort(), ['arm_l', 'arm_r']);
assert.deepEqual(node('arm_r').children.map((i) => gltf.nodes[i].name), ['hand_r']);
// origin "feet": body pivot (8,2,11) relative to the footprint center (8,2) at ground z=6, in glTF axes.
assert.deepEqual(node('body').translation.map((v) => +v.toFixed(6)), [0, 0.5, 0]);
console.log('glb nodes:', gltf.nodes.map((n) => `${n.name} t=${(n.translation ?? []).map((v) => +v.toFixed(3))}`).join(' | '));

// --- Skinned export: bones from the rig, meshes bound to them, clothing bound to another file's bones.
const readGltf = (file) => {
  const b = fs.readFileSync(path.join(out, file));
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
};
assert.match(await call('export_glb', { file: 'rigged_skinned', voxel_size: 0.1, skinned: true }), /3 meshes, \d+ triangles, \d+ nodes, 3 bones/);
const sk = readGltf('rigged_skinned.glb');
const skinJoints = sk.skins[0].joints.map((i) => sk.nodes[i].name);
assert.deepEqual(skinJoints, ['body', 'arm_r', 'arm_l']);
assert.deepEqual(sk.nodes.find((n) => n.name === 'arm_r').translation.map((v) => +v.toFixed(6)), [-0.6, 0.5, 0]);
const skinnedMeshes = sk.nodes.filter((n) => n.mesh !== undefined);
assert.equal(skinnedMeshes.length, 3);
assert.ok(skinnedMeshes.every((n) => n.skin === 0 && n.name.endsWith('_mesh')));
assert.ok(sk.meshes.every((m) => m.primitives[0].attributes.JOINTS_0 !== undefined));
assert.deepEqual(sk.nodes.find((n) => n.name === 'arm_r').children.map((i) => sk.nodes[i].name), ['hand_r']);
await call('new_scene');
await call('import_model', { file: 'rigged' });
await call('create_model', { name: 'glove', size: [4, 4, 2], position: [0, 0, 7] });
await call('fill_box', { model: 'glove', from: [0, 0, 0], to: [3, 3, 1], color: '#2e2b26' });
await call('export_glb', { file: 'glove', models: ['glove'], skinned: true, skeleton_from: 'rigged' }, { error: true });
await call('set_pivot', { model: 'glove', pivot: [2, 2, 16], parent: 'arm_r' });
assert.match(await call('export_glb', { file: 'glove', models: ['glove'], skinned: true, skeleton_from: 'rigged' }), /1 meshes, .*3 bones/);
const gl = readGltf('glove.glb');
assert.deepEqual(gl.skins[0].joints.map((i) => gl.nodes[i].name), ['body', 'arm_r', 'arm_l']);
assert.equal(gl.nodes.find((n) => n.mesh !== undefined).name, 'glove');
// Bound to joint 1 (arm_r): check the first JOINTS_0 entry in the binary chunk.
const glb2 = fs.readFileSync(path.join(out, 'glove.glb'));
const binStart = 20 + glb2.readUInt32LE(12) + 8;
const jAcc = gl.accessors[gl.meshes[0].primitives[0].attributes.JOINTS_0];
const jView = gl.bufferViews[jAcc.bufferView];
assert.equal(glb2.readUInt16LE(binStart + jView.byteOffset), 1);

for (const f of samples ? ['chr_knight.vox', 'castle.vox', 'cars.vox'] : []) {
  await call('load_vox', { file: path.join(samples, f) });
  const t = Date.now();
  await call('render_preview', { views: ['iso'] });
  console.log(`  render ${f}: ${Date.now() - t} ms`);
}
await client.close();
console.log('ALL CHECKS PASSED');
