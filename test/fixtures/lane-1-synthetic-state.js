// Deliberately synthetic broker/coordinator state. Not TradingView messages,
// not captured Schwab responses, and not evidence of live short capability.
export function syntheticPositionPacket(side = 'FLAT') {
  return { securitiesAccount: { positions: side === 'FLAT' ? [] : [{
    instrument: { symbol: 'SPY', assetType: 'COLLECTIVE_INVESTMENT' },
    longQuantity: side === 'LONG' ? 1 : 0,
    shortQuantity: side === 'SHORT' ? 1 : 0,
  }] } };
}

export function syntheticSnapshot(side = 'FLAT', at = Date.now()) {
  const longQuantity = side === 'LONG' ? 1 : 0;
  const shortQuantity = side === 'SHORT' ? 1 : 0;
  return { symbol: 'SPY', positionSide: side, longQuantity, shortQuantity,
    netQuantity: longQuantity - shortQuantity, accountHash: 'ACCOUNT-HASH',
    orderStateSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    orderCheckBound: 'NO_WORKING_SPY_ORDER_IN_60_DAY_QUERY',
    readStartedAt: new Date(at).toISOString(), acquiredAt: new Date(at).toISOString(),
    ordersFrom: new Date(at - 60 * 86_400_000).toISOString(), ordersTo: new Date(at + 60_000).toISOString() };
}

export function syntheticClaim(instruction = 'BUY', clientOrderId = 'CLIENT-1', at = Date.now()) {
  const side = instruction === 'SELL' ? 'LONG' : instruction === 'BUY_TO_COVER' ? 'SHORT' : 'FLAT';
  const signal = instruction === 'BUY' ? 'LONG' : instruction === 'SELL_SHORT' ? 'SHORT' : 'EXIT';
  return { armed: true, positionSide: side, stage: `${signal}_SENDING`,
    expiresAt: new Date(at + 60_000).toISOString(),
    [signal === 'EXIT' ? 'exit' : 'open']: { seal: { clientOrderId, brokerInstruction: instruction } } };
}

export function syntheticOrder(status = 'WORKING', symbol = 'SPY', orderId = 'ORDER-1') {
  return { orderId, status, orderStrategyType: 'SINGLE',
    orderLegCollection: [{ instruction: 'BUY', quantity: 1, instrument: { symbol, assetType: 'EQUITY' } }] };
}
