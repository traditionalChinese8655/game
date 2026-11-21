/**
 * config.ts — global tuning.
 */

export const INPUT_CONFIG = {
  /** Mouse/touch camera sensitivity (radians/pixel). */
  MOUSE_SENS_X: 0.0026,
  MOUSE_SENS_Y: 0.0022,
  /** Camera invert switches: default false = mouse right turns camera right, mouse up looks up. */
  INVERT_X: false,
  INVERT_Y: false,
} as const;

export const PLAYER = {
  EYE_HEIGHT: 1.62,
  HEIGHT: 1.8,
  RADIUS: 0.32,
  WALK_SPEED: 5.2,
  SPRINT_SPEED: 9.0,
  JUMP_SPEED: 5.4,
  ACCEL: 40,
  AIR_ACCEL: 10,
  MAX_PROPS: 240,
  REACH: 60,
} as const;

export const PHYSICS = {
  FIXED_STEP: 1 / 60,
  MAX_SUBSTEPS: 4,
  GROUND_FRICTION: 0.82,
  SLEEP_SPEED: 0.08,
  DEFAULT_RESTITUTION: 0.35,
  DEFAULT_FRICTION: 0.55,
  MAX_SPEED: 40,
} as const;

export const GRAB = {
  MIN_DIST: 1.6,
  MAX_DIST: 18,
  START_DIST: 5,
  SCROLL_STEP: 0.8,
  SPRING: 14,
  THROW_BOOST: 1.35,
  MAX_SIZE: 6,
} as const;

export const QUALITY = {
  PARTICLES_HIGH: 400,
  PARTICLES_LOW: 120,
  DEGRADE_FPS: 45,
} as const;

export const WORLD_DEFAULTS = {
  gravity: 9.8,
  timeScale: 1,
  skyColor: 0x87b5e0,
  sunColor: 0xfff2dd,
  sunIntensity: 2.4,
  fogDensity: 0,
} as const;

export const SAVE_KEY = "sandbox-ai.world";
