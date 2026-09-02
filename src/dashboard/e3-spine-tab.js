export const E3_SPINE_TAB_FLAG = 'NUVO_E3_SPINE_TAB';

const FIXTURE_PANE = Object.freeze({
  label: 'FIXTURE',
  synthetic: true,
  economicEpisodeId: 'EP-FIXTURE-E3-000001',
  putUnit: Object.freeze({
    resolvedUnitId: 'RU-FIXTURE-E3-000001',
    fills: 2,
    brokerEvents: 3,
    netCashUsd: -9656.95,
    optionRealizedPnlUsd: 348.05,
    shares: 200,
    shareLots: 2,
    unitStatus: 'RESOLVED_ASSIGNMENT_TO_INVENTORY',
    episodeStatus: 'OPEN_SHARES',
  }),
  coveredCallUnit: Object.freeze({
    resolvedUnitId: 'RU-FIXTURE-E3-CC-000002',
    coveredCalls: 2,
    callNetCashUsd: 158.70,
    cumulativeEpisodeCashUsd: -9498.25,
    callOptionRealizedPnlUsd: 158.70,
    cumulativeOptionRealizedPnlUsd: 506.75,
    shares: 200,
    newShareLots: 0,
    unitStatus: 'RESOLVED_EXPIRED',
    episodeStatus: 'OPEN_SHARES',
    thirdCallOutcome: 'FAULT:COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES',
  }),
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function equityMark(positions, symbol) {
  const position = positions.find((candidate) => candidate?.type === 'EQUITY'
    && String(candidate.symbol ?? '').toUpperCase() === symbol);
  if (!position) return null;
  const directMark = finite(position.mark);
  if (directMark !== null) return directMark;
  const marketValue = finite(position.marketValue);
  const quantity = finite(position.quantity);
  const multiplier = finite(position.multiplier) ?? 1;
  if (marketValue === null || quantity === null || quantity === 0 || multiplier <= 0) return null;
  return Number((Math.abs(marketValue) / (Math.abs(quantity) * multiplier)).toFixed(6));
}

/** Read-only E3 tab model. It never promotes custody marks into an economic unit. */
export function buildE3SpineTab({ cycleSnapshot = null, laneUnit = null,
  lanePreviewSource = null, positionProjection = null } = {}) {
  const account = cycleSnapshot?.account ?? {};
  const positions = Array.isArray(cycleSnapshot?.positions) ? cycleSnapshot.positions : [];
  const latest = laneUnit?.latestUnit ?? laneUnit ?? {};
  const realizedPnlCents = Number.isSafeInteger(latest.realizedPnlCents)
    ? latest.realizedPnlCents : null;
  const projectionStatus = positionProjection?.status ?? 'UNVERIFIED';
  const projectedSide = projectionStatus === 'AGREE'
    ? positionProjection.positionSide : projectionStatus === 'UNVERIFIED'
      ? positionProjection?.positionSide ?? 'UNKNOWN' : 'UNKNOWN';
  return {
    readOnly: true,
    paneA: FIXTURE_PANE,
    paneB: {
      label: 'LIVE MARKS · NOT A UNIT',
      notAUnit: true,
      observedAt: cycleSnapshot?.observedAt ?? null,
      values: {
        nav: {
          value: finite(account.nav),
          source: 'CYCLE_SNAPSHOT_ACCOUNT_NAV',
        },
        cashDerived: {
          value: finite(account.cash),
          source: 'CYCLE_SNAPSHOT_NAV_MINUS_POSITION_MARKS',
        },
        CBRS: {
          value: equityMark(positions, 'CBRS'),
          source: 'CYCLE_SNAPSHOT_EQUITY_MARK',
        },
        SPCX: {
          value: equityMark(positions, 'SPCX'),
          source: 'CYCLE_SNAPSHOT_EQUITY_MARK',
        },
      },
    },
    paneC: {
      label: laneUnit?.latestUnit?.label ?? laneUnit?.label ?? 'LANE_1_SPY',
      fixture: false,
      state: laneUnit?.stage ?? laneUnit?.state ?? 'DISARMED',
      symbol: laneUnit?.latestUnit?.symbol ?? laneUnit?.symbol ?? 'SPY',
      quantity: laneUnit?.latestUnit?.quantity ?? laneUnit?.quantity ?? 1,
      buyFillId: laneUnit?.latestUnit?.buyFillId ?? laneUnit?.buyFillId ?? null,
      sellFillId: laneUnit?.latestUnit?.sellFillId ?? laneUnit?.sellFillId ?? null,
      openingFillId: latest.openingFillId ?? null,
      closingFillId: latest.closingFillId ?? null,
      positionSide: projectedSide,
      positionProjection: positionProjection ?? { status: 'UNVERIFIED',
        brokerRead: { ok: false, error: 'BROKER_SNAPSHOT_UNAVAILABLE' } },
      protectiveStop: laneUnit?.stop ?? latest.stop ?? null,
      manifestHash: laneUnit?.latestUnit?.manifestHash ?? laneUnit?.manifestHash ?? null,
      realizedPnlUsd: realizedPnlCents === null
        ? (latest.realizedPnlUsd ?? null) : realizedPnlCents / 100,
      updatedAt: laneUnit?.latestUnit?.updatedAt ?? laneUnit?.updatedAt ?? null,
      armed: laneUnit?.armed === true,
      previewSource: lanePreviewSource?.replayEligible === true ? {
        ingressId: lanePreviewSource.ingressId,
        receivedAt: lanePreviewSource.receivedAt,
        ticker: lanePreviewSource.ticker,
        side: lanePreviewSource.side,
        qty: lanePreviewSource.qty,
        tvBodyBindingSha256: lanePreviewSource.tvBodyBindingSha256,
      } : null,
    },
  };
}
