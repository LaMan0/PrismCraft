/* =====================================================================
   chunkmesh.js — gestion des chunks côté THREAD PRINCIPAL
   ---------------------------------------------------------------------
   Ce fragment ne fait AUCUN calcul de terrain : il pilote un pool de
   Web Workers, transforme les ArrayBuffer transférés en BufferGeometry,
   et gère frustum culling, pooling et libération GPU.

   Budget par frame : ~1 ms pour 3 chunks reçus (mesuré, bench/bench.mjs).

   Responsabilités
     1. pool de workers créés depuis un Blob (le jeu reste un fichier unique)
     2. file de priorité (tas binaire) : le chunk le plus proche d'abord
     3. réception → BufferGeometry + Mesh, sphère englobante fournie par le
        worker ⇒ `frustumCulled = true` redevient exact
     4. déchargement différé (requestIdleCallback) + geometry.dispose()
     5. store voxel Uint8Array = source de vérité (collisions, visée, physique)
     6. raycast DDA EXACT sur la grille triangulaire (aucun pas fixe,
        aucun Raycaster Three.js par frame)

   Utilisation :
     const CR = createChunkRenderer(THREE, { scene, workerSource, types, defs, seed });
     // dans animate() :
     CR.update(player.pos.x, player.pos.z);
     // visée :
     const hit = CR.raycast(eye, dir, REACH);   // { i, j, k, face, place:{i,j,k}, normal }
   ===================================================================== */
function createChunkRenderer(THREE, opts) {
  const {
    scene, workerSource, types, defs, seed,
    radius = 4, unloadRadius = 6, workers = 0,
    maxApplyPerFrame = 3, maxUnloadPerIdle = 4,
  } = opts;

  /* ---- constantes de la grille (identiques à PrismCore / au moteur) ---- */
  const S = 1.0, R = S / Math.sqrt(3), HROW = 1.5 * R, HX = S / 2, BH = 1.0;
  const CHUNK = 16, KMAX = 64, PAD = 2, VW = CHUNK + 2 * PAD;
  const INRADIUS = R / 2;
  const isUp = (i, j) => ((i + j) & 1) === 0;
  const NX = [Math.sin(Math.PI / 3), Math.sin(Math.PI), Math.sin(5 * Math.PI / 3)];
  const NZ = [Math.cos(Math.PI / 3), Math.cos(Math.PI), Math.cos(5 * Math.PI / 3)];
  const NDI_UP = [1, 0, -1], NDJ_UP = [0, -1, 0];
  const NDI_DN = [-1, 0, 1], NDJ_DN = [0, 1, 0];
  const nbrDi = (f, up) => (up ? NDI_UP[f] : NDI_DN[f]);
  const nbrDj = (f, up) => (up ? NDJ_UP[f] : NDJ_DN[f]);
  const centerZ = (j, up) => j * HROW + (up ? 0.5 * R : R);

  const ID = Object.create(null);
  types.forEach((t, n) => { ID[t] = n + 1; });
  const NAME = types.slice();
  const isOpaqueId = (nid) => nid !== 0 && !defs[nid - 1].fluid && !defs[nid - 1].transparent
    && !defs[nid - 1].passable && !defs[nid - 1].plant;

  /* ==================================================================
     1. POOL DE WORKERS (Blob → URL : aucune requête réseau, fichier unique)
     ================================================================== */
  const POOL = Math.max(1, workers || Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const pool = [];
  for (let n = 0; n < POOL; n++) {
    const w = new Worker(blobUrl);
    const entry = { worker: w, busy: false, req: -1, ci: 0, cj: 0 };
    w.onmessage = (ev) => onWorkerMessage(entry, ev.data);
    w.onerror = (e) => { entry.busy = false; console.error('[chunkWorker]', e.message || e); };
    w.postMessage({ cmd: 'init', seed, types, defs });
    pool.push(entry);
  }
  const freeWorker = () => pool.find((p) => !p.busy) || null;

  /* ==================================================================
     2. ÉTAT DES CHUNKS + FILE DE PRIORITÉ (tas binaire sur distSq)
     ================================================================== */
  const chunks = new Map();          // "ci,cj" → { ci, cj, state, vox, meshes, req }
  const heap = [];                   // [distSq, ci, cj]
  const wanted = new Set();
  const key = (ci, cj) => ci + ',' + cj;

  function heapPush(item) {
    heap.push(item);
    let n = heap.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heap[p][0] <= heap[n][0]) break;
      [heap[p], heap[n]] = [heap[n], heap[p]]; n = p;
    }
  }
  function heapPop() {
    if (!heap.length) return null;
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1; let m = n;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === n) break;
        [heap[m], heap[n]] = [heap[n], heap[m]]; n = m;
      }
    }
    return top;
  }

  /* ==================================================================
     3. POOLING DES MESHES (Object3D + BufferGeometry réutilisés)
     ================================================================== */
  const MATERIALS = opts.materials || {};
  const LAYERS = ['opaque', 'cutout', 'fluid'];
  const meshPool = [];
  const acquireMesh = (layer) => {
    const m = meshPool.find((x) => x.userData.layer === layer && !x.parent);
    if (m) return m;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), MATERIALS[layer]);
    mesh.userData.layer = layer;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.frustumCulled = true;                       // ← la sphère vient du worker
    return mesh;
  };
  const releaseMesh = (mesh) => {
    if (mesh.parent) scene.remove(mesh);
    mesh.geometry.dispose();                          // libère VBO + IBO côté GPU
    meshPool.push(mesh);
  };

  const attr = (g, name, arr, size, normalized) =>
    g.setAttribute(name, new THREE.BufferAttribute(arr, size, !!normalized));

  function applyLayer(ci, cj, layer, L) {
    const ch = chunks.get(key(ci, cj));
    if (!ch) return;
    if (!L) { const old = ch.meshes[layer]; if (old) { releaseMesh(old); ch.meshes[layer] = null; } return; }
    if (ch.meshes[layer]) releaseMesh(ch.meshes[layer]);
    const mesh = acquireMesh(layer);
    const g = new THREE.BufferGeometry();
    attr(g, 'position', L.position, 3);
    attr(g, 'normal', L.normal, 3, true);            // Int8 normalisé : 3 o/sommet
    attr(g, 'uv', L.uv, 2);
    attr(g, 'shade', L.shade, 4, true);              // ao · ciel · bloc · teinte
    g.setIndex(new THREE.BufferAttribute(L.index, 1));
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(L.bounds.cx, L.bounds.cy, L.bounds.cz), L.bounds.r);
    if (mesh.geometry) mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.position.set(ci * CHUNK * HX, 0, cj * CHUNK * HROW);
    mesh.updateMatrix();
    if (!mesh.parent) scene.add(mesh);
    ch.meshes[layer] = mesh;
    ch.tris[layer] = L.indexCount / 3;
  }

  /* ==================================================================
     4. CYCLE DE VIE : demande → réception → déchargement différé
     ================================================================== */
  let reqSeq = 1;
  const pendingApply = [];                            // résultats en attente d'application
  const toUnload = [];

  function onWorkerMessage(entry, m) {
    entry.busy = false;
    if (m.cmd === 'error') { console.error('[chunkWorker]', m.message); dispatch(); return; }
    if (m.cmd !== 'meshed') return;
    const k = key(m.ci, m.cj);
    const ch = chunks.get(k);
    /* Résultat périmé (chunk parti, re-demande plus récente) : les ArrayBuffer
       transférés sont simplement laissés au GC, aucun Mesh n'est construit. */
    if (!ch || ch.req !== m.req || !wanted.has(k)) { stats.dropped++; dispatch(); return; }
    pendingApply.push({ ch, m });
    dispatch();
  }

  /** Donne du travail aux workers libres, du chunk le plus proche au plus loin. */
  function dispatch() {
    let w;
    while ((w = freeWorker()) && heap.length) {
      const [, ci, cj] = heapPop();
      const k = key(ci, cj);
      if (!wanted.has(k)) continue;
      const ch = chunks.get(k);
      if (!ch || ch.state !== 'idle') continue;
      ch.state = 'loading'; ch.req = reqSeq++;
      w.busy = true; w.req = ch.req; w.ci = ci; w.cj = cj;
      w.worker.postMessage({ cmd: 'mesh', ci, cj, req: ch.req, edits: editsFor(ci, cj), keep: true });
    }
  }

  /** Consomme le budget de la frame : `maxApplyPerFrame` maillages au maximum,
      soit ~0,4 ms/chunk de thread principal (mesuré).  Le reste attend la
      frame suivante : le rendu n'est jamais bloqué par une arrivée en masse. */
  function apply() {
    let n = maxApplyPerFrame;
    while (n-- > 0 && pendingApply.length) {
      const { ch, m } = pendingApply.shift();
      ch.vox = m.voxels;
      for (const layer of LAYERS) applyLayer(ch.ci, ch.cj, layer, m.layers[layer]);
      ch.state = 'ready';
      stats.applied++;
      stats.workerMs += m.ms.gen + m.ms.light + m.ms.mesh;
      stats.loaded++;
      if (opts.onChunkReady) opts.onChunkReady(ch.ci, ch.cj);
    }
  }

  /** Journal des modifications du joueur restreint à un chunk : le worker les
      réapplique après génération, donc un chunk rechargé retrouve ses éditions. */
  function editsFor(ci, cj) {
    const out = [];
    for (const [ek, type] of edits) {
      const p = ek.split(',');
      if (Math.floor(+p[0] / CHUNK) === ci && Math.floor(+p[1] / CHUNK) === cj) out.push([+p[0], +p[1], +p[2], type]);
    }
    return out;
  }

  /** Déchargement : hors du chemin critique, via requestIdleCallback. */
  const idle = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 250 })
    : (fn) => setTimeout(fn, 16);
  let idleScheduled = false;
  function scheduleUnload() {
    if (idleScheduled) return;
    idleScheduled = true;
    idle(() => {
      idleScheduled = false;
      let budget = maxUnloadPerIdle;
      while (budget-- > 0 && toUnload.length) {
        const k = toUnload.pop();
        if (wanted.has(k)) continue;                  // hystérésis : revenu entre-temps
        const ch = chunks.get(k);
        if (!ch) continue;
        for (const layer of LAYERS) if (ch.meshes[layer]) releaseMesh(ch.meshes[layer]);
        ch.meshes = {}; ch.vox = null;
        chunks.delete(k);
        for (const p of pool) if ((p.ci === ch.ci && p.cj === ch.cj)) p.worker.postMessage({ cmd: 'drop', ci: ch.ci, cj: ch.cj });
        stats.unloaded++;
      }
    });
  }

  /* ==================================================================
     5. STORE VOXEL (source de vérité : collisions, visée, physique)
     ================================================================== */
  const edits = new Map();                            // "i,j,k" → type|null

  function chunkFor(i, j) { return chunks.get(key(Math.floor(i / CHUNK), Math.floor(j / CHUNK))); }
  function getBlockId(i, j, k) {
    if (k < 0 || k >= KMAX) return 0;
    const ch = chunkFor(i, j);
    if (!ch || !ch.vox) return 0;
    const li = i - ch.ci * CHUNK + PAD, lj = j - ch.cj * CHUNK + PAD;
    if (li < 0 || li >= VW || lj < 0 || lj >= VW) return 0;
    return ch.vox.types[(k * VW + lj) * VW + li];
  }
  const getBlock = (i, j, k) => { const n = getBlockId(i, j, k); return n ? NAME[n - 1] : null; };
  const isSolid = (i, j, k) => {
    const n = getBlockId(i, j, k);
    return n !== 0 && !defs[n - 1].fluid && !defs[n - 1].passable && !defs[n - 1].plant;
  };
  /** Édition joueur : écriture O(1) dans le Uint8Array, puis re-maillage ciblé. */
  function setBlock(i, j, k, type) {
    const ch = chunkFor(i, j);
    if (!ch || !ch.vox || k < 0 || k >= KMAX) return false;
    const li = i - ch.ci * CHUNK + PAD, lj = j - ch.cj * CHUNK + PAD;
    const nid = type ? ID[type] : 0;
    const p = (k * VW + lj) * VW + li;
    ch.vox.types[p] = nid || 0;
    ch.vox.meta[p] = nid && defs[nid - 1].fluid ? 8 : 0;
    edits.set(i + ',' + j + ',' + k, type || null);
    /* Le chunk touché, plus ses voisins si la cellule est en bordure (le halo
       des voisins contient cette cellule : leurs faces cachées changent). */
    const ci = ch.ci, cj = ch.cj;
    const touched = new Set([key(ci, cj)]);
    if (li < PAD + 1) touched.add(key(ci - 1, cj));
    if (li >= VW - PAD - 1) touched.add(key(ci + 1, cj));
    if (lj < PAD + 1) touched.add(key(ci, cj - 1));
    if (lj >= VW - PAD - 1) touched.add(key(ci, cj + 1));
    for (const k2 of touched) {
      const c = chunks.get(k2);
      if (c && c.state === 'ready') { c.state = 'idle'; heapPush([0, c.ci, c.cj]); }
    }
    dispatch();
    return true;
  }

  /* ==================================================================
     6. RAYCAST DDA EXACT SUR LA GRILLE TRIANGULAIRE
     -------------------------------------------------------------------
     Le moteur actuel marche à pas fixe (0.02 sur 6.5 u = 325 itérations)
     puis refait un Raycaster Three.js sur un mesh fantôme pour obtenir la
     normale.  Ici on traverse exactement les cellules : à chaque étape on
     calcule le paramètre de sortie t des 3 plans latéraux du prisme et du
     plan horizontal, on prend le plus petit.  Coût = nombre de cellules
     traversées (~8 pour REACH = 6.5) et la normale de face est connue
     analytiquement → la cellule de pose est le voisin de l'autre côté.
     ================================================================== */
  function raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let c = worldToCell(ox, oy, oz);
    let t = 0;
    const hit = { i: 0, j: 0, k: 0, face: -1, normal: null, place: null, t: 0 };
    for (let guard = 0; guard < 512 && t <= maxDist; guard++) {
      const id = getBlockId(c.i, c.j, c.k);
      if (id !== 0) {
        hit.i = c.i; hit.j = c.j; hit.k = c.k; hit.t = t; hit.face = c.face;
        hit.normal = faceNormal(c.i, c.j, c.face);
        hit.place = c.face < 0
          ? { i: c.i, j: c.j, k: c.k + 1 }
          : c.face === 4 ? { i: c.i, j: c.j, k: c.k - 1 }
            : { i: c.i + nbrDi(c.face, isUp(c.i, c.j)), j: c.j + nbrDj(c.face, isUp(c.i, c.j)), k: c.k };
        return hit;
      }
      const up = isUp(c.i, c.j);
      const cx = c.i * HX, cz = centerZ(c.j, up);
      const px = ox + dx * t, pz = oz + dz * t, py = oy + dy * t;
      let best = Infinity, bf = -1;
      /* Invariant : le point P(t) est dans la cellule c.  Un `tf` nul DOIT être
         accepté (origine ou étape posée exactement sur un plan : y = k·BH, bord
         de prisme) sinon l'invariant est rompu et la marche diverge.  La face
         par laquelle on vient d'entrer est automatiquement écartée : son
         `denom` est négatif (on s'en éloigne) → aucune oscillation possible. */
      for (let f = 0; f < 3; f++) {
        const nx = up ? NX[f] : -NX[f], nz = up ? NZ[f] : -NZ[f];
        const denom = dx * nx + dz * nz;
        if (denom <= 1e-9) continue;                            // parallèle ou entrant
        const tf = (INRADIUS - ((px - cx) * nx + (pz - cz) * nz)) / denom;
        if (tf >= 0 && tf < best) { best = tf; bf = f; }
      }
      if (dy > 1e-9) {
        const ty = ((c.k + 1) * BH - py) / dy;
        if (ty >= 0 && ty < best) { best = ty; bf = 5; }
      } else if (dy < -1e-9) {
        const ty = (c.k * BH - py) / dy;
        if (ty >= 0 && ty < best) { best = ty; bf = 4; }
      }
      if (!isFinite(best)) return null;
      t += best;
      if (t > maxDist) return null;
      if (bf === 5) c = { i: c.i, j: c.j, k: c.k + 1, face: 4 };
      else if (bf === 4) c = { i: c.i, j: c.j, k: c.k - 1, face: -1 };
      else {
        /* Attention : `oppositeFace` doit recevoir les coordonnées de la
           NOUVELLE cellule.  Dans un littéral objet, le membre de droite est
           évalué avant l'affectation → passer c.i/c.j ici donnerait l'ancienne
           cellule et donc une face d'entrée (et une cellule de pose) fausses. */
        const ni = c.i + nbrDi(bf, up), nj = c.j + nbrDj(bf, up);
        c = { i: ni, j: nj, k: c.k, face: oppositeFace(ni, nj, bf, up) };
      }
      if (c.k < 0) return null;
    }
    return null;
  }
  /** Face par laquelle on ENTRE dans le voisin : celle qui pointe vers la cellule
      d'où l'on vient (les deux prismes partagent exactement cette arête). */
  function oppositeFace(i, j, fromFace, wasUp) {
    const up = isUp(i, j);
    const pi = i - nbrDi(fromFace, wasUp), pj = j - nbrDj(fromFace, wasUp);
    for (let f = 0; f < 3; f++)
      if (i + nbrDi(f, up) === pi && j + nbrDj(f, up) === pj) return f;
    return fromFace;
  }
  const faceNormal = (i, j, face) => {
    if (face < 0) return { x: 0, y: 1, z: 0 };
    if (face === 4) return { x: 0, y: -1, z: 0 };
    const up = isUp(i, j);
    return { x: up ? NX[face] : -NX[face], y: 0, z: up ? NZ[face] : -NZ[face] };
  };
  function worldToCell(x, y, z) {
    const k = Math.floor(y / BH);
    const j = Math.floor(z / HROW);
    const zl = z - j * HROW;
    const i0 = Math.floor(x / HX);
    const xl = x - i0 * HX;
    let i;
    if (isUp(i0, j)) i = (zl <= HROW * (1 - xl / HX)) ? i0 : i0 + 1;
    else i = (zl >= HROW * (xl / HX)) ? i0 : i0 + 1;
    return { i, j, k, face: -1 };
  }

  /* ==================================================================
     7. BOUCLE : à appeler une fois par frame
     ================================================================== */
  const stats = { applied: 0, unloaded: 0, dropped: 0, workerMs: 0, loaded: 0 };
  let lastCx = Infinity, lastCz = Infinity;
  function update(px, pz) {
    const ci0 = Math.floor(px / HX / CHUNK), cj0 = Math.floor(pz / HROW / CHUNK);
    if (ci0 === lastCx && cj0 === lastCz) { dispatch(); apply(); scheduleUnload(); return; }
    lastCx = ci0; lastCz = cj0;
    wanted.clear();
    for (let cj = cj0 - radius; cj <= cj0 + radius; cj++)
      for (let ci = ci0 - radius; ci <= ci0 + radius; ci++) wanted.add(key(ci, cj));
    /* Nouvelles demandes, triées par distance (le chunk du joueur d'abord). */
    heap.length = 0;
    for (let cj = cj0 - radius; cj <= cj0 + radius; cj++)
      for (let ci = ci0 - radius; ci <= ci0 + radius; ci++) {
        const k = key(ci, cj);
        let ch = chunks.get(k);
        if (!ch) { ch = { ci, cj, state: 'idle', vox: null, meshes: {}, tris: {}, req: 0 }; chunks.set(k, ch); }
        if (ch.state === 'idle') heapPush([(ci - ci0) * (ci - ci0) + (cj - cj0) * (cj - cj0), ci, cj]);
      }
    /* Déchargement avec hystérésis, jamais dans la frame du chargement. */
    for (const [k, ch] of chunks) {
      if (!wanted.has(k)
        && (Math.abs(ch.ci - ci0) > unloadRadius || Math.abs(ch.cj - cj0) > unloadRadius)
        && !toUnload.includes(k)) toUnload.push(k);
    }
    dispatch();
    apply();
    scheduleUnload();
  }

  function dispose() {
    for (const p of pool) p.worker.terminate();
    URL.revokeObjectURL(blobUrl);
    for (const [, ch] of chunks) for (const layer of LAYERS) if (ch.meshes[layer]) releaseMesh(ch.meshes[layer]);
    chunks.clear(); heap.length = 0; toUnload.length = 0; pendingApply.length = 0;
  }

  return {
    update, dispatch, apply, raycast, getBlock, getBlockId, isSolid, setBlock, worldToCell, dispose,
    chunks, stats, edits,
    get ready() { let n = 0; for (const [, c] of chunks) if (c.state === 'ready') n++; return n; },
    get triangles() { let n = 0; for (const [, c] of chunks) for (const l of LAYERS) n += c.tris[l] || 0; return n; },
    get queued() { return heap.length + pendingApply.length; },
    _internals: { INRADIUS, NX, NZ, nbrDi, nbrDj, HX, HROW, BH, CHUNK, KMAX, PAD, VW },
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createChunkRenderer };
