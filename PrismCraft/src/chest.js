/* =====================================================================
   17b. COFFRES (27 slots par bloc, interface « Coffre » comme 1.8)
   ---------------------------------------------------------------------
   Chaque bloc `chest` possède son propre contenu dans CHESTS (Map clé de
   cellule → tableau de 27 piles), créé à la première ouverture et sauvegardé
   avec la partie.  Clic droit → openInventory('chest') : la zone supérieure
   de la fenêtre montre la grille 3×9 du coffre, câblée sur la même logique de
   slots (clickRealSlot : clic / clic droit / Maj+clic ↔ inventaire).  Casser
   le coffre fait tomber son contenu au sol.  Le coffre de départ contient de
   quoi commencer une partie en survie (outils en bois, torches, pain, arc).
   ===================================================================== */
const CHESTS = new Map();
let openChestKey = null;
const CHEST_VIEW = new Array(27).fill(null);                              // tableau « courant » lié à l'UI (référence stable pour bindSlotGrid)
{
  const win = document.getElementById('inv-window'), anchor = document.getElementById('inv-catalog');
  const box = document.createElement('div'); box.className = 'mc-table hidden'; box.id = 'inv-chest'; box.style.height = 'auto';
  box.innerHTML = `<div class="mc-label">Coffre</div><div class="mc-grid" id="chest-grid">${Array.from({ length: 27 }, (_, n) => `<div class="slot chest" data-ch="${n}"></div>`).join('')}</div>`;
  win.insertBefore(box, anchor);
}
const invChest = document.getElementById('inv-chest'), chestGridEl = document.getElementById('chest-grid');
/** Contenu d'un coffre (créé vide, ou garni pour le coffre de départ). */
function chestContent(key) {
  let c = CHESTS.get(key);
  if (!c) {
    c = new Array(27).fill(null);
    if (key === STARTER_CHEST) { [['wooden_pickaxe', 1], ['wooden_axe', 1], ['wooden_sword', 1], ['torch', 8], ['bread', 4], ['bow', 1], ['arrow', 16], ['planks', 12], ['apple', 3]].forEach(([id, n], q) => { c[q] = { id, n }; }); }
    CHESTS.set(key, c);
  }
  return c;
}
function openChest(cell) {
  openChestKey = cellKey(cell.i, cell.j, cell.k);
  const c = chestContent(openChestKey);
  for (let n = 0; n < 27; n++) CHEST_VIEW[n] = c[n];
  SFX.play('chest');
  openInventory('chest');
}
function renderChestGrid() {
  if (invMode !== 'chest') return;
  for (const el of chestGridEl.children) el.innerHTML = stackHTML(CHEST_VIEW[+el.dataset.ch]);
}
/** Recopie la vue dans le coffre réel (après chaque clic) — les piles sont partagées par référence, on synchronise juste les cases vidées/remplies. */
function syncChest() { if (!openChestKey) return; const c = CHESTS.get(openChestKey); if (c) for (let n = 0; n < 27; n++) c[n] = CHEST_VIEW[n]; }
bindSlotGrid(chestGridEl, CHEST_VIEW, 'ch', false, () => invMode === 'chest');
chestGridEl.addEventListener('click', () => { syncChest(); renderChestGrid(); });
chestGridEl.addEventListener('contextmenu', () => { syncChest(); renderChestGrid(); });
/** Maj+clic depuis l'inventaire avec un coffre ouvert → envoie la pile dans le coffre (au lieu de la hotbar). */
function chestQuickMove(st) {
  if (invMode !== 'chest') return false;
  const left = addToArr(CHEST_VIEW, st.id, st.n); st.n = left; syncChest(); renderChestGrid(); return true;
}
/** Un coffre cassé vide son contenu au sol. */
function dropChestContent(i, j, k) {
  const key = cellKey(i, j, k), c = CHESTS.get(key); if (!c) return;
  const pos = cellCenter(i, j, k, new THREE.Vector3());
  for (const st of c) if (st) spawnItem(st.id, pos.clone(), new THREE.Vector3((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2), st.n);
  CHESTS.delete(key);
}
