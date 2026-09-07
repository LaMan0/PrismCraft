# Analyse comparative Minecraft (Java 1.8) ↔ PrismCraft

Objectif : identifier ce qui fait « l'identité » de Minecraft, point par point, et
mesurer l'écart avec PrismCraft pour le réduire au maximum tout en conservant la
grille de prismes triangulaires (`CylinderGeometry(r, r, h, 3)`).

Légende : ✅ déjà équivalent · 🔶 partiel → complété dans cette itération · ❌ absent → ajouté · ⛔ hors périmètre (incompatible avec les prismes ou trop vaste)

## 1. Monde et génération

| Élément Minecraft | Rôle dans l'identité du jeu | PrismCraft avant | Après |
|---|---|---|---|
| Terrain par bruit de Perlin, collines douces | base du « look » | ✅ | ✅ (Perlin conservé) |
| **Biomes** (plaines, forêt, désert, montagnes enneigées, océan) | variété visuelle, motivation à explorer | ❌ un seul biome | ✅ 5 biomes par température/humidité |
| **Grottes** (tunnels vermiformes + cavernes) | exploration, minage, peur du noir | ❌ | ✅ bruit 3D (deux « vers » + cavernes) |
| Lacs de lave souterrains | danger, lumière dans les grottes | 🔶 poches | ✅ lave dans les grottes basses |
| **Minerais en filons** par profondeur (charbon > fer > or > diamant) | progression | 🔶 dispersion aléatoire | ✅ filons + profondeur MC |
| Bedrock indestructible | limite du monde | 🔶 « k = 0 » protégé | ✅ bloc *Bedrock* texturé |
| Arbres variés (chêne, bouleau, sapin) | biomes lisibles | 🔶 un seul arbre | ✅ 3 essences + cactus |
| Herbes hautes, fleurs (coquelicot, pissenlit) | vie des plaines | ❌ | ✅ (prismes fins traversables) |
| Sable/gravier qui tombent, eau et lave qui coulent | physique emblématique | ✅ | ✅ |
| Niveau de la mer, plages de sable | lecture du relief | ✅ | ✅ |
| Monde infini par chunks | ⛔ (monde fini 64×64 u, plus grand qu'avant : 48×48) | | 🔶 agrandi |

## 2. Lumière — l'élément le plus identitaire

Minecraft n'utilise **aucune lumière dynamique** : chaque cellule porte deux
valeurs 0-15 (*sky light* et *block light*) propagées par inondation, et la
luminosité d'une face suit la courbe `f/(4-3f)`. C'est ce qui rend les grottes
noires, les torches indispensables et les nuits angoissantes.

| Élément | Avant | Après |
|---|---|---|
| Sky light par colonne + propagation latérale | ❌ (éclairage Three.js uniforme) | ✅ moteur d'éclairage voxel (`src/lighting.js`) |
| Block light (torche 14, glowstone 15, lave 15) | ❌ (émissif local seulement) | ✅ inondation BFS, recalcul local ±16 |
| Courbe de luminosité `f/(4-3f)` + réglage « Luminosité » | ❌ | ✅ uniform shader, option Moody→Lumineux |
| Occlusion ambiante « smooth lighting » | ✅ | ✅ |
| Entités assombries dans les grottes | ❌ | ✅ (uniform par entité) |
| Blocs enfouis non rendus | ❌ | ✅ (culling des blocs enfermés, gain GPU) |

## 3. Ciel

| Élément | Avant | Après |
|---|---|---|
| Dégradé jour/nuit, aube orangée | ✅ | ✅ |
| **Soleil et lune carrés** | ❌ (disque) | ✅ |
| Étoiles la nuit, nuages plats qui dérivent | ✅ | ✅ |
| Brouillard coloré comme l'horizon | ✅ | ✅ |

## 4. Joueur

| Élément | Avant | Après |
|---|---|---|
| ZQSD/WASD, saut, sprint, sneak, vol créatif | ✅ | ✅ |
| **Élargissement du FOV en sprint** | ❌ | ✅ |
| Bobbing, bras animé, viewmodel | ✅ | ✅ |
| Vie, faim, saturation, armure, XP, bulles d'air | ✅ | ✅ |
| **Fissures de minage** sur le bloc (10 étapes) | 🔶 contour coloré | ✅ texture de fissures |
| Options (FOV, sensibilité, distance, luminosité, volume) | ❌ | ✅ menu Options |
| Skin Steve, armures visibles | ✅ | ✅ |

## 5. Blocs et objets

| Élément | Avant | Après |
|---|---|---|
| Craft 2×2 / 3×3, four | ✅ | ✅ |
| **Coffre** (27 emplacements, persistant) | ❌ | ✅ |
| **TNT qui explose** (amorçage, mèche 4 s, cratère) | ❌ (bloc décoratif) | ✅ |
| Laine (mouton) | ❌ | ✅ |
| Escaliers, dalles, portes, échelles | ⛔ (n'ont pas de sens sur des prismes) | |
| Redstone, enchantements, potions, Nether | ⛔ | |

## 6. Créatures

| Élément | Avant | Après |
|---|---|---|
| Zombie (mêlée, brûle au soleil) | ✅ | ✅ |
| **Creeper** (approche, sifflement, explosion) | ❌ | ✅ |
| **Squelette** (arc, flèches en cloche, brûle au soleil) | ❌ | ✅ |
| Cochon, vache | ✅ | ✅ |
| **Mouton** (laine) | ❌ | ✅ |
| Apparition nocturne dans l'obscurité (light level) | 🔶 nuit seulement | ✅ selon la lumière de la cellule |

## 7. Son — absent jusqu'ici, pourtant central

Minecraft est reconnaissable les yeux fermés : bruit de pas, « clac » de la pose,
craquement du minage, « oof », sifflement du creeper, grognement du zombie.

| Élément | Avant | Après |
|---|---|---|
| Effets sonores | ❌ | ✅ synthèse WebAudio procédurale (`src/audio.js`), aucun fichier externe |
| Musique C418 | ⛔ (droits) | — |

## 8. Interface

| Élément | Avant | Après |
|---|---|---|
| Hotbar, inventaire, HUD 1.8, police pixel | ✅ | ✅ |
| **Écran titre avec « splash » jaune animé** | ❌ | ✅ |
| Menu pause « Menu du jeu » avec Options | 🔶 | ✅ |
| Écran de mort, tchat, F3 | ✅ | ✅ |

## Architecture livrée

```
prismcraft/
├─ index.html              ← fichier unique à ouvrir (généré)
├─ build.py                ← assemble src/ dans index.html
└─ src/
   ├─ index.template.html  ← HTML/CSS + cœur du moteur (grille, prismes, joueur, UI)
   ├─ noise3.js            ← bruit de Perlin 3D (grottes)
   ├─ worldgen.js          ← biomes, grottes, minerais, arbres, végétation
   ├─ lighting.js          ← sky/block light, courbe MC, blocs enfouis
   ├─ explosions.js        ← explosions, TNT amorcée
   ├─ mobs_extra.js        ← creeper, squelette, flèches, mouton
   ├─ audio.js             ← effets sonores procéduraux
   ├─ chest.js             ← coffres
   └─ options.js           ← menu Options + splash
```

`python3 build.py` régénère `index.html` ; le jeu reste jouable en ouvrant ce seul fichier.
