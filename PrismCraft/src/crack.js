/* =====================================================================
   14b. FISSURES DE MINAGE (destroy_stage_0 … 9) — overlay sur le bloc visé
   ---------------------------------------------------------------------
   Minecraft superpose 10 textures de fissures pendant le minage.  Ici les 10
   étapes sont dessinées en Canvas 16×16 (fissures noires semi-transparentes,
   de plus en plus ramifiées, PRNG fixe) et appliquées sur un prisme légèrement
   agrandi (×1.01, transparent, polygonOffset) posé sur la cellule minée.
   updateCrack(f, i, j, k) : f ∈ [0,1] → étape floor(f·10).
   ===================================================================== */
const CRACK_TEX = (() => {
  const list = [];
  const rnd = mulberry32(777);
  // Fissures cumulatives : on part d'un canvas vide et on ajoute des segments à chaque étape
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const ctx = cv.getContext('2d');
  const segs = [];
  for (let stage = 0; stage < 10; stage++) {
    const n = 2 + stage * 2;
    for (let q = 0; q < n; q++) {
      const x = Math.floor(rnd() * 16), y = Math.floor(rnd() * 16), len = 2 + Math.floor(rnd() * (3 + stage));
      const dx = rnd() < 0.5 ? 1 : -1, dy = rnd() < 0.5 ? 1 : -1, horiz = rnd() < 0.5;
      segs.push({ x, y, len, dx, dy, horiz });
    }
    ctx.clearRect(0, 0, 16, 16);
    for (const sg of segs) {
      let x = sg.x, y = sg.y;
      for (let t = 0; t < sg.len; t++) {
        ctx.fillStyle = `rgba(0,0,0,${0.55 + rnd() * 0.3})`;
        ctx.fillRect(((x % 16) + 16) % 16, ((y % 16) + 16) % 16, 1, 1);
        if (sg.horiz) { x += sg.dx; if (rnd() < 0.3) y += sg.dy; } else { y += sg.dy; if (rnd() < 0.3) x += sg.dx; }
      }
    }
    const tex = new THREE.CanvasTexture(cv);                   // CanvasTexture copie le canvas au premier upload
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
    // Forcer la copie immédiate (sinon toutes les textures partageraient l'état final du canvas)
    const img = document.createElement('canvas'); img.width = img.height = 16; img.getContext('2d').drawImage(cv, 0, 0);
    tex.image = img;
    list.push(tex);
  }
  return list;
})();
const crackMat = new THREE.MeshBasicMaterial({ map: CRACK_TEX[0], transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const crack = new THREE.Mesh(prismGeo, crackMat);
crack.scale.setScalar(1.01); crack.visible = false; crack.renderOrder = 2;
scene.add(crack);
let crackStage = -1;
function updateCrack(f, i, j, k) {
  const st = Math.min(9, Math.floor(f * 10));
  if (st !== crackStage) { crackStage = st; crackMat.map = CRACK_TEX[st]; crackMat.needsUpdate = true; }
  cellCenter(i, j, k, crack.position);
  crack.quaternion.copy(isUp(i, j) ? Q_UP : Q_DOWN);
  crack.visible = true;
}
