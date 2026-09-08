/* =====================================================================
   bench/parity.mjs — PARITÉ moteur ⇄ worker
   ---------------------------------------------------------------------
   Extrait les VRAIES fonctions du jeu (makePerlin, makeNoise3, hash2,
   grille triangulaire, computeBiome/heightAt/isCave/generateColumn/
   placeTree de src/worldgen.js) depuis les fichiers sources, les exécute
   dans Node avec des stubs, puis compare cellule par cellule le résultat
   au volume produit par src/worker/prismcore.js.

   Ce n'est PAS une ré-implémentation : le code testé côté « référence »
   est extrait textuellement des fichiers livrés au navigateur.

   Usage : node bench/parity.mjs [ci cj ...]
   ===================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ---------- extraction d'une déclaration de haut niveau -------------- */
function extract(src, marker, label) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marqueur introuvable : ${label}`);
  if (src.indexOf(marker, at + 1) >= 0 && marker.startsWith('function')) {
    throw new Error(`marqueur ambigu : ${label}`);
  }
  if (!marker.includes('{')) {                                   // déclaration d'une ligne
    const end = src.indexOf('\n', at);
    return src.slice(at, end);
  }
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`accolades non équilibrées : ${label}`);
}

const tpl = read('src/index.template.html');
const noise3src = read('src/noise3.js');
const worldgen = read('src/worldgen.js');

const pieces = [
  extract(tpl, 'const S    = 1.0;', 'S'),
  extract(tpl, 'const R    = S / Math.sqrt(3);', 'R'),
  extract(tpl, 'const HROW = 1.5 * R;', 'HROW'),
  extract(tpl, 'const HX   = S / 2;', 'HX'),
  extract(tpl, 'const BH   = 1.0;', 'BH'),
  extract(tpl, 'const isUp = (i, j) =>', 'isUp'),
  extract(tpl, 'function cellCenter(i, j, k, out = new THREE.Vector3()) {', 'cellCenter'),
  extract(tpl, 'function worldToCell(x, y, z) {', 'worldToCell'),
  extract(tpl, 'function makePerlin(seed) {', 'makePerlin'),
  extract(tpl, 'const hash2 = (i, j) =>', 'hash2'),
  extract(tpl, 'const WATER_LEVEL = 4.0;', 'WATER_LEVEL'),
  extract(noise3src, 'function makeNoise3(seed) {', 'makeNoise3'),
  extract(worldgen, 'const CHUNK = 16;', 'CHUNK'),
  extract(worldgen, 'function computeBiome(wx, wz) {', 'computeBiome'),
  extract(worldgen, 'const biomeIndexAt = (i, j) =>', 'biomeIndexAt'),
  extract(worldgen, 'function heightAt(i, j) {', 'heightAt'),
  extract(worldgen, 'function isCave(wx, k, wz) {', 'isCave'),
  extract(worldgen, 'const h2 = (a, b) =>', 'h2'),
  extract(worldgen, 'function generateColumn(i, j) {', 'generateColumn'),
  extract(worldgen, 'function placeTree(i, j) {', 'placeTree'),
];

/* Le moteur déclare `let fbm = makePerlin(1337)` puis worldgen.js réassigne
   fbm/noise3 via setWorldSeed().  On reproduit exactement cet ordre. */
const body = `
${pieces.join('\n')}
let fbm = makePerlin(1337);
let noise3 = makeNoise3(1337);
let worldSeed = 0;
const _tv = new THREE.Vector3(), _lv = new THREE.Vector3();
function setWorldSeed(seed) { worldSeed = seed >>> 0; fbm = makePerlin(worldSeed); noise3 = makeNoise3(worldSeed); }
return { setWorldSeed, generateColumn, placeTree, heightAt, biomeIndexAt, computeBiome, isCave,
         makePerlin, makeNoise3, hash2, worldToCell, cellCenter, CHUNK, WATER_LEVEL,
         S, R, HROW, HX, BH, isUp,
         _h2: (a, b) => h2(a, b) };
`;

/* ---------- stubs minimaux (THREE.Vector3 + store de blocs) ------------ */
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
const store = new Map();
const addBlock = (i, j, k, type) => { store.set(i + ',' + j + ',' + k, type); return true; };
const removeBlock = (i, j, k) => store.delete(i + ',' + j + ',' + k);
const blockAt = (i, j, k) => { const t = store.get(i + ',' + j + ',' + k); return t ? { type: t } : undefined; };

const fn = new Function('THREE', 'addBlock', 'removeBlock', 'blockAt', 'cellKey', body);
const ref = fn({ Vector3: Vec3 }, addBlock, removeBlock, blockAt, (i, j, k) => i + ',' + j + ',' + k);

const PC = require(join(ROOT, 'src/worker/prismcore.js'));

/* ---------- table des types (celle du jeu, réduite aux champs utiles) --- */
const TYPES_SRC = extract(tpl, 'const TYPES = {', 'TYPES');
const TYPES = new Function(`${TYPES_SRC}; return TYPES;`)();
const EXTRA = read('src/blocks_extra.js');
const mExtra = EXTRA.match(/Object\.assign\(TYPES,\s*(\{[\s\S]*?\n\})\)/);
if (mExtra) Object.assign(TYPES, new Function(`return ${mExtra[1]}`)());

const TYPE_IDS = Object.keys(TYPES);
const defs = TYPE_IDS.map((t) => TYPES[t]);
PC.configure({ types: TYPE_IDS, defs });

/* ===================================================================== */
const args = process.argv.slice(2);
const cells = args.length ? [[+args[0], +args[1]]] : [[0, 0], [1, 0], [0, 1], [-1, 2], [3, -1]];
let failures = 0;

console.log('── 1. Parité du bruit (100 000 échantillons, seeds 1 / 1337 / 424242) ──');
for (const seed of [1, 1337, 424242]) {
  const a = ref.makePerlin(seed), b = PC.makePerlin(seed);
  const a3 = ref.makeNoise3(seed), b3 = PC.makeNoise3(seed);
  let bad2 = 0, bad3 = 0;
  for (let n = 0; n < 100000; n++) {
    const x = (n * 0.0371) % 97 - 48, y = (n * 0.0917) % 89 - 44;
    if (a(x, y, 4) !== b(x, y, 4)) bad2++;
    if (a3(x, n % 64, y, 2) !== b3(x, n % 64, y, 2)) bad3++;
  }
  const hs = (i, j) => ref.hash2(i, j) === PC.hash2(i, j);
  const badH = [...Array(20000).keys()].filter((n) => !hs(n * 7 - 5000, n * 13 - 9000)).length;
  console.log(`  seed ${String(seed).padStart(6)} : perlin2D diff=${bad2}  noise3 diff=${bad3}  hash2 diff=${badH}`);
  if (bad2 || bad3 || badH) failures++;
}

console.log('\n── 2. Parité du terrain généré (cellule par cellule) ──────────────');
for (const [ci, cj] of cells) {
  /* Référence : generateColumn sur le chunk + halo 2, puis arbres sur 3×3
     (exactement ce que font ensureChunk() puis decorateTrees()). */
  store.clear();
  ref.setWorldSeed(20260908);
  for (let j = cj * 16 - 2; j < cj * 16 + 18; j++)
    for (let i = ci * 16 - 2; i < ci * 16 + 18; i++) ref.generateColumn(i, j);
  for (let j = cj * 16 - 16; j < cj * 16 + 32; j++)
    for (let i = ci * 16 - 16; i < ci * 16 + 32; i++) ref.placeTree(i, j);

  /* Worker : même seed, même halo. */
  PC.setSeed(20260908);
  const V = PC.generateChunkVolume(ci, cj, 2);

  let diff = 0, filled = 0, firstBad = null;
  for (let j = cj * 16 - 2; j < cj * 16 + 18; j++) {
    for (let i = ci * 16 - 2; i < ci * 16 + 18; i++) {
      for (let k = 0; k < 64; k++) {
        const want = store.get(i + ',' + j + ',' + k) || null;
        const gotId = PC.getAt(V, i, j, k, ci, cj);
        const got = gotId ? PC.table.names[gotId - 1] : null;
        if (want) filled++;
        if (want !== got) { diff++; if (!firstBad) firstBad = { i, j, k, want, got }; }
      }
    }
  }
  const ok = diff === 0;
  if (!ok) failures++;
  console.log(`  chunk (${String(ci).padStart(2)},${String(cj).padStart(2)}) : ` +
    `${String(filled).padStart(5)} cellules pleines, ${String(diff).padStart(4)} différences  ${ok ? '✅' : '❌ ' + JSON.stringify(firstBad)}`);
}

console.log('\n── 3. Parité heightAt / biomeIndexAt / computeBiome ───────────────');
ref.setWorldSeed(20260908); PC.setSeed(20260908);
let dH = 0, dB = 0, dBio = 0;
for (let n = 0; n < 20000; n++) {
  const i = (n * 37) % 400 - 200, j = (n * 61) % 400 - 200;
  if (ref.heightAt(i, j) !== PC.heightAt(i, j)) dH++;
  if (ref.biomeIndexAt(i, j) !== PC.biomeIndexAt(i, j)) dB++;
  if (ref.computeBiome(i * ref.HX, j * ref.HROW) !== PC.computeBiome(i * PC.HX, j * PC.HROW)) dBio++;
}
console.log(`  heightAt diff=${dH}  biomeIndexAt diff=${dB}  computeBiome diff=${dBio}  (20 000 colonnes)`);
if (dH || dB || dBio) failures++;

console.log('\n── 4. Parité de la géométrie de grille ───────────────────────────');
let dW = 0;
for (let n = 0; n < 50000; n++) {
  const x = (n * 0.13) % 60 - 30, y = (n * 0.07) % 40, z = (n * 0.29) % 60 - 30;
  const a = ref.worldToCell(x, y, z), b = PC.worldToCell(x, y, z);
  if (a.i !== b.i || a.j !== b.j || a.k !== b.k) dW++;
}
console.log(`  worldToCell diff=${dW} sur 50 000 points`);
if (dW) failures++;

console.log(failures === 0 ? '\n✅ PARITÉ TOTALE : le worker reconstruit le monde du moteur à l\'identique.'
  : `\n❌ ${failures} groupe(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
