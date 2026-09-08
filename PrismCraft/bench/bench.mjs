/* =====================================================================
   bench/bench.mjs — mesure comparée « architecture actuelle » ⇄ « worker »
   ---------------------------------------------------------------------
   Côté « actuel », ce banc n'est PAS une ré-implémentation : il extrait
   textuellement addBlock / removeBlock / writeMatrix / writeColor /
   computeAO / refreshAOAround / refreshChunkAO / flushLayer /
   refreshCulling depuis src/index.template.html et src/worldgen.js, puis
   les exécute sur de vraies classes THREE avec des couches InstancedMesh
   simulées (mêmes tableaux typés, mêmes copies).

   Côté « worker », il exécute src/worker/prismcore.js (le code livré).

   Usage : node bench/bench.mjs [nbChunks]
   ===================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PC = require(join(ROOT, 'src/worker/prismcore.js'));

/* ---------- extraction d'une déclaration de haut niveau -------------- */
function extract(src, marker, label) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marqueur introuvable : ' + label);
  if (!marker.includes('{')) return src.slice(at, src.indexOf('\n', at));
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('accolades non équilibrées : ' + label);
}
const tpl = read('src/index.template.html');
const wg = read('src/worldgen.js');
const n3 = read('src/noise3.js');

/* ---------- table des types réelle ----------------------------------- */
const TYPES = new Function(extract(tpl, 'const TYPES = {', 'TYPES') + '; return TYPES;')();
const mExtra = read('src/blocks_extra.js').match(/Object\.assign\(TYPES,\s*(\{[\s\S]*?\n\})\)/);
if (mExtra) Object.assign(TYPES, new Function('return ' + mExtra[1])());
const TYPE_IDS = Object.keys(TYPES);
const LAYER_MAX = new Function(extract(tpl, 'const LAYER_MAX = {', 'LAYER_MAX') + '; return LAYER_MAX;')();
const SOURCE_OF = new Function(extract(tpl, 'const SOURCE_OF = {', 'SOURCE_OF') + '; return SOURCE_OF;')();

/* =====================================================================
   MOTEUR ACTUEL — fonctions réelles, couches simulées
   ===================================================================== */
class FakeInstancedMesh {
  constructor(max) {
    this.count = 0; this.max = max;
    this.instanceMatrix = { array: new Float32Array(max * 16), needsUpdate: false };
    this.instanceColor = { array: new Float32Array(max * 3), needsUpdate: false };
  }
  setMatrixAt(i, m) { this.instanceMatrix.array.set(m.elements, i * 16); }
  getMatrixAt(i, m) { m.fromArray(this.instanceMatrix.array, i * 16); }
  setColorAt(i, c) { this.instanceColor.array[i * 3] = c.r; this.instanceColor.array[i * 3 + 1] = c.g; this.instanceColor.array[i * 3 + 2] = c.b; }
  getColorAt(i, c) { c.fromArray(this.instanceColor.array, i * 3); }
}
const terrain = {};
for (const t of TYPE_IDS) {
  const max = Math.max(LAYER_MAX[t] || 5000, 400000);      // jamais de growLayer ici
  terrain[t] = {
    type: t, mesh: new FakeInstancedMesh(max), depthPre: null,
    ao: TYPES[t].fluid ? null : { array: new Float32Array(max), needsUpdate: false },
    skyL: { array: new Float32Array(max), needsUpdate: false },
    blkL: { array: new Float32Array(max), needsUpdate: false },
    idxToKey: [], max, dirty: false,
  };
}
const blocks = new Map();
const pending = new Set();
const edits = new Map();
const player = { pos: new THREE.Vector3(0, 10, 0) };
const isCreative = () => true;
const recordEdit = () => {};
const growLayer = () => { throw new Error('growLayer appelé : augmenter LAYER_MAX'); };

const engineSrc = [
  /* grille */
  'const S = 1.0;',
  extract(tpl, 'const R    = S / Math.sqrt(3);', 'R'),
  extract(tpl, 'const HROW = 1.5 * R;', 'HROW'),
  extract(tpl, 'const HX   = S / 2;', 'HX'),
  extract(tpl, 'const BH   = 1.0;', 'BH'),
  extract(tpl, 'const isUp = (i, j) =>', 'isUp'),
  extract(tpl, 'function cellCenter(i, j, k, out = new THREE.Vector3()) {', 'cellCenter'),
  extract(tpl, 'function worldToCell(x, y, z) {', 'worldToCell'),
  extract(tpl, 'const cellKey = (i, j, k) =>', 'cellKey'),
  extract(tpl, 'function makePerlin(seed) {', 'makePerlin'),
  extract(tpl, 'const hash2 = (i, j) =>', 'hash2'),
  extract(tpl, 'const WATER_LEVEL = 4.0;', 'WATER_LEVEL'),
  extract(n3, 'function makeNoise3(seed) {', 'makeNoise3'),
  extract(wg, 'const CHUNK = 16;', 'CHUNK'),
  extract(wg, 'function computeBiome(wx, wz) {', 'computeBiome'),
  extract(wg, 'const biomeIndexAt = (i, j) =>', 'biomeIndexAt'),
  extract(wg, 'function heightAt(i, j) {', 'heightAt'),
  extract(wg, 'function isCave(wx, k, wz) {', 'isCave'),
  extract(wg, 'const h2 = (a, b) =>', 'h2'),
  extract(wg, 'function generateColumn(i, j) {', 'generateColumn'),
  extract(wg, 'function placeTree(i, j) {', 'placeTree'),
  /* rendu / AO / culling */
  extract(tpl, 'const _aoDir = new THREE.Vector3(), _aoC = new THREE.Vector3();', '_aoDir'),
  extract(tpl, 'const AO_FACE_DIRS = [0, 1, 2].map', 'AO_FACE_DIRS'),
  extract(tpl, 'function computeAO(b) {', 'computeAO'),
  extract(tpl, 'function refreshAOAround(i, j, k) {', 'refreshAOAround'),
  extract(tpl, 'const _m = new THREE.Matrix4();', '_m'),
  extract(tpl, 'const _pos = new THREE.Vector3();', '_pos'),
  extract(tpl, 'const _one = new THREE.Vector3(1, 1, 1);', '_one'),
  extract(tpl, 'const _zero = new THREE.Vector3(0, 0, 0);', '_zero'),
  extract(tpl, 'const _c = new THREE.Color();', '_c'),
  extract(tpl, 'const Q_UP   = new THREE.Quaternion();', 'Q_UP'),
  extract(tpl, 'const Q_DOWN = new THREE.Quaternion()', 'Q_DOWN'),
  extract(tpl, 'const _scl = new THREE.Vector3();', '_scl'),
  extract(tpl, 'const fluidHeight = (level) =>', 'fluidHeight'),
  extract(tpl, 'function writeMatrix(b) {', 'writeMatrix'),
  extract(tpl, 'function writeColor(b) {', 'writeColor'),
  extract(tpl, 'function flushLayer(layer) {', 'flushLayer'),
  extract(tpl, 'function neighbors3(i, j) {', 'neighbors3'),
  extract(tpl, 'function schedule(i, j, k) {', 'schedule'),
  extract(tpl, 'function scheduleAround(i, j, k) {', 'scheduleAround'),
  extract(tpl, 'function addBlock(i, j, k, type, doFlush = true, level) {', 'addBlock'),
  extract(tpl, 'function removeBlock(i, j, k, byPlayer = false) {', 'removeBlock'),
  extract(tpl, 'const blockAt = (i, j, k) =>', 'blockAt'),
  extract(tpl, 'const isSolid = (i, j, k) =>', 'isSolid'),
  extract(wg, 'function refreshChunkAO(ci, cj) {', 'refreshChunkAO'),
  extract(tpl, 'const VIEW_DIST_SQ = VIEW_DISTANCE * VIEW_DISTANCE;', 'VIEW_DIST_SQ'),
  extract(tpl, 'const _lastCullPos = new THREE.Vector3(Infinity, Infinity, Infinity);', '_lastCullPos'),
  extract(tpl, 'const _cp = new THREE.Vector3();', '_cp'),
  extract(tpl, 'function refreshCulling(force = false) {', 'refreshCulling'),
  'let fbm = makePerlin(1337); let noise3 = makeNoise3(1337); let worldSeed = 0;',
  'function setWorldSeed(s){ worldSeed = s >>> 0; fbm = makePerlin(worldSeed); noise3 = makeNoise3(worldSeed); }',
  'return { setWorldSeed, generateColumn, placeTree, addBlock, removeBlock, blockAt, isSolid,',
  '         computeAO, refreshAOAround, refreshChunkAO, flushLayer, refreshCulling,',
  '         cellCenter, worldToCell, cellKey, CHUNK, terrain, blocks, VIEW_DIST_SQ };',
].join('\n');

const E = new Function('THREE', 'terrain', 'blocks', 'pending', 'edits', 'player',
  'isCreative', 'recordEdit', 'growLayer', 'TYPES', 'TYPE_IDS', 'SOURCE_OF',
  'VIEW_DISTANCE', 'culledCountSink', engineSrc)(
  THREE, terrain, blocks, pending, edits, player, isCreative, recordEdit, growLayer,
  TYPES, TYPE_IDS, SOURCE_OF, 40, {});

/* =====================================================================
   MESURES
   ===================================================================== */
const NCHUNK = +(process.argv[2] || 25);
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;   // ms
const SEED = 20260908;

/* ---- liste de chunks en spirale autour de (0,0) ---- */
const cells = [];
{
  const rad = Math.ceil(Math.sqrt(NCHUNK) / 2);
  for (let cj = -rad; cj <= rad; cj++) for (let ci = -rad; ci <= rad; ci++) cells.push([ci, cj]);
  cells.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
  cells.length = NCHUNK;
}

PC.configure({ types: TYPE_IDS, defs: TYPE_IDS.map((t) => TYPES[t]) });
PC.setSeed(SEED);
E.setWorldSeed(SEED);

console.log(`PrismCraft — banc d'architecture chunks`);
console.log(`Node ${process.version} · three r${THREE.REVISION} · ${NCHUNK} chunks 16×16×64 · seed ${SEED}\n`);

/* ================= 1. COÛT WORKER (hors thread principal) ============ */
let genMs = 0, lightMs = 0, meshMs = 0;
let voxTotal = 0, triTotal = 0, vertTotal = 0, bytesTotal = 0, prismTotal = 0;
const perLayer = { opaque: 0, cutout: 0, fluid: 0 };
let faceTotal = 0, faceMax = 0;
const volumes = [];
for (const [ci, cj] of cells) {
  let t = now(); const V = PC.generateChunkVolume(ci, cj, PC.PAD); genMs += now() - t;
  t = now(); PC.computeLight(V); lightMs += now() - t;
  t = now();
  const B = {}; PC.meshChunk(V, ci, cj, B);
  const L = { opaque: PC.finish(B.opaque), cutout: PC.finish(B.cutout), fluid: PC.finish(B.fluid) };
  meshMs += now() - t;
  let prisms = 0;
  for (let j = cj * 16; j < cj * 16 + 16; j++)
    for (let i = ci * 16; i < ci * 16 + 16; i++)
      for (let k = 0; k < 64; k++) if (PC.getAt(V, i, j, k, ci, cj)) prisms++;
  prismTotal += prisms;
  voxTotal += prisms;
  faceTotal += prisms * 5; faceMax += prisms * 5;
  for (const n in L) {
    if (!L[n]) continue;
    triTotal += L[n].indexCount / 3; vertTotal += L[n].vertexCount;
    bytesTotal += L[n].bytes; perLayer[n] += L[n].indexCount / 3;
  }
  volumes.push({ ci, cj, V });
}
/* Comptage exact des faces : chapeau = 3 sommets / 3 index,
   latérale = 4 sommets / 6 index  →  Q = (I − V)/2 quads,  C = (V − 4Q)/3 chapeaux. */
let quadTotal = 0, capTotal = 0;
for (const { V, ci, cj } of volumes) {
  const B = {}; PC.meshChunk(V, ci, cj, B);
  for (const n of ['opaque', 'cutout', 'fluid']) {
    const Q = (B[n].ni - B[n].nv) / 2, C = (B[n].nv - 4 * Q) / 3;
    quadTotal += Q; capTotal += C;
  }
}
const facesEmitted = quadTotal + capTotal;

/* Variante : culling des faces internes du feuillage (option « Fast » de MC). */
let triNoFoliage = 0;
{
  const defs2 = TYPE_IDS.map((t) => Object.assign({}, TYPES[t], t === 'leaves' ? { foliage: false } : {}));
  PC.configure({ types: TYPE_IDS, defs: defs2 });
  for (const { V } of volumes) {
    const B = {}; PC.meshChunk(V, 0, 0, B);
    for (const n of ['opaque', 'cutout', 'fluid']) if (PC.finish(B[n])) triNoFoliage += B[n].ni / 3;
  }
  PC.configure({ types: TYPE_IDS, defs: TYPE_IDS.map((t) => TYPES[t]) });
}

console.log('── 1. Worker (ces ms ne touchent JAMAIS le thread principal) ──────');
console.log(`  génération terrain  : ${(genMs / NCHUNK).toFixed(2)} ms/chunk`);
console.log(`  éclairage voxel     : ${(lightMs / NCHUNK).toFixed(2)} ms/chunk`);
console.log(`  maillage + culling  : ${(meshMs / NCHUNK).toFixed(2)} ms/chunk`);
console.log(`  TOTAL worker        : ${((genMs + lightMs + meshMs) / NCHUNK).toFixed(2)} ms/chunk  (${(genMs + lightMs + meshMs).toFixed(0)} ms pour ${NCHUNK} chunks)`);
console.log(`  prismes/chunk       : ${(prismTotal / NCHUNK).toFixed(0)}`);
console.log(`  triangles émis      : ${(triTotal / NCHUNK).toFixed(0)}/chunk  [opaque ${(perLayer.opaque / NCHUNK).toFixed(0)} · cutout ${(perLayer.cutout / NCHUNK).toFixed(0)} · fluide ${(perLayer.fluid / NCHUNK).toFixed(0)}]`);
console.log(`  faces émises        : ${(facesEmitted / NCHUNK).toFixed(0)}/chunk (${(quadTotal / NCHUNK).toFixed(0)} latérales + ${(capTotal / NCHUNK).toFixed(0)} chapeaux) sur ${(faceMax / NCHUNK).toFixed(0)} possibles → ${((facesEmitted / faceMax) * 100).toFixed(1)} % conservées`);
console.log(`  … si on culle aussi l'intérieur des feuillages : ${(triNoFoliage / NCHUNK).toFixed(0)} tri/chunk (−${((1 - triNoFoliage / triTotal) * 100).toFixed(0)} %)`);
console.log(`  sommets/chunk       : ${(vertTotal / NCHUNK).toFixed(0)}`);
console.log(`  octets transférés   : ${(bytesTotal / NCHUNK / 1024).toFixed(1)} Kio/chunk (ArrayBuffer transférés, 0 copie)`);

/* ================= 2. MOTEUR ACTUEL : thread principal =============== */
/* 2a. ensureChunk : generateColumn ×256 + addBlock (objet + Map + matrice) */
E.setWorldSeed(SEED);
let t0 = now();
for (const [ci, cj] of cells) {
  for (let j = cj * 16; j < cj * 16 + 16; j++)
    for (let i = ci * 16; i < ci * 16 + 16; i++) E.generateColumn(i, j);
  for (const t of TYPE_IDS) if (terrain[t].dirty) E.flushLayer(terrain[t]);
}
const ensureMs = now() - t0;

/* 2b. refreshChunkAO après chaque chunk (appelé par updateDeco / unloadChunk) */
t0 = now();
for (const [ci, cj] of cells) E.refreshChunkAO(ci, cj);
const aoMs = now() - t0;

/* 2c. refreshCulling : parcours GLOBAL de tous les blocs, toutes les 250 ms */
player.pos.set(0, 10, 0);
t0 = now();
E.refreshCulling(true);
const cullMs = now() - t0;

/* 2d. unloadChunk : removeBlock bloc par bloc + refreshAOAround */
const one = cells[NCHUNK - 1];
t0 = now();
{
  const [ci, cj] = one;
  for (let j = cj * 16; j < cj * 16 + 16; j++)
    for (let i = ci * 16; i < ci * 16 + 16; i++)
      for (let k = 0; k < 64; k++) { const b = E.blockAt(i, j, k); if (b) E.removeBlock(i, j, k); }
  E.refreshChunkAO(ci, cj);
}
const unloadMs = now() - t0;

const totalBlocks = TYPE_IDS.reduce((n, t) => n + terrain[t].mesh.count, 0);
console.log('\n── 2. Architecture actuelle (mesuré sur le code réel, thread principal) ──');
console.log(`  ensureChunk (gen + addBlock + flush) : ${(ensureMs / NCHUNK).toFixed(2)} ms/chunk  ← BLOQUE le rendu`);
console.log(`  refreshChunkAO (48×48×64 cellules)   : ${(aoMs / NCHUNK).toFixed(2)} ms/chunk  ← BLOQUE le rendu`);
console.log(`  refreshCulling (parcours global)     : ${cullMs.toFixed(2)} ms toutes les 250 ms sur ${totalBlocks.toLocaleString('fr-FR')} blocs`);
console.log(`  unloadChunk (removeBlock ×N + AO)    : ${unloadMs.toFixed(2)} ms  ← BLOQUE le rendu`);
console.log(`  budget 16,7 ms/frame                 : ${(ensureMs / NCHUNK + aoMs / NCHUNK).toFixed(1)} ms de freeze par chunk chargé`);
console.log(`  objets JS « block » alloués          : ${totalBlocks.toLocaleString('fr-FR')} (+ 1 clé texte "i,j,k" chacun)`);

/* ================= 3. NOUVELLE ARCHI : thread principal ============== */
/* Réapplique exactement ce que fait chunkmesh.js à la réception :
   BufferGeometry + BufferAttribute + boundingSphere + Mesh. */
const matOpaque = new THREE.MeshLambertMaterial();
const matCutout = new THREE.MeshLambertMaterial({ alphaTest: 0.5 });
const matFluid = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
const MATS = { opaque: matOpaque, cutout: matCutout, fluid: matFluid };
const scene = new THREE.Scene();
let applyMs = 0, gpuBytes = 0;
t0 = now();
for (const { ci, cj, V } of volumes) {
  const B = {}; PC.meshChunk(V, ci, cj, B);
  for (const name of ['opaque', 'cutout', 'fluid']) {
    const L = PC.finish(B[name]);
    if (!L) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(L.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(L.normal, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(L.uv, 2));
    g.setAttribute('shade', new THREE.BufferAttribute(L.shade, 4, true));
    g.setIndex(new THREE.BufferAttribute(L.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(L.bounds.cx, L.bounds.cy, L.bounds.cz), L.bounds.r);
    const mesh = new THREE.Mesh(g, MATS[name]);
    mesh.position.set(ci * 16 * PC.HX, 0, cj * 16 * PC.HROW);
    scene.add(mesh);
    gpuBytes += L.bytes;
  }
}
applyMs = now() - t0;

console.log('\n── 3. Nouvelle architecture (thread principal, à la réception) ────');
console.log(`  construction des BufferGeometry      : ${(applyMs / NCHUNK).toFixed(2)} ms/chunk`);
console.log(`  upload GPU (somme des buffers)       : ${(gpuBytes / 1024 / NCHUNK).toFixed(1)} Kio/chunk`);
console.log(`  draw calls                           : ${scene.children.length} (${(scene.children.length / NCHUNK).toFixed(1)}/chunk) vs ${TYPE_IDS.length} InstancedMesh globaux non frustum-cullés`);
console.log(`  objets JS « block » alloués          : 0 (Uint8Array ${(16 * 16 * 64 * 2 / 1024).toFixed(0)} Kio/chunk)`);

/* ================= 3b. EMPREINTE MÉMOIRE =========================== */
if (global.gc) global.gc();
const heap0 = process.memoryUsage().heapUsed;
const store = new Map();
for (let n = 0; n < totalBlocks; n++) {
  store.set((n % 80) + ',' + ((n / 80) | 0) + ',' + (n % 64),
    { layer: terrain.stone, idx: n, type: 'stone', i: n % 80, j: (n / 80) | 0, k: n % 64, hidden: false });
}
if (global.gc) global.gc();
const heapMap = process.memoryUsage().heapUsed - heap0;
const ab0 = process.memoryUsage().arrayBuffers;
const voxStore = [];
for (let n = 0; n < NCHUNK; n++) voxStore.push(new Uint8Array(16 * 16 * 64 * 2));
const heapVox = process.memoryUsage().arrayBuffers - ab0;
void voxStore;
console.log('\n── 3b. Empreinte mémoire (mesurée sur le tas Node) ────────────────');
console.log(`  Map<"i,j,k", record> pour ${totalBlocks.toLocaleString('fr-FR')} blocs : ${(heapMap / 1048576).toFixed(2)} Mio  (${(heapMap / totalBlocks).toFixed(0)} o/bloc)`);
console.log(`  Uint8Array voxel pour ${NCHUNK} chunks                : ${(heapVox / 1048576).toFixed(2)} Mio  (${(heapVox / NCHUNK / 1024).toFixed(0)} Kio/chunk)`);
console.log(`  → facteur ${(heapMap / Math.max(1, heapVox)).toFixed(1)}× sur la représentation du monde`);
console.log(`  GPU (géométrie uploadée)        : ${(gpuBytes / 1048576).toFixed(1)} Mio pour ${NCHUNK} chunks`);

/* ================= 3c. COÛT DE growLayer() ========================== */
{
  const L = terrain.stone;
  const src = L.mesh;
  const t = now();
  const dst = new FakeInstancedMesh(src.max * 2);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  for (let n = 0; n < src.count; n++) { src.getMatrixAt(n, m4); dst.setMatrixAt(n, m4); src.getColorAt(n, col); dst.setColorAt(n, col); }
  const growMs = now() - t;
  console.log(`\n── 3c. growLayer() : recopie synchrone quand une couche est pleine ──`);
  console.log(`  ${src.count.toLocaleString('fr-FR')} instances de « stone » recopiées : ${growMs.toFixed(1)} ms  ← BLOQUE le rendu (×5 tableaux)`);
}

/* ================= 3d. COÛT GPU DE L'ARCHITECTURE ACTUELLE ========== */
/* Géométrie RÉELLE du moteur : CylinderGeometry(R, R, BH, 3, 1, false)
   .toNonIndexed().  Chaque chapeau est un éventail de 3 triangles → un prisme
   coûte 12 triangles et 36 sommets (et non 8/24 comme on le suppose souvent). */
const prismGeoNow = new THREE.CylinderGeometry(PC.R, PC.R, PC.BH, 3, 1, false).toNonIndexed();
const TRI_PER_PRISM = prismGeoNow.attributes.position.count / 3;
const VTX_PER_PRISM = prismGeoNow.attributes.position.count;
console.log('\n── 3d. Coût GPU de l\'architecture actuelle ───────────────────────');
console.log(`  géométrie d'un prisme : ${TRI_PER_PRISM} triangles / ${VTX_PER_PRISM} sommets (chapeaux en éventail de 3)`);
console.log(`  instances = tous les prismes chargés, dont ${(1 - facesEmitted / faceMax) * 100 | 0} % totalement invisibles`);
console.log(`  triangles soumis au GPU : ${(prismTotal * TRI_PER_PRISM / NCHUNK).toFixed(0)}/chunk`);
const BYTES_PER_PRISM = VTX_PER_PRISM * (12 + 12 + 8) + (64 + 12 + 4 + 4 + 4);
console.log(`  octets d'attributs      : ${BYTES_PER_PRISM} o PAR PRISME (${(BYTES_PER_PRISM * 1000 / 1048576).toFixed(2)} Mio / 1 000 prismes)`);
console.log(`    36 sommets × (position 12 + normale 12 + uv 8) + matrice 4×4 (64) + instanceColor (12) + aoBits/skyL/blkL (12)`);
console.log(`  nouveau pipeline        : ${(bytesTotal / prismTotal).toFixed(0)} o par prisme (${(BYTES_PER_PRISM / (bytesTotal / prismTotal)).toFixed(1)}× moins), faces cachées jamais allouées`);
console.log(`  frustum culling         : DÉSACTIVÉ (mesh.frustumCulled = false sur toutes les couches)`);


const before = ensureMs / NCHUNK + aoMs / NCHUNK;
console.log('\n── 4. Synthèse ────────────────────────────────────────────────────');
console.log(`  temps thread principal / chunk : ${before.toFixed(2)} ms  →  ${(applyMs / NCHUNK).toFixed(2)} ms   (×${(before / (applyMs / NCHUNK)).toFixed(0)} moins)`);
console.log(`  triangles envoyés au GPU       : ${(prismTotal * TRI_PER_PRISM / NCHUNK).toFixed(0)}  →  ${(triTotal / NCHUNK).toFixed(0)}   (×${(prismTotal * TRI_PER_PRISM / triTotal).toFixed(1)} moins)`);
console.log(`  faces conservées               : ${((facesEmitted / faceMax) * 100).toFixed(1)} % du plafond « 5 faces par prisme »`);
console.log(`  frames perdues à 60 FPS        : ${(before / 16.7).toFixed(1)} frame(s) de freeze par chunk chargé → 0`);
