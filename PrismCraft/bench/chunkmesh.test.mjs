/* =====================================================================
   bench/chunkmesh.test.mjs — test d'intégration du gestionnaire de chunks
   ---------------------------------------------------------------------
   Exécute src/chunkmesh.js dans Node avec des stubs navigateur (Worker,
   Blob, URL, navigator, requestIdleCallback).  Le « faux worker » appelle
   le VRAI src/worker/prismcore.js : on teste donc les deux moitiés livrées
   bout en bout, sans navigateur.

   Vérifie :
     1. chargement / file de priorité / budget par frame
     2. store voxel identique à PrismCore
     3. raycast DDA exact (oracle : marche à pas très fin)
     4. cellule de pose vide et partageant la face touchée
     5. frustum culling (sphères englobantes correctes)
     6. déchargement : geometry.dispose() appelé, meshes rendus au pool
   ===================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PC = require(join(ROOT, 'src/worker/prismcore.js'));

/* ---------- table des types réelle ---------------------------------- */
const tpl = readFileSync(join(ROOT, 'src/index.template.html'), 'utf8');
function extract(src, marker) {
  const at = src.indexOf(marker);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(marker);
}
const TYPES = new Function(extract(tpl, 'const TYPES = {') + '; return TYPES;')();
const mExtra = readFileSync(join(ROOT, 'src/blocks_extra.js'), 'utf8')
  .match(/Object\.assign\(TYPES,\s*(\{[\s\S]*?\n\})\)/);
if (mExtra) Object.assign(TYPES, new Function('return ' + mExtra[1])());
const types = Object.keys(TYPES);
const defs = types.map((t) => TYPES[t]);
const SEED = 20260908;
PC.configure({ types, defs });
PC.setSeed(SEED);

/* =====================================================================
   Stubs navigateur
   ===================================================================== */
let disposedGeometries = 0;
const origDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { disposedGeometries++; return origDispose.call(this); };
const workerLog = [];
class FakeWorker {
  constructor() { this.handlers = {}; this.alive = true; setTimeout(() => this.onmessage && this.onmessage({ data: { cmd: 'ready' } }), 0); }
  postMessage(m) {
    if (!this.alive) throw new Error('worker terminé');
    if (m.cmd === 'drop') { workerLog.push('drop ' + m.ci + ',' + m.cj); return; }
    if (m.cmd !== 'mesh') return;
    workerLog.push('mesh ' + m.ci + ',' + m.cj);
    /* Réponse SYNCHRONE via le vrai prismcore : le contenu est exactement
       celui que produirait le worker navigateur (mêmes fonctions). */
    const V = PC.generateChunkVolume(m.ci, m.cj, PC.PAD);
    PC.computeLight(V);
    if (m.edits) for (const e of m.edits) PC.setAt(V, e[0], e[1], e[2], e[3] ? PC.table.id[e[3]] : 0, 0, m.ci, m.cj);
    const B = {}; PC.meshChunk(V, m.ci, m.cj, B);
    const layers = { opaque: PC.finish(B.opaque), cutout: PC.finish(B.cutout), fluid: PC.finish(B.fluid) };
    const voxels = { types: V.types.slice(0), meta: V.meta.slice(0), w: V.w, pad: PC.PAD };
    const self = this;
    setTimeout(() => self.onmessage && self.onmessage({ data: { cmd: 'meshed', ci: m.ci, cj: m.cj, req: m.req, layers, voxels, ms: { gen: 1, light: 1, mesh: 1 } } }), 0);
  }
  terminate() { this.alive = false; }
}
globalThis.Worker = FakeWorker;
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true, writable: true });
const idleQueue = [];
globalThis.requestIdleCallback = (fn) => { idleQueue.push(fn); return idleQueue.length; };
const runIdle = () => { while (idleQueue.length) idleQueue.shift()(); };
const tick = () => new Promise((r) => setTimeout(r, 1));

/* ---------- chargement du fragment livré ---------------------------- */
const src = readFileSync(join(ROOT, 'src/chunkmesh.js'), 'utf8');
const createChunkRenderer = new Function('THREE', 'module', src + '\nreturn createChunkRenderer;')(THREE, {});

const scene = new THREE.Scene();
const MATERIALS = {
  opaque: new THREE.MeshLambertMaterial(),
  cutout: new THREE.MeshLambertMaterial({ alphaTest: 0.5 }),
  fluid: new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.6, depthWrite: false }),
};
const CR = createChunkRenderer(THREE, {
  scene, workerSource: '/* fake */', types, defs, seed: SEED,
  radius: 2, unloadRadius: 3, workers: 3, maxApplyPerFrame: 2,
});
let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) fail++; };

console.log('── 1. Chargement + file de priorité + budget par frame ────────────');
CR.update(0, 0);
await tick();
const perFrame = [];
let prevApplied = CR.stats.applied;
for (let f = 0; f < 40; f++) {
  CR.update(0, 0); await tick();
  perFrame.push(CR.stats.applied - prevApplied); prevApplied = CR.stats.applied;
}
const wantedCount = 5 * 5;
ok(CR.ready === wantedCount, `${wantedCount} chunks prêts`, `obtenu ${CR.ready}`);
ok(scene.children.length === wantedCount * 3 || scene.children.length > 0,
  'meshes ajoutés à la scène', `${scene.children.length} meshes`);
ok(perFrame.slice(0, 30).every((v) => v <= 2), 'budget ≤ maxApplyPerFrame par frame',
  'max observé ' + Math.max(...perFrame));

console.log('\n── 2. Store voxel identique à PrismCore ──────────────────────────');
let diff = 0, checked = 0;
for (let cj = -2; cj <= 2; cj++) for (let ci = -2; ci <= 2; ci++) {
  const V = PC.generateChunkVolume(ci, cj, PC.PAD);
  for (let j = cj * 16; j < cj * 16 + 16; j++)
    for (let i = ci * 16; i < ci * 16 + 16; i++)
      for (let k = 0; k < 64; k++) {
        checked++;
        const a = PC.getAt(V, i, j, k, ci, cj);
        const b = CR.getBlockId(i, j, k);
        if (a !== b) diff++;
      }
}
ok(diff === 0, 'store voxel ⇄ PrismCore', `${checked.toLocaleString('fr-FR')} cellules, ${diff} différences`);

console.log('\n── 3. Raycast DDA exact (oracle exhaustif : test des 5 plans) ─────');
/* Oracle INDÉPENDANT et exact : on énumère toutes les cellules pleines de la
   boîte englobante du rayon et on intersecte le rayon avec le prisme
   (3 demi-espaces latéraux à l'apothème R/2 + 2 plans horizontaux).
   Aucune approximation de pas : c'est une vérification réelle du DDA. */
const { INRADIUS, NX, NZ, HX, HROW, BH, nbrDi, nbrDj } = CR._internals;
function prismHit(ox, oy, oz, dx, dy, dz, i, j, k, maxD) {
  const up = ((i + j) & 1) === 0;
  const cx = i * HX, cz = j * HROW + (up ? 0.5 * (1 / Math.sqrt(3)) : 1 / Math.sqrt(3));
  let lo = 0, hi = maxD;
  const cut = (a1, b1) => {                                   // a1·t <= b1
    if (Math.abs(a1) < 1e-12) return b1 >= -1e-12;
    const r = b1 / a1;
    if (a1 > 0) { hi = Math.min(hi, r); } else { lo = Math.max(lo, r); }
    return lo <= hi;
  };
  for (let f = 0; f < 3; f++) {
    const nx = up ? NX[f] : -NX[f], nz = up ? NZ[f] : -NZ[f];
    if (!cut(dx * nx + dz * nz, INRADIUS - ((ox - cx) * nx + (oz - cz) * nz))) return null;
  }
  if (!cut(dy, (k + 1) * BH - oy)) return null;               // y <= (k+1)·BH
  if (!cut(-dy, oy - k * BH)) return null;                    // y >= k·BH
  return lo <= hi && hi >= 0 ? lo : null;
}
function oracle(ox, oy, oz, dx, dy, dz, maxD) {
  const iA = Math.floor((Math.min(ox, ox + dx * maxD) - 1) / HX), iB = Math.ceil((Math.max(ox, ox + dx * maxD) + 1) / HX);
  const jA = Math.floor((Math.min(oz, oz + dz * maxD) - 1) / HROW), jB = Math.ceil((Math.max(oz, oz + dz * maxD) + 1) / HROW);
  const kA = Math.max(0, Math.floor(Math.min(oy, oy + dy * maxD) / BH) - 1);
  const kB = Math.min(63, Math.ceil(Math.max(oy, oy + dy * maxD) / BH) + 1);
  /* Le rayon peut raser une arête : plusieurs cellules partagent alors le même
     t d'entrée.  On renvoie le t minimal ET l'ensemble des cellules ex æquo ;
     le DDA est correct s'il tombe sur l'une d'elles. */
  let bestT = Infinity; const tied = [];
  for (let k = kA; k <= kB; k++) for (let j = jA; j <= jB; j++) for (let i = iA; i <= iB; i++) {
    if (!CR.getBlockId(i, j, k)) continue;
    const t = prismHit(ox, oy, oz, dx, dy, dz, i, j, k, maxD);
    if (t === null) continue;
    if (t < bestT - 1e-9) { bestT = t; tied.length = 0; tied.push(i + ',' + j + ',' + k); }
    else if (t <= bestT + 1e-9) tied.push(i + ',' + j + ',' + k);
  }
  return tied.length ? { t: bestT, tied } : null;
}
let rays = 0, mism = 0, hits = 0, badPlace = 0, badT = 0, degeneres = 0, dansUnBloc = 0;
for (let n = 0; n < 4000; n++) {
  const a = (n * 0.6180339887) * Math.PI * 2, e = ((n % 120) - 60) * Math.PI / 180;
  const dx = Math.cos(e) * Math.cos(a), dy = Math.sin(e), dz = Math.cos(e) * Math.sin(a);
  const ox = 0.3 + (n % 17) * 0.7, oy = 12 + (n % 9) * 0.35, oz = -0.4 + ((n >> 2) % 19) * 0.65;
  /* Rayons dégénérés : parfaitement horizontaux à une hauteur entière, ou dont
     l'origine tombe exactement sur un plan y = k·BH.  Le rayon rase alors une
     arête partagée par 4 prismes : « dedans » ou « dehors » sont tous deux
     défendables, et worldToCell (demi-ouvert) tranche autrement que le test des
     plans (fermé).  Ces cas sont exclus et comptés à part. */
  if (Math.abs(dy) < 1e-9 || Number.isInteger(oy / BH)) { degeneres++; continue; }
  const h = CR.raycast(ox, oy, oz, dx, dy, dz, 6.5);
  const o = oracle(ox, oy, oz, dx, dy, dz, 6.5);
  rays++;
  if (!!h !== !!o) { mism++; continue; }
  if (!h) continue;
  hits++;
  if (!o.tied.includes(h.i + ',' + h.j + ',' + h.k)) { mism++; continue; }
  if (Math.abs(h.t - o.t) > 1e-6) badT++;
  const pl = h.place;
  if (h.t <= 1e-9) { dansUnBloc++; continue; }   // origine déjà dans un bloc : pose non définie
  const empty = CR.getBlockId(pl.i, pl.j, pl.k) === 0;
  const up = ((h.i + h.j) & 1) === 0;
  const adjacent = (pl.k - h.k === 1 && pl.i === h.i && pl.j === h.j)
    || (pl.k - h.k === -1 && pl.i === h.i && pl.j === h.j)
    || (pl.k === h.k && [0, 1, 2].some((f) => h.i + nbrDi(f, up) === pl.i && h.j + nbrDj(f, up) === pl.j));
  if (!empty || !adjacent) badPlace++;
}
ok(mism === 0, 'cellule touchée identique à l\'oracle exhaustif', `${rays} rayons, ${hits} impacts, ${mism} divergences`);
ok(badT === 0, 'distance d\'impact exacte (à 1e-6)', `${badT} écarts`);
ok(badPlace === 0, 'cellule de pose vide et adjacente à la face touchée',
  `${badPlace} anomalies (${degeneres} rayons dégénérés et ${dansUnBloc} origines dans un bloc exclus)`);

console.log('\n── 4. Frustum culling : sphères englobantes ──────────────────────');
let badSphere = 0, sphereCount = 0;
scene.traverse((o) => {
  if (!o.isMesh || !o.geometry.boundingSphere) return;
  sphereCount++;
  const bs = o.geometry.boundingSphere;
  const pos = o.geometry.attributes.position;
  if (!pos) return;
  for (let v = 0; v < pos.count; v++) {
    const dx = pos.getX(v) - bs.center.x, dy = pos.getY(v) - bs.center.y, dz = pos.getZ(v) - bs.center.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > bs.radius + 1e-4) { badSphere++; break; }
  }
  /* coordonnées locales petites → l'origine est bien portée par mesh.position */
  if (Math.abs(bs.center.x) > 16 || Math.abs(bs.center.z) > 16) badSphere++;
});
ok(sphereCount > 0 && badSphere === 0, 'toutes les sphères contiennent leur géométrie', `${sphereCount} meshes testés`);
const frustum = new THREE.Frustum();
const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
cam.position.set(0, 20, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
let visible = 0, total = 0;
scene.traverse((o) => { if (!o.isMesh || !o.geometry.boundingSphere) return; total++; o.updateMatrixWorld(); if (frustum.intersectsObject(o)) visible++; });
ok(visible < total, 'le frustum rejette bien des chunks', `${visible}/${total} visibles depuis (0,20,0)`);

console.log('\n── 5. Déchargement : dispose() + retour au pool ──────────────────');
const before = scene.children.length;
const disposedBefore = disposedGeometries;
CR.update(200 * 8, 200 * 13.856);            // le joueur part très loin
for (let f = 0; f < 12; f++) { CR.update(200 * 8, 200 * 13.856); await tick(); runIdle(); }
ok(scene.children.length > 0, 'les nouveaux chunks sont là', `${scene.children.length} meshes`);
ok(disposedGeometries > disposedBefore, 'geometry.dispose() appelé au déchargement',
  `${disposedGeometries - disposedBefore} dispose()`);
ok(CR.stats.unloaded > 0, 'chunks déchargés comptabilisés', `${CR.stats.unloaded}`);

console.log('\n── 6. Édition : setBlock → re-maillage ciblé ─────────────────────');
CR.update(0, 0);
for (let f = 0; f < 40; f++) { CR.update(0, 0); await tick(); runIdle(); }
const hgt = (() => { for (let k = 63; k >= 0; k--) if (CR.getBlockId(3, 3, k)) return k; return 0; })();
const appliedBefore = CR.stats.applied;
CR.setBlock(3, 3, hgt + 1, 'glass');
ok(CR.getBlock(3, 3, hgt + 1) === 'glass', 'setBlock écrit dans le store voxel');
for (let f = 0; f < 10; f++) { CR.update(0, 0); await tick(); runIdle(); }
ok(CR.stats.applied > appliedBefore, 'le chunk touché est re-maillé', `${CR.stats.applied - appliedBefore} re-maillage(s)`);
ok(workerLog.filter((l) => l.startsWith('mesh 0,0')).length >= 2, 'ordre « mesh » renvoyé au worker',
  workerLog.filter((l) => l.startsWith('mesh 0,0')).length + '×');

console.log('\n── 7. Libération complète ---------------------------------------');
CR.dispose();
ok(scene.children.length === 0, 'scène vidée', `${scene.children.length} objets restants`);

console.log(fail === 0 ? '\n✅ chunkmesh.js : tous les tests passent.' : `\n❌ ${fail} test(s) en échec.`);
process.exit(fail === 0 ? 0 : 1);
