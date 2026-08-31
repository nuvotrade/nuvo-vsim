import { readFileSync } from 'node:fs';

// Exact inspection projection of captured ORIGINAL 73646c14...; the canonical
// inspection hash is ee10f968... . No request-builder or OpenAPI-derived shape.
export const livePreviewInspection = JSON.parse(readFileSync(new URL(
  '../fixtures/schwab-preview-20260831.inspection.json', import.meta.url), 'utf8'));

export function livePreviewBody() {
  return structuredClone(livePreviewInspection.body);
}

// Non-BUY instructions are explicit synthetic mutations for safety tests;
// only the unchanged BUY response has production provenance.
export function liveDerivedPreviewOrder(instruction = 'BUY') {
  const order = livePreviewBody().orderStrategy;
  order.orderLegs[0].instruction = instruction;
  return order;
}
