/* =====================================================================
   PrismCore — noyau partagé « main thread ⇄ Web Worker »
   ---------------------------------------------------------------------
   Fichier 100 % pur : aucune dépendance à THREE, au DOM ni à `window`.
   Il est chargé :
     • dans le Web Worker (inliné avant chunkWorker.js dans le Blob) ;
     • dans le thread principal (pour worldToCell / cellCenter / la visée).
   Il est donc LA source de vérité unique de la géométrie de la grille
   triangulaire, du bruit et de la génération de terrain.

   Contenu :
     1. constantes de la grille + topologie des faces d'un prisme
     2. bruit (Perlin 2D, value noise 3D, hash) — identique au moteur
     3. table des types de blocs (envoyée par le thread principal)
     4. génération déterministe d'un chunk (+ halo)
     5. éclairage voxel (sky + block, BFS) sur le volume rembourré
     6. maillage : suppression des faces cachées + AO par sommet
   ===================================================================== */
(function (root) {
  'use strict';

  /* ===================================================================
     1. GRILLE TRIANGULAIRE
     -------------------------------------------------------------------
     Prisme = CylinderGeometry(R, R, BH, 3).  R = S/√3 est le rayon
     circonscrit du triangle ; l'apothème (rayon inscrit) vaut R/2.
       UP   ((i+j) pair)  : pointe vers +Z, centre z = j·HROW + R/2
       DOWN ((i+j) impair): pointe vers −Z, centre z = j·HROW + R
     =================================================================== */
  const S = 1.0;
  const R = S / Math.sqrt(3);
  const HROW = 1.5 * R;          // pas Z entre deux rangées de la grille
  const HX = S / 2;              // pas X
  const BH = 1.0;                // hauteur d'un prisme
  const INRADIUS = R / 2;        // apothème : pas de marche « sans trou »
  const CHUNK = 16;              // côté d'un chunk, en cellules
  const KMAX = 64;               // k ∈ [0, KMAX[
  const WATER_LEVEL = 4;

  const isUp = (i, j) => ((i + j) & 1) === 0;
  const cellKey = (i, j, k) => i + ',' + j + ',' + k;
  /** Centre monde d'une cellule (mêmes formules que cellCenter() du moteur). */
  function centerX(i) { return i * HX; }
  function centerZ(j, up) { return j * HROW + (up ? 0.5 * R : R); }
  function centerY(k) { return k * BH + BH / 2; }
  function cellCenter(i, j, k, out) {
    out = out || { x: 0, y: 0, z: 0 };
    out.x = centerX(i); out.y = centerY(k); out.z = centerZ(j, isUp(i, j));
    return out;
  }
  /** Monde → cellule (identique à worldToCell() du moteur). */
  function worldToCell(x, y, z) {
    const k = Math.floor(y / BH);
    const j = Math.floor(z / HROW);
    const zl = z - j * HROW;
    const i0 = Math.floor(x / HX);
    const xl = x - i0 * HX;
    let i;
    if (isUp(i0, j)) i = (zl <= HROW * (1 - xl / HX)) ? i0 : i0 + 1;
    else i = (zl >= HROW * (xl / HX)) ? i0 : i0 + 1;
    return { i, j, k };
  }

  /* ---- Topologie : un prisme a 5 faces, 3 voisins latéraux ----------
     Face f (f = 0,1,2) : normale horizontale d'angle (f + 0.5)·120°,
     arête reliant les sommets d'anneau f et (f+1) % 3.
     La rotation 180° des prismes DOWN ajoute 180° à chaque normale mais
     NE permute PAS l'indexation : la face f relie toujours f et f+1.

       UP   : face 0 → (i+1, j)   face 1 → (i, j−1)   face 2 → (i−1, j)
       DOWN : face 0 → (i−1, j)   face 1 → (i, j+1)   face 2 → (i+1, j)
     (démonstration dans docs/ARCHITECTURE_CHUNKS.md §2.2)                */
  const NDI_UP = [1, 0, -1], NDJ_UP = [0, -1, 0];
  const NDI_DN = [-1, 0, 1], NDJ_DN = [0, 1, 0];
  const nbrDi = (f, up) => (up ? NDI_UP[f] : NDI_DN[f]);
  const nbrDj = (f, up) => (up ? NDJ_UP[f] : NDJ_DN[f]);

  /* Anneau du triangle dans le plan XZ, relatif au centre de la cellule. */
  const RX = [0, S / 2, -S / 2];
  const RZ = [R, -R / 2, -R / 2];
  const ringX = (f, up) => (up ? RX[f] : -RX[f]);
  const ringZ = (f, up) => (up ? RZ[f] : -RZ[f]);
  /* Normale sortante de la face f (avant rotation 180° des DOWN). */
  const NX = [Math.sin(Math.PI / 3), Math.sin(Math.PI), Math.sin(5 * Math.PI / 3)];
  const NZ = [Math.cos(Math.PI / 3), Math.cos(Math.PI), Math.cos(5 * Math.PI / 3)];

  /* ===================================================================
     2. BRUIT — recopié à l'identique du moteur (bit-à-bit).
        `bench/parity.mjs` vérifie cette égalité à l'exécution.
     =================================================================== */
  function makePerlin(seed) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const p = new Uint8Array(512);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const r = Math.floor(rnd() * (i + 1)); [perm[i], perm[r]] = [perm[r], perm[i]]; }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + t * (b - a);
    const grad = (h, x, y) => { switch (h & 3) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; default: return -x - y; } };
    function noise(x, y) {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      x -= Math.floor(x); y -= Math.floor(y);
      const u = fade(x), v = fade(y);
      const a = p[X] + Y, b = p[X + 1] + Y;
      return lerp(
        lerp(grad(p[a], x, y), grad(p[b], x - 1, y), u),
        lerp(grad(p[a + 1], x, y - 1), grad(p[b + 1], x - 1, y - 1), u), v);
    }
    return function fbm(x, y, octaves = 4, lac = 2.0, gain = 0.5) {
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) { sum += amp * noise(x * freq, y * freq); norm += amp; amp *= gain; freq *= lac; }
      return sum / norm;
    };
  }

  const hash2 = (i, j) => (((i * 73856093) ^ (j * 19349663)) >>> 0) % 100000;

  function makeNoise3(seed) {
    const h3 = (x, y, z) => {
      let n = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const fade = t => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    function noise(x, y, z) {
      const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
      const u = fade(x - X), v = fade(y - Y), w = fade(z - Z);
      return lerp(
        lerp(lerp(h3(X, Y, Z), h3(X + 1, Y, Z), u), lerp(h3(X, Y + 1, Z), h3(X + 1, Y + 1, Z), u), v),
        lerp(lerp(h3(X, Y, Z + 1), h3(X + 1, Y, Z + 1), u), lerp(h3(X, Y + 1, Z + 1), h3(X + 1, Y + 1, Z + 1), u), v), w);
    }
    return function fbm3(x, y, z, octaves = 2, lac = 2.0, gain = 0.5) {
      let amp = 1, freq = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) { sum += amp * noise(x * freq, y * freq, z * freq); norm += amp; amp *= gain; freq *= lac; }
      return sum / norm;
    };
  }

  /* ===================================================================
     3. TABLE DES TYPES DE BLOCS
     -------------------------------------------------------------------
     Le thread principal envoie la liste ordonnée des types (TYPE_IDS) et
     leurs propriétés.  id 0 = air ; id = index + 1.
     =================================================================== */
  const F_OPAQUE = 1, F_FLUID = 2, F_PASSABLE = 4, F_ALPHA = 8, F_FOLIAGE = 16;
  let T = null;                                    // table active
  function configure(cfg) {
    const n = cfg.types.length;
    const id = Object.create(null);
    T = {
      names: cfg.types.slice(), id,
      flags: new Uint8Array(n + 1),
      opac: new Uint8Array(n + 1),                 // atténuation lumineuse par pas
      light: new Uint8Array(n + 1),                // émission 0..15
      sx: new Float32Array(n + 1), sy: new Float32Array(n + 1), sz: new Float32Array(n + 1),
      count: n + 1,
    };
    for (let i = 0; i <= n; i++) { T.sx[i] = T.sy[i] = T.sz[i] = 1; }
    for (let idx = 0; idx < n; idx++) {
      const name = cfg.types[idx], b = cfg.defs[idx] || {}, nid = idx + 1;
      id[name] = nid;
      let f = 0;
      if (b.fluid) f |= F_FLUID;
      if (b.passable || b.plant) f |= F_PASSABLE;
      if (b.transparent) f |= F_ALPHA;
      if (!b.fluid && !b.transparent && !b.passable && !b.plant) f |= F_OPAQUE;
      if (b.foliage) f |= F_FOLIAGE;
      T.flags[nid] = f;
      T.opac[nid] = b.fluid ? (b.fam === 'water' ? 2 : 0)
        : (b.passable || b.plant) ? 0
          : name === 'leaves' ? 1
            : b.transparent ? 0 : 255;
      T.light[nid] = b.light || 0;
      if (b.scale) { T.sx[nid] = b.scale[0]; T.sy[nid] = b.scale[1]; T.sz[nid] = b.scale[2]; }
    }
    return T;
  }
  const isOpaqueId = (nid) => nid !== 0 && (T.flags[nid] & F_OPAQUE) !== 0;
  const isFluidId = (nid) => nid !== 0 && (T.flags[nid] & F_FLUID) !== 0;
  /** Un voisin masque-t-il la face du bloc `self` ?
      `self === -1` (sous le monde, k < 0) est traité comme un masque plein. */
  function occludes(nb, self) {
    if (self === -1) return true;
    if (nb === 0) return false;
    if (nb === self) return (T.flags[self] & F_FOLIAGE) === 0;   // feuillage : faces internes visibles
    return (T.flags[nb] & F_OPAQUE) !== 0;
  }

  /* ===================================================================
     4. GÉNÉRATION DÉTERMINISTE D'UN CHUNK (+ HALO)
     -------------------------------------------------------------------
     Port fidèle de src/worldgen.js : mêmes formules, mêmes constantes.
     Deux seules libertés, sans effet sur le résultat :
       • les prédicats purs de placeTree() sont réordonnés (le hash, le
         moins cher, est testé en premier) ;
       • addBlock()/blockAt() sont remplacés par des écritures directes
         dans un Uint8Array rembourré de PAD cellules.
     =================================================================== */
  let fbm = null, noise3 = null, worldSeed = 0;
  function setSeed(seed) {
    worldSeed = seed >>> 0;
    fbm = makePerlin(worldSeed);
    noise3 = makeNoise3(worldSeed);
  }
  const h2 = (a, b) => hash2(a ^ worldSeed, b ^ (worldSeed * 3));

  function computeBiome(wx, wz) {
    const temp = fbm(wx * 0.028 + 500, wz * 0.028 + 500, 2), hum = fbm(wx * 0.03 - 300, wz * 0.03 + 800, 2);
    if (temp > 0.22 && hum < 0.05) return 2;
    if (temp < -0.26) return 3;
    if (hum > 0.1) return 1;
    return 0;
  }
  const biomeIndexAt = (i, j) => computeBiome(i * HX, j * HROW);
  function heightAt(i, j) {
    const wx = i * HX, wz = j * HROW, bio = biomeIndexAt(i, j);
    let n = fbm(wx * 0.045 + 100, wz * 0.045 + 100, 4);
    n = n * 0.5 + 0.5;
    n = Math.pow(n, 1.35);
    if (bio === 2) n = n * 0.75 + 0.08;
    return 1 + Math.round(n * 13);
  }
  function isCave(wx, k, wz) {
    const a = Math.abs(noise3(wx * 0.10 + 7, k * 0.13 + 3, wz * 0.10 + 11) - 0.5);
    const b = Math.abs(noise3(wx * 0.09 - 5, k * 0.12 + 9, wz * 0.11 - 2) - 0.5);
    return a < 0.055 && b < 0.055;
  }

  /* ---- Volume rembourré : (CHUNK + 2·PAD)² × KMAX ------------------ */
  function makeVolume(pad) {
    const w = CHUNK + 2 * pad;
    const n = w * w * KMAX;
    return {
      pad, w,
      types: new Uint8Array(n),
      meta: new Uint8Array(n),                     // niveau de fluide 1..8
      sky: new Uint8Array(n),
      blk: new Uint8Array(n),
      idx(li, lj, k) { return (k * w + lj) * w + li; },
    };
  }
  /** (i, j) monde → index de colonne dans le volume rembourré. */
  function colBase(V, i, j, ci, cj) {
    const li = i - ci * CHUNK + V.pad, lj = j - cj * CHUNK + V.pad;
    if (li < 0 || li >= V.w || lj < 0 || lj >= V.w) return -1;
    return lj * V.w + li;
  }
  const getAt = (V, i, j, k, ci, cj) => {
    if (k < 0 || k >= KMAX) return 0;
    const b = colBase(V, i, j, ci, cj);
    return b < 0 ? 0 : V.types[b + k * V.w * V.w];
  };
  const setAt = (V, i, j, k, nid, meta, ci, cj) => {
    if (k < 0 || k >= KMAX) return;
    const b = colBase(V, i, j, ci, cj);
    if (b < 0) return;
    const p = b + k * V.w * V.w;
    V.types[p] = nid; if (meta !== undefined) V.meta[p] = meta;
  };

  /** Colonne de terrain (port de generateColumn()). */
  function generateColumn(V, i, j, ci, cj) {
    const base = colBase(V, i, j, ci, cj);
    if (base < 0) return;
    const wx = i * HX, wz = j * HROW;
    const bio = biomeIndexAt(i, j);
    let n = fbm(wx * 0.045 + 100, wz * 0.045 + 100, 4);
    n = n * 0.5 + 0.5;
    n = Math.pow(n, 1.35);
    if (bio === 2) n = n * 0.75 + 0.08;
    const top = 1 + Math.round(n * 13);
    const beach = top <= WATER_LEVEL + 0.5;
    const plane = V.w * V.w;
    const put = (k, name, meta) => {
      const nid = T.id[name]; if (!nid) return;
      V.types[base + k * plane] = nid;
      V.meta[base + k * plane] = meta || 0;
    };
    for (let k = 0; k <= top; k++) {
      let type;
      if (k > 0 && k < top - 1 && top > WATER_LEVEL + 1 && isCave(wx, k, wz)) {
        if (k <= 2 && noise3(wx * 0.2, 0, wz * 0.2) > 0.6) put(k, 'lava', 8);
        continue;
      }
      if (k === top) {
        if (beach) type = 'sand';
        else if (top >= 13 || bio === 3) type = 'snow';
        else if (bio === 2) type = 'sand';
        else type = 'grass';
      } else if (k >= top - 3) {
        type = (beach || bio === 2) ? (k >= top - 1 ? 'sand' : 'sandstone') : (bio === 3 && k === top - 1 ? 'dirt' : 'dirt');
      } else {
        const v = fbm(wx * 0.11 + k * 0.17 + 900, wz * 0.11 - k * 0.13 + 300, 2);
        type = v > 0.34 ? 'granite' : v < -0.36 ? 'diorite' : (v > 0.2 && v < 0.26) ? 'andesite' : (v < -0.2 && v > -0.26 && k > 1) ? 'gravel' : 'stone';
        if (k <= 4 && k > 0 && v > -0.05 && v < 0.05 && top > 6) type = 'gold';
        if (type === 'stone') {
          const o = h2(i * 7 + k * 31, j * 13 + k * 17) % 1000;
          if (o < 30) type = 'coal_ore'; else if (o < 46 && k <= 9) type = 'iron_ore'; else if (o < 49 && k <= 3) type = 'diamond_ore';
        }
        if (k === 1 && v > 0.42 && top > 8) type = 'lava';
        if (k > 1 && type === 'stone' && h2(i * 3 + k, j * 5 - k) % 1000 < 6) type = 'mossy_cobble';
      }
      if (k === 0) type = 'stone';
      put(k, type, (T.flags[T.id[type]] & F_FLUID) ? 8 : 0);
    }
    for (let k = top + 1; k <= WATER_LEVEL; k++) {
      const isIce = bio === 3 && k === WATER_LEVEL;
      put(k, isIce ? 'ice' : 'water', isIce ? 0 : 8);
    }
    if (!beach && top < 13) {
      const r = h2(i * 11 + 3, j * 17 + 5) % 1000;
      if (bio === 2) { if (r < 12) { const h = 1 + (r % 3); for (let k = 1; k <= h; k++) put(top + k, 'cactus'); } }
      else if (bio !== 3) {
        if (r < 140) put(top + 1, 'tallgrass');
        else if (r < 152) put(top + 1, 'flower_red');
        else if (r < 166) put(top + 1, 'flower_yellow');
      }
    }
  }

  /** Un arbre (port de placeTree(), prédicats purs réordonnés). */
  function placeTree(V, i, j, ci, cj) {
    const density0 = h2(i, j) % 1000;
    if (density0 >= 42) return false;                     // test le moins cher d'abord
    const top = heightAt(i, j), bio = biomeIndexAt(i, j);
    if (top <= WATER_LEVEL + 0.5 || top >= 13 || bio === 2) return false;
    if (Math.abs(i) < 5 && Math.abs(j) < 4) return false;
    const density = bio === 1 ? 42 : bio === 3 ? 18 : 9;
    if (density0 >= density) return false;
    const pine = bio === 3;
    const trunkH = pine ? 5 + (h2(j, i) % 3) : 4 + (h2(j, i) % 2);
    const WOOD = T.id.wood, LEAF = T.id.leaves;
    if (!WOOD || !LEAF) return false;
    // remplace l'herbe haute au-dessus du tronc
    const exBase = colBase(V, i, j, ci, cj);
    if (exBase >= 0 && V.types[exBase + (top + 1) * V.w * V.w]) V.types[exBase + (top + 1) * V.w * V.w] = 0;
    for (let k = top + 1; k <= top + trunkH; k++) {
      const b = colBase(V, i, j, ci, cj);
      if (b >= 0 && !V.types[b + k * V.w * V.w]) V.types[b + k * V.w * V.w] = WOOD;
    }
    const tx = centerX(i), tz = centerZ(j, isUp(i, j));
    for (let dj = -3; dj <= 3; dj++) for (let di = -6; di <= 6; di++) {
      const ii = i + di, jj = j + dj;
      const lx = centerX(ii), lz = centerZ(jj, isUp(ii, jj));
      const d = Math.hypot(lx - tx, lz - tz);
      const b = colBase(V, ii, jj, ci, cj);
      if (b < 0) continue;
      if (pine) {
        for (let k = top + 2; k <= top + trunkH + 1; k++) {
          const lvl = top + trunkH + 1 - k;
          const rad = lvl === 0 ? 0.3 : ((lvl % 2) ? 1.6 : 0.9) * Math.min(1, 0.5 + lvl * 0.2);
          if (d <= rad && !V.types[b + k * V.w * V.w]) V.types[b + k * V.w * V.w] = LEAF;
        }
      } else {
        for (let k = top + trunkH - 2; k <= top + trunkH + 1; k++) {
          const rad = (k >= top + trunkH) ? (k === top + trunkH + 1 ? 0.8 : 1.35) : 1.9;
          if (d <= rad && !V.types[b + k * V.w * V.w]) V.types[b + k * V.w * V.w] = LEAF;
        }
      }
    }
    return true;
  }

  /**
   * Génère le chunk (ci, cj) dans un volume rembourré de `pad` cellules.
   * Le halo sert à la suppression des faces cachées, à l'AO et à la lumière
   * aux frontières.  Les canopées débordant de ±6 cellules en i et ±3 en j,
   * on balaie les troncs sur les chunks 3×3 (comme decorateTrees()).
   */
  function generateChunkVolume(ci, cj, pad, V) {
    V = V || makeVolume(pad);
    V.types.fill(0); V.meta.fill(0); V.sky.fill(0); V.blk.fill(0);
    const i0 = ci * CHUNK - pad, i1 = ci * CHUNK + CHUNK + pad;
    const j0 = cj * CHUNK - pad, j1 = cj * CHUNK + CHUNK + pad;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) generateColumn(V, i, j, ci, cj);
    const ti0 = ci * CHUNK - CHUNK, ti1 = ci * CHUNK + 2 * CHUNK;
    const tj0 = cj * CHUNK - CHUNK, tj1 = cj * CHUNK + 2 * CHUNK;
    for (let j = tj0; j < tj1; j++) for (let i = ti0; i < ti1; i++) placeTree(V, i, j, ci, cj);
    return V;
  }

  /* ===================================================================
     5. ÉCLAIRAGE VOXEL (sky + block) — BFS, port de src/lighting.js
     =================================================================== */
  const lightQueue = [];
  function computeLight(V) {
    const w = V.w, plane = w * w, CN = plane * KMAX;
    const types = V.types, opac = T.opac;
    /* Sky : descente exacte par colonne (le ciel vient de la verticale). */
    for (let c = 0; c < plane; c++) {
      let v = 15;
      for (let k = KMAX - 1; k >= 0; k--) {
        const p = c + k * plane, o = opac[types[p]];
        if (v > 0) { if (o === 255) v = 0; else v = Math.max(0, v - o); }
        V.sky[p] = v;
      }
    }
    const propagate = (arr) => {
      let head = 0;
      while (head < lightQueue.length) {
        const id = lightQueue[head++];
        const L = arr[id]; if (L <= 1) continue;
        const li = id % w, lj = ((id / w) | 0) % w, k = (id / plane) | 0;
        // CHUNK est pair → isUp(i, j) monde == isUp(li − pad, lj − pad)
        const up = (((li - V.pad) + (lj - V.pad)) & 1) === 0;
        const nj = up ? lj - 1 : lj + 1;
        const check = (ni, njj, nk) => {
          if (nk < 0 || nk >= KMAX || ni < 0 || ni >= w || njj < 0 || njj >= w) return;
          const nid = (nk * w + njj) * w + ni;
          const o = opac[types[nid]];
          if (o === 255) return;
          const nl = L - 1 - o;
          if (nl > arr[nid]) { arr[nid] = nl; lightQueue.push(nid); }
        };
        check(li - 1, lj, k); check(li + 1, lj, k); check(li, nj, k);
        check(li, lj, k + 1); check(li, lj, k - 1);
      }
    };
    lightQueue.length = 0;
    for (let id = 0; id < CN; id++) if (V.sky[id] > 1) lightQueue.push(id);
    propagate(V.sky);
    lightQueue.length = 0;
    for (let id = 0; id < CN; id++) { const s = T.light[types[id]]; if (s) { V.blk[id] = s; lightQueue.push(id); } }
    propagate(V.blk);
  }

  /* ===================================================================
     6. MAILLAGE — suppression des faces cachées + AO par sommet
     -------------------------------------------------------------------
     Sortie : un maillage fusionné par couche (« opaque » / « blend »),
     en coordonnées LOCALES au chunk (mesh.position porte l'origine).
     =================================================================== */
  function makeBuilder() {
    return {
      pos: new Float32Array(4096 * 3), nrm: new Int8Array(4096 * 3),
      uv: new Float32Array(4096 * 2), shd: new Uint8Array(4096 * 4),
      idx: new Uint32Array(4096 * 3), nv: 0, ni: 0,
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    };
  }
  function grow(B) {
    const n = B.pos.length / 3 * 2;
    const p = new Float32Array(n * 3); p.set(B.pos); B.pos = p;
    const q = new Int8Array(n * 3); q.set(B.nrm); B.nrm = q;
    const u = new Float32Array(n * 2); u.set(B.uv); B.uv = u;
    const s = new Uint8Array(n * 4); s.set(B.shd); B.shd = s;
  }
  function growIdx(B) {
    const n = B.idx.length * 2;
    const a = new Uint32Array(n); a.set(B.idx); B.idx = a;
  }
  /** Un sommet.  shd = [ao(0..255), sky(0..15)·16, blk(0..15)·16, tint(0..255)] */
  function pushV(B, x, y, z, nx, ny, nz, u, v, ao, sky, blk, tint) {
    if (B.nv * 3 >= B.pos.length) grow(B);
    const v3 = B.nv * 3, v2 = B.nv * 2, v4 = B.nv * 4;
    B.pos[v3] = x; B.pos[v3 + 1] = y; B.pos[v3 + 2] = z;
    B.nrm[v3] = Math.round(nx * 127); B.nrm[v3 + 1] = Math.round(ny * 127); B.nrm[v3 + 2] = Math.round(nz * 127);
    B.uv[v2] = u; B.uv[v2 + 1] = v;
    B.shd[v4] = ao; B.shd[v4 + 1] = sky * 16; B.shd[v4 + 2] = blk * 16; B.shd[v4 + 3] = tint;
    if (x < B.minX) B.minX = x; if (x > B.maxX) B.maxX = x;
    if (y < B.minY) B.minY = y; if (y > B.maxY) B.maxY = y;
    if (z < B.minZ) B.minZ = z; if (z > B.maxZ) B.maxZ = z;
    B.nv++;
  }
  function pushI(B, a, b, c) {
    if (B.ni + 3 > B.idx.length) growIdx(B);
    B.idx[B.ni++] = a; B.idx[B.ni++] = b; B.idx[B.ni++] = c;
  }
  /** AO « Minecraft » : 0 si les deux côtés sont pleins, sinon 3 − (s1+s2+coin). */
  const aoOf = (s1, s2, c) => ((s1 && s2) ? 0 : 3 - (s1 + s2 + c)) * 85;

  /**
   * Construit le maillage du chunk (ci, cj) à partir du volume rembourré.
   * Trois couches, une par matériau :
   *   opaque → depthWrite, aucune transparence
   *   cutout → alphaTest (feuilles, verre, végétation)
   *   fluid  → depthWrite false + pré-passe de profondeur
   * Les coordonnées sont LOCALES au chunk : c'est `mesh.position` qui porte
   * l'origine monde.  La sphère englobante reste donc petite et le frustum
   * culling de Three.js redevient exact (il est désactivé dans le moteur
   * actuel, où un seul InstancedMesh global couvre tout le monde).
   */
  function meshChunk(V, ci, cj, out) {
    out = out || {};
    const W = V.w, plane = W * W, pad = V.pad;
    const types = V.types, meta = V.meta, sky = V.sky, blk = V.blk;
    for (const name of ['opaque', 'cutout', 'fluid']) {
      if (!out[name]) out[name] = makeBuilder();
      const B = out[name];
      B.nv = 0; B.ni = 0;
      B.minX = B.minY = B.minZ = Infinity; B.maxX = B.maxY = B.maxZ = -Infinity;
    }
    const originX = ci * CHUNK * HX, originZ = cj * CHUNK * HROW;

    /** 1 si la cellule est occlusive (pour l'AO).  k < 0 = sous le monde = plein. */
    const solidAt = (i, j, k) => {
      if (k < 0) return 1;
      if (k >= KMAX) return 0;
      const b = colBase(V, i, j, ci, cj);
      if (b < 0) return 0;
      const nid = types[b + k * plane];
      return (nid !== 0 && (T.flags[nid] & F_OPAQUE) !== 0) ? 1 : 0;
    };
    /** Niveau lumineux échantillonné dans la cellule voisine d'une face. */
    const lightOf = (i, j, k, own, acc) => {
      const b = colBase(V, i, j, ci, cj);
      if (b < 0 || k < 0) { acc[0] = own[0]; acc[1] = own[1]; return acc; }
      if (k >= KMAX) { acc[0] = 15; acc[1] = own[1]; return acc; }
      const p = b + k * plane;
      acc[0] = sky[p] > own[0] ? sky[p] : own[0];
      acc[1] = blk[p] > own[1] ? blk[p] : own[1];
      return acc;
    };
    const L = [0, 0];

    for (let lj = 0; lj < CHUNK; lj++) for (let li = 0; li < CHUNK; li++) {
      const i = ci * CHUNK + li, j = cj * CHUNK + lj;
      const up = isUp(i, j);
      const col = (lj + pad) * W + (li + pad);
      const cx = centerX(i) - originX, cz = centerZ(j, up) - originZ;
      for (let k = 0; k < KMAX; k++) {
        const nid = types[col + k * plane];
        if (nid === 0) continue;
        const fl = T.flags[nid];
        const fluid = (fl & F_FLUID) !== 0;
        const B = fluid ? out.fluid : (fl & (F_ALPHA | F_PASSABLE)) !== 0 ? out.cutout : out.opaque;
        const level = fluid ? (meta[col + k * plane] || 8) : 8;
        const h = fluid ? 0.9 * level / 8 : T.sy[nid];
        const cy = k * BH + BH / 2 - (1 - h) * BH / 2;
        const yBot = cy - h * BH / 2, yTop = cy + h * BH / 2;
        const sx = T.sx[nid], sz = T.sz[nid];
        const em = T.light[nid];
        const own = [sky[col + k * plane], em > blk[col + k * plane] ? em : blk[col + k * plane]];
        /* Teinte par bloc (0.90 … 1.00), identique à writeColor() du moteur. */
        const hv = ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0;
        const tint = fluid ? 255 : Math.round((0.9 + ((hv % 1000) / 1000) * 0.1) * 255);

        const nb = [
          getAt(V, i + nbrDi(0, up), j + nbrDj(0, up), k, ci, cj),
          getAt(V, i + nbrDi(1, up), j + nbrDj(1, up), k, ci, cj),
          getAt(V, i + nbrDi(2, up), j + nbrDj(2, up), k, ci, cj),
        ];
        const above = getAt(V, i, j, k + 1, ci, cj);
        const belowId = k > 0 ? getAt(V, i, j, k - 1, ci, cj) : -1;   // −1 = sous le monde

        /* ---- chapeau supérieur (normale +Y) ---- */
        if (!occludes(above, nid)) {
          const base = B.nv;
          for (let f = 0; f < 3; f++) {
            const f2 = (f + 2) % 3;
            const s1 = solidAt(i + nbrDi(f, up), j + nbrDj(f, up), k + 1);
            const s2 = solidAt(i + nbrDi(f2, up), j + nbrDj(f2, up), k + 1);
            lightOf(i + nbrDi(f, up), j + nbrDj(f, up), k + 1, own, L);
            const rx = ringX(f, up) * sx, rz = ringZ(f, up) * sz;
            /* UV du chapeau : formule de THREE.CylinderGeometry (disque) puis
               remap du moteur (v → moitié haute de la texture).  rx/rz sont
               RELATIFS au centre de la cellule, jamais à l'origine du chunk. */
            pushV(B, cx + rx, yTop, cz + rz, 0, 1, 0,
              (rx / R + 1) / 2, 0.5 + (rz / R + 1) / 4,
              (3 - (s1 + s2)) * 85, L[0], L[1], tint);
          }
          pushI(B, base, base + 1, base + 2);
        }
        /* ---- chapeau inférieur (normale −Y) ---- */
        if (!occludes(belowId, nid)) {
          const base = B.nv;
          for (let f = 0; f < 3; f++) {
            const f2 = (f + 2) % 3;
            const s1 = solidAt(i + nbrDi(f, up), j + nbrDj(f, up), k - 1);
            const s2 = solidAt(i + nbrDi(f2, up), j + nbrDj(f2, up), k - 1);
            lightOf(i + nbrDi(f, up), j + nbrDj(f, up), k - 1, own, L);
            const rx = ringX(f, up) * sx, rz = ringZ(f, up) * sz;
            pushV(B, cx + rx, yBot, cz + rz, 0, -1, 0,
              (rx / R + 1) / 2, (rz / R + 1) / 4,
              (3 - (s1 + s2)) * 85, L[0], L[1], tint);
          }
          pushI(B, base, base + 2, base + 1);
        }
        /* ---- 3 faces latérales ---- */
        for (let f = 0; f < 3; f++) {
          if (occludes(nb[f], nid)) continue;
          const fA = (f + 2) % 3, fB = (f + 1) % 3;
          const ai = i + nbrDi(fA, up), aj = j + nbrDj(fA, up);
          const bi = i + nbrDi(fB, up), bj = j + nbrDj(fB, up);
          const ni2 = i + nbrDi(f, up), nj2 = j + nbrDj(f, up);
          const sTop = solidAt(ni2, nj2, k + 1), sBot = solidAt(ni2, nj2, k - 1);
          const aK = solidAt(ai, aj, k), aU = solidAt(ai, aj, k + 1), aD = solidAt(ai, aj, k - 1);
          const bK = solidAt(bi, bj, k), bU = solidAt(bi, bj, k + 1), bD = solidAt(bi, bj, k - 1);
          const aoT0 = aoOf(sTop, aK, aU), aoT1 = aoOf(sTop, bK, bU);
          const aoB0 = aoOf(sBot, aK, aD), aoB1 = aoOf(sBot, bK, bD);
          lightOf(ni2, nj2, k + 1, own, L); const ltS = L[0], ltB = L[1];
          lightOf(ni2, nj2, k, own, L); const lbS = L[0], lbB = L[1];
          const nx = up ? NX[f] : -NX[f], nz = up ? NZ[f] : -NZ[f];
          const x0 = cx + ringX(f, up) * sx, z0 = cz + ringZ(f, up) * sz;
          const x1 = cx + ringX((f + 1) % 3, up) * sx, z1 = cz + ringZ((f + 1) % 3, up) * sz;
          const base = B.nv;
          pushV(B, x0, yBot, z0, nx, 0, nz, 0, 0, aoB0, lbS, lbB, tint);
          pushV(B, x1, yBot, z1, nx, 0, nz, 1, 0, aoB1, lbS, lbB, tint);
          pushV(B, x1, yTop, z1, nx, 0, nz, 1, 1, aoT1, ltS, ltB, tint);
          pushV(B, x0, yTop, z0, nx, 0, nz, 0, 1, aoT0, ltS, ltB, tint);
          /* Diagonale du quad choisie selon l'AO : supprime la couture
             d'éclairage quand l'occlusion est anisotrope (règle Minecraft). */
          if (aoB0 + aoT1 > aoB1 + aoT0) { pushI(B, base, base + 1, base + 2); pushI(B, base, base + 2, base + 3); }
          else { pushI(B, base + 1, base + 2, base + 3); pushI(B, base + 1, base + 3, base); }
        }
      }
    }
    out.chunk = { ci, cj };
    return out;
  }

  /** Compacte un builder en TypedArrays prêts à être transférés (zéro copie). */
  function finish(B) {
    if (B.nv === 0) return null;
    const position = B.pos.slice(0, B.nv * 3);
    const normal = B.nrm.slice(0, B.nv * 3);
    const uv = B.uv.slice(0, B.nv * 2);
    const shade = B.shd.slice(0, B.nv * 4);
    const index = B.idx.slice(0, B.ni);
    const cx = (B.minX + B.maxX) / 2, cy = (B.minY + B.maxY) / 2, cz = (B.minZ + B.maxZ) / 2;
    let r2 = 0;
    for (let v = 0; v < B.nv; v++) {
      const dx = position[v * 3] - cx, dy = position[v * 3 + 1] - cy, dz = position[v * 3 + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz; if (d > r2) r2 = d;
    }
    return {
      position, normal, uv, shade, index,
      bounds: { cx, cy, cz, r: Math.sqrt(r2) },
      vertexCount: B.nv, indexCount: B.ni,
      bytes: position.byteLength + normal.byteLength + uv.byteLength + shade.byteLength + index.byteLength,
    };
  }


  /* ===================================================================
     7. API PUBLIÉE
     =================================================================== */
  const PrismCore = {
    /* constantes */
    S, R, HROW, HX, BH, CHUNK, KMAX, WATER_LEVEL, INRADIUS, PAD: 2,
    /* grille */
    isUp, cellKey, cellCenter, centerX, centerY, centerZ, worldToCell,
    nbrDi, nbrDj, ringX, ringZ, NX, NZ,
    /* bruit */
    makePerlin, makeNoise3, hash2, setSeed, get seed() { return worldSeed; },
    /* types */
    configure, get table() { return T; }, F_OPAQUE, F_FLUID, F_PASSABLE, F_ALPHA, F_FOLIAGE,
    /* génération */
    makeVolume, generateChunkVolume, computeBiome, heightAt, biomeIndexAt,
    computeLight,
    /* maillage */
    makeBuilder, meshChunk, finish,
    /* accès volume */
    getAt, setAt, colBase,
  };
  root.PrismCore = PrismCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = PrismCore;
})(typeof self !== 'undefined' ? self : globalThis);
