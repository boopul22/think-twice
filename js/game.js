// ---- js/sdk.js ----
// Thin wrapper around the Poki SDK.
// - Works when the SDK is missing (local file://, ad blockers, other portals).
// - Guards against double gameplayStart/gameplayStop calls (a Poki QA requirement).
// - Mutes audio and blocks input while an ad is playing.
(function () {
  const has = () => typeof window.PokiSDK !== 'undefined';
  const shield = () => document.getElementById('adblock-shield');

  const SDK = {
    playing: false,
    inAd: false,

    init() {
      return new Promise((resolve) => {
        if (!has()) return resolve(false);
        try {
          window.PokiSDK.init().then(() => resolve(true)).catch(() => resolve(false));
        } catch (e) { resolve(false); }
      });
    },

    loadingFinished() {
      if (has()) try { window.PokiSDK.gameLoadingFinished(); } catch (e) {}
    },

    gameplayStart() {
      if (this.playing || this.inAd) return;
      this.playing = true;
      if (has()) try { window.PokiSDK.gameplayStart(); } catch (e) {}
    },

    gameplayStop() {
      if (!this.playing) return;
      this.playing = false;
      if (has()) try { window.PokiSDK.gameplayStop(); } catch (e) {}
    },

    _beginAd() {
      this.inAd = true;
      shield().classList.remove('hidden');
      window.GameAudio && GameAudio.setAdMute(true);
    },

    _endAd() {
      this.inAd = false;
      shield().classList.add('hidden');
      window.GameAudio && GameAudio.setAdMute(false);
    },

    // Call only when heading back into gameplay. Resolves when the game may continue.
    commercialBreak() {
      return new Promise((resolve) => {
        if (!has() || this.inAd) return resolve();
        this.gameplayStop();
        this._beginAd();
        const done = () => { this._endAd(); resolve(); };
        try {
          window.PokiSDK.commercialBreak(() => GameAudio.setAdMute(true)).then(done).catch(done);
        } catch (e) { done(); }
      });
    },

    // Resolves true only when the ad was actually shown (no reward otherwise).
    rewardedBreak() {
      return new Promise((resolve) => {
        if (!has() || this.inAd) return resolve(false);
        this.gameplayStop();
        this._beginAd();
        const done = (ok) => { this._endAd(); resolve(!!ok); };
        try {
          window.PokiSDK.rewardedBreak(() => GameAudio.setAdMute(true)).then(done).catch(() => done(false));
        } catch (e) { done(false); }
      });
    },
  };

  window.SDK = SDK;
})();

// ---- js/audio.js ----
// Think Twice! sound. Everything is synthesized with WebAudio at runtime: no audio files, no requests.
//
//   sound voices ─► sfxBus ──┐
//   music notes ─► session ─► musicBus ─┴► glue compressor ► limiter ► soft clip ► out ► speakers
//
// Nothing is created or played before unlock() runs inside a user gesture. Ads (setAdMute) and a
// hidden tab (setHidden) silence everything, stop the music scheduler and suspend the context.
(function () {
  'use strict';
  const AC = window.AudioContext || window.webkitAudioContext;
  const MUSIC_LEVEL = 0.15;   // music bus level, well under the effects
  const MAX_VOICES = 24;      // hard cap on simultaneous sound effects

  let ctx = null, sfxBus = null, musicBus = null, out = null, noiseBuf = null, unlockedAt = 0;
  let userMuted = false, adMuted = false, musicOn = true, hidden = false;
  const W = {};               // periodic waves, built once
  const silent = () => adMuted || hidden;
  const disc = (n) => { try { n.disconnect(); } catch (e) { /* already gone */ } };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------- context + master chain ----------
  function ensure() {
    if (ctx) return ctx;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; return null; }
    const glue = ctx.createDynamicsCompressor();     // gentle bus glue (also ducks music under big hits)
    glue.threshold.value = -14; glue.knee.value = 10; glue.ratio.value = 3;
    glue.attack.value = 0.004; glue.release.value = 0.12;
    const lim = ctx.createDynamicsCompressor();      // fast limiter
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.04;
    const clip = ctx.createWaveShaper();             // final safety: nothing can exceed ~0.86
    clip.curve = clipCurve(); clip.oversample = '2x';
    out = ctx.createGain(); out.gain.value = silent() ? 0 : 1;
    sfxBus = ctx.createGain(); sfxBus.gain.value = userMuted ? 0 : 1;
    musicBus = ctx.createGain(); musicBus.gain.value = musicOn ? MUSIC_LEVEL : 0;
    sfxBus.connect(glue); musicBus.connect(glue);
    glue.connect(lim); lim.connect(clip); clip.connect(out); out.connect(ctx.destination);

    // one shared second of white noise, reused (looped from a random offset) by every noisy sound
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    const harm = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));
    W.brass = wave(harm(14, (k) => 1 / k));                                    // band-limited saw
    W.pluck = wave(harm(10, (k) => 1 / Math.pow(k, 1.6)));                     // soft string
    W.pulse = wave(harm(12, (k) => Math.sin(k * Math.PI * 0.25) / k));         // 25% pulse, chiptune coin
    return ctx;
  }

  function wave(amps) {
    const real = new Float32Array(amps.length + 1), imag = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => { imag[i + 1] = a; });
    return ctx.createPeriodicWave(real, imag);
  }

  function clipCurve() {   // linear up to 0.6, then eases toward a 0.9 ceiling
    const n = 2049, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
      const y = ax <= 0.6 ? ax : 0.6 + 0.3 * Math.tanh((ax - 0.6) / 0.3);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }

  function glide(p, v, tc) {
    const t = ctx.currentTime;
    try {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else { const cur = p.value; p.cancelScheduledValues(t); p.setValueAtTime(cur, t); }
      p.setTargetAtTime(v, t, tc);
    } catch (e) { p.value = v; }
  }
  function hold(p, v) {
    const t = ctx.currentTime;
    try { p.cancelScheduledValues(t); p.setValueAtTime(v, t); } catch (e) { p.value = v; }
  }

  function apply() {
    if (!ctx) return;
    const s = silent();
    if (s) { hold(out.gain, 0); killAll(true); } else glide(out.gain, 1, 0.03);
    glide(sfxBus.gain, userMuted ? 0 : 1, 0.012);
    glide(musicBus.gain, musicOn ? MUSIC_LEVEL : 0, 0.06);
    if (musicOn && !s) startMusic(); else stopMusic(s);
  }

  function syncContext() {
    if (!ctx) return;
    try {
      const p = silent() ? ctx.suspend() : ctx.resume();   // always issue: calls resolve in order
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* closed or unsupported */ }
  }

  // ---------- building blocks ----------
  // Every source is started, stopped and tracked by an owner (a sound voice or the music session);
  // when it ends, its whole chain is disconnected so nothing piles up.
  function shape(p, t, a, vol, h, d) {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(vol, t + a);
    if (h) p.setValueAtTime(vol, t + a + h);
    p.exponentialRampToValueAtTime(0.0001, t + a + h + d);
  }
  function path(p, t, pts) {
    p.setValueAtTime(pts[0][1], t + pts[0][0]);
    for (let i = 1; i < pts.length; i++) p.exponentialRampToValueAtTime(pts[i][1], t + pts[i][0]);
  }

  // o: { t, f, to, glide, type|wave, a, hold, d, vol, detune, filter, ff|fenv, q, vib, vibDepth }
  function tone(own, o) {
    const t = o.t, a = o.a == null ? 0.004 : o.a, h = o.hold || 0, d = o.d == null ? 0.15 : o.d;
    const end = t + a + h + d + 0.02;
    const osc = ctx.createOscillator();
    if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || a + h + d));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const g = ctx.createGain();
    shape(g.gain, t, a, o.vol, h, d);
    const nodes = [osc, g];
    let head = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter;
      if (o.q != null) f.Q.value = o.q;
      if (o.fenv) path(f.frequency, t, o.fenv); else f.frequency.setValueAtTime(o.ff, t);
      osc.connect(f); head = f; nodes.push(f);
    }
    head.connect(g); g.connect(own.dst);
    osc.start(t); osc.stop(end);
    own.track(osc, nodes, end);
    if (o.vib) lfo(own, osc.frequency, o.vib, o.vibDepth, t, end);
  }

  function lfo(own, param, rate, depth, t, end) {
    const l = ctx.createOscillator(), g = ctx.createGain();
    l.frequency.value = rate; g.gain.value = depth;
    l.connect(g); g.connect(param);
    l.start(t); l.stop(end);
    own.track(l, [l, g], end);
  }

  // filtered slice of the shared noise buffer. o: { t, type, f, to, glide, fenv, q, a, hold, d, vol }
  function noise(own, o) {
    const t = o.t, a = o.a == null ? 0.005 : o.a, h = o.hold || 0, d = o.d == null ? 0.1 : o.d;
    const end = t + a + h + d + 0.02;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    if (o.q != null) f.Q.value = o.q;
    if (o.fenv) path(f.frequency, t, o.fenv);
    else {
      f.frequency.setValueAtTime(o.f || 1000, t);
      if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || a + h + d));
    }
    const g = ctx.createGain();
    shape(g.gain, t, a, o.vol, h, d);
    s.connect(f); f.connect(g); g.connect(own.dst);
    s.start(t, Math.random() * 0.8); s.stop(end);
    own.track(s, [s, f, g], end);
  }

  // glockenspiel-like bell: fundamental plus two quickly fading inharmonic partials
  const BELL = [[1, 1, 1], [2.756, 0.3, 0.3], [5.404, 0.1, 0.15]];
  function bell(own, o) {
    const n = o.partials || 3, br = o.bright == null ? 1 : o.bright;
    for (let i = 0; i < n; i++) {
      const p = BELL[i], f = o.f * p[0];
      if (f > 11000) break;
      tone(own, { t: o.t, f, a: i ? 0.001 : 0.002, d: o.d * p[2], vol: o.vol * p[1] * (i ? br : 1) });
    }
  }

  // marimba: round fundamental + the woody 4th-harmonic "knock"
  function mallet(own, o) {
    tone(own, { t: o.t, f: o.f, a: 0.002, d: o.d, vol: o.vol });
    tone(own, { t: o.t, f: o.f * 4, a: 0.001, d: Math.min(0.08, o.d * 0.3), vol: o.vol * 0.2 });
  }

  function brass(own, o) {
    const f = o.f, h = o.hold || 0;
    tone(own, {
      t: o.t, wave: W.brass, f, a: 0.018, hold: h, d: o.d, vol: o.vol, detune: o.detune,
      vib: o.vib, vibDepth: o.vibDepth,
      filter: 'lowpass', fenv: [[0, f * 1.2], [0.035, Math.min(f * 6, 9000)], [h + o.d, f * 1.8]],
    });
  }

  function pluck(own, t, f, vol, d, bright) {
    tone(own, { t, wave: W.pluck, f, a: 0.002, d, vol, filter: 'lowpass', fenv: [[0, bright], [0.1, Math.max(f * 1.5, 500)]] });
  }

  // dip the music under a big stinger, then let it swell back
  function duck(t, dur) {
    if (!musicOn) return;
    const p = musicBus.gain;
    try {
      glide(p, MUSIC_LEVEL * 0.4, 0.03);
      p.setTargetAtTime(MUSIC_LEVEL, t + dur, 0.3);
    } catch (e) { /* ignore */ }
  }

  function kick(own, t, vol) {
    tone(own, { t, f: 150, to: 48, glide: 0.16, a: 0.001, d: 0.3, vol });
    noise(own, { t, type: 'lowpass', f: 900, a: 0.0008, d: 0.03, vol: vol * 0.35 });
  }

  // ---------- sound-effect voices ----------
  const voices = [];   // oldest first

  function voice(name, cap, lvl) {
    let same = 0;
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].name === name && ++same >= cap) retire(voices[i]);
    }
    while (voices.length >= MAX_VOICES) retire(voices[0]);
    const g = ctx.createGain();
    g.gain.value = lvl;
    g.connect(sfxBus);
    const v = { name, g, dst: g, nodes: [g], srcs: [], live: 0, end: 0, dead: false };
    v.track = (src, nodes, end) => {
      v.live++; v.srcs.push(src); src._end = end;
      if (end > v.end) v.end = end;
      src.onended = () => { nodes.forEach(disc); if (--v.live <= 0) finish(v); };
    };
    v.sub = (pan) => {   // a panned branch of this voice
      if (!ctx.createStereoPanner) return { dst: g, track: v.track, node: null };
      const p = ctx.createStereoPanner();
      p.pan.value = pan; p.connect(g); v.nodes.push(p);
      return { dst: p, track: v.track, node: p };
    };
    voices.push(v);
    return v;
  }

  function finish(v) {
    if (v.dead) return;
    v.dead = true;
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    v.nodes.forEach(disc);
    v.srcs.length = 0;
  }

  // fade a voice out fast (soft) or cut it now (hard, used when going silent)
  function retire(v, hard) {
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    if (v.dead) return;
    const t = ctx.currentTime, at = hard ? t : t + 0.035;
    if (!hard) {
      const p = v.g.gain;
      try { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0, at); } catch (e) { /* ignore */ }
    }
    v.srcs.forEach((s) => {
      if (s._end > at) { s._end = at; try { s.stop(at); } catch (e) { /* not started */ } }
    });
    if (hard) finish(v);
  }

  function killAll(hard) { voices.slice().forEach((v) => retire(v, hard)); }

  // ---------- the sounds ----------
  // def(name, cap, minGapMs, pitchJitter, level, fn(voice, t, opts, pitchRatio))
  const SFX = Object.create(null);
  function def(name, cap, gap, jit, lvl, fn) { SFX[name] = { cap, gap, jit, lvl, fn, last: 0 }; }

  // UI button: soft round "pok"
  def('click', 3, 25, 0.02, 0.7, (v, t, o, r) => {
    tone(v, { t, f: 1250 * r, to: 620 * r, glide: 0.045, a: 0.0015, d: 0.07, vol: 0.3 });
    tone(v, { t, type: 'triangle', f: 2500 * r, a: 0.0008, d: 0.014, vol: 0.06 });
  });

  // tapping a scene object: bouncy marimba "bop"
  def('tap', 4, 25, 0.05, 0.55, (v, t, o, r) => {
    const f = 587.33 * r;
    tone(v, { t, f: f * 1.5, to: f, glide: 0.015, a: 0.0015, d: 0.16, vol: 0.3 });
    tone(v, { t, f: f * 4, a: 0.001, d: 0.035, vol: 0.05 });
    tone(v, { t, type: 'triangle', f: f / 2, a: 0.002, d: 0.08, vol: 0.1 });
  });

  // start dragging: light rising blip
  def('pick', 3, 30, 0.04, 0.8, (v, t, o, r) => {
    tone(v, { t, type: 'triangle', f: 440 * r, to: 900 * r, glide: 0.08, a: 0.004, d: 0.1, vol: 0.24 });
    tone(v, { t: t + 0.01, f: 880 * r, to: 1800 * r, glide: 0.08, a: 0.004, d: 0.07, vol: 0.05 });
    noise(v, { t, type: 'bandpass', f: 1800, to: 4200, q: 1.5, a: 0.02, d: 0.05, vol: 0.05 });
  });

  // release: soft plop / thud
  def('drop', 3, 30, 0.05, 0.45, (v, t, o, r) => {
    tone(v, { t, f: 330 * r, to: 115 * r, glide: 0.09, a: 0.002, d: 0.16, vol: 0.42 });
    tone(v, { t, type: 'triangle', f: 660 * r, to: 300 * r, glide: 0.04, a: 0.001, d: 0.05, vol: 0.05 });
    noise(v, { t, type: 'lowpass', f: 700, a: 0.001, d: 0.06, vol: 0.12 });
  });

  // item lands in its slot: crisp click + two-note chime
  def('snap', 3, 40, 0.02, 1.1, (v, t, o, r) => {
    noise(v, { t, type: 'highpass', f: 3000, a: 0.0005, d: 0.02, vol: 0.18 });
    tone(v, { t, type: 'triangle', f: 2200 * r, to: 1200 * r, glide: 0.012, a: 0.0005, d: 0.03, vol: 0.1 });
    tone(v, { t, f: 180, to: 90, glide: 0.04, a: 0.001, d: 0.07, vol: 0.22 });
    bell(v.sub(-0.15), { t: t + 0.02, f: 1567.98 * r, d: 0.35, vol: 0.12 });
    bell(v.sub(0.15), { t: t + 0.07, f: 2093 * r, d: 0.5, vol: 0.1, bright: 0.6 });
  });

  // correct step: twinkly arpeggio; quick successive steps climb higher (a little combo)
  let sparkN = 0, sparkAt = -1e9;
  def('sparkle', 3, 60, 0, 1.5, (v, t) => {
    const now = performance.now();
    sparkN = now - sparkAt < 3500 ? Math.min(sparkN + 1, 4) : 0;
    sparkAt = now;
    const k = Math.pow(2, [0, 2, 4, 5, 7][sparkN] / 12);
    tone(v, { t, type: 'triangle', f: 392 * k, a: 0.003, d: 0.2, vol: 0.11 });
    [783.99, 1046.5, 1318.51, 1567.98, 2093].forEach((f, i) => {
      bell(v.sub(-0.4 + i * 0.2), { t: t + i * 0.05, f: f * k, d: 0.28 + i * 0.07, vol: i === 4 ? 0.07 : 0.11, bright: i === 4 ? 0.5 : 0.8 });
    });
    noise(v, { t: t + 0.05, type: 'highpass', f: 7000, a: 0.05, d: 0.3, vol: 0.03 });
  });

  // mistake: rubbery two-note "bwoop-bwoww", lowpassed so it never gets harsh
  def('wrong', 2, 120, 0, 0.45, (v, t) => {
    tone(v, { t, type: 'triangle', f: 392, to: 370, glide: 0.1, a: 0.005, d: 0.12, vol: 0.26 });
    tone(v, { t, type: 'sawtooth', f: 392, to: 370, glide: 0.1, a: 0.005, d: 0.1, vol: 0.05, filter: 'lowpass', ff: 1100 });
    const t2 = t + 0.14;
    tone(v, { t: t2, type: 'triangle', f: 277.18, to: 196, glide: 0.34, a: 0.008, hold: 0.08, d: 0.26, vol: 0.3, vib: 10, vibDepth: 12 });
    tone(v, { t: t2, type: 'sawtooth', f: 277.18, to: 196, glide: 0.34, a: 0.008, hold: 0.08, d: 0.22, vol: 0.06, filter: 'lowpass', ff: 900, vib: 10, vibDepth: 12 });
  });

  // level solved: marimba run into a bright brass "ta-da" (~1 s)
  def('win', 1, 300, 0, 0.85, (v, t) => {
    duck(t, 0.8);
    [523.25, 659.26, 783.99, 1046.5].forEach((f, i) => mallet(v, { t: t + i * 0.075, f, vol: 0.2, d: 0.22 }));
    const c = t + 0.32;
    [523.25, 659.26, 783.99].forEach((f, i) => brass(v, { t: c, f, hold: 0.14, d: 0.5, vol: 0.075, detune: (i - 1) * 5 }));
    brass(v, { t: c, f: 1046.5, hold: 0.14, d: 0.5, vol: 0.05 });
    tone(v, { t: c, type: 'triangle', f: 130.81, a: 0.004, d: 0.5, vol: 0.3 });
    kick(v, c, 0.42);
    bell(v.sub(-0.3), { t: c + 0.04, f: 2093, d: 0.7, vol: 0.08, bright: 0.6 });
    bell(v.sub(0.3), { t: c + 0.16, f: 2637.02, d: 0.6, vol: 0.06, bright: 0.5 });
    noise(v, { t: c, type: 'highpass', f: 6500, a: 0.02, d: 0.6, vol: 0.05 });
  });

  // one star on the win card: "ding" that climbs C6 → E6 → G6, panned left → right
  def('star', 3, 50, 0, 1, (v, t, o) => {
    const i = Math.max(0, Math.min(2, o.i | 0));
    const f = [1046.5, 1318.51, 1567.98][i];
    const side = v.sub((i - 1) * 0.4);
    noise(side, { t, type: 'bandpass', f: 2500, to: 7000, q: 1.2, a: 0.04, d: 0.05, vol: 0.06 });
    tone(v, { t: t + 0.05, f: 300 + i * 60, to: 120, glide: 0.07, a: 0.001, d: 0.1, vol: 0.24 });
    tone(v, { t: t + 0.05, type: 'triangle', f: f / 2, a: 0.002, d: 0.25, vol: 0.11 });
    bell(side, { t: t + 0.05, f, d: 0.6, vol: 0.15 });
    bell(side, { t: t + 0.11, f: f * 1.5, d: 0.45, vol: 0.06, bright: 0.5 });
    if (i === 2) {
      bell(side, { t: t + 0.18, f: f * 2, d: 0.5, vol: 0.05, bright: 0.4 });
      noise(side, { t: t + 0.12, type: 'highpass', f: 7000, a: 0.05, d: 0.35, vol: 0.035 });
    }
  });

  // hint bulb earned: classic two-note coin, softened
  def('coin', 2, 60, 0, 0.9, (v, t) => {
    const lp = { filter: 'lowpass', ff: 4500 };
    tone(v, Object.assign({ t, wave: W.pulse, f: 987.77, a: 0.002, hold: 0.06, d: 0.03, vol: 0.1 }, lp));
    tone(v, Object.assign({ t: t + 0.075, wave: W.pulse, f: 1318.51, a: 0.002, hold: 0.08, d: 0.4, vol: 0.1 }, lp));
    tone(v, { t, f: 987.77, a: 0.002, hold: 0.06, d: 0.03, vol: 0.09 });
    tone(v, { t: t + 0.075, f: 1318.51, a: 0.002, hold: 0.08, d: 0.4, vol: 0.09 });
    bell(v.sub(0.25), { t: t + 0.14, f: 2637.02, d: 0.4, vol: 0.045, bright: 0.4 });
    noise(v, { t: t + 0.08, type: 'highpass', f: 7000, a: 0.03, d: 0.3, vol: 0.03 });
  });

  // rank up: brass fanfare "ta-ta-ta TAA ... ta-DAAA" with cymbal swell and a sparkle cascade (~1.6 s)
  def('levelup', 1, 500, 0, 1, (v, t) => {
    duck(t, 1.4);
    [[0, 392], [0.1, 523.25], [0.2, 659.26]].forEach(([dt, f]) => {
      brass(v, { t: t + dt, f, hold: 0.03, d: 0.09, vol: 0.12 });
      mallet(v, { t: t + dt, f: f * 2, vol: 0.07, d: 0.15 });
    });
    brass(v, { t: t + 0.3, f: 783.99, hold: 0.16, d: 0.12, vol: 0.12 });
    mallet(v, { t: t + 0.3, f: 1567.98, vol: 0.06, d: 0.2 });
    tone(v, { t: t + 0.3, type: 'triangle', f: 98, a: 0.004, d: 0.3, vol: 0.26 });
    noise(v, { t: t + 0.3, type: 'highpass', f: 5000, a: 0.3, d: 0.9, vol: 0.05 });
    const c = t + 0.62;
    [523.25, 659.26, 783.99, 1046.5].forEach((f, i) => brass(v, {
      t: c, f, hold: 0.45, d: 0.55, vol: i === 3 ? 0.05 : 0.07, detune: [-6, 4, -3, 6][i], vib: 5.5, vibDepth: f * 0.005,
    }));
    tone(v, { t: c, type: 'triangle', f: 130.81, a: 0.004, hold: 0.3, d: 0.6, vol: 0.3 });
    kick(v, c, 0.5);
    [1046.5, 1318.51, 1567.98, 2093, 2637.02].forEach((f, i) => {
      bell(v.sub(-0.4 + i * 0.2), { t: c + 0.08 + i * 0.06, f, d: 0.5, vol: 0.065, bright: 0.6 });
    });
  });

  // solve streak: fiery whoosh with crackles, then a rising pentatonic chime
  def('streak', 1, 300, 0, 1.35, (v, t) => {
    duck(t, 0.8);
    noise(v, { t, type: 'bandpass', q: 1.8, fenv: [[0, 300], [0.3, 2600], [0.5, 1200]], a: 0.16, d: 0.34, vol: 0.3 });
    noise(v, { t, type: 'lowpass', f: 380, a: 0.1, d: 0.3, vol: 0.16 });
    for (let k = 0; k < 6; k++) {
      noise(v, { t: t + rnd(0.04, 0.4), type: 'highpass', f: rnd(2500, 5000), a: 0.0005, d: rnd(0.01, 0.022), vol: rnd(0.04, 0.09) });
    }
    [1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093].forEach((f, i) => {
      bell(v.sub(-0.5 + i * 0.2), { t: t + 0.14 + i * 0.045, f, d: 0.25, vol: 0.07, bright: 0.6 });
    });
    const c = t + 0.42;
    bell(v, { t: c, f: 2093, d: 0.7, vol: 0.08 });
    tone(v, { t: c, type: 'triangle', f: 523.25, d: 0.4, vol: 0.1 });
    tone(v, { t: c, type: 'triangle', f: 783.99, d: 0.4, vol: 0.07 });
  });

  // speech bubble: tiny round "bloop" (kept soft because it happens a lot)
  def('bubble', 2, 60, 0.06, 0.8, (v, t, o, r) => {
    tone(v, { t, f: 480 * r, to: 820 * r, glide: 0.045, a: 0.004, d: 0.065, vol: 0.14 });
  });

  // balloon pop: sharp burst plus a little thump
  def('pop', 4, 30, 0.05, 0.75, (v, t, o, r) => {
    noise(v, { t, type: 'bandpass', f: 1600 * r, q: 0.5, a: 0.0005, d: 0.08, vol: 0.55 });
    noise(v, { t, type: 'highpass', f: 5000, a: 0.0003, d: 0.02, vol: 0.18 });
    tone(v, { t, f: 260 * r, to: 70, glide: 0.07, a: 0.001, d: 0.1, vol: 0.25 });
  });

  // whoosh: swept noise travelling left → right
  def('whoosh', 2, 60, 0.05, 1.6, (v, t, o, r) => {
    const s = v.sub(-0.45);
    if (s.node) { s.node.pan.setValueAtTime(-0.45, t); s.node.pan.linearRampToValueAtTime(0.45, t + 0.38); }
    noise(s, { t, type: 'bandpass', q: 1.2, fenv: [[0, 380 * r], [0.16, 1700 * r], [0.38, 650 * r]], a: 0.13, d: 0.25, vol: 0.38 });
    noise(s, { t, type: 'lowpass', f: 500, a: 0.1, d: 0.2, vol: 0.12 });
  });

  // splash: plunk, spray and a few droplets
  def('splash', 2, 80, 0.04, 0.8, (v, t, o, r) => {
    tone(v, { t, f: 280 * r, to: 100, glide: 0.08, a: 0.001, d: 0.12, vol: 0.28 });
    noise(v, { t, type: 'lowpass', fenv: [[0, 4000], [0.5, 500]], a: 0.004, d: 0.55, vol: 0.4 });
    noise(v, { t: t + 0.01, type: 'highpass', f: 3500, a: 0.003, d: 0.2, vol: 0.1 });
    for (let k = 0; k < 5; k++) {
      const f = rnd(800, 1700) * r;
      tone(v.sub(rnd(-0.5, 0.5)), { t: t + rnd(0.06, 0.38), f, to: f * 1.9, glide: 0.035, a: 0.001, d: 0.045, vol: rnd(0.05, 0.1) });
    }
  });

  // alarm clock: two small bells struck ~18 times a second for ~0.8 s
  def('ring', 1, 300, 0, 1, (v, t) => {
    const dur = 0.8, rate = 18;
    const env = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000;
    shape(env.gain, t, 0.01, 0.17, 0.6, 0.18);
    env.connect(lp); lp.connect(v.dst); v.nodes.push(env, lp);
    [[1380, 0], [1520, 0.5 / rate]].forEach(([f, off]) => {
      const am = ctx.createGain();
      am.gain.value = 0.5; am.connect(env); v.nodes.push(am);
      // a rising saw, inverted: each cycle is a sharp strike followed by a decay
      const hammer = ctx.createOscillator(), depth = ctx.createGain();
      hammer.type = 'sawtooth'; hammer.frequency.value = rate; depth.gain.value = -0.5;
      hammer.connect(depth); depth.connect(am.gain);
      hammer.start(t + off); hammer.stop(t + dur);
      v.track(hammer, [hammer, depth], t + dur);
      [[1, 0.6], [1.47, 0.32], [2.09, 0.16]].forEach(([m, a]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f * m; g.gain.value = a;
        o.connect(g); g.connect(am);
        o.start(t); o.stop(t + dur);
        v.track(o, [o, g], t + dur);
      });
    });
  });

  // drum hit
  def('boom', 2, 60, 0.03, 0.8, (v, t, o, r) => {
    tone(v, { t, f: 170 * r, to: 46, glide: 0.2, a: 0.001, d: 0.5, vol: 0.72 });
    tone(v, { t, type: 'triangle', f: 240 * r, to: 95, glide: 0.07, a: 0.001, d: 0.14, vol: 0.2 });
    noise(v, { t, type: 'lowpass', fenv: [[0, 2200], [0.12, 300]], a: 0.0008, d: 0.16, vol: 0.3 });
    noise(v, { t, type: 'highpass', f: 3000, a: 0.0003, d: 0.012, vol: 0.1 });
  });

  // hint revealed: whole-tone glissando of bells over a soft shimmering chord
  def('reveal', 2, 120, 0, 1.1, (v, t) => {
    [1046.5, 1174.66, 1318.51, 1479.98, 1661.22, 1864.66, 2093].forEach((f, i) => {
      bell(v.sub(-0.6 + i * 0.2), { t: t + i * 0.042, f, d: 0.32 + i * 0.03, vol: 0.06, bright: 0.55, partials: 2 });
    });
    [523.25, 783.99, 1318.51].forEach((f, i) => {
      tone(v, { t, type: 'triangle', f, a: 0.14, hold: 0.12, d: 0.5, vol: 0.05, detune: [-7, 5, 9][i], vib: 5.5, vibDepth: f * 0.004 });
    });
    noise(v, { t, type: 'highpass', f: 6000, a: 0.25, d: 0.45, vol: 0.035 });
  });

  // new level unlocked: "ka-chunk" latch, then an upward chime
  def('unlock', 1, 200, 0, 1.1, (v, t) => {
    noise(v, { t, type: 'bandpass', f: 2600, q: 2.5, a: 0.0005, d: 0.022, vol: 0.24 });
    tone(v, { t, type: 'triangle', f: 320, to: 140, glide: 0.04, a: 0.001, d: 0.07, vol: 0.2 });
    noise(v, { t: t + 0.065, type: 'bandpass', f: 1700, q: 2.5, a: 0.0005, d: 0.03, vol: 0.22 });
    tone(v, { t: t + 0.065, f: 210, to: 90, glide: 0.05, a: 0.001, d: 0.09, vol: 0.26 });
    bell(v.sub(-0.2), { t: t + 0.14, f: 1567.98, d: 0.4, vol: 0.12 });
    bell(v.sub(0.2), { t: t + 0.22, f: 2093, d: 0.6, vol: 0.1 });
    noise(v, { t: t + 0.2, type: 'highpass', f: 7000, a: 0.04, d: 0.35, vol: 0.03 });
  });

  // number count-up tick: tiny and quiet; a fast run of ticks creeps upward in pitch
  let tickN = 0, tickAt = -1e9;
  def('tick', 3, 28, 0.03, 1, (v, t, o, r) => {
    const now = performance.now();
    tickN = now - tickAt < 220 ? Math.min(tickN + 1, 24) : 0;
    tickAt = now;
    const f = 1700 * r * (1 + tickN * 0.012);
    tone(v, { t, f, to: f * 0.8, glide: 0.012, a: 0.0006, d: 0.024, vol: 0.11 });
  });

  // ---------- background music ----------
  // An original, light "island marimba" tune in C: 100 BPM, gently swung eighths, 32 bars as
  // A (marimba) – B (glockenspiel, ukulele strum) – A' (marimba + glock, fuller groove) – B' (marimba + bell).
  const BPM = 100, E8 = 60 / BPM / 2, SWING = E8 * 0.1, LOOKAHEAD = 0.3;
  const UKE = { // gCEA voicings, in strum order
    C: [67, 60, 64, 72], Am: [69, 60, 64, 69], F: [69, 60, 65, 69], G: [67, 62, 67, 71],
    Dm: [69, 62, 65, 69], Em: [67, 64, 67, 71], G7: [67, 62, 65, 71],
  };
  const ROOT = { C: 48, Dm: 50, Em: 40, F: 41, G: 43, G7: 43, Am: 45 };
  const SCALE = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];   // C major pitch classes
  // melody events: [bar, eighth, midi, length in eighths]
  const SEC_A = {
    chords: ['C', 'Am', 'F', 'G', 'C', 'Am', 'Dm|G', 'C'],
    mel: [
      [0, 0, 76, 1.5], [0, 2, 79, 1], [0, 3, 76, 1], [0, 4, 72, 2.5], [0, 7, 74, 1],
      [1, 0, 76, 1.5], [1, 2, 81, 1.5], [1, 4, 79, 1], [1, 5, 76, 1], [1, 6, 72, 1.5],
      [2, 0, 77, 1.5], [2, 2, 81, 1], [2, 3, 77, 1], [2, 4, 72, 2.5], [2, 7, 72, 1],
      [3, 0, 74, 1], [3, 1, 76, 1], [3, 2, 77, 1.5], [3, 4, 76, 1.5], [3, 6, 74, 2],
      [4, 0, 76, 1.5], [4, 2, 79, 1], [4, 3, 76, 1], [4, 4, 84, 2.5], [4, 7, 83, 1],
      [5, 0, 81, 1.5], [5, 2, 79, 1], [5, 3, 76, 1], [5, 4, 72, 3],
      [6, 0, 74, 1], [6, 1, 77, 1], [6, 2, 81, 1.5], [6, 4, 79, 1], [6, 5, 77, 1], [6, 6, 74, 1], [6, 7, 71, 1],
      [7, 0, 72, 2], [7, 4, 72, 1], [7, 5, 74, 1], [7, 6, 76, 1], [7, 7, 79, 1],
    ],
  };
  const SEC_B = {
    chords: ['F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C|G7'],
    mel: [
      [0, 0, 81, 1], [0, 2, 81, 1], [0, 4, 84, 1.5], [0, 6, 81, 1.5],
      [1, 0, 83, 1], [1, 2, 79, 1], [1, 4, 74, 3],
      [2, 0, 79, 1], [2, 2, 79, 1], [2, 4, 83, 1.5], [2, 6, 79, 1.5],
      [3, 0, 81, 1], [3, 2, 76, 1], [3, 4, 72, 3],
      [4, 0, 81, 1], [4, 1, 79, 1], [4, 2, 81, 1], [4, 3, 84, 1.5], [4, 5, 81, 1], [4, 6, 77, 1.5],
      [5, 0, 79, 1], [5, 1, 77, 1], [5, 2, 79, 1], [5, 3, 83, 1.5], [5, 5, 79, 1], [5, 6, 74, 1.5],
      [6, 0, 76, 1], [6, 2, 79, 1], [6, 4, 84, 3],
      [7, 4, 79, 1], [7, 5, 77, 1], [7, 6, 76, 1], [7, 7, 74, 1],
    ],
  };
  [SEC_A, SEC_B].forEach((s) => {
    s.at = {};
    s.mel.forEach(([b, e, n, l]) => { s.at[b * 8 + e] = [n, l]; });
    s.ch = s.chords.map((c) => c.split('|'));
  });
  // strum patterns: eighth -> [down?, velocity]
  const PAH = { 2: [1, 0.9], 6: [1, 0.9] };
  const CALYPSO = { 0: [1, 0.8], 2: [1, 0.6], 3: [0, 0.5], 5: [0, 0.55], 6: [1, 0.7], 7: [0, 0.45] };
  const PARTS = [
    { sec: SEC_A, lead: 'mallet', dbl: null, bass: 0, strum: PAH, perc: 0 },
    { sec: SEC_B, lead: 'bell', dbl: 'low', bass: 1, strum: CALYPSO, perc: 1 },
    { sec: SEC_A, lead: 'mallet', dbl: 'high', bass: 1, strum: PAH, perc: 2 },
    { sec: SEC_B, lead: 'mallet', dbl: 'bell', bass: 1, strum: CALYPSO, perc: 3 },
  ];
  const LOOP = PARTS.length * 64;

  let mTimer = null, mSession = null, mStep = 0, mNext = 0;
  const mSrcs = new Set();
  const M = {   // owner for music notes
    dst: null,
    track(src, nodes, end) {
      src._end = end; mSrcs.add(src);
      src.onended = () => { mSrcs.delete(src); nodes.forEach(disc); };
    },
  };

  const chordAt = (part, bar, e) => { const c = part.sec.ch[bar]; return c.length > 1 && e >= 4 ? c[1] : c[0]; };
  function approach(target, fromBelow) {   // the scale tone next to the target root
    for (let k = 1; k <= 2; k++) { const n = fromBelow ? target - k : target + k; if (SCALE[n % 12]) return n; }
    return target;
  }
  const hum = (v) => v * rnd(0.9, 1.04);

  function bassNote(t, n, vol, d) {
    tone(M, { t, type: 'triangle', f: hz(n), a: 0.004, d, vol: hum(vol), filter: 'lowpass', fenv: [[0, 1400], [0.15, 500]] });
  }

  function playStep(step, t) {
    const part = PARTS[Math.floor(step / 64)];
    const local = step % 64, bar = local >> 3, e = local & 7;
    const chord = chordAt(part, bar, e);
    const root = ROOT[chord];

    // lead
    const ev = part.sec.at[local];
    if (ev) {
      const f = hz(ev[0]), len = ev[1], d = Math.min(1.2, 0.4 + len * E8), acc = e === 0 ? 1.08 : 1;
      if (part.lead === 'mallet') mallet(M, { t, f, vol: hum(0.24) * acc, d });
      else bell(M, { t, f, d: d + 0.3, vol: hum(0.15) * acc, bright: 0.7, partials: 2 });
      if (part.dbl === 'low') pluck(M, t, f / 2, hum(0.06), 0.25 + len * 0.1, 1800);
      else if (part.dbl === 'high' && len >= 1.5) bell(M, { t, f: f * 2, d: 0.4, vol: hum(0.03), bright: 0.4, partials: 2 });
      else if (part.dbl === 'bell') bell(M, { t, f, d, vol: hum(0.055), bright: 0.5, partials: 2 });
    }
    if (local === 0 && part.sec === SEC_B) noise(M, { t, type: 'highpass', f: 7000, a: 0.005, d: 0.9, vol: 0.025 });

    const split = part.sec.ch[bar].length > 1;

    // warm sine pad holding the chord, so the plucky parts float on something soft
    if (e === 0 || (split && e === 4)) {
      const len = (split ? 4 : 8) * E8, tones = UKE[chord].slice().sort((x, y) => x - y).filter((n, i, a) => a.indexOf(n) === i).slice(0, 3);
      tones.forEach((n) => tone(M, { t, f: hz(n), a: 0.25, hold: len - 0.35, d: 0.7, vol: part.perc ? 0.024 : 0.018 }));
    }

    // bass: "oom-pah" in A, a bouncier line with a walk-up note elsewhere
    const fifth = root + 7 <= 52 ? root + 7 : root - 5;
    if (e === 0) bassNote(t, root, 0.32, part.bass ? 0.7 : 1.0);
    else if (e === 4) bassNote(t, split ? root : fifth, 0.26, part.bass ? 0.6 : 0.9);
    else if (part.bass && e === 3) bassNote(t, root, 0.15, 0.3);
    else if (part.bass && e === 7) {
      const next = (step + 1) % LOOP, np = PARTS[Math.floor(next / 64)], nb = (next % 64) >> 3;
      const target = ROOT[chordAt(np, nb, 0)];
      bassNote(t, approach(target, target >= root), 0.17, 0.3);
    }

    // ukulele strum
    const st = part.strum[e];
    if (st) {
      const notes = st[0] ? UKE[chord] : UKE[chord].slice().reverse();
      const d = part.strum === PAH ? 0.5 : 0.35;
      notes.forEach((n, i) => pluck(M, t + i * 0.011, hz(n), 0.042 * st[1] * rnd(0.9, 1.1), d, 2600));
    }

    // light percussion, building up over the four parts
    if (e % 2) noise(M, { t, type: 'highpass', f: 6500, a: 0.006, d: 0.045, vol: part.perc ? 0.03 : 0.022 });
    else if (part.perc) noise(M, { t, type: 'highpass', f: 6500, a: 0.006, d: 0.035, vol: 0.014 });
    if (part.perc && (e === 0 || e === 4 || (part.perc === 3 && e === 7 && bar % 2))) {
      tone(M, { t, f: 120, to: 45, glide: 0.12, a: 0.002, d: 0.22, vol: e === 7 ? 0.14 : 0.22 });
    }
    if (part.perc >= 2 && (e === 2 || e === 6)) tone(M, { t, f: 1150, to: 850, glide: 0.02, a: 0.0008, d: 0.045, vol: 0.06 });
  }

  function musicTick() {
    if (!ctx || !mSession) return;
    const now = ctx.currentTime;
    if (mNext < now - 0.08) mNext = now + 0.05;   // fell behind (jank): skip ahead, don't burst
    while (mNext < now + LOOKAHEAD) {
      try { playStep(mStep, mNext + (mStep % 2 ? SWING : 0)); } catch (e) { /* keep the clock going */ }
      mNext += E8;
      mStep = (mStep + 1) % LOOP;
    }
  }

  function startMusic() {
    if (mTimer || !ctx) return;
    const t = ctx.currentTime;
    mSession = ctx.createGain();
    mSession.gain.setValueAtTime(0, t);
    mSession.gain.linearRampToValueAtTime(1, t + 0.6);
    mSession.connect(musicBus);
    M.dst = mSession;
    mStep -= mStep % 8;          // resume from the top of the bar we were in
    mNext = t + 0.08;
    mTimer = setInterval(musicTick, 50);
    musicTick();
  }

  function stopMusic(hard) {
    if (!mTimer) return;
    clearInterval(mTimer);
    mTimer = null;
    const s = mSession, t = ctx.currentTime, at = hard ? t : t + 0.15;
    mSession = null;
    mSrcs.forEach((src) => {
      if (src._end > at) { src._end = at; try { src.stop(at); } catch (e) { /* not started */ } }
    });
    if (hard) disc(s);
    else {
      try { s.gain.cancelScheduledValues(t); s.gain.setValueAtTime(s.gain.value, t); s.gain.linearRampToValueAtTime(0, at); } catch (e) { /* ignore */ }
      setTimeout(() => disc(s), 400);
    }
  }

  // ---------- public API ----------
  window.GameAudio = {
    // Audio starts only after the first user gesture (browser autoplay rules).
    unlock() {
      try {
        if (!AC) return;
        const first = !ctx;
        if (first) {
          if (!ensure()) return;
          unlockedAt = performance.now();
          const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();   // iOS wake-up
          s.buffer = b; s.connect(ctx.destination); s.onended = () => disc(s); s.start(0);
        }
        if (first || ctx.state !== 'running') { syncContext(); apply(); }
      } catch (e) { /* audio is optional */ }
    },
    play(name, opts) {
      try {
        if (!ctx || userMuted || silent() || typeof name !== 'string') return;
        const d = SFX[name];
        if (!d) return;
        if (ctx.state !== 'running') {
          syncContext();
          if (performance.now() - unlockedAt > 1500) return;   // stuck suspended: don't queue up sounds
        }
        const now = performance.now();
        if (d.last && now - d.last < d.gap) return;
        d.last = now;
        const v = voice(name, d.cap, d.lvl);
        try {
          // a brand-new context's compressors start clamped for ~0.1 s, so hold the very first sounds until then
          d.fn(v, Math.max(ctx.currentTime + 0.004, 0.1), opts && typeof opts === 'object' ? opts : {}, 1 + (Math.random() * 2 - 1) * d.jit);
        } finally {
          setTimeout(() => { if (!v.dead) retire(v, true); }, Math.max(0, v.end - ctx.currentTime) * 1000 + 2000);
        }
      } catch (e) { /* a sound must never break the game */ }
    },
    setUserMute(m) { userMuted = !!m; apply(); },
    isUserMuted() { return userMuted; },
    setMusic(on) { musicOn = !!on; apply(); },
    isMusicOn() { return musicOn; },
    setAdMute(m) { adMuted = !!m; apply(); syncContext(); },
    setHidden(h) { hidden = !!h; apply(); syncContext(); },
  };
})();

// ---- js/art.js ----
// Hand-drawn SVG props. Every function returns an SVG string sized in scene pixels.
(function () {
  const O = '#1f1f24'; // outline colour
  const sw = 7;        // outline width
  const svg = (w, h, inner) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;

  const Art = {
    svg,

    fridgeBody(w = 280, h = 460) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="26" fill="#dff1ff" stroke="${O}" stroke-width="${sw}"/>
        <rect x="26" y="26" width="${w - 52}" height="${h - 52}" rx="14" fill="#bfe3ff"/>
        <line x1="26" y1="${h * 0.36}" x2="${w - 26}" y2="${h * 0.36}" stroke="#8fc6f0" stroke-width="8"/>
        <line x1="26" y1="${h * 0.62}" x2="${w - 26}" y2="${h * 0.62}" stroke="#8fc6f0" stroke-width="8"/>
        <circle cx="${w / 2}" cy="44" r="10" fill="#fff8b0"/>`);
    },

    fridgeDoorClosed(w = 280, h = 460) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="26" fill="#f4fbff" stroke="${O}" stroke-width="${sw}"/>
        <line x1="6" y1="${h * 0.32}" x2="${w - 6}" y2="${h * 0.32}" stroke="${O}" stroke-width="${sw}"/>
        <rect x="${w - 52}" y="${h * 0.14}" width="16" height="64" rx="8" fill="#c9d6e3" stroke="${O}" stroke-width="5"/>
        <rect x="${w - 52}" y="${h * 0.42}" width="16" height="110" rx="8" fill="#c9d6e3" stroke="${O}" stroke-width="5"/>
        <circle cx="60" cy="${h * 0.5}" r="14" fill="#ff7a7a"/><circle cx="96" cy="${h * 0.56}" r="10" fill="#ffd23f"/>`);
    },

    fridgeDoorOpen(w = 90, h = 460) {
      return svg(w, h, `
        <path d="M6 6 L${w - 6} 34 L${w - 6} ${h - 34} L6 ${h - 6} Z" fill="#e8f2fb" stroke="${O}" stroke-width="${sw}"/>
        <line x1="20" y1="${h * 0.34}" x2="${w - 14}" y2="${h * 0.36}" stroke="#8fb8da" stroke-width="6"/>
        <line x1="20" y1="${h * 0.66}" x2="${w - 14}" y2="${h * 0.64}" stroke="#8fb8da" stroke-width="6"/>`);
    },

    houseDoor(open = false, w = 230, h = 380) {
      if (open) {
        return svg(w, h, `
          <rect x="6" y="6" width="${w - 12}" height="${h - 6}" rx="16" fill="#fff3b0" stroke="${O}" stroke-width="${sw}"/>
          <path d="M6 6 L60 30 L60 ${h - 20} L6 ${h}" fill="#b5713c" stroke="${O}" stroke-width="${sw}"/>
          <circle cx="${w * 0.62}" cy="${h * 0.42}" r="40" fill="#fff" opacity=".7"/>`);
      }
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 6}" rx="16" fill="#c9824a" stroke="${O}" stroke-width="${sw}"/>
        <rect x="34" y="36" width="${w - 68}" height="${h * 0.32}" rx="10" fill="#b5713c" stroke="${O}" stroke-width="5"/>
        <rect x="34" y="${h * 0.48}" width="${w - 68}" height="${h * 0.36}" rx="10" fill="#b5713c" stroke="${O}" stroke-width="5"/>
        <circle cx="${w - 46}" cy="${h * 0.52}" r="14" fill="#ffd23f" stroke="${O}" stroke-width="5"/>
        <path d="M${w - 46} ${h * 0.58} l0 22" stroke="${O}" stroke-width="7"/>`);
    },

    doormat(w = 320, h = 70) {
      return svg(w, h, `
        <rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="14" fill="#8c5a2b" stroke="${O}" stroke-width="6"/>
        <text x="${w / 2}" y="${h / 2 + 12}" text-anchor="middle" font-family="Luckiest Guy, sans-serif" font-weight="700" font-size="32" fill="#f3d9a8">WELCOME</text>`);
    },

    matchbox(w = 220, h = 130) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="12" fill="#ffcf4a" stroke="${O}" stroke-width="${sw}"/>
        <rect x="6" y="${h - 44}" width="${w - 12}" height="38" fill="#7a3d1b" stroke="${O}" stroke-width="${sw}"/>
        <path d="M${w / 2 - 20} 30 q20 -18 40 0 q-6 26 -20 32 q-14 -6 -20 -32z" fill="#ff5a3c" stroke="${O}" stroke-width="5"/>`);
    },

    match(lit = false, w = 46, h = 190) {
      return svg(w, h, `
        ${lit ? `<path class="flicker" d="M${w / 2} 0 C${w} 30 ${w} 52 ${w / 2} 60 C0 52 0 30 ${w / 2} 0z" fill="#ffb020" stroke="${O}" stroke-width="5"/>
                  <path d="M${w / 2} 22 C${w * 0.75} 38 ${w * 0.7} 52 ${w / 2} 55 C${w * 0.3} 52 ${w * 0.25} 38 ${w / 2} 22z" fill="#fff07a"/>` : ''}
        <rect x="${w / 2 - 8}" y="60" width="16" height="${h - 66}" rx="6" fill="#f2c993" stroke="${O}" stroke-width="5"/>
        <ellipse cx="${w / 2}" cy="66" rx="15" ry="19" fill="${lit ? '#4a2a1a' : '#e5373d'}" stroke="${O}" stroke-width="5"/>`);
    },

    cake(w = 380, h = 330) {
      return svg(w, h, `
        <rect x="${w / 2 - 12}" y="10" width="24" height="90" rx="6" fill="#7fc8ff" stroke="${O}" stroke-width="6"/>
        <line x1="${w / 2}" y1="10" x2="${w / 2}" y2="0" stroke="${O}" stroke-width="5"/>
        <path d="M30 120 h${w - 60} v170 h-${w - 60}z" fill="#ffb3c7" stroke="${O}" stroke-width="${sw}"/>
        <path d="M30 120 h${w - 60} v40 q-40 30 -80 0 q-40 30 -80 0 q-40 30 -80 0 q-40 30 -80 0 v-40z" fill="#fff" stroke="${O}" stroke-width="6"/>
        <rect x="10" y="286" width="${w - 20}" height="30" rx="14" fill="#d9e6f2" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="90" cy="220" r="10" fill="#ff5a5f"/><circle cx="190" cy="240" r="10" fill="#ffd23f"/><circle cx="290" cy="215" r="10" fill="#3d8bff"/>`);
    },

    flame(w = 50, h = 70) {
      return svg(w, h, `
        <path d="M${w / 2} 2 C${w} 30 ${w} 58 ${w / 2} ${h - 2} C0 58 0 30 ${w / 2} 2z" fill="#ffb020" stroke="${O}" stroke-width="5"/>
        <path d="M${w / 2} 26 C${w * 0.78} 42 ${w * 0.72} 58 ${w / 2} ${h - 10} C${w * 0.28} 58 ${w * 0.22} 42 ${w / 2} 26z" fill="#fff07a"/>`);
    },

    balance(w = 640, h = 360) {
      return svg(w, h, `
        <rect x="${w / 2 - 14}" y="40" width="28" height="${h - 80}" fill="#c08850" stroke="${O}" stroke-width="${sw}"/>
        <rect x="${w / 2 - 110}" y="${h - 48}" width="220" height="40" rx="14" fill="#c08850" stroke="${O}" stroke-width="${sw}"/>
        <rect x="40" y="40" width="${w - 80}" height="22" rx="10" fill="#e0a95f" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="${w / 2}" cy="50" r="20" fill="#ffd23f" stroke="${O}" stroke-width="${sw}"/>
        <path d="M80 62 L40 190 M80 62 L120 190 M${w - 80} 62 L${w - 120} 190 M${w - 80} 62 L${w - 40} 190" stroke="${O}" stroke-width="5"/>
        <path d="M20 190 h120 q-10 50 -60 50 q-50 0 -60 -50z" fill="#e0a95f" stroke="${O}" stroke-width="${sw}"/>
        <path d="M${w - 140} 190 h120 q-10 50 -60 50 q-50 0 -60 -50z" fill="#e0a95f" stroke="${O}" stroke-width="${sw}"/>`);
    },

    bucket(w = 170, h = 170) {
      return svg(w, h, `
        <path d="M30 30 q${w / 2 - 30} -40 ${w - 60} 0" fill="none" stroke="${O}" stroke-width="6"/>
        <path d="M20 40 h${w - 40} l-18 ${h - 50} h-${w - 76}z" fill="#9aa9b8" stroke="${O}" stroke-width="${sw}"/>
        <ellipse cx="${w / 2}" cy="44" rx="${w / 2 - 26}" ry="12" fill="#3fa9ff" stroke="${O}" stroke-width="5"/>`);
    },

    groundWithHole(w = 1000, h = 520, holeX = 500, holeW = 110, holeDepth = 420) {
      const l = holeX - holeW / 2, r = holeX + holeW / 2;
      return svg(w, h, `
        <path d="M-10 40 H${l} V${holeDepth} H${r} V40 H${w + 10} V${h + 10} H-10z" fill="#b07a45" stroke="${O}" stroke-width="${sw}"/>
        <path d="M-10 40 H${l} M${r} 40 H${w + 10}" stroke="#5fbf4a" stroke-width="22"/>
        <circle cx="160" cy="240" r="16" fill="#8e5e30"/><circle cx="820" cy="320" r="22" fill="#8e5e30"/><circle cx="300" cy="420" r="12" fill="#8e5e30"/><circle cx="700" cy="180" r="14" fill="#8e5e30"/>`);
    },

    holeWater(w = 104, h = 380) {
      return svg(w, h, `<rect x="0" y="0" width="${w}" height="${h}" fill="#3fa9ff" opacity=".85"/>`);
    },

    stick(w = 40, h = 260) {
      return svg(w, h, `<path d="M${w / 2} 6 L${w / 2 + 4} ${h - 6}" stroke="${O}" stroke-width="22"/><path d="M${w / 2} 6 L${w / 2 + 4} ${h - 6}" stroke="#a8743f" stroke-width="12"/>`);
    },

    cage(w = 300, h = 380) {
      let bars = '';
      for (let i = 1; i < 7; i++) {
        const x = 30 + i * ((w - 60) / 7);
        bars += `<line x1="${x}" y1="${70 + Math.abs(i - 3.5) * 10}" x2="${x}" y2="${h - 30}" stroke="${O}" stroke-width="7"/>`;
      }
      return svg(w, h, `
        <path d="M30 ${h - 30} V120 Q${w / 2} -20 ${w - 30} 120 V${h - 30}" fill="none" stroke="${O}" stroke-width="10"/>
        ${bars}
        <circle cx="${w / 2}" cy="26" r="16" fill="none" stroke="${O}" stroke-width="8"/>
        <rect x="20" y="${h - 40}" width="${w - 40}" height="22" rx="8" fill="#ffcf4a" stroke="${O}" stroke-width="6"/>
        <rect x="${w - 70}" y="${h / 2 + 10}" width="44" height="40" rx="8" fill="#ffd23f" stroke="${O}" stroke-width="6"/>
        <path d="M${w - 62} ${h / 2 + 10} v-12 a14 14 0 0 1 28 0 v12" fill="none" stroke="${O}" stroke-width="6"/>`);
    },

    pot(w = 200, h = 160) {
      return svg(w, h, `
        <rect x="6" y="10" width="${w - 12}" height="34" rx="10" fill="#e07a4a" stroke="${O}" stroke-width="${sw}"/>
        <path d="M22 44 h${w - 44} l-16 ${h - 52} h-${w - 76}z" fill="#d0653a" stroke="${O}" stroke-width="${sw}"/>
        <ellipse cx="${w / 2}" cy="14" rx="${w / 2 - 20}" ry="8" fill="#6b4226"/>`);
    },

    wateringCan(w = 230, h = 170, pouring = false) {
      return svg(w, h, `
        <path d="M150 70 L220 26" stroke="${O}" stroke-width="20"/><path d="M150 70 L220 26" stroke="#3fb6ff" stroke-width="10"/>
        <rect x="200" y="12" width="26" height="22" rx="6" fill="#3fb6ff" stroke="${O}" stroke-width="5" transform="rotate(-32 213 23)"/>
        <rect x="40" y="50" width="120" height="110" rx="20" fill="#3fb6ff" stroke="${O}" stroke-width="${sw}"/>
        <path d="M60 50 q40 -50 80 0" fill="none" stroke="${O}" stroke-width="10"/>
        ${pouring ? '<circle cx="232" cy="52" r="6" fill="#3fa9ff"/><circle cx="240" cy="72" r="5" fill="#3fa9ff"/><circle cx="228" cy="88" r="6" fill="#3fa9ff"/>' : ''}`);
    },

    windowFrame(w = 320, h = 300, sunny = false) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="10" fill="${sunny ? '#9fdcff' : '#9fdcff'}" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="${w * 0.68}" cy="${h * 0.36}" r="44" fill="#ffd23f" stroke="${O}" stroke-width="5"/>
        <line x1="${w / 2}" y1="6" x2="${w / 2}" y2="${h - 6}" stroke="${O}" stroke-width="${sw}"/>
        <line x1="6" y1="${h / 2}" x2="${w - 6}" y2="${h / 2}" stroke="${O}" stroke-width="${sw}"/>`);
    },

    curtain(w = 200, h = 340) {
      return svg(w, h, `
        <path d="M6 6 H${w - 6} V${h - 10} Q${w * 0.75} ${h - 30} ${w / 2} ${h - 10} Q${w * 0.25} ${h - 30} 6 ${h - 10}z" fill="#e5484d" stroke="${O}" stroke-width="${sw}"/>
        <path d="M${w * 0.3} 14 V${h - 30} M${w * 0.55} 14 V${h - 22} M${w * 0.8} 14 V${h - 30}" stroke="#b8323a" stroke-width="8"/>`);
    },

    lightSwitch(on = true, w = 90, h = 130) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="14" fill="#fff" stroke="${O}" stroke-width="6"/>
        <rect x="${w / 2 - 16}" y="${on ? 26 : h / 2 - 4}" width="32" height="${h / 2 - 22}" rx="8" fill="${on ? '#ffd23f' : '#9b94b8'}" stroke="${O}" stroke-width="5"/>`);
    },

    lamp(on = true, w = 160, h = 260) {
      return svg(w, h, `
        <line x1="${w / 2}" y1="0" x2="${w / 2}" y2="${h - 140}" stroke="${O}" stroke-width="6"/>
        ${on ? `<path d="M${w / 2 - 60} ${h - 70} L-40 ${h + 400} L${w + 40} ${h + 400} L${w / 2 + 60} ${h - 70}z" fill="#fff6b0" opacity=".45"/>` : ''}
        <path d="M${w / 2 - 60} ${h - 70} Q${w / 2} ${h - 170} ${w / 2 + 60} ${h - 70}z" fill="#3d8bff" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="${w / 2}" cy="${h - 62}" r="16" fill="${on ? '#fff07a' : '#c8c3da'}" stroke="${O}" stroke-width="5"/>`);
    },

    socket(w = 110, h = 120) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="18" fill="#fff" stroke="${O}" stroke-width="6"/>
        <circle cx="${w / 2}" cy="${h / 2}" r="32" fill="#eee9f7" stroke="${O}" stroke-width="5"/>
        <circle cx="${w / 2 - 12}" cy="${h / 2}" r="6" fill="${O}"/><circle cx="${w / 2 + 12}" cy="${h / 2}" r="6" fill="${O}"/>`);
    },

    plug(w = 70, h = 90) {
      return svg(w, h, `
        <rect x="${w / 2 - 14}" y="0" width="7" height="22" fill="#b9b2cf" stroke="${O}" stroke-width="3"/>
        <rect x="${w / 2 + 7}" y="0" width="7" height="22" fill="#b9b2cf" stroke="${O}" stroke-width="3"/>
        <rect x="6" y="18" width="${w - 12}" height="${h - 30}" rx="14" fill="#4b4570" stroke="${O}" stroke-width="5"/>`);
    },

    tv(on = true, w = 380, h = 300) {
      return svg(w, h, `
        <path d="M${w / 2 - 60} ${h - 30} l-30 26 M${w / 2 + 60} ${h - 30} l30 26" stroke="${O}" stroke-width="8"/>
        <rect x="6" y="6" width="${w - 12}" height="${h - 40}" rx="22" fill="#4b4570" stroke="${O}" stroke-width="${sw}"/>
        <rect x="26" y="26" width="${w - 52}" height="${h - 80}" rx="12" fill="${on ? '#58d0ff' : '#1d1a33'}"/>
        ${on ? `<circle cx="${w / 2 - 50}" cy="${h / 2 - 30}" r="28" fill="#ffd23f"/><path d="M40 ${h - 70} q80 -80 150 -20 q60 -50 150 10 v${10} h-300z" fill="#5fbf4a"/>` : ''}`);
    },

    safe(open = false, w = 380, h = 380) {
      if (open) {
        return svg(w, h, `
          <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="22" fill="#6c7a8c" stroke="${O}" stroke-width="${sw}"/>
          <rect x="34" y="34" width="${w - 68}" height="${h - 68}" rx="12" fill="#2b2350"/>`);
      }
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="22" fill="#8a99ab" stroke="${O}" stroke-width="${sw}"/>
        <rect x="34" y="34" width="${w - 68}" height="${h - 68}" rx="12" fill="#9fb0c2" stroke="${O}" stroke-width="5"/>
        <circle cx="${w / 2}" cy="${h / 2}" r="70" fill="#d6dee8" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="${w / 2}" cy="${h / 2}" r="18" fill="${O}"/>
        <path d="M${w / 2} ${h / 2 - 70} v22 M${w / 2 + 70} ${h / 2} h-22 M${w / 2} ${h / 2 + 70} v-22 M${w / 2 - 70} ${h / 2} h22" stroke="${O}" stroke-width="6"/>`);
    },

    bigButton(w = 260, h = 200) {
      return svg(w, h, `
        <ellipse cx="${w / 2}" cy="${h - 50}" rx="${w / 2 - 8}" ry="42" fill="#9b94b8" stroke="${O}" stroke-width="${sw}"/>
        <path d="M40 ${h - 60} V${h / 2 - 10} a${w / 2 - 40} 40 0 0 1 ${w - 80} 0 V${h - 60} a${w / 2 - 40} 40 0 0 1 -${w - 80} 0z" fill="#e5373d" stroke="${O}" stroke-width="${sw}"/>
        <ellipse cx="${w / 2}" cy="${h / 2 - 10}" rx="${w / 2 - 40}" ry="40" fill="#ff6b6f" stroke="${O}" stroke-width="${sw}"/>`);
    },

    house(lit = false, w = 300, h = 280) {
      const win = lit ? '#ffe066' : '#3a3466';
      return svg(w, h, `
        <path d="M20 120 L${w / 2} 10 L${w - 20} 120z" fill="#e5484d" stroke="${O}" stroke-width="${sw}"/>
        <rect x="40" y="110" width="${w - 80}" height="${h - 116}" fill="#ffe0b3" stroke="${O}" stroke-width="${sw}"/>
        <rect x="68" y="146" width="56" height="56" rx="6" fill="${win}" stroke="${O}" stroke-width="5"/>
        <rect x="${w - 124}" y="146" width="56" height="56" rx="6" fill="${win}" stroke="${O}" stroke-width="5"/>
        <rect x="${w / 2 - 24}" y="${h - 76}" width="48" height="70" rx="6" fill="#b5713c" stroke="${O}" stroke-width="5"/>`);
    },

    hills(w = 1000, h = 300, color = '#5fbf4a') {
      return svg(w, h, `<path d="M-10 ${h} V120 Q180 0 380 90 Q560 170 720 60 Q880 -20 1010 100 V${h}z" fill="${color}" stroke="${O}" stroke-width="${sw}"/>`);
    },

    nest(w = 420, h = 140) {
      return svg(w, h, `
        <path d="M10 40 Q${w / 2} 170 ${w - 10} 40 Q${w / 2} 90 10 40z" fill="#a8743f" stroke="${O}" stroke-width="${sw}"/>
        <path d="M40 60 q60 30 120 10 M200 80 q60 10 120 -20 M90 90 q80 20 160 0" stroke="#7a4f24" stroke-width="6" fill="none"/>`);
    },

    nestFront(w = 420, h = 110) {
      return svg(w, h, `<path d="M10 10 Q${w / 2} 150 ${w - 10} 10 Q${w / 2} 70 10 10z" fill="#c08850" stroke="${O}" stroke-width="${sw}"/>
        <path d="M60 40 q60 30 120 10 M220 50 q60 10 120 -20" stroke="#7a4f24" stroke-width="6" fill="none"/>`);
    },

    arrowLine(len = 520, inward = false, w = 680, h = 120) {
      const x1 = (w - len) / 2, x2 = x1 + len, y = h / 2, a = 50;
      const d = inward
        ? `M${x1} ${y} l${a} -${a} M${x1} ${y} l${a} ${a} M${x2} ${y} l-${a} -${a} M${x2} ${y} l-${a} ${a}`
        : `M${x1} ${y} l-${a} -${a} M${x1} ${y} l-${a} ${a} M${x2} ${y} l${a} -${a} M${x2} ${y} l${a} ${a}`;
      return svg(w, h, `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${O}" stroke-width="12"/><path d="${d}" stroke="${O}" stroke-width="12" fill="none"/>`);
    },

    table(w = 520, h = 160) {
      return svg(w, h, `
        <rect x="6" y="6" width="${w - 12}" height="34" rx="10" fill="#c08850" stroke="${O}" stroke-width="${sw}"/>
        <rect x="40" y="40" width="28" height="${h - 46}" fill="#a8743f" stroke="${O}" stroke-width="6"/>
        <rect x="${w - 68}" y="40" width="28" height="${h - 46}" fill="#a8743f" stroke="${O}" stroke-width="6"/>`);
    },

    mouseHole(w = 120, h = 110) {
      return svg(w, h, `<path d="M6 ${h} V${h / 2} a${w / 2 - 6} ${h / 2 - 6} 0 0 1 ${w - 12} 0 V${h}z" fill="#2b2350"/>`);
    },

    bottle(full = false, w = 90, h = 190) {
      return svg(w, h, `
        <rect x="${w / 2 - 14}" y="6" width="28" height="30" rx="12" fill="#ff9fb8" stroke="${O}" stroke-width="5"/>
        <rect x="${w / 2 - 26}" y="34" width="52" height="20" rx="6" fill="#7fc8ff" stroke="${O}" stroke-width="5"/>
        <rect x="10" y="52" width="${w - 20}" height="${h - 58}" rx="20" fill="#eaf6ff" stroke="${O}" stroke-width="${sw}"/>
        ${full ? `<rect x="16" y="70" width="${w - 32}" height="${h - 82}" rx="14" fill="#fff"/><path d="M16 80 h${w - 32}" stroke="#d0e4f5" stroke-width="4"/>` : ''}
        <path d="M24 90 h12 M24 120 h12 M24 150 h12" stroke="#9fc3e0" stroke-width="5"/>`);
    },

    river(w = 1000, h = 260) {
      return svg(w, h, `
        <rect x="-10" y="0" width="${w + 20}" height="${h}" fill="#3fa9ff" stroke="${O}" stroke-width="${sw}"/>
        <path d="M60 70 q30 -20 60 0 q30 20 60 0 M420 150 q30 -20 60 0 q30 20 60 0 M760 80 q30 -20 60 0 q30 20 60 0 M220 200 q30 -20 60 0 q30 20 60 0" stroke="#bfe6ff" stroke-width="8" fill="none"/>`);
    },

    sign(text = '', w = 300, h = 220) {
      return svg(w, h, `
        <rect x="${w / 2 - 12}" y="${h * 0.5}" width="24" height="${h * 0.5}" fill="#a8743f" stroke="${O}" stroke-width="6"/>
        <rect x="6" y="6" width="${w - 12}" height="${h * 0.55}" rx="16" fill="#ffd23f" stroke="${O}" stroke-width="${sw}"/>
        <text x="${w / 2}" y="${h * 0.37}" text-anchor="middle" font-family="Luckiest Guy, sans-serif" font-weight="700" font-size="40" fill="${O}">${text}</text>`);
    },

    boat(w = 260, h = 120) {
      return svg(w, h, `<path d="M6 30 H${w - 6} L${w - 50} ${h - 6} H50z" fill="#c9824a" stroke="${O}" stroke-width="${sw}"/>
        <circle cx="${w / 2 + 30}" cy="${h / 2 + 10}" r="12" fill="${O}"/>`);
    },

    shelf(w = 300, h = 40) {
      return svg(w, h, `<rect x="6" y="6" width="${w - 12}" height="${h - 12}" rx="8" fill="#c08850" stroke="${O}" stroke-width="6"/>`);
    },

    fence(w = 260, h = 160) {
      return svg(w, h, `
        <rect x="10" y="60" width="${w - 20}" height="22" fill="#fff" stroke="${O}" stroke-width="5"/>
        <rect x="10" y="110" width="${w - 20}" height="22" fill="#fff" stroke="${O}" stroke-width="5"/>
        <path d="M40 ${h} V30 l20 -22 l20 22 V${h}z M${w / 2 - 20} ${h} V30 l20 -22 l20 22 V${h}z M${w - 80} ${h} V30 l20 -22 l20 22 V${h}z" fill="#fff" stroke="${O}" stroke-width="5"/>`);
    },

    // Bulby, the game's mascot. mood: happy | win | think | sleep
    mascot(mood = 'happy', size = 200) {
      const eyes = {
        happy: '<ellipse cx="78" cy="80" rx="15" ry="17" fill="#fff" stroke="' + O + '" stroke-width="5"/><ellipse cx="122" cy="80" rx="15" ry="17" fill="#fff" stroke="' + O + '" stroke-width="5"/><circle cx="81" cy="83" r="7" fill="' + O + '"/><circle cx="125" cy="83" r="7" fill="' + O + '"/><circle cx="84" cy="80" r="2.5" fill="#fff"/><circle cx="128" cy="80" r="2.5" fill="#fff"/>',
        win: '<path d="M64 84 q14 -18 28 0 M108 84 q14 -18 28 0" fill="none" stroke="' + O + '" stroke-width="7" stroke-linecap="round"/>',
        think: '<ellipse cx="78" cy="80" rx="15" ry="17" fill="#fff" stroke="' + O + '" stroke-width="5"/><ellipse cx="122" cy="80" rx="15" ry="17" fill="#fff" stroke="' + O + '" stroke-width="5"/><circle cx="73" cy="73" r="7" fill="' + O + '"/><circle cx="117" cy="73" r="7" fill="' + O + '"/>',
        sleep: '<path d="M64 82 q14 12 28 0 M108 82 q14 12 28 0" fill="none" stroke="' + O + '" stroke-width="6" stroke-linecap="round"/>',
      }[mood];
      const mouth = {
        happy: '<path d="M84 104 Q100 122 116 104" fill="none" stroke="' + O + '" stroke-width="6" stroke-linecap="round"/>',
        win: '<path d="M80 100 Q100 100 120 100 Q118 128 100 128 Q82 128 80 100z" fill="#e5484d" stroke="' + O + '" stroke-width="5" stroke-linejoin="round"/>',
        think: '<ellipse cx="104" cy="110" rx="7" ry="8" fill="' + O + '"/>',
        sleep: '<path d="M90 108 Q100 114 110 108" fill="none" stroke="' + O + '" stroke-width="5" stroke-linecap="round"/>',
      }[mood];
      const arms = {
        happy: '<path d="M42 100 Q22 104 16 84" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M158 100 Q178 104 184 84" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/>',
        win: '<path d="M44 92 Q22 80 20 52" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M156 92 Q178 80 180 52" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/>',
        think: '<path d="M44 104 Q30 118 50 128 Q70 132 84 124" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M158 100 Q178 106 182 118" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/>',
        sleep: '<path d="M44 104 Q30 112 26 124" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M156 104 Q170 112 174 124" stroke="' + O + '" stroke-width="7" fill="none" stroke-linecap="round"/>',
      }[mood];
      const rays = mood === 'win'
        ? '<path d="M100 2 v12 M40 22 l9 9 M160 22 l-9 9 M12 70 h12 M176 70 h12" stroke="' + O + '" stroke-width="6" stroke-linecap="round"/>'
        : mood === 'think' ? '<text x="150" y="40" font-family="Luckiest Guy, sans-serif" font-size="40" fill="#fff" stroke="' + O + '" stroke-width="3" paint-order="stroke">?</text>' : '';
      return `<svg class="mascot-svg" width="${size}" height="${size}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round">
        ${rays}${arms}
        <path d="M70 142 C70 122 38 110 38 80 A62 62 0 1 1 162 80 C162 110 130 122 130 142 Z" fill="#ffd23f" stroke="${O}" stroke-width="7"/>
        <path d="M58 58 Q66 38 86 32" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".85"/>
        <ellipse cx="62" cy="104" rx="10" ry="6" fill="#ff8fa3" opacity=".8"/><ellipse cx="138" cy="104" rx="10" ry="6" fill="#ff8fa3" opacity=".8"/>
        ${eyes}${mouth}
        <rect x="66" y="142" width="68" height="16" rx="7" fill="#b8b8c4" stroke="${O}" stroke-width="6"/>
        <rect x="70" y="158" width="60" height="14" rx="7" fill="#d6d6de" stroke="${O}" stroke-width="6"/>
        <rect x="84" y="172" width="32" height="12" rx="6" fill="#5b5b66" stroke="${O}" stroke-width="5"/>
      </svg>`;
    },

    // faint sketches scattered behind the title screen
    doodles() {
      const st = `fill="none" stroke="${O}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
      const items = [
        ['6%', '18%', 110, `<path d="M36 8 v94 M74 8 v94 M8 38 h94 M8 74 h94" ${st}/><path d="M16 16 l14 14 M30 16 l-14 14 M84 84 l14 14 M98 84 l-14 14" ${st}/><circle cx="56" cy="56" r="10" ${st}/>`],
        ['80%', '12%', 90, `<path d="M45 6 l11 25 27 3 -20 18 6 27 -24 -14 -24 14 6 -27 -20 -18 27 -3z" ${st}/>`],
        ['86%', '62%', 100, `<path d="M50 50 m0 -6 a6 6 0 1 1 -6 6 a12 12 0 1 1 12 12 a18 18 0 1 1 -18 -18 a26 26 0 1 1 26 26 a34 34 0 1 1 -34 -34" ${st}/>`],
        ['10%', '70%', 90, `<path d="M30 30 q0 -22 22 -22 q22 0 22 20 q0 16 -20 22 v14 M54 84 v4" ${st}/>`],
        ['70%', '84%', 80, `<path d="M44 4 l-26 42 h22 l-10 36 34 -48 h-22z" ${st}/>`],
        ['24%', '86%', 110, `<path d="M8 50 h80 m-20 -20 l20 20 -20 20" ${st}/>`],
        ['3%', '44%', 70, `<circle cx="35" cy="35" r="10" ${st}/><path d="M35 6 v10 M35 54 v10 M6 35 h10 M54 35 h10 M14 14 l7 7 M49 49 l7 7 M56 14 l-7 7 M21 49 l-7 7" ${st}/>`],
        ['90%', '38%', 70, `<path d="M10 60 q15 -50 30 0 q15 50 30 0" ${st}/>`],
      ];
      return items.map(([l, t, s, inner]) => `<svg style="left:${l};top:${t}" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${inner}</svg>`).join('');
    },

    cloud(w = 260, h = 150, color = '#ffffff') {
      // drawn in a 260×150 box and scaled to w×h
      return `<svg width="${w}" height="${h}" viewBox="0 0 260 150" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round">` +
        `<path d="M50 130 a40 40 0 0 1 10 -78 a60 60 0 0 1 110 -20 a46 46 0 0 1 70 50 a34 34 0 0 1 -10 48z" fill="${color}" stroke="${O}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/></svg>`;
    },
  };

  window.Art = Art;
})();

// ---- js/engine.js ----
// Puzzle engine: a 1000x1000 scene of draggable / tappable objects, an interactive
// question line, and helpers (choices, number pad, bubbles, win / fail feedback).
(function () {
  const SIZE = 1000;
  const sceneEl = document.getElementById('scene');
  const stageEl = document.getElementById('stage');
  const qEl = document.getElementById('question');
  const TAP_SLOP = 9; // screen px a pointer may move and still count as a tap

  let k = 1;
  let S = null;      // current scene context
  let uid = 0;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const INK = '#1f1f24';
  const stroke2 = (d, color, w) =>
    `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + 10}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const MARK_CHECK = `<svg width="400" height="400" viewBox="0 0 100 100">${stroke2('M18 52 L40 74 L84 26', '#b9e85a', 13)}</svg>`;
  const MARK_X = `<svg width="170" height="170" viewBox="0 0 100 100">${stroke2('M22 22 L78 78 M78 22 L22 78', '#ff6b6b', 14)}</svg>`;
  const SPARK_COLORS = ['#ffd23f', '#b9e85a', '#ff6b6b', '#7fd3ff', '#c7a8ff', '#ffffff'];

  function haptic(pattern) {
    if (GameAudio.isUserMuted()) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not allowed in this frame */ }
  }

  // a ring of little stars / dots that fly out from (x, y) in scene units
  function burst(x, y, n = 10, spread = 140) {
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'spark' + (i % 3 === 0 ? ' star' : '');
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const r = spread * (0.6 + Math.random() * 0.6);
      d.style.left = x + 'px'; d.style.top = y + 'px';
      d.style.setProperty('--dx', Math.cos(a) * r + 'px');
      d.style.setProperty('--dy', Math.sin(a) * r + 'px');
      d.style.setProperty('--c', SPARK_COLORS[i % SPARK_COLORS.length]);
      sceneEl.appendChild(d);
      setTimeout(() => d.remove(), 750);
    }
  }

  function floatText(text, x, y, cls = '') {
    const f = document.createElement('div');
    f.className = 'floaty ' + cls;
    f.textContent = text;
    f.style.left = x + 'px'; f.style.top = y + 'px';
    sceneEl.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  function ripple(x, y) {
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = x + 'px'; r.style.top = y + 'px';
    sceneEl.appendChild(r);
    setTimeout(() => r.remove(), 450);
  }

  function squash(body) {
    if (!body.animate) return;
    body.animate([{ scale: '1.14 0.86' }, { scale: '0.94 1.06' }, { scale: '1 1' }], { duration: 280, easing: 'ease-out' });
  }
  function bounce(body) {
    if (!body.animate) return;
    body.animate([{ scale: '1' }, { scale: '0.86' }, { scale: '1.06' }, { scale: '1' }], { duration: 240, easing: 'ease-out' });
  }

  // ---------- layout ----------
  function layout() {
    const wide = window.innerWidth >= window.innerHeight * 1.4;
    // short landscape screens (phones, small Poki frames): puzzle on the left, question + buttons on the right.
    // This gives the puzzle the full height and keeps the top-centre free for Poki's mobile pill.
    const side = wide && window.innerHeight < 520;
    document.body.classList.toggle('portrait', !wide);
    document.body.classList.toggle('landscape', wide);
    document.body.classList.toggle('side', side);
    if (side) {
      const app = document.getElementById('app');
      const cs = getComputedStyle(app);
      stageEl.style.width = Math.floor(app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) + 'px';
    } else stageEl.style.width = '';
    const r = stageEl.getBoundingClientRect();
    k = Math.max(0.05, Math.min(r.width, r.height) / SIZE);
    const ox = (r.width - SIZE * k) / 2;
    const oy = (r.height - SIZE * k) / 2;
    sceneEl.style.transform = `translate(${ox}px, ${oy}px) scale(${k})`;
  }

  function toScene(cx, cy) {
    const r = sceneEl.getBoundingClientRect();
    return { x: (cx - r.left) / k, y: (cy - r.top) / k };
  }

  // ---------- objects ----------
  // Each object is a zero-size positioner (.obj) that flex-centres its body (.in) on (x, y),
  // so rotation, scale and CSS animations on the body always pivot around its own centre.
  class Obj {
    constructor(ctx, o) {
      this.S = ctx;
      this.id = o.id || 'o' + (++uid);
      const el = document.createElement('div');
      el.className = 'obj';
      el.dataset.id = this.id;
      const body = document.createElement('div');
      body.className = 'in';
      if (o.e != null) { body.classList.add('emoji'); body.textContent = o.e; }
      else if (o.text != null) { body.classList.add('text'); body.textContent = o.text; }
      else if (o.html != null) body.innerHTML = o.html;
      if (o.cls) o.cls.split(' ').forEach((c) => c && body.classList.add(c));
      if (o.w) body.style.width = o.w + 'px';
      if (o.h) body.style.height = o.h + 'px';
      body.style.fontSize = (o.s || 100) + 'px';
      if (o.color) body.style.color = o.color;
      if (o.style) for (const k in o.style) k.startsWith('--') ? body.style.setProperty(k, o.style[k]) : (body.style[k] = o.style[k]);
      el.appendChild(body);
      this.el = el;
      this.body = body;
      this.x = o.x == null ? 500 : o.x;
      this.y = o.y == null ? 500 : o.y;
      this.rot = o.rot || 0;
      this.sc = o.sc == null ? 1 : o.sc;
      this.flip = o.flip ? -1 : 1;
      this.op = o.op == null ? 1 : o.op;
      this.z = o.z == null ? 10 : o.z;
      this.drag = !!o.drag;
      this.axis = o.axis || null;
      this.bounds = o.bounds || null;
      this.lift = o.lift !== false;
      this.back = !!o.back;
      this.onTap = o.tap || null;
      this.onDrop = o.drop || null;
      this.onMove = o.move || null;
      this.onGrab = o.grab || null;
      this.data = o.data || {};
      el.style.zIndex = this.z;
      if (o.static) el.classList.add('static');
      this.refreshCursor();
      this.render();
      (o.parent ? o.parent.body : ctx.root).appendChild(el);
      if (o.hidden) this.hide();
    }

    refreshCursor() {
      this.body.classList.toggle('draggable', this.drag);
      this.body.classList.toggle('interactive', !!this.onTap && !this.drag);
    }

    render() {
      this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
      this.body.style.transform = `rotate(${this.rot}deg) scale(${this.sc * this.flip}, ${this.sc})`;
      this.el.style.opacity = this.op;
    }

    set(p) {
      const b = this.body;
      for (const key in p) {
        if (key === 'e' || key === 'text') b.textContent = p[key];
        else if (key === 'html') b.innerHTML = p.html;
        else if (key === 'z') { this.z = p.z; this.el.style.zIndex = p.z; }
        else if (key === 'w') b.style.width = p.w + 'px';
        else if (key === 'h') b.style.height = p.h + 'px';
        else if (key === 's') b.style.fontSize = p.s + 'px';
        else if (key === 'drag') { this.drag = p.drag; this.refreshCursor(); }
        else if (key === 'tap') { this.onTap = p.tap; this.refreshCursor(); }
        else if (key === 'flip') this.flip = p.flip ? -1 : 1;
        else this[key] = p[key];
      }
      this.render();
      return this;
    }

    to(p, ms = 400, ease = 'cubic-bezier(.3,1.25,.5,1)') {
      const tr = `transform ${ms}ms ${ease}, opacity ${ms}ms ease`;
      this.el.style.transition = tr;
      this.body.style.transition = tr;
      void this.el.offsetWidth; // flush styles so the transition always runs
      this.set(p);
      return this.S.wait(ms).then(() => { this.el.style.transition = ''; this.body.style.transition = ''; return this; });
    }

    hide() { this.el.style.display = 'none'; return this; }
    show() { this.el.style.display = ''; return this; }
    isShown() { return this.el.style.display !== 'none' && this.el.isConnected; }
    remove() { this.el.remove(); this.S.map.delete(this.id); }
    cls(name, on = true) { this.body.classList.toggle(name, on); return this; }

    anim(name, ms = 500) {
      const b = this.body;
      b.classList.remove(name);
      void b.offsetWidth;
      b.classList.add(name);
      this.S.after(ms, () => b.classList.remove(name));
      return this;
    }
    shake() { return this.anim('shake', 460); }

    rect() {
      const r = this.body.getBoundingClientRect();
      const s = sceneEl.getBoundingClientRect();
      const l = (r.left - s.left) / k, t = (r.top - s.top) / k;
      const w = r.width / k, h = r.height / k;
      return { l, t, r: l + w, b: t + h, w, h, x: l + w / 2, y: t + h / 2 };
    }
  }

  // ---------- scene context ----------
  function createContext(level, index) {
    sceneEl.innerHTML = '';
    // optional framed backdrop; without one the level is drawn straight on the notebook paper
    const bgEl = document.createElement('div');
    bgEl.className = 'scene-bg';
    bgEl.style.display = 'none';
    sceneEl.appendChild(bgEl);
    const root = document.createElement('div');
    root.className = 'layer';
    root.style.pointerEvents = 'auto';
    sceneEl.appendChild(root);
    const frame = document.createElement('div');
    frame.className = 'scene-frame';
    frame.style.display = 'none';
    sceneEl.appendChild(frame);

    const timers = [];
    const ctx = {
      level, index,
      root,
      map: new Map(),
      state: {},
      locked: false,
      done: false,
      onBgTap: null,
      words: [],
      mistakes: 0,
      t0: performance.now(),

      add(o) {
        const obj = new Obj(ctx, o);
        ctx.map.set(obj.id, obj);
        return obj;
      },
      get(id) { return ctx.map.get(id); },

      // decorative rectangle by top-left corner
      rect(l, t, w, h, style = {}, opts = {}) {
        return ctx.add(Object.assign({ html: '', w, h, x: l + w / 2, y: t + h / 2, static: true, z: 1, style: Object.assign({ borderRadius: '0' }, style) }, opts));
      },

      bg(css) { bgEl.style.background = css; bgEl.style.display = ''; frame.style.display = ''; },

      after(ms, fn) {
        const t = setTimeout(() => { if (S === ctx) fn(); }, ms);
        timers.push(t);
        return t;
      },
      every(ms, fn) {
        const t = setInterval(() => { if (S === ctx) fn(); }, ms);
        timers.push(t);
        return t;
      },
      wait(ms) { return new Promise((res) => ctx.after(ms, res)); },
      clearTimers() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers.length = 0; },

      dist(a, b) { const A = a.rect ? a.rect() : a, B = b.rect ? b.rect() : b; return Math.hypot(A.x - B.x, A.y - B.y); },
      near(a, b, d) { return ctx.dist(a, b) <= d; },
      // is the centre of a inside b's box (grown by pad)?
      over(a, b, pad = 0) {
        if (!a.isShown() || !b.isShown()) return false;
        const A = a.rect(), B = b.rect();
        return A.x >= B.l - pad && A.x <= B.r + pad && A.y >= B.t - pad && A.y <= B.b + pad;
      },
      hits(a, b, pad = 0) {
        if (!a.isShown() || !b.isShown()) return false;
        const A = a.rect(), B = b.rect();
        return A.l < B.r + pad && A.r > B.l - pad && A.t < B.b + pad && A.b > B.t - pad;
      },

      // ---------- feedback ----------
      win(msg) {
        if (ctx.done) return;
        ctx.done = true;
        ctx.locked = true;
        GameAudio.play('win');
        haptic([20, 40, 30]);
        const m = document.createElement('div');
        m.className = 'mark check';
        m.innerHTML = MARK_CHECK;
        m.style.left = '500px'; m.style.top = '470px';
        sceneEl.appendChild(m);
        burst(500, 470, 18, 380);
        Game.fx.confetti();
        ctx.after(1100, () => Game.onWin(msg, { mistakes: ctx.mistakes, ms: performance.now() - ctx.t0 }));
      },

      // celebrate a correct intermediate step: sparkles, a chime and optional floating text
      good(target, text) {
        const p = target && target.rect ? target.rect() : (target || { x: 500, y: 500 });
        GameAudio.play('sparkle');
        haptic(12);
        burst(p.x, p.y, 10, 130);
        if (text) floatText(text, p.x, p.y - 50);
      },

      fail(at, msg) {
        if (ctx.done) return;
        ctx.mistakes++;
        GameAudio.play('wrong');
        haptic(45);
        sceneEl.classList.remove('scene-shake');
        void sceneEl.offsetWidth;
        sceneEl.classList.add('scene-shake');
        let p = at;
        if (at && at.rect) { at.shake(); p = at.rect(); }
        if (!p) p = { x: 500, y: 500 };
        const m = document.createElement('div');
        m.className = 'mark x fade';
        m.innerHTML = MARK_X;
        m.style.left = p.x + 'px'; m.style.top = p.y + 'px';
        sceneEl.appendChild(m);
        setTimeout(() => m.remove(), 1400);
        if (msg) ctx.toast(msg, p.x, p.y - 60);
      },

      toast(text, x, y, ms = 1600) {
        GameAudio.play('bubble');
        const b = document.createElement('div');
        b.className = 'bubble';
        b.textContent = text;
        sceneEl.appendChild(b);
        const w = b.offsetWidth, h = b.offsetHeight;
        const cx = clamp(x, w / 2 + 16, SIZE - w / 2 - 16);
        const cy = clamp(y, h + 16, SIZE - 16);
        b.style.left = (cx - w / 2) + 'px';
        b.style.top = (cy - h) + 'px';
        setTimeout(() => { b.style.transition = 'opacity .25s'; b.style.opacity = '0'; }, ms);
        setTimeout(() => b.remove(), ms + 300);
        return b;
      },

      say(o, text, ms) {
        const r = o.rect();
        return ctx.toast(text, r.x, r.t - 10, ms);
      },

      // point a big finger at something (used by the solution hint)
      point(x, y) {
        const a = document.createElement('div');
        a.className = 'hint-arrow';
        a.textContent = '👇';
        a.style.left = (x - 45) + 'px'; a.style.top = (y - 110) + 'px';
        a.style.fontFamily = 'var(--emoji)';
        sceneEl.appendChild(a);
        return a;
      },

      // ---------- question words ----------
      word(key) { return ctx.words.find((w) => w.key === key); },
      tapWord(key, fn) {
        const w = ctx.word(key);
        if (!w) return;
        w.onTap = fn;
        w.el.classList.add('tap');
      },
      dragWord(key, fn) {
        const w = ctx.word(key);
        if (!w) return;
        w.onDrop = fn;
        w.el.classList.add('drag');
      },

      // ---------- answer widgets ----------
      choices(items, correct, opts = {}) {
        const n = items.length;
        const cols = opts.cols || n;
        const rows = Math.ceil(n / cols);
        const gap = opts.gap || 26;
        const h = opts.h || 140;
        const w = opts.w || (SIZE - 80 - gap * (cols - 1)) / cols;
        const y0 = opts.y == null ? SIZE - 40 - rows * h - (rows - 1) * gap + h / 2 : opts.y;
        const buttons = [];
        items.forEach((label, i) => {
          const c = i % cols, r = Math.floor(i / cols);
          const rowCount = Math.min(cols, n - r * cols);
          const rowW = rowCount * w + (rowCount - 1) * gap;
          const x = (SIZE - rowW) / 2 + w / 2 + c * (w + gap);
          const b = ctx.add({
            html: label, cls: 'choice', w, h, s: opts.size || 54,
            x, y: y0 + r * (h + gap), z: 50,
            tap: (o) => {
              const ok = Array.isArray(correct) ? correct.includes(i) : i === correct;
              if (ok) { o.cls('right'); ctx.win(opts.msg); }
              else { o.cls('wrong'); ctx.fail(o); if (opts.onWrong) opts.onWrong(i); }
            },
          });
          buttons.push(b);
        });
        return buttons;
      },

      numpad(answer, opts = {}) {
        const answers = (Array.isArray(answer) ? answer : [answer]).map(String);
        const max = opts.max || 4;
        const y = opts.y == null ? 590 : opts.y;
        let val = '';
        const disp = ctx.add({ html: '?', cls: 'display', w: 400, h: 120, s: 84, x: 500, y, z: 50 });
        const show = () => { disp.body.textContent = val || '?'; disp.body.style.color = val ? INK : '#b5b5bd'; };
        show();
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫', '✓'];
        const kw = 140, kh = 112, gap = 16;
        keys.forEach((key, i) => {
          const c = i % 6, r = Math.floor(i / 6);
          ctx.add({
            html: key, cls: 'key' + (key === '✓' ? ' ok' : ''), w: kw, h: kh, s: 60, z: 50,
            x: (SIZE - (6 * kw + 5 * gap)) / 2 + kw / 2 + c * (kw + gap),
            y: y + 150 + r * (kh + gap),
            tap: () => {
              if (key === '⌫') val = val.slice(0, -1);
              else if (key === '✓') {
                if (!val) return;
                if (answers.includes(val)) { disp.body.style.background = '#b9e85a'; opts.onCorrect ? opts.onCorrect() : ctx.win(opts.msg); }
                else { ctx.fail(disp); if (opts.onWrong) opts.onWrong(val); val = ''; }
              } else if (val.length < max) val += key;
              show();
            },
          });
        });
        return disp;
      },
    };
    return ctx;
  }

  // ---------- question rendering ----------
  // Text in [brackets] becomes its own token with no space before it, so a level can make
  // punctuation tappable: "Tap the smallest dot[.]"
  function renderQuestion(ctx, text) {
    qEl.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'qt';
    ctx.words = [];
    const re = /\[([^\]]+)\]|[^\s\[]+|\s+/g;
    let m;
    while ((m = re.exec(text))) {
      if (/^\s+$/.test(m[0])) { line.appendChild(document.createTextNode(' ')); continue; }
      const t = m[1] != null ? m[1] : m[0];
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = t;
      if (/\p{Extended_Pictographic}/u.test(t)) span.classList.add('em');
      line.appendChild(span);
      const key = t.replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]/gu, '').toLowerCase() || t;
      ctx.words.push({ key: m[1] != null ? m[1] : key, text: t, el: span, onTap: null, onDrop: null });
    }
    qEl.appendChild(line);
  }

  // ---------- input ----------
  let active = null;

  function onSceneDown(e) {
    if (!S || S.locked || SDK.inAd || active) return;
    Game.onFirstInput();
    const el = e.target.closest('.obj');
    const o = el ? S.map.get(el.dataset.id) : null;
    const p = toScene(e.clientX, e.clientY);
    active = { kind: 'obj', o, p0: p, c0: { x: e.clientX, y: e.clientY }, moved: false, ox: o ? o.x : 0, oy: o ? o.y : 0, id: e.pointerId };
    if (o && o.drag) {
      o.body.classList.add('dragging');
      o.el.classList.add('held');
      if (o.lift) o.el.style.zIndex = 800;
      if (o.onGrab) o.onGrab(o);
    }
    bindMove();
    e.preventDefault();
  }

  function onWordDown(e) {
    if (!S || S.locked || SDK.inAd || active) return;
    Game.onFirstInput();
    const el = e.target.closest('.w');
    if (!el) return;
    const w = S.words.find((x) => x.el === el);
    if (!w || (!w.onTap && !w.onDrop)) return;
    active = { kind: 'word', w, c0: { x: e.clientX, y: e.clientY }, moved: false, id: e.pointerId, ghost: null };
    bindMove();
    e.preventDefault();
  }

  function bindMove() {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  function unbindMove() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    const a = active;
    if (!a || e.pointerId !== a.id) return;
    if (!a.moved && Math.hypot(e.clientX - a.c0.x, e.clientY - a.c0.y) > TAP_SLOP) {
      a.moved = true;
      if (a.kind === 'obj' && a.o && a.o.drag) GameAudio.play('pick');
      if (a.kind === 'word' && a.w.onDrop) {
        const g = a.w.el.cloneNode(true);
        const r = a.w.el.getBoundingClientRect();
        const cs = getComputedStyle(qEl);
        Object.assign(g.style, {
          position: 'fixed', left: r.left + 'px', top: r.top + 'px', zIndex: 70, pointerEvents: 'none',
          fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, color: '#2b2350',
          background: '#fff2a8', padding: '0 .15em', borderRadius: '.25em', boxShadow: '0 6px 0 rgba(0,0,0,.2)',
        });
        g.dataset.dx = e.clientX - r.left; g.dataset.dy = e.clientY - r.top;
        document.body.appendChild(g);
        a.ghost = g;
        a.w.el.classList.add('hidden-word');
        GameAudio.play('pick');
      }
    }
    if (!a.moved) return;
    if (a.kind === 'obj' && a.o && a.o.drag && !S.locked) {
      // move by the pointer's screen delta, so a scene that is still animating in can't make objects jump
      const o = a.o;
      let nx = a.ox + (e.clientX - a.c0.x) / k, ny = a.oy + (e.clientY - a.c0.y) / k;
      if (o.axis === 'x') ny = a.oy;
      if (o.axis === 'y') nx = a.ox;
      const b = o.bounds || { l: 10, t: 10, r: SIZE - 10, b: SIZE - 10 };
      o.x = clamp(nx, b.l, b.r);
      o.y = clamp(ny, b.t, b.b);
      o.render();
      if (o.onMove) o.onMove(o);
    } else if (a.kind === 'word' && a.ghost) {
      a.ghost.style.left = (e.clientX - a.ghost.dataset.dx) + 'px';
      a.ghost.style.top = (e.clientY - a.ghost.dataset.dy) + 'px';
    }
  }

  function onUp(e) {
    const a = active;
    if (!a || e.pointerId !== a.id) return;
    active = null;
    unbindMove();
    if (!S) return;
    if (a.kind === 'word') {
      const w = a.w;
      if (!a.moved) {
        if (w.onTap) { w.el.classList.remove('pressed'); void w.el.offsetWidth; w.el.classList.add('pressed'); w.onTap(w); }
        return;
      }
      if (a.ghost) {
        const r = a.ghost.getBoundingClientRect();
        a.ghost.remove();
        const p = toScene(r.left + r.width / 2, r.top + r.height / 2);
        const used = p.x >= 0 && p.x <= SIZE && p.y >= 0 && p.y <= SIZE && w.onDrop && w.onDrop(w, p);
        if (!used) w.el.classList.remove('hidden-word');
        else GameAudio.play('drop');
      }
      return;
    }
    const o = a.o;
    if (o && o.drag) {
      o.body.classList.remove('dragging');
      o.el.classList.remove('held');
      if (o.lift) o.el.style.zIndex = o.z;
    }
    if (!a.moved) {
      if (o && o.onTap) { GameAudio.play('tap'); bounce(o.body); o.onTap(o, a.p0); }
      else {
        ripple(a.p0.x, a.p0.y);
        if (S.onBgTap) S.onBgTap(a.p0, o);
      }
      return;
    }
    if (o && o.drag) {
      GameAudio.play('drop');
      squash(o.body);
      const handled = o.onDrop ? o.onDrop(o, toScene(e.clientX, e.clientY)) : false;
      if (!handled && o.back && S.map.has(o.id)) o.to({ x: a.ox, y: a.oy }, 300);
    }
  }

  function cancelInput() {
    if (!active) return;
    if (active.ghost) active.ghost.remove();
    if (active.kind === 'word') active.w.el.classList.remove('hidden-word');
    if (active.o) { active.o.body.classList.remove('dragging'); active.o.el.classList.remove('held'); }
    active = null;
    unbindMove();
  }

  sceneEl.addEventListener('pointerdown', onSceneDown);
  qEl.addEventListener('pointerdown', onWordDown);
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 200));

  window.Engine = {
    SIZE,
    layout,
    load(level, index) {
      cancelInput();
      if (S) S.clearTimers();
      S = createContext(level, index);
      renderQuestion(S, level.q);
      layout();
      level.setup(S);
      return S;
    },
    current() { return S; },
    burst, haptic,
    unload() { cancelInput(); if (S) S.clearTimers(); S = null; },
  };
})();

// ---- js/level-kit.js ----
// Shared helpers for level files (levels-1.js, levels-2.js).
(function () {
  const A = window.Art;
  const INK = '#1f1f24';
  const SKY = 'linear-gradient(#bfe9ff, #effaff)';

  function floor(S, y, color) {
    return S.rect(0, y, 1000, 1000 - y, { background: color, borderTop: `7px solid ${INK}` }, { z: 1 });
  }
  function room(S, wall, floorColor, y = 780) {
    S.bg(wall);
    return floor(S, y, floorColor);
  }
  const block = (bg, extra = {}) => Object.assign({
    background: bg, borderRadius: '30px', border: `7px solid ${INK}`, boxShadow: `0 10px 0 ${INK}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--display)', color: INK, paddingTop: '.12em',
  }, extra);

  // A fridge whose door opens and closes on tap. Items dropped inside sit between body and door.
  function fridge(S, x, y) {
    const F = { open: false, onToggle: null };
    F.body = S.add({ html: A.fridgeBody(), x, y, z: 2, static: true });
    F.door = S.add({ html: A.fridgeDoorClosed(), x, y, z: 6, tap: () => F.toggle() });
    F.toggle = () => {
      F.open = !F.open;
      GameAudio.play(F.open ? 'whoosh' : 'drop');
      if (F.open) F.door.set({ html: A.fridgeDoorOpen(), x: x + 185 });
      else F.door.set({ html: A.fridgeDoorClosed(), x });
      if (F.onToggle) F.onToggle(F.open);
    };
    F.isOver = (o) => S.over(o, F.body, 20);
    return F;
  }

  window.LevelKit = { A, INK, SKY, floor, room, block, fridge };
  window.LEVELS = [];
})();

// ---- js/levels-1.js ----
// Levels 1–21
// Each level: { id, q, hint, solution, setup(S) }. setup builds the scene with the engine API (engine.js).
(function () {
  const { A, INK, SKY, floor, room, block, fridge } = window.LevelKit;

  // ---------- helpers local to this file ----------
  // tap handler that cycles through a list of funny lines
  const talk = (S, lines, ms) => { let i = 0; return (o) => S.say(o, lines[i++ % lines.length], ms); };
  // true only the first time `key` is used during this run of the level
  const first = (S, key) => (S.state[key] ? false : (S.state[key] = true));
  // two snacks on the top shelf of the fridge (between the fridge body and its door)
  const fridgeSnacks = (S) => {
    S.add({ e: '🧀', x: 590, y: 415, s: 70, z: 3, tap: (o) => S.say(o, 'Cheese!', 800) });
    S.add({ e: '🥛', x: 705, y: 412, s: 70, z: 3, tap: (o) => S.say(o, 'Milk!', 800) });
  };
  const doubleStroke = (d, color, w) =>
    `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w + 14}" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;

  // ---------- extra props (inline SVG in the Art style) ----------
  const sleepyCat = () => A.svg(300, 200, `
    <ellipse cx="175" cy="130" rx="110" ry="60" fill="#ffb45c" stroke="${INK}" stroke-width="7"/>
    <path d="M165 76 q14 22 0 46 M205 74 q14 24 0 50 M243 88 q12 20 0 40" stroke="#e58a2e" stroke-width="9" fill="none"/>
    ${doubleStroke('M278 140 Q302 192 232 194 Q186 196 150 190', '#ffb45c', 16)}
    <path d="M44 106 L48 44 L94 78 Z" fill="#ffb45c" stroke="${INK}" stroke-width="7"/>
    <path d="M98 76 L142 40 L148 106 Z" fill="#ffb45c" stroke="${INK}" stroke-width="7"/>
    <path d="M56 92 L58 62 L80 78 Z M110 78 L134 58 L136 94 Z" fill="#ffb3c7"/>
    <circle cx="95" cy="130" r="56" fill="#ffb45c" stroke="${INK}" stroke-width="7"/>
    <path d="M62 128 q12 10 24 0 M104 128 q12 10 24 0" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M89 144 l6 7 l6 -7 z" fill="#ff7a9a" stroke="${INK}" stroke-width="4"/>
    <ellipse cx="150" cy="184" rx="32" ry="15" fill="#ffc77f" stroke="${INK}" stroke-width="6"/>
    <ellipse cx="214" cy="186" rx="28" ry="13" fill="#ffc77f" stroke="${INK}" stroke-width="6"/>`);

  const doghouse = () => A.svg(300, 280, `
    <path d="M18 122 L150 14 L282 122 Z" fill="#e5484d" stroke="${INK}" stroke-width="7"/>
    <rect x="40" y="112" width="220" height="162" fill="#c9824a" stroke="${INK}" stroke-width="7"/>
    <path d="M108 274 V206 a42 42 0 0 1 84 0 V274 Z" fill="#2b2350" stroke="${INK}" stroke-width="6"/>
    <rect x="104" y="130" width="92" height="30" rx="8" fill="#ffd23f" stroke="${INK}" stroke-width="5"/>`);

  const bush = () => A.svg(240, 160, `
    <path d="M22 150 Q0 104 40 84 Q38 32 98 38 Q130 2 172 32 Q232 30 222 92 Q246 122 220 150 Z" fill="#4caf50" stroke="${INK}" stroke-width="7"/>
    <path d="M70 112 q20 -16 40 0 M140 82 q16 -14 32 0" stroke="#2e7d32" stroke-width="7" fill="none" stroke-linecap="round"/>`);

  const dogBowl = () => A.svg(150, 80, `
    <path d="M10 22 H140 Q132 76 75 76 Q18 76 10 22 Z" fill="#3d8bff" stroke="${INK}" stroke-width="7"/>
    <ellipse cx="75" cy="22" rx="65" ry="12" fill="#a8743f" stroke="${INK}" stroke-width="6"/>`);

  const puppyTail = () => A.svg(90, 120, doubleStroke('M86 114 Q42 102 32 62 Q26 32 46 12', '#c9824a', 18));

  const barn = () => A.svg(440, 380, `
    <rect x="60" y="170" width="320" height="204" fill="#e5484d" stroke="${INK}" stroke-width="7"/>
    <path d="M30 192 L220 22 L410 192 Z" fill="#8a4b2a" stroke="${INK}" stroke-width="7"/>
    <path d="M90 168 L220 52 L350 168" fill="none" stroke="#6e3a1f" stroke-width="8"/>
    <rect x="176" y="250" width="88" height="124" fill="#fff3d6" stroke="${INK}" stroke-width="6"/>
    <path d="M176 250 L264 374 M264 250 L176 374" stroke="${INK}" stroke-width="5"/>
    <circle cx="220" cy="140" r="24" fill="#fff3d6" stroke="${INK}" stroke-width="6"/>`);

  const windLines = () => A.svg(220, 140, `
    <path d="M10 30 q50 -26 100 0 t100 0 M30 75 q45 -24 90 0 t80 0 M10 120 q50 -26 100 0 t90 0" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>`);

  const doorbell = () => A.svg(64, 96, `
    <rect x="6" y="6" width="52" height="84" rx="16" fill="#fff" stroke="${INK}" stroke-width="6"/>
    <circle cx="32" cy="48" r="15" fill="#ffd23f" stroke="${INK}" stroke-width="5"/>`);

  const bathtub = () => A.svg(620, 300, `
    <path d="M100 262 l-14 32 h44 l-6 -32 Z M520 262 l6 32 h-44 l14 -32 Z" fill="#ffd23f" stroke="${INK}" stroke-width="6"/>
    <path d="M10 70 H610 Q604 252 470 264 H150 Q16 252 10 70 Z" fill="#ffffff" stroke="${INK}" stroke-width="7"/>
    <rect x="26" y="38" width="568" height="66" rx="33" fill="#d3e9f7" stroke="${INK}" stroke-width="7"/>
    <ellipse cx="470" cy="72" rx="18" ry="11" fill="#2b2350"/>`);

  const bathFaucet = () => A.svg(200, 150, `
    <rect x="8" y="40" width="34" height="74" rx="10" fill="#c9d6e3" stroke="${INK}" stroke-width="6"/>
    ${doubleStroke('M42 62 H128 Q160 62 160 92 V112', '#c9d6e3', 16)}
    <rect x="84" y="28" width="14" height="26" fill="#c9d6e3" stroke="${INK}" stroke-width="5"/>
    <rect x="58" y="10" width="66" height="24" rx="11" fill="#ff6b6b" stroke="${INK}" stroke-width="6"/>`);

  const bathPlug = () => A.svg(84, 84, `
    <circle cx="42" cy="16" r="10" fill="none" stroke="${INK}" stroke-width="6"/>
    <ellipse cx="42" cy="54" rx="32" ry="22" fill="#4a4a5a" stroke="${INK}" stroke-width="7"/>
    <ellipse cx="33" cy="47" rx="10" ry="5" fill="#8a8aa0"/>`);

  const towel = () => A.svg(220, 240, `
    <rect x="44" y="24" width="132" height="206" rx="16" fill="#ff9fb8" stroke="${INK}" stroke-width="7"/>
    <path d="M48 180 H172 M48 202 H172" stroke="#fff" stroke-width="9"/>
    <path d="M10 26 H210" stroke="${INK}" stroke-width="16" stroke-linecap="round"/>
    <path d="M10 26 H210" stroke="#c9d6e3" stroke-width="6" stroke-linecap="round"/>`);

  const fishbowl = () => A.svg(340, 300, `
    <defs><clipPath id="fwclip"><path d="M100 32 Q12 100 20 180 Q32 290 170 292 Q308 290 320 180 Q328 100 240 32 Z"/></clipPath></defs>
    <path d="M100 32 Q12 100 20 180 Q32 290 170 292 Q308 290 320 180 Q328 100 240 32 Z" fill="#eef8ff"/>
    <g clip-path="url(#fwclip)"><g class="fw-water" style="transition: transform 1.1s cubic-bezier(.3,1.15,.5,1)">
      <rect x="-10" y="300" width="360" height="260" fill="#5ec8ff"/>
      <path d="M-10 300 q45 -16 90 0 t90 0 t90 0 t90 0" fill="#9fdcff" stroke="${INK}" stroke-width="5"/>
    </g></g>
    <path d="M100 32 Q12 100 20 180 Q32 290 170 292 Q308 290 320 180 Q328 100 240 32" fill="none" stroke="${INK}" stroke-width="7"/>
    <ellipse cx="170" cy="32" rx="74" ry="14" fill="#d8eefa" stroke="${INK}" stroke-width="6"/>
    <path d="M58 150 Q60 110 86 84" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>`);

  const kitchenCounter = () => A.svg(300, 280, `
    <rect x="14" y="50" width="272" height="226" rx="12" fill="#8fc6f0" stroke="${INK}" stroke-width="7"/>
    <rect x="34" y="82" width="106" height="170" rx="10" fill="#a9d6f7" stroke="${INK}" stroke-width="6"/>
    <rect x="160" y="82" width="106" height="170" rx="10" fill="#a9d6f7" stroke="${INK}" stroke-width="6"/>
    <circle cx="122" cy="166" r="8" fill="#ffd23f" stroke="${INK}" stroke-width="4"/>
    <circle cx="178" cy="166" r="8" fill="#ffd23f" stroke="${INK}" stroke-width="4"/>
    <rect x="4" y="28" width="292" height="34" rx="10" fill="#f4f1fb" stroke="${INK}" stroke-width="7"/>
    <rect x="86" y="35" width="128" height="14" rx="7" fill="#6b7a8c"/>`);

  const sinkTap = () => A.svg(120, 140, `
    ${doubleStroke('M30 136 V42 Q30 12 60 12 Q90 12 90 42 V58', '#c9d6e3', 14)}
    <rect x="6" y="96" width="46" height="18" rx="8" fill="#ff6b6b" stroke="${INK}" stroke-width="5"/>`);

  const calTile = (m) => `<div style="position:absolute;left:0;top:0;right:0;height:40px;background:#ff6b6b;border-bottom:6px solid ${INK}"></div>` +
    `<span style="position:relative;top:18px">${m}</span>`;

  window.LEVELS.push(
    // 1
    {
      id: 'biggest-number',
      q: 'Tap the biggest number.',
      hint: "Big doesn't always mean big-looking.",
      solution: 'Tap the tiny 1000. It is the largest number!',
      setup(S) {
        const nums = [['8', 240, 270, 230, '#ff5a5f', -8], ['99', 690, 300, 320, '#3d8bff', 6], ['27', 270, 700, 250, '#a259ff', 5],
          ['5', 540, 560, 160, '#ff9f1c', -4], ['1000', 760, 760, 64, '#16a34a', 0]];
        const objs = nums.map(([t, x, y, s, c, r], i) => S.add({ text: t, x, y, s, rot: r, color: c, cls: 'bob',
          style: { padding: t === '1000' ? '34px' : '14px', animationDelay: (i * 0.35) + 's', animationDuration: (1.8 + (i % 3) * 0.4) + 's' },
          tap: (o) => {
            if (t !== '1000') return S.fail(o, t === '99' ? 'Big... but not the biggest!' : '');
            S.locked = true;
            objs.forEach((n) => n !== o && n.to({ sc: 0.6, op: 0.5 }, 300));
            o.to({ x: 500, y: 520, sc: 3.4, rot: 0 }, 450);
            S.win('Size can fool you. Value matters!');
          } }));
      },
    },
    // 2
    {
      id: 'make-morning',
      q: 'Make it morning!',
      hint: 'Something in the sky has to go down first.',
      solution: 'Drag the moon down behind the hills. The sun will come up.',
      setup(S) {
        S.bg('linear-gradient(#1b1745, #3b3486)');
        const day = S.rect(0, 0, 1000, 1000, { background: 'linear-gradient(#8fd8ff, #e9f9ff)' }, { z: 0, op: 0 });
        const stars = [[120, 140], [330, 90], [480, 230], [880, 120], [260, 380], [600, 120], [820, 380], [90, 470]].map(([x, y], i) =>
          S.add({ text: '✦', x, y, s: 30 + (i % 3) * 14, color: '#fff7c2', z: 1, static: true, cls: 'pulse',
            style: { animationDelay: (i * 0.37) + 's', animationDuration: (1.1 + (i % 3) * 0.5) + 's' } }));
        const moon = S.add({ e: '🌙', x: 700, y: 240, s: 200, z: 3, drag: true, lift: false, cls: 'bob',
          tap: talk(S, ['Good night!', "I'm in charge up here."]),
          drop: (o) => {
            if (o.y > 700) morning();
            else S.say(o, o.y > 480 ? 'Lower...' : 'Still night...', 900);
            return true;
          } });
        S.add({ html: A.hills(1000, 330), x: 500, y: 835, z: 5, static: true });
        const house = S.add({ html: A.house(false), x: 300, y: 700, z: 6, tap: talk(S, ['Zzz...', 'Shh! Everyone is asleep.']) });
        const snore = S.add({ text: 'z', x: 360, y: 560, s: 60, color: '#c9c3ff', z: 7, static: true, cls: 'zzz' });
        const rooster = S.add({ e: '🐓', x: 760, y: 730, s: 130, z: 7, tap: talk(S, ["It's still dark!", 'Wake me at sunrise.']) });
        function morning() {
          S.locked = true;
          moon.to({ y: 1100 }, 500);
          GameAudio.play('reveal');
          day.to({ op: 1 }, 1000);
          stars.forEach((s) => s.to({ op: 0 }, 800));
          snore.hide();
          const sun = S.add({ e: '☀️', x: 180, y: 900, s: 220, z: 3, static: true });
          sun.to({ y: 220 }, 1000, 'ease-out');
          S.after(700, () => { house.set({ html: A.house(true) }); rooster.anim('ring', 600); S.say(rooster, 'Cock-a-doodle-doo!'); });
          S.after(1300, () => S.win('Good morning!'));
        }
      },
    },
    // 3
    {
      id: 'count-eggs',
      q: 'How many eggs are there?',
      hint: 'Is the hen hiding something?',
      solution: 'Move the hen. There is one more egg under her, so the answer is 5.',
      setup(S) {
        S.bg('linear-gradient(#c9f0ff 0 58%, #a7dd7f 58%)');
        S.add({ html: A.cloud(200, 110), x: 170, y: 150, z: 1, static: true, cls: 'bob', style: { animationDuration: '3s' } });
        S.add({ e: '🦋', x: 860, y: 190, s: 80, z: 7, cls: 'bob', style: { animationDuration: '1.4s' }, tap: talk(S, ['Flutter!', 'Count carefully!']) });
        let n = 0;
        const count = (o) => { if (!o.data.n) o.data.n = ++n; S.say(o, String(o.data.n), 700); };
        S.add({ html: A.nest(), x: 300, y: 470, z: 2, static: true });
        [200, 270, 340, 410].forEach((x, i) => S.add({ e: '🥚', x, y: 432, s: 90, rot: (i - 1.5) * 8, z: 3, tap: count }));
        S.add({ html: A.nestFront(), x: 300, y: 515, z: 4, static: true });
        S.add({ html: A.nest(), x: 730, y: 560, z: 2, static: true });
        const egg = S.add({ e: '🥚', x: 730, y: 520, s: 90, z: 3, tap: count });
        S.add({ html: A.nestFront(), x: 730, y: 605, z: 4, static: true });
        const check = (o) => { if (S.dist(o, egg) > 150 && first(S, 'found')) S.good(egg, 'An egg!'); };
        S.add({ e: '🐔', x: 730, y: 500, s: 240, z: 6, drag: true, tap: talk(S, ["Bawk! I'm busy!", 'Bawk! Just sitting here.']),
          move: (o) => { if (first(S, 'bawk')) S.say(o, 'Bawk!', 700); check(o); },
          drop: (o) => { check(o); return true; } });
        S.choices(['3', '4', '5', '6'], 2, { size: 72, msg: 'One egg was hiding under the hen!' });
      },
    },
    // 4
    {
      id: 'smallest-dot',
      q: 'Tap the smallest dot[.]',
      hint: 'The smallest dot might not be in the picture.',
      solution: 'Tap the period at the end of the question.',
      setup(S) {
        [[250, 300, 150, '#ff5a5f'], [720, 250, 96, '#3d8bff'], [480, 540, 190, '#ffd23f'], [810, 620, 60, '#22c55e'],
          [230, 730, 80, '#a259ff'], [620, 830, 36, '#ff9f1c'], [400, 230, 22, INK]].forEach(([x, y, d, c], i) => {
          S.add({ html: '', w: d, h: d, x, y, z: 5, cls: 'pulse',
            style: { background: c, borderRadius: '50%', boxShadow: '0 6px 0 rgba(0,0,0,.15)',
              animationDelay: (i * 0.23) + 's', animationDuration: (1.4 + (i % 3) * 0.3) + 's' },
            tap: (o) => S.fail(o, d === 22 ? 'Even smaller!' : '') });
        });
        S.tapWord('.', () => S.win('The question had the smallest dot all along!'));
      },
    },
    // 5
    {
      id: 'wake-cat',
      q: 'Wake up the cat.',
      hint: 'What does a cat love even more than sleeping?',
      solution: 'Drag the fish to the cat.',
      setup(S) {
        room(S, '#ece5ff', '#c9a27a', 780);
        S.add({ html: '', w: 380, h: 90, x: 450, y: 805, z: 2, static: true, style: { background: '#ff9fb8', borderRadius: '50%', boxShadow: `0 0 0 7px ${INK} inset` } });
        const cat = S.add({ html: sleepyCat(), x: 450, y: 708, z: 5, tap: talk(S, ['Purrr... Zzz', 'Five more minutes...', 'Zzz... mice... zzz']) });
        const zs = [0, 0.8, 1.6].map((d, i) => S.add({ text: 'Z', x: 400 + i * 34, y: 600 - i * 22, s: 60 + i * 14, color: '#9d8fe0', z: 6, static: true,
          cls: 'zzz', style: { animationDelay: d + 's' } }));
        const snores = ['Zzz...', 'Zzz... snore...', 'Zzz... too early...'];
        let k = 0;
        S.add({ html: A.shelf(260, 40), x: 190, y: 400, z: 2, static: true });
        S.add({ e: '⏰', x: 190, y: 330, s: 110, z: 4, tap: (o) => { o.anim('ring', 900); GameAudio.play('ring'); S.after(900, () => S.say(cat, snores[k++ % 3])); } });
        S.add({ e: '🥁', x: 860, y: 860, s: 140, z: 4, tap: (o) => { o.anim('pulse', 300); GameAudio.play('boom'); S.after(400, () => S.say(cat, snores[k++ % 3])); } });
        S.add({ html: A.table(300, 130), x: 800, y: 560, z: 2, static: true });
        S.add({ e: '🍽️', x: 800, y: 480, s: 120, z: 3, static: true });
        S.add({ e: '🐟', x: 800, y: 455, s: 100, z: 8, drag: true, tap: (o) => S.say(o, 'Sniff sniff!', 800), drop: (o) => {
          if (!S.near(o, cat, 250)) return true;
          S.locked = true;
          zs.forEach((z) => z.hide());
          cat.hide();
          const awake = S.add({ e: '🐈', x: 450, y: 690, s: 240, sc: 0.7, z: 5, static: true });
          awake.to({ sc: 1 }, 300);
          o.to({ x: 345, y: 700, sc: 0.6 }, 300);
          S.after(150, () => S.say(awake, 'Meow! 😻'));
          S.win('Nothing wakes a cat like a fish!');
          return true;
        } });
      },
    },
    // 6
    {
      id: 'heavier',
      q: 'Which is heavier?',
      hint: 'Read the labels very carefully.',
      solution: '1 kg is 1 kg. They weigh the same!',
      setup(S) {
        S.add({ html: A.balance(), x: 500, y: 380, z: 2, static: true });
        S.add({ html: '1 kg', w: 200, h: 120, s: 58, x: 260, y: 330, z: 4, style: block('#fff'), tap: talk(S, ['So fluffy!', 'Tickly!']) });
        S.add({ html: '1 kg', w: 200, h: 120, s: 58, x: 740, y: 330, z: 4, style: block('#e0704f', { color: '#fff' }), tap: talk(S, ['Solid!', 'Ouch, my toe!']) });
        S.add({ text: 'FEATHERS', x: 260, y: 600, s: 52, z: 4, static: true, color: '#fff' });
        S.add({ text: 'BRICKS', x: 740, y: 600, s: 52, z: 4, static: true, color: '#ff8a65' });
        S.choices(['Feathers', 'Bricks', 'Same'], 2, { size: 56, msg: 'A kilo is a kilo!' });
      },
    },
    // 7 (new) hidden object: just outside the picture
    {
      id: 'find-puppy',
      q: 'Find the puppy.',
      hint: 'Look closely at the edges of the picture.',
      solution: 'Tap the wagging tail at the right edge. The puppy was hiding just outside the picture!',
      setup(S) {
        S.bg('linear-gradient(#bfe9ff 0 55%, #a7dd7f 55%)');
        [130, 390, 650, 910].forEach((x) => S.add({ html: A.fence(), x, y: 500, z: 1, static: true }));
        S.add({ html: A.cloud(220, 120), x: 220, y: 150, z: 1, static: true, cls: 'bob', style: { animationDuration: '3.4s' } });
        // paw prints lead from the dog house to the right edge
        [[455, 790], [570, 750], [685, 800], [790, 760], [890, 800]].forEach(([x, y], i) =>
          S.add({ e: '🐾', x, y, s: 46, rot: 70 + (i % 2) * 20, op: 0.5, z: 2, static: true }));
        S.add({ html: doghouse(), x: 300, y: 640, z: 3, tap: (o) => { o.shake(); S.say(o, first(S, 'house') ? 'Nobody home!' : 'Still empty!', 900); } });
        S.add({ html: dogBowl(), x: 520, y: 880, z: 4, tap: (o) => S.say(o, 'Kibble! But no puppy.', 900) });
        S.add({ html: bush(), x: 700, y: 610, z: 4, drag: true, tap: (o) => S.say(o, 'Rustle rustle...', 800), drop: (o) => { S.say(o, 'Just leaves!', 800); return true; } });
        const tail = S.add({ html: puppyTail(), x: 965, y: 760, z: 5, cls: 'ring',
          style: { animationDuration: '0.32s', transformOrigin: '92% 92%' }, tap: () => found(), drop: () => { found(); return true; }, drag: true });
        const puppy = S.add({ e: '🐕', x: 1140, y: 770, s: 200, z: 6, static: true });
        const found = () => {
          if (!first(S, 'found')) return;
          S.locked = true;
          tail.hide();
          GameAudio.play('reveal');
          puppy.to({ x: 800 }, 600, 'ease-out').then(() => { S.say(puppy, 'Woof! You found me!'); puppy.anim('wobble', 900); });
          S.after(700, () => S.win('Peekaboo! It was just outside the picture.'));
        };
        S.add({ e: '🎾', x: 160, y: 860, s: 80, z: 7, drag: true, tap: (o) => { o.to({ y: 760 }, 160).then(() => o.to({ y: 860 }, 220)); S.say(o, 'Boing!', 600); },
          drop: (o) => { if (o.x > 840) found(); return true; } });
      },
    },
    // 8
    {
      id: 'light-candle',
      q: 'Light the candle.',
      hint: 'A match needs to be struck first.',
      solution: 'Rub the match on the matchbox to light it, then bring the flame to the candle.',
      setup(S) {
        room(S, '#fff0e0', '#d9a875', 780);
        S.add({ html: A.table(760, 160), x: 540, y: 860, z: 2, static: true });
        const wick = { x: 680, y: 452 };
        S.add({ html: A.cake(), x: 680, y: 615, z: 3, tap: talk(S, ['No flame yet!', 'Make a wish... soon!']) });
        const flame = S.add({ html: A.flame(), x: 680, y: 418, z: 4, hidden: true, static: true, cls: 'pulse' });
        const box = S.add({ html: A.matchbox(), x: 290, y: 717, z: 4, tap: talk(S, ['Scratchy!', 'Matches live here.']) });
        const rest = { x: 300, y: 628, rot: -80 };
        // where the match head is (the match is 190 tall, head 29 above its centre)
        const head = (o) => { const a = o.rot * Math.PI / 180; return { x: o.x + 29 * Math.sin(a), y: o.y - 29 * Math.cos(a) }; };
        const light = (o) => {
          if (!first(S, 'lit')) return;
          o.set({ html: A.match(true) });
          GameAudio.play('whoosh');
          S.good(o, 'Fsssh!');
        };
        let rub = 0, last = null;
        S.add({ html: A.match(false), x: rest.x, y: rest.y, rot: rest.rot, z: 8, drag: true,
          tap: (o) => S.say(o, S.state.lit ? 'Careful, hot!' : 'A match!', 800),
          move: (o) => {
            if (o.rot !== -15) o.set({ rot: -15 }); // hold it upright
            if (S.state.lit) return;
            const h = head(o), b = box.rect();
            if (h.x > b.l && h.x < b.r && h.y > b.t - 10 && h.y < b.b) {
              if (last) rub += Math.hypot(h.x - last.x, h.y - last.y);
              last = h;
              if (rub > 110) light(o);
            } else last = null;
          },
          drop: (o) => {
            const h = head(o);
            const d = Math.hypot(h.x - wick.x, h.y - wick.y);
            if (S.state.lit && d < 130) {
              S.locked = true;
              o.set({ drag: false });
              flame.show();
              GameAudio.play('reveal');
              S.win('Happy birthday!');
              return true;
            }
            if (!S.state.lit && S.hits(o, box)) light(o);
            else if (!S.state.lit && d < 170) S.say(o, 'Strike it first!');
            last = null;
            o.to(rest, 300);
            return true;
          } });
      },
    },
    // 9
    {
      id: 'key-under-mat',
      q: 'Open the door.',
      hint: 'People like to hide a spare key close to the door.',
      solution: 'Move the doormat, then drag the key onto the door.',
      setup(S) {
        room(S, '#ffe3b8', '#bcbcc9', 790);
        const knock = talk(S, ['Locked!', 'Still locked!', 'Knock knock... nobody.']);
        const door = S.add({ html: A.houseDoor(false), x: 500, y: 600, z: 2, tap: (o) => { if (S.done) return; o.shake(); GameAudio.play('click'); knock(o); } });
        S.add({ html: doorbell(), x: 680, y: 560, z: 3, tap: (o) => { GameAudio.play('ring'); S.say(o, 'Ding dong! ...nobody home.'); } });
        const mailbox = S.add({ e: '📫', x: 170, y: 690, s: 150, z: 4, tap: talk(S, ['Only bills...', 'No keys in here.']) });
        const key = S.add({ e: '🔑', x: 500, y: 852, s: 62, z: 3, drag: true, tap: (o) => S.say(o, 'Jingle!', 700), drop: (o) => {
          if (S.hits(o, door, -20)) {
            S.locked = true;
            o.hide();
            door.set({ html: A.houseDoor(true) });
            GameAudio.play('unlock');
            S.win('Never hide a key under the mat!');
          } else if (S.near(o, mailbox, 120)) S.say(mailbox, 'Wrong lock!');
          return true;
        } });
        const check = (o) => { if (!S.hits(o, key, -8) && first(S, 'found')) S.good(key, 'A key!'); };
        S.add({ html: A.doormat(320, 90), x: 500, y: 852, z: 4, drag: true, tap: (o) => S.say(o, 'Welcome!', 800), move: check, drop: (o) => { check(o); return true; } });
        S.add({ e: '🌵', x: 830, y: 700, s: 170, z: 4, drag: true, grab: (o) => S.say(o, 'Ouch! Prickly!', 700) });
      },
    },
    // 10
    {
      id: 'half-of-two',
      q: 'What is half of 2 + 2?',
      hint: 'Do the "half of" part first.',
      solution: 'Half of 2 is 1, then 1 + 2 = 3. Type 3.',
      setup(S) {
        const fail = S.fail;
        S.fail = (at, msg) => fail(at, msg || 'Order matters!');
        S.add({ text: '½ of 2 + 2 = ?', x: 500, y: 320, s: 110, z: 4, static: true, color: '#ffd23f' });
        S.add({ e: '🤔', x: 500, y: 150, s: 120, z: 4, cls: 'bob', tap: talk(S, ['Hmm...', 'Think twice!']) });
        S.numpad(3, { y: 600, msg: 'Half of 2 is 1. 1 + 2 = 3!' });
      },
    },
    // 11 (new) lateral-thinking choice
    {
      id: 'rooster-egg',
      q: 'A rooster lays an egg on the roof. Which way does it roll?',
      hint: 'Who lays eggs: hens or roosters?',
      solution: 'Roosters don\'t lay eggs! Tap "No egg!".',
      setup(S) {
        S.bg(SKY);
        S.rect(0, 610, 1000, 400, { background: '#a7dd7f', borderTop: `7px solid ${INK}` }, { z: 1 });
        S.add({ html: A.cloud(220, 120), x: 800, y: 130, z: 1, static: true, cls: 'bob', style: { animationDuration: '3.2s' } });
        S.add({ html: barn(), x: 500, y: 440, z: 2, tap: talk(S, ['A very pointy roof!', 'Moo? No, just a barn.']) });
        const rooster = S.add({ e: '🐓', x: 500, y: 215, s: 140, z: 4, cls: 'wobble', tap: talk(S, ['Cock-a-doodle-doo!', 'I rule this roof!']) });
        S.add({ html: windLines(), x: 290, y: 250, z: 3, static: true, cls: 'bob', style: { animationDuration: '1.2s' } });
        S.add({ e: '🌬️', x: 120, y: 250, s: 130, z: 4, cls: 'pulse', tap: (o) => { GameAudio.play('whoosh'); rooster.anim('ring', 500); S.say(o, 'Whooosh!', 800); } });
        S.add({ e: '🐔', x: 830, y: 600, s: 110, z: 4, tap: talk(S, ['Bawk! Bawk!', "Eggs? That's MY job!"]) });
        S.choices(['⬅️ Left', 'Right ➡️', 'Straight down', 'No egg!'], 3, { cols: 2, h: 120, size: 50, msg: "Roosters don't lay eggs!" });
      },
    },
    // 12
    {
      id: 'press-button',
      q: 'Press the button!',
      hint: "The button you need isn't in the picture.",
      solution: 'Tap the word "button" in the question.',
      setup(S) {
        const spots = [[500, 560], [200, 300], [800, 300], [240, 800], [780, 790], [500, 330], [160, 560], [840, 560]];
        const lines = ['Nope!', 'Too slow!', 'Hehe!', 'Catch me!', 'Not today!', 'Missed!', 'Over here!', 'Wheee!'];
        let cur = 0, last = 0, n = 0;
        const btn = S.add({ html: A.bigButton(), x: 500, y: 560, z: 5, cls: 'bob' });
        const dodge = () => {
          const now = performance.now();
          if (now - last < 200 || S.done) return;
          last = now;
          let next;
          do { next = Math.floor(Math.random() * spots.length); } while (next === cur);
          cur = next;
          GameAudio.play('whoosh');
          btn.to({ x: spots[next][0], y: spots[next][1] }, 220, 'ease-out');
          S.after(230, () => S.say(btn, lines[n++ % lines.length], 700));
        };
        btn.body.addEventListener('pointerdown', dodge);
        btn.body.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') dodge(); });
        S.tapWord('button', () => { btn.cls('bob', false); btn.to({ sc: 0.85 }, 150); GameAudio.play('click'); S.win('Sometimes the answer is right in the question!'); });
      },
    },
    // 13
    {
      id: 'pop-balloons',
      q: 'Pop all the balloons.',
      hint: 'One balloon is hiding.',
      solution: 'Pop the 5 you can see, then drag the big cloud away to find the last one.',
      setup(S) {
        S.bg(SKY);
        let popped = 0;
        const balloons = [];
        const pop = (o) => {
          if (o.data.p) return;
          o.data.p = true;
          GameAudio.play('pop');
          S.good(o, 'Pop!');
          o.set({ e: '💥' });
          o.cls('bob', false);
          o.to({ sc: 1.4, op: 0 }, 300).then(() => o.remove());
          popped++;
          if (popped === 6) S.after(350, () => S.win('One was hiding behind the cloud!'));
          else if (popped === 5 && !balloons[5].data.p) S.every(2600, () => { if (!S.state.seen && !S.done) big.anim('wobble', 1300); });
        };
        // the last one hides in the middle of the big cloud: keep it small, pad its tap area
        [[180, 330, 0], [420, 210, 140], [300, 650, 220], [620, 580, 60], [860, 720, 280], [730, 290, 180]].forEach(([x, y, hue], i) => {
          const hidden = i === 5;
          balloons.push(S.add({ e: '🎈', x, y, s: hidden ? 66 : 110, z: 5, cls: hidden ? '' : 'bob',
            style: { '--f': `hue-rotate(${hue}deg)`, animationDelay: (i * 0.3) + 's', padding: hidden ? '26px' : '0' }, tap: pop }));
        });
        const hiddenOne = balloons[5];
        const reveal = () => { if (!hiddenOne.data.p && !S.hits(big, hiddenOne, -10) && first(S, 'seen')) S.say(hiddenOne, 'Eep!', 900); };
        const big = S.add({ html: A.cloud(440, 270), x: 730, y: 280, z: 8, drag: true, move: reveal, drop: () => { reveal(); return true; } });
        S.add({ html: A.cloud(240, 140), x: 230, y: 470, z: 8, drag: true, drop: (o) => { S.say(o, 'Just fluff!', 800); return true; } });
        S.add({ html: A.hills(1000, 220, '#7fd36a'), x: 500, y: 900, z: 2, static: true });
      },
    },
    // 14
    {
      id: 'elephant-fridge',
      q: 'Put the elephant in the fridge.',
      hint: 'It only takes three steps.',
      solution: 'Tap the fridge to open it, drag the elephant inside, then tap the door to close it.',
      setup(S) {
        room(S, '#dff6ea', '#e2b07a', 750);
        const F = fridge(S, 650, 520);
        fridgeSnacks(S);
        const home = { x: 240, y: 630 };
        S.add({ e: '🐘', x: home.x, y: home.y, s: 240, z: 8, drag: true, tap: talk(S, ['Toot!', 'I fit. Trust me!']), drop: (o) => {
          if (F.isOver(o)) {
            if (!F.open) { S.say(F.door, "It's closed!"); o.to({ x: home.x, y: home.y, sc: 1 }, 350); return true; }
            S.state.inside = true;
            o.set({ z: 4 });
            o.to({ x: 650, y: 590, sc: 0.55 }, 300);
            if (first(S, 'in')) S.good({ x: 650, y: 560 }, 'In you go!');
            return true;
          }
          S.state.inside = false;
          o.set({ z: 8 });
          o.to({ sc: 1 }, 200);
          return true;
        } });
        F.onToggle = (open) => {
          if (open && first(S, 'opened')) S.good(F.door, 'Open!');
          if (!open && S.state.inside) S.win('Open, put it in, close. Easy!');
        };
      },
    },
    // 15
    {
      id: 'giraffe-fridge',
      q: 'Put the giraffe in the fridge.',
      hint: "The fridge isn't empty from last time.",
      solution: 'Open the fridge, take the elephant out, put the giraffe in, then close the door.',
      setup(S) {
        room(S, '#dff6ea', '#e2b07a', 750);
        const F = fridge(S, 650, 520);
        fridgeSnacks(S);
        const inside = { ele: true, gir: false };
        const homes = { ele: [210, 650], gir: [230, 600] };
        const fit = { ele: [650, 590, 0.55], gir: [650, 560, 0.5] };
        const sendHome = (key, o) => { inside[key] = false; o.set({ z: 8 }); o.to({ x: homes[key][0], y: homes[key][1], sc: 1 }, 350); };
        const drop = (key) => (o) => {
          const other = key === 'ele' ? 'gir' : 'ele';
          if (F.isOver(o)) {
            if (!F.open) { S.say(F.door, "It's closed!"); sendHome(key, o); return true; }
            if (inside[other]) { S.say(F.door, 'No room!'); sendHome(key, o); return true; }
            inside[key] = true;
            o.set({ z: 4 });
            o.to({ x: fit[key][0], y: fit[key][1], sc: fit[key][2] }, 300);
            if (key === 'gir' && first(S, 'girIn')) S.good({ x: 650, y: 540 }, 'Squeeze!');
            return true;
          }
          const was = inside[key];
          inside[key] = false;
          o.set({ z: 8 });
          o.to({ sc: 1 }, 200);
          if (key === 'ele' && was && first(S, 'eleOut')) S.good(o, 'Out you come!');
          return true;
        };
        const ele = S.add({ e: '🐘', x: 650, y: 590, s: 240, sc: 0.55, z: 4, drag: true, tap: talk(S, ['Toot! Still here!', 'Brr! Let me out!']), drop: drop('ele') });
        S.add({ e: '🦒', x: 230, y: 600, s: 280, z: 8, drag: true, tap: talk(S, ['Long neck, big dreams!', 'Is it cold in there?']), drop: drop('gir') });
        F.onToggle = (open) => {
          if (open && inside.ele && first(S, 'peek')) S.after(250, () => S.say(ele, 'Toot! Still here!'));
          if (!open && inside.gir && !inside.ele) S.win('Out with the elephant, in with the giraffe!');
        };
      },
    },
    // 16
    {
      id: 'lion-party',
      q: "One animal missed the lion's birthday party. Who?",
      hint: 'Think about the last level.',
      solution: 'The giraffe. It is still in the fridge!',
      setup(S) {
        S.add({ text: 'HAPPY BIRTHDAY!', x: 500, y: 80, s: 64, z: 3, static: true, color: '#ff6b6b' });
        [[70, 170, 0], [930, 170, 200], [90, 430, 120]].forEach(([x, y, hue], i) =>
          S.add({ e: '🎈', x, y, s: 90, z: 2, static: true, cls: 'bob', style: { '--f': `hue-rotate(${hue}deg)`, animationDelay: (i * 0.5) + 's' } }));
        S.add({ e: '🦁', x: 500, y: 330, s: 210, z: 4, cls: 'bob', tap: talk(S, ['Roar! Thanks for coming!', 'Who wants cake?']) });
        S.add({ e: '👑', x: 500, y: 195, s: 90, z: 5, static: true, cls: 'bob' });
        S.add({ e: '🎂', x: 500, y: 540, s: 140, z: 4, tap: (o) => S.say(o, 'Not yet! Wait for everyone.', 1000) });
        [['🐒', 170, 300, 150, 'Ooh ooh! Cake!'], ['🐊', 830, 300, 160, 'Snap! Best party ever!'], ['🐧', 160, 560, 140, 'Cool party!'],
          ['🐘', 840, 560, 170, 'Phew! I got out of the fridge!'], ['🐻', 320, 650, 120, 'Honey cake?'], ['🦓', 680, 650, 130, 'Stripes are in!']]
          .forEach(([e, x, y, s, line]) => S.add({ e, x, y, s, z: 4, tap: (o) => { o.anim('wobble', 600); S.say(o, line, 1100); } }));
        S.add({ e: '🎉', x: 500, y: 690, s: 80, z: 4, tap: (o) => { GameAudio.play('pop'); Engine.burst(o.x, o.y - 40, 14, 220); } });
        S.choices(['🐘', '🦒', '🐊', '🐒'], 1, { size: 90, msg: 'The giraffe is still in the fridge!' });
      },
    },
    // 17
    {
      id: 'croc-river',
      q: 'Cross the river full of crocodiles.',
      hint: 'Where are all the animals today?',
      solution: 'Just swim across! The crocodiles are all at the lion\'s party.',
      setup(S) {
        S.bg('#a7dd7f');
        S.rect(0, 0, 1000, 310, { background: '#bfe9ff' }, { z: 0 });
        S.rect(0, 210, 1000, 100, { background: '#a7dd7f', borderTop: `7px solid ${INK}` }, { z: 1 });
        S.add({ html: A.river(1000, 290), x: 500, y: 455, z: 2, static: true });
        [[150, 400], [620, 530], [880, 380]].forEach(([x, y], i) =>
          S.add({ e: '🍃', x, y, s: 50, z: 3, static: true, cls: 'bob', style: { animationDelay: (i * 0.6) + 's' } }));
        S.add({ e: '🚩', x: 520, y: 200, s: 130, z: 3, cls: 'wobble', tap: (o) => S.say(o, 'Over here!', 800) });
        S.add({ html: A.sign('⚠ CROCS!', 300, 220), x: 820, y: 760, z: 3, tap: talk(S, ['Danger! Crocs!', '...but where are they?']) });
        const quiet = ['So quiet...', 'Not a croc in sight.'];
        let q = 0;
        S.onBgTap = (p) => { if (p.y > 320 && p.y < 590) S.toast(quiet[q++ % 2], p.x, p.y, 900); };
        S.add({ html: A.boat(), x: 210, y: 690, z: 5, drag: true, tap: (o) => S.say(o, 'A leaky old boat.', 900), drop: (o) => {
          if (o.y > 320 && o.y < 600) {
            o.set({ drag: false });
            S.say(o, 'It had a hole!');
            GameAudio.play('splash');
            o.to({ y: o.y + 50, op: 0 }, 900).then(() => o.remove());
          }
          return true;
        } });
        S.add({ e: '🚶', x: 430, y: 820, s: 150, z: 8, drag: true, tap: talk(S, ['Crocs? Gulp...', 'I can swim, you know.']),
          move: (o) => o.set({ e: o.y > 320 && o.y < 600 ? '🏊' : '🚶' }),
          drop: (o) => {
            if (o.y <= 320) { S.locked = true; S.win("The crocodiles are all at the lion's party! 🦁🎉"); }
            else if (o.y < 600) S.say(o, first(S, 'swam') ? 'Hey... no crocs?!' : 'Splash!', 900);
            return true;
          } });
      },
    },
    // 18
    {
      id: 'month-28-days',
      q: 'Tap every month that has 28 days.',
      hint: 'Does any month have fewer than 28 days?',
      solution: 'Every month has at least 28 days, so tap all 12 months.',
      setup(S) {
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        let picked = 0;
        const toggle = (o) => {
          if (S.done) return;
          o.data.on = !o.data.on;
          o.body.style.background = o.data.on ? '#b9e85a' : '#fff';
          if (o.data.on) { picked++; S.good(o, o.data.m === 'FEB' ? '28!' : 'Has day 28!'); } else picked--;
          if (picked === 12) { S.locked = true; S.after(300, () => S.win('Every month has at least 28 days!')); }
        };
        months.forEach((m, i) => S.add({ html: calTile(m), w: 200, h: 150, s: 58, x: 162 + (i % 4) * 225, y: 200 + Math.floor(i / 4) * 180, z: 5,
          data: { m, on: false }, style: block('#fff', { position: 'relative', overflow: 'hidden', borderRadius: '24px' }), tap: toggle }));
        S.add({ html: 'DONE', cls: 'choice', w: 380, h: 130, s: 64, x: 500, y: 850, z: 50, tap: (o) => {
          if (S.done) return;
          if (!picked) S.say(o, 'Tap some months first!', 1000);
          else S.fail(o, 'Look again!');
        } });
      },
    },
    // 19 (new) multi-step physical logic
    {
      id: 'fill-bathtub',
      q: 'Fill the bathtub.',
      hint: 'Where is all the water going?',
      solution: 'Drag the plug into the drain hole, then tap the tap to turn the water on.',
      setup(S) {
        S.bg('repeating-linear-gradient(90deg, #bcdcf2 0 6px, transparent 6px 100px), repeating-linear-gradient(0deg, #bcdcf2 0 6px, #e6f5ff 6px 100px)');
        floor(S, 830, '#9cc3d6');
        const drain = { x: 680, y: 622 };
        S.add({ html: towel(), x: 860, y: 330, z: 2, tap: talk(S, ['Fluffy!', 'Dry... for now.']) });
        S.add({ html: bathtub(), x: 520, y: 700, z: 2, tap: talk(S, ['Empty!', 'Needs water!']) });
        const swirl = S.add({ e: '🌀', x: drain.x, y: drain.y, s: 46, z: 4, hidden: true, static: true, cls: 'ring' });
        const water = S.add({ html: '', w: 556, h: 54, x: 520, y: 621, z: 5, op: 0, static: true, style: { background: '#5ec8ff', borderRadius: '27px' } });
        const stream = S.add({ html: '', w: 24, h: 104, x: 390, y: 562, z: 6, hidden: true, static: true,
          style: { background: '#5ec8ff', borderRadius: '12px', boxShadow: `0 0 0 5px ${INK} inset` } });
        S.add({ e: '🧴', x: 770, y: 546, s: 80, z: 3, tap: (o) => S.say(o, 'Bubbles later!', 900) });
        const duck = S.add({ e: '🦆', x: 880, y: 900, s: 90, z: 7, drag: true, tap: (o) => { GameAudio.play('bubble'); S.say(o, 'Quack!', 700); },
          drop: (o) => {
            S.state.duckIn = o.x > 250 && o.x < 790 && o.y > 540 && o.y < 700;
            if (S.state.duckIn) { o.to({ y: 600 }, 200); if (!S.state.full) S.say(o, 'Quack? No water!', 900); }
            return true;
          } });
        const fill = () => {
          if (!first(S, 'full')) return;
          S.locked = true;
          swirl.hide();
          GameAudio.play('splash');
          water.to({ op: 0.92 }, 1400);
          if (S.state.duckIn) S.after(800, () => duck.to({ y: 595 }, 300).then(() => duck.cls('bob', true)));
          S.after(1500, () => {
            stream.hide();
            S.say(duck, 'Quack quack!', 900);
            S.win('Plug first, then water!');
          });
        };
        S.add({ html: bathFaucet(), x: 330, y: 470, z: 3, tap: () => {
          if (S.state.full) return;
          S.state.on = !S.state.on;
          GameAudio.play(S.state.on ? 'splash' : 'click');
          stream[S.state.on ? 'show' : 'hide']();
          if (!S.state.on) { swirl.hide(); return; }
          if (S.state.plug) { S.good(stream, 'Filling!'); fill(); return; }
          swirl.show();
          S.after(700, () => { if (S.state.on && !S.state.plug) S.toast('Glug glug glug...', drain.x, drain.y - 50, 1200); });
        } });
        S.add({ html: bathPlug(), x: 150, y: 900, z: 8, drag: true, tap: (o) => S.say(o, 'A rubber plug.', 900), drop: (o) => {
          const d = Math.hypot(o.x - drain.x, o.y - drain.y);
          if (d < 85) {
            S.state.plug = true;
            o.set({ drag: false, z: 3, tap: null });
            o.to({ x: drain.x, y: drain.y - 10, sc: 0.6 }, 250);
            swirl.hide();
            S.good(o, 'Plugged!');
            if (S.state.on) fill();
          } else if (d < 230) S.say(o, 'Almost!', 700);
          return true;
        } });
      },
    },
    // 20 (new) question-word trick
    {
      id: 'thirsty-fish',
      q: 'The fish needs water!',
      hint: 'There is no water in the picture... look outside it.',
      solution: 'Drag the word "water" from the question into the fishbowl.',
      setup(S) {
        room(S, '#fff4e0', '#d9a875', 780);
        S.add({ html: A.windowFrame(260, 230), x: 190, y: 290, z: 2, tap: talk(S, ['Not a cloud in the sky.', 'No rain today!']) });
        S.add({ html: A.table(420, 160), x: 400, y: 860, z: 2, static: true });
        const bowl = S.add({ html: fishbowl(), x: 400, y: 635, z: 4, tap: talk(S, ['Bone dry!', 'Not a drop!']) });
        const fish = S.add({ e: '🐟', x: 400, y: 738, s: 100, z: 5, cls: 'wobble', tap: talk(S, ['Blub... water!', 'Gasp... blub...']) });
        S.after(500, () => S.say(fish, 'Blub... water!', 1300));
        S.every(1500, () => { if (!S.state.full) fish.to({ y: 700 }, 160).then(() => { if (!S.state.full) fish.to({ y: 738 }, 220); }); });
        S.add({ html: kitchenCounter(), x: 800, y: 770, z: 2, static: true });
        const drip = () => {
          const d = S.add({ e: '💧', x: 810, y: 600, s: 36, z: 3, static: true });
          d.to({ y: 662, op: 0 }, 600).then(() => d.remove());
        };
        S.add({ html: sinkTap(), x: 780, y: 595, z: 3, tap: (o) => { GameAudio.play('click'); drip(); S.say(o, first(S, 'tap') ? 'Drip... broken!' : 'Still broken!', 900); } });
        const nearBowl = (o) => S.near(o, bowl, 230);
        S.add({ e: '🥛', x: 690, y: 612, s: 90, z: 6, drag: true, back: true, tap: (o) => S.say(o, 'Milk!', 700),
          drop: (o) => { if (nearBowl(o)) S.say(fish, 'Milk? Blub, no!'); return false; } });
        S.add({ e: '🍉', x: 905, y: 615, s: 90, z: 6, drag: true, back: true, tap: (o) => S.say(o, 'Juicy!', 700),
          drop: (o) => { if (nearBowl(o)) S.say(fish, 'Water... melon? Nope!'); return false; } });
        const fill = () => {
          S.state.full = true;
          S.locked = true;
          const w = bowl.body.querySelector('.fw-water');
          if (w) w.style.transform = 'translateY(-215px)';
          GameAudio.play('splash');
          fish.cls('wobble', false);
          fish.to({ y: 640, rot: 0 }, 900).then(() => fish.cls('bob', true));
          S.after(900, () => { S.say(fish, 'Blub! Thank you!'); S.win('The water was in the question!'); });
        };
        S.dragWord('water', (w, p) => {
          if (S.state.full) return false;
          if (Math.hypot(p.x - 400, p.y - 640) > 230) { S.toast('Into the bowl!', p.x, p.y, 900); return false; }
          fill();
          return true;
        });
        S.tapWord('water', () => { const d = S.add({ e: '💧', x: 500, y: 20, s: 50, z: 30, static: true }); d.to({ y: 140, op: 0 }, 700).then(() => d.remove()); });
      },
    },
    // 21
    {
      id: 'snowman-summer',
      q: 'Help the snowman survive the summer.',
      hint: 'Where is it cold even in summer?',
      solution: 'Drag the snowman to the top of the snowy mountain.',
      setup(S) {
        S.bg('linear-gradient(#ffd98a, #fff3d0)');
        const mountain = S.add({ html: A.svg(460, 400, `
          <path d="M10 395 L230 20 L450 395z" fill="#8e86b8" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
          <path d="M150 156 L230 20 L310 156 L275 140 L245 170 L210 138 L180 165z" fill="#fff" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>`),
          x: 740, y: 560, z: 2, tap: (o) => S.say(o, 'So tall!', 800) });
        floor(S, 760, '#f2d48b');
        S.add({ e: '☀️', x: 190, y: 170, s: 200, z: 3, cls: 'pulse', drag: true, back: true, drop: (o) => { S.say(o, 'Too hot to move!'); return false; } });
        const puddle = S.add({ html: '', w: 220, h: 50, x: 330, y: 830, z: 3, static: true, style: { background: '#8fd3ff', borderRadius: '50%', boxShadow: `0 0 0 5px ${INK} inset` } });
        const sweat = S.add({ e: '💦', x: 450, y: 560, s: 60, z: 9, static: true, cls: 'bob' });
        const snow = S.add({ e: '☃️', x: 330, y: 650, s: 270, z: 8, drag: true, tap: talk(S, ["I'm melting!", 'So... hot...']),
          move: () => sweat.hide(),
          drop: (o) => {
            if (S.over(o, mountain, 10)) {
              S.locked = true;
              o.set({ drag: false });
              o.to({ x: 740, y: 300, sc: 0.42 }, 400);
              puddle.hide();
              S.after(450, () => S.say(o, 'Brrr! Perfect!'));
              S.win('It is always winter on the mountain top!');
            } else {
              sweat.set({ x: o.x + 120, y: o.y - 90 }).show();
              S.say(o, 'Still melting!', 800);
            }
            return true;
          } });
        // slowly melting (set, not to: a transition would make the snowman lag while dragged)
        S.every(1200, () => { if (!S.done) { puddle.to({ sc: Math.min(1.6, puddle.sc + 0.05) }, 400); snow.set({ sc: Math.max(0.86, snow.sc - 0.01) }); } });
        S.add({ e: '⛱️', x: 140, y: 820, s: 170, z: 7, drag: true, drop: (o) => { if (S.near(o, snow, 260)) S.say(snow, 'Still melting!'); return true; } });
      },
    }
  );
})();

// ---- js/levels-2.js ----
// Part 2 of the level list (follows js/levels-1.js; the numbers below assume part 1 has 21 levels).
// Each level: { id, q, hint, solution, setup(S) }. setup builds the scene with the engine API (engine.js).
// 'safe-code' must stay the very last level of the game: its code is its own level number.
(function () {
  const { A, INK, SKY, floor, room, block } = window.LevelKit;

  // ---------- helpers used only by this file ----------
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // Art.cloud only draws correctly at its default size; this one stretches to fill any box.
  const cloudArt = (w, h, color = '#ffffff') =>
    `<svg width="${w}" height="${h}" viewBox="0 0 260 150" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M50 130 a40 40 0 0 1 10 -78 a60 60 0 0 1 110 -20 a46 46 0 0 1 70 50 a34 34 0 0 1 -10 48z" fill="${color}" ` +
    `stroke="${INK}" stroke-width="7" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;

  // jump up and land again
  function hop(o, h, ms = 560) {
    if (o.data.hopping) return;
    o.data.hopping = true;
    const y = o.y;
    o.to({ y: y - h }, ms * 0.45, 'cubic-bezier(.2,.8,.4,1)')
      .then(() => o.to({ y }, ms * 0.55, 'cubic-bezier(.6,0,.9,.5)'))
      .then(() => { o.data.hopping = false; });
  }

  // a character that keeps talking until the level is solved
  function chatter(S, o, lines, every = 4500, first = 500) {
    let i = 0;
    const talk = () => { if (!S.done && o.isShown()) S.say(o, lines[i++ % lines.length], 1300); };
    S.after(first, talk);
    S.every(every, talk);
  }

  // twinkling background sparkles that answer when tapped
  function twinkles(S, pts, color, lines) {
    return pts.map(([x, y], i) => S.add({ text: '✦', x, y, s: 26 + (i % 3) * 10, color, z: 1, cls: 'pulse',
      style: { animationDelay: (i * 0.37).toFixed(2) + 's', padding: '14px' },
      tap: (o) => S.say(o, pick(lines), 900) }));
  }

  // floating Z Z Z
  const snore = (S, x, y, color = '#7a6fb0', z = 6) => [0, 0.8, 1.6].map((d, i) =>
    S.add({ text: 'Z', x: x + i * 30, y: y - i * 20, s: 50 + i * 12, color, z, static: true, cls: 'zzz', style: { animationDelay: d + 's' } }));

  // ---------- SVG props used only by this file ----------
  const remoteArt = A.svg(90, 180, `<rect x="6" y="6" width="78" height="168" rx="24" fill="#4b4570" stroke="${INK}" stroke-width="6"/>
    <circle cx="45" cy="40" r="14" fill="#e5484d"/><rect x="24" y="74" width="42" height="14" rx="6" fill="#b9b2cf"/>
    <rect x="24" y="100" width="42" height="14" rx="6" fill="#b9b2cf"/><rect x="24" y="126" width="42" height="14" rx="6" fill="#b9b2cf"/>`);
  const iglooArt = A.svg(240, 140, `
    <path d="M10 134 Q10 10 120 10 Q230 10 230 134z" fill="#f4f9ff" stroke="${INK}" stroke-width="7"/>
    <path d="M30 96 h180 M18 60 h204 M70 14 v46 M170 14 v46 M120 60 v36 M60 96 v38 M180 96 v38" stroke="#b9cfe4" stroke-width="5"/>
    <path d="M92 134 V102 a28 28 0 0 1 56 0 V134z" fill="#3a3466" stroke="${INK}" stroke-width="6"/>`);
  // a polar bear peeking out of the snow: nearly invisible until found (seen = outlined)
  const polarBear = (seen, blink = false) => {
    const line = seen ? INK : '#f3f6fa';
    const sw = seen ? 7 : 4;
    const eye = (cx) => (blink ? `<path d="M${cx - 10} 100 h20" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` : `<circle cx="${cx}" cy="100" r="10" fill="${INK}"/>`);
    return A.svg(280, 200, `
      <circle cx="74" cy="50" r="26" fill="#fdfeff" stroke="${line}" stroke-width="${sw}"/>
      <circle cx="206" cy="50" r="26" fill="#fdfeff" stroke="${line}" stroke-width="${sw}"/>
      <circle cx="140" cy="116" r="84" fill="#fdfeff" stroke="${line}" stroke-width="${sw}"/>
      ${eye(110)}${eye(170)}
      <ellipse cx="140" cy="132" rx="18" ry="13" fill="${INK}"/>
      <path d="M140 146 v10 M126 160 q14 11 28 0" stroke="${seen ? INK : '#e2e9f1'}" stroke-width="5" fill="none" stroke-linecap="round"/>
      ${seen ? '' : '<rect x="0" y="176" width="280" height="30" fill="#fdfeff"/>'}`);
  };
  // a crescent moon shaped exactly like a C (emoji moons face different ways on different systems)
  const moonArt = A.svg(130, 180, `<path d="M110 22 A70 70 0 1 0 110 158 A80 80 0 0 1 110 22 Z" fill="#ffe066" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
    <circle cx="52" cy="70" r="7" fill="#f2c94c"/><circle cx="44" cy="112" r="9" fill="#f2c94c"/>`);
  const paperArt = A.svg(580, 560, `<rect x="6" y="6" width="568" height="548" rx="16" fill="#fff" stroke="${INK}" stroke-width="7"/>
    ${[120, 190, 260, 330, 400, 470].map((y) => `<line x1="12" y1="${y}" x2="568" y2="${y}" stroke="#cfe3ff" stroke-width="4"/>`).join('')}
    <line x1="80" y1="10" x2="80" y2="550" stroke="#ff9b9b" stroke-width="5"/>`);
  const boardArt = A.svg(920, 470, `
    <rect x="6" y="6" width="908" height="430" rx="22" fill="#b5713c" stroke="${INK}" stroke-width="7"/>
    <rect x="32" y="32" width="856" height="378" rx="10" fill="#2f6b4f" stroke="${INK}" stroke-width="5"/>
    <path d="M90 366 q80 -24 160 0 M610 84 q80 -20 160 4" stroke="#4d8a6b" stroke-width="10" fill="none" stroke-linecap="round"/>
    <rect x="180" y="428" width="560" height="34" rx="12" fill="#c9824a" stroke="${INK}" stroke-width="6"/>`);
  const chalkArt = A.svg(200, 46, `<rect x="6" y="8" width="188" height="30" rx="15" fill="#fff" stroke="${INK}" stroke-width="6"/>`);
  const lakeArt = A.svg(380, 170, `<ellipse cx="190" cy="85" rx="180" ry="76" fill="#3fa9ff" stroke="${INK}" stroke-width="7"/>
    <path d="M90 66 q20 -14 40 0 q20 14 40 0 M200 108 q20 -14 40 0 q20 14 40 0" stroke="#bfe6ff" stroke-width="7" fill="none" stroke-linecap="round"/>`);
  const logsArt = A.svg(250, 100, `
    <rect x="16" y="36" width="218" height="32" rx="16" fill="#a8743f" stroke="${INK}" stroke-width="7" transform="rotate(-10 125 52)"/>
    <rect x="16" y="36" width="218" height="32" rx="16" fill="#c08850" stroke="${INK}" stroke-width="7" transform="rotate(10 125 52)"/>
    <circle cx="28" cy="84" r="13" fill="#9aa1ad" stroke="${INK}" stroke-width="5"/><circle cx="222" cy="84" r="13" fill="#9aa1ad" stroke="${INK}" stroke-width="5"/>`);
  const leakyBucket = (full) => A.svg(150, 160, `
    <path d="M28 22 q47 -34 94 0" fill="none" stroke="${INK}" stroke-width="6"/>
    <path d="M16 32 h118 l-16 108 h-86z" fill="#9aa9b8" stroke="${INK}" stroke-width="7"/>
    ${full ? `<ellipse cx="75" cy="36" rx="56" ry="10" fill="#3fa9ff" stroke="${INK}" stroke-width="5"/>` : ''}
    <circle cx="58" cy="104" r="9" fill="${INK}"/>
    ${full ? '<path d="M58 118 v30" stroke="#3fa9ff" stroke-width="8" stroke-linecap="round"/>' : ''}`);
  const paintingArt = A.svg(300, 260, `
    <rect x="6" y="6" width="288" height="248" rx="12" fill="#e0a95f" stroke="${INK}" stroke-width="7"/>
    <rect x="30" y="30" width="240" height="200" rx="6" fill="#9fdcff" stroke="${INK}" stroke-width="5"/>
    <circle cx="200" cy="82" r="26" fill="#ffd23f" stroke="${INK}" stroke-width="5"/>
    <path d="M33 196 Q100 112 160 170 Q210 124 267 178 V227 H33z" fill="#5fbf4a" stroke="${INK}" stroke-width="5"/>`);

  window.LEVELS.push(
    // 22
    {
      id: 'feed-baby',
      q: 'Feed the baby.',
      hint: 'The bottle is empty. Where does milk come from?',
      solution: 'Drag the bottle to the cow to fill it, then give it to the baby.',
      setup(S) {
        S.bg('linear-gradient(#bfe9ff 0 58%, #a7dd7f 58%)');
        S.add({ html: cloudArt(230, 120), x: 170, y: 150, z: 1, static: true, cls: 'bob' });
        S.add({ e: '🦋', x: 520, y: 230, s: 80, z: 3, cls: 'bob', style: { animationDuration: '1.3s' },
          tap: (o) => { S.say(o, 'Flap flap!', 900); o.to({ x: 380 + Math.random() * 260, y: 150 + Math.random() * 160 }, 600); } });
        S.add({ html: A.fence(), x: 790, y: 560, z: 2, static: true });
        const cow = S.add({ e: '🐄', x: 780, y: 520, s: 220, z: 4,
          tap: (o) => { o.anim('wobble', 900); S.say(o, S.state.full ? 'Moo! Enjoy!' : 'Moo?'); } });
        S.add({ html: '', w: 320, h: 120, x: 230, y: 690, z: 3, static: true, style: { background: '#ffd0e0', borderRadius: '40px', boxShadow: `0 0 0 7px ${INK} inset` } });
        const baby = S.add({ e: '👶', x: 230, y: 590, s: 200, z: 4, cls: 'wobble', tap: (o) => S.say(o, pick(['Waaah! Hungry!', 'Waaah! 🍼'])) });
        chatter(S, baby, ['Waaah!', 'Hungry! Waaah!', 'Waaah! 🍼'], 4200, 400);
        S.add({ e: '🧸', x: 450, y: 880, s: 120, z: 7, drag: true,
          drop: (o) => { if (S.near(o, baby, 220)) S.say(baby, 'Teddy! ...still hungry!'); return true; } });
        S.add({ html: A.bottle(false), x: 620, y: 830, z: 8, drag: true, drop: (o) => {
          if (!S.state.full && S.near(o, cow, 200)) {
            S.state.full = true;
            o.set({ html: A.bottle(true) });
            S.say(cow, 'Moo!');
            S.good(o, 'Milk!');
          } else if (S.near(o, baby, 220)) {
            if (!S.state.full) { S.say(baby, "It's empty! Waaah!"); return true; }
            o.set({ drag: false });
            baby.cls('wobble', false);
            o.to({ x: baby.x + 90, y: baby.y + 20, rot: -35 }, 250);
            S.say(baby, 'Yum! 😊');
            S.win('Fresh milk!');
          }
          return true;
        } });
      },
    },
    // 23
    {
      id: 'monkey-banana',
      q: 'Give the monkey a banana.',
      hint: 'Give the tree a few good shakes.',
      solution: 'Tap the palm tree three times until the banana falls, then drag the banana to the monkey.',
      setup(S) {
        S.bg('linear-gradient(#bff0d0, #ecfff3)');
        S.add({ html: cloudArt(230, 120), x: 190, y: 160, z: 1, static: true, cls: 'bob' });
        floor(S, 820, '#7fc45e');
        let shakes = 0;
        const feed = (food) => {
          food.set({ drag: false, tap: null });
          food.to({ x: monkey.x + 70, y: monkey.y - 10, sc: 0.7 }, 250);
          S.say(monkey, 'Yum yum! 😋');
          S.win('A good shake does the trick!');
        };
        const monkey = S.add({ e: '🐒', x: 220, y: 740, s: 210, z: 6, drag: true, back: true,
          tap: (o) => { hop(o, 60, 400); S.say(o, pick(['Ooh ooh! 🍌', 'Banana please!', 'Ooh ooh aah!'])); },
          drop: (o) => {
            if (S.state.fell && S.near(o, banana, 180)) { o.set({ drag: false }); feed(banana); return true; }
            S.say(o, S.near(o, tree, 280) ? 'Too lazy to climb! 😴' : 'Ooh?', 1000);
            return false;
          } });
        const banana = S.add({ e: '🍌', x: 610, y: 330, s: 100, z: 5, tap: (o) => S.say(o, 'Too high!', 900),
          drop: (o) => { if (S.near(o, monkey, 230)) feed(o); else S.say(monkey, 'Over here! 🙌', 900); return true; } });
        const tree = S.add({ e: '🌴', x: 650, y: 520, s: 560, z: 3, tap: (o) => {
          o.anim('ring', 500);
          GameAudio.play('whoosh');
          if (S.state.fell) { S.say(o, 'No more bananas!', 900); return; }
          banana.anim('ring', 500);
          shakes++;
          if (shakes === 1) S.toast('Rustle rustle...', 650, 230, 900);
          else if (shakes === 2) coconut();
          else if (shakes === 3) {
            S.state.fell = true;
            banana.to({ y: 860, rot: 80 }, 700, 'cubic-bezier(.5,0,.8,.6)').then(() => {
              GameAudio.play('drop');
              banana.set({ drag: true, tap: () => S.say(monkey, 'Gimme! 🙌', 900) });
              S.good(banana, 'Banana!');
            });
          }
        } });
        function coconut() {
          const c = S.add({ e: '🥥', x: 720, y: 330, s: 90, z: 5, tap: (o) => S.say(o, 'Bonk!', 700),
            drop: (o) => { if (S.near(o, monkey, 230)) { S.say(monkey, "That's a coconut! 🙄"); o.to({ x: 840, y: 880 }, 350); } return true; } });
          c.to({ x: 840, y: 880, rot: 200 }, 750, 'cubic-bezier(.5,0,.8,.6)').then(() => {
            GameAudio.play('drop');
            c.set({ drag: true });
            S.say(monkey, 'Not a banana!', 1000);
          });
        }
      },
    },
    // 24
    {
      id: 'find-ghost',
      q: 'Find the ghost.',
      hint: 'Ghosts only come out in the dark.',
      solution: 'Tap the light switch to turn off the light, then tap the ghost.',
      setup(S) {
        room(S, '#f6e2c2', '#c99a6b', 780);
        const lamp = S.add({ html: '', x: 480, y: 130, z: 2, tap: () => toggle() });
        const setLamp = (on) => {
          lamp.set({ html: A.lamp(on) });
          // the light cone spills outside the lamp: keep it from catching taps meant for the room
          lamp.body.querySelectorAll('path[opacity]').forEach((p) => { p.style.pointerEvents = 'none'; });
        };
        setLamp(true);
        const spooky = (o) => S.say(o, pick(['Brrr...', 'Who is there?', 'So spooky...']), 900);
        S.add({ e: '🖼️', x: 220, y: 340, s: 150, z: 4, tap: (o) => { if (S.state.dark) return spooky(o); o.anim('wobble', 700); S.say(o, 'Just a painting.'); } });
        S.add({ e: '🛏️', x: 330, y: 760, s: 270, z: 4, tap: (o) => (S.state.dark ? spooky(o) : S.say(o, 'Nobody under here.')) });
        S.add({ e: '🕰️', x: 760, y: 700, s: 130, z: 4, cls: 'wobble', tap: (o) => (S.state.dark ? spooky(o) : S.say(o, 'Tick tock.')) });
        const dark = S.rect(0, 0, 1000, 1000, { background: 'rgba(12,10,40,.9)' }, { z: 20, hidden: true });
        const ghost = S.add({ e: '👻', x: 640, y: 470, s: 190, z: 25, hidden: true, cls: 'bob', style: { '--f': 'drop-shadow(0 0 30px #c9b8ff)' },
          tap: (o) => { S.say(o, 'BOO!'); S.win('Ghosts only come out in the dark!'); } });
        const sw = S.add({ html: A.lightSwitch(true), x: 890, y: 470, z: 30, tap: () => toggle() });
        function toggle() {
          S.state.dark = !S.state.dark;
          GameAudio.play('click');
          sw.set({ html: A.lightSwitch(!S.state.dark) });
          setLamp(!S.state.dark);
          dark[S.state.dark ? 'show' : 'hide']();
          if (!S.state.dark) { ghost.hide(); return; }
          ghost.set({ op: 0 }).show();
          ghost.to({ op: 1 }, 500);
          if (!S.state.seen) { S.state.seen = true; S.good(sw, 'Lights out!'); }
          S.after(700, () => { if (S.state.dark && !S.done) S.say(ghost, 'Hee hee!', 900); });
        }
        S.onBgTap = (p) => S.toast(S.state.dark ? pick(['Brrr...', 'Spooky...']) : 'Nothing here...', p.x, p.y, 900);
      },
    },
    // 25
    {
      id: 'cat-mouse',
      q: 'The cat wants a mouse. Help it!',
      hint: 'Not every mouse squeaks.',
      solution: 'Give the computer mouse to the cat.',
      setup(S) {
        room(S, '#ffe9d6', '#c99a6b', 780);
        const holes = [120, 520].map((x) => S.add({ html: A.mouseHole(), x, y: 727, z: 2, tap: (o) => S.say(o, pick(['Empty!', 'Nobody home.'])) }));
        const cat = S.add({ e: '🐈', x: 300, y: 640, s: 230, z: 5, tap: (o) => { hop(o, 50, 380); S.say(o, 'Meow? Mouse?'); } });
        chatter(S, cat, ['Where is a mouse?', 'Mouse? 🐭', 'Meow... mouse!'], 5200, 400);
        S.add({ e: '🧀', x: 470, y: 900, s: 110, z: 7, drag: true, drop: (o) => {
          if (S.near(o, cat, 220)) S.say(cat, 'I want a MOUSE!');
          else if (holes.some((h) => S.near(o, h, 140))) S.say(o, 'No mouse is coming out...');
          return true;
        } });
        S.add({ html: A.table(400, 150), x: 770, y: 860, z: 2, static: true });
        S.rect(840, 742, 130, 36, { background: '#3d8bff', borderRadius: '12px', boxShadow: `0 0 0 5px ${INK} inset` }, { z: 3 });
        S.add({ e: '💻', x: 740, y: 720, s: 170, z: 3, tap: (o) => { o.anim('pulse', 400); S.say(o, 'Beep boop.'); } });
        S.add({ e: '\u{1F5B1}️', x: 905, y: 720, s: 110, z: 4, drag: true, tap: (o) => S.say(o, 'Click click!', 800), drop: (o) => {
          if (S.near(o, cat, 230)) {
            o.set({ drag: false, tap: null });
            o.to({ x: cat.x + 90, y: cat.y + 70 }, 200);
            cat.set({ e: '😸' });
            S.win('Not every mouse squeaks!');
          }
          return true;
        } });
      },
    },
    // 26
    {
      id: 'find-polar-bear',
      q: 'Find the polar bear.',
      hint: 'Polar bears are as white as snow... but their eyes and nose are not.',
      solution: 'Look for two little black eyes and a black nose in the snow, and tap them.',
      setup(S) {
        S.bg('linear-gradient(#cfe6fa, #eef6fd)');
        S.add({ html: A.hills(1000, 700, '#fdfeff'), x: 500, y: 730, z: 1, static: true });
        S.add({ e: '🌲', x: 90, y: 400, s: 190, z: 2, static: true });
        S.add({ e: '🌲', x: 330, y: 400, s: 130, z: 2, static: true });
        S.add({ html: iglooArt, x: 790, y: 420, z: 2, tap: (o) => S.say(o, 'Nobody home!', 900) });
        S.add({ e: '☃️', x: 220, y: 620, s: 220, z: 4, tap: (o) => { o.anim('wobble', 700); S.say(o, "Not me! I'm a snowman."); } });
        S.add({ e: '🐧', x: 900, y: 650, s: 120, z: 4, tap: (o) => { hop(o, 40, 400); S.say(o, 'Wrong pole! I live down south.'); } });
        [[400, 830, 80], [470, 860, 64], [345, 868, 56]].forEach(([x, y, d]) => S.add({ html: '', w: d, h: d, x, y, z: 4,
          style: { background: '#fff', borderRadius: '50%', boxShadow: `0 0 0 6px ${INK} inset` }, tap: (o) => S.say(o, 'Just a snowball!', 900) }));
        [[120, 880], [860, 860]].forEach(([x, y]) => S.add({ html: '', w: 90, h: 46, x, y, z: 4,
          style: { background: '#5b5f6b', borderRadius: '50%', boxShadow: `0 0 0 6px ${INK} inset` }, tap: (o) => S.say(o, 'Just a rock.', 900) }));
        const bear = S.add({ html: polarBear(false), x: 640, y: 650, z: 3, tap: (o) => {
          if (S.done) return;
          S.state.seen = true;
          o.set({ html: polarBear(true) });
          hop(o, 50, 420);
          S.say(o, 'You found me! 🐾');
          S.win('Polar bears blend right into the snow!');
        } });
        // the bear blinks now and then: a little reward for sharp eyes
        S.every(2800, () => {
          if (S.done) return;
          bear.set({ html: polarBear(false, true) });
          S.after(200, () => { if (!S.state.seen) bear.set({ html: polarBear(false) }); });
        });
        S.every(320, () => {
          if (S.done) return;
          const x = Math.random() * 1000;
          const f = S.add({ html: '', w: 18, h: 18, x, y: 30, z: 20, static: true, style: { background: '#fff', borderRadius: '50%', border: '3px solid #a9c4de' } });
          f.to({ x: x + 60, y: 430 + Math.random() * 500, op: 0 }, 3200, 'linear').then(() => f.remove());
        });
        S.onBgTap = (p) => S.toast(pick(['Just snow!', 'Brrr!', 'Snow, snow, snow...']), p.x, p.y, 800);
      },
    },
    // 27
    {
      id: 'tv-plug',
      q: 'Turn off the TV.',
      hint: 'The remote is dead. Is there another way to cut the power?',
      solution: 'Drag the plug out of the wall socket.',
      setup(S) {
        room(S, '#e8f0ff', '#b98a5e', 800);
        const tv = S.add({ html: A.tv(true), x: 400, y: 450, z: 4, tap: (o) => { o.anim('shake', 460); S.say(o, 'No buttons on this TV!'); } });
        const notes = [0, 0.8, 1.6].map((d, i) => S.add({ text: i % 2 ? '♫' : '♪', x: 560 + i * 26, y: 330 - i * 16, s: 60, color: '#3d8bff', z: 5,
          static: true, cls: 'zzz', style: { animationDelay: d + 's' } }));
        const sleeper = S.add({ e: '😴', x: 330, y: 762, s: 110, z: 5, tap: (o) => S.say(o, "Zzz... I'm watching... zzz") });
        snore(S, 385, 700);
        S.add({ e: '🛋️', x: 360, y: 850, s: 260, z: 6, static: true });
        const socket = S.add({ html: A.socket(), x: 860, y: 640, z: 3, tap: (o) => S.say(o, 'Bzzz...', 800) });
        const cable = S.add({ html: A.svg(1000, 1000, `<path d="" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>`),
          x: 500, y: 500, z: 3, static: true });
        const path = cable.body.querySelector('path');
        const draw = (p) => path.setAttribute('d', `M560 560 C 640 700, ${p.x - 100} ${p.y + 220}, ${p.x} ${p.y + 40}`);
        const plug = S.add({ html: A.plug(), x: 860, y: 675, z: 5, drag: true,
          move: (o) => {
            draw(o);
            if (!S.state.off && S.dist(o, socket) > 110) {
              S.state.off = true;
              tv.set({ html: A.tv(false) });
              notes.forEach((n) => n.hide());
              GameAudio.play('click');
              S.good(o, 'Unplugged!');
              S.after(500, () => S.say(sleeper, 'Zzz... 😴'));
              S.after(700, () => S.win('Unplugged! Who needs a remote?'));
            }
          } });
        draw(plug);
        S.add({ html: remoteArt, x: 680, y: 880, rot: -20, z: 7, drag: true, tap: (o) => S.say(o, 'Batteries are dead!'),
          drop: (o) => { if (S.near(o, tv, 260)) S.say(tv, 'Click... click... nothing!'); return true; } });
      },
    },
    // 28
    {
      id: 'line-length',
      q: 'Which line is longer?',
      hint: "Don't trust your eyes, and don't trust what you think you know. Measure!",
      solution: 'Drag the ruler onto each line: the top one is 13 cm, the bottom one is 16 cm. Tap Bottom.',
      setup(S) {
        const follow = (o) => { if (o.data.tag) o.data.tag.set({ x: o.x, y: o.y - 78 }); };
        const bounds = { l: 340, r: 660, t: 90, b: 720 };
        const lines = [
          S.add({ html: A.arrowLine(520, false), x: 500, y: 210, z: 5, drag: true, bounds, move: follow, data: { cm: 13 } }),
          S.add({ html: A.arrowLine(640, true), x: 500, y: 450, z: 5, drag: true, bounds, move: follow, data: { cm: 16 } }),
        ];
        S.add({ e: '📏', x: 850, y: 650, s: 120, z: 8, drag: true, bounds: { l: 60, r: 940, t: 60, b: 740 }, tap: (o) => S.say(o, 'Drag me onto a line!', 1000), drop: (o) => {
          const l = lines.find((ln) => Math.abs(o.y - ln.y) < 110 && Math.abs(o.x - ln.x) < 380);
          if (!l) return true;
          o.to({ x: l.x + 250, y: l.y + 60 }, 200);
          if (l.data.tag) { l.data.tag.anim('pulse', 500); return true; }
          l.data.tag = S.add({ text: l.data.cm + ' cm', x: l.x, y: l.y - 78, s: 54, color: '#ffd23f', z: 9, static: true });
          S.good(l, l.data.cm + ' cm');
          return true;
        } });
        S.choices(['Top', 'Bottom', 'Same'], 1, { size: 60, msg: 'Think twice! This time the bottom one really IS longer.',
          onWrong: (i) => S.after(250, () => S.toast(i === 2 ? 'Did you measure? 📏' : 'Looks can lie!', 500, 760, 1200)) });
      },
    },
    // 29
    {
      id: 'spelled-incorrectly',
      q: 'Which word is always spelled incorrectly?',
      hint: 'Read the question very, very literally.',
      solution: 'The word "incorrectly" is always spelled I-N-C-O-R-R-E-C-T-L-Y.',
      setup(S) {
        S.add({ e: '📖', x: 330, y: 300, s: 220, z: 3, tap: (o) => { o.anim('wobble', 600); S.say(o, pick(['A, B, C...', 'So many words!'])); } });
        S.add({ e: '✏️', x: 560, y: 260, s: 150, z: 3, rot: 15, tap: (o) => { o.anim('ring', 500); S.say(o, 'Scribble scribble!'); } });
        S.add({ e: '🐝', x: 780, y: 230, s: 110, z: 4, cls: 'bob', tap: (o) => {
          S.say(o, "Bzz! I'm a spelling bee!");
          o.to({ x: 680 + Math.random() * 220, y: 150 + Math.random() * 260 }, 500);
        } });
        const msg = 'Incorrectly is always spelled I-N-C-O-R-R-E-C-T-L-Y!';
        const btns = S.choices(['Wrong', 'Incorrectly', 'Mistake', 'Error'], 1, { cols: 2, h: 130, size: 54, msg });
        S.tapWord('incorrectly', (w) => { w.el.classList.add('glow'); btns[1].cls('right'); S.win(msg); });
      },
    },
    // 30
    {
      id: 'bird-cage',
      q: 'Help the bird escape.',
      hint: "You don't need a key at all.",
      solution: 'The cage has no bottom. Drag the whole cage up!',
      setup(S) {
        room(S, '#e7f3ff', '#c99a6b', 800);
        S.add({ html: A.table(600, 160), x: 500, y: 860, z: 2, static: true });
        S.rect(400, 700, 200, 14, { background: '#a8743f', borderRadius: '7px' }, { z: 3 });
        const bird = S.add({ e: '🐦', x: 500, y: 640, s: 120, z: 4, cls: 'bob' });
        chatter(S, bird, ['Tweet! Let me out!', 'Tweet tweet! 😢', 'Help!'], 5000, 500);
        const cage = S.add({ html: A.cage(), x: 500, y: 590, z: 6, drag: true, tap: (o) => { o.anim('shake', 460); S.say(o, 'Locked! 🔒'); },
          move: (o) => { if (!S.state.free && !S.hits(bird, o, -40)) free(); } });
        S.add({ e: '🌽', x: 160, y: 880, s: 110, z: 7, drag: true, drop: (o) => { if (S.near(o, cage, 240)) S.say(bird, 'Yum! But let me out!'); return true; } });
        S.add({ e: '🗝️', x: 840, y: 330, s: 90, z: 5, rot: 20, drag: true, back: true, tap: (o) => S.say(o, 'An old key...', 900),
          drop: (o) => { S.say(o, S.near(o, cage, 260) ? "Doesn't fit!" : 'Hmm...', 900); return false; } });
        function free() {
          S.state.free = true;
          bird.cls('bob', false);
          GameAudio.play('whoosh');
          S.good(bird, 'Free!');
          bird.to({ x: 880, y: 110, rot: -15 }, 1000, 'ease-in');
          S.after(800, () => S.win('No key needed. The cage had no bottom!'));
        }
      },
    },
    // 31
    {
      id: 'numbers-1-9',
      q: 'Tap the numbers from 1 to 9 in order.',
      hint: 'One number is shy and hiding.',
      solution: 'After 5, move the big 8 to find the 6 under it.',
      setup(S) {
        let next = 1;
        const label = S.add({ text: 'NEXT: 1', x: 500, y: 70, s: 58, z: 3, static: true, color: '#ffd23f' });
        const colors = ['#ff5a5f', '#ffb020', '#ffd23f', '#22c55e', '#3d8bff', '#a259ff', '#ff7ab6', '#4fd1c5', '#ff9f1c'];
        const pos = { 1: [170, 250], 2: [820, 560], 3: [480, 420], 4: [210, 700], 5: [720, 240], 6: [640, 800], 7: [370, 880], 8: [640, 800], 9: [870, 880] };
        const praise = ['Nice!', 'Yes!', 'Good!', 'Great!'];
        const nums = {};
        for (let n = 1; n <= 9; n++) {
          const big = n === 8;
          nums[n] = S.add({ html: String(n), w: big ? 240 : 150, h: big ? 240 : 150, s: big ? 130 : 90, x: pos[n][0], y: pos[n][1],
            z: n === 6 ? 3 : big ? 9 : 6, drag: true, data: { n }, cls: n === 6 || big ? '' : 'bob',
            style: block(colors[n - 1], { borderRadius: '50%', color: '#fff', textShadow: '0 4px 0 rgba(0,0,0,.2)', animationDelay: (n * 0.23).toFixed(2) + 's' }),
            move: big ? (o) => { if (!S.state.peek && !S.hits(nums[6], o, -30)) { S.state.peek = true; S.say(nums[6], 'Eek! You found me! 🙈'); } } : null,
            tap: (o) => {
              if (o.data.done) return S.say(o, 'Already got me!', 700);
              if (o.data.n !== next) return S.fail(o, next === 6 ? 'Where is 6?' : 'Not yet!');
              o.data.done = true;
              o.body.style.background = '#c9f7d3';
              o.body.style.color = '#16a34a';
              o.to({ sc: 0.85 }, 200);
              next++;
              label.set({ text: next > 9 ? 'DONE!' : 'NEXT: ' + next });
              if (next > 9) S.win('The shy 6 was hiding under the 8!');
              else S.good(o, praise[o.data.n % praise.length]);
            } });
        }
      },
    },
    // 32
    {
      id: 'jump-house',
      q: 'How many animals can jump higher than the house?',
      hint: 'How high can a house jump?',
      solution: "A house can't jump at all, so every animal that can jump beats it. Snails can't jump, so the answer is 3.",
      setup(S) {
        S.bg(SKY);
        S.add({ html: cloudArt(220, 120), x: 170, y: 140, z: 1, static: true, cls: 'bob' });
        S.add({ html: cloudArt(180, 100), x: 830, y: 200, z: 1, static: true, cls: 'bob', style: { animationDelay: '.8s' } });
        floor(S, 700, '#8fd16a');
        S.add({ html: A.house(false, 340, 340), x: 500, y: 535, z: 3, tap: (o) => { o.anim('shake', 460); S.say(o, pick(['Hnnngh!', 'Hnnngh... nope.'])); } });
        [['🦘', 140, 605, 200, 140, 'Boing!'], ['🐸', 295, 648, 120, 100, 'Ribbit!'], ['🐇', 730, 630, 150, 120, 'Hop hop!']].forEach(([e, x, y, s, h, line], i) =>
          S.add({ e, x, y, s, z: 5, cls: 'bob', style: { animationDelay: (i * 0.5) + 's', animationDuration: '2.6s' },
            tap: (o) => { hop(o, h); GameAudio.play('whoosh'); S.toast(line, o.x, o.y - s / 2 - h, 800); } }));
        S.add({ e: '🐌', x: 880, y: 660, s: 110, z: 5, tap: (o) => { o.anim('shake', 460); S.say(o, "I can't jump! 🐌"); } });
        S.choices(['0', '1', '2', '3', '4'], 3, { size: 72, msg: "Houses can't jump! (Snails can't either.)" });
      },
    },
    // 33
    {
      id: 'ball-in-hole',
      q: 'Get the ball out of the hole.',
      hint: 'Balls float!',
      solution: 'Pour the bucket of water into the hole. The ball floats up.',
      setup(S) {
        S.bg(SKY);
        S.add({ html: cloudArt(240, 130), x: 640, y: 150, z: 1, static: true, cls: 'bob' });
        S.rect(440, 515, 120, 390, { background: '#5a3a1e' }, { z: 1 });
        const water = S.add({ html: A.holeWater(120, 380), x: 500, y: 1100, z: 2, static: true });
        S.add({ html: A.groundWithHole(1000, 520, 500, 120, 420), x: 500, y: 740, z: 4, static: true });
        const target = S.rect(440, 380, 120, 520, {}, { z: 0 });
        const ball = S.add({ e: '⚽', x: 500, y: 852, s: 90, z: 3, tap: (o) => { o.anim('shake', 460); S.say(o, 'Too deep to reach!'); } });
        const kid = S.add({ e: '🧒', x: 350, y: 446, s: 150, z: 5, tap: (o) => S.say(o, pick(['My ball! 😢', 'Can you get it out?'])) });
        S.after(500, () => S.say(kid, 'My ball fell in! 😢', 1500));
        const stickHome = { x: 150, y: 506, rot: 90 };
        S.add({ html: A.stick(), x: stickHome.x, y: stickHome.y, rot: stickHome.rot, z: 8, drag: true, drop: (o) => {
          if (!S.over(o, target, 60) || o.data.busy) return true;
          o.data.busy = true;
          o.set({ z: 3, drag: false });
          o.to({ x: 500, y: 650, rot: 0 }, 300)
            .then(() => { S.say(o, 'Too short!'); return S.wait(700); })
            .then(() => { o.set({ z: 8 }); return o.to(stickHome, 400); })
            .then(() => { o.set({ drag: true }); o.data.busy = false; });
          return true;
        } });
        S.add({ html: A.bucket(), x: 830, y: 442, z: 8, drag: true, drop: (o) => {
          if (S.state.poured || !S.over(o, target, 90)) return true;
          S.state.poured = true;
          o.set({ drag: false });
          o.to({ x: 600, y: 420, rot: -75 }, 300);
          GameAudio.play('splash');
          S.good(o, 'Splash!');
          water.to({ y: 750 }, 1300, 'ease-out');
          ball.to({ y: 530 }, 1300, 'ease-out')
            .then(() => ball.to({ x: 650, y: 474 }, 400))
            .then(() => { S.say(kid, 'Yay! My ball! 🎉'); S.win('Water pushed the ball up!'); });
          return true;
        } });
      },
    },
    // 34
    {
      id: 'grow-plant',
      q: 'Make the plant grow.',
      hint: 'Plants need two things.',
      solution: 'Water the plant with the watering can, then slide the curtain open to let the sunlight in.',
      setup(S) {
        room(S, '#fff1d6', '#d9a875', 800);
        S.add({ html: A.windowFrame(320, 300), x: 700, y: 300, z: 2, static: true });
        const beam = S.add({ html: '', w: 260, h: 640, x: 470, y: 570, rot: 38, z: 3, hidden: true, static: true,
          style: { background: 'linear-gradient(rgba(255,236,120,.75), rgba(255,236,120,0))' } });
        const plantSays = () => S.say(plant, S.state.water ? 'Now I need sunlight! ☀️' : S.state.sun ? 'So thirsty!' : pick(['Thirsty... and dark.', 'Help me grow!']));
        const pot = S.add({ html: A.pot(), x: 300, y: 830, z: 6, tap: () => plantSays() });
        const plant = S.add({ e: '🌱', x: 300, y: 720, s: 100, z: 5, cls: 'wobble', tap: () => plantSays() });
        const check = () => {
          if (S.state.water && S.state.sun) {
            plant.cls('wobble', false);
            plant.set({ e: '🌻' });
            plant.to({ sc: 2, y: 620 }, 600);
            S.after(700, () => S.win('Water + sunlight = flower!'));
          } else S.after(600, plantSays);
        };
        S.add({ html: A.curtain(340, 340), x: 700, y: 300, z: 4, drag: true, axis: 'x', bounds: { l: 220, r: 1180, t: 300, b: 300 },
          tap: (o) => { o.anim('wobble', 500); GameAudio.play('whoosh'); },
          move: (o) => {
            if (S.state.sun || Math.abs(o.x - 700) < 300) return;
            S.state.sun = true;
            beam.show();
            S.good({ x: 700, y: 300 }, 'Sunshine!');
            check();
          } });
        S.add({ html: A.wateringCan(), x: 650, y: 880, z: 8, drag: true, drop: (o) => {
          if (!S.state.water && S.near(o, pot, 280)) {
            S.state.water = true;
            o.set({ html: A.wateringCan(230, 170, true), drag: false, flip: true });
            o.to({ x: pot.x + 170, y: pot.y - 240, rot: -25 }, 300);
            GameAudio.play('splash');
            plant.to({ sc: 1.4, y: 700 }, 400);
            S.good(plant, 'Gulp!');
            check();
          }
          return true;
        } });
      },
    },
    // 35
    {
      id: 'spell-cat',
      q: 'Spell the word CAT.',
      hint: 'There is no C tile... but something in the sky looks like one.',
      solution: 'Drag the moon into the first box (it is shaped like a C), then add A and T.',
      setup(S) {
        S.bg('linear-gradient(#1f1a4d 0 44%, #fffdf7 44%)');
        twinkles(S, [[120, 110], [380, 80], [560, 190], [940, 300], [250, 330]], '#fff7c2', ['Twinkle!', '✨', 'Not a letter!']);
        const slots = [['C', 290], ['A', 500], ['T', 710]].map(([need, x]) => ({ need, x, y: 580, o: null,
          box: S.add({ html: '', w: 180, h: 180, x, y: 580, z: 2, static: true, style: { border: '8px dashed #b9b2cf', borderRadius: '30px', background: '#f4f1fb' } }) }));
        const check = () => { if (slots.every((s) => s.o && s.o.data.l === s.need)) S.win('The moon makes a great C!'); };
        const place = (o, s) => { s.o = o; o.data.slot = s; o.to({ x: s.x, y: s.y }, 200); };
        const freeSlot = (o) => slots.find((s) => !s.o && S.over(o, s.box, 30));
        const grab = (o) => { if (o.data.slot) { o.data.slot.o = null; o.data.slot = null; } };
        const tryPlace = (o) => {
          const s = freeSlot(o);
          if (!s) return true;
          if (o.data.l !== s.need) {
            o.shake();
            S.say(s.box, s.need === 'C' && 'OG'.includes(o.data.l) ? `So close! But ${o.data.l} is not a C.` : `This box needs ${s.need}!`, 1200);
            o.to({ x: o.data.hx, y: o.data.hy }, 300);
            return true;
          }
          place(o, s);
          S.good(s.box, 'Nice!');
          check();
          return true;
        };
        const tile = (l, x, y, bg) => S.add({ html: l, w: 150, h: 150, s: 96, x, y, z: 8, drag: true, data: { l, hx: x, hy: y }, style: block(bg), grab, drop: tryPlace });
        ['A', 'T', 'O', 'G', 'D'].forEach((l, i) => tile(l, 120 + i * 190, 840, '#ffd23f'));
        S.add({ html: moonArt, x: 790, y: 190, z: 8, drag: true, tap: (o) => S.say(o, 'Hello down there!', 900), drop: (o) => {
          if (!freeSlot(o) || slots[0].o) return true;
          o.hide();
          GameAudio.play('reveal');
          const c = tile('C', o.x, o.y, '#fff2a8');
          place(c, slots[0]);
          S.good(slots[0].box, 'C!');
          check();
          return true;
        } });
        S.dragWord('cat', (w, p) => {
          if (p.y < 380) return false;
          slots.forEach((s) => { if (s.o) { s.o.data.slot = null; s.o.to({ x: s.o.data.hx, y: s.o.data.hy }, 250); } s.o = null; });
          'CAT'.split('').forEach((l, i) => place(tile(l, p.x, p.y, '#fff2a8'), slots[i]));
          S.good(slots[1].box, 'C-A-T!');
          check();
          return true;
        });
      },
    },
    // 36
    {
      id: 'the-the',
      q: 'Tap the the mistake.',
      hint: 'Read the question again, slowly, one word at a time.',
      solution: 'The question says "the the". Tap one of the two "the" words in the question.',
      setup(S) {
        S.add({ html: paperArt, x: 440, y: 500, rot: -3, z: 2, static: true });
        S.add({ text: 'MATH TEST', x: 440, y: 290, s: 56, z: 3, rot: -3, static: true, color: '#ff6b6b' });
        const owl = S.add({ e: '🦉', x: 850, y: 770, s: 170, z: 4, cls: 'bob', tap: (o) => S.say(o, pick(['Hoo! Read carefully!', 'Hoo hoo!'])) });
        S.add({ e: '🖊️', x: 860, y: 330, s: 120, z: 4, rot: 20, tap: (o) => { o.anim('ring', 400); S.say(o, 'Scribble!', 800); } });
        let checked = 0;
        [['2 + 3 = 5', 410], ['4 × 2 = 8', 540], ['9 − 6 = 3', 670]].forEach(([t, y]) => {
          S.add({ text: t, x: 430, y, s: 90, z: 4, rot: -3, cls: 'plain', color: '#2b2350', style: { fontFamily: 'var(--hand)', padding: '10px 30px' },
            tap: (o) => {
              if (!o.data.ok) {
                o.data.ok = true;
                S.add({ text: '✔', x: o.x + 230, y: o.y, s: 80, z: 5, color: '#22c55e', static: true });
                checked++;
              }
              S.say(o, pick(['Correct!', 'No mistake here!', "That's right!"]), 900);
              if (checked === 3 && !S.state.all) {
                S.state.all = true;
                S.after(1100, () => S.say(owl, 'All correct... so where is the mistake? 🤔', 2000));
              }
            } });
        });
        S.words.forEach((w) => {
          let fn = null;
          if (w.key === 'the') fn = (x) => { x.el.classList.add('glow'); S.win('Did your brain skip the extra "the"? Most do!'); };
          else if (w.key === 'mistake') fn = () => S.toast('Not this word!', 500, 130, 900);
          else if (w.key === 'tap') fn = () => S.toast('Tap tap! 👆', 500, 130, 900);
          if (fn) { w.onTap = fn; w.el.classList.add('tap'); }
        });
      },
    },
    // 37
    {
      id: 'put-out-fire',
      q: 'Put out the fire!',
      hint: 'Clouds are made of water... but this one is dry. Where could it get some?',
      solution: 'Drag the cloud down onto the lake to soak up water, then drag the rain cloud over the fire.',
      setup(S) {
        S.bg(SKY);
        floor(S, 560, '#9ed676');
        S.add({ e: '🌲', x: 90, y: 470, s: 210, z: 2, static: true });
        S.add({ e: '🌲', x: 300, y: 485, s: 170, z: 2, static: true });
        S.add({ e: '⛺', x: 875, y: 505, s: 200, z: 2, tap: (o) => S.say(o, pick(['Zzz...', 'Is it out yet?']), 900) });
        const lake = S.add({ html: lakeArt, x: 220, y: 790, z: 2, tap: (o) => { o.anim('pulse', 400); GameAudio.play('splash'); S.say(o, 'Splash!', 700); } });
        const fire = S.add({ e: '🔥', x: 690, y: 660, s: 180, z: 3, cls: 'pulse', tap: (o) => { o.shake(); S.say(o, 'Too hot! 🥵', 900); } });
        S.add({ html: logsArt, x: 690, y: 748, z: 4, static: true });
        const overFire = (o) => Math.abs(o.x - fire.x) < 180 && o.y < fire.y + 20;
        const cloud = S.add({ html: cloudArt(300, 170), x: 420, y: 170, z: 9, drag: true,
          tap: (o) => S.say(o, S.state.wet ? "I'm full of water!" : 'Puff!', 900),
          drop: (o) => {
            if (S.state.out) return true;
            if (S.over(o, lake, 40)) {
              if (S.state.wet) { S.say(o, "I'm already full!", 900); return true; }
              S.state.wet = true;
              o.set({ html: cloudArt(300, 170, '#9aa6bd') });
              GameAudio.play('splash');
              lake.to({ sc: 0.85 }, 500);
              S.good(o, 'Slurp!');
              S.after(450, () => { if (!S.state.out) o.to({ y: 210 }, 600, 'ease-out'); });
            } else if (overFire(o)) {
              if (S.state.wet) rain(o); else S.say(o, "I'm too dry to rain!", 1100);
            }
            return true;
          } });
        function rain(c) {
          S.state.out = true;
          c.set({ drag: false });
          c.to({ x: fire.x, y: 420 }, 350);
          GameAudio.play('splash');
          for (let i = 0; i < 14; i++) S.after(110 * i, () => {
            const d = S.add({ e: '💧', x: fire.x - 110 + Math.random() * 220, y: 480, s: 46, z: 8, static: true });
            d.to({ y: 700, op: 0.2 }, 450, 'ease-in').then(() => d.remove());
          });
          S.after(800, () => fire.to({ sc: 0.2, op: 0 }, 600));
          S.after(1300, () => { const p = S.add({ e: '💨', x: fire.x, y: 690, s: 110, z: 7, static: true, op: 0 }); p.to({ y: 580, op: 1 }, 700); });
          S.after(1700, () => S.win('Clouds carry water!'));
        }
        S.add({ html: leakyBucket(false), x: 500, y: 890, z: 7, drag: true, drop: (o) => {
          if (S.over(o, lake, 30)) {
            if (o.data.full) return true;
            o.data.full = true;
            o.set({ html: leakyBucket(true) });
            S.say(o, 'Full!', 700);
            S.after(1300, () => { o.data.full = false; o.set({ html: leakyBucket(false) }); S.say(o, 'Oops! It has a hole!', 1100); });
          } else if (S.near(o, fire, 240)) S.say(o, o.data.full ? 'It all leaked out!' : 'Empty! It leaks!', 1000);
          return true;
        } });
        void cloud;
      },
    },
    // 38
    {
      id: 'three-stars',
      q: 'Find 3 stars ⭐',
      hint: 'Look everywhere, even outside the picture.',
      solution: 'One is in the sky, one is behind the cloud, and one is in the question.',
      setup(S) {
        S.bg('linear-gradient(#141238, #2f2a6e)');
        twinkles(S, [[90, 120], [320, 380], [560, 100], [900, 160], [460, 560], [130, 520], [880, 560], [690, 640]], '#c9c3ff',
          ['Just a twinkle ✨', 'Too tiny!', "That's not a ⭐"]);
        S.add({ html: A.hills(1000, 260, '#3c3570'), x: 500, y: 870, z: 2, static: true });
        let found = 0;
        const counter = S.add({ text: '0 / 3', x: 500, y: 920, s: 62, z: 30, static: true, color: '#fff' });
        const add = (at) => {
          found++;
          counter.set({ text: found + ' / 3' });
          counter.anim('pulse', 500);
          if (found === 3) S.win('Even the question was hiding one!');
          else S.good(at, found + ' / 3');
        };
        const star = (x, y) => S.add({ e: '⭐', x, y, s: 70, z: 5, tap: (o) => {
          if (o.data.f) return S.say(o, 'Already found!', 700);
          o.data.f = true;
          o.cls('pulse');
          add(o);
        } });
        star(220, 640);
        star(700, 360);
        S.add({ html: cloudArt(440, 270, '#d9d4f5'), x: 710, y: 350, z: 8, drag: true });
        S.add({ e: '🌙', x: 300, y: 230, s: 160, z: 6, drag: true, tap: (o) => S.say(o, 'Hello!', 800),
          drop: (o) => { if (found < 3) S.say(o, 'Nothing behind me!', 900); return true; } });
        S.tapWord('⭐', (w) => {
          if (S.state.q) return;
          S.state.q = true;
          w.el.classList.add('glow');
          add({ x: 500, y: 130 });
        });
      },
    },
    // 39
    {
      id: 'parking-spot',
      q: 'What number is the car parked on?',
      hint: 'Try looking at it upside down.',
      solution: 'Upside down the spots read 86, ?, 88, 89, 90, 91. The car is on 87.',
      setup(S) {
        S.bg('#5b5f6b');
        S.rect(0, 0, 1000, 70, { background: '#4a4e59' }, { z: 1 });
        ['16', '06', '68', '88', '87', '98'].forEach((t, i) => {
          const x = 105 + i * 158;
          S.rect(x - 75, 100, 150, 340, { borderLeft: '8px solid #fff', borderRight: '8px solid #fff', borderTop: '8px solid #fff' }, { z: 2 });
          S.add({ text: t, x, y: 380, s: 70, z: 3, static: true, color: '#fff', rot: t === '87' ? 180 : 0 });
        });
        S.add({ e: '🚘', x: 737, y: 350, s: 200, z: 6, drag: true, bounds: { l: 90, r: 910, t: 130, b: 470 },
          tap: (o) => { o.anim('shake', 460); S.say(o, 'Beep beep!', 800); } });
        S.numpad(87, { y: 620 });
      },
    },
    // 40
    {
      id: 'add-one-line',
      q: 'Add ONE line to make this true.',
      hint: "Leave the numbers alone. Look at the + signs: one line could turn one into a number.",
      solution: 'Drag the chalk line onto the first + to turn it into a 4: 545 + 5 = 550.',
      setup(S) {
        S.add({ html: boardArt, x: 500, y: 380, z: 2, static: true });
        const toks = [['5', 150], ['+', 245], ['5', 340], ['+', 435], ['5', 530], ['=', 630], ['550', 800]].map(([ch, x]) =>
          ({ ch, o: S.add({ text: ch, x, y: 350, s: ch === '+' || ch === '=' ? 160 : 130, z: 4, cls: 'plain', color: '#fdfdf5', static: true }) }));
        const home = { x: 330, y: 566 };
        S.add({ html: chalkArt, x: home.x, y: home.y, z: 6, drag: true, tap: (o) => { o.anim('shake', 460); S.say(o, 'Squeak!', 700); }, drop: (o) => {
          const r = o.rect();
          let best = null, bd = 85;
          toks.forEach((t) => { const d = S.dist(r, t.o); if (d < bd) { bd = d; best = t; } });
          if (!best) { o.to(home, 300); return true; }
          if (best.ch === '5' || best.ch === '550') {
            S.say(best.o, pick(['That makes a weird number!', 'Nope, not there.']), 1000);
            o.to(home, 300);
            return true;
          }
          o.hide();
          GameAudio.play('reveal');
          best.o.set({ text: best.ch === '+' ? '4' : '≠' });
          best.o.body.style.color = '#ffd23f';
          best.o.anim('pulse', 800);
          S.win(best.ch === '=' ? '5 + 5 + 5 ≠ 550. Sneaky, but true!' : best === toks[1] ? '545 + 5 = 550!' : '5 + 545 = 550!');
          return true;
        } });
        S.add({ e: '🦉', x: 860, y: 810, s: 160, z: 4, cls: 'bob', tap: (o) => S.say(o, 'Hoo! Just ONE line!') });
      },
    },
    // 41: must stay the last level of the game (its code is its own level number)
    {
      id: 'safe-code',
      q: 'Open the safe to win the trophy!',
      hint: 'Something on the wall is hiding a clue. Then look at the top of your screen.',
      solution: "Move the painting to find the note: the code is this level's number, shown at the top of the screen.",
      setup(S) {
        S.bg('linear-gradient(#efe6ff 0 52%, #d9c2a0 52%)');
        const safe = S.add({ html: A.safe(false, 300, 300), x: 270, y: 290, z: 4, tap: (o) => {
          if (S.state.open) return;
          o.anim('ring', 400);
          GameAudio.play('tick');
          S.say(o, 'Locked! Type the code 👇', 1000);
        } });
        const note = S.add({ html: "The code is this level's number 😉", w: 230, h: 190, x: 700, y: 280, rot: 5, z: 3, static: true,
          style: block('#fff27a', { fontSize: '36px', whiteSpace: 'normal', textAlign: 'center', padding: '14px', lineHeight: '1.1', borderRadius: '10px', fontFamily: 'var(--hand), var(--emoji)' }) });
        S.add({ html: paintingArt, x: 700, y: 280, z: 6, drag: true, bounds: { l: 160, r: 840, t: 150, b: 470 },
          tap: (o) => { o.anim('wobble', 600); S.say(o, 'It wiggles...', 800); },
          move: (o) => { if (!S.state.found && !S.hits(o, note, -40)) { S.state.found = true; S.good(note, 'A clue!'); } } });
        S.numpad(String(S.index + 1), { y: 620, onCorrect: () => {
          S.state.open = true;
          safe.set({ html: A.safe(true, 300, 300) });
          const trophy = S.add({ e: '🏆', x: 270, y: 290, s: 180, sc: 0.2, z: 6, static: true });
          trophy.to({ sc: 1 }, 500);
          S.after(600, () => S.win('You cracked the final puzzle!'));
        } });
      },
    }
  );
})();

// ---- js/main.js ----
// Game flow: title, levels, hints, pause, win / completion screens, rewards, saving and SDK events.
(function () {
  const LEVELS = window.LEVELS;
  const SAVE_KEY = 'thinktwice_save_v2';
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay'), panel = $('panel'), titleEl = $('title');
  const ICON = {
    sfx: $('btn-sfx').innerHTML,
    music: $('btn-music').innerHTML,
    home: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" stroke="#1f1f24" stroke-width="2" stroke-linejoin="round"/></svg>',
  };
  $('doodles').innerHTML = Art.doodles();

  // Brain-power ranks: XP comes from stars (10 XP per star).
  const RANKS = [
    [0, 'Curious Kid'], [60, 'Puzzle Rookie'], [150, 'Clever Clogs'], [270, 'Sneaky Thinker'],
    [420, 'Brain Box'], [600, 'Riddle Master'], [820, 'Big Brain'], [1100, 'Certified Genius'],
  ];
  const rankOf = (xp) => {
    let i = 0;
    while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++;
    return { i, name: RANKS[i][1], from: RANKS[i][0], to: RANKS[i + 1] ? RANKS[i + 1][0] : RANKS[i][0] };
  };

  // ---------- save data ----------
  // solved: level id → best stars (1–3). revealed: level id → 1 (hint) / 2 (solution).
  const save = { solved: {}, revealed: {}, hints: 3, current: null, sfx: true, music: true, streak: 0, best: 0 };
  const ids = new Set(LEVELS.map((l) => l.id));

  function loadSave() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    save.hints = int(raw.hints, 0, 999, 3);
    save.streak = int(raw.streak, 0, 9999, 0);
    save.best = int(raw.best, 0, 9999, 0);
    save.sfx = raw.sfx !== false;
    save.music = raw.music !== false;
    if (typeof raw.current === 'string' && ids.has(raw.current)) save.current = raw.current;
    if (raw.solved && typeof raw.solved === 'object') {
      for (const k in raw.solved) if (ids.has(k)) save.solved[k] = int(raw.solved[k], 1, 3, 1);
    }
    if (raw.revealed && typeof raw.revealed === 'object') {
      for (const k in raw.revealed) if (ids.has(k) && (raw.revealed[k] === 1 || raw.revealed[k] === 2)) save.revealed[k] = raw.revealed[k];
    }
  }

  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* incognito / storage blocked */ }
  }

  const solvedCount = () => Object.keys(save.solved).length;
  const totalStars = () => Object.values(save.solved).reduce((a, b) => a + b, 0);
  const xp = () => totalStars() * 10;
  function unlockedCount() {
    let last = -1;
    LEVELS.forEach((l, i) => { if (save.solved[l.id]) last = i; });
    return Math.min(LEVELS.length, last + 2);
  }
  function firstPlayable() {
    const n = unlockedCount();
    for (let i = 0; i < n; i++) if (!save.solved[LEVELS[i].id]) return i;
    const cur = LEVELS.findIndex((l) => l.id === save.current);
    return cur >= 0 ? cur : 0;
  }
  const starRow = (n, cls = '') =>
    `<span class="stars ${cls}">${[0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}">${ICON.star}</i>`).join('')}</span>`;

  // ---------- confetti ----------
  const fx = (() => {
    const cv = $('fx'), g = cv.getContext('2d');
    let parts = [], raf = 0, last = 0;
    const colors = ['#ffd23f', '#ff6b6b', '#7fd3ff', '#b9e85a', '#c7a8ff', '#ff9f1c'];
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function frame(t) {
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
      last = t;
      g.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 40);
      for (const p of parts) {
        p.vy += 900 * dt; p.vx *= 0.99;
        p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life -= dt;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r);
        g.fillStyle = p.c; g.strokeStyle = '#1f1f24'; g.lineWidth = 1.5;
        g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.strokeRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        g.restore();
      }
      if (parts.length) raf = requestAnimationFrame(frame);
      else { raf = 0; g.clearRect(0, 0, innerWidth, innerHeight); }
    }
    window.addEventListener('resize', resize);
    resize();
    return {
      confetti(n = 110, cx = innerWidth / 2, cy = innerHeight * 0.45) {
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 350 + Math.random() * 650;
          parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 14,
            s: 8 + Math.random() * 10, c: colors[i % colors.length], life: 2.6 });
        }
        if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
      },
    };
  })();

  // ---------- screens ----------
  let screen = 'loading'; // loading | title | play | panel
  let levelIndex = 0;
  let panelTimers = [];
  const later = (ms, fn) => { panelTimers.push(setTimeout(fn, ms)); };
  const clearPanelTimers = () => { panelTimers.forEach(clearTimeout); panelTimers = []; };

  function updateHud() {
    $('level-label').textContent = 'LEVEL ' + (levelIndex + 1);
    $('hint-count').textContent = save.hints;
  }

  function syncAudioButtons() {
    $('btn-sfx').classList.toggle('off', !save.sfx);
    $('btn-music').classList.toggle('off', !save.music);
    GameAudio.setUserMute(!save.sfx);
    GameAudio.setMusic(save.music);
  }

  function enterAnim(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function startLevel(i) {
    levelIndex = Math.max(0, Math.min(LEVELS.length - 1, i));
    save.current = LEVELS[levelIndex].id;
    persist();
    Engine.load(LEVELS[levelIndex], levelIndex);
    updateHud();
    enterAnim($('question'), 'enter');
    enterAnim($('scene'), 'enter');
    GameAudio.play('whoosh');
    screen = 'play';
  }

  // Go into gameplay after a natural break: commercial break first, then start.
  function enterGameplay(i) {
    hidePanel();
    titleEl.classList.add('hidden');
    SDK.commercialBreak().then(() => {
      if (i != null) startLevel(i);
      else { const S = Engine.current(); if (S) S.locked = false; screen = 'play'; }
      SDK.gameplayStart();
    });
  }

  function showPanel(html, bind, cls = '') {
    SDK.gameplayStop();
    clearPanelTimers();
    const S = Engine.current();
    if (S) S.locked = true;
    panel.className = 'panel ' + cls;
    panel.innerHTML = html;
    overlay.classList.remove('hidden');
    panel.scrollTop = 0;
    screen = 'panel';
    panel.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', (e) => { GameAudio.play('click'); bind[b.dataset.act](e, b); });
    });
  }

  function hidePanel() { clearPanelTimers(); overlay.classList.add('hidden'); panel.innerHTML = ''; }

  // close a panel and continue the same level without an ad (hint panel)
  function resumeQuiet() {
    hidePanel();
    const S = Engine.current();
    if (S && !S.done) S.locked = false;
    screen = 'play';
    SDK.gameplayStart();
  }

  function showTitle() {
    SDK.gameplayStop();
    hidePanel();
    Engine.unload();
    screen = 'title';
    const next = firstPlayable();
    const r = rankOf(xp());
    $('title-mascot').innerHTML = Art.mascot('happy');
    $('title-level').textContent = 'LEVEL ' + (next + 1);
    $('title-count').innerHTML = `<span class="em">⭐</span> ${totalStars()}/${LEVELS.length * 3}`;
    $('title-rank').textContent = r.name.toUpperCase();
    $('title-tap').textContent = solvedCount() > 0 ? 'TAP TO CONTINUE!' : 'TAP TO PLAY!';
    titleEl.classList.remove('hidden');
  }

  // ---------- panels ----------
  function showPause() {
    showPanel(`
      ${Art.mascot('sleep', 120)}
      <h2>PAUSED</h2>
      <div class="col">
        <button class="btn big lime" data-act="resume">RESUME</button>
        <button class="btn big yellow" data-act="levels">LEVELS</button>
        <div class="row">
          <button class="btn icon ${save.sfx ? '' : 'off'}" data-act="sfx" aria-label="Sound effects">${ICON.sfx}</button>
          <button class="btn icon ${save.music ? '' : 'off'}" data-act="music" aria-label="Music">${ICON.music}</button>
          <button class="btn icon" data-act="home" aria-label="Home">${ICON.home}</button>
        </div>
      </div>`, {
      resume: () => enterGameplay(null),
      levels: () => showLevels(),
      sfx: (e, b) => { save.sfx = !save.sfx; persist(); syncAudioButtons(); b.classList.toggle('off', !save.sfx); },
      music: (e, b) => { save.music = !save.music; persist(); syncAudioButtons(); b.classList.toggle('off', !save.music); },
      home: () => showTitle(),
    }, 'pause');
  }

  function showLevels() {
    const fromTitle = screen === 'title';
    const unlocked = unlockedCount();
    const cur = fromTitle ? firstPlayable() : levelIndex;
    let grid = '';
    LEVELS.forEach((l, i) => {
      const locked = i >= unlocked;
      const stars = save.solved[l.id] || 0;
      const current = !locked && !stars && i === cur;
      grid += `<button class="btn lv ${locked ? 'locked' : ''} ${stars ? 'solved' : ''} ${current ? 'current' : ''}" data-act="pick" data-i="${i}" ${locked ? 'disabled' : ''}>
        <b>${locked ? ICON.lock : i + 1}</b>${stars ? starRow(stars, 'mini') : ''}</button>`;
    });
    titleEl.classList.add('hidden');
    showPanel(`
      <h2>LEVELS</h2>
      <p><span class="em">⭐</span> ${totalStars()} / ${LEVELS.length * 3} · ${rankOf(xp()).name}</p>
      <div class="levels">${grid}</div>
      <button class="btn mid yellow" data-act="close">BACK</button>`, {
      pick: (e, b) => enterGameplay(+b.dataset.i),
      close: () => (fromTitle || !Engine.current() ? showTitle() : showPause()),
    }, 'levelsc');
    // scroll only inside the card (scrollIntoView could scroll Poki's host page)
    const curEl = panel.querySelector('.lv.current');
    if (curEl) panel.scrollTop = Math.max(0, curEl.offsetTop - panel.clientHeight / 2);
  }

  function hintBody(stage, lv) {
    let html = '';
    if (stage >= 1) html += `<div class="hint-text">💡 ${lv.hint}</div>`;
    if (stage >= 2) html += `<div class="hint-text solution">✅ ${lv.solution}</div>`;
    return html;
  }

  function showHint() {
    const lv = LEVELS[levelIndex];
    const stage = save.revealed[lv.id] || 0;
    const what = stage === 0 ? 'hint' : 'solution';
    const canPay = save.hints > 0;
    const offer = stage >= 2 ? '' : `
      <div class="col">
        <button class="btn big yellow" data-act="pay" ${canPay ? '' : 'disabled'}>USE 1 <span class="em">💡</span> FOR THE ${what.toUpperCase()}</button>
        <button class="btn big purple" data-act="ad"><span class="em">🎬</span> FREE ${what.toUpperCase()} (AD)</button>
      </div>
      <p class="small">${canPay ? 'Hints cost a star on this level.' : 'Out of 💡! Solve 3 levels in a row without hints to earn one.'}</p>`;
    showPanel(`
      ${Art.mascot(stage >= 2 ? 'happy' : 'think', 130)}
      <h2>${stage === 0 ? 'NEED A HINT?' : stage === 1 ? 'STILL STUCK?' : 'HERE YOU GO!'}</h2>
      ${hintBody(stage, lv)}
      ${offer}
      <button class="btn ghost" data-act="close">Keep trying</button>`, {
      pay: () => {
        if (save.hints <= 0) return;
        save.hints--;
        reveal(stage + 1);
      },
      ad: () => {
        SDK.rewardedBreak().then((ok) => {
          if (ok) reveal(stage + 1);
          else showHint(); // no ad shown: no reward, no message (Poki handles ad-block messaging)
        });
      },
      close: () => resumeQuiet(),
    }, 'hintc');
  }

  function reveal(stage) {
    save.revealed[LEVELS[levelIndex].id] = Math.min(2, stage);
    persist();
    updateHud();
    GameAudio.play('reveal');
    showHint();
  }

  // ---------- winning: stars, streak, brain power ----------
  const PRAISE = ['BRILLIANT!', 'GENIUS!', 'NAILED IT!', 'BIG BRAIN!', 'SO SNEAKY!', 'CLEVER!', 'SMART MOVE!', 'YOU GOT IT!', 'WOW!', 'TOO EASY!'];

  function starsFor(id, stats) {
    const revealed = save.revealed[id] || 0;
    let s = 3 - revealed;
    if (stats.mistakes >= 2) s--;
    if (stats.mistakes >= 5) s--;
    return Math.max(1, Math.min(3, s));
  }

  function onWin(msg, stats = { mistakes: 0, ms: 0 }) {
    SDK.gameplayStop();
    const lv = LEVELS[levelIndex];
    const stars = starsFor(lv.id, stats);
    const first = !save.solved[lv.id];
    const xpBefore = xp();
    const rankBefore = rankOf(xpBefore);
    save.solved[lv.id] = Math.max(save.solved[lv.id] || 0, stars);
    const xpAfter = xp();
    const rankAfter = rankOf(xpAfter);

    // streak: consecutive solves without hints
    let bulb = false;
    if (save.revealed[lv.id]) save.streak = 0;
    else if (first) {
      save.streak++;
      save.best = Math.max(save.best, save.streak);
      if (save.streak % 3 === 0) { save.hints++; bulb = true; }
    }
    persist();

    const last = levelIndex === LEVELS.length - 1;
    const r = Math.floor(Math.random() * PRAISE.length);
    const pct = (v, rk) => (rk.to > rk.from ? Math.min(100, ((v - rk.from) / (rk.to - rk.from)) * 100) : 100);
    const allDone = solvedCount() === LEVELS.length;
    showPanel(`
      ${Art.mascot('win', 140)}
      <h2>${last ? (allDone ? 'YOU BEAT THEM ALL!' : 'FINAL LEVEL DONE!') : PRAISE[r]}</h2>
      <div class="win-stars">${[0, 1, 2].map((i) => `<i data-i="${i}">${ICON.star}</i>`).join('')}</div>
      ${msg ? `<p>${msg}</p>` : ''}
      ${save.streak >= 2 && first && !save.revealed[lv.id] ? `<div class="streak"><span class="em">🔥</span> ${save.streak} IN A ROW!</div>` : ''}
      <div class="brain">
        <div class="brain-top"><span>BRAIN POWER</span><span class="rank">${rankAfter.name.toUpperCase()}</span></div>
        <div class="bar"><div class="fill" style="width:${pct(xpBefore, rankBefore)}%"></div></div>
        <div class="xp">+${xpAfter - xpBefore} XP</div>
      </div>
      ${bulb ? '<div class="reward" id="reward">+1 <span class="em">💡</span> STREAK BONUS!</div>' : ''}
      ${last
        ? `<p>${allDone ? `All ${LEVELS.length} puzzles solved!` : `Solved ${solvedCount()} of ${LEVELS.length}. Go back for the rest!`}</p>
           <button class="btn big yellow" data-act="levels">LEVELS</button>
           <button class="btn ghost" data-act="home">Home</button>`
        : `<button class="btn big yellow" data-act="next">NEXT LEVEL ▶</button>
           <div class="row"><button class="btn ghost" data-act="replay">Replay</button><button class="btn ghost" data-act="levels">Levels</button></div>`}
    `, {
      next: () => enterGameplay(levelIndex + 1),
      replay: () => enterGameplay(levelIndex),
      levels: () => showLevels(),
      home: () => showTitle(),
    }, 'win');

    // reveal sequence: stars pop in one by one, then the XP bar fills, then bonuses
    for (let i = 0; i < 3; i++) {
      later(250 + i * 280, () => {
        const el = panel.querySelector(`.win-stars i[data-i="${i}"]`);
        if (!el) return;
        if (i < stars) { el.classList.add('on'); GameAudio.play('star', { i }); }
        else el.classList.add('miss');
      });
    }
    const t = 250 + 3 * 280;
    later(t, () => {
      const fill = panel.querySelector('.brain .fill');
      if (!fill) return;
      if (rankAfter.i > rankBefore.i) {
        fill.style.width = '100%';
        later(500, () => {
          fill.style.transition = 'none'; fill.style.width = '0%';
          void fill.offsetWidth;
          fill.style.transition = ''; fill.style.width = pct(xpAfter, rankAfter) + '%';
          const rk = panel.querySelector('.brain .rank');
          if (rk) rk.classList.add('up');
          const badge = document.createElement('div');
          badge.className = 'rankup';
          badge.textContent = 'RANK UP!';
          const brain = panel.querySelector('.brain');
          if (brain) brain.appendChild(badge);
          GameAudio.play('levelup');
          fx.confetti(140);
        });
      } else fill.style.width = pct(xpAfter, rankAfter) + '%';
      if (xpAfter > xpBefore) for (let k = 0; k < 5; k++) later(k * 80, () => GameAudio.play('tick'));
    });
    if (save.streak >= 2 && first) later(t + 300, () => GameAudio.play('streak'));
    if (bulb) later(t + 700, flyBulb);
    if (last && allDone) later(t + 400, () => fx.confetti(160));
  }

  // a bulb flies from the reward line to the hint button
  function flyBulb() {
    const from = $('reward'), to = $('btn-hint');
    if (!from || !to) return;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'fly-bulb';
    f.textContent = '💡';
    f.style.left = (a.left + a.width / 2) + 'px';
    f.style.top = (a.top + a.height / 2) + 'px';
    document.body.appendChild(f);
    GameAudio.play('coin');
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const anim = f.animate([
      { transform: 'translate(-50%,-50%) scale(1)' },
      { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 80}px)) scale(1.6)` },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.8)` },
    ], { duration: 750, easing: 'ease-in-out' });
    anim.onfinish = () => {
      f.remove();
      updateHud();
      enterAnim(to, 'pop');
    };
  }

  // ---------- idle help: wiggle the hint button when the player seems stuck ----------
  setInterval(() => {
    const S = Engine.current();
    if (screen !== 'play' || !S || S.done || SDK.inAd) return;
    const stuck = performance.now() - S.t0 > 40000 || S.mistakes >= 3;
    if (stuck && (save.revealed[LEVELS[levelIndex].id] || 0) < 2) enterAnim($('btn-hint'), 'nudge');
  }, 9000);

  // ---------- public hooks used by the engine ----------
  window.Game = {
    fx,
    onWin,
    onFirstInput() {
      GameAudio.unlock();
      if (screen === 'play') SDK.gameplayStart();
    },
  };

  // ---------- wiring ----------
  function press(id, fn) {
    $(id).addEventListener('click', () => { GameAudio.unlock(); GameAudio.play('click'); fn(); });
  }
  press('btn-menu', () => { if (screen === 'play') showPause(); });
  press('btn-hint', () => { if (screen === 'play' && !Engine.current().done) showHint(); });
  press('btn-restart', () => {
    if (screen === 'play' && !Engine.current().done) startLevel(levelIndex);
  });
  press('btn-play', () => {
    titleEl.classList.add('hidden');
    startLevel(firstPlayable());
    SDK.gameplayStart();
  });
  press('btn-levels', () => showLevels());
  press('btn-sfx', () => { save.sfx = !save.sfx; persist(); syncAudioButtons(); });
  press('btn-music', () => { save.music = !save.music; persist(); syncAudioButtons(); });

  // keep the host page from scrolling; ESC / P toggles pause on desktop
  window.addEventListener('keydown', (ev) => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '].includes(ev.key)) ev.preventDefault();
    if (SDK.inAd) return;
    if (ev.key === 'Escape' || ev.key === 'p' || ev.key === 'P') {
      if (screen === 'play') showPause();
      else if (screen === 'panel' && panel.querySelector('[data-act="resume"]')) enterGameplay(null);
    }
  });
  window.addEventListener('wheel', (ev) => ev.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', (ev) => ev.preventDefault());
  document.addEventListener('visibilitychange', () => GameAudio.setHidden(document.hidden));

  // ---------- boot ----------
  loadSave();
  syncAudioButtons();
  const timeout = new Promise((res) => setTimeout(res, 5000));
  const fonts = document.fonts && document.fonts.load
    ? Promise.all([document.fonts.load('20px "Luckiest Guy"'), document.fonts.load('20px "Patrick Hand"')]).catch(() => {})
    : Promise.resolve();
  Promise.race([Promise.all([SDK.init(), fonts]), timeout]).then(() => {
    Engine.layout();
    $('loading').classList.add('gone');
    setTimeout(() => $('loading').remove(), 400);
    SDK.loadingFinished();
    showTitle();
  });
})();
