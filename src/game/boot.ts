/**
 * boot.ts — SANDBOX AI: a Gmod-style 3D sandbox in the browser.
 * Owns the renderer/scene, the title → playing ⇄ paused flow, the HUD/console DOM,
 * physics stepping, tools, saves, and the mod-console wiring.
 *
 * Contract with the React shell (src/pages/Home.tsx):
 *   startGame(canvas)  mounts renderer + loop onto an existing <canvas>
 *   stopGame()         tears everything down
 */

import * as THREE from "three";
import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import { Player } from "./player";
import { PropWorld, setWorldSurfaces } from "./props";
import { Tools, TOOL_INFO } from "./tools";
import { Particles } from "./fx";
import { runCommand, type ModContext } from "./mods";
import { storage } from "./storage";
import { PHYSICS, PLAYER, SAVE_KEY, WORLD_DEFAULTS } from "./config";
import type { SaveData, SerializedProp, WorldSettings } from "./types";
import { GameStateMachine } from "./state";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
  }
}

let session: { dispose: () => void } | null = null;

export function stopGame(): void {
  session?.dispose();
  session = null;
}

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();

  // ------------------------------------------------------------ renderer / scene
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.08, 500);

  const settings: WorldSettings = {
    gravity: WORLD_DEFAULTS.gravity,
    timeScale: 1,
    restitution: PHYSICS.DEFAULT_RESTITUTION,
    friction: PHYSICS.DEFAULT_FRICTION,
    skyColor: WORLD_DEFAULTS.skyColor,
    sunColor: WORLD_DEFAULTS.sunColor,
    sunIntensity: WORLD_DEFAULTS.sunIntensity,
    fogDensity: 0,
  };

  const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x3a4a3a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(settings.sunColor, settings.sunIntensity);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 160;
  scene.add(sun);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a6741, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // subtle grid for motion perception
  const grid = new THREE.GridHelper(400, 100, 0x5c7a52, 0x54704b);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.25;
  grid.position.y = 0.02;
  scene.add(grid);

  function applyWorldSettings(): void {
    scene.background = new THREE.Color(settings.skyColor);
    sun.color.setHex(settings.sunColor);
    sun.intensity = settings.sunIntensity;
    hemi.intensity = settings.sunIntensity < 1 ? 0.35 : 0.9;
    if (settings.fogDensity > 0) scene.fog = new THREE.FogExp2(settings.skyColor, settings.fogDensity);
    else scene.fog = null;
  }
  applyWorldSettings();

  // ------------------------------------------------------------ world / player / systems
  const world = new PropWorld(settings);
  scene.add(world.group);
  const player = new Player(settings);
  const input = new Input(canvas);
  const audio = new AudioSystem();
  const fx = new Particles();
  scene.add(fx.points);
  const fsm = new GameStateMachine();

  // physgun beam
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
  const beamMat = new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.9 });
  const beam = new THREE.Line(beamGeo, beamMat);
  beam.frustumCulled = false;
  beam.visible = false;
  scene.add(beam);

  // ------------------------------------------------------------ DOM UI
  const overlay = document.getElementById("ui-overlay") ?? document.body;
  const ui = buildUI(overlay);

  function toast(msg: string, kind: "info" | "error" = "info"): void {
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.textContent = msg;
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 5) ui.toasts.firstChild?.remove();
    setTimeout(() => el.classList.add("show"), 16);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 400);
    }, 3400);
  }

  // ------------------------------------------------------------ save / load
  function saveWorld(): boolean {
    const data: SaveData = {
      version: 1,
      world: { ...settings },
      props: world.serialize(),
    };
    storage.set(SAVE_KEY, data);
    return true;
  }
  function loadWorld(): number {
    const data = storage.get<SaveData | null>(SAVE_KEY, null);
    if (!data || data.version !== 1) return -1;
    Object.assign(settings, data.world);
    setWorldSurfaces(PHYSICS.DEFAULT_RESTITUTION, PHYSICS.DEFAULT_FRICTION);
    applyWorldSettings();
    return world.deserialize(data.props ?? []);
  }
  function resetWorld(): void {
    world.clear();
    Object.assign(settings, {
      gravity: WORLD_DEFAULTS.gravity, timeScale: 1,
      skyColor: WORLD_DEFAULTS.skyColor, sunColor: WORLD_DEFAULTS.sunColor,
      sunIntensity: WORLD_DEFAULTS.sunIntensity, fogDensity: 0,
    });
    setWorldSurfaces(PHYSICS.DEFAULT_RESTITUTION, PHYSICS.DEFAULT_FRICTION);
    applyWorldSettings();
    player.pos.set(0, 0, 8);
    player.vel.set(0, 0, 0);
  }

  // ------------------------------------------------------------ tools
  let shakeAmt = 0;
  const tools = new Tools(world, {
    onGrab() {}, onRelease() {}, onFreeze(p) { fx.burst(p.group.position, 0x9fd8ff, 14, 3); },
    onDelete(p) { fx.burst(p.group.position, p.color, 22, 5); },
    onSpawn(p) { fx.burst(p.group.position, p.color, 14, 3.5); },
    sfx: (id) => audio.sfx(id),
  });

  // ------------------------------------------------------------ mod console
  let consoleOpen = false;
  const history: string[] = [];
  let historyIdx = -1;

  const modCtx: ModContext = {
    world, settings, player,
    applyWorldSettings,
    spawnProps: (inits) => {
      let n = 0;
      let first: THREE.Vector3 | null = null;
      for (const init of inits) {
        const p = world.spawn(init);
        if (p) {
          n++;
          first ??= p.group.position.clone();
          world.kick(p, 1.5);
        }
      }
      if (first) fx.burst(first, 0xffffff, 10, 2.5);
      return n;
    },
    shake: () => { shakeAmt = 0.5; },
    sfx: (id) => audio.sfx(id),
  };

  function openConsole(): void {
    if (fsm.state !== "playing" || consoleOpen) return;
    consoleOpen = true;
    ui.consoleBox.classList.add("open");
    ui.consoleInput.value = "";
    ui.consoleInput.focus();
    audio.sfx("console");
    document.exitPointerLock?.();
  }
  function closeConsole(): void {
    if (!consoleOpen) return;
    consoleOpen = false;
    lastConsoleClose = performance.now();
    ui.consoleBox.classList.remove("open");
    ui.consoleInput.blur();
    canvas.focus();
    if (fsm.state === "playing") lockPointer();
  }
  function submitConsole(): void {
    const text = ui.consoleInput.value.trim();
    if (!text) { closeConsole(); return; }
    history.unshift(text);
    if (history.length > 40) history.pop();
    historyIdx = -1;
    ui.consoleInput.value = "";
    consoleOpen = false;
    ui.consoleBox.classList.remove("open");
    ui.consoleInput.blur();
    if (fsm.state === "playing") lockPointer();

    const reply = runCommand(text, modCtx);
    if (reply === "HELP") {
      ui.helpPanel.classList.toggle("open");
    } else if (reply === "SAVE") {
      saveWorld();
      toast(`World saved (${world.count} props).`);
      audio.sfx("ui");
    } else if (reply === "LOAD") {
      const n = loadWorld();
      if (n >= 0) { toast(`Loaded ${n} props.`); audio.sfx("ui"); }
      else { toast("No saved world found.", "error"); audio.sfx("error"); }
    } else if (reply.startsWith("I don't understand")) {
      toast(reply, "error");
      audio.sfx("error");
    } else {
      toast(reply);
      audio.sfx("pop");
    }
  }

  ui.consoleInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); submitConsole(); }
    else if (e.key === "Escape") { e.preventDefault(); closeConsole(); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIdx < history.length - 1) { historyIdx++; ui.consoleInput.value = history[historyIdx]; }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx > 0) { historyIdx--; ui.consoleInput.value = history[historyIdx]; }
      else { historyIdx = -1; ui.consoleInput.value = ""; }
    }
  });
  ui.consoleForm.addEventListener("submit", (e) => { e.preventDefault(); submitConsole(); });

  // ------------------------------------------------------------ pointer lock / states
  /** Timestamp of the last console close — a lockchange shortly after it is the console's own
   *  unlock arriving late (or a re-lock request denied by the browser cooldown), not the user pausing. */
  let lastConsoleClose = 0;

  function lockPointer(): void {
    if (document.pointerLockElement !== canvas) {
      try {
        // returns a Promise in newer Chromium; frequent requests hit a browser
        // cooldown and reject — that is not an error, the user can click to re-lock
        const req = canvas.requestPointerLock?.() as unknown;
        if (req && typeof (req as Promise<void>).catch === "function") {
          (req as Promise<void>).catch(() => {});
        }
      } catch { /* cooldown or unsupported: ignore */ }
    }
  }
  function startPlaying(): void {
    if (fsm.state === "title") fsm.transition("playing");
    else if (fsm.state === "paused") fsm.transition("playing");
    ui.title.classList.remove("open");
    ui.pause.classList.remove("open");
    audio.startMusic();
    lockPointer();
  }
  function pauseGame(): void {
    if (fsm.state !== "playing") return;
    fsm.transition("paused");
    tools.drop();
    ui.pause.classList.add("open");
    document.exitPointerLock?.();
  }

  const onLockChange = () => {
    if (document.pointerLockElement !== canvas && fsm.state === "playing" && !consoleOpen) {
      // ignore lock changes that are the console's own unlock arriving late, or a re-lock
      // request the browser denied (pointer lock has a ~1.3s re-request cooldown)
      if (performance.now() - lastConsoleClose < 800) return;
      pauseGame();
    }
  };
  document.addEventListener("pointerlockchange", onLockChange);
  canvas.addEventListener("pointerdown", () => {
    if (fsm.state === "playing" && !consoleOpen) lockPointer();
  });

  ui.btnStart.addEventListener("click", startPlaying);
  ui.btnResume.addEventListener("click", startPlaying);
  ui.btnReset.addEventListener("click", () => { resetWorld(); toast("World reset."); startPlaying(); });
  ui.btnHelp2.addEventListener("click", () => ui.helpPanel.classList.toggle("open"));
  ui.btnSave.addEventListener("click", () => { saveWorld(); toast(`World saved (${world.count} props).`); });
  ui.btnLoad.addEventListener("click", () => {
    const n = loadWorld();
    if (n >= 0) toast(`Loaded ${n} props.`);
    else toast("No saved world found.", "error");
  });

  fsm.onChange((s) => {
    ui.root.dataset.state = s;
  });

  // global keys for UI-level actions
  const onKeyDown = (e: KeyboardEvent) => {
    if (consoleOpen) return; // console input handles its own keys
    if (e.code === "Enter" || e.code === "Backquote") {
      if (fsm.state === "playing") { e.preventDefault(); openConsole(); }
      return;
    }
    if (fsm.state === "title" && (e.code === "Space" || e.code === "Enter")) {
      e.preventDefault();
      startPlaying();
      return;
    }
    if (fsm.state === "paused" && e.code === "Escape") {
      // pointer lock exit put us here; Escape again resumes
      startPlaying();
      return;
    }
    if (fsm.state !== "playing") return;
    if (e.code === "Escape") {
      // when pointer lock is active the browser swallows Esc and fires pointerlockchange
      // instead; this covers the not-locked case (and pointers that never locked)
      if (!consoleOpen && document.pointerLockElement !== canvas) pauseGame();
      return;
    }
    if (e.code === "KeyM") {
      const muted = audio.toggleMute();
      toast(muted ? "Sound off" : "Sound on");
    }
    if (e.code === "KeyH") ui.helpPanel.classList.toggle("open");
  };
  window.addEventListener("keydown", onKeyDown);

  // ------------------------------------------------------------ main loop
  let simAcc = 0;
  let played = false;
  const tmp = new THREE.Vector3();
  let lastRenderT = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let qualityTier = 0;

  const loop = new GameLoop({
    update: (step) => {
      if (fsm.state !== "playing") return;
      const jump = input.consumeAction("Space");
      if (jump && player.grounded && !consoleOpen) audio.sfx("jump");

      tools.update(step, player, input, consoleOpen);

      simAcc += step * settings.timeScale;
      const dt = PHYSICS.FIXED_STEP;
      let substeps = 0;
      while (simAcc >= dt && substeps < PHYSICS.MAX_SUBSTEPS) {
        player.step(dt, input, world, jump);
        world.step(dt);
        simAcc -= dt;
        substeps++;
      }
      if (substeps === PHYSICS.MAX_SUBSTEPS) simAcc = 0;

      fx.step(step * settings.timeScale, settings.gravity);

      if (player.landedHard) { player.landedHard = false; audio.sfx("land"); }

      // HUD refresh (cheap DOM writes only when changed)
      updateHud();
    },
    render: () => {
      // rolling FPS → quality tiers (weak GPUs / software rendering)
      const now = performance.now();
      const delta = now - lastRenderT;
      lastRenderT = now;
      if (fsm.state === "playing" && delta < 500) {
        fpsAccum += delta;
        fpsFrames++;
        if (fpsAccum >= 2000) {
          const fps = (fpsFrames * 1000) / fpsAccum;
          fpsAccum = 0; fpsFrames = 0;
          if (fps < 45 && qualityTier < 2) {
            qualityTier++;
            if (qualityTier === 1) {
              renderer.setPixelRatio(1);
              toast("Performance mode: reduced resolution");
            } else {
              sun.castShadow = false;
              renderer.setPixelRatio(0.75);
              toast("Performance mode: shadows off");
            }
          }
        }
      }
      player.applyLook(input);
      const shake = shakeAmt;
      shakeAmt = Math.max(0, shakeAmt - 0.02);
      camera.position.set(
        player.pos.x + (Math.random() - 0.5) * shake * 0.3,
        player.eyeY + (Math.random() - 0.5) * shake * 0.3,
        player.pos.z + (Math.random() - 0.5) * shake * 0.3,
      );
      camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");

      // physgun beam
      const held = tools.heldProp;
      if (held) {
        beam.visible = true;
        beamMat.color.setHex(held.frozen ? 0xff8899 : 0x66ffcc);
        const pos = beamGeo.getAttribute("position") as THREE.BufferAttribute;
        // from the gun tip (lower-right of view) to the prop
        tmp.set(0.35, -0.3, -0.6).applyQuaternion(camera.quaternion).add(camera.position);
        pos.setXYZ(0, tmp.x, tmp.y, tmp.z);
        pos.setXYZ(1, held.group.position.x, held.group.position.y, held.group.position.z);
        pos.needsUpdate = true;
      } else {
        beam.visible = false;
      }

      renderer.render(scene, camera);
      if (!played) {
        played = true;
        window.__GAME_READY__ = true;
      }
    },
  });
  loop.start();

  // ------------------------------------------------------------ HUD helpers
  let lastToolLine = "";
  let lastCount = -1;
  function updateHud(): void {
    const info = TOOL_INFO[tools.current];
    const line = `${info.name} — ${info.hint}`;
    if (line !== lastToolLine) { ui.toolLine.textContent = line; lastToolLine = line; }
    if (world.count !== lastCount) { ui.propCount.textContent = `${world.count} props`; lastCount = world.count; }
    const target = tools.hovered;
    const label = target ? `${target.shape} · ${target.frozen ? "frozen" : "free"} · size ${target.size}` : "";
    if (ui.hoverLabel.textContent !== label) ui.hoverLabel.textContent = label;
    ui.crosshair.dataset.tool = tools.current;
    ui.crosshair.dataset.hold = tools.heldProp ? "1" : "0";
  }

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", onResize);

  window.__gameProbe = () => ({ x: player.pos.x, y: player.pos.y, z: player.pos.z });
  // debug/testing handle (used by the verification script)
  (window as unknown as Record<string, unknown>).__sandbox = { tools, world, player, settings, fsm };

  // title screen shows on boot
  ui.title.classList.add("open");
  ui.root.dataset.state = "title";

  session = {
    dispose: () => {
      loop.stop();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerlockchange", onLockChange);
      input.dispose();
      audio.dispose();
      fx.dispose();
      tools.dispose();
      world.clear();
      renderer.dispose();
      overlay.innerHTML = "";
      delete window.__gameProbe;
      delete (window as unknown as Record<string, unknown>).__sandbox;
      window.__GAME_READY__ = false;
    },
  };
}

/** Build the DOM overlay (HUD, screens, console). Returns the element handles boot needs. */
function buildUI(overlay: HTMLElement) {
  overlay.innerHTML = `
    <div id="hud">
      <div id="crosshair" data-tool="physgun"><span></span></div>
      <div id="hover-label"></div>
      <div id="tool-line"></div>
      <div id="prop-count"></div>
      <div id="keys-line">WASD move · Space jump · E/RMB grab · 1/2/3 tools · Enter AI console · H help</div>
    </div>
    <div id="toasts"></div>
    <div id="title-screen" class="screen">
      <h1>SANDBOX<span>AI</span></h1>
      <p class="tagline">A Gmod-style physics sandbox you mod with words.</p>
      <div class="title-examples">
        <em>"spawn 5 big red metal balls"</em>
        <em>"tower of crates"</em>
        <em>"moon gravity"</em>
        <em>"make it night"</em>
        <em>"rain donuts"</em>
      </div>
      <button id="btn-start" class="big-btn">CLICK TO PLAY</button>
      <p class="fine">WASD move · mouse look · Space jump · hold E or Right-Mouse to grab, scroll for distance, click to freeze, release to throw</p>
    </div>
    <div id="pause-screen" class="screen">
      <h2>PAUSED</h2>
      <button id="btn-resume" class="big-btn">RESUME</button>
      <div class="row">
        <button id="btn-save">Save world</button>
        <button id="btn-load">Load world</button>
        <button id="btn-help2">Help</button>
        <button id="btn-reset" class="danger">Reset world</button>
      </div>
      <p class="fine">Saves live in this browser only (localStorage).</p>
    </div>
    <div id="help-panel">
      <h3>What the AI understands</h3>
      <div class="help-cols">
        <div>
          <h4>Spawning</h4>
          <p>"spawn 5 small blue balls"<br>"a huge wooden crate"<br>"tower of crates" · "wall of metal boxes"<br>"rain glass spheres" · "pyramid of 8 balls"</p>
          <h4>Placement</h4>
          <p>"on my head" · "in the sky" · "in front of me"</p>
        </div>
        <div>
          <h4>World mods</h4>
          <p>"low gravity" / "moon gravity" / "no gravity"<br>"slow motion" · "time is 2x"<br>"make it night" / "sunset" · "sky is purple"<br>"add fog" · "make everything bouncy"<br>"everything is slippery"</p>
          <h4>Utilities</h4>
          <p>"explode" · "clear" · "save" · "load"</p>
        </div>
      </div>
      <p class="fine">Press H or type "help" to close</p>
    </div>
    <form id="console-box" autocomplete="off">
      <span class="prompt">mod&gt;</span>
      <input id="console-input" type="text" placeholder='Describe a mod… e.g. "spawn 3 huge red cubes"' maxlength="140" />
    </form>
  `;
  const $ = (id: string) => overlay.querySelector(id) as HTMLElement;
  return {
    root: overlay,
    hud: $("#hud"),
    crosshair: $("#crosshair"),
    hoverLabel: $("#hover-label"),
    toolLine: $("#tool-line"),
    propCount: $("#prop-count"),
    toasts: $("#toasts"),
    title: $("#title-screen"),
    pause: $("#pause-screen"),
    helpPanel: $("#help-panel"),
    consoleBox: $("#console-box") as HTMLFormElement,
    consoleInput: $("#console-input") as HTMLInputElement,
    consoleForm: $("#console-box") as HTMLFormElement,
    btnStart: $("#btn-start"),
    btnResume: $("#btn-resume"),
    btnReset: $("#btn-reset"),
    btnHelp2: $("#btn-help2"),
    btnSave: $("#btn-save"),
    btnLoad: $("#btn-load"),
  };
}
