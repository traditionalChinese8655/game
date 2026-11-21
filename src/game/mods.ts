/**
 * mods.ts — the in-game AI mod console: natural language in, world changes out.
 * A rule-based parser (no network needed) understands spawning ("5 big red metal cubes"),
 * structures ("a tower of crates", "rain donuts"), world mods ("low gravity", "night",
 * "make everything bouncy", "slow motion") and utilities ("clear", "save", "load", "help").
 */

import * as THREE from "three";
import type { MaterialKind, PropInit, ShapeKind, WorldSettings } from "./types";
import type { Prop, PropWorld } from "./props";
import { GRAB, PHYSICS, WORLD_DEFAULTS } from "./config";

export interface ModContext {
  world: PropWorld;
  settings: WorldSettings;
  player: { pos: THREE.Vector3; eyeY: number; lookDir(out: THREE.Vector3): THREE.Vector3 };
  applyWorldSettings(): void;
  spawnProps(inits: PropInit[]): number;
  shake(): void;
  sfx(id: "spawn" | "del" | "boom" | "ui" | "error" | "pop"): void;
}

const COLORS: Record<string, number> = {
  red: 0xe04b3a, blue: 0x3a7de0, green: 0x4caf50, yellow: 0xf2c14e,
  purple: 0x9b59b6, orange: 0xe67e22, pink: 0xf48fb1, white: 0xf5f5f5,
  black: 0x222226, gray: 0x9aa0a6, grey: 0x9aa0a6, brown: 0x8d6e63,
  cyan: 0x36c5d8, magenta: 0xd836c5, lime: 0xaee236, gold: 0xd4af37,
  silver: 0xc0c8d0, teal: 0x2a9d8f, crimson: 0xb3122e, navy: 0x2c3e80,
};

const SIZES: Record<string, number> = {
  tiny: 0.35, small: 0.6, medium: 1, normal: 1, big: 2, large: 2,
  huge: 3.5, giant: 5, massive: 5,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

const SHAPES: Record<string, ShapeKind> = {
  box: "box", cube: "box", crate: "box", block: "box",
  ball: "sphere", sphere: "sphere", orb: "sphere",
  cylinder: "cylinder", barrel: "cylinder", can: "cylinder", tube: "cylinder",
  cone: "cone",
  pyramid: "pyramid",
  ramp: "ramp", wedge: "ramp",
  donut: "donut", doughnut: "donut", torus: "donut",
  plank: "plank", board: "plank",
};

const MATERIALS: Record<string, MaterialKind> = {
  wood: "wood", wooden: "wood",
  metal: "metal", steel: "metal", iron: "metal", golden: "metal",
  rubber: "rubber", bouncy: "rubber",
  glass: "glass",
};

const tmpDir = new THREE.Vector3();
const tmpPos = new THREE.Vector3();

/** Execute a natural-language command. Returns the feedback line for the console. */
export function runCommand(raw: string, ctx: ModContext): string {
  const text = raw.trim().toLowerCase().replace(/[!?.]+$/g, "").replace(/\s+/g, " ");
  if (!text) return "Type something — try “help”.";

  // --- utility ---
  if (/^(help|what can you do|\?|commands)$/.test(text)) return "HELP";
  if (/^(hi|hello|hey|yo)\b/.test(text)) return "Hey! I'm the world mod AI. Try: “spawn 5 red balls” or “low gravity”.";
  if (/\b(clear|remove all|delete all|reset (the )?world|clean (up|everything)|empty)\b/.test(text)) {
    const n = ctx.world.count;
    ctx.world.clear();
    ctx.sfx("del");
    return n > 0 ? `Cleared ${n} props.` : "The world is already empty.";
  }
  if (/\b(save|save world|save game)\b/.test(text)) return "SAVE";
  if (/\b(load|load world|restore)\b/.test(text)) return "LOAD";

  // --- world mods ---
  const g = gravityCommand(text, ctx.settings);
  if (g) return g;
  const t = timeCommand(text, ctx.settings);
  if (t) return t;
  const s = skyCommand(text, ctx.settings, ctx);
  if (s) return s;
  const f = fogCommand(text, ctx.settings, ctx);
  if (f) return f;
  const b = surfaceCommand(text);
  if (b) return b;
  const x = explodeCommand(text, ctx);
  if (x) return x;

  // --- spawning & structures ---
  const sp = spawnCommand(text, ctx);
  if (sp) return sp;

  return `I don't understand “${raw}” yet. Try “help” to see what I can do.`;
}

// ---------------------------------------------------------------- gravity

function gravityCommand(text: string, s: WorldSettings): string | null {
  if (!text.includes("gravity") && !/\b(fly|floating|float)\b/.test(text)) return null;
  const set = (v: number, label: string) => { s.gravity = v; return `Gravity set to ${label} (${v} m/s²).`; };
  if (/\b(no|zero|0|none|off|disable)\b/.test(text)) return set(0, "zero");
  if (/anti|negative|upside/.test(text)) return set(-4, "negative — things fall up!");
  if (/moon|lunar/.test(text)) return set(1.6, "lunar");
  if (/low|less|weak/.test(text)) return set(2.5, "low");
  if (/high|strong|more|heavy/.test(text)) return set(24, "high");
  if (/normal|earth|default|restore/.test(text)) return set(WORLD_DEFAULTS.gravity, "normal");
  const m = text.match(/(-?\d+(?:\.\d+)?)/);
  if (m) return set(parseFloat(m[1]), "custom");
  return set(WORLD_DEFAULTS.gravity, "normal");
}

// ---------------------------------------------------------------- time

function timeCommand(text: string, s: WorldSettings): string | null {
  if (!/\b(time|motion|speed)\b/.test(text)) return null;
  if (/slow/.test(text)) { s.timeScale = 0.3; return "Slow motion engaged (0.3×)."; }
  if (/fast|speed up|faster/.test(text)) { s.timeScale = 2; return "Time is running at 2×."; }
  if (/normal|default|restore/.test(text)) { s.timeScale = 1; return "Time is back to normal."; }
  const m = text.match(/(\d+(?:\.\d+)?)\s*(x|×|times)/);
  if (m) { s.timeScale = Math.min(4, Math.max(0.1, parseFloat(m[1]))); return `Time scale set to ${s.timeScale}×.`; }
  return null;
}

// ---------------------------------------------------------------- sky

function skyCommand(text: string, s: WorldSettings, ctx: ModContext): string | null {
  if (!/\b(sky|night|day|sunset|dawn|dusk|morning)\b/.test(text)) return null;
  // phrases like "spawn 30 balls in the sky" are spawning placement, not sky mods
  if (/\b(spawn|drop|give|rain|tower|wall|build|summon|create|place|stack)\b/.test(text)) return null;
  if (/night|midnight/.test(text)) {
    s.skyColor = 0x0b1026; s.sunColor = 0x8fa8ff; s.sunIntensity = 0.35; s.fogDensity = 0;
  } else if (/sunset|dusk|dawn/.test(text)) {
    s.skyColor = 0xe08a5a; s.sunColor = 0xff9a3c; s.sunIntensity = 1.6; s.fogDensity = 0.004;
  } else if (/day|morning|noon/.test(text)) {
    s.skyColor = WORLD_DEFAULTS.skyColor; s.sunColor = WORLD_DEFAULTS.sunColor;
    s.sunIntensity = WORLD_DEFAULTS.sunIntensity; s.fogDensity = 0;
  } else {
    const c = findColor(text);
    if (c === null) return null;
    s.skyColor = c;
  }
  ctx.applyWorldSettings();
  return "Sky updated.";
}

// ---------------------------------------------------------------- fog

function fogCommand(text: string, s: WorldSettings, ctx: ModContext): string | null {
  if (!/fog/.test(text)) return null;
  if (/no |clear|remove|less|off|away/.test(text)) s.fogDensity = 0;
  else if (/heavy|dense|thick|lots of/.test(text)) s.fogDensity = 0.03;
  else s.fogDensity = 0.012;
  ctx.applyWorldSettings();
  return s.fogDensity > 0 ? "Fog rolled in." : "Fog cleared.";
}

// ---------------------------------------------------------------- surfaces

// surface override state lives in props.ts (setWorldSurfaces); we track last values here
import { setWorldSurfaces } from "./props";
let _rest: number = PHYSICS.DEFAULT_RESTITUTION;
let _fric: number = PHYSICS.DEFAULT_FRICTION;

function surfaceCommand(text: string): string | null {
  if (/bounc|bounce/.test(text)) {
    if (/no |less|off|stop/.test(text)) { _rest = PHYSICS.DEFAULT_RESTITUTION; setWorldSurfaces(_rest, _fric); return "Bounce disabled."; }
    const superBouncy = /super|ultra|max/.test(text);
    _rest = superBouncy ? 1.15 : 0.85;
    setWorldSurfaces(_rest, _fric);
    return superBouncy ? "Everything is SUPER bouncy!" : "Everything is bouncy now.";
  }
  if (/slipper|ice|slide/.test(text)) {
    _fric = 0.04;
    setWorldSurfaces(_rest, _fric);
    return "Everything is slippery as ice.";
  }
  if (/normal friction|sticky|grippy/.test(text)) {
    _fric = PHYSICS.DEFAULT_FRICTION;
    setWorldSurfaces(_rest, _fric);
    return "Friction restored.";
  }
  return null;
}

// ---------------------------------------------------------------- explosion

function explodeCommand(text: string, ctx: ModContext): string | null {
  if (!/explod|launch everything|boom|blast/.test(text)) return null;
  const center = tmpPos.set(ctx.player.pos.x, ctx.player.pos.y + 1, ctx.player.pos.z);
  let n = 0;
  for (const p of ctx.world.props) {
    tmpDir.copy(p.group.position).sub(center);
    const d = Math.max(1.2, tmpDir.length());
    tmpDir.normalize();
    const power = Math.min(28, 90 / d);
    p.vel.addScaledVector(tmpDir, power);
    p.vel.y += power * 0.9;
    ctx.world.kick(p, 6);
    n++;
  }
  ctx.shake();
  ctx.sfx("boom");
  return n > 0 ? `BOOM — launched ${n} props!` : "Nothing to explode… spawn something first!";
}

// ---------------------------------------------------------------- spawning

interface SpawnSpec {
  count: number;
  shape: ShapeKind | null;
  size: number;
  color: number | "rainbow" | null;
  material: MaterialKind | null;
  mode: "drop" | "head" | "sky" | "tower" | "wall" | "pyramid" | "rain";
}

function spawnCommand(text: string, ctx: ModContext): string | null {
  const wants = /\b(spawn|drop|give|make|create|add|build|place|summon|i want|can i have|get me|rain)\b/.test(text)
    || Object.keys(SHAPES).some((k) => text.includes(k));
  if (!wants) return null;

  const spec: SpawnSpec = {
    count: 1, shape: null, size: 1, color: null, material: null, mode: "drop",
  };

  // count: digits or number words
  const numMatch = text.match(/\b(\d+)\b/);
  if (numMatch) spec.count = Math.min(30, parseInt(numMatch[1], 10));
  else {
    for (const [w, n] of Object.entries(NUMBER_WORDS)) {
      if (new RegExp(`\\b${w}\\b`).test(text)) { spec.count = n; break; }
    }
  }

  // shape
  for (const [word, shape] of Object.entries(SHAPES)) {
    if (new RegExp(`\\b${word}s?\\b`).test(text)) { spec.shape = shape; break; }
  }

  // material
  for (const [word, mat] of Object.entries(MATERIALS)) {
    if (text.includes(word)) { spec.material = mat; break; }
  }

  // color (explicit word, hex, or rainbow)
  if (/rainbow/.test(text)) spec.color = "rainbow";
  else {
    const hex = text.match(/#([0-9a-f]{6})/);
    if (hex) spec.color = parseInt(hex[1], 16);
    else {
      const c = findColor(text);
      if (c !== null) spec.color = c;
    }
  }

  // size
  for (const [word, v] of Object.entries(SIZES)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) { spec.size = v; break; }
  }
  const meter = text.match(/(\d+(?:\.\d+)?)\s*m(?:eter|etre)?s?\b/);
  if (meter) spec.size = Math.min(GRAB.MAX_SIZE, Math.max(0.2, parseFloat(meter[1])));

  // placement / structure ("pyramid of crates" = structure; a bare "pyramid" = the shape)
  if (/on my head|above me|on top of me/.test(text)) spec.mode = "head";
  else if (/in the sky|from the sky|high in the air/.test(text)) spec.mode = "sky";
  else if (/tower|stack|column/.test(text)) spec.mode = "tower";
  else if (/wall/.test(text)) spec.mode = "wall";
  else if (/pyramid of/.test(text)) spec.mode = "pyramid";
  else if (/rain/.test(text)) spec.mode = "rain";

  if (spec.mode === "pyramid" && (!spec.shape || spec.shape === "pyramid")) spec.shape = "sphere";
  if (!spec.shape) spec.shape = "box";

  const inits = buildPlacements(spec, ctx);
  if (inits.length === 0) return "Hmm, I couldn't figure out where to put those.";
  const spawned = ctx.spawnProps(inits);
  if (spawned === 0) return "The world is full — try “clear” first.";
  ctx.sfx("spawn");
  return describe(spec, spawned);
}

function buildPlacements(spec: SpawnSpec, ctx: ModContext): PropInit[] {
  const color = (i: number): number => {
    if (spec.color === "rainbow") return new THREE.Color().setHSL((i * 0.13) % 1, 0.75, 0.55).getHex();
    return spec.color ?? 0xb8c4d0;
  };
  const base: Omit<PropInit, "pos"> = {
    shape: spec.shape ?? "box",
    size: spec.size,
    material: spec.material ?? "default",
    color: 0,
  };
  const out: PropInit[] = [];

  // anchor point: in front of the player
  const eye = tmpPos.set(ctx.player.pos.x, ctx.player.eyeY, ctx.player.pos.z);
  ctx.player.lookDir(tmpDir);
  const anchor = new THREE.Vector3();
  const inFront = (dist: number): THREE.Vector3 =>
    anchor.copy(eye).addScaledVector(tmpDir, dist);

  switch (spec.mode) {
    case "head": {
      const p = inFront(1.2).clone();
      p.y = ctx.player.pos.y + 2.6;
      for (let i = 0; i < spec.count; i++) {
        out.push({ ...base, color: color(i), pos: { x: p.x + i * 0.1, y: p.y + i * (spec.size + 0.15), z: p.z } });
      }
      break;
    }
    case "sky": {
      for (let i = 0; i < spec.count; i++) {
        const p = inFront(8 + i * 2.5).clone();
        p.y = 14 + (i % 5) * 3;
        p.x += (Math.random() - 0.5) * 10;
        out.push({ ...base, color: color(i), pos: { x: p.x, y: p.y, z: p.z } });
      }
      break;
    }
    case "tower": {
      const n = Math.min(12, Math.max(4, spec.count === 1 ? 8 : spec.count));
      const p = inFront(5).clone();
      for (let i = 0; i < n; i++) {
        out.push({ ...base, color: color(i), pos: { x: p.x, y: spec.size / 2 + 0.05 + i * (spec.size + 0.02), z: p.z } });
      }
      break;
    }
    case "wall": {
      const cols = 5, rows = 3;
      const p = inFront(6).clone();
      // face the wall perpendicular to view
      const right = new THREE.Vector3(tmpDir.z, 0, -tmpDir.x).normalize();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const x = p.x + right.x * (c - (cols - 1) / 2) * (spec.size + 0.06);
          const z = p.z + right.z * (c - (cols - 1) / 2) * (spec.size + 0.06);
          out.push({ ...base, color: color(i), pos: { x, y: spec.size / 2 + 0.05 + r * (spec.size + 0.04), z } });
        }
      }
      break;
    }
    case "pyramid": {
      const p = inFront(6).clone();
      const layers = 4;
      for (let l = 0; l < layers; l++) {
        const perSide = layers - l;
        for (let a = 0; a < perSide; a++) {
          for (let b = 0; b < perSide; b++) {
            const i = l * 100 + a * 10 + b;
            out.push({
              ...base,
              color: color(i),
              pos: {
                x: p.x + (a - (perSide - 1) / 2) * (spec.size + 0.05),
                y: spec.size / 2 + 0.05 + l * (spec.size + 0.03),
                z: p.z + (b - (perSide - 1) / 2) * (spec.size + 0.05),
              },
            });
          }
        }
      }
      break;
    }
    case "rain": {
      for (let i = 0; i < spec.count; i++) {
        const p = inFront(6 + Math.random() * 10).clone();
        p.x += (Math.random() - 0.5) * 14;
        p.z += (Math.random() - 0.5) * 14;
        p.y = 10 + Math.random() * 8;
        out.push({ ...base, color: color(i), pos: { x: p.x, y: p.y, z: p.z } });
      }
      break;
    }
    default: {
      for (let i = 0; i < spec.count; i++) {
        const p = inFront(4 + (i % 5)).clone();
        p.x += (Math.random() - 0.5) * 2.5;
        p.y = Math.max(1.5, ctx.player.pos.y + 3 + (i % 3));
        p.z += (Math.random() - 0.5) * 2.5;
        out.push({ ...base, color: color(i), pos: { x: p.x, y: p.y, z: p.z } });
      }
    }
  }
  return out;
}

function describe(spec: SpawnSpec, n: number): string {
  const parts: string[] = [`Spawned ${n}`];
  if (spec.color === "rainbow") parts.push("rainbow");
  else if (typeof spec.color === "number" && spec.color !== null) {
    parts.push(`#${spec.color.toString(16).padStart(6, "0")}`);
  }
  if (spec.material) parts.push(spec.material);
  if (spec.size !== 1) parts.push(`${spec.size}m`);
  parts.push(spec.shape === "box" ? (n > 1 ? "boxes" : "box") : `${spec.shape}s`);
  const where: Record<SpawnSpec["mode"], string> = {
    drop: "in front of you", head: "on your head", sky: "in the sky",
    tower: "as a tower", wall: "as a wall", pyramid: "as a pyramid", rain: "raining from above",
  };
  parts.push(where[spec.mode] + ".");
  return parts.join(" ");
}

function findColor(text: string): number | null {
  for (const [name, hex] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return hex;
  }
  return null;
}
