/* =====================================================================
   4d. OBJETS ET RECETTES SUPPLÉMENTAIRES (arc, flèches, os, poudre, laine…)
   ---------------------------------------------------------------------
   Inclus juste après la déclaration d'ITEMS et des recettes (avant ITEM_IDS).
   ===================================================================== */
Object.assign(ITEMS, {
  bone:            { name: 'Os',               cat: 'misc', material: true },
  arrow:           { name: 'Flèche',           cat: 'tools', ammo: true },
  bow:             { name: 'Arc',              cat: 'tools', bow: true, dmg: 1, stack: 1, tier: 0 },
  gunpowder:       { name: 'Poudre à canon',   cat: 'misc', material: true },
  string:          { name: 'Ficelle',          cat: 'misc', material: true },
  flint_and_steel: { name: 'Briquet',          cat: 'tools', igniter: true, stack: 1, tier: 2 },
  egg:             { name: 'Œuf',              cat: 'misc', material: true, stack: 16 },
  feather:         { name: 'Plume',            cat: 'misc', material: true },
  mutton:          { name: 'Mouton cru',       cat: 'food', food: 2, sat: 1.2 },
  cooked_mutton:   { name: 'Mouton cuit',      cat: 'food', food: 6, sat: 9.6 },
  chicken:         { name: 'Poulet cru',       cat: 'food', food: 2, sat: 1.2 },
  cooked_chicken:  { name: 'Poulet cuit',      cat: 'food', food: 6, sat: 7.2 },
});
shaped(['PPP', 'P P', 'PPP'], { P: 'planks' }, ['chest', 1]);
shaped([' SW', 'S W', ' SW'], { S: 'stick', W: 'string' }, ['bow', 1]);
shaped(['F', 'S', 'E'], { F: 'cobblestone', S: 'stick', E: 'feather' }, ['arrow', 4]);
shaped(['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: 'sand' }, ['tnt', 1]);
shapeless(['iron_ingot', 'cobblestone'], ['flint_and_steel', 1]);
shapeless(['cobblestone', 'tallgrass'], ['mossy_cobble', 1]);
shaped(['WW', 'WW'], { W: 'string' }, ['wool', 1]);
shapeless(['wool', 'flower_red'], ['wool_red', 1]);
shapeless(['wool', 'flower_yellow'], ['wool_yellow', 1]);
shapeless(['wool', 'cactus'], ['wool_green', 1]);
shapeless(['wool', 'coal'], ['wool_black', 1]);
shapeless(['wool', 'diamond_ore'], ['wool_blue', 1]);
shapeless(['bone'], ['wool', 1]);                                                   // farine d'os simplifiée → laine blanche
Object.assign(SMELTING, { mutton: 'cooked_mutton', chicken: 'cooked_chicken', cactus: 'wool_green', netherrack: 'brick', ice: 'water' });
Object.assign(FUEL, { chest: 15, bow: 15, wool: 5 });
