// Rig helpers: pivots, parent hierarchy, posed transforms and the .rig.json sidecar.
import fs from 'node:fs';
import path from 'node:path';

export const pivotOf = (m) => m.pivot ?? m.position.map((p, k) => p + m.size[k] / 2);

const matVec = (A, v) => [0, 1, 2].map((r) => A[r][0] * v[0] + A[r][1] * v[1] + A[r][2] * v[2]);
const matMul = (A, B) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
export { matVec };

// Euler angles in degrees around MagicaVoxel axes, applied X first, then Y, then Z.
export function rotationMatrix([rx, ry, rz] = [0, 0, 0]) {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const X = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Y = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Z = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return matMul(Z, matMul(Y, X));
}

// World transform {A, b} for every model: a rest-pose world point x maps to A·x + b.
// Each model rotates about its own pivot and inherits its parent's transform.
export function poseTransforms(scene, pose = {}) {
  for (const name of Object.keys(pose)) scene.model(name);
  const out = new Map();
  const visiting = new Set();
  const resolve = (name) => {
    if (out.has(name)) return out.get(name);
    if (visiting.has(name)) throw new Error(`Rig cycle detected at "${name}".`);
    visiting.add(name);
    const m = scene.model(name);
    const p = pivotOf(m);
    let A = rotationMatrix(pose[name]);
    let b = p.map((v, k) => v - matVec(A, p)[k]);
    if (m.parent && scene.models.has(m.parent)) {
      const P = resolve(m.parent);
      b = matVec(P.A, b).map((v, k) => v + P.b[k]);
      A = matMul(P.A, A);
    }
    visiting.delete(name);
    out.set(name, { A, b });
    return out.get(name);
  };
  for (const name of scene.models.keys()) resolve(name);
  return out;
}

export const hasRig = (scene) =>
  scene.attachments.size > 0 || [...scene.models.values()].some((m) => m.pivot || m.parent);

export const rigPath = (voxPath) => voxPath.replace(/\.vox$/i, '') + '.rig.json';

export function writeRig(scene, voxPath) {
  const file = rigPath(voxPath);
  let extra = {};
  try {
    extra = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no previous sidecar to preserve
  }
  const parts = {};
  for (const m of scene.models.values()) parts[m.name] = { parent: m.parent, pivot: pivotOf(m) };
  const attachment_points = {};
  for (const [name, a] of scene.attachments) attachment_points[name] = { parent: a.parent, position: a.position };
  const rig = {
    ...extra,
    model: path.basename(voxPath),
    units: 'voxels, MagicaVoxel world coordinates (x = right, y = back, z = up; front faces -y)',
    parts,
    attachment_points,
  };
  fs.writeFileSync(file, JSON.stringify(rig, null, 2) + '\n');
  return file;
}

// Applies a sidecar next to voxPath when present. Returns the sidecar path or null.
export function readRig(scene, voxPath) {
  const file = rigPath(voxPath);
  if (!fs.existsSync(file)) return null;
  const rig = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, part] of Object.entries(rig.parts ?? {})) {
    const m = scene.models.get(name);
    if (!m) continue;
    if (Array.isArray(part.pivot)) m.pivot = part.pivot.map(Number);
    m.parent = part.parent ?? null;
  }
  for (const [name, a] of Object.entries(rig.attachment_points ?? {})) {
    if (Array.isArray(a.position)) scene.attachments.set(name, { parent: a.parent ?? null, position: a.position.map(Number) });
  }
  return file;
}
