/* =====================================================================
   6c. ÉCLAIRAGE VOXEL « MINECRAFT » (lumière du ciel + lumière des blocs)
   ---------------------------------------------------------------------
   Minecraft stocke, pour chaque cellule d'air, deux niveaux 0..15 :
     • SKY   : 15 sous le ciel ouvert, propagé dans les grottes avec −1 par
               pas (−2 de plus dans l'eau, −1 dans les feuilles) ;
     • BLOCK : émis par les sources (torche 14, glowstone 15, lave 15…),
               propagé de la même façon.
   La luminosité finale d'une face = max(sky × jour, block) passée dans la
   courbe de Minecraft  b = (1−x)/(3x+1), x = 1 − niveau/15.
   Implémentation :
     • deux Uint8Array (sky, blk) indexés (k·WORLD_J + j)·WORLD_I + i, plus
       `opac` (255 = opaque, sinon atténuation supplémentaire) et `src`
       (niveau émis) tenus à jour par addBlock / removeBlock ;
     • propagation en largeur (BFS) sur les 5 voisins (3 latéraux + haut/bas)
       en n'utilisant QUE des tableaux typés (aucune chaîne, aucune alloc.) ;
     • mise à jour INCRÉMENTALE : chaque modification agrandit une boîte
       « sale » ; au plus une fois par frame la boîte étendue de 16 cellules
       (portée max = 15) est recalculée : remise à zéro, colonnes de ciel,
       sources internes, graines sur le pourtour (dont les valeurs ne peuvent
       pas avoir changé), puis BFS ;
     • chaque prisme reçoit 2 attributs instanciés (skyL, blkL) contenant les
       niveaux de ses 5 faces (5 quartets → entier < 2^20, exact en float32) ;
       le vertex shader (attachAO) retrouve la face et calcule la luminosité,
       le fragment shader multiplie l'éclairage Lambert et ajoute la lueur
       chaude des torches la nuit (uniform uSkyLight = 0.3 + 0.7·jour).
   ===================================================================== */
const LIGHT_KMAX = 64;
const LIGHT_N = WORLD_I * WORLD_J * LIGHT_KMAX;
const LIGHT_U = { uSkyLight: { value: 1 } };                 // uniform partagé par toutes les couches
{
  const sky = new Uint8Array(LIGHT_N), blk = new Uint8Array(LIGHT_N), opac = new Uint8Array(LIGHT_N), src = new Uint8Array(LIGHT_N);
  const STRIDE_J = WORLD_I, STRIDE_K = WORLD_I * WORLD_J;
  const idxOf = (i, j, k) => (k * WORLD_J + j) * WORLD_I + i;
  const inside = (i, j, k) => i >= 0 && i < WORLD_I && j >= 0 && j < WORLD_J && k >= 0 && k < LIGHT_KMAX;
  let kTop = 20;                                                          // plus haut bloc + marge (évite de parcourir 64 étages)
  const dirty = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity, any: false, full: false };
  /** Code d'opacité d'un type : 255 opaque · sinon atténuation supplémentaire par pas. */
  function opacityOf(type) {
    if (!type) return 0;
    const d = TYPES[type];
    if (d.fluid) return d.fam === 'water' ? 2 : 0;
    if (d.passable || d.plant) return 0;
    if (type === 'leaves') return 1;
    if (d.transparent) return 0;
    return 255;
  }
  const queue = new Int32Array(LIGHT_N);                                  // file BFS (indices), sans allocation
  /** Propagation BFS générique sur `arr` à partir des `count` graines déjà placées dans `queue`. */
  function propagate(arr, count) {
    let head = 0, tail = count;
    while (head < tail) {
      const id = queue[head++];
      const L = arr[id]; if (L <= 1) continue;
      const i = id % WORLD_I, j = ((id / WORLD_I) | 0) % WORLD_J, k = (id / STRIDE_K) | 0;
      // 5 voisins : i±1, voisin j (selon l'orientation UP/DOWN), k±1
      const nj = isUp(i, j) ? j - 1 : j + 1;
      const cand = [i - 1, j, k, i + 1, j, k, i, nj, k, i, j, k + 1, i, j, k - 1];
      for (let c = 0; c < 15; c += 3) {
        const ci = cand[c], cj = cand[c + 1], ck = cand[c + 2];
        if (!inside(ci, cj, ck)) continue;
        const nid = idxOf(ci, cj, ck), op = opac[nid];
        if (op === 255) continue;
        const nl = L - 1 - op;
        if (nl > arr[nid]) { arr[nid] = nl; if (tail < LIGHT_N) queue[tail++] = nid; }
      }
    }
  }
  /** Recalcule complètement la lumière dans la boîte [i0..i1]×[j0..j1] (tous les k ≤ kTop). */
  function recompute(i0, j0, i1, j1) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(WORLD_I - 1, i1); j1 = Math.min(WORLD_J - 1, j1);
    const kt = Math.min(LIGHT_KMAX - 1, kTop);
    // 1. remise à zéro + colonnes de ciel
    let n = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      let v = 15;
      for (let k = LIGHT_KMAX - 1; k >= 0; k--) {
        const id = idxOf(i, j, k); blk[id] = 0;
        if (v > 0) { const op = opac[id]; if (op === 255) v = 0; else v = Math.max(0, v - op); }
        sky[id] = v;
      }
    }
    // 2. graines ciel : cellules éclairées de la boîte dont un voisin pourrait recevoir moins + pourtour
    const seed = (arr, i, j, k) => { if (!inside(i, j, k)) return; const id = idxOf(i, j, k); if (arr[id] > 1) queue[n++] = id; };
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let k = 0; k <= kt; k++) seed(sky, i, j, k);
    for (let k = 0; k <= kt; k++) {
      for (let i = i0 - 1; i <= i1 + 1; i++) { seed(sky, i, j0 - 1, k); seed(sky, i, j1 + 1, k); }
      for (let j = j0; j <= j1; j++) { seed(sky, i0 - 1, j, k); seed(sky, i1 + 1, j, k); }
    }
    propagate(sky, n);
    // 3. lumière des blocs : sources internes + pourtour
    n = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let k = 0; k <= kt; k++) { const id = idxOf(i, j, k); if (src[id]) { blk[id] = src[id]; queue[n++] = id; } }
    for (let k = 0; k <= kt; k++) {
      for (let i = i0 - 1; i <= i1 + 1; i++) { seed(blk, i, j0 - 1, k); seed(blk, i, j1 + 1, k); }
      for (let j = j0; j <= j1; j++) { seed(blk, i0 - 1, j, k); seed(blk, i1 + 1, j, k); }
    }
    propagate(blk, n);
  }
  /** Niveaux (sky, blk) d'une cellule, hors monde = plein ciel. */
  const skyAt = (i, j, k) => inside(i, j, k) ? sky[idxOf(i, j, k)] : (k >= LIGHT_KMAX ? 15 : (i < 0 || i >= WORLD_I || j < 0 || j >= WORLD_J) ? 15 : 0);
  const blkAt = (i, j, k) => inside(i, j, k) ? blk[idxOf(i, j, k)] : 0;
  /* Écrit les attributs skyL / blkL d'un prisme : quartet 0 = dessus, 1 = dessous, 2..4 = faces latérales
     (même repérage que computeAO : direction locale tournée par l'orientation de l'instance). */
  const _lc = new THREE.Vector3(), _ld = new THREE.Vector3();
  function writeLight(b) {
    const layer = b.layer; if (!layer.skyL) return;
    const own = TYPES[b.type].light || 0, ownS = opac[idxOf(b.i, b.j, b.k)] === 255 ? 0 : skyAt(b.i, b.j, b.k), ownB = Math.max(own, opac[idxOf(b.i, b.j, b.k)] === 255 ? 0 : blkAt(b.i, b.j, b.k));
    let s = Math.max(ownS, skyAt(b.i, b.j, b.k + 1)) + Math.max(ownS, skyAt(b.i, b.j, b.k - 1)) * 16;
    let l = Math.max(ownB, blkAt(b.i, b.j, b.k + 1)) + Math.max(ownB, blkAt(b.i, b.j, b.k - 1)) * 16;
    cellCenter(b.i, b.j, b.k, _lc);
    const q = isUp(b.i, b.j) ? Q_UP : Q_DOWN;
    let mul = 256;
    for (let f = 0; f < 3; f++) {
      _ld.copy(AO_FACE_DIRS[f]).applyQuaternion(q);
      const c = worldToCell(_lc.x + _ld.x * 0.45, _lc.y, _lc.z + _ld.z * 0.45);
      s += Math.max(ownS, skyAt(c.i, c.j, c.k)) * mul; l += Math.max(ownB, blkAt(c.i, c.j, c.k)) * mul; mul *= 16;
    }
    if (layer.skyL.array[b.idx] !== s) { layer.skyL.array[b.idx] = s; layer.skyL.needsUpdate = true; }
    if (layer.blkL.array[b.idx] !== l) { layer.blkL.array[b.idx] = l; layer.blkL.needsUpdate = true; }
  }
  /** Ré-écrit les attributs de tous les prismes de la boîte (+1 de marge). */
  function refreshAttribs(i0, j0, i1, j1) {
    for (const b of blocks.values()) if (b.i >= i0 - 1 && b.i <= i1 + 1 && b.j >= j0 - 1 && b.j <= j1 + 1) writeLight(b);
  }
  LIGHT = {
    ready: false,
    /** Appelé par addBlock / removeBlock : maintient opac / src et agrandit la boîte sale. */
    onChange(i, j, k, type) {
      if (!inside(i, j, k)) return;
      const id = idxOf(i, j, k);
      opac[id] = opacityOf(type); src[id] = (type && TYPES[type].light) || 0;
      if (k + 2 > kTop) kTop = Math.min(LIGHT_KMAX - 1, k + 2);
      if (!this.ready) return;
      dirty.i0 = Math.min(dirty.i0, i); dirty.i1 = Math.max(dirty.i1, i); dirty.j0 = Math.min(dirty.j0, j); dirty.j1 = Math.max(dirty.j1, j); dirty.any = true;
    },
    /** Calcul complet (après la génération / le chargement d'une sauvegarde). */
    computeAll() {
      const t0 = performance.now();
      recompute(0, 0, WORLD_I - 1, WORLD_J - 1);
      for (const b of blocks.values()) writeLight(b);
      this.ready = true; dirty.any = false; dirty.i0 = dirty.j0 = Infinity; dirty.i1 = dirty.j1 = -Infinity;
      this.lastMs = performance.now() - t0;
    },
    /** À appeler chaque frame : traite la boîte sale (au plus un recalcul par frame). */
    update() {
      if (!dirty.any) return;
      const t0 = performance.now();
      const i0 = dirty.i0 - 16, i1 = dirty.i1 + 16, j0 = dirty.j0 - 16, j1 = dirty.j1 + 16;
      recompute(i0, j0, i1, j1);
      refreshAttribs(Math.max(0, i0), Math.max(0, j0), Math.min(WORLD_I - 1, i1), Math.min(WORLD_J - 1, j1));
      dirty.any = false; dirty.i0 = dirty.j0 = Infinity; dirty.i1 = dirty.j1 = -Infinity;
      this.lastMs = performance.now() - t0;
    },
    /** Facteur jour (0..1) → uniform ; la nuit garde un plancher « clair de lune » de 0.3. */
    setDaylight(d) { LIGHT_U.uSkyLight.value = 0.3 + 0.7 * d; },
    /** Niveaux (0..15) à une position monde. */
    levelsAt(x, y, z) { const c = worldToCell(x, y, z); return [skyAt(c.i, c.j, c.k), blkAt(c.i, c.j, c.k)]; },
    /** Luminosité 0.05..1 à une position (pour teinter les entités : mobs, objets). */
    brightnessAt(x, y, z) {
      const c = worldToCell(x, y, z);
      const lv = Math.max(skyAt(c.i, c.j, c.k) / 15 * LIGHT_U.uSkyLight.value, blkAt(c.i, c.j, c.k) / 15);
      const xx = 1 - lv; return ((1 - xx) / (3 * xx + 1)) * 0.95 + 0.05;
    },
    /** Attributs instanciés d'une couche (appelé par makeLayer via LIGHT_attach). */
    lastMs: 0, sky, blk, opac,
  };
}
// Remplit opac/src pour le monde déjà généré (les blocs ont été ajoutés avant que LIGHT existe), puis calcule tout
for (const b of blocks.values()) LIGHT.onChange(b.i, b.j, b.k, b.type);
LIGHT.computeAll();
