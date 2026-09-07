/* =====================================================================
   18b. MENU OPTIONS (style 1.8) + « splash » jaune de l'écran titre
   ---------------------------------------------------------------------
   OPTIONS (persistées dans localStorage « prismcraft:options ») :
     fov 30..110 (défaut 70 « Normal », comme Minecraft ; Quake Pro = 110),
     sensitivity 0.1..2 (× 0.002 rad/pixel de PointerLockControls),
     renderDistance 24..64 u (agit sur le culling ET le brouillard),
     volume 0..1 (SFX), bobbing on/off, clouds on/off, brightness 0..1
     (« Sombre » → « Lumineux » : plancher de la lumière du ciel la nuit).
   Le panneau est injecté dans #overlay (menu Échap) sous forme de curseurs
   Minecraft (boutons gris avec poignée) ; un bouton « Options… » est ajouté
   au menu, « Terminé » referme le panneau.
   ===================================================================== */
const OPTIONS_DEFAULT = { fov: 70, sensitivity: 1, renderDistance: 40, volume: 0.7, bobbing: true, clouds: true, brightness: 0.5 };
const OPTIONS = Object.assign({}, OPTIONS_DEFAULT, (() => { try { return JSON.parse(localStorage.getItem('prismcraft:options') || '{}'); } catch { return {}; } })());
let VIEW_DIST_CUR = OPTIONS.renderDistance;
/** Applique toutes les options au moteur (appelé au chargement et à chaque changement). */
function applyOptions() {
  controls.pointerSpeed = OPTIONS.sensitivity;
  SFX.setVolume(OPTIONS.volume);
  cloudGroup.visible = OPTIONS.clouds;
  if (VIEW_DIST_CUR !== OPTIONS.renderDistance) {
    VIEW_DIST_CUR = OPTIONS.renderDistance;
    scene.fog.near = VIEW_DIST_CUR * 0.55; scene.fog.far = VIEW_DIST_CUR;
    refreshCulling(true);
  }
  localStorage.setItem('prismcraft:options', JSON.stringify(OPTIONS));
}
const OPTION_DEFS = [
  { key: 'fov', label: 'Champ de vision', min: 30, max: 110, step: 1, fmt: v => v === 70 ? 'Normal' : v === 110 ? 'Quake Pro' : String(v) },
  { key: 'sensitivity', label: 'Sensibilité', min: 0.1, max: 2, step: 0.05, fmt: v => v >= 2 ? 'HYPERSPEED !!!' : Math.round(v * 100) + ' %' },
  { key: 'renderDistance', label: 'Distance d\u2019affichage', min: 24, max: 64, step: 4, fmt: v => v + ' blocs' },
  { key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, fmt: v => v <= 0 ? 'OFF' : Math.round(v * 100) + ' %' },
  { key: 'brightness', label: 'Luminosité', min: 0, max: 1, step: 0.05, fmt: v => v <= 0 ? 'Sombre' : v >= 1 ? 'Lumineux' : Math.round(v * 100) + ' %' },
  { key: 'bobbing', label: 'Balancement', toggle: true },
  { key: 'clouds', label: 'Nuages', toggle: true },
];
{
  const box = document.querySelector('#overlay .box'), menu = document.getElementById('menu');
  const panel = document.createElement('div'); panel.id = 'options-panel'; panel.className = 'hidden';
  panel.innerHTML = `<div class="opt-title">Options</div><div class="opt-grid"></div><button class="mc-btn opt-done">Terminé</button>`;
  box.appendChild(panel);
  const grid = panel.querySelector('.opt-grid');
  const render = () => {
    grid.innerHTML = OPTION_DEFS.map(d => {
      if (d.toggle) return `<button class="opt-btn" data-key="${d.key}">${d.label} : ${OPTIONS[d.key] ? 'OUI' : 'NON'}</button>`;
      const t = (OPTIONS[d.key] - d.min) / (d.max - d.min);
      return `<div class="opt-slider" data-key="${d.key}"><div class="opt-knob" style="left:calc(${(t * 100).toFixed(1)}% - ${(t * 10).toFixed(1)}px)"></div><span>${d.label} : ${d.fmt(OPTIONS[d.key])}</span></div>`;
    }).join('');
  };
  const setFromPointer = (el, clientX) => {
    const d = OPTION_DEFS.find(o => o.key === el.dataset.key); const r = el.getBoundingClientRect();
    let t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    let v = d.min + t * (d.max - d.min); v = Math.round(v / d.step) * d.step; v = +v.toFixed(3);
    if (OPTIONS[d.key] !== v) { OPTIONS[d.key] = v; applyOptions(); render(); }
  };
  let dragging = null;
  grid.addEventListener('pointerdown', e => {
    const b = e.target.closest('.opt-btn'); if (b) { OPTIONS[b.dataset.key] = !OPTIONS[b.dataset.key]; applyOptions(); render(); SFX.play('click'); return; }
    const sl = e.target.closest('.opt-slider'); if (sl) { dragging = sl; setFromPointer(sl, e.clientX); }
  });
  window.addEventListener('pointermove', e => { if (dragging) setFromPointer(dragging, e.clientX); });
  window.addEventListener('pointerup', () => { if (dragging) { dragging = null; SFX.play('click'); } });
  const btn = document.createElement('button'); btn.id = 'btn-options'; btn.textContent = '⚙ Options…';
  menu.insertBefore(btn, document.getElementById('btn-save'));
  const keys = box.querySelector('.keys');
  btn.addEventListener('click', e => { e.stopPropagation(); panel.classList.remove('hidden'); menu.classList.add('hidden'); keys.classList.add('hidden'); render(); SFX.play('click'); });
  panel.querySelector('.opt-done').addEventListener('click', e => { e.stopPropagation(); panel.classList.add('hidden'); menu.classList.remove('hidden'); keys.classList.remove('hidden'); SFX.play('click'); });
  panel.addEventListener('click', e => e.stopPropagation());
  // Splash jaune oscillant sous le titre (liste 1.8 + clins d'œil aux prismes)
  const SPLASHES = ['Triangulaire !', '100 % prismes !', 'Also try Minecraft!', 'Notch approuve ?', '√3 inside', 'Bienvenue en 1.8 !', 'Creeper ? Aww man', 'Pas de cube ici !', 'Hexagones cachés !', 'Made in Île-de-France', 'Tessellation !', 'Sans blocs carrés !'];
  const h1 = box.querySelector('h1');
  const splash = document.createElement('div'); splash.id = 'splash'; splash.textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
  h1.style.position = 'relative'; h1.appendChild(splash);
}
applyOptions();
