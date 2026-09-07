/* =====================================================================
   16i. MOBS SUPPLÉMENTAIRES 100 % PRISMES : Creeper, Squelette, Mouton, Poule
   ---------------------------------------------------------------------
   Modèles (CylinderGeometry(r, r, h, 3) uniquement, via prismMesh / limbPrism) :
     • CREEPER : corps vert haut (4×12×8 px → prisme aplati), tête avec la
       face triste (yeux et bouche = prismes plats noirs), 4 pattes courtes ;
       IA : approche silencieuse, à < 3 u déclenche la mèche (1,5 s, sifflement,
       gonflement + clignotement blanc) puis explode(pos, 3) ; recule si le
       joueur s'éloigne (> 6 u) avant la fin → mèche annulée ; brûle-pas au
       soleil (comme dans MC) mais despawn de jour à distance.
     • SQUELETTE : buildSteve(palette os) avec membres fins ; tient un arc ;
       IA : garde 8-12 u de distance, tire une flèche toutes les 2 s si ligne
       de vue (projectile prisme, gravité, dégâts 2-4, se plante dans les
       blocs) ; brûle au soleil comme le zombie.
     • MOUTON : quadrupède laineux (corps large blanc / coloré, tête sombre) ;
       clic droit… non : les moutons donnent laine + mouton à la mort ;
       broutent (tête baissée quand idle).
     • POULE : petit bipède blanc, bec jaune, crête rouge, chute lente
       (battement d'ailes), pond un œuf toutes les ~2 min.
   Spawn : creepers/squelettes la nuit avec les zombies (répartition
   50 % zombie / 30 % squelette / 20 % creeper) ; moutons/poules avec les
   passifs du départ.
   ===================================================================== */
const SKELETON_PALETTE = { skin: 0xd8d8d8, shirt: 0xc8c8c8, pants: 0xbcbcbc, shoes: 0xa8a8a8, hair: 0xc0c0c0, eye: 0x202020, iris: 0x202020, nose: 0x9a9a9a, mouth: 0x505050 };
Object.assign(MOB_DEFS, {
  creeper:  { name: 'Creeper',  hp: 20, speed: 2.4, dmg: 0, xp: 5, hostile: true, drops: [['gunpowder', 0, 2]], sound: 'fuse', creeper: true },
  skeleton: { name: 'Squelette', hp: 20, speed: 2.4, dmg: 3, xp: 5, hostile: true, drops: [['bone', 0, 2], ['arrow', 0, 2]], sound: 'skeleton', ranged: true },
  sheep:    { name: 'Mouton',   hp: 8,  speed: 1.3, xp: 1, drops: [['wool', 1, 1], ['mutton', 1, 2]], cooked: 'cooked_mutton', sound: 'sheep' },
  chicken:  { name: 'Poule',    hp: 4,  speed: 1.2, xp: 1, drops: [['feather', 0, 2], ['chicken', 1, 1]], cooked: 'cooked_chicken', sound: 'pop', chicken: true },
});
const WOOL_COLORS = ['wool', 'wool', 'wool', 'wool', 'wool_black', 'wool_yellow', 'wool_red', 'wool_blue', 'wool_green'];

function buildCreeper() {
  const skin = new THREE.MeshLambertMaterial({ color: 0x4caa3c }), dark = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
  const group = new THREE.Group(), rig = { legs: [] };
  const legH = 0.38, bodyH = 0.75, bodyW = 0.5;
  const torso = prismMesh(bodyW, bodyH, skin, { sz: 0.55 }); torso.position.y = legH + bodyH / 2; group.add(torso); rig.torso = torso;
  const headP = new THREE.Group(); headP.position.set(0, legH + bodyH, 0); group.add(headP); rig.head = headP;
  const head = prismMesh(0.5, 0.5, skin, { sz: 0.9 }); head.position.y = 0.25; headP.add(head);
  // Visage : yeux carrés-triangles + bouche en « ᗣ » (3 prismes plats noirs)
  for (const [x, y, w] of [[-0.12, 0.34, 0.11], [0.12, 0.34, 0.11], [0, 0.16, 0.1], [-0.07, 0.07, 0.07], [0.07, 0.07, 0.07]]) {
    const e = prismMesh(w, 0.015, dark, { sz: 1 }); e.rotation.x = Math.PI / 2; e.position.set(x, y, 0.27); headP.add(e);
  }
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const piv = new THREE.Group(); piv.position.set(sx * 0.13, legH, sz * 0.2);
    const leg = prismMesh(0.2, legH, skin, { sz: 0.8 }); leg.position.y = -legH / 2; piv.add(leg); group.add(piv); rig.legs.push(piv);
  }
  group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group, rig, height: legH + bodyH + 0.5, radius: 0.3, quadLegs: true };
}
function buildSheep() {
  const wool = new THREE.MeshLambertMaterial({ color: 0xececec }), skin = new THREE.MeshLambertMaterial({ color: 0xb59a86 }), dark = new THREE.MeshLambertMaterial({ color: 0x202020 });
  const group = new THREE.Group(), rig = { legs: [] };
  const L = 1.0, H = 0.7, W = 0.7, legH = 0.5;
  const torso = prismMesh(W, L, wool, { axis: 'z', sz: H / (W * 0.5) * 0.5 }); torso.position.y = legH + H * 0.45; group.add(torso); rig.torso = torso; rig.woolMat = wool;
  const headP = new THREE.Group(); headP.position.set(0, legH + H * 0.75, L * 0.45); group.add(headP); rig.head = headP;
  const head = prismMesh(0.4, 0.4, skin, { sz: 0.9 }); head.position.set(0, 0, 0.18); headP.add(head);
  const fleece = prismMesh(0.45, 0.2, wool, { sz: 0.9 }); fleece.position.set(0, 0.22, 0.1); headP.add(fleece);
  for (const sx of [-1, 1]) { const eye = prismMesh(0.07, 0.02, dark, { sz: 1 }); eye.rotation.x = Math.PI / 2; eye.position.set(sx * 0.11, 0.05, 0.36); headP.add(eye); }
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const piv = new THREE.Group(); piv.position.set(sx * W * 0.3, legH, sz * L * 0.33);
    const leg = prismMesh(0.18, legH, skin, { sz: 0.85 }); leg.position.y = -legH / 2; piv.add(leg);
    const tuft = prismMesh(0.22, legH * 0.3, wool, { sz: 0.9 }); tuft.position.y = -legH * 0.15; piv.add(tuft);
    group.add(piv); rig.legs.push(piv);
  }
  group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group, rig, height: legH + H + 0.1, radius: 0.36 };
}
function buildChicken() {
  const white = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 }), yellow = new THREE.MeshLambertMaterial({ color: 0xe8b83c }), red = new THREE.MeshLambertMaterial({ color: 0xc02020 }), dark = new THREE.MeshLambertMaterial({ color: 0x202020 });
  const group = new THREE.Group(), rig = { legs: [] };
  const legH = 0.28;
  const torso = prismMesh(0.38, 0.5, white, { axis: 'z', sz: 0.9 }); torso.position.y = legH + 0.22; group.add(torso); rig.torso = torso;
  const headP = new THREE.Group(); headP.position.set(0, legH + 0.42, 0.18); group.add(headP); rig.head = headP;
  const head = prismMesh(0.22, 0.32, white, { sz: 0.9 }); head.position.y = 0.16; headP.add(head);
  const beak = prismMesh(0.14, 0.08, yellow, { sz: 0.6 }); beak.position.set(0, 0.14, 0.17); headP.add(beak);
  const wattle = prismMesh(0.08, 0.1, red, { sz: 0.6 }); wattle.position.set(0, 0.04, 0.15); headP.add(wattle);
  for (const sx of [-1, 1]) { const eye = prismMesh(0.05, 0.02, dark, { sz: 1 }); eye.rotation.x = Math.PI / 2; eye.position.set(sx * 0.07, 0.22, 0.14); headP.add(eye); }
  rig.wings = [];
  for (const sx of [-1, 1]) { const wing = prismMesh(0.08, 0.34, white, { axis: 'z', sz: 1 }); wing.position.set(sx * 0.22, legH + 0.3, 0); group.add(wing); rig.wings.push(wing); }
  for (const sx of [-1, 1]) {
    const piv = new THREE.Group(); piv.position.set(sx * 0.08, legH, 0);
    const leg = prismMesh(0.08, legH, yellow, { sz: 0.8 }); leg.position.y = -legH / 2; piv.add(leg); group.add(piv); rig.legs.push(piv);
  }
  rig.legs.push(rig.legs[0], rig.legs[1]);                                 // l'animateur attend 4 pattes
  group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group, rig, height: legH + 0.6, radius: 0.2 };
}
/** Modèle d'un mob supplémentaire (retourne null pour les types de base). */
function buildExtraMob(kind) {
  if (kind === 'creeper') return buildCreeper();
  if (kind === 'sheep') return buildSheep();
  if (kind === 'chicken') return buildChicken();
  if (kind === 'skeleton') {
    const { group, rig } = buildSteve(SKELETON_PALETTE);
    group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    for (const p of [rig.armL, rig.armR, rig.legL, rig.legR]) p.scale.set(0.55, 1, 0.55);   // membres fins
    rig.held.visible = false; rig.heldIcon.visible = true; rig.heldIcon.material = iconMat('bow');
    rig.armL.rotation.x = rig.armR.rotation.x = -1.4;                                       // arc bandé
    return { group, rig, height: 1.9, radius: 0.22, humanoid: true };
  }
  return null;
}

/* ---- Flèches (projectiles) : prisme fin, gravité, se plante dans un bloc, blesse joueur / mobs ---- */
const arrows = [];
const arrowMat = new THREE.MeshLambertMaterial({ color: 0xd8c8a0 });
const arrowGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 3, 1, false).toNonIndexed(); arrowGeo.rotateX(Math.PI / 2); arrowGeo.computeVertexNormals();
function shootArrow(from, dir, speed, owner, dmg) {
  const mesh = new THREE.Mesh(arrowGeo, arrowMat); mesh.position.copy(from); scene.add(mesh);
  arrows.push({ mesh, pos: mesh.position, vel: dir.clone().multiplyScalar(speed), owner, dmg, life: 30, stuck: 0 });
  SFX.play('bow', { pos: from });
}
const _ap = new THREE.Vector3();
function updateArrows(dt) {
  for (let n = arrows.length - 1; n >= 0; n--) {
    const a = arrows[n]; a.life -= dt;
    if (a.life <= 0) { scene.remove(a.mesh); arrows.splice(n, 1); continue; }
    if (a.stuck) { if (a.owner === 'player' && !player.dead && a.pos.distanceToSquared(_ap.set(player.pos.x, player.pos.y + 0.9, player.pos.z)) < 1.2) { addToInventory('arrow', 1); refreshInv(); SFX.play('pop'); scene.remove(a.mesh); arrows.splice(n, 1); } continue; }
    a.vel.y -= GRAVITY * 0.8 * dt;
    const steps = 3, sx = a.vel.x * dt / steps, sy = a.vel.y * dt / steps, sz = a.vel.z * dt / steps;
    for (let s = 0; s < steps && !a.stuck; s++) {
      a.pos.x += sx; a.pos.y += sy; a.pos.z += sz;
      const c = worldToCell(a.pos.x, a.pos.y, a.pos.z);
      if (isSolid(c.i, c.j, c.k)) { a.stuck = 1; a.life = Math.min(a.life, 12); SFX.play('arrowhit', { pos: a.pos }); break; }
      if (a.owner !== 'player') {
        if (!player.dead && Math.abs(a.pos.x - player.pos.x) < 0.45 && Math.abs(a.pos.z - player.pos.z) < 0.45 && a.pos.y > player.pos.y && a.pos.y < player.pos.y + player.height) { damagePlayer(a.dmg, 'skeleton', a.owner.pos); scene.remove(a.mesh); arrows.splice(n, 1); a.stuck = 2; break; }
      } else {
        for (const m of mobs) if (!m.dying && Math.abs(a.pos.x - m.pos.x) < m.radius + 0.2 && Math.abs(a.pos.z - m.pos.z) < m.radius + 0.2 && a.pos.y > m.pos.y && a.pos.y < m.pos.y + m.height) {
          m.health -= a.dmg; m.hurtT = 0.5; m.ai.fleeT = 3; m.ai.memory = 8; m.kb.set(a.vel.x * 0.15, 0, a.vel.z * 0.15);
          spawnParticles(new THREE.Vector3(m.pos.x, m.pos.y + m.height * 0.6, m.pos.z), 0x9b1010, 6, 1.5); SFX.play(m.def.sound || 'hurt', { pos: m.pos });
          if (m.health <= 0) killMob(m, true);
          scene.remove(a.mesh); arrows.splice(n, 1); a.stuck = 2; break;
        }
      }
    }
    if (a.stuck === 2) continue;
    if (a.pos.y < -20) { scene.remove(a.mesh); arrows.splice(n, 1); continue; }
    a.mesh.lookAt(_ap.copy(a.pos).add(a.vel));
  }
}
/* ---- Arc du joueur : clic droit maintenu = bander (0..1 en 1 s), relâcher = tirer (consomme 1 flèche sauf créatif) ---- */
player.bowDraw = 0;
function updateBow(dt) {
  const held = heldId(), def = held && ITEMS[held];
  const rmb = mouseButtons[2] && controls.isLocked && !inventoryOpen && !player.dead;
  const hasArrow = isCreative() || HOTBAR.some(s => s && s.id === 'arrow') || INVENTORY.some(s => s && s.id === 'arrow');
  if (def?.bow && rmb && hasArrow) { player.bowDraw = Math.min(1, player.bowDraw + dt); return; }
  if (player.bowDraw > 0.15 && def?.bow) {
    const f = player.bowDraw;
    _eye.set(player.pos.x, player.pos.y + player.eye, player.pos.z); getViewDir(_dir);
    shootArrow(_eye.clone().addScaledVector(_dir, 0.4), _dir, 12 + 28 * f, 'player', Math.round(2 + 7 * f * f));
    if (!isCreative()) { const take = (arr) => { for (const s of arr) if (s && s.id === 'arrow') { s.n--; if (s.n <= 0) arr[arr.indexOf(s)] = null; return true; } return false; }; if (!take(HOTBAR)) take(INVENTORY); refreshInv(); }
    anim.swing = 0;
  }
  player.bowDraw = 0;
}

/* ---- Comportements spécifiques (appelés depuis updateMobs pour chaque mob) ---- */
function updateExtraMobAI(m, dt, distP) {
  const ai = m.ai, def = m.def;
  if (def.creeper) {
    // Mèche : déclenchée au contact, annulée si le joueur s'éloigne
    if (!isCreative() && !player.dead && distP < 3 && Math.abs(player.pos.y - m.pos.y) < 2.5 && ai.memory > 0) {
      if (!m.fuse) { m.fuse = 0.001; SFX.play('fuse', { pos: m.pos, minGap: 0 }); }
    } else if (m.fuse && distP > 6) m.fuse = 0;
    if (m.fuse) {
      m.fuse += dt;
      const sw = 1 + m.fuse * 0.25; m.group.scale.set(sw, 1 + m.fuse * 0.12, sw);
      for (const mat of m.mats) mat.emissive.setHex(Math.floor(m.fuse * 8) % 2 ? 0xffffff : 0x000000);
      if (m.fuse >= 1.5) { const pos = new THREE.Vector3(m.pos.x, m.pos.y + 0.8, m.pos.z); m.dying = 10; removeMob(mobs.indexOf(m)); explode(pos, 3); return 'removed'; }
      return 'stop';                                                       // immobile pendant la mèche
    } else m.group.scale.setScalar(1);
  }
  if (def.ranged) {
    // Squelette : garde ses distances (recul < 6 u, avance > 12 u) et tire toutes les 2 s
    ai.shootCd = (ai.shootCd ?? 1) - dt;
    if (ai.memory > 0 && !player.dead && !isCreative()) {
      if (ai.shootCd <= 0 && distP < 16 && lineOfSight(new THREE.Vector3(m.pos.x, m.pos.y + 1.6, m.pos.z), new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z))) {
        ai.shootCd = 2;
        const from = new THREE.Vector3(m.pos.x, m.pos.y + 1.5, m.pos.z), to = new THREE.Vector3(player.pos.x, player.pos.y + 1.0, player.pos.z);
        const d = to.distanceTo(from), dir = to.sub(from); dir.y += d * 0.045; dir.normalize();   // légère parabole
        shootArrow(from, dir, 20, m, 2 + Math.floor(Math.random() * 3));
        m.rig.armL.rotation.x = m.rig.armR.rotation.x = -1.9;
      }
      if (distP < 6) return 'retreat';
      if (distP < 11) return 'strafe';
    }
  }
  if (def.chicken) {
    if (!m.onGround && m.vel.y < -1) m.vel.y = Math.max(m.vel.y, -1.2);                     // chute lente (ailes)
    const flap = m.onGround ? 0 : Math.sin(anim.t * 30) * 0.8;
    if (m.rig.wings) { m.rig.wings[0].rotation.z = -flap - 0.1; m.rig.wings[1].rotation.z = flap + 0.1; }
    m.eggT = (m.eggT ?? 60 + Math.random() * 120) - dt;
    if (m.eggT <= 0) { m.eggT = 120 + Math.random() * 120; spawnItem('egg', new THREE.Vector3(m.pos.x, m.pos.y + 0.3, m.pos.z), new THREE.Vector3(), 1); SFX.play('pop', { pos: m.pos }); }
  }
  if (m.kind === 'sheep' && ai.state === 'idle') m.rig.head.rotation.x = 0.7;                // broute
  return null;
}
/** Le mouton reçoit une couleur de laine aléatoire (drop assorti). */
function decorateExtraMob(m) {
  if (m.kind === 'sheep') {
    const w = WOOL_COLORS[Math.floor(Math.random() * WOOL_COLORS.length)];
    m.woolType = w; m.def = { ...m.def, drops: [[w, 1, 1], ['mutton', 1, 2]] };
    for (const mat of m.mats) if (mat.color.getHex() === 0xececec) mat.color.setHex(TYPES[w].color);
  }
}
/** Tirage du type de monstre nocturne : 50 % zombie, 30 % squelette, 20 % creeper. */
function pickHostileKind() { const r = Math.random(); return r < 0.5 ? 'zombie' : r < 0.8 ? 'skeleton' : 'creeper'; }
