/* =====================================================================
   4c. BLOCS SUPPLÉMENTAIRES « MINECRAFT » (laine, coffre, cactus, végétation)
   ---------------------------------------------------------------------
   Inclus AVANT `TYPE_IDS = Object.keys(TYPES)` : on complète simplement le
   dictionnaire TYPES, les couches InstancedMesh / textures / catalogue suivent.
   Les textures sont fournies par EXTRA_TEX[type] (appelé depuis le `default`
   de generateTexture avec ses helpers px / noiseFill) — toujours du Canvas 2D
   16×16, jamais de fichier externe.
   `light` = niveau lumineux 0..15 émis (utilisé par l'éclairage voxel, §6c).
   ===================================================================== */
Object.assign(TYPES, {
  wool:          { name: 'Laine',            color: 0xe9e9e9, cat: 'build', hard: 0.8, soft: true },
  wool_red:      { name: 'Laine rouge',      color: 0xb02e26, cat: 'build', hard: 0.8, soft: true },
  wool_blue:     { name: 'Laine bleue',      color: 0x3c44aa, cat: 'build', hard: 0.8, soft: true },
  wool_green:    { name: 'Laine verte',      color: 0x5e7c16, cat: 'build', hard: 0.8, soft: true },
  wool_yellow:   { name: 'Laine jaune',      color: 0xfed83d, cat: 'build', hard: 0.8, soft: true },
  wool_black:    { name: 'Laine noire',      color: 0x1d1d21, cat: 'build', hard: 0.8, soft: true },
  chest:         { name: 'Coffre',           color: 0xa8792f, cat: 'deco',  hard: 2.5, tool: 'axe', soft: true, container: true },
  cactus:        { name: 'Cactus',           color: 0x5a8f2e, cat: 'deco',  hard: 0.4, soft: true, hurts: true, scale: [0.9, 1, 0.9] },
  tallgrass:     { name: 'Herbes hautes',    color: 0x5aa03a, cat: 'deco',  hard: 0,   passable: true, plant: true, scale: [0.75, 0.7, 0.75], drop: null },
  flower_red:    { name: 'Coquelicot',       color: 0xd82424, cat: 'deco',  hard: 0,   passable: true, plant: true, scale: [0.28, 0.55, 0.28] },
  flower_yellow: { name: 'Pissenlit',        color: 0xf1d91c, cat: 'deco',  hard: 0,   passable: true, plant: true, scale: [0.28, 0.5, 0.28] },
  mossy_cobble:  { name: 'Pierre moussue',   color: 0x6a7d5a, cat: 'build', hard: 2,   tool: 'pickaxe' },
  netherrack:    { name: 'Netherrack',       color: 0x6e3634, cat: 'build', hard: 0.4, tool: 'pickaxe', soft: true },
  ice:           { name: 'Glace',            color: 0x9fc9ff, cat: 'deco',  hard: 0.5, transparent: true, opacity: 0.8, drop: null, slippery: true },
});
// Sources lumineuses (niveau 0..15, comme Minecraft) — la torche est déjà émissive visuellement
TYPES.torch.light = 14; TYPES.glowstone.light = 15; TYPES.lava.light = 15; TYPES.lavaflow.light = 12; TYPES.redstone_block.light = 4;

const EXTRA_TEX = {
  chest({ px, noiseFill, SIZE }) {
    noiseFill([168, 121, 47], 0.08);
    for (let x = 0; x < SIZE; x++) { px(x, 0, [90, 60, 20]); px(x, 15, [90, 60, 20]); px(x, 6, [70, 48, 18]); px(x, 7, [70, 48, 18]); }
    for (let y = 0; y < SIZE; y++) { px(0, y, [90, 60, 20]); px(15, y, [90, 60, 20]); }
    for (let y = 5; y < 10; y++) for (let x = 6; x < 10; x++) px(x, y, [70, 70, 75]);            // loquet
    px(7, 7, [30, 30, 30]); px(8, 7, [30, 30, 30]);
  },
  cactus({ px, noiseFill, SIZE }) {
    noiseFill([70, 130, 40], 0.12);
    for (let y = 0; y < SIZE; y++) { px(0, y, [40, 80, 20]); px(15, y, [40, 80, 20]); px(4 + (y % 2), y, [110, 170, 70]); px(11 - (y % 2), y, [110, 170, 70]); }
    for (let y = 1; y < SIZE; y += 3) { px(2, y, [220, 230, 200]); px(13, y + 1, [220, 230, 200]); }   // épines
  },
  tallgrass({ px, noiseFill, SIZE }) {
    noiseFill([70, 140, 45], 0.2);
    for (let x = 0; x < SIZE; x += 2) for (let y = 0; y < 4 + (x % 5); y++) px(x, y, [50, 100, 30]);
  },
  flower_red({ px, noiseFill, SIZE }) {
    noiseFill([60, 120, 40], 0.15);
    for (let y = 0; y < 7; y++) for (let x = 2; x < 14; x++) px(x, y, [216, 36, 36], 1 + ((x + y) % 3 - 1) * 0.08);
    for (let x = 6; x < 10; x++) for (let y = 2; y < 5; y++) px(x, y, [30, 20, 20]);
  },
  flower_yellow({ px, noiseFill, SIZE }) {
    noiseFill([60, 120, 40], 0.15);
    for (let y = 0; y < 7; y++) for (let x = 2; x < 14; x++) px(x, y, [241, 217, 28], 1 + ((x * 3 + y) % 3 - 1) * 0.08);
  },
  mossy_cobble({ px, noiseFill, SIZE, rnd }) {
    noiseFill([122, 122, 122], 0.16);
    for (let n = 0; n < 40; n++) px(Math.floor(rnd() * SIZE), Math.floor(rnd() * SIZE), [90, 130, 70], 1 + (rnd() - 0.5) * 0.3);
    for (let y = 0; y < SIZE; y += 4) for (let x = 0; x < SIZE; x++) px((x + y) % SIZE, y, [70, 70, 70]);
  },
  netherrack({ px, noiseFill, SIZE, rnd }) {
    noiseFill([110, 54, 52], 0.22);
    for (let n = 0; n < 30; n++) px(Math.floor(rnd() * SIZE), Math.floor(rnd() * SIZE), [70, 30, 30]);
  },
  ice({ px, noiseFill, SIZE }) {
    noiseFill([159, 201, 255], 0.06);
    for (let n = 0; n < 8; n++) px((n * 5) % SIZE, (n * 7) % SIZE, [230, 240, 255]);
    for (let y = 3; y < 12; y++) px(y, y, [200, 225, 255]);
  },
  wool({ px, noiseFill, SIZE }) { noiseFill([233, 233, 233], 0.07); for (let y = 0; y < SIZE; y += 3) for (let x = (y / 3) % 2; x < SIZE; x += 3) px(x, y, [205, 205, 205]); },
};
for (const w of ['wool_red', 'wool_blue', 'wool_green', 'wool_yellow', 'wool_black']) EXTRA_TEX[w] = ({ px, noiseFill, SIZE, base }) => { noiseFill(base, 0.07); for (let y = 0; y < SIZE; y += 3) for (let x = (y / 3) % 2; x < SIZE; x += 3) px(x, y, base, 0.85); };

/** Icônes pixel-art (16 lignes) des nouveaux objets ; résolu à l'appel (ICONS est défini plus loin). */
const EXTRA_ICON_GRIDS = {
  bone: ['................', '................', '..bb........bb..', '.bbbb......bbbb.', '.bbbbb....bbbbb.', '..bbbbbbbbbbbb..', '...bbbbbbbbbb...', '....bbbbbbbb....',
    '....bbbbbbbb....', '...bbbbbbbbbb...', '..bbbbbbbbbbbb..', '.bbbbb....bbbbb.', '.bbbb......bbbb.', '..bb........bb..', '................', '................'],
  arrow: ['..............ff', '.............fff', '............fhff', '...........fhhf.', '..........fhh...', '.........hhh....', '........hhh.....', '.......hhh......',
    '......hhh.......', '.....hhh........', '....hhh.........', '...hhh..........', '..wwh...........', '.www............', 'www.............', 'ww..............'],
  bow: ['......sss.......', '.....s...s......', '....s.....s.....', '...s.......s....', '...s.......s....', '..s.........s...', '..s.........s...', '..s..t......s...',
    '..s..t......s...', '..s.........s...', '..s.........s...', '...s.......s....', '...s.......s....', '....s.....s.....', '.....s...s......', '......sss.......'],
  gunpowder: ['................', '................', '.....g..g.......', '...g..gg..g.....', '....gggggg......', '..g.gggggg.g....', '...gggggggg.....', '..gggggggggg....',
    '...gggggggg.....', '..g.gggggg.g....', '....gggggg......', '...g..gg..g.....', '.....g..g.......', '................', '................', '................'],
  string: ['................', '..ww............', '...ww...........', '....ww..........', '.....ww.........', '......ww........', '.......ww.......', '........ww......',
    '.........ww.....', '..........ww....', '...........ww...', '............ww..', '.............ww.', '..............ww', '................', '................'],
  flint_and_steel: ['................', '......iiii......', '.....i....i.....', '....i......i....', '....i......i....', '.....i....i.....', '......iiii......', '........i.......',
    '.......iii......', '......fffff.....', '.....fffffff....', '.....fffffff....', '......fffff.....', '.......fff......', '................', '................'],
  egg: ['................', '................', '......ww........', '.....wwww.......', '....wwwwww......', '....wwwwww......', '...wwwwwwww.....', '...wwwwwwww.....',
    '...wwwwwwww.....', '...wwwwwwww.....', '....wwwwww......', '....wwwwww......', '.....wwww.......', '................', '................', '................'],
  feather: ['..............ww', '.............www', '............www.', '...........wwww.', '..........wwww..', '.........wwww...', '........wwww....', '.......wwww.....',
    '......wwww......', '.....wwww.......', '....wwww........', '...www..........', '..ww............', '.w..............', '................', '................'],
};
function extraIcon(id) {
  const P = {
    bone: { b: [235, 235, 220] }, arrow: { f: [200, 200, 200], h: [120, 90, 50], w: [230, 230, 230] }, bow: { s: [120, 80, 40], t: [220, 220, 220] },
    gunpowder: { g: [70, 70, 70] }, string: { w: [230, 230, 230] }, flint_and_steel: { i: [180, 180, 190], f: [80, 80, 90] },
    egg: { w: [240, 230, 200] }, feather: { w: [240, 240, 240] },
    mutton: { m: [230, 100, 110], f: [250, 240, 230], b: [230, 220, 200] }, cooked_mutton: { m: [150, 80, 50], f: [250, 240, 230], b: [230, 220, 200] },
    chicken: { m: [240, 200, 190], f: [250, 240, 230], b: [230, 220, 200] }, cooked_chicken: { m: [190, 120, 60], f: [250, 240, 230], b: [230, 220, 200] },
  };
  if (!P[id]) return null;
  return { grid: EXTRA_ICON_GRIDS[id] || ICONS.meat, pal: P[id] };
}
