/* =====================================================================
   6b. GÉNÉRATION DU MONDE « MINECRAFT » : biomes, grottes, minerais, végétation
   ---------------------------------------------------------------------
   Remplace l'ancien generateWorld().  Le relief utilise TOUJOURS le Perlin
   2D d'origine (fbm) ; on y superpose :
     • BIOMES (température / humidité, 2 bruits basse fréquence) :
         plaines  → herbe, herbes hautes, fleurs, arbres épars ;
         forêt    → arbres denses (chênes plus hauts) ;
         désert   → sable + grès en sous-couche, cactus, pas d'arbre ;
         toundra  → neige en surface, glace sur les lacs, sapins (feuilles étroites) ;
       + neige d'altitude (top ≥ 13) quel que soit le biome ;
     • GROTTES : deux bruits 3D « ridged » ; là où les deux crêtes se croisent
       on creuse un tunnel (largeur ~2-3 blocs), uniquement sous la surface
       (k < top − 2) pour garder le sol praticable, avec quelques entrées ;
       lacs de lave dans les cavités profondes (k ≤ 2) ;
     • MINERAIS : charbon partout, fer (k ≤ 9), or (k ≤ 4), diamant (k ≤ 3), en
       grappes (hash par cellule) — inchangé, mais exposés par les grottes ;
     • VÉGÉTATION : herbes hautes / coquelicots / pissenlits (blocs passables) ;
     • COFFRE DE DÉPART : un coffre près du spawn avec quelques objets.
   Toutes les décisions sont déterministes (seed 1337) → même monde à chaque
   chargement, ce qui préserve le journal de modifications de la sauvegarde.
   ===================================================================== */
const BIOME_IDS = ['plains', 'forest', 'desert', 'taiga'];
const biomeMap = new Uint8Array(WORLD_I * WORLD_J);
function biomeAt(i, j) { return BIOME_IDS[biomeMap[j * WORLD_I + i]] || 'plains'; }
/** Biome d'une colonne : température / humidité (Perlin basse fréquence). */
function computeBiome(wx, wz) {
  const temp = fbm(wx * 0.028 + 500, wz * 0.028 + 500, 2), hum = fbm(wx * 0.03 - 300, wz * 0.03 + 800, 2);
  if (temp > 0.22 && hum < 0.05) return 2;        // désert
  if (temp < -0.26) return 3;                      // toundra
  if (hum > 0.1) return 1;                         // forêt
  return 0;                                        // plaines
}
/** Grotte en (wx, k, wz) ? — intersection de deux crêtes de bruit 3D. */
function isCave(wx, k, wz) {
  const a = Math.abs(noise3(wx * 0.10 + 7, k * 0.13 + 3, wz * 0.10 + 11) - 0.5);
  const b = Math.abs(noise3(wx * 0.09 - 5, k * 0.12 + 9, wz * 0.11 - 2) - 0.5);
  return a < 0.055 && b < 0.055;
}

function generateWorld() {
  const _t = new THREE.Vector3(), _l = new THREE.Vector3();
  for (let j = 0; j < WORLD_J; j++) {
    for (let i = 0; i < WORLD_I; i++) {
      const wx = i * HX, wz = j * HROW;
      const bio = computeBiome(wx, wz); biomeMap[j * WORLD_I + i] = bio;
      let n = fbm(wx * 0.045 + 100, wz * 0.045 + 100, 4);
      n = n * 0.5 + 0.5;
      n = Math.pow(n, 1.35);
      if (bio === 2) n = n * 0.75 + 0.08;                                  // désert plus plat
      const top = 1 + Math.round(n * 13);
      heightMap[j * WORLD_I + i] = top;
      const beach = top <= WATER_LEVEL + 0.5;
      for (let k = 0; k <= top; k++) {
        let type;
        // ---- Grottes (jamais la bedrock ni les 2 blocs de surface, sauf entrée aléatoire) ----
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
          // Sous-sol 1.8 : roche + filons de granite / diorite / andésite / gravier (bruit 3D grossier)
          const v = fbm(wx * 0.11 + k * 0.17 + 900, wz * 0.11 - k * 0.13 + 300, 2);
          type = v > 0.34 ? 'granite' : v < -0.36 ? 'diorite' : (v > 0.2 && v < 0.26) ? 'andesite' : (v < -0.2 && v > -0.26 && k > 1) ? 'gravel' : 'stone';
          if (k <= 4 && k > 0 && v > -0.05 && v < 0.05 && top > 6) type = 'gold';
          // Minerais : charbon (fréquent, partout), fer (k ≤ 9), diamant (k ≤ 3, rare) — hash déterministe par cellule
          if (type === 'stone') { const o = hash2(i * 7 + k * 31, j * 13 + k * 17) % 1000; if (o < 30) type = 'coal_ore'; else if (o < 46 && k <= 9) type = 'iron_ore'; else if (o < 49 && k <= 3) type = 'diamond_ore'; }
          if (k === 1 && v > 0.42 && top > 8) type = 'lava';                       // poches de lave profondes (sous la roche)
          if (k > 1 && type === 'stone' && hash2(i * 3 + k, j * 5 - k) % 1000 < 6) type = 'mossy_cobble';
        }
        if (k === 0) type = 'stone';                                              // « bedrock » (protégée en survie)
        addBlock(i, j, k, type, false);
      }
      // Lacs : blocs SOURCE d'eau (grille) au-dessus du fond, jusqu'au niveau WATER_LEVEL ; glace en toundra
      for (let k = top + 1; k <= WATER_LEVEL; k++) addBlock(i, j, k, (bio === 3 && k === WATER_LEVEL) ? 'ice' : 'water', false);
      // ---- Végétation de surface (blocs passables) et cactus ----
      if (!beach && top < 13) {
        const r = hash2(i * 11 + 3, j * 17 + 5) % 1000;
        if (bio === 2) { if (r < 12) { const h = 1 + (r % 3); for (let k = 1; k <= h; k++) addBlock(i, j, top + k, 'cactus', false); } }
        else if (bio !== 3) {
          if (r < 140) addBlock(i, j, top + 1, 'tallgrass', false);
          else if (r < 152) addBlock(i, j, top + 1, 'flower_red', false);
          else if (r < 166) addBlock(i, j, top + 1, 'flower_yellow', false);
        }
      }
    }
  }
  // ---- Arbres : densité par biome (forêt ×3, désert 0), sapins en toundra ----
  const ci = Math.floor(WORLD_I / 2), cj = Math.floor(WORLD_J / 2);
  for (let j = 3; j < WORLD_J - 3; j++) {
    for (let i = 5; i < WORLD_I - 5; i++) {
      const top = heightMap[j * WORLD_I + i], bio = biomeMap[j * WORLD_I + i];
      if (top <= WATER_LEVEL + 0.5 || top >= 13 || bio === 2) continue;
      if (Math.abs(i - ci) < 4 && Math.abs(j - cj) < 3) continue;
      const density = bio === 1 ? 42 : bio === 3 ? 18 : 9;
      if (hash2(i, j) % 1000 >= density) continue;
      const ex = blockAt(i, j, top + 1); if (ex) removeBlock(i, j, top + 1);          // remplace l'herbe haute
      const pine = bio === 3;
      const trunkH = pine ? 5 + (hash2(j, i) % 3) : 4 + (hash2(j, i) % 2);
      for (let k = top + 1; k <= top + trunkH; k++) { if (!blockAt(i, j, k)) addBlock(i, j, k, 'wood', false); }
      cellCenter(i, j, 0, _t);
      for (let dj = -3; dj <= 3; dj++) for (let di = -6; di <= 6; di++) {
        const ii = i + di, jj = j + dj;
        cellCenter(ii, jj, 0, _l);
        const d = Math.hypot(_l.x - _t.x, _l.z - _t.z);
        if (pine) {                                                            // sapin : cône de feuilles étagé
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
    }
  }
  // ---- Coffre de départ (à 3 cellules du spawn) ----
  { const si = ci + 3, sj = cj; const t = heightMap[sj * WORLD_I + si]; const ex = blockAt(si, sj, t + 1); if (ex) removeBlock(si, sj, t + 1); addBlock(si, sj, t + 1, 'chest', false); STARTER_CHEST = cellKey(si, sj, t + 1); }
  for (const b of blocks.values()) computeAO(b);                          // AO initiale de tout le monde
  for (const t of TYPE_IDS) flushLayer(terrain[t]);
}
let STARTER_CHEST = null;
generateWorld();
