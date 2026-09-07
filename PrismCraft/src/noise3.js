/* =====================================================================
   6a. BRUIT 3D (value noise trilinéaire + fbm) — grottes et filons
   ---------------------------------------------------------------------
   Le Perlin 2D existant (makePerlin) reste intact pour le relief ; ici on
   ajoute un bruit VOLUMIQUE déterministe (hash entier → gradient) utilisé
   pour creuser les grottes (« swiss cheese » comme Minecraft) et moduler
   les biomes.  Retourne des valeurs dans [0, 1].
   ===================================================================== */
function makeNoise3(seed) {
  const h3 = (x, y, z) => {
    let n = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fade = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  function noise(x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const u = fade(x - X), v = fade(y - Y), w = fade(z - Z);
    return lerp(
      lerp(lerp(h3(X, Y, Z), h3(X + 1, Y, Z), u), lerp(h3(X, Y + 1, Z), h3(X + 1, Y + 1, Z), u), v),
      lerp(lerp(h3(X, Y, Z + 1), h3(X + 1, Y, Z + 1), u), lerp(h3(X, Y + 1, Z + 1), h3(X + 1, Y + 1, Z + 1), u), v), w);
  }
  return function fbm3(x, y, z, octaves = 2, lac = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * noise(x * freq, y * freq, z * freq); norm += amp; amp *= gain; freq *= lac; }
    return sum / norm;
  };
}
const noise3 = makeNoise3(1337);
