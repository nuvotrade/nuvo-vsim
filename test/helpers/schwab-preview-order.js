// Response shape read in Schwab's authenticated OAS3 PreviewOrder / OrderStrategy
// / OrderLeg models on 2026-08-31. Synthetic values, never a broker receipt.
// Deliberately independent of the outgoing order builder.
export function documentedPreviewOrder(instruction = 'BUY') {
  return { orderType: 'MARKET', orderStrategyType: 'SINGLE', session: 'NORMAL',
    duration: 'DAY', orderLegs: [{ instruction, quantity: 1,
      finalSymbol: 'SPY', assetType: 'EQUITY' }] };
}
