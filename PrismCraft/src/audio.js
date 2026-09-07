/* =====================================================================
   0. AUDIO PROCÉDURAL (WebAudio) — aucun fichier externe
   ---------------------------------------------------------------------
   Minecraft se reconnaît les yeux fermés : pas, « clac » de la pose, craquement
   du minage, « oof », sifflement du creeper, grognement du zombie.  Tous les
   effets sont SYNTHÉTISÉS ici (oscillateurs + bruit filtré + enveloppes), ce qui
   respecte la contrainte « un seul fichier » et évite toute question de droits.
   API : SFX.play('break', { pos, type, vol })  ·  SFX.setVolume(v)
   Le contexte audio n'est créé qu'au premier clic (politique des navigateurs).
   ===================================================================== */
const SFX = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let volume = 0.7;
  const ensure = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return false; }
    master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
    // Buffer de bruit blanc de 2 s réutilisé par tous les effets « bruités »
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let n = 0; n < d.length; n++) d[n] = Math.random() * 2 - 1;
    return true;
  };
  document.addEventListener('pointerdown', ensure, { once: false });
  document.addEventListener('keydown', ensure, { once: false });

  /** Gain enveloppé (attaque / déclin) branché sur le master, avec atténuation par distance. */
  const env = (t0, a, d, peak = 1, dist = 0) => {
    const g = ctx.createGain();
    const att = dist > 0 ? Math.max(0, 1 - dist / 18) : 1;              // portée ≈ 18 u
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak * att, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    g.connect(master); return g;
  };
  /** Rafale de bruit filtré (pas, casse, explosion…). */
  const noise = (t0, dur, { type = 'bandpass', freq = 1000, q = 1, peak = 0.5, dist = 0, sweep = null } = {}) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
    const g = env(t0, 0.005, dur, peak, dist);
    src.connect(f); f.connect(g); src.start(t0); src.stop(t0 + dur + 0.05);
  };
  /** Note d'oscillateur avec glissando optionnel. */
  const tone = (t0, dur, { type = 'square', freq = 440, to = null, peak = 0.3, dist = 0, a = 0.005 } = {}) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = env(t0, a, dur, peak, dist);
    o.connect(g); o.start(t0); o.stop(t0 + a + dur + 0.05);
  };
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---- Bibliothèque d'effets : nom → fonction(t0, opts) ---- */
  const LIB = {
    // Pas : bruit court dont la couleur dépend du matériau (herbe sourde, pierre claire, bois mat, sable feutré)
    step(t, o) {
      const m = o.type || 'grass';
      const p = m === 'grass' || m === 'leaves' || m === 'dirt' ? [500, 0.06, 0.18] : m === 'sand' || m === 'gravel' || m === 'snow' ? [1800, 0.07, 0.12] : m.includes('wood') || m === 'planks' || m === 'bookshelf' ? [700, 0.05, 0.22] : m === 'wool' ? [300, 0.06, 0.12] : [2600, 0.045, 0.2];
      noise(t, p[1], { freq: p[0] * rnd(0.9, 1.1), q: 0.8, peak: p[2] * (o.vol ?? 1), dist: o.dist });
    },
    // Casse : craquement grave + éclats
    break(t, o) { noise(t, 0.16, { type: 'lowpass', freq: 900, peak: 0.6, dist: o.dist, sweep: 200 }); noise(t + 0.02, 0.08, { freq: 2400, q: 2, peak: 0.25, dist: o.dist }); },
    // Coup de minage (répété)
    hit(t, o) { noise(t, 0.05, { freq: rnd(1500, 2200), q: 1.5, peak: 0.22, dist: o.dist }); },
    // Pose : « clac » sec
    place(t, o) { noise(t, 0.05, { type: 'lowpass', freq: 1200, peak: 0.55, dist: o.dist }); tone(t, 0.04, { type: 'triangle', freq: 180, to: 90, peak: 0.25 }); },
    // Ramassage : « pop » aigu qui monte
    pop(t) { tone(t, 0.09, { type: 'sine', freq: rnd(600, 900), to: 1500, peak: 0.25 }); },
    // Clic d'interface
    click(t) { tone(t, 0.03, { type: 'square', freq: 1100, peak: 0.12 }); },
    // « Oof » : deux notes descendantes nasillardes
    hurt(t) { tone(t, 0.12, { type: 'sawtooth', freq: 320, to: 180, peak: 0.28 }); tone(t + 0.04, 0.1, { type: 'square', freq: 200, to: 120, peak: 0.15 }); },
    // Manger : croquements réguliers
    eat(t) { for (let n = 0; n < 3; n++) noise(t + n * 0.12, 0.05, { type: 'lowpass', freq: 700, peak: 0.3 }); },
    burp(t) { tone(t, 0.25, { type: 'sawtooth', freq: 140, to: 80, peak: 0.25, a: 0.03 }); },
    // Plongeon / nage
    splash(t, o) { noise(t, 0.3, { type: 'bandpass', freq: 800, q: 0.5, peak: 0.4, dist: o.dist, sweep: 300 }); },
    // Explosion : boom grave + souffle
    explode(t, o) { noise(t, 1.1, { type: 'lowpass', freq: 300, peak: 1.0, dist: o.dist ? o.dist * 0.4 : 0, sweep: 60 }); tone(t, 0.5, { type: 'sine', freq: 90, to: 30, peak: 0.8, a: 0.01 }); noise(t + 0.05, 0.5, { freq: 2000, q: 0.5, peak: 0.3, dist: o.dist }); },
    // Sifflement du creeper (mèche, 1.5 s)
    fuse(t, o) { noise(t, 1.5, { type: 'highpass', freq: 2500, peak: 0.45, dist: o.dist }); },
    // Grognement du zombie : dent de scie grave avec vibrato
    zombie(t, o) { tone(t, 0.6, { type: 'sawtooth', freq: rnd(70, 95), to: 60, peak: 0.22, dist: o.dist, a: 0.08 }); tone(t + 0.1, 0.5, { type: 'square', freq: rnd(110, 140), to: 90, peak: 0.08, dist: o.dist, a: 0.05 }); },
    // Cliquetis du squelette
    skeleton(t, o) { for (let n = 0; n < 4; n++) noise(t + n * 0.07, 0.03, { freq: rnd(2500, 4000), q: 4, peak: 0.18, dist: o.dist }); },
    // Arc et flèche
    bow(t, o) { noise(t, 0.12, { type: 'bandpass', freq: 1200, q: 0.7, peak: 0.35, dist: o.dist, sweep: 400 }); tone(t, 0.1, { type: 'triangle', freq: 500, to: 250, peak: 0.12, dist: o.dist }); },
    arrowhit(t, o) { noise(t, 0.05, { type: 'lowpass', freq: 1500, peak: 0.3, dist: o.dist }); },
    // Cris d'animaux
    pig(t, o) { tone(t, 0.18, { type: 'sawtooth', freq: 300, to: 420, peak: 0.16, dist: o.dist, a: 0.02 }); tone(t + 0.18, 0.12, { type: 'sawtooth', freq: 420, to: 260, peak: 0.12, dist: o.dist }); },
    cow(t, o) { tone(t, 0.7, { type: 'sawtooth', freq: 150, to: 110, peak: 0.16, dist: o.dist, a: 0.1 }); },
    sheep(t, o) { for (let n = 0; n < 5; n++) tone(t + n * 0.08, 0.07, { type: 'square', freq: 330 + (n % 2) * 40, peak: 0.09, dist: o.dist }); },
    // Montée de niveau / XP
    levelup(t) { [523, 659, 784, 1047].forEach((f, n) => tone(t + n * 0.09, 0.25, { type: 'triangle', freq: f, peak: 0.2 })); },
    xp(t) { tone(t, 0.08, { type: 'sine', freq: rnd(1200, 2400), peak: 0.1 }); },
    // Ouverture / fermeture de coffre
    chest(t) { noise(t, 0.2, { type: 'lowpass', freq: 500, peak: 0.35 }); tone(t + 0.05, 0.12, { type: 'triangle', freq: 220, to: 330, peak: 0.1 }); },
    // Ambiance caverne : nappe grave inquiétante
    cave(t) { tone(t, 2.5, { type: 'sine', freq: rnd(60, 90), to: 45, peak: 0.18, a: 0.8 }); noise(t + 0.3, 2, { type: 'bandpass', freq: 400, q: 6, peak: 0.08 }); },
    // Lave / feu
    fizz(t, o) { noise(t, 0.4, { type: 'highpass', freq: 3000, peak: 0.3, dist: o.dist }); },
  };

  const lastPlayed = {};
  return {
    /** Joue un effet ; `pos` (Vector3) permet l'atténuation par distance au joueur (listener = SFX.listener). */
    play(name, o = {}) {
      if (!ensure() || !LIB[name] || volume <= 0) return;
      const now = performance.now();
      if (lastPlayed[name] && now - lastPlayed[name] < (o.minGap ?? 30)) return;   // anti-spam
      lastPlayed[name] = now;
      if (o.pos && this.listener) o.dist = o.pos.distanceTo(this.listener);
      if (o.dist > 20) return;
      try { LIB[name](ctx.currentTime, o); } catch { /* contexte fermé */ }
    },
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = volume; },
    get volume() { return volume; },
    listener: null,
  };
})();
