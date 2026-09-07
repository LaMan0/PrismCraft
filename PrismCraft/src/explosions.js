/* =====================================================================
   16h. TNT AMORCÉE ET EXPLOSIONS (Minecraft 1.8 simplifié)
   ---------------------------------------------------------------------
   • Clic droit avec un briquet sur une TNT (ou explosion voisine, ou feu de
     lave) → le bloc est retiré et remplacé par une ENTITÉ « primed TNT » :
     prisme rouge clignotant (blanc / rouge), physique simple (gravité,
     rebond), mèche 4 s (80 ticks), sifflement.
   • explode(pos, power) :
       - blocs : pour chaque cellule dans le rayon, on lance un rayon depuis
         le centre ; l'intensité power×(0.7..1.3) décroît de 0.3 par pas et
         de la résistance du bloc (hard/5) ; si elle reste > 0 le bloc saute
         (drop 1 fois sur 3, comme les 30 % de 1.8 ; TNT voisine → amorcée) ;
       - entités : dégâts = (1 − d/(2·power)) × 7·power (+ recul), sur le
         joueur, les mobs et les creepers ;
       - effets : 40 particules grises + fumée, son « explode », flash.
   • Les creepers appellent explode(pos, 3) ; la TNT power = 4.
   ===================================================================== */
const primedTNT = [];
const tntMatA = new THREE.MeshLambertMaterial({ map: TEX.tnt.texture }), tntMatB = new THREE.MeshBasicMaterial({ color: 0xffffff });
/** Transforme le bloc TNT (i,j,k) en entité amorcée. */
function primeTNT(i, j, k, fuse = 4) {
  const b = blockAt(i, j, k); if (!b || b.type !== 'tnt') return false;
  removeBlock(i, j, k); recordEdit(i, j, k, null);
  const mesh = new THREE.Mesh(prismGeo, tntMatA); mesh.scale.setScalar(0.98);
  cellCenter(i, j, k, mesh.position); mesh.quaternion.copy(isUp(i, j) ? Q_UP : Q_DOWN);
  scene.add(mesh);
  primedTNT.push({ mesh, pos: mesh.position, vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 2.5, (Math.random() - 0.5) * 0.4), fuse, t: 0 });
  SFX.play('fuse', { pos: mesh.position });
  return true;
}
function updateTNT(dt) {
  for (let n = primedTNT.length - 1; n >= 0; n--) {
    const e = primedTNT[n]; e.t += dt; e.fuse -= dt;
    e.vel.y -= GRAVITY * dt;
    const ny = e.pos.y + e.vel.y * dt, c = worldToCell(e.pos.x, ny - BH / 2, e.pos.z);
    if (e.vel.y < 0 && isSolid(c.i, c.j, c.k)) { e.pos.y = (c.k + 1) * BH + BH / 2; e.vel.y = 0; e.vel.x *= 0.5; e.vel.z *= 0.5; }
    else e.pos.y = ny;
    e.pos.x += e.vel.x * dt; e.pos.z += e.vel.z * dt;
    e.mesh.material = Math.floor(e.t * (e.fuse < 1 ? 16 : 6)) % 2 ? tntMatB : tntMatA;   // clignotement accéléré à la fin
    const s = 0.98 + (e.fuse < 0.5 ? (0.5 - e.fuse) * 0.6 : 0); e.mesh.scale.setScalar(s);
    if (e.fuse <= 0) { scene.remove(e.mesh); primedTNT.splice(n, 1); explode(e.pos.clone(), 4); }
  }
}
const _ex = new THREE.Vector3(), _exd = new THREE.Vector3();
function explode(pos, power) {
  SFX.play('explode', { pos, minGap: 0 });
  spawnParticles(pos, 0x444444, 40, power * 2.2, 1.2, 1);
  spawnParticles(pos, 0xffffff, 25, power * 1.6, 0.9, -1);
  hurtEl.style.opacity = '0.6'; setTimeout(() => { hurtEl.style.opacity = '0'; }, 120);
  // ---- Blocs : lancer de rayons vers une sphère de directions (16 × 8) ----
  const R = Math.ceil(power * 1.4), removed = new Set(), toPrime = [];
  for (let a = 0; a < 16; a++) for (let b = 0; b < 8; b++) {
    const th = a / 16 * Math.PI * 2, ph = (b + 0.5) / 8 * Math.PI;
    _exd.set(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
    let inten = power * (0.7 + Math.random() * 0.6);
    for (let d = 0.3; d < R + 1 && inten > 0; d += 0.3) {
      _ex.copy(pos).addScaledVector(_exd, d);
      const c = worldToCell(_ex.x, _ex.y, _ex.z), key = cellKey(c.i, c.j, c.k);
      const bl = blocks.get(key);
      if (bl) { const def = TYPES[bl.type]; inten -= ((def.hard ?? 1) / 5 + 0.3) * 0.3; if (inten > 0 && !removed.has(key) && c.k > 0 && !def.fluid) removed.add(key); }
      inten -= 0.3 * 0.3 * 3;
    }
  }
  for (const key of removed) {
    const b = blocks.get(key); if (!b) continue;
    const { i, j, k, type } = b;
    if (type === 'tnt') { toPrime.push([i, j, k]); continue; }
    removeBlock(i, j, k); recordEdit(i, j, k, null);
    if (Math.random() < 0.33 && !isCreative()) { const def = TYPES[type]; const drop = def.drop === undefined ? type : def.drop; if (drop) spawnItem(drop, cellCenter(i, j, k, new THREE.Vector3()), new THREE.Vector3((Math.random() - 0.5) * 3, 3, (Math.random() - 0.5) * 3), 1); }
  }
  for (const [i, j, k] of toPrime) primeTNT(i, j, k, 0.5 + Math.random());   // réaction en chaîne
  // ---- Entités ----
  const range = power * 2;
  const hurt = (p, applyDmg, kbFn) => { const d = p.distanceTo(pos); if (d > range) return; const f = 1 - d / range; applyDmg(Math.round(f * 7 * power + 1)); _exd.subVectors(p, pos).normalize(); kbFn(_exd, f); };
  hurt(new THREE.Vector3(player.pos.x, player.pos.y + 0.9, player.pos.z), dmg => { player.invuln = 0; damagePlayer(dmg, 'explosion'); }, (dir, f) => { player.kb.set(dir.x * 8 * f, 0, dir.z * 8 * f); player.vel.y = Math.max(player.vel.y, 6 * f); player.onGround = false; });
  for (const m of [...mobs]) hurt(m.pos, dmg => { m.health -= dmg; m.hurtT = 0.5; if (m.health <= 0) killMob(m, false); }, (dir, f) => { m.kb.set(dir.x * 8 * f, 0, dir.z * 8 * f); m.vel.y = Math.max(m.vel.y, 5 * f); });
}
DEATH_MSG.explosion = 'a explosé';
DEATH_MSG.creeper = 'a été soufflé par un Creeper';
DEATH_MSG.skeleton = 'a été criblé de flèches par un Squelette';
DEATH_MSG.cactus = 's\u2019est piqué à mort';
