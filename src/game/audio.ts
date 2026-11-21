/**
 * audio.ts — Web Audio synthesized SFX + ambient music layer + mute toggle (remembered in localStorage).
 * No audio asset files at all — everything is synthesized at runtime.
 */

export type SfxId =
  | "spawn" | "grab" | "release" | "freeze" | "del" | "jump" | "land"
  | "ui" | "error" | "console" | "pop" | "boom";

const MUTE_KEY = "game.muted";

// localStorage can throw (storage disabled, private mode, third-party storage blocked
// inside a preview iframe) — a game must never fail to start because of that.
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // not persisted this session; the in-memory flag still works
  }
}

interface ToneSpec {
  type: OscillatorType;
  f0: number;
  f1: number;
  dur: number;
  gain: number;
}

/** Oscillator-based tones; "noise" entries are handled separately. */
const TONES: Partial<Record<SfxId, ToneSpec>> = {
  spawn: { type: "sine", f0: 330, f1: 660, dur: 0.12, gain: 0.22 },
  grab: { type: "triangle", f0: 220, f1: 330, dur: 0.08, gain: 0.2 },
  release: { type: "triangle", f0: 330, f1: 200, dur: 0.1, gain: 0.2 },
  freeze: { type: "square", f0: 880, f1: 880, dur: 0.06, gain: 0.12 },
  del: { type: "sawtooth", f0: 300, f1: 60, dur: 0.15, gain: 0.22 },
  jump: { type: "sine", f0: 260, f1: 420, dur: 0.12, gain: 0.15 },
  land: { type: "sine", f0: 140, f1: 70, dur: 0.1, gain: 0.2 },
  ui: { type: "sine", f0: 440, f1: 520, dur: 0.05, gain: 0.14 },
  error: { type: "square", f0: 180, f1: 120, dur: 0.18, gain: 0.18 },
  console: { type: "sine", f0: 520, f1: 700, dur: 0.06, gain: 0.14 },
  pop: { type: "sine", f0: 500, f1: 900, dur: 0.07, gain: 0.16 },
  boom: { type: "sawtooth", f0: 120, f1: 25, dur: 0.5, gain: 0.4 },
};

/** Noise-burst specs for percussive events. */
const NOISES: Partial<Record<SfxId, { dur: number; gain: number; lowpass: number }>> = {
  del: { dur: 0.08, gain: 0.15, lowpass: 2400 },
  land: { dur: 0.06, gain: 0.12, lowpass: 900 },
  boom: { dur: 0.4, gain: 0.35, lowpass: 500 },
};

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicNodes: AudioNode[] = [];
  private noiseBuf: AudioBuffer | null = null;
  private disposed = false;
  muted = false;

  // browsers require a first user interaction before the AudioContext can start
  private readonly unlock = () => {
    this.ensureCtx();
    this.detachUnlock();
  };

  constructor() {
    this.muted = readMuted();
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  /** Release everything. Call from stopGame() — otherwise StrictMode/HMR leaks one AudioContext per mount. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachUnlock();
    this.stopMusic();
    this.master?.disconnect();
    this.master = null;
    this.noiseBuf = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  sfx(id: SfxId): void {
    if (this.disposed || this.muted) return; // muted: no context is created either
    const ctx = this.ensureCtx();
    if (!this.master) return;
    const t = ctx.currentTime;

    const tone = TONES[id];
    if (tone) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, tone.f1), t + tone.dur);
      env.gain.setValueAtTime(tone.gain, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + tone.dur);
      osc.connect(env).connect(this.master);
      osc.start(t);
      osc.stop(t + tone.dur);
    }

    const noise = NOISES[id];
    if (noise) {
      if (!this.noiseBuf) {
        const len = Math.floor(ctx.sampleRate * 0.5);
        this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = noise.lowpass;
      const env = ctx.createGain();
      env.gain.setValueAtTime(noise.gain, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + noise.dur);
      src.connect(filter).connect(env).connect(this.master);
      src.start(t);
      src.stop(t + noise.dur);
    }
  }

  /** Ambient pad: two detuned sines + slow LFO — quiet, keeps the world alive while idle. */
  startMusic(): void {
    if (this.disposed || this.musicNodes.length > 0) return;
    const ctx = this.ensureCtx();
    const mk = (freq: number, gain: number) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g).connect(this.master!);
      osc.start();
      this.musicNodes.push(osc, g);
    };
    mk(55, 0.045); // A1
    mk(82.5, 0.03); // E2
    mk(110.2, 0.02); // A2 detuned shimmer
  }

  stopMusic(): void {
    for (const n of this.musicNodes) {
      if (n instanceof OscillatorNode) {
        try { n.stop(); } catch { /* already stopped */ }
      }
      n.disconnect();
    }
    this.musicNodes = [];
  }
}
