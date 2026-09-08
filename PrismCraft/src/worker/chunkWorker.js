/* =====================================================================
   chunkWorker.js — générateur + mailleur de chunks (Web Worker)
   ---------------------------------------------------------------------
   Tourné HORS du thread principal.  Reçoit des ordres de maillage,
   renvoie des TypedArrays **transférés** (zéro copie, zéro sérialisation
   structurelle) + le volume voxel du chunk.

   Ce fichier est inliné par build.py juste APRÈS prismcore.js dans un
   <script type="text/prismcraft-worker"> ; le thread principal en fait un
   Blob → URL → `new Worker(url)`.  Le jeu reste donc un fichier unique.

   PROTOCOLE
     main → worker
       { cmd:'init', seed, types:[nom…], defs:[{…}] }
       { cmd:'mesh', ci, cj, req, edits:[[i,j,k,type|null]…], keep:bool }
       { cmd:'drop', ci, cj }                     // libère le cache
       { cmd:'light', ci, cj, req }               // re-maille (lumière/édition)
     worker → main
       { cmd:'meshed', ci, cj, req, layers:{opaque,cutout,fluid},
         voxels:{ types, meta, w, pad }, ms:{gen,light,mesh} }
       { cmd:'error', ci, cj, req, message }
   ===================================================================== */
/* global PrismCore */
(function () {
  'use strict';
  const PC = PrismCore;
  const PAD = PC.PAD;

  let ready = false;
  let scratch = null;                       // volume réutilisé d'un chunk à l'autre
  let builders = null;                      // buffers de maillage réutilisés
  /** Petit LRU : un chunk récemment généré est re-maillé sans régénération. */
  const cache = new Map();
  const CACHE_MAX = 24;

  const cachePut = (key, V) => {
    cache.set(key, V);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  /** Applique le journal des modifications du joueur dans le volume. */
  function applyEdits(V, ci, cj, edits) {
    if (!edits || !edits.length) return 0;
    const i0 = ci * PC.CHUNK - PAD, i1 = ci * PC.CHUNK + PC.CHUNK + PAD;
    const j0 = cj * PC.CHUNK - PAD, j1 = cj * PC.CHUNK + PC.CHUNK + PAD;
    let n = 0;
    for (let e = 0; e < edits.length; e++) {
      const i = edits[e][0], j = edits[e][1], k = edits[e][2], type = edits[e][3];
      if (i < i0 || i >= i1 || j < j0 || j >= j1) continue;
      const nid = type ? PC.table.id[type] : 0;
      PC.setAt(V, i, j, k, nid || 0, nid && (PC.table.flags[nid] & PC.F_FLUID) ? 8 : 0, ci, cj);
      n++;
    }
    return n;
  }

  function collectTransfer(layers, voxels) {
    const t = [];
    for (const name in layers) {
      const L = layers[name];
      if (!L) continue;
      t.push(L.position.buffer, L.normal.buffer, L.uv.buffer, L.shade.buffer, L.index.buffer);
    }
    t.push(voxels.types.buffer, voxels.meta.buffer);
    return t;
  }

  function mesh(ci, cj, req, edits, keep) {
    const key = ci + ',' + cj;
    const t0 = performance.now();
    let V = cache.get(key);
    let tGen = 0, tLight = 0;
    if (!V) {
      scratch = scratch || PC.makeVolume(PAD);
      V = PC.generateChunkVolume(ci, cj, PAD, scratch);
      tGen = performance.now() - t0;
      const t1 = performance.now();
      PC.computeLight(V);
      tLight = performance.now() - t1;
    } else {
      cache.delete(key); cache.set(key, V);                 // touche LRU
    }
    if (applyEdits(V, ci, cj, edits)) {
      const t1 = performance.now(); PC.computeLight(V); tLight += performance.now() - t1;
    }

    const t2 = performance.now();
    builders = builders || {};
    PC.meshChunk(V, ci, cj, builders);
    const layers = {
      opaque: PC.finish(builders.opaque),
      cutout: PC.finish(builders.cutout),
      fluid: PC.finish(builders.fluid),
    };
    const tMesh = performance.now() - t2;

    /* Le volume voxel part AUSSI au thread principal : c'est sa nouvelle
       source de vérité pour les collisions / la visée / la physique.
       `keep` = le worker garde une copie (éditions à venir). */
    const voxels = {
      types: V.types.slice(0), meta: V.meta.slice(0), w: V.w, pad: PAD,
    };
    if (keep !== false) cachePut(key, V);

    self.postMessage({
      cmd: 'meshed', ci, cj, req, layers, voxels,
      ms: { gen: tGen, light: tLight, mesh: tMesh },
    }, collectTransfer(layers, voxels));
  }

  self.onmessage = (ev) => {
    const m = ev.data;
    try {
      switch (m.cmd) {
        case 'init':
          PC.configure({ types: m.types, defs: m.defs });
          PC.setSeed(m.seed);
          if (typeof m.pad === 'number') { /* PAD est une constante du noyau */ }
          ready = true;
          self.postMessage({ cmd: 'ready' });
          break;
        case 'mesh':
        case 'light':
          if (!ready) { self.postMessage({ cmd: 'error', req: m.req, message: 'worker non initialisé' }); break; }
          mesh(m.ci, m.cj, m.req, m.edits, m.keep);
          break;
        case 'drop':
          cache.delete(m.ci + ',' + m.cj);
          break;
        default:
          self.postMessage({ cmd: 'error', message: 'commande inconnue : ' + m.cmd });
      }
    } catch (err) {
      self.postMessage({ cmd: 'error', ci: m.ci, cj: m.cj, req: m.req, message: String(err && err.stack || err) });
    }
  };
})();
