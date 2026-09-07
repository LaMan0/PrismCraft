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

   Monde INFINI : les tableaux de lumière sont stockés PAR CHUNK (16×16×64).
   Le BFS de propagation traverse les frontières de chunk via l'index global
   (i,j,k) → chunk ; les cellules hors des chunks chargés sont traitées comme
   ciel ouvert (sky 15) / obscurité (blk 0). Les chargements/déchargements de
   chunks marquent des régions « sales » qui sont recalculées UNE FOIS PAR
   FRAME (LIGHT.update), jamais de façon synchrone par chunk.
   ===================================================================== */
const LIGHT_KMAX = 64;
const LIGHT_U = { uSkyLight: { value: 1 } };                 // uniform partagé par toutes les couches
{
  const CS = CHUNK, CN = CS * CS * LIGHT_KMAX;
  const chunks = new Map();                                  // "ci,cj" → { ci, cj, sky, blk, opac, src }
  const dirty = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity, any: false };
  const lightDirtyChunks = new Set();                        // "ci,cj" à recalculer (chargement/déchargement)
  const chunkKey = (ci, cj) => ci + ',' + cj;
  const chunkOf = (i, j) => ({ ci: Math.floor(i / CS), cj: Math.floor(j / CS) });

  function newChunk(ci, cj) {
    return { ci, cj, sky: new Uint8Array(CN), blk: new Uint8Array(CN), opac: new Uint8Array(CN), src: new Uint8Array(CN) };
  }
  function chunkAt(i, j) { const c = chunkOf(i, j); return chunks.get(chunkKey(c.ci, c.cj)); }
  const idOf = (li, lj, k) => (k * CS + lj) * CS + li;

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
  const opacAt = (i, j, k) => {
    if (k < 0 || k >= LIGHT_KMAX) return 0;
    const ch = chunkAt(i, j); if (!ch) return 0;
    return ch.opac[idOf(i - ch.ci * CS, j - ch.cj * CS, k)];
  };
  const skyAt = (i, j, k) => {
    if (k < 0) return 0;
    if (k >= LIGHT_KMAX) return 15;
    const ch = chunkAt(i, j); if (!ch) return 15;            // chunk non chargé = ciel ouvert
    return ch.sky[idOf(i - ch.ci * CS, j - ch.cj * CS, k)];
  };
  const blkAt = (i, j, k) => {
    if (k < 0 || k >= LIGHT_KMAX) return 0;
    const ch = chunkAt(i, j); if (!ch) return 0;
    return ch.blk[idOf(i - ch.ci * CS, j - ch.cj * CS, k)];
  };

  /* BFS trans-chunk : file de [chunk, idLocal] pour éviter toute alloc de clé. */
  const queue = [];
  function propagate(arrKey) {
    let head = 0;
    while (head < queue.length) {
      const ch = queue[head++], id = queue[head++];
      const L = ch[arrKey][id]; if (L <= 1) continue;
      const li = id % CS, lj = ((id / CS) | 0) % CS, k = (id / (CS * CS)) | 0;
      const i = ch.ci * CS + li, j = ch.cj * CS + lj;
      const nj = isUp(i, j) ? j - 1 : j + 1;
      // i±1 (même chunk sauf aux bords), voisin j (peut changer de chunk), k±1 (même chunk)
      const check = (ni, njj, nk) => {
        if (nk < 0 || nk >= LIGHT_KMAX) return;
        let nch = ch, nli = ni - ch.ci * CS, nlj = njj - ch.cj * CS;
        if (nli < 0 || nli >= CS || nlj < 0 || nlj >= CS) {
          const nc = chunkOf(ni, njj);
          nch = chunks.get(chunkKey(nc.ci, nc.cj)); if (!nch) return;
          nli = ni - nch.ci * CS; nlj = njj - nch.cj * CS;
        }
        const nid = idOf(nli, nlj, nk);
        const op = nch.opac[nid];
        if (op === 255) return;
        const nl = L - 1 - op;
        if (nl > nch[arrKey][nid]) { nch[arrKey][nid] = nl; queue.push(nch, nid); }
      };
      check(i - 1, j, k); check(i + 1, j, k); check(i, nj, k); check(i, j, k + 1); check(i, j, k - 1);
    }
  }
  /** Recalcule la lumière pour un ensemble de chunks chargés (clés "ci,cj"). */
  function recomputeSet(regionKeys) {
    for (const key of regionKeys) {
      let ch = chunks.get(key);
      if (!ch) { const [ci, cj] = key.split(',').map(Number); ch = newChunk(ci, cj); chunks.set(key, ch); }
      ch.sky.fill(0); ch.blk.fill(0);
      for (let lj = 0; lj < CS; lj++) for (let li = 0; li < CS; li++) {
        let v = 15;
        for (let k = LIGHT_KMAX - 1; k >= 0; k--) {
          const id = idOf(li, lj, k);
          if (v > 0) { const op = ch.opac[id]; if (op === 255) v = 0; else v = Math.max(0, v - op); }
          ch.sky[id] = v;
        }
      }
    }
    queue.length = 0;
    for (const key of regionKeys) { const ch = chunks.get(key); for (let id = 0; id < CN; id++) if (ch.sky[id] > 1) queue.push(ch, id); }
    propagate('sky');
    // Lumière des blocs : on re-sème depuis TOUTES les sources des chunks chargés,
    // pour que la lumière d'une torche traverse les frontières de chunk rechargées.
    queue.length = 0;
    for (const key of loadedChunks) { const ch = chunks.get(key); if (!ch) continue; for (let id = 0; id < CN; id++) if (ch.src[id]) { ch.blk[id] = ch.src[id]; queue.push(ch, id); } }
    propagate('blk');
  }
  /** Recalcule les chunks chargés qui intersectent la boîte absolue [i0..i1]×[j0..j1]. */
  function recomputeRegion(i0, j0, i1, j1) {
    const ci0 = Math.floor(i0 / CS), ci1 = Math.floor(i1 / CS), cj0 = Math.floor(j0 / CS), cj1 = Math.floor(j1 / CS);
    const region = [];
    for (const key of loadedChunks) {
      const [ci, cj] = key.split(',').map(Number);
      if (ci >= ci0 && ci <= ci1 && cj >= cj0 && cj <= cj1) region.push(key);
    }
    recomputeSet(region);
  }

  /* Écrit les attributs skyL / blkL d'un prisme (même repérage que computeAO). */
  const _lc = new THREE.Vector3(), _ld = new THREE.Vector3();
  function writeLight(b) {
    const layer = b.layer; if (!layer.skyL) return;
    const own = TYPES[b.type].light || 0, op = opacAt(b.i, b.j, b.k), ownS = op === 255 ? 0 : skyAt(b.i, b.j, b.k), ownB = Math.max(own, op === 255 ? 0 : blkAt(b.i, b.j, b.k));
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
    bulk: false,
    /** Appelé par addBlock / removeBlock : maintient opac / src et agrandit la boîte sale. */
    onChange(i, j, k, type) {
      if (k < 0 || k >= LIGHT_KMAX) return;
      const c = chunkOf(i, j), key = chunkKey(c.ci, c.cj);
      let ch = chunks.get(key);
      if (!ch) { ch = newChunk(c.ci, c.cj); chunks.set(key, ch); }
      const id = idOf(i - c.ci * CS, j - c.cj * CS, k);
      ch.opac[id] = opacityOf(type); ch.src[id] = (type && TYPES[type].light) || 0;
      if (!this.ready || this.bulk) return;
      dirty.i0 = Math.min(dirty.i0, i); dirty.i1 = Math.max(dirty.i1, i); dirty.j0 = Math.min(dirty.j0, j); dirty.j1 = Math.max(dirty.j1, j); dirty.any = true;
    },
    /** Chunk fraîchement généré : seule SA lumière doit être calculée (le ciel est
        local par colonne ; les sources du chunk sont resemées globalement → les
        voisins reçoivent la lumière par propagation). */
    onChunkLoad(ci, cj) {
      lightDirtyChunks.add(chunkKey(ci, cj));
    },
    /** Chunk déchargé : libère ses tableaux et marque les voisins. */
    onChunkUnload(ci, cj) {
      chunks.delete(chunkKey(ci, cj));
      for (let cjj = cj - 1; cjj <= cj + 1; cjj++) for (let cii = ci - 1; cii <= ci + 1; cii++)
        if (loadedChunks.has(chunkKey(cii, cjj))) lightDirtyChunks.add(chunkKey(cii, cjj));
    },
    /** Calcul complet (après génération / restauration de sauvegarde). */
    computeAll() {
      const t0 = performance.now();
      recomputeSet([...loadedChunks]);
      for (const b of blocks.values()) writeLight(b);
      this.ready = true; dirty.any = false; dirty.i0 = dirty.j0 = Infinity; dirty.i1 = dirty.j1 = -Infinity;
      lightDirtyChunks.clear();
      this.lastMs = performance.now() - t0;
    },
    /** À appeler chaque frame : recalculs différés (chunks + modifications du joueur). */
    update() {
      const t0 = performance.now();
      // 1. lumière des chunks chargés/déchargés (une passe par frame)
      if (lightDirtyChunks.size) {
        const region = [...lightDirtyChunks];
        let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
        for (const key of region) {
          const [ci, cj] = key.split(',').map(Number);
          i0 = Math.min(i0, ci * CS); i1 = Math.max(i1, (ci + 1) * CS - 1);
          j0 = Math.min(j0, cj * CS); j1 = Math.max(j1, (cj + 1) * CS - 1);
        }
        recomputeSet(region);
        lightDirtyChunks.clear();
        refreshAttribs(i0, j0, i1, j1);
        this.lastMs = performance.now() - t0;
        return;                                             // une seule passe lourde par frame
      }
      // 2. boîte sale des modifications du joueur
      if (dirty.any) {
        const i0 = dirty.i0 - 16, i1 = dirty.i1 + 16, j0 = dirty.j0 - 16, j1 = dirty.j1 + 16;
        recomputeRegion(i0, j0, i1, j1);
        refreshAttribs(i0, j0, i1, j1);
        dirty.any = false; dirty.i0 = dirty.j0 = Infinity; dirty.i1 = dirty.j1 = -Infinity;
        this.lastMs = performance.now() - t0;
      }
    },
    /** Purge complète (nouvelle partie / changement de seed). */
    reset() {
      chunks.clear(); lightDirtyChunks.clear(); dirty.any = false; dirty.i0 = dirty.j0 = Infinity; dirty.i1 = dirty.j1 = -Infinity;
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
    lastMs: 0, chunks,
  };
}
// Remplit opac/src pour le monde déjà généré (les blocs ont été ajoutés avant que LIGHT existe), puis calcule tout
for (const b of blocks.values()) LIGHT.onChange(b.i, b.j, b.k, b.type);
LIGHT.computeAll();
