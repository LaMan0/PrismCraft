/* =====================================================================
   RECETTES SUPPLÉMENTAIRES (coffre, arc, TNT, laine, cuisson)
   ===================================================================== */
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
