/* =====================================================================
   6b. MONDE INFINI + SEED — biomes, grottes, minerais, végétation, chunks
   ---------------------------------------------------------------------
   Remplace l'ancien generateWorld() à monde fini. Le relief utilise le
   Perlin 2D re-seedable (fbm) ; on y superpose :
     • BIOMES (température / humidité) : plaines, forêt, désert, toundra ;
     • GROTTES (deux bruits 3D « ridged »), lacs de lave profonds ;
     • MINERAIS en filons par profondeur (charbon > fer > or > diamant) ;
     • VÉGÉTATION : herbes hautes, fleurs, cactus, et 3 essences d'arbres ;
     • COFFRE DE DÉPART près du spawn.

   Monde INFINI : découpé en chunks de 16×16 colonnes. Le terrain est généré
   autour du joueur à mesure qu'il se déplace (LOAD_RADIUS), et les chunks
   trop éloignés sont déchargés (UNLOAD_RADIUS, avec hystérésis). Chaque
   cellule est calculée de façon DÉTERMINISTE à partir de la SEED (bruit +
   hash), donc un même monde est reconstruit à l'identique : les modifications
   du joueur (journal `edits`) sont réappliquées quand un chunk est rechargé.
   ===================================================================== */

const CHUNK = 16;                     // côté d'un chunk, en cellules
const LOAD_RADIUS = 2;                // chunks chargés autour du joueur (5×5 = 80×80 cellules, ≈ 40×69 unités)
const UNLOAD_RADIUS = LOAD_RADIUS + 2; // hystérésis avant déchargement
const BIOME_IDS = ['plains', 'forest', 'desert', 'taiga'];

let worldSeed = 0;
const loadedChunks = new Set();       // "ci,cj" déjà générés (terrain de base)
const loadQueue = [];                 // "ci,cj" à générer (budget par frame)
const unloadQueue = [];               // "ci,cj" à libérer (budget par frame)

const chunkKey = (ci, cj) => ci + ',' + cj;
const chunkOf = (i, j) => ({ ci: Math.floor(i / CHUNK), cj: Math.floor(j / CHUNK) });
const cellInChunk = (i, j, ci, cj) => ci * CHUNK <= i && i < (ci + 1) * CHUNK && cj * CHUNK <= j && j < (cj + 1) * CHUNK;

/** Seed depuis l'URL (?seed=…) ou null. */
function seedFromURL() {
  const m = /[?&]seed=(-?\d+)/.exec(location.search);
  return m ? (parseInt(m[1], 10) >>> 0) : null;
}
/** Ré-assigne les bruits pour une seed donnée. */
function setWorldSeed(seed) {
  worldSeed = seed >>> 0;
  fbm = makePerlin(worldSeed);
  noise3 = makeNoise3(worldSeed);
}
/** Met à jour l'affichage de la seed dans le menu. */
function updateSeedLine() {
  const el = document.getElementById('seed-line');
  if (el) el.textContent = `🌱 Seed : ${worldSeed}`;
}

/* ---- Hauteur / biome / grottes d'une colonne (déterministe à partir de la seed) ---- */
function computeBiome(wx, wz) {
  const temp = fbm(wx * 0.028 + 500, wz * 0.028 + 500, 2), hum = fbm(wx * 0.03 - 300, wz * 0.03 + 800, 2);
  if (temp > 0.22 && hum < 0.05) return 2;        // désert
  if (temp < -0.26) return 3;                      // toundra
  if (hum > 0.1) return 1;                         // forêt
  return 0;                                        // plaines
}
const biomeIndexAt = (i, j) => computeBiome(i * HX, j * HROW);
function biomeAt(i, j) { return BIOME_IDS[biomeIndexAt(i, j)]; }
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
/** Hash de cellule déterministe, dépendant de la seed (minerais, végétation, arbres). */
const h2 = (a, b) => hash2(a ^ worldSeed, b ^ (worldSeed * 3));

/* ---- Colonne de terrain : sous-sol, surface, eau, végétation basse ---- */
function generateColumn(i, j) {
  const wx = i * HX, wz = j * HROW;
  const bio = biomeIndexAt(i, j);
  let n = fbm(wx * 0.045 + 100, wz * 0.045 + 100, 4);
  n = n * 0.5 + 0.5;
  n = Math.pow(n, 1.35);
  if (bio === 2) n = n * 0.75 + 0.08;                                  // désert plus plat
  const top = 1 + Math.round(n * 13);
  const beach = top <= WATER_LEVEL + 0.5;
  for (let k = 0; k <= top; k++) {
    let type;
    // ---- Grottes (jamais la bedrock ni les 2 blocs de surface) ----
    if (k > 0 && k < top - 1 && top > WATER_LEVEL + 1 && isCave(wx, k, wz)) {
      if (k <= 2 && noise3(wx * 0.2, 0, wz * 0.2) > 0.6) addBlock(i, j, k, 'lava', false);      // lacs de lave en profondeur
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
      if (type === 'stone') { const o = h2(i * 7 + k * 31, j * 13 + k * 17) % 1000; if (o < 30) type = 'coal_ore'; else if (o < 46 && k <= 9) type = 'iron_ore'; else if (o < 49 && k <= 3) type = 'diamond_ore'; }
      if (k === 1 && v > 0.42 && top > 8) type = 'lava';                       // poches de lave profondes
      if (k > 1 && type === 'stone' && h2(i * 3 + k, j * 5 - k) % 1000 < 6) type = 'mossy_cobble';
    }
    if (k === 0) type = 'stone';                                              // « bedrock » (protégée en survie)
    addBlock(i, j, k, type, false);
  }
  // Lacs / océans : blocs SOURCE d'eau au-dessus du fond, jusqu'au niveau WATER_LEVEL ; glace en toundra
  for (let k = top + 1; k <= WATER_LEVEL; k++) addBlock(i, j, k, (bio === 3 && k === WATER_LEVEL) ? 'ice' : 'water', false);
  // ---- Végétation de surface (blocs passables) et cactus ----
  if (!beach && top < 13) {
    const r = h2(i * 11 + 3, j * 17 + 5) % 1000;
    if (bio === 2) { if (r < 12) { const h = 1 + (r % 3); for (let k = 1; k <= h; k++) addBlock(i, j, top + k, 'cactus', false); } }
    else if (bio !== 3) {
      if (r < 140) addBlock(i, j, top + 1, 'tallgrass', false);
      else if (r < 152) addBlock(i, j, top + 1, 'flower_red', false);
      else if (r < 166) addBlock(i, j, top + 1, 'flower_yellow', false);
    }
  }
}

/* ---- Arbres : 3 essences (chêne/bouleau/sapin), feuilles transparentes ---- */
const _tv = new THREE.Vector3(), _lv = new THREE.Vector3();
function placeTree(i, j) {
  const top = heightAt(i, j), bio = biomeIndexAt(i, j);
  if (top <= WATER_LEVEL + 0.5 || top >= 13 || bio === 2) return false;
  if (Math.abs(i) < 5 && Math.abs(j) < 4) return false;                       // zone dégagée autour du spawn
  const density = bio === 1 ? 42 : bio === 3 ? 18 : 9;
  if (h2(i, j) % 1000 >= density) return false;
  const ex = blockAt(i, j, top + 1); if (ex) removeBlock(i, j, top + 1);      // remplace l'herbe haute
  const pine = bio === 3;
  const trunkH = pine ? 5 + (h2(j, i) % 3) : 4 + (h2(j, i) % 2);
  for (let k = top + 1; k <= top + trunkH; k++) { if (!blockAt(i, j, k)) addBlock(i, j, k, 'wood', false); }
  cellCenter(i, j, 0, _tv);
  for (let dj = -3; dj <= 3; dj++) for (let di = -6; di <= 6; di++) {
    const ii = i + di, jj = j + dj;
    cellCenter(ii, jj, 0, _lv);
    const d = Math.hypot(_lv.x - _tv.x, _lv.z - _tv.z);
    if (pine) {
      for (let k = top + 2; k <= top + trunkH + 1; k++) {
        const lvl = top + trunkH + 1 - k, rad = lvl === 0 ? 0.3 : ((lvl % 2) ? 1.6 : 0.9) * Math.min(1, 0.5 + lvl * 0.2);
        if (d <= rad && !blockAt(ii, jj, k)) addBlock(ii, jj, k, 'leaves', false);
      }
    } else {
      for (let k = top + trunkH - 2; k <= top + trunkH + 1; k++) {
        const rad = (k >= top + trunkH) ? (k === top + trunkH + 1 ? 0.8 : 1.35) : 1.9;
        if (d <= rad && !blockAt(ii, jj, k)) addBlock(ii, jj, k, 'leaves', false);
      }
    }
  }
  return true;
}
/** Décore les arbres du chunk ET de ses 8 voisins (les canopées débordent ; idempotent). */
function decorateTrees(ci, cj) {
  for (let cjj = cj - 1; cjj <= cj + 1; cjj++) for (let cii = ci - 1; cii <= ci + 1; cii++)
    for (let j = cjj * CHUNK; j < (cjj + 1) * CHUNK; j++) for (let i = cii * CHUNK; i < (cii + 1) * CHUNK; i++) placeTree(i, j);
}

/* ---- Coffre de départ (à 3 cellules du spawn) ---- */
let STARTER_CHEST = null, starterPlaced = false;
function placeStarterChest() {
  if (starterPlaced) return;
  const t = heightAt(3, 0);
  const ex = blockAt(3, 0, t + 1); if (ex) removeBlock(3, 0, t + 1);
  addBlock(3, 0, t + 1, 'chest', false);
  STARTER_CHEST = cellKey(3, 0, t + 1);
  starterPlaced = true;
}

/* ---- AO d'un chunk (+1 de marge) ---- */
function refreshChunkAO(ci, cj) {
  const i0 = (ci - 1) * CHUNK, i1 = (ci + 2) * CHUNK, j0 = (cj - 1) * CHUNK, j1 = (cj + 2) * CHUNK;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) for (let k = 0; k < 64; k++) { const b = blockAt(i, j, k); if (b) computeAO(b); }
}

/* ---- Décoration différée : les arbres (et l'AO) ne sont finalisés que lorsque
       le chunk ET ses 8 voisins sont générés (les canopées débordent).  Cela évite
       de redécorer 9× la même zone à chaque chargement de chunk. ---- */
const decoPending = new Set();        // "ci,cj" prêts à être décorés (3×3 chargé)
const decoDone = new Set();           // "ci,cj" déjà décorés

/* ---- Chargement / déchargement ---- */
function ensureChunk(ci, cj) {
  const key = chunkKey(ci, cj);
  if (loadedChunks.has(key)) return;
  loadedChunks.add(key);
  const i0 = ci * CHUNK, j0 = cj * CHUNK;
  if (LIGHT) LIGHT.bulk = true;                                        // ne pas marquer la boîte sale pour chaque bloc
  for (let j = j0; j < j0 + CHUNK; j++) for (let i = i0; i < i0 + CHUNK; i++) generateColumn(i, j);
  if (LIGHT) LIGHT.bulk = false;
  // Réapplique les modifications du joueur dans ce chunk (journal de sauvegarde)
  for (const [ekey, etype] of edits) {
    const [i, j, k] = ekey.split(',').map(Number);
    if (cellInChunk(i, j, ci, cj)) {
      const ex = blockAt(i, j, k);
      if (etype && TYPES[etype]) { if (ex) removeBlock(i, j, k); addBlock(i, j, k, etype); }
      else if (ex) removeBlock(i, j, k);
    }
  }
  placeStarterChest();
  for (const t of TYPE_IDS) if (terrain[t].dirty) flushLayer(terrain[t]);
  if (LIGHT) LIGHT.onChunkLoad(ci, cj);                                // marque la lumière sale (déférée)
  // Programme la décoration de ce chunk et de ses voisins déjà chargés
  for (let cjj = cj - 1; cjj <= cj + 1; cjj++) for (let cii = ci - 1; cii <= ci + 1; cii++) {
    const kk = chunkKey(cii, cjj);
    if (loadedChunks.has(kk) && !decoDone.has(kk)) decoPending.add(kk);
  }
}
/** Décore (arbres + AO) jusqu'à `budget` chunks dont le voisinage 3×3 est chargé. */
function updateDeco(budget) {
  while (budget-- > 0 && decoPending.size) {
    let processed = false;
    for (const key of decoPending) {
      const [ci, cj] = key.split(',').map(Number);
      let ready = true;
      for (let cjj = cj - 1; cjj <= cj + 1 && ready; cjj++) for (let cii = ci - 1; cii <= ci + 1; cii++)
        if (!loadedChunks.has(chunkKey(cii, cjj))) { ready = false; break; }
      if (!ready) continue;                                            // pas encore de voisinage complet
      decorateTrees(ci, cj);
      refreshChunkAO(ci, cj);
      decoPending.delete(key);
      decoDone.add(key);
      processed = true;
      break;
    }
    if (!processed) break;                                             // rien de prêt pour l'instant
  }
}
function unloadChunk(ci, cj) {
  const key = chunkKey(ci, cj);
  if (!loadedChunks.has(key)) return;
  loadedChunks.delete(key);
  decoDone.delete(key); decoPending.delete(key);
  const i0 = ci * CHUNK, j0 = cj * CHUNK;
  for (let j = j0; j < j0 + CHUNK; j++) for (let i = i0; i < i0 + CHUNK; i++) for (let k = 0; k < 64; k++) {
    const b = blockAt(i, j, k);
    if (b) removeBlock(i, j, k);
  }
  refreshChunkAO(ci, cj);
  if (LIGHT) LIGHT.onChunkUnload(ci, cj);
}

/** Charge/décharge les chunks autour du joueur, avec un budget par frame (anti-saccades).
    Le chunk du joueur est TOUJOURS garanti chargé (le sol existe sous ses pieds). */
function updateChunks(px, pz, force = false) {
  const c = worldToCell(px, 0, pz), pc = chunkOf(c.i, c.j);
  if (!loadedChunks.has(chunkKey(pc.ci, pc.cj))) ensureChunk(pc.ci, pc.cj);   // garantie : chunk du joueur
  for (let cj = pc.cj - LOAD_RADIUS; cj <= pc.cj + LOAD_RADIUS; cj++)
    for (let ci = pc.ci - LOAD_RADIUS; ci <= pc.ci + LOAD_RADIUS; ci++) {
      const key = chunkKey(ci, cj);
      if (!loadedChunks.has(key) && !loadQueue.includes(key)) loadQueue.push(key);
    }
  for (const key of loadedChunks) {
    const [ci, cj] = key.split(',').map(Number);
    if ((Math.abs(ci - pc.ci) > UNLOAD_RADIUS || Math.abs(cj - pc.cj) > UNLOAD_RADIUS) && !unloadQueue.includes(key)) unloadQueue.push(key);
  }
  let budget = force ? 400 : 4;
  while (budget-- > 0 && loadQueue.length) {
    const key = loadQueue.shift();
    if (!loadedChunks.has(key)) { const [ci, cj] = key.split(',').map(Number); ensureChunk(ci, cj); }
  }
  // Déchargement immédiat (peu coûteux, hors de vue) : jamais de retard de mémoire.
  while (unloadQueue.length) {
    const key = unloadQueue.shift();
    if (loadedChunks.has(key)) {
      const [ci, cj] = key.split(',').map(Number);
      if (Math.abs(ci - pc.ci) > UNLOAD_RADIUS || Math.abs(cj - pc.cj) > UNLOAD_RADIUS) unloadChunk(ci, cj);
    }
  }
  updateDeco(force ? 10000 : 2);                                 // arbres + AO différés (budget par frame)
}
/** Chargement SYNCHRONE de tout le rayon (spawn, tp, restauration de sauvegarde). */
function ensureChunksAround(px, pz, force = false) {
  const c = worldToCell(px, 0, pz), pc = chunkOf(c.i, c.j);
  for (let cj = pc.cj - LOAD_RADIUS; cj <= pc.cj + LOAD_RADIUS; cj++)
    for (let ci = pc.ci - LOAD_RADIUS; ci <= pc.ci + LOAD_RADIUS; ci++) ensureChunk(ci, cj);
  for (const key of [...loadedChunks]) {
    const [ci, cj] = key.split(',').map(Number);
    if (Math.abs(ci - pc.ci) > UNLOAD_RADIUS || Math.abs(cj - pc.cj) > UNLOAD_RADIUS) unloadChunk(ci, cj);
  }
  updateDeco(10000);                                             // finalise toute la décoration du rayon
  for (const b of blocks.values()) computeAO(b);                 // AO complète (les arbres ont pu changer les voisinages)
  for (const t of TYPE_IDS) flushLayer(terrain[t]);
}

/** Purge complète du monde chargé (blocs, couches, entités, lumière) — conserve `edits`. */
function resetLoadedWorld() {
  while (mobs.length) removeMob(mobs.length - 1);
  for (const it of items) scene.remove(it.mesh); items.length = 0;
  if (typeof primedTNT !== 'undefined') { for (const e of primedTNT) scene.remove(e.mesh); primedTNT.length = 0; }
  if (typeof arrows !== 'undefined') { for (const a of arrows) scene.remove(a.mesh); arrows.length = 0; }
  if (typeof CHESTS !== 'undefined') { CHESTS.clear(); openChestKey = null; }
  blocks.clear();
  for (const t of TYPE_IDS) { const L = terrain[t]; L.mesh.count = 0; L.idxToKey.length = 0; if (L.depthPre) L.depthPre.count = 0; L.dirty = true; }
  loadedChunks.clear(); loadQueue.length = 0; unloadQueue.length = 0;
  decoPending.clear(); decoDone.clear();
  pending.clear();
  starterPlaced = false; STARTER_CHEST = null;
  if (LIGHT) LIGHT.reset();
}

/* ---- Génération initiale (autour du spawn 0,0) ---- */
function generateWorld() {
  const fromURL = seedFromURL();
  setWorldSeed(fromURL !== null ? fromURL : ((Math.random() * 0x7fffffff) | 0));
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('seed') !== String(worldSeed)) { u.searchParams.set('seed', worldSeed); history.replaceState(null, '', u.toString()); }
  } catch {}
  updateSeedLine();
  ensureChunksAround(0, 0, true);
}
generateWorld();
