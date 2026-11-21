/**
 * types.ts — shared types for the sandbox.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Camera pose (right-handed): yaw around the Y axis (turning right increases in the negative direction), pitch around the X axis (looking up is positive). */
export interface CameraRig {
  yaw: number;
  pitch: number;
  pos: Vec3;
}

/** Prop shapes the world knows how to build and collide. */
export type ShapeKind = "box" | "sphere" | "cylinder" | "cone" | "pyramid" | "ramp" | "donut" | "plank";

/** Material presets — affect friction, restitution and the three.js material. */
export type MaterialKind = "default" | "wood" | "metal" | "rubber" | "glass";

export interface WorldSettings {
  /** Gravity in m/s² (can be negative for anti-gravity). */
  gravity: number;
  /** Simulation speed multiplier (slow-mo / fast-forward). */
  timeScale: number;
  /** Default restitution for newly spawned props. */
  restitution: number;
  /** Default friction for newly spawned props. */
  friction: number;
  /** Sky/background color. */
  skyColor: number;
  /** Sun (directional light) color. */
  sunColor: number;
  /** Sun intensity. */
  sunIntensity: number;
  /** Fog density, 0 = off. */
  fogDensity: number;
}

export interface PropInit {
  shape: ShapeKind;
  size: number;
  color: number;
  material: MaterialKind;
  pos: Vec3;
}

export interface SerializedProp {
  shape: ShapeKind;
  size: number;
  color: number;
  material: MaterialKind;
  pos: [number, number, number];
  rot: [number, number, number, number];
  vel: [number, number, number];
  frozen: boolean;
}

export interface SaveData {
  version: 1;
  world: WorldSettings;
  props: SerializedProp[];
}
