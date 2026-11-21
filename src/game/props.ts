/**
 * props.ts — prop entities, simple rigid-body-ish physics and the spawn factory.
 *
 * Physics is deliberately arcade: every prop collides as an axis-aligned bounding box
 * (recomputed from its oriented half-extents each step), pairs resolved with minimal-axis
 * penetration + impulse. No torque transfer between props — spin comes from spawn/throws only.
 * That keeps stacking, towers and ragdoll-ish piles stable at 240 props / 60Hz with no
 * per-frame allocation.
 */

import * as THREE from "three";
import type { MaterialKind, PropInit, SerializedProp, ShapeKind, WorldSettings } from "./types";
import { PHYSICS, PLAYER } from "./config";

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

export interface MaterialTuning {
  restitution: number;
  friction: number;
  roughness: number;
  metalness: number;
  opacity: number;
}

export const MATERIAL_TUNING: Record<MaterialKind, MaterialTuning> = {
  default: { restitution: 0.35, friction: 0.55, roughness: 0.7, metalness: 0.05, opacity: 1 },
  wood: { restitution: 0.3, friction: 0.65, roughness: 0.9, metalness: 0.0, opacity: 1 },
  metal: { restitution: 0.45, friction: 0.35, roughness: 0.25, metalness: 0.9, opacity: 1 },
  rubber: { restitution: 0.9, friction: 0.8, roughness: 0.95, metalness: 0.0, opacity: 1 },
  glass: { restitution: 0.4, friction: 0.3, roughness: 0.05, metalness: 0.1, opacity: 0.45 },
};

const WORLD_BOUND = 90;
const KILL_Y = -60;

let nextId = 1;

export class Prop {
  readonly id = nextId++;
  readonly group = new THREE.Group();
  /** Body state — group.position/quaternion are the source of truth for rendering. */
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();
  readonly halfExtents = new THREE.Vector3();
  shape: ShapeKind = "box";
  size = 1;
  material: MaterialKind = "default";
  color = 0xffffff;
  /** Kinematic / welded — ignores gravity and collisions-as-light object. */
  frozen = false;
  grounded = false;
  /** Mass ∝ volume; frozen props act as infinite mass. */
  get mass(): number {
    const s = this.size;
    return Math.max(0.2, Math.min(60, s * s * s * densityOf(this.shape)));
  }
  constructor() {
    this.group.userData.propRef = this;
  }
}

function densityOf(shape: ShapeKind): number {
  switch (shape) {
    case "sphere": return 1.4;
    case "cylinder": return 1.2;
    case "cone": case "pyramid": return 0.9;
    case "ramp": return 0.8;
    case "donut": return 0.6;
    case "plank": return 0.7;
    default: return 1.0;
  }
}

/** Half extents for a unit-size shape; the mesh is built to match. */
function unitHalfExtents(shape: ShapeKind, out: THREE.Vector3): THREE.Vector3 {
  switch (shape) {
    case "box": return out.set(0.5, 0.5, 0.5);
    case "sphere": return out.set(0.5, 0.5, 0.5);
    case "cylinder": return out.set(0.5, 0.5, 0.5);
    case "cone": return out.set(0.5, 0.5, 0.5);
    case "pyramid": return out.set(0.5, 0.5, 0.5);
    case "ramp": return out.set(0.5, 0.5, 0.5); // wedge fills the unit cube
    case "donut": return out.set(0.62, 0.25, 0.62);
    case "plank": return out.set(1.1, 0.08, 0.4);
  }
}

function buildGeometry(shape: ShapeKind, size: number): THREE.BufferGeometry {
  const s = size;
  switch (shape) {
    case "box": return new THREE.BoxGeometry(s, s, s);
    case "sphere": return new THREE.SphereGeometry(s * 0.5, 24, 18);
    case "cylinder": return new THREE.CylinderGeometry(s * 0.5, s * 0.5, s, 24);
    case "cone": return new THREE.ConeGeometry(s * 0.5, s, 24);
    case "pyramid": return new THREE.ConeGeometry(s * 0.5, s, 4);
    case "ramp": return wedgeGeometry(s);
    case "donut": return new THREE.TorusGeometry(s * 0.42, s * 0.16, 14, 28);
    case "plank": return new THREE.BoxGeometry(s * 2.2, s * 0.16, s * 0.8);
  }
}

/** Triangular-prism wedge that fills a cube of side s (slope along +Z). */
function wedgeGeometry(s: number): THREE.BufferGeometry {
  const h = s / 2;
  const geo = new THREE.BufferGeometry();
  const v = [
    // bottom quad (two tris)
    -h, -h, -h, h, -h, -h, h, -h, h, -h, -h, -h, h, -h, h, -h, -h, h,
    // back face (z=-h)
    -h, -h, -h, h, -h, -h, h, h, -h, -h, -h, -h, h, h, -h, -h, h, -h,
    // slope (from z=-h top edge down to z=+h bottom edge)
    -h, h, -h, h, h, -h, h, -h, h, -h, h, -h, h, -h, h, -h, -h, h,
    // left triangle
    -h, -h, -h, -h, -h, h, -h, h, -h,
    // right triangle
    h, -h, -h, h, h, -h, h, -h, h,
  ];
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

export class PropWorld {
  readonly props: Prop[] = [];
  readonly group = new THREE.Group();
  onPropRemoved: ((p: Prop) => void) | null = null;

  constructor(private settings: WorldSettings) {
    this.group.name = "props";
  }

  get count(): number { return this.props.length; }

  spawn(init: PropInit): Prop | null {
    if (this.props.length >= PLAYER.MAX_PROPS) return null;
    const p = new Prop();
    p.shape = init.shape;
    p.size = init.size;
    p.material = init.material;
    p.color = init.color;

    const geo = buildGeometry(init.shape, init.size);
    const tune = MATERIAL_TUNING[init.material];
    const mat = new THREE.MeshStandardMaterial({
      color: init.color,
      roughness: tune.roughness,
      metalness: tune.metalness,
      transparent: init.material === "glass",
      opacity: tune.opacity,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    p.group.add(mesh);

    unitHalfExtents(init.shape, p.halfExtents).multiplyScalar(init.size);
    p.group.position.set(init.pos.x, init.pos.y, init.pos.z);
    p.group.quaternion.identity();
    this.group.add(p.group);
    this.props.push(p);
    return p;
  }

  remove(p: Prop): void {
    const i = this.props.indexOf(p);
    if (i < 0) return;
    this.props.splice(i, 1);
    p.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.remove(p.group);
    this.onPropRemoved?.(p);
  }

  clear(): void {
    while (this.props.length > 0) this.remove(this.props[this.props.length - 1]);
  }

  /** Random gentle spin, used by spawns and explosions. */
  kick(p: Prop, strength: number): void {
    p.angVel.set(
      (Math.random() - 0.5) * strength,
      (Math.random() - 0.5) * strength,
      (Math.random() - 0.5) * strength,
    );
  }

  /** Ray vs props (world-AABB slab test, ignores rotation — good enough for tools). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Prop | null {
    let best: Prop | null = null;
    let bestT = maxDist;
    for (const p of this.props) {
      const t = rayVsAABB(origin, dir, p.group.position, p.halfExtents, bestT);
      if (t !== null && t < bestT) { bestT = t; best = p; }
    }
    return best;
  }

  step(dt: number): void {
    const g = this.settings.gravity;
    const list = this.props;

    for (const p of list) {
      if (p.frozen) continue;
      if (p.grounded) {
        // rolling/spinning friction while resting
        p.vel.x *= 0.92;
        p.vel.z *= 0.92;
        p.angVel.multiplyScalar(0.9);
      }
      p.grounded = false;
      p.vel.y -= g * dt;
      const sp = p.vel.length();
      if (sp > PHYSICS.MAX_SPEED) p.vel.multiplyScalar(PHYSICS.MAX_SPEED / sp);

      p.group.position.addScaledVector(p.vel, dt);
      integrateRotation(p, dt);

      // ground plane
      const pos = p.group.position;
      const he = p.halfExtents;
      if (pos.y - he.y < 0) {
        pos.y = he.y;
        if (p.vel.y < 0) {
          const tune = MATERIAL_TUNING[p.material];
          const rest = Math.max(tune.restitution, worldRestitution);
          p.vel.y = -p.vel.y * rest;
          if (Math.abs(p.vel.y) < 0.9) p.vel.y = 0;
          // tangential friction
          const fr = Math.min(tune.friction, worldFriction) * PHYSICS.GROUND_FRICTION;
          p.vel.x *= fr; p.vel.z *= fr;
          p.grounded = true;
        }
      }
      // soft world walls + kill plane
      if (pos.x > WORLD_BOUND) { pos.x = WORLD_BOUND; p.vel.x *= -0.4; }
      else if (pos.x < -WORLD_BOUND) { pos.x = -WORLD_BOUND; p.vel.x *= -0.4; }
      if (pos.z > WORLD_BOUND) { pos.z = WORLD_BOUND; p.vel.z *= -0.4; }
      else if (pos.z < -WORLD_BOUND) { pos.z = -WORLD_BOUND; p.vel.z *= -0.4; }
      if (pos.y < KILL_Y) this.respawn(p);
    }

    // pairwise AABB resolution (n ≤ 240 → ≤ ~29k tests at 60Hz, fine in JS)
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        resolvePair(a, b);
      }
    }
  }

  private respawn(p: Prop): void {
    p.group.position.set((Math.random() - 0.5) * 8, 12, (Math.random() - 0.5) * 8);
    p.vel.set(0, 0, 0);
    p.angVel.set(0, 0, 0);
  }

  serialize(): SerializedProp[] {
    return this.props.map((p) => ({
      shape: p.shape,
      size: p.size,
      color: p.color,
      material: p.material,
      pos: [p.group.position.x, p.group.position.y, p.group.position.z],
      rot: [p.group.quaternion.x, p.group.quaternion.y, p.group.quaternion.z, p.group.quaternion.w],
      vel: [p.vel.x, p.vel.y, p.vel.z],
      frozen: p.frozen,
    }));
  }

  deserialize(data: SerializedProp[]): number {
    this.clear();
    let n = 0;
    for (const s of data) {
      const p = this.spawn({
        shape: s.shape,
        size: s.size,
        color: s.color,
        material: s.material,
        pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
      });
      if (!p) break;
      p.group.quaternion.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      p.vel.set(s.vel[0], s.vel[1], s.vel[2]);
      p.frozen = s.frozen;
      n++;
    }
    return n;
  }
}

/** Slab test against an axis-aligned box. Returns hit distance or null. */
function rayVsAABB(
  o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, he: THREE.Vector3, maxT: number,
): number | null {
  let tmin = 0, tmax = maxT;
  // X
  if (Math.abs(d.x) < 1e-9) { if (o.x < c.x - he.x || o.x > c.x + he.x) return null; }
  else {
    let t1 = (c.x - he.x - o.x) / d.x, t2 = (c.x + he.x - o.x) / d.x;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(d.y) < 1e-9) { if (o.y < c.y - he.y || o.y > c.y + he.y) return null; }
  else {
    let t1 = (c.y - he.y - o.y) / d.y, t2 = (c.y + he.y - o.y) / d.y;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(d.z) < 1e-9) { if (o.z < c.z - he.z || o.z > c.z + he.z) return null; }
  else {
    let t1 = (c.z - he.z - o.z) / d.z, t2 = (c.z + he.z - o.z) / d.z;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Integrate quaternion by angular velocity (no allocation). */
const dq = new THREE.Quaternion();
function integrateRotation(p: Prop, dt: number): void {
  const w = p.angVel;
  if (w.x === 0 && w.y === 0 && w.z === 0) return;
  dq.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(p.group.quaternion);
  p.group.quaternion.x += dq.x;
  p.group.quaternion.y += dq.y;
  p.group.quaternion.z += dq.z;
  p.group.quaternion.w += dq.w;
  p.group.quaternion.normalize();
}

function im(p: Prop): number {
  return p.frozen ? 0 : 1 / p.mass;
}

/** World-level overrides set by AI mods ("make everything bouncy" / "slippery"). */
let worldRestitution: number = PHYSICS.DEFAULT_RESTITUTION;
let worldFriction: number = PHYSICS.DEFAULT_FRICTION;
export function setWorldSurfaces(restitution: number, friction: number): void {
  worldRestitution = restitution;
  worldFriction = friction;
}

/** Resolve one prop pair: minimal-axis AABB penetration + impulse along that axis. */
function resolvePair(a: Prop, b: Prop): void {
  const pa = a.group.position, pb = b.group.position;
  const ha = a.halfExtents, hb = b.halfExtents;
  const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
  const ox = ha.x + hb.x - Math.abs(dx);
  if (ox <= 0) return;
  const oy = ha.y + hb.y - Math.abs(dy);
  if (oy <= 0) return;
  const oz = ha.z + hb.z - Math.abs(dz);
  if (oz <= 0) return;

  const ima = im(a), imb = im(b);
  const imSum = ima + imb;
  if (imSum === 0) return; // both frozen

  // minimal penetration axis
  let nx = 0, ny = 0, nz = 0, pen: number;
  if (ox < oy && ox < oz) { pen = ox; nx = dx > 0 ? 1 : -1; }
  else if (oy < oz) { pen = oy; ny = dy > 0 ? 1 : -1; }
  else { pen = oz; nz = dz > 0 ? 1 : -1; }

  // positional correction (split by inverse mass, slight slop to avoid jitter)
  const slop = 0.01;
  const corr = Math.max(pen - slop, 0) / imSum;
  pa.x -= nx * corr * ima; pa.y -= ny * corr * ima; pa.z -= nz * corr * ima;
  pb.x += nx * corr * imb; pb.y += ny * corr * imb; pb.z += nz * corr * imb;

  // impulse along the normal
  const rvx = b.vel.x - a.vel.x, rvy = b.vel.y - a.vel.y, rvz = b.vel.z - a.vel.z;
  const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;
  if (velAlongNormal > 0) return;
  const rest = Math.max(
    worldRestitution,
    Math.max(MATERIAL_TUNING[a.material].restitution, MATERIAL_TUNING[b.material].restitution),
  );
  const jimp = -(1 + rest) * velAlongNormal / imSum;
  a.vel.x -= jimp * nx * ima; a.vel.y -= jimp * ny * ima; a.vel.z -= jimp * nz * ima;
  b.vel.x += jimp * nx * imb; b.vel.y += jimp * ny * imb; b.vel.z += jimp * nz * imb;

  // friction on tangential velocity
  const tx = rvx - velAlongNormal * nx, ty = rvy - velAlongNormal * ny, tz = rvz - velAlongNormal * nz;
  const tLen = Math.hypot(tx, ty, tz);
  if (tLen > 1e-6) {
    const fr = Math.min(
      worldFriction,
      Math.min(MATERIAL_TUNING[a.material].friction, MATERIAL_TUNING[b.material].friction),
    );
    const jt = Math.min(tLen, jimp * fr * 0.9) / tLen / imSum;
    a.vel.x += tx * jt * ima; a.vel.y += ty * jt * ima; a.vel.z += tz * jt * ima;
    b.vel.x -= tx * jt * imb; b.vel.y -= ty * jt * imb; b.vel.z -= tz * jt * imb;
  }

  // ground contact flags (huge stack stability win: props resting on something don't slide)
  if (ny !== 0) {
    if (ny > 0) { if (imb > 0) b.grounded = true; if (b.frozen && ima > 0) a.grounded = true; }
    else { if (ima > 0) a.grounded = true; if (a.frozen && imb > 0) b.grounded = true; }
  }
}
