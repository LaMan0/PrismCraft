# Architecture chunks — génération, maillage et rendu des prismes triangulaires

> Objectif : éliminer les micro-freezes de génération/maillage et tenir 60 FPS.
>
> Tous les chiffres de ce document sont **mesurés** sur ce dépôt par
> `node --expose-gc bench/bench.mjs` (voir §8). Le banc n'est pas une
> maquette : il extrait textuellement les fonctions du moteur
> (`addBlock`, `removeBlock`, `computeAO`, `refreshChunkAO`, `refreshCulling`,
> `generateColumn`, `placeTree`…) depuis `src/index.template.html` et
> `src/worldgen.js`, et les exécute sur de vraies classes `three`.

---

## 0. Résumé

| | Actuel (InstancedMesh globaux) | Cible (worker + maillage fusionné) | Gain mesuré |
|---|---|---|---|
| Thread principal / chunk chargé | **37 ms** (`ensureChunk` 2,5 + `refreshChunkAO` 34,3) | **1,3 ms** (construction des `BufferGeometry`) | **×29** |
| Thread principal / chunk déchargé | **78 ms** (`unloadChunk`) | ~0 (hors frame, `requestIdleCallback`) | — |
| Pics récurrents | `refreshCulling` **6,1 ms** toutes les 250 ms | 0 (frustum culling GPU) | — |
| Triangles soumis au GPU / chunk | **24 748** | **2 669** | **×9,3** |
| Mémoire « monde » (25 chunks) | **6,31 Mio** (43 931 objets + clés texte) | **0,78 Mio** (`Uint8Array`) | **×8,1** |
| Octets d'attributs GPU / prisme | **1 240 o** | **99 o** | **×12,5** |
| Frustum culling | **désactivé** (`frustumCulled = false`) | actif, sphère fournie par le worker | 34/60 meshes retenus en test |
| Frames perdues à 60 FPS | **2,2 frame** de freeze par chunk chargé | **0** | — |

> Les temps en millisecondes varient de ±30 % d'un lancement à l'autre (GC,
> fréquence CPU) : sur cette machine, la synthèse est remontée entre **×24 et
> ×29** selon les runs. Les **rapports** et les **comptages** (triangles, faces,
> octets, prismes) sont, eux, parfaitement déterministes — ce sont eux qu'il
> faut lire.

Le calcul lui-même (bruit + terrain + lumière + maillage) coûte **7,05 ms par
chunk** — il n'est pas « trop cher », il est simplement **au mauvais endroit**.
Le déplacer dans un Web Worker suffit à supprimer 100 % des freezes de
génération ; la suppression des faces cachées divise ensuite la charge GPU par 9.

---

## 1. Diagnostic : ce qui gèle réellement aujourd'hui

Quatre chemins du code, tous sur le thread principal :

### 1.1 `refreshChunkAO()` — 34,3 ms par chunk

```js
// src/worldgen.js
function refreshChunkAO(ci, cj) {
  const i0 = (ci - 1) * CHUNK, i1 = (ci + 2) * CHUNK, …;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) for (let k = 0; k < 64; k++) {
    const b = blockAt(i, j, k); if (b) computeAO(b);
  }
}
```

48 × 48 × 64 = **147 456 itérations**, chacune construisant une clé texte
`i + ',' + j + ',' + k` puis faisant un `Map.get`. C'est le poste n°1.
Appelé par `updateDeco()` (budget 2 chunks/frame ⇒ **~70 ms de freeze par
frame**) et par `unloadChunk()`.

### 1.2 `unloadChunk()` — 78 ms, sans budget

```js
// src/worldgen.js — updateChunks()
while (unloadQueue.length) { … unloadChunk(ci, cj); }     // ← non borné
```

Chaque `removeBlock()` appelle `refreshAOAround()`, qui visite ~81 cellules
(3 étages × 9 colonnes) avec clés texte. Pour ~2 000 blocs : **~160 000
`Map.get`**. Le commentaire du code dit « peu coûteux, hors de vue » : la
mesure dit 78 ms.

### 1.3 `refreshCulling()` — 6,1 ms toutes les 250 ms

```js
for (const b of blocks.values()) { …; if (far !== b.hidden) { b.hidden = far; writeMatrix(b); … } }
```

Parcours **global** des 43 931 blocs pour masquer à l'échelle 0 ceux hors de
`VIEW_DISTANCE`. C'est un contournement : comme `mesh.frustumCulled = false`
sur toutes les couches (`index.template.html:1304`), le GPU dessine tout, et le
culling est refait à la main côté CPU.

### 1.4 `growLayer()` — 3,1 ms de recopie synchrone

Quand une couche `InstancedMesh` est pleine, on double sa capacité en recopiant
matrices, couleurs, AO et lumière instance par instance, sur le thread
principal, en pleine frame.

### 1.5 Représentation mémoire

`blocks` est une `Map<"i,j,k", {layer, idx, type, i, j, k, hidden, level}>` :
**151 octets par bloc mesurés** (objet V8 + clé `String`), soit 6,31 Mio pour
25 chunks. Chaque `blockAt()` paie une concaténation + un hachage de chaîne.

---

## 2. Option A (pré-génération) vs Option B (streaming asynchrone)

### 2.1 Option A — tout générer à l'écran de chargement

| Critère | Évaluation pour PrismCraft |
|---|---|
| Temps d'attente | 7,05 ms/chunk **en parallèle** sur N workers. Un monde 64 × 64 chunks = 4 096 chunks ⇒ 28,9 s de CPU, ≈ **7,2 s sur 4 workers**. Inacceptable au-delà de ~32 × 32 chunks (1 024 chunks ≈ 1,8 s). |
| Fluidité en jeu | Parfaite **si** le monde tient : plus aucun calcul de terrain pendant la partie. |
| RAM | 32 Kio de voxels/chunk + ~200 Kio de géométrie. 64 × 64 chunks ⇒ **0,94 Gio**. Interdit sur mobile / onglet navigateur (quota ~2-4 Gio, et les `ArrayBuffer` comptent hors tas). |
| Limites de carte | Monde **fini**. Contradictoire avec `worldgen.js`, qui est déjà infini (`LOAD_RADIUS` / `UNLOAD_RADIUS`). |

**Verdict : à écarter**, sauf monde « carte fixe » ≤ 24 × 24 chunks.
Le coût n'est pas le problème (il est parallélisable), c'est l'empreinte :
un monde infini ne se pré-génère pas, par définition.

### 2.2 Option B — streaming asynchrone (retenue)

| Critère | Évaluation |
|---|---|
| Temps d'attente | Un seul chunk (celui du joueur) en synchrone au spawn : **7 ms**. Le reste arrive en continu. |
| Fluidité | 0 ms de thread principal pour le calcul ; **1,3 ms** à l'application d'un maillage, borné par `maxApplyPerFrame`. |
| RAM | Bornée par le rayon : `(2·r+1)²` chunks. r = 6 ⇒ 169 chunks ⇒ **5,4 Mio** de voxels + **34 Mio** de géométrie GPU. |
| Complexité | File de priorité, annulation des requêtes périmées, halo aux frontières, pool de workers. C'est le prix à payer, et il est circonscrit dans `chunkmesh.js`. |

**Verdict : Option B**, avec trois règles non négociables :

1. **Aucun calcul de terrain sur le thread principal.** Jamais, même « juste
   pour le chunk du joueur » — sauf au tout premier spawn, hors boucle de rendu.
2. **Budget par frame côté application.** Recevoir 12 maillages d'un coup ne
   doit pas coûter 12 × 1,3 ms dans la même frame.
3. **Priorité par distance + annulation.** Un chunk demandé puis quitté ne doit
   pas être maillé. D'où le `req` (numéro de requête) et le test
   `ch.req !== m.req` à la réception.

### 2.3 Comparaison synthétique

```
                  Option A (pré-gén.)      Option B (streaming)
Attente initiale  1,8 s (32×32) … 7,2 s    ~7 ms (1 chunk)
FPS en jeu        60 (si monde fini)       60 (budget d'application)
RAM à 64×64       0,94 Gio  ✗              — (n'existe pas)
RAM à r=6         —                        39 Mio  ✓
Monde infini      ✗                        ✓
Pire frame        0 ms                     1,3 ms × maxApplyPerFrame
```

### 2.4 Et `requestIdleCallback` ?

Utile, mais **pas pour la génération** : il ne donne aucun parallélisme, il
décale seulement sur le thread principal. On l'utilise ici pour ce qui est
vraiment différable et non critique : **le déchargement** (`scheduleUnload()`),
qui n'a aucune raison de tomber dans une frame de rendu. La génération, elle,
va dans un Worker — sinon `requestIdleCallback` ne ferait que déplacer le
freeze dans le temps.

---

## 3. Maillage des prismes triangulaires

### 3.1 Géométrie et topologie exactes

`S = 1`, `R = S/√3` (rayon circonscrit), apothème `R/2`, `HROW = 1,5 R`, `HX = S/2`.

```
UP   ((i+j) pair)   : pointe vers +Z, centre z = j·HROW + R/2
DOWN ((i+j) impair) : pointe vers −Z, centre z = j·HROW + R
```

Un prisme a **5 faces** : 2 chapeaux (±Y) + 3 latérales. La face latérale `f`
a pour normale l'angle `(f + 0,5)·120°` et relie les sommets d'anneau `f` et
`(f+1) mod 3`. La rotation de 180° des prismes DOWN ajoute 180° aux normales
mais **ne permute pas l'indexation** — la face `f` relie toujours `f` et `f+1`.

D'où la table de voisinage (vérifiée par `bench/parity.mjs` §4) :

| | face 0 | face 1 | face 2 |
|---|---|---|---|
| **UP** | `(i+1, j)` | `(i, j−1)` | `(i−1, j)` |
| **DOWN** | `(i−1, j)` | `(i, j+1)` | `(i+1, j)` |

> La face 1 est toujours le voisin « de rangée » ; les faces 0 et 2 sont
> échangées selon la parité. Toute la logique de culling tient dans ces deux
> tableaux (`NDI_UP/NDJ_UP`, `NDI_DN/NDJ_DN`).

### 3.2 Suppression des faces cachées — le gain principal

Une face est supprimée si le voisin est **occlusif**, ou si c'est le **même
type** (face interne d'un volume homogène) :

```js
function occludes(nb, self) {
  if (self === -1) return true;                                 // k < 0 : sous le monde
  if (nb === 0) return false;                                   // air
  if (nb === self) return (T.flags[self] & F_FOLIAGE) === 0;    // feuillage : on garde l'intérieur
  return (T.flags[nb] & F_OPAQUE) !== 0;
}
```

**Résultat mesuré** : sur 10 312 faces possibles par chunk, **1 853 sont
émises (18,0 %)**. Autrement dit **82 % des prismes ne produisent aucun
triangle** : ils ne sont ni alloués, ni transférés, ni uploadés, ni rastérisés.

Répartition : 816 latérales (2 triangles) + 1 037 chapeaux (1 triangle)
= **2 669 triangles**, contre **24 748** aujourd'hui (×9,3).

> Détail qui compte : la géométrie actuelle
> `CylinderGeometry(R, R, BH, 3, 1, false).toNonIndexed()` produit
> **12 triangles et 36 sommets** par prisme, pas 8/24 — chaque chapeau est un
> éventail de 3 triangles autour d'un sommet central. Le mailleur n'émet qu'**un**
> triangle par chapeau : une partie du gain vient de là.

**Feuillage** : ne pas auto-culler les faces internes des feuilles coûte cher
(`cutout` = 1 754 triangles sur 2 669). Passer `leaves` en `foliage: false`
donne **1 516 triangles/chunk, soit −43 %** — c'est le réglage « Fast » de
Minecraft. À exposer dans les Options.

### 3.3 Greedy meshing : pourquoi c'est (presque) inutile ici

Analyse géométrique, pas une intuition :

- **Faces latérales.** Seuls les prismes **UP** ont une face de normale 60°, et
  deux UP adjacents ont des faces 60° **non coplanaires** (décalage de
  `S·sin60°`). Aucune fusion horizontale n'est possible. Reste la fusion
  **verticale** : les faces de même `(i, j, f)` empilées en `k` sont coplanaires
  et fusionnables en un quad de hauteur `n`. Gain réel sur les falaises, nul
  ailleurs (ces faces sont de toute façon culled si le voisin est plein).
  **À faire en phase 2**, c'est exact et bon marché.

- **Chapeaux.** Un UP et un DOWN adjacents forment un parallélogramme exact :
  2 triangles → 2 triangles. **Aucun gain.** Sur `m` prismes alignés, on passe
  de `m` triangles à 2 (m pair) ou 3 (m impair) — le gain existe donc, mais il
  exige d'étirer **une seule texture** sur toute la bande. Avec une texture par
  type (le schéma actuel), il faut passer en `RepeatWrapping` et écrire des UV
  `0..n`, ce qui introduit du *mipmap bleeding* aux joints. **Non recommandé**
  sans atlas de textures.

- **Conclusion.** Le culling de faces + la fusion verticale + le batching par
  chunk donnent l'essentiel. Le greedy meshing « complet » n'est pas rentable
  sur une grille triangulaire : c'est une différence structurelle avec les
  cubes, pas un détail d'implémentation.

### 3.4 `InstancedMesh` ou maillage fusionné ?

`InstancedMesh` est un bon outil **quand toutes les instances sont visibles**.
Ici 82 % ne le sont pas : on paierait 64 octets de matrice par prisme pour ne
rien dessiner, et le nombre d'instances ne baisse qu'avec un culling CPU
manuel — exactement le `refreshCulling()` à 6,1 ms.

Le **maillage fusionné par chunk** gagne sur les deux tableaux : les prismes
invisibles ne sont jamais émis, et le frustum culling redevient exact parce que
chaque chunk a sa propre `boundingSphere` (test §4 : toutes les sphères
contiennent leur géométrie, 34/60 meshes retenus depuis `(0, 20, 0)`).

Coût : 2 à 3 *draw calls* par chunk (opaque / cutout / fluide) au lieu de 53
couches globales. À rayon 6 (169 chunks) cela fait ~400 draw calls — acceptable,
et un atlas de textures permettrait de retomber à 2.

### 3.5 Structures de données

**Volume voxel d'un chunk** — `Uint8Array`, 16 × 16 × 64 :

```js
{ types: Uint8Array(16384),     // 0 = air, sinon index+1 dans la table des types
  meta:  Uint8Array(16384),     // niveau de fluide 1..8
  sky:   Uint8Array(16384),     // lumière du ciel 0..15
  blk:   Uint8Array(16384) }    // lumière des blocs 0..15
```

- Index : `(k * W + lj) * W + li` — accès O(1), aucun hachage, aucune allocation.
- **32 Kio par chunk** pour `types + meta` ⇒ 8,1× moins que la `Map` actuelle.
- **Halo de 2 cellules** (`PAD = 2`) : le volume est `(16 + 2·2)² × 64`. Il sert
  au culling des faces frontalières, à l'AO et à la lumière **sans jamais lire
  un chunk voisin**. C'est ce qui rend le worker autonome et idempotent.
- `Uint8Array` impose ≤ 255 types. Le jeu en a ~60 : large marge. Au-delà,
  passer `types` en `Uint16Array` (64 Kio/chunk).
- Optimisation disponible : RLE par colonne (le sous-sol est quasi homogène)
  divise encore le transfert par ~5. Non implémenté : 32 Kio ne le justifient pas.

**Buffers de maillage** (par couche, par chunk) :

| Attribut | Type | o/sommet | Remarque |
|---|---|---|---|
| `position` | `Float32 ×3` | 12 | **local au chunk** — `mesh.position` porte l'origine ⇒ `float32` précis + petite `boundingSphere` |
| `normal` | `Int8 ×3` normalisé | 3 | les normales d'un prisme sont dans `{0, ±1/2, ±√3/2, ±1}` : `Math.round(n·127)` coûte 0,4 % d'erreur, invisible |
| `uv` | `Float32 ×2` | 8 | `Uint16` normalisé possible (−4 o) si on renonce au tiling |
| `shade` | `Uint8 ×4` normalisé | 4 | `[ao, ciel·16, bloc·16, teinte]` — tout l'ombrage en 4 octets |
| `index` | `Uint32` | 6 /sommet | `Uint16` dès que `vertexCount < 65 536` (toujours ici) : −50 % |

Total mesuré : **99 octets par prisme** contre 1 240 aujourd'hui (**×12,5**),
et **199,4 Kio de géométrie transférée par chunk** (auxquels s'ajoutent 32 Kio
de voxels, soit ~231 Kio au total — en transfert de propriété, pas en copie).

**AO par sommet** (et non plus par instance) : règle Minecraft
`ao = (s1 && s2) ? 0 : 3 − (s1 + s2 + coin)`, avec **bascule de la diagonale du
quad** quand l'occlusion est anisotrope (`aoB0 + aoT1 > aoB1 + aoT0`) pour
supprimer la couture d'éclairage. Le sommet `V[f]` d'une face `f` est partagé
par les faces `f` et `(f+2) mod 3` : ce sont les deux « côtés » du calcul.

---

## 4. Déport dans un Web Worker + Transferable Objects

### 4.1 Découpage

```
src/worker/prismcore.js   ← 100 % pur : grille, bruit, terrain, lumière, maillage
src/worker/chunkWorker.js ← protocole postMessage
src/chunkmesh.js          ← thread principal : pool, priorité, géométrie, pooling
```

`prismcore.js` ne touche ni `THREE`, ni `window`, ni le DOM. Il est chargé
**des deux côtés** — c'est la garantie qu'il n'existe qu'une seule définition
de la grille. `bench/parity.mjs` le vérifie en exécutant les fonctions du
moteur à côté de celles du worker.

### 4.2 Fichier unique préservé

Le jeu se distribue en **un seul `index.html`**. Un `chunkWorker.js` séparé
casserait cette propriété. Solution retenue dans `build.py` :

```python
def worker_bundle() -> str:
    src = read("worker/prismcore.js") + "\n" + read("worker/chunkWorker.js")
    if "</script" in src.lower():
        raise RuntimeError("le source du worker contient '</script'")
    return src
```

inliné dans `<script id="pc-chunk-worker" type="text/prismcraft-worker">` —
type inconnu du navigateur, donc **jamais exécuté** — puis :

```js
const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
const w = new Worker(blobUrl);
```

Aucune requête réseau, aucun CORS, `file://` fonctionne.

### 4.3 Protocole

```
main → worker
  { cmd:'init', seed, types:[…], defs:[…] }      // table des types = TYPE_IDS du moteur
  { cmd:'mesh', ci, cj, req, edits, keep }       // edits = journal du joueur
  { cmd:'drop', ci, cj }                          // vide le cache LRU
worker → main
  { cmd:'meshed', ci, cj, req, layers:{opaque,cutout,fluid}, voxels:{types,meta,w,pad}, ms }
  { cmd:'error', ci, cj, req, message }
```

### 4.4 Transferable Objects — le point critique

```js
function collectTransfer(layers, voxels) {
  const t = [];
  for (const name in layers) {
    const L = layers[name]; if (!L) continue;
    t.push(L.position.buffer, L.normal.buffer, L.uv.buffer, L.shade.buffer, L.index.buffer);
  }
  t.push(voxels.types.buffer, voxels.meta.buffer);
  return t;
}
self.postMessage({ …, layers, voxels }, collectTransfer(layers, voxels));
```

Le deuxième argument de `postMessage` **transfère la propriété** des
`ArrayBuffer` : le coût est celui d'un déplacement de descripteur
(~microsecondes), **pas** d'une copie ni d'un `structuredClone`. Sans lui,
199 Kio seraient sérialisés/désérialisés à chaque chunk — de l'ordre de
1 à 2 ms **sur le thread principal**, ce qui annulerait une partie du bénéfice.

Contrepartie à connaître : après le `postMessage`, les buffers du worker sont
**détachés** (`byteLength === 0`). D'où les `.slice(0)` dans `finish()` et pour
`voxels` : les builders du worker sont réutilisés d'un chunk à l'autre, il faut
donc en extraire une copie compacte **avant** le transfert. C'est un piège
classique ; il est traité ici.

### 4.5 Taille du pool

```js
const POOL = Math.max(1, workers || Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
```

`hardwareConcurrency − 1` : garder un cœur pour le rendu. Au-delà de 4 workers,
le gain est marginal (le pipeline est limité par l'application côté principal,
bornée par `maxApplyPerFrame`) et la mémoire des caches LRU double.

---

## 5. Implémentation

### 5.1 Fichiers livrés

| Fichier | Rôle | Statut |
|---|---|---|
| `src/worker/prismcore.js` | noyau pur partagé | ✅ implémenté, parité vérifiée |
| `src/worker/chunkWorker.js` | entrée worker, cache LRU, éditions | ✅ implémenté |
| `src/chunkmesh.js` | gestion thread principal | ✅ implémenté, 7 jeux de tests verts |
| `build.py` | inline le worker + le manager | ✅ câblé, `index.html` régénéré |
| `bench/parity.mjs` | parité moteur ⇄ worker | ✅ 0 divergence |
| `bench/chunkmesh.test.mjs` | intégration du manager | ✅ tous verts |
| `bench/bench.mjs` | mesures comparées | ✅ |

### 5.2 Worker — `chunkWorker.js`

```js
function mesh(ci, cj, req, edits, keep) {
  const key = ci + ',' + cj;
  let V = cache.get(key);                        // LRU 24 chunks
  if (!V) {
    V = PC.generateChunkVolume(ci, cj, PAD, scratch);   // terrain + halo + arbres
    PC.computeLight(V);                                  // sky + block, BFS
  }
  if (applyEdits(V, ci, cj, edits)) PC.computeLight(V);  // journal du joueur
  PC.meshChunk(V, ci, cj, builders);                     // culling + AO
  const layers = { opaque: PC.finish(builders.opaque), … };
  const voxels = { types: V.types.slice(0), meta: V.meta.slice(0), … };
  self.postMessage({ cmd:'meshed', ci, cj, req, layers, voxels, ms }, collectTransfer(layers, voxels));
}
```

Trois détails qui comptent :

- **`scratch` et `builders` sont réalloués une fois**, puis réutilisés : zéro
  allocation par chunk côté worker, donc pas de GC dans le worker non plus.
- **Cache LRU** : une édition joueur re-maille le chunk **sans le régénérer**
  (7 ms → 3 ms).
- **Les prédicats de `placeTree()` sont réordonnés** : le test de hash (le moins
  cher) passe en premier. Tous les prédicats étant purs, le résultat est
  **identique** — vérifié par `parity.mjs` — mais le rejet de ~97 % des
  colonnes ne paie plus 8 octaves de bruit.

### 5.3 Thread principal — `chunkmesh.js`

**File de priorité** (tas binaire sur la distance au carré) : le chunk du
joueur part en premier, les coins en dernier.

**Budget par frame** — c'est ce qui garantit l'absence de freeze :

```js
function apply() {
  let n = maxApplyPerFrame;                  // 3 par défaut
  while (n-- > 0 && pendingApply.length) {
    const { ch, m } = pendingApply.shift();
    ch.vox = m.voxels;
    for (const layer of LAYERS) applyLayer(ch.ci, ch.cj, layer, m.layers[layer]);
    ch.state = 'ready';
  }
}
```

`onmessage` **n'applique rien** : il empile et réveille les workers libres.
L'application a lieu dans `update()`, une fois par frame. Recevoir 12 chunks
d'un coup coûte donc 3 × 1,3 ms répartis sur 4 frames, pas 15 ms d'un bloc.
Vérifié par le test 1 : `max observé 2` avec `maxApplyPerFrame: 2`.

**Annulation** : chaque requête porte un numéro `req`. À la réception,
`ch.req !== m.req || !wanted.has(k)` ⇒ résultat jeté, aucun `Mesh` construit.
Les `ArrayBuffer` transférés partent au GC.

**Déchargement** :

```js
const idle = typeof requestIdleCallback === 'function'
  ? (fn) => requestIdleCallback(fn, { timeout: 250 })
  : (fn) => setTimeout(fn, 16);
```

avec **hystérésis** (`unloadRadius > radius`) et re-vérification `wanted.has(k)`
au moment de l'exécution : un chunk revenu dans le rayon pendant l'attente n'est
pas détruit. Test 5 : 107 `geometry.dispose()` et 25 chunks déchargés.

**Édition joueur** — `setBlock()` est O(1) dans le `Uint8Array`, puis ne
re-maille que les chunks concernés :

```js
if (li < PAD + 1)          touched.add(key(ci - 1, cj));
if (li >= VW - PAD - 1)    touched.add(key(ci + 1, cj));
```

La cellule modifiée vit dans le **halo des voisins** : leurs faces cachées
changent aussi. Test 6 : 1 re-maillage déclenché, 3 ordres `mesh` au worker
(le chunk central n'est pas en bordure ici).

### 5.4 Le shader (rappel d'intégration)

Le maillage fusionné remplace les attributs instanciés `aoBits` / `skyL` /
`blkL` par un **`attribute vec4 shade`** par sommet :

```glsl
attribute vec4 shade;                  // x = ao, y = ciel·16/255, z = bloc·16/255, w = teinte
varying vec4 vShade;
uniform float uSkyLight;
void main() {
  vShade = shade;
  …
}
// fragment
float sky  = vShade.y * (255.0 / 16.0);
float blk  = vShade.z * (255.0 / 16.0);
float illum = clamp(max(sky * uSkyLight, blk) / 15.0, 0.24, 1.0);
vColor.rgb *= (0.45 + 0.55 * vShade.x / 255.0) * (0.35 + 0.65 * illum) * (vShade.w);
```

C'est **plus simple** que le shader actuel (plus de `packedLight` /
`mod(floor(p / pow(16, n)), 16)`), et l'ombrage devient progressif au lieu
d'être constant par prisme.

---

## 6. GPU et mémoire

### 6.1 Frustum culling

Aujourd'hui : `im.frustumCulled = false` sur toutes les couches, avec le
commentaire *« la sphère englobante n'est pas fiable pour un InstancedMesh
dynamique »*. C'est exact — mais c'est une conséquence du choix d'un
InstancedMesh **global**, pas une fatalité.

Avec un mesh par chunk en **coordonnées locales** :

```js
g.boundingSphere = new THREE.Sphere(
  new THREE.Vector3(L.bounds.cx, L.bounds.cy, L.bounds.cz), L.bounds.r);
mesh.position.set(ci * CHUNK * HX, 0, cj * CHUNK * HROW);
mesh.frustumCulled = true;
```

La sphère est calculée **par le worker** (parcours des sommets, déjà en cache) :
le thread principal ne fait ni `computeBoundingSphere()` ni `computeBoundingBox()`.
Test 4 : les 60 sphères contiennent leur géométrie, `|centre| ≤ 16`, et le
frustum rejette 26 meshes sur 60 depuis `(0, 20, 0)`.

`refreshCulling()` et son `setInterval` de 250 ms **disparaissent** : le
culling hors champ est fait par Three.js, par chunk, à chaque frame, sans coût
CPU mesurable.

Reste le **culling par distance** (`VIEW_DISTANCE`) : il devient un simple
critère de plus dans `wanted` (rayon de chargement), donc gratuit — on ne
charge pas ce qu'on ne veut pas voir, au lieu de charger puis masquer.

### 6.2 Raycasting sur prismes triangulaires

L'actuel `pickTarget()` marche à **pas fixe 0,02** sur 6,5 unités
(**326 échantillons/frame**, chacun avec `worldToCell` + `Map.get` sur clé
texte), puis refait un `raycaster.intersectObject(ghost)` pour obtenir la
normale de face.

`chunkmesh.js` le remplace par un **DDA exact** : à chaque étape on calcule le
paramètre de sortie des 3 plans latéraux du prisme (distance au centre =
apothème `R/2`) et du plan horizontal, et on prend le minimum.

```js
for (let f = 0; f < 3; f++) {
  const nx = up ? NX[f] : -NX[f], nz = up ? NZ[f] : -NZ[f];
  const denom = dx * nx + dz * nz;
  if (denom <= 1e-9) continue;                     // parallèle ou entrant
  const tf = (INRADIUS - ((px - cx) * nx + (pz - cz) * nz)) / denom;
  if (tf >= 0 && tf < best) { best = tf; bf = f; }
}
```

- **Coût** : le nombre de cellules traversées (~8 pour `REACH = 6,5`), contre 326.
- **La normale est connue analytiquement** : la cellule de pose est *le voisin
  de l'autre côté de la face d'entrée*. Plus de `Raycaster`, plus de mesh
  fantôme, plus d'allocation par frame.
- **Deux pièges corrigés** (et couverts par les tests) :
  1. `tf >= 0` et non `tf > 1e-6`. Quand l'origine tombe exactement sur un plan
     (`y = k·BH`, bord de prisme), rejeter le `tf` nul rompt l'invariant
     « le point est dans la cellule courante » et la marche diverge.
  2. `oppositeFace()` doit recevoir les coordonnées de la **nouvelle** cellule.
     Dans `c = { …, face: oppositeFace(c.i, c.j, …) }` le membre de droite est
     évalué **avant** l'affectation : on passait l'ancienne cellule, donc une
     face d'entrée fausse et une cellule de pose du mauvais côté.

**Vérification** : oracle indépendant et exact (énumération de toutes les
cellules pleines de la boîte englobante + intersection rayon/prisme par test
des 5 plans). 3 533 rayons, 1 035 impacts, **0 divergence**, distance d'impact
exacte à 1e-6, cellule de pose vide et adjacente dans 100 % des cas.
Sont exclus et comptés à part 467 rayons dégénérés (parfaitement horizontaux à
hauteur entière : le rayon rase une arête partagée par 4 prismes) et 216
origines déjà dans un bloc (pose non définie).

### 6.3 Object pooling

```js
const releaseMesh = (mesh) => {
  if (mesh.parent) scene.remove(mesh);
  mesh.geometry.dispose();          // libère VBO + IBO côté GPU
  meshPool.push(mesh);
};
```

On recycle les **`Mesh`** (donc les `Object3D`, leurs matrices et leur place
dans la scène) ; la `BufferGeometry` est jetée puis recréée, parce que ses
`BufferAttribute` sont de tailles variables d'un chunk à l'autre. Recycler la
géométrie elle-même imposerait des buffers surdimensionnés au pire cas
(~250 Kio × pool) pour économiser une allocation de 5 objets — mauvais échange.

### 6.4 Libération propre de la mémoire GPU

`geometry.dispose()` est **indispensable** : Three.js ne libère pas les VBO/IBO
au garbage-collecteur, il les libère sur l'événement `dispose`. Sans cet appel,
chaque chunk déchargé laisse ses buffers VRAM jusqu'à la perte du contexte.
Test 5 : 107 `dispose()` pour 25 chunks déchargés (3 couches + géométries
intermédiaires), 0 objet restant après `CR.dispose()`.

Ordre correct : `scene.remove(mesh)` → `geometry.dispose()` → `vox = null`.
Les `ArrayBuffer` transférés n'ont **aucune** référence côté worker (ils sont
détachés) : `vox = null` suffit à les rendre au GC.

Le matériau, lui, est **partagé** (3 matériaux pour tout le monde) et ne doit
jamais être disposé au déchargement d'un chunk.

### 6.5 Budgets recommandés

| Rayon | Chunks | Voxels | GPU géométrie | Draw calls |
|---|---|---|---|---|
| 4 | 81 | 2,5 Mio | 16 Mio | ~200 |
| 6 | 169 | 5,4 Mio | 34 Mio | ~400 |
| 8 | 289 | 9,2 Mio | 58 Mio | ~700 |

`radius = 6` / `unloadRadius = 8` est un bon défaut. Un chunk mesure
16 × `HX` = **8 unités** en X et 16 × `HROW` = **13,9 unités** en Z : le
brouillard actuel (`VIEW_DISTANCE = 40`) couvre donc ~5 chunks en X et ~3 en Z,
ce qui masque entièrement la frontière de chargement dans l'axe le plus court.
Dans l'axe X il faudra soit monter le brouillard à 56, soit descendre
`radius` à 5.

---

## 7. Migration et état d'avancement

### 7.1 Ce qui est fait et vérifié

Le pipeline complet existe, compile, est inliné dans `index.html`
(36 228 octets de worker, `node --check` OK ; module de 335 080 octets,
`node --check` OK), et passe ses tests.

### 7.2 Ce qui reste à faire

**Le jeu exécute toujours le rendu `InstancedMesh` actuel.** `chunkmesh.js` est
présent dans le bundle mais pas branché sur la boucle de rendu : basculer
impose de porter les systèmes qui consomment `blocks` et `terrain` —

| Système | Dépendance à porter |
|---|---|
| physique sable/eau (`schedule`/`pending`) | `blocks` → `CR.setBlock()` + re-maillage |
| éclairage `lighting.js` | déjà refait dans le worker ⇒ à **retirer** du thread principal |
| mobs / collisions | `isSolid()` → `CR.isSolid()` (même signature) |
| explosions, TNT, coffres | `blockAt`/`addBlock`/`removeBlock` → `CR.getBlock`/`setBlock` |
| sauvegarde (`edits`) | déjà prévu : le worker réapplique le journal |
| minage / pose | `pickTarget()` → `CR.raycast()` |

Ce port touche la physique, la lumière et la sauvegarde : il doit être validé
**dans un navigateur**. Or cet environnement n'a ni navigateur installable
(CDN Playwright injoignant, pas de droits `apt`) ni WebGL — je n'ai donc **pas**
pu valider le rendu ni le framerate réel. C'est la raison pour laquelle la
bascule n'a pas été faite : livrer un moteur de rendu non vérifié à la place
d'un moteur qui fonctionne aurait été un recul.

### 7.3 Ordre de bascule recommandé

1. **Gains immédiats, sans risque** (à faire même sans le worker) :
   borner la boucle de déchargement (`while (unloadQueue.length)` → budget 1
   par frame) ; ne pas appeler `refreshAOAround()` pendant les opérations en
   masse ; remplacer le balayage 48 × 48 × 64 de `refreshChunkAO()` par une
   liste des cellules du chunk. Ces trois corrections suppriment les freezes de
   34 ms et 78 ms **dans l'architecture existante**.
2. Brancher `CR.update()` et le rendu des chunks à côté de l'ancien, avec un
   drapeau, et comparer visuellement.
3. Porter la physique et la sauvegarde.
4. Supprimer `lighting.js` du thread principal, `refreshCulling()`,
   `growLayer()` et la `Map blocks`.

---

## 8. Reproduire les mesures

```bash
npm install                                   # racine du dépôt (dossier contenant PrismCraft/)
npm run parity                                # parité moteur ⇄ worker
npm test                                      # intégration du gestionnaire de chunks
npm run bench                                 # mesures comparées (25 chunks)
npm run check                                 # les trois à la suite

cd PrismCraft && python3 build.py             # régénère index.html
```

Équivalents directs : `node PrismCraft/bench/parity.mjs`,
`node PrismCraft/bench/chunkmesh.test.mjs`,
`node --expose-gc PrismCraft/bench/bench.mjs 25` (le dernier argument est le
nombre de chunks). `three` n'est requis **que** par les bancs — le jeu continue
de le charger par importmap depuis le CDN.

`bench/parity.mjs` mérite une note : il **extrait textuellement** `makePerlin`,
`makeNoise3`, `hash2`, `worldToCell`, `computeBiome`, `heightAt`, `isCave`,
`generateColumn` et `placeTree` depuis les fichiers livrés au navigateur, les
exécute avec des stubs, puis compare cellule par cellule. Résultat :

```
seed      1 : perlin2D diff=0  noise3 diff=0  hash2 diff=0
seed   1337 : perlin2D diff=0  noise3 diff=0  hash2 diff=0
seed 424242 : perlin2D diff=0  noise3 diff=0  hash2 diff=0
chunk ( 0, 0) :  3285 cellules pleines,    0 différences  ✅
…
worldToCell diff=0 sur 50 000 points
✅ PARITÉ TOTALE
```

Le worker reconstruit donc **le même monde**, à la cellule près, avec la même
seed. Les deux seules libertés prises sont documentées dans `prismcore.js` :
réordonnancement de prédicats purs dans `placeTree()`, et remplacement de
`addBlock()`/`blockAt()` par des écritures directes dans le volume rembourré.
