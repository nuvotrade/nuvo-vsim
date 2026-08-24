/**
 * Correlation clustering (§14).
 *
 * "Ten bullish short-put positions in technology are not ten independent
 * trades. They may effectively be one enormous short-volatility technology
 * trade."
 *
 * Clusters are built from realised correlation first and sector second.
 * Sector alone is too coarse — correlation is what actually determines
 * whether two positions lose together.
 */
import { correlation, isNum, mean } from '../math/stats.js';

/**
 * Single-linkage clustering over the correlation matrix.
 *
 * Single linkage is chosen deliberately: it is the PESSIMISTIC choice.
 * Two names join a cluster if ANY pair is correlated above threshold, so
 * NUVO errs toward declaring concentration rather than away from it.
 */
export function buildClusters(returnsBySymbol, { threshold = 0.65, sectors = {} } = {}) {
  const symbols = Object.keys(returnsBySymbol);
  const parent = Object.fromEntries(symbols.map((s) => [s, s]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const pairs = [];
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = symbols[i];
      const b = symbols[j];
      const n = Math.min(returnsBySymbol[a].length, returnsBySymbol[b].length, 120);
      const rho = correlation(returnsBySymbol[a].slice(-n), returnsBySymbol[b].slice(-n));
      if (isNum(rho)) pairs.push({ a, b, rho });
      // Same sector counts as correlated even if the sample says otherwise:
      // a short history can hide a relationship that a shock will reveal.
      const sameSector = sectors[a] && sectors[a] === sectors[b] && sectors[a] !== 'UNKNOWN';
      if ((isNum(rho) && Math.abs(rho) >= threshold) || sameSector) union(a, b);
    }
  }

  const groups = new Map();
  for (const s of symbols) {
    const root = find(s);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  }

  return {
    clusters: [...groups.values()].map((members, i) => ({
      id: `C${i + 1}`,
      members,
      sector: members.map((m) => sectors[m]).find(Boolean) ?? 'MIXED',
    })),
    pairs,
    averageCorrelation: pairs.length ? mean(pairs.map((p) => Math.abs(p.rho))) : NaN,
    threshold,
  };
}

/** Which cluster a symbol belongs to. */
export function clusterOf(clustering, symbol) {
  return clustering.clusters.find((c) => c.members.includes(symbol)) ?? null;
}
