/**
 * Deterministic pseudo-randomness.
 *
 * Every simulation NUVO runs must be reproducible from its evidence package
 * (Constitution §19). `Math.random()` is therefore banned inside the engine:
 * a Monte Carlo run that cannot be replayed is not evidence, it is an anecdote.
 */

/** SplitMix64-derived 32-bit seeder — turns any string/number into 4 seed words. */
function seedWords(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
  return [next(), next(), next(), next()];
}

/**
 * xoshiro128** — fast, well-distributed, and fully replayable from `seed`.
 */
export class Rng {
  constructor(seed = 'nuvo') {
    this.seed = String(seed);
    const [a, b, c, d] = seedWords(seed);
    // Guard against the all-zero state, which xoshiro cannot escape.
    this._s = [a || 1, b || 2, c || 3, d || 4];
  }

  /** Uniform on [0, 1). */
  next() {
    const s = this._s;
    const r = Math.imul(s[1] * 5, 1) >>> 0;
    const result = ((((r << 7) | (r >>> 25)) >>> 0) * 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;
    return result / 4294967296;
  }

  /** Uniform on [lo, hi). */
  uniform(lo = 0, hi = 1) {
    return lo + (hi - lo) * this.next();
  }

  /** Standard normal via Box–Muller (cached pair). */
  normal(mu = 0, sigma = 1) {
    if (this._spare !== undefined) {
      const z = this._spare;
      this._spare = undefined;
      return mu + sigma * z;
    }
    let u = 0;
    let v = 0;
    // next() can return exactly 0; log(0) is -Infinity.
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this._spare = mag * Math.sin(2 * Math.PI * v);
    return mu + sigma * mag * Math.cos(2 * Math.PI * v);
  }

  /** Student-t draw with `nu` degrees of freedom, standardised to unit variance. */
  studentT(nu = 5) {
    if (nu <= 2) throw new RangeError('studentT requires nu > 2 for finite variance');
    // t = Z / sqrt(W/nu), with W ~ chi-square(nu) built from normals.
    let w = 0;
    for (let i = 0; i < Math.round(nu); i += 1) {
      const z = this.normal();
      w += z * z;
    }
    const t = this.normal() / Math.sqrt(w / Math.round(nu));
    return t / Math.sqrt(nu / (nu - 2));
  }

  /** Integer on [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** Uniform choice from an array. */
  pick(arr) {
    if (!arr.length) throw new RangeError('pick from empty array');
    return arr[this.int(arr.length)];
  }

  /** In-place Fisher–Yates on a copy. */
  shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** A child generator, deterministically derived — lets sub-simulations branch safely. */
  fork(tag) {
    return new Rng(`${this.seed}:${tag}`);
  }
}

export const rngFor = (seed) => new Rng(seed);
