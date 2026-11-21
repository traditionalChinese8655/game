/**
 * fx.ts — pooled particle bursts (spawn / delete / freeze) using a single THREE.Points
 * buffer. Fixed pool, zero per-frame allocation, lives in world space.
 */

import * as THREE from "three";

const MAX_PARTICLES = 300;

interface Particle {
  alive: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  r: number; g: number; b: number;
  size: number;
}

const tmpColor = new THREE.Color();

export class Particles {
  readonly points: THREE.Points;
  private readonly pool: Particle[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geo: THREE.BufferGeometry;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        alive: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, r: 1, g: 1, b: 1, size: 1,
      });
    }
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  /** Radial burst of colored sparks. */
  burst(pos: THREE.Vector3, colorHex: number, count: number, speed: number): void {
    tmpColor.setHex(colorHex);
    let spawned = 0;
    for (const p of this.pool) {
      if (p.alive) continue;
      p.alive = true;
      p.px = pos.x; p.py = pos.y; p.pz = pos.z;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.4 + Math.random() * 0.8);
      p.vx = Math.sin(phi) * Math.cos(theta) * s;
      p.vy = Math.abs(Math.cos(phi)) * s * 0.9 + speed * 0.3;
      p.vz = Math.sin(phi) * Math.sin(theta) * s;
      p.maxLife = 0.5 + Math.random() * 0.4;
      p.life = p.maxLife;
      const shade = 0.75 + Math.random() * 0.35;
      p.r = Math.min(1, tmpColor.r * shade);
      p.g = Math.min(1, tmpColor.g * shade);
      p.b = Math.min(1, tmpColor.b * shade);
      if (++spawned >= count) break;
    }
  }

  step(dt: number, gravity: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (!p.alive) {
        this.positions[i * 3 + 1] = -9999;
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; this.positions[i * 3 + 1] = -9999; continue; }
      p.vy -= gravity * 0.6 * dt;
      p.px += p.vx * dt;
      p.py += p.vy * dt;
      p.pz += p.vz * dt;
      if (p.py < 0.05) { p.py = 0.05; p.vy *= -0.4; p.vx *= 0.7; p.vz *= 0.7; }
      const fade = p.life / p.maxLife;
      this.positions[i * 3] = p.px;
      this.positions[i * 3 + 1] = p.py;
      this.positions[i * 3 + 2] = p.pz;
      this.colors[i * 3] = p.r * fade;
      this.colors[i * 3 + 1] = p.g * fade;
      this.colors[i * 3 + 2] = p.b * fade;
    }
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
