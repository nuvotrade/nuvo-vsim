/**
 * NUVO VSIM — an autonomous capital-allocation and options-underwriting system.
 *
 * MANDATE
 *   Compound capital by selling mispriced risk only when compensation
 *   exceeds modelled risk after costs.
 *
 * HIERARCHY
 *   TRUTH > SURVIVAL > EXPECTANCY > CAPITAL EFFICIENCY > INCOME
 *
 * The identity is permanent. CSPs, spreads, shares, covered calls and cash
 * are implementation vehicles, not the business. Strategies live, compete
 * for capital, and die; the system does not change shape when one of them
 * stops working.
 */
export * from './constitution/index.js';
export * from './math/index.js';
export * from './market/index.js';
export * from './universe/index.js';
export * from './structures/index.js';
export * from './underwriter/index.js';
export * from './portfolio/index.js';
export * from './lifecycle/index.js';
export * from './execution/index.js';
export * from './research/index.js';
export * from './registry/index.js';
export * from './evidence/index.js';
export * from './scoreboard/index.js';
export * from './pipeline/index.js';
export * from './truth/contract.js';
export * from './truth/reconciliation.js';
export * from './truth/providers/provider.js';
export * from './truth/providers/synthetic.js';

export const VERSION = '5.0.0';
export const MANDATE =
  'Compound capital by selling mispriced risk only when compensation exceeds modelled risk after costs.';
