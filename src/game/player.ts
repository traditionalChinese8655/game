/**
 * player.ts — first-person controller: WASD + mouse look, sprint, jump,
 * capsule-as-AABB collision against the ground and prop bounding boxes.
 * The player can stand on props and shove them by walking into them.
 */

import * as THREE from "three";
import { Input } from "./input";
import { PLAYER } from "./config";
import type { WorldSettings } from "./types";
import type { Prop, PropWorld } from "./props";

const tmp = new THREE.Vector3();

export class Player {
  /** Feet position. */
  readonly pos = new THREE.Vector3(0, 0, 8);
  readonly vel = new THREE.Vector3();
  yaw = 0; // facing -Z initially? forward = (sin(yaw), 0, cos(yaw))·(-1)... see moveDir
  pitch = 0;
  grounded = false;

  /** Half extents of the player's collision box. */
  private readonly he = new THREE.Vector3(PLAYER.RADIUS, PLAYER.HEIGHT / 2, PLAYER.RADIUS);

  constructor(private settings: WorldSettings) {}

  get eyeY(): number { return this.pos.y + PLAYER.EYE_HEIGHT; }

  /** Forward direction on the XZ plane from yaw (yaw=0 → -Z, matching camera). */
  forwardDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Full look direction including pitch. */
  lookDir(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  applyLook(input: Input): void {
    const look = input.consumeLook();
    this.yaw += look.yaw;
    this.pitch += look.pitch;
    const limit = Math.PI / 2 - 0.02;
    if (this.pitch > limit) this.pitch = limit;
    if (this.pitch < -limit) this.pitch = -limit;
  }

  step(dt: number, input: Input, world: PropWorld, jumpRequested: boolean): void {
    // desired planar velocity in world space
    const speed = input.isHeld("ShiftLeft") || input.isHeld("ShiftRight") ? PLAYER.SPRINT_SPEED : PLAYER.WALK_SPEED;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const wx = (rx * input.moveX + fx * input.moveZ) * speed;
    const wz = (rz * input.moveX + fz * input.moveZ) * speed;

    const accel = this.grounded ? PLAYER.ACCEL : PLAYER.AIR_ACCEL;
    this.vel.x += (wx - this.vel.x) * Math.min(1, accel * dt / speed || 0);
    this.vel.z += (wz - this.vel.z) * Math.min(1, accel * dt / speed || 0);

    if (this.grounded && jumpRequested) {
      this.vel.y = PLAYER.JUMP_SPEED;
      this.grounded = false;
    }

    this.vel.y -= this.settings.gravity * dt;
    if (this.vel.y < -30) this.vel.y = -30;

    this.pos.addScaledVector(this.vel, dt);

    // ground plane
    if (this.pos.y <= 0) {
      if (this.vel.y < -8) this.landedHard = true;
      this.pos.y = 0;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // props: push out + shove
    for (const p of world.props) {
      resolvePlayerProp(this, p, dt);
    }

    // soft world walls
    const B = 120;
    if (this.pos.x > B) this.pos.x = B;
    if (this.pos.x < -B) this.pos.x = -B;
    if (this.pos.z > B) this.pos.z = B;
    if (this.pos.z < -B) this.pos.z = -B;
  }

  /** Set by the ground plane check when a hard landing happens (for the land SFX). */
  landedHard = false;

  /** Center of the player box (for AABB tests). */
  center(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + PLAYER.HEIGHT / 2, this.pos.z);
  }

  get halfExtents(): THREE.Vector3 { return this.he; }
}

/** Resolve the player's AABB against one prop: push the player out, shove the prop. */
function resolvePlayerProp(player: Player, p: Prop, dt: number): void {
  if (p.frozen) return;
  const heP = player.halfExtents;
  const pcx = player.pos.x, pcy = player.pos.y + heP.y, pcz = player.pos.z;
  const c = p.group.position, he = p.halfExtents;
  const dx = pcx - c.x, dy = pcy - c.y, dz = pcz - c.z;
  const ox = he.x + heP.x - Math.abs(dx);
  if (ox <= 0) return;
  const oy = he.y + heP.y - Math.abs(dy);
  if (oy <= 0) return;
  const oz = he.z + heP.z - Math.abs(dz);
  if (oz <= 0) return;

  if (ox < oy && ox < oz) {
    const s = dx > 0 ? 1 : -1;
    player.pos.x += ox * s;
    // walking into a prop shoves it
    p.vel.x -= s * 1.2;
  } else if (oy < oz) {
    const s = dy > 0 ? 1 : -1;
    player.pos.y += oy * s;
    if (s > 0) {
      player.grounded = true;
      if (player.vel.y < 0) player.vel.y = 0;
      // ride moving props: inherit a bit of their horizontal velocity
      player.vel.x += p.vel.x * 0.1;
      player.vel.z += p.vel.z * 0.1;
    } else {
      if (player.vel.y > 0) player.vel.y = 0;
    }
  } else {
    const s = dz > 0 ? 1 : -1;
    player.pos.z += oz * s;
    p.vel.z -= s * 1.2;
  }
  void dt;
  void tmp;
}
