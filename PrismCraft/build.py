#!/usr/bin/env python3
"""Assemble PrismCraft into one standalone index.html.

The JavaScript files in src/ are intentionally fragments of the same ES module:
several of them extend dictionaries or replace engine functions.  Loading them
with independent <script src> tags would break their lexical scope, so this
builder inlines them in dependency order inside the single module of the HTML.
"""
from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
TEMPLATE = SRC / "index.template.html"
OUT = ROOT / "index.html"


def read(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


def block(name: str, code: str) -> str:
    return f"\n/* ===== PrismCraft extension: {name} ===== */\n{code.rstrip()}\n/* ===== End extension: {name} ===== */\n"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {n}")
    return text.replace(old, new, 1)


def insert_after(text: str, marker: str, code: str, label: str) -> str:
    return replace_once(text, marker, marker + code, label)


def extract_items_extra(src: str) -> tuple[str, str]:
    """Split the supplied historical items_extra.js at its natural phases.

    The file contains item definitions, additional recipes, and furnace data.
    Item definitions must precede ITEM_IDS; recipes must follow shaped(),
    shapeless(), SMELTING and FUEL.
    """
    m = re.search(r"Object\.assign\(ITEMS, \{.*?\n\}\);", src, re.S)
    if not m:
        raise RuntimeError("items_extra.js: Object.assign(ITEMS, ...) not found")
    items = src[m.start():m.end()]
    rest = src[m.end():].strip()
    return items, rest


def worker_bundle() -> str:
    """Concatène le noyau pur + l'entrée du Web Worker.

    Le résultat est inliné dans un <script type="text/prismcraft-worker"> :
    le navigateur ne l'exécute pas, mais chunkmesh.js en fait un Blob →
    `new Worker(URL.createObjectURL(...))`.  Le jeu reste donc un FICHIER
    UNIQUE, sans requête réseau pour le worker.
    """
    src = read("worker/prismcore.js") + "\n" + read("worker/chunkWorker.js")
    if "</script" in src.lower():
        raise RuntimeError("le source du worker contient '</script' : balise fermante prématurée")
    return src


def add_worker_tag(html: str) -> str:
    tag = (
        '\n<!-- Source du Web Worker de génération/maillage des chunks. type inconnu du\n'
        '     navigateur ⇒ jamais exécuté ici ; lu par chunkmesh.js puis chargé\n'
        '     comme Blob dans un vrai Worker. -->\n'
        '<script id="pc-chunk-worker" type="text/prismcraft-worker">\n'
        + worker_bundle()
        + "\n</script>\n"
    )
    return replace_once(html, "</head>", tag + "</head>", "worker script tag")


def add_options_css(html: str) -> str:
    css = r'''
  /* Options injected by options.js */
  #options-panel { width: 360px; margin: 0 auto; text-align: left; }
  #options-panel.hidden { display: none; }
  #options-panel .opt-title { text-align: center; color: #ffd54a; font-size: 14px; margin: 0 0 14px; text-shadow: 2px 2px #3f3f3f; }
  #options-panel .opt-grid { display: grid; gap: 8px; }
  #options-panel .opt-slider { position: relative; height: 30px; box-sizing: border-box; padding: 9px 10px 0; background: #555; border: 2px solid; border-color: #222 #aaa #aaa #222; cursor: ew-resize; color: #fff; font: 8px var(--mc-font); }
  #options-panel .opt-slider::before { content: ""; position: absolute; left: 10px; right: 10px; top: 20px; height: 3px; background: #222; box-shadow: inset 0 1px #999; }
  #options-panel .opt-slider span { position: relative; z-index: 1; text-shadow: 1px 1px #222; }
  #options-panel .opt-knob { position: absolute; z-index: 2; top: 16px; width: 20px; height: 10px; background: #c6c6c6; border: 2px solid; border-color: #fff #555 #555 #fff; box-sizing: border-box; pointer-events: none; }
  #options-panel .opt-btn, #options-panel .opt-done { width: 100%; box-sizing: border-box; }
  #splash { position: absolute; left: 105%; top: 52%; white-space: nowrap; transform: rotate(-12deg); color: #ffff55; font: 10px var(--mc-font); text-shadow: 2px 2px 0 #3f3f00; animation: splash-wobble .9s ease-in-out infinite alternate; }
  @keyframes splash-wobble { from { transform: rotate(-12deg) scale(1); } to { transform: rotate(-8deg) scale(1.08); } }
'''
    return replace_once(html, "</style>", css + "</style>", "options CSS")


def build() -> str:
    html = read("index.template.html")
    js_start = "import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';"

    # Audio and a declared lighting handle must be available to all fragments.
    # chunkmesh.js declares a single factory (createChunkRenderer) and collides
    # with nothing in the engine, so it can sit right at the top of the module.
    html = insert_after(html, js_start,
                        block("audio.js", read("audio.js")) +
                        block("chunkmesh.js", read("chunkmesh.js")) +
                        "\nlet LIGHT = null;\n",
                        "audio + chunkmesh + LIGHT declaration")

    # Add blocks before TYPE_IDS is frozen.
    blocks_extra = read("blocks_extra.js")
    html = replace_once(
        html,
        "const TYPE_IDS = Object.keys(TYPES);",
        block("blocks_extra.js", blocks_extra) + "\nconst TYPE_IDS = Object.keys(TYPES);",
        "blocks_extra before TYPE_IDS",
    )

    # Add extra item definitions before ITEM_IDS is frozen.
    items_extra = read("items_extra.js")
    item_defs, embedded_recipe_defs = extract_items_extra(items_extra)
    # Newer layouts keep recipe extensions in recipes_extra.js.  The fallback
    # also accepts the original attached items_extra.js, which bundled both.
    recipe_defs = read("recipes_extra.js") if (SRC / "recipes_extra.js").exists() else embedded_recipe_defs
    html = replace_once(
        html,
        "const ITEM_IDS = Object.keys(ITEMS);",
        block("items_extra.js (items)", item_defs) + "\nconst ITEM_IDS = Object.keys(ITEMS);",
        "items_extra before ITEM_IDS",
    )

    # Additional recipes/furnace rules need shaped(), SMELTING and FUEL.
    fuel_marker = re.search(r"const FUEL = \{.*?\};", html, re.S)
    if not fuel_marker:
        raise RuntimeError("base FUEL declaration not found")
    fuel = fuel_marker.group(0)
    html = replace_once(html, fuel,
                        fuel + block("items_extra.js (recipes)", recipe_defs),
                        "items_extra recipes after FUEL")

    # The extra texture dictionary and icon dictionary are declared before the
    # generators, then called by the two generator fallbacks.
    html = replace_once(
        html,
        "    default:\n      noiseFill(base, 0.12);\n  }",
        "    default:\n      if (EXTRA_TEX[type]) EXTRA_TEX[type]({ px, noiseFill, SIZE, base, rnd });\n      else noiseFill(base, 0.12);\n  }",
        "extra texture fallback",
    )
    icon_marker = "  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {"
    html = replace_once(
        html,
        icon_marker,
        "  const extra = typeof extraIcon === 'function' ? extraIcon(id) : null;\n"
        "  if (extra) { grid = extra.grid; pal = extra.pal; }\n" + icon_marker,
        "extra item icon fallback",
    )

    # Extra 3-D noise and the enhanced deterministic world generator.
    height_marker = "let fbm = makePerlin(1337);"
    html = insert_after(html, height_marker, block("noise3.js", read("noise3.js")), "noise3 after fbm")
    gen_re = re.compile(r"function generateWorld\(\) \{.*?\n\}\ngenerateWorld\(\);", re.S)
    matches = list(gen_re.finditer(html))
    if len(matches) != 1:
        raise RuntimeError(f"base generateWorld: expected 1 block, found {len(matches)}")
    html = html[:matches[0].start()] + block("worldgen.js", read("worldgen.js")) + html[matches[0].end():]

    # Allocate per-instance light attributes.  lighting.js fills them after
    # generation and refreshes them after edits.
    old_geo = "const geo = def.fluid ? prismGeo : prismGeo.clone();"
    new_geo = "const geo = prismGeo.clone();"
    html = replace_once(html, old_geo, new_geo, "clone geometry for light attributes")
    old_ao = """  let ao = null;
  if (!def.fluid) { ao = new THREE.InstancedBufferAttribute(new Float32Array(max), 1); ao.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aoBits', ao); attachAO(mat); }
"""
    new_ao = """  let ao = null;
  if (!def.fluid) { ao = new THREE.InstancedBufferAttribute(new Float32Array(max), 1); ao.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aoBits', ao); attachAO(mat); }
  // Two packed light levels per instance; lighting.js updates these arrays.
  const skyL = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const blkL = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  skyL.setUsage(THREE.DynamicDrawUsage); blkL.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('skyL', skyL); geo.setAttribute('blkL', blkL);
"""
    html = replace_once(html, old_ao, new_ao, "light attributes in makeLayer")
    # Feed packed voxel-light attributes into the existing AO shader.  This
    # keeps lighting.js visible in the final render without replacing the
    # palette, textures, or the ambient-occlusion pass.
    html = replace_once(
        html,
        "attribute float aoBits;\nfloat aoBit",
        "attribute float aoBits;\nattribute float skyL;\nattribute float blkL;\nuniform float uSkyLight;\nfloat packedLight(float p, float n) { return mod(floor(p / pow(16.0, n)), 16.0); }\nfloat aoBit",
        "voxel light shader declarations",
    )
    html = replace_once(
        html,
        "  vColor.rgb *= (1.0 - min(ao, 0.6));\n}",
        """  float skyFace = 15.0, blockFace = 0.0;
  if (n.y > 0.5) { skyFace = packedLight(skyL, 0.0); blockFace = packedLight(blkL, 0.0); }
  else if (n.y < -0.5) { skyFace = packedLight(skyL, 1.0); blockFace = packedLight(blkL, 1.0); }
  else { float lf = faceIndex(n); skyFace = packedLight(skyL, 2.0 + lf); blockFace = packedLight(blkL, 2.0 + lf); }
  float illum = clamp(max(skyFace * uSkyLight, blockFace) / 15.0, 0.24, 1.0);
  vColor.rgb *= (1.0 - min(ao, 0.6)) * (0.35 + 0.65 * illum);
}
""",
        "voxel light shader application",
    )
    html = replace_once(
        html,
        "  mat.onBeforeCompile = (sh) => {\n    sh.vertexShader = sh.vertexShader",
        "  mat.onBeforeCompile = (sh) => {\n    sh.uniforms.uSkyLight = (typeof LIGHT_U !== 'undefined' ? LIGHT_U.uSkyLight : { value: 1 });\n    sh.vertexShader = sh.vertexShader",
        "voxel light uniform",
    )
    html = replace_once(
        html,
        "return { type, mesh: im, depthPre, ao, idxToKey: [], max, dirty: false };",
        "return { type, mesh: im, depthPre, ao, skyL, blkL, idxToKey: [], max, dirty: false };",
        "return light attributes from makeLayer",
    )

    html = replace_once(
        html,
        "    if (layer.ao) { layer.ao.array[b.idx] = layer.ao.array[last]; layer.ao.needsUpdate = true; }\n    lb.idx = b.idx;",
        "    if (layer.ao) { layer.ao.array[b.idx] = layer.ao.array[last]; layer.ao.needsUpdate = true; }\n    if (layer.skyL) { layer.skyL.array[b.idx] = layer.skyL.array[last]; layer.skyL.needsUpdate = true; }\n    if (layer.blkL) { layer.blkL.array[b.idx] = layer.blkL.array[last]; layer.blkL.needsUpdate = true; }\n    lb.idx = b.idx;",
        "copy light attributes on swap-remove",
    )
    # Notify voxel lighting whenever a cell changes.
    html = replace_once(
        html,
        "  blocks.set(key, b);\n  layer.idxToKey[idx] = key;",
        "  blocks.set(key, b);\n  if (LIGHT) LIGHT.onChange(i, j, k, type);\n  layer.idxToKey[idx] = key;",
        "LIGHT addBlock hook",
    )
    html = replace_once(
        html,
        "  blocks.delete(key);\n  flushLayer(layer);",
        "  blocks.delete(key);\n  if (LIGHT) LIGHT.onChange(i, j, k, null);\n  flushLayer(layer);",
        "LIGHT removeBlock hook",
    )
    # Run the lighting engine once the enhanced world exists.
    world_marker = "/* Plus de socle plein sous le monde"
    html = replace_once(html, world_marker,
                        block("lighting.js", read("lighting.js")) +
                        "\n/* Plus de socle plein sous le monde",
                        "lighting after world generation")

    html = replace_once(
        html,
        "  const bob = Math.min(1, p.hSpeed / PLAYER.speed) * (p.onGround ? 1 : 0.3);",
        "  const bob = (typeof OPTIONS !== 'undefined' && !OPTIONS.bobbing) ? 0 : Math.min(1, p.hSpeed / PLAYER.speed) * (p.onGround ? 1 : 0.3);",
        "option-controlled bobbing",
    )

    # Dynamic render distance and option CSS/UI.
    html = replace_once(html, "const VIEW_DIST_SQ = VIEW_DISTANCE * VIEW_DISTANCE;",
                        "let VIEW_DIST_SQ = VIEW_DISTANCE * VIEW_DISTANCE;",
                        "mutable culling distance")
    html = add_options_css(html)
    html = add_worker_tag(html)
    options = read("options.js").replace(
        "  controls.pointerSpeed = OPTIONS.sensitivity;\n",
        "  controls.pointerSpeed = OPTIONS.sensitivity;\n"
        "  camera.fov = OPTIONS.fov; camera.updateProjectionMatrix();\n"
        "  VIEW_DIST_SQ = OPTIONS.renderDistance * OPTIONS.renderDistance;\n",
    )
    # Options must be evaluated after camera, clouds, controls and inventory UI exist.
    loop_marker = "/* =====================================================================\n   19. BOUCLE — deux passes"
    html = replace_once(html, loop_marker, block("options.js", options) + "\n" + loop_marker,
                        "options before render loop")

    # Mob extensions are declared after the base mob definitions and before spawnMob.
    mob_marker = "};\nfunction spawnMob(kind, x, y, z) {"
    html = replace_once(html, mob_marker,
                        "};\n" + block("mobs_extra.js", read("mobs_extra.js")) +
                        "\nfunction spawnMob(kind, x, y, z) {",
                        "mobs_extra after MOB_DEFS")
    old_model = """  let model;
  if (kind === 'zombie') {
"""
    new_model = """  let model = typeof buildExtraMob === 'function' ? buildExtraMob(kind) : null;
  if (!model && kind === 'zombie') {
"""
    html = replace_once(html, old_model, new_model, "extra mob model selection")
    html = replace_once(html,
                        "  } else model = buildQuadruped(kind);\n  // Matériaux clonés par mob",
                        "  } else if (!model) model = buildQuadruped(kind);\n  // Matériaux clonés par mob",
                        "extra mob fallback")
    html = replace_once(html,
                        "  mobs.push(mob);\n  registerHitbox(mob, def.hostile ? 0xff4040 : 0x40ff90);",
                        "  mobs.push(mob);\n  if (typeof decorateExtraMob === 'function') decorateExtraMob(mob);\n  registerHitbox(mob, def.hostile ? 0xff4040 : 0x40ff90);",
                        "extra mob decoration")
    # Extra mob AI is called by the base movement loop; its result adjusts the
    # common steering without replacing collision/gravity code.
    ai_marker = "    m.hurtT = Math.max(0, m.hurtT - dt); m.invuln = Math.max(0, m.invuln - dt);\n"
    html = insert_after(html, ai_marker,
                        "    const extraState = typeof updateExtraMobAI === 'function' ? updateExtraMobAI(m, dt, distP) : null;\n"
                        "    if (extraState === 'removed') continue;\n",
                        "extra mob AI call")
    html = replace_once(html,
                        "    if (def.hostile) {\n      if (ai.losT <= 0)",
                        "    if (extraState === 'stop') {\n      speed = 0; want.set(0, 0, 0);\n    } else if (def.hostile) {\n      if (ai.losT <= 0)",
                        "extra mob stop state")
    bounds_marker = "    // Bords du monde : demi-tour\n"
    html = insert_after(html, bounds_marker,
                        "    if (extraState === 'retreat') { want.set(m.pos.x - player.pos.x, 0, m.pos.z - player.pos.z).normalize(); speed = def.speed; }\n"
                        "    else if (extraState === 'strafe') { want.set(player.pos.x - m.pos.x, 0, player.pos.z - m.pos.z).normalize().applyAxisAngle(_UP, 1.2); speed = def.speed; }\n",
                        "extra mob steering states")
    # Spawn sheep/chicken with passives and all three hostile variants at night.
    html = replace_once(html,
                        "spawnMob(Math.random() < 0.5 ? 'pig' : 'cow', x, y, z);",
                        "spawnMob((() => { const r = Math.random(); return r < 0.35 ? 'pig' : r < 0.65 ? 'cow' : r < 0.83 ? 'sheep' : 'chicken'; })(), x, y, z);",
                        "extra passive spawn")
    html = replace_once(html,
                        "spawnMob('zombie', x, y, z); chatLog('§7Un zombie rôde dans les parages…');",
                        "const hostile = typeof pickHostileKind === 'function' ? pickHostileKind() : 'zombie';\n    spawnMob(hostile, x, y, z); chatLog(`§7Un ${MOB_DEFS[hostile].name.toLowerCase()} rôde dans les parages…`);",
                        "extra hostile spawn")

    html = replace_once(
        html,
        "          if (damagePlayer(def.dmg, 'zombie', m.pos)) { m.rig.armL.rotation.x = m.rig.armR.rotation.x = -2.2; }",
        "          if (damagePlayer(def.dmg, 'zombie', m.pos)) { if (m.rig.armL) m.rig.armL.rotation.x = m.rig.armR.rotation.x = -2.2; }",
        "guard extra mob arms",
    )
    html = replace_once(
        html,
        "    if (def.hostile && !isCreative()) {\n      if (day > 0.6",
        "    if (def.hostile && !def.creeper && !isCreative()) {\n      if (day > 0.6",
        "creeper daylight immunity",
    )

    # TNT/explosion code is placed after base mobs exist and before the chat/UI tail.
    chat_marker = "/* =====================================================================\n   16h. TCHAT & COMMANDES"
    html = replace_once(html, chat_marker, block("explosions.js", read("explosions.js")) + "\n" + chat_marker,
                        "explosions before chat")

    # Crack overlay can be built as soon as prismGeo exists; it is driven by
    # updateMining below.
    uv_marker = "  uv.needsUpdate = true;\n}\n\n/* =====================================================================\n   6. MONDE"
    html = replace_once(html, uv_marker,
                        "  uv.needsUpdate = true;\n}\n" + block("crack.js", read("crack.js")) +
                        """\n/* =====================================================================
   6. MONDE""",
                        "crack after prism geometry")
    html = replace_once(html,
                        "  if (!mouseButtons[0] || !controls.isLocked || inventoryOpen || isCreative() || !target || player.dead) { mining = null; highlight.material.color.setHex(0x111111); return; }",
                        "  if (!mouseButtons[0] || !controls.isLocked || inventoryOpen || isCreative() || !target || player.dead) { mining = null; highlight.material.color.setHex(0x111111); crack.visible = false; return; }",
                        "hide crack when not mining")
    html = replace_once(html,
                        "  const f = mining.t / mining.need;\n  highlight.material.color.setRGB",
                        "  const f = mining.t / mining.need;\n  updateCrack(f, i, j, k);\n  highlight.material.color.setRGB",
                        "update crack stage")
    html = replace_once(html,
                        "  if (f >= 1) { breakBlock(i, j, k, b.type); mining = null; }",
                        "  if (f >= 1) { breakBlock(i, j, k, b.type); mining = null; crack.visible = false; }",
                        "hide crack after break")

    # Chest extension is inserted after bindSlotGrid exists, before its first use.
    bind_marker = "}\nbindSlotGrid(invMainEl, INVENTORY, 'idx', false);"
    html = replace_once(html, bind_marker,
                        "}" + block("chest.js", read("chest.js")) +
                        "\nbindSlotGrid(invMainEl, INVENTORY, 'idx', false);",
                        "chest after bindSlotGrid")
    html = replace_once(html,
                        "  invFurnace.classList.toggle('hidden', mode !== 'furnace');\n  invTitle.textContent = mode === 'table' ? 'Fabrication' : mode === 'furnace' ? 'Four' : 'Inventaire';",
                        "  invFurnace.classList.toggle('hidden', mode !== 'furnace');\n  if (typeof invChest !== 'undefined') invChest.classList.toggle('hidden', mode !== 'chest');\n  invTitle.textContent = mode === 'table' ? 'Fabrication' : mode === 'furnace' ? 'Four' : mode === 'chest' ? 'Coffre' : 'Inventaire';",
                        "chest inventory mode")
    html = replace_once(html,
                        "  renderInventoryGrids();\n  setCursorStack(null);",
                        "  renderInventoryGrids();\n  if (mode === 'chest' && typeof renderChestGrid === 'function') renderChestGrid();\n  setCursorStack(null);",
                        "render chest on open")
    html = replace_once(html,
                        "function closeInventory(resume) {\n  inventoryOpen = false;",
                        "function closeInventory(resume) {\n  if (invMode === 'chest' && typeof syncChest === 'function') syncChest();\n  inventoryOpen = false;",
                        "sync chest on close")
    html = replace_once(html,
                        "  updateHotbar(); updateHeldItem();\n  if (resume && !controls.isLocked",
                        "  updateHotbar(); updateHeldItem();\n  if (typeof openChestKey !== 'undefined') openChestKey = null;\n  if (resume && !controls.isLocked",
                        "close chest state")
    # Chest interactions and TNT ignition share the right-click branch.
    interact_marker = "    const tb = target.block && TYPES[target.block.type];\n    if (tb?.interact && !player.sneaking) { openInventory(tb.interact === 'craft' ? 'table' : 'furnace'); return; }"
    interact_repl = """    const heldForUse = heldId();
    if (target.block?.type === 'tnt' && ITEMS[heldForUse]?.igniter) { primeTNT(target.hit.i, target.hit.j, target.hit.k); return; }
    const tb = target.block && TYPES[target.block.type];
    if (tb?.container && !player.sneaking) { openChest(target.hit); return; }
    if (tb?.interact && !player.sneaking) { openInventory(tb.interact === 'craft' ? 'table' : 'furnace'); return; }"""
    html = replace_once(html, interact_marker, interact_repl, "chest and TNT interaction")
    html = replace_once(html,
                        "function breakBlock(i, j, k, type) {\n  if (!removeBlock(i, j, k, true))",
                        "function breakBlock(i, j, k, type) {\n  if (type === 'chest' && typeof dropChestContent === 'function') dropChestContent(i, j, k);\n  if (!removeBlock(i, j, k, true))",
                        "drop chest contents")

    # Use the audio and TNT/arrow/light systems from the main loop and actions.
    html = insert_after(html,
                        "  spawnParticles(cellCenter(i, j, k, new THREE.Vector3()), def.color, 10, 2.5, 0.5);",
                        "  SFX.play('break', { pos: cellCenter(i, j, k, new THREE.Vector3()), type });\n",
                        "block break sound")
    html = replace_once(html,
                        "      else { recordEdit(i, j, k, id); consumeHeld(); }",
                        "      else { recordEdit(i, j, k, id); consumeHeld(); SFX.play('place', { pos: cellCenter(i, j, k, new THREE.Vector3()), type: id }); }",
                        "block place sound")
    html = insert_after(html,
                        "const clock = new THREE.Clock();",
                        "\nSFX.listener = player.pos;\n",
                        "audio listener")
    html = replace_once(html,
                        "  updateItems(dt);\n  updateFurnace(dt);",
                        "  updateItems(dt);\n  updateFurnace(dt);\n  updateTNT(dt);\n  updateArrows(dt);\n  updateBow(dt);",
                        "extra entity updates")
    html = replace_once(html,
                        "  updateDayNight(dt);\n  updateMobs(dt);",
                        "  updateDayNight(dt);\n  if (LIGHT) LIGHT.setDaylight(daylight());\n  if (LIGHT) LIGHT.update();\n  updateMobs(dt);",
                        "lighting updates")

    # Fix a couple of option-dependent engine values and expose extra APIs.
    html = replace_once(html,
                        "window.PrismCraft = { player, mobs, items, blocks, TYPES, ITEMS, HOTBAR, INVENTORY, cmd: runCommand,",
                        "window.PrismCraft = { player, mobs, items, blocks, TYPES, ITEMS, HOTBAR, INVENTORY, CHESTS: typeof CHESTS !== 'undefined' ? CHESTS : null, cmd: runCommand,",
                        "expose chests")

    return html


if __name__ == "__main__":
    result = build()
    OUT.write_text(result, encoding="utf-8")
    print(f"Écrit : {OUT} ({len(result.encode('utf-8')):,} octets)")
