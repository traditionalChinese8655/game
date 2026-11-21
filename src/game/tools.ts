/**
 * tools.ts — Gmod-style tools: physics gun (grab / carry / throw / freeze), delete, spawn.
 * Tool 1 "Physgun": hold E or Right-Mouse to grab what you aim at, scroll to adjust
 * distance, Left-Click while holding to freeze/unfreeze in place, release to throw.
 * Tool 2 "Remover": aim + Left-Click (or X) to delete.
 * Tool 3 "Spawner": Left-Click to drop a crate where you aim.
 */

import * as THREE from "three";
import { Input } from "./input";
import { GRAB, PLAYER } from "./config";
import type { Prop, PropWorld } from "./props";
import type { Player } from "./player";

export type ToolId = "physgun" | "remover" | "spawner";

export const TOOL_INFO: Record<ToolId, { name: string; hint: string }> = {
  physgun: { name: "Physics Gun", hint: "Hold E / Right-Mouse: grab · Scroll: distance · Click: freeze · Release: throw" },
  remover: { name: "Remover", hint: "Aim + Click or X: delete prop" },
  spawner: { name: "Spawner", hint: "Click: spawn a crate at the aim point" },
};

const TOOL_ORDER: ToolId[] = ["physgun", "remover", "spawner"];

/** Ring buffer for throw-velocity estimation (last few hold positions). */
const POS_SAMPLES = 6;
const samplePos: THREE.Vector3[] = Array.from({ length: POS_SAMPLES }, () => new THREE.Vector3());
let sampleCount = 0;

const aimOrigin = new THREE.Vector3();
const aimDir = new THREE.Vector3();
const holdTarget = new THREE.Vector3();
const tmpV = new THREE.Vector3();

export interface ToolHooks {
  onGrab(p: Prop): void;
  onRelease(p: Prop): void;
  onFreeze(p: Prop): void;
  onDelete(p: Prop): void;
  onSpawn(p: Prop): void;
  sfx(id: "grab" | "release" | "freeze" | "del" | "spawn" | "ui" | "error"): void;
}

export class Tools {
  current: ToolId = "physgun";
  /** Prop under the crosshair (for HUD + tools). */
  hovered: Prop | null = null;

  private held: Prop | null = null;
  private holdDist: number = GRAB.START_DIST;
  private wheelDelta = 0;
  private wheelOff: (() => void) | null = null;

  constructor(private world: PropWorld, private hooks: ToolHooks) {
    const onWheel = (e: WheelEvent) => {
      this.wheelDelta += e.deltaY;
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    this.wheelOff = () => window.removeEventListener("wheel", onWheel);
  }

  dispose(): void {
    this.wheelOff?.();
    this.wheelOff = null;
  }

  cycle(dir: 1 | -1): ToolId {
    const i = TOOL_ORDER.indexOf(this.current);
    this.current = TOOL_ORDER[(i + dir + TOOL_ORDER.length) % TOOL_ORDER.length];
    this.dropHeld(false);
    this.hooks.sfx("ui");
    return this.current;
  }

  setTool(t: ToolId): void {
    if (this.current === t) return;
    this.current = t;
    this.dropHeld(false);
    this.hooks.sfx("ui");
  }

  /** Release whatever is held (e.g. when pausing). */
  drop(): void {
    this.dropHeld(true);
  }

  get heldProp(): Prop | null { return this.held; }

  /** Aim ray from the player's eye. */
  private updateAim(player: Player): void {
    aimOrigin.set(player.pos.x, player.eyeY, player.pos.z);
    player.lookDir(aimDir);
    this.hovered = this.world.raycast(aimOrigin, aimDir, PLAYER.REACH);
  }

  /** Point at the aimed prop / max reach — used by the spawner and the mod console. */
  aimPoint(player: Player, out: THREE.Vector3): THREE.Vector3 {
    this.updateAim(player);
    aimOrigin.set(player.pos.x, player.eyeY, player.pos.z);
    player.lookDir(aimDir);
    const dist = this.hovered ? distanceToAim(player, this.hovered) : GRAB.START_DIST;
    return out.copy(aimOrigin).addScaledVector(aimDir, Math.max(2, Math.min(dist, PLAYER.REACH)));
  }

  update(dt: number, player: Player, input: Input, uiOpen: boolean): void {
    this.updateAim(player);

    // tool switching
    if (!uiOpen) {
      if (input.consumeAction("Digit1")) this.setTool("physgun");
      if (input.consumeAction("Digit2")) this.setTool("remover");
      if (input.consumeAction("Digit3")) this.setTool("spawner");
      if (input.consumeAction("KeyQ")) this.cycle(1);
    }

    if (uiOpen) {
      // never grab/throw while typing in the console
      this.dropHeld(false);
      return;
    }

    const grabHeld = input.isHeld("KeyE") || input.isHeld("Mouse2");
    const clicked = input.consumeAction("Mouse0");

    switch (this.current) {
      case "physgun": {
        if (grabHeld) {
          if (!this.held && this.hovered) this.grab(this.hovered);
          if (this.held) {
            // carry: spring toward hold point
            this.holdDist = clamp(this.holdDist + this.wheelDelta * 0.01 * GRAB.SCROLL_STEP, GRAB.MIN_DIST, GRAB.MAX_DIST);
            holdTarget.copy(aimOrigin).addScaledVector(aimDir, this.holdDist);
            const p = this.held;
            if (p.frozen) {
              p.group.position.copy(holdTarget);
            } else {
              tmpV.copy(holdTarget).sub(p.group.position);
              p.vel.addScaledVector(tmpV, GRAB.SPRING * dt);
              p.vel.multiplyScalar(Math.max(0, 1 - 6 * dt));
              p.angVel.multiplyScalar(Math.max(0, 1 - 4 * dt));
            }
            // remember positions for throw velocity
            sampleCount = Math.min(sampleCount + 1, POS_SAMPLES);
            for (let i = POS_SAMPLES - 1; i > 0; i--) samplePos[i].copy(samplePos[i - 1]);
            samplePos[0].copy(holdTarget);
            if (clicked) this.toggleFreeze(p);
          }
        } else if (this.held) {
          this.throwHeld(player);
        }
        break;
      }
      case "remover": {
        if ((clicked || input.consumeAction("KeyX")) && this.hovered) {
          const p = this.hovered;
          this.world.remove(p);
          if (this.held === p) this.held = null;
          this.hooks.onDelete(p);
          this.hooks.sfx("del");
        }
        break;
      }
      case "spawner": {
        if (clicked) {
          const point = this.aimPoint(player, tmpV);
          const p = this.world.spawn({
            shape: "box", size: 1, color: 0x9fb4c8, material: "wood",
            pos: { x: point.x, y: point.y + 1.5, z: point.z },
          });
          if (p) { this.hooks.onSpawn(p); this.hooks.sfx("spawn"); }
          else this.hooks.sfx("error");
        }
        break;
      }
    }

    this.wheelDelta = 0;
  }

  private grab(p: Prop): void {
    this.held = p;
    this.holdDist = clamp(distanceToAimPoint(p), GRAB.MIN_DIST, GRAB.MAX_DIST);
    sampleCount = 0;
    this.hooks.onGrab(p);
    this.hooks.sfx("grab");
  }

  private toggleFreeze(p: Prop): void {
    p.frozen = !p.frozen;
    p.vel.set(0, 0, 0);
    p.angVel.set(0, 0, 0);
    this.hooks.onFreeze(p);
    this.hooks.sfx("freeze");
  }

  /** Release the held prop with the swing velocity of the hold point. */
  private throwHeld(player: Player): void {
    const p = this.held;
    if (!p) return;
    this.held = null;
    if (!p.frozen) {
      if (sampleCount >= 2) {
        const a = samplePos[0], b = samplePos[Math.min(sampleCount - 1, POS_SAMPLES - 1)];
        tmpV.copy(a).sub(b).multiplyScalar(1 / (0.016 * Math.min(sampleCount, POS_SAMPLES)));
        p.vel.copy(tmpV).multiplyScalar(GRAB.THROW_BOOST);
        player.lookDir(aimDir);
        p.vel.addScaledVector(aimDir, 2.5);
      } else {
        player.lookDir(aimDir);
        p.vel.copy(aimDir).multiplyScalar(8);
      }
      this.world.kick(p, 3);
    }
    this.hooks.onRelease(p);
    this.hooks.sfx("release");
    sampleCount = 0;
  }

  private dropHeld(silent: boolean): void {
    const p = this.held;
    if (!p) return;
    this.held = null;
    if (!silent) this.hooks.onRelease(p);
  }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

function distanceToAimPoint(p: Prop): number { return p.group.position.distanceTo(aimOrigin); }

function distanceToAim(player: Player, p: Prop): number {
  aimOrigin.set(player.pos.x, player.eyeY, player.pos.z);
  return p.group.position.distanceTo(aimOrigin);
}
