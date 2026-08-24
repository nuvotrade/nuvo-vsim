const AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const TRADER_URL = 'https://api.schwabapi.com/trader/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function iso(value, fallback = null) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomState() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenKey(raw, usages) {
  const bytes = fromBase64(raw);
  if (bytes.byteLength !== 32) throw new Error('BROKER_TOKEN_KEY_MUST_BE_32_BYTES_BASE64');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

async function encrypt(value, rawKey, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(context),
  }, await tokenKey(rawKey, ['encrypt']), encoder.encode(String(value)));
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

async function decrypt(ciphertext, iv, rawKey, context) {
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(context),
  }, await tokenKey(rawKey, ['decrypt']), fromBase64(ciphertext));
  return decoder.decode(plaintext);
}

function parseOcc(symbol) {
  const compact = String(symbol ?? '').toUpperCase().replaceAll(' ', '');
  const match = /^([A-Z0-9.]{1,6})(\d{6})([CP])(\d{8})$/u.exec(compact);
  if (!match) return null;
  const [, underlying, date, right, rawStrike] = match;
  return {
    underlying,
    right: right === 'P' ? 'put' : 'call',
    expiration: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    strike: Number(rawStrike) / 1000,
  };
}

export function normalizePosition(position) {
  const symbol = String(position.instrument?.symbol ?? '').toUpperCase();
  const assetType = String(position.instrument?.assetType ?? 'UNKNOWN').toUpperCase();
  const option = parseOcc(symbol);
  const longQuantity = finite(position.longQuantity);
  const shortQuantity = finite(position.shortQuantity);
  return {
    symbol: symbol.replaceAll(' ', ''),
    underlying: option?.underlying ?? symbol,
    type: option ? 'OPTION' : assetType === 'EQUITY' ? 'EQUITY' : assetType,
    right: option?.right ?? null,
    strike: option?.strike ?? null,
    expiration: option?.expiration ?? null,
    quantity: longQuantity != null && shortQuantity != null
      ? longQuantity - shortQuantity : null,
    multiplier: option ? 100 : 1,
    averagePrice: finite(position.averagePrice),
    marketValue: finite(position.marketValue),
  };
}

/** Aggregate the same instrument across linked Schwab accounts. */
export function aggregatePositions(positions) {
  const grouped = new Map();
  for (const position of positions ?? []) {
    const key = [position.symbol, position.underlying, position.type, position.right,
      position.strike, position.expiration].join('|');
    const prior = grouped.get(key);
    if (!prior) {
      grouped.set(key, {
        ...position,
        _allMarketValuesKnown: Number.isFinite(position.marketValue),
        _weightedPrice: Number.isFinite(position.averagePrice)
          ? Math.abs(position.quantity) * position.averagePrice : null,
        _weight: Number.isFinite(position.averagePrice) ? Math.abs(position.quantity) : 0,
        _direction: Math.sign(position.quantity),
      });
      continue;
    }
    prior.quantity += position.quantity;
    prior._allMarketValuesKnown = prior._allMarketValuesKnown && Number.isFinite(position.marketValue);
    prior.marketValue = prior._allMarketValuesKnown ? prior.marketValue + position.marketValue : null;
    if (prior._direction !== Math.sign(position.quantity)) prior._direction = 0;
    if (prior._direction && Number.isFinite(position.averagePrice)) {
      prior._weightedPrice = (prior._weightedPrice ?? 0) + Math.abs(position.quantity) * position.averagePrice;
      prior._weight += Math.abs(position.quantity);
    } else if (!prior._direction) {
      prior._weightedPrice = null;
      prior._weight = 0;
    }
  }
  return [...grouped.values()].filter((position) => position.quantity !== 0).map((position) => {
    const { _allMarketValuesKnown, _weightedPrice, _weight, _direction, ...clean } = position;
    clean.averagePrice = _weightedPrice != null && _weight > 0 ? _weightedPrice / _weight : null;
    return clean;
  });
}

function flattenOrders(order, accountRef, observedAt, rows = []) {
  const providerOrderId = String(order?.orderId ?? '').trim();
  if (providerOrderId) {
    const leg = order?.orderLegCollection?.[0] ?? {};
    rows.push({
      brokerOrderId: providerOrderId,
      clientOrderId: providerOrderId,
      accountRef,
      symbol: String(leg.instrument?.symbol ?? '').replaceAll(' ', '').toUpperCase(),
      state: String(order.status ?? 'UNKNOWN').toUpperCase(),
      quantity: finite(order.quantity ?? leg.quantity, 0),
      updatedAt: iso(order.closeTime ?? order.cancelTime ?? order.enteredTime, observedAt),
    });
  }
  for (const child of order?.childOrderStrategies ?? []) flattenOrders(child, accountRef, observedAt, rows);
  return rows;
}

function isOpenOrder(order) {
  return ['AWAITING_PARENT_ORDER', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION', 'AWAITING_MANUAL_REVIEW',
    'ACCEPTED', 'AWAITING_UR_OUT', 'PENDING_ACTIVATION', 'QUEUED', 'WORKING', 'PENDING_CANCEL',
    'PENDING_REPLACE'].includes(order.state);
}

export class SchwabD1Client {
  constructor(env) { this.env = env; }

  configured() {
    return this.env.NUVO_BROKER_MODE === 'READ_ONLY'
      && this.env.NUVO_BROKER_EXECUTION_MODE === 'SHADOW_ONLY'
      && this.env.SCHWAB_CLIENT_ID && this.env.SCHWAB_CLIENT_SECRET
      && this.env.SCHWAB_CALLBACK_URL && this.env.BROKER_TOKEN_ENCRYPTION_KEY;
  }

  async beginOAuth(ownerId) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const state = randomState();
    const stateHash = await digest(state);
    const now = new Date().toISOString();
    await this.env.DB.prepare(`INSERT INTO broker_oauth_states
      (state_hash,owner_id,redirect_uri,expires_at,consumed_at,created_at)
      VALUES (?,?,?,?,NULL,?)`).bind(
      stateHash, ownerId, this.env.SCHWAB_CALLBACK_URL,
      new Date(Date.now() + 600_000).toISOString(), now,
    ).run();
    const destination = new URL(AUTH_URL);
    destination.searchParams.set('client_id', this.env.SCHWAB_CLIENT_ID);
    destination.searchParams.set('redirect_uri', this.env.SCHWAB_CALLBACK_URL);
    destination.searchParams.set('response_type', 'code');
    destination.searchParams.set('state', state);
    return destination.toString();
  }

  async completeOAuth(ownerId, state, code) {
    if (!state || !code) throw new Error('SCHWAB_OAUTH_RESPONSE_INCOMPLETE');
    const stateHash = await digest(state);
    const row = await this.env.DB.prepare(`SELECT redirect_uri,expires_at,consumed_at
      FROM broker_oauth_states WHERE state_hash=? AND owner_id=?`).bind(stateHash, ownerId).first();
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
      throw new Error('SCHWAB_OAUTH_STATE_INVALID');
    }
    const consumed = await this.env.DB.prepare(`UPDATE broker_oauth_states SET consumed_at=?
      WHERE state_hash=? AND owner_id=? AND consumed_at IS NULL`).bind(
      new Date().toISOString(), stateHash, ownerId,
    ).run();
    if (Number(consumed.meta?.changes ?? 0) !== 1) throw new Error('SCHWAB_OAUTH_STATE_INVALID');
    const packet = await this._tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri,
    });
    await this._saveTokens(ownerId, packet);
    await this.env.DB.prepare(`INSERT INTO broker_connections
      (owner_id,status,last_successful_sync_at,last_error_code,updated_at)
      VALUES (?,'CONNECTED',NULL,NULL,?) ON CONFLICT(owner_id) DO UPDATE SET
      status='CONNECTED',last_error_code=NULL,updated_at=excluded.updated_at`).bind(
      ownerId, new Date().toISOString(),
    ).run();
  }

  async _tokenRequest(fields) {
    const credentials = btoa(`${this.env.SCHWAB_CLIENT_ID}:${this.env.SCHWAB_CLIENT_SECRET}`);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(15_000),
    });
    const packet = await response.json().catch(() => ({}));
    if (!response.ok || typeof packet.access_token !== 'string') {
      throw new Error(`SCHWAB_TOKEN_${fields.grant_type === 'refresh_token' ? 'REFRESH' : 'EXCHANGE'}_${response.status}`);
    }
    return packet;
  }

  async _saveTokens(ownerId, packet, priorRefresh = null, priorRefreshExpiry = null) {
    const refresh = typeof packet.refresh_token === 'string' ? packet.refresh_token : priorRefresh;
    if (!refresh) throw new Error('SCHWAB_REFRESH_TOKEN_MISSING');
    const [accessBox, refreshBox] = await Promise.all([
      encrypt(packet.access_token, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:access:v1`),
      encrypt(refresh, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:refresh:v1`),
    ]);
    const accessSeconds = Math.min(Math.max(60, Number(packet.expires_in ?? 1800)), 720);
    const refreshExpiry = Number.isFinite(Number(packet.refresh_token_expires_in))
      ? new Date(Date.now() + Number(packet.refresh_token_expires_in) * 1000).toISOString()
      : priorRefreshExpiry ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.env.DB.prepare(`INSERT INTO broker_token_vault
      (owner_id,encrypted_access_token,access_iv,encrypted_refresh_token,refresh_iv,
       access_expires_at,refresh_expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
      encrypted_access_token=excluded.encrypted_access_token,access_iv=excluded.access_iv,
      encrypted_refresh_token=excluded.encrypted_refresh_token,refresh_iv=excluded.refresh_iv,
      access_expires_at=excluded.access_expires_at,refresh_expires_at=excluded.refresh_expires_at,
      updated_at=excluded.updated_at`).bind(
      ownerId, accessBox.ciphertext, accessBox.iv, refreshBox.ciphertext, refreshBox.iv,
      new Date(Date.now() + accessSeconds * 1000).toISOString(), refreshExpiry, new Date().toISOString(),
    ).run();
  }

  async _tokenRow(ownerId) {
    return this.env.DB.prepare('SELECT * FROM broker_token_vault WHERE owner_id=?').bind(ownerId).first();
  }

  async _acquireRefreshLease(ownerId, leaseId) {
    const acquiredAt = new Date().toISOString();
    const result = await this.env.DB.prepare(`INSERT INTO broker_token_refresh_leases
      (owner_id,lease_id,acquired_at,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET
      lease_id=excluded.lease_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at
      WHERE broker_token_refresh_leases.expires_at<=excluded.acquired_at`).bind(
      ownerId, leaseId, acquiredAt, new Date(Date.now() + 20_000).toISOString(),
    ).run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  async _releaseRefreshLease(ownerId, leaseId) {
    await this.env.DB.prepare(`DELETE FROM broker_token_refresh_leases
      WHERE owner_id=? AND lease_id=?`).bind(ownerId, leaseId).run();
  }

  async _freshAccessToken(ownerId, minimumLifetimeMs = 120_000) {
    const row = await this._tokenRow(ownerId);
    if (!row) throw new Error('SCHWAB_NOT_CONNECTED');
    if (Date.parse(row.refresh_expires_at) <= Date.now()) throw new Error('SCHWAB_AUTHORIZATION_RENEWAL_REQUIRED');
    if (Date.parse(row.access_expires_at) <= Date.now() + minimumLifetimeMs) return null;
    return decrypt(row.encrypted_access_token, row.access_iv, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:access:v1`);
  }

  async _accessToken(ownerId) {
    const current = await this._freshAccessToken(ownerId);
    if (current) return current;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const leaseId = crypto.randomUUID();
      if (await this._acquireRefreshLease(ownerId, leaseId)) {
        try {
          const refreshedByPeer = await this._freshAccessToken(ownerId);
          if (refreshedByPeer) return refreshedByPeer;
          const row = await this._tokenRow(ownerId);
          const refresh = await decrypt(row.encrypted_refresh_token, row.refresh_iv,
            this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:refresh:v1`);
          const packet = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
          await this._saveTokens(ownerId, packet, refresh, row.refresh_expires_at);
          return packet.access_token;
        } finally {
          await this._releaseRefreshLease(ownerId, leaseId);
        }
      }

      for (let poll = 0; poll < 20; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const refreshedByPeer = await this._freshAccessToken(ownerId);
        if (refreshedByPeer) return refreshedByPeer;
      }
    }
    throw new Error('SCHWAB_TOKEN_REFRESH_BUSY');
  }

  async _read(path, token) {
    const response = await fetch(`${TRADER_URL}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_READ_${response.status}:${path.split('?')[0]}`);
    return response.json();
  }

  async snapshot(ownerId) {
    try { return await this._snapshot(ownerId); }
    catch (error) {
      const at = new Date().toISOString();
      await this.env.DB.prepare(`UPDATE broker_connections SET status='DEGRADED',
        last_error_code=?,updated_at=? WHERE owner_id=?`).bind(
        String(error.message ?? 'SCHWAB_READ_FAILED').slice(0, 240), at, ownerId,
      ).run().catch(() => {});
      throw error;
    }
  }

  async _snapshot(ownerId) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const token = await this._accessToken(ownerId);
    const [directory, accountPackets] = await Promise.all([
      this._read('/accounts/accountNumbers', token),
      this._read('/accounts?fields=positions', token),
    ]);
    const observedAt = new Date().toISOString();
    const accounts = directory.map((number) => {
      const packet = accountPackets.find((candidate) => String(candidate?.securitiesAccount?.accountNumber ?? '') === String(number.accountNumber));
      if (!packet) throw new Error('SCHWAB_ACCOUNT_SNAPSHOT_MISSING');
      const account = packet.securitiesAccount;
      const normalizedPositions = (account.positions ?? []).map(normalizePosition);
      if (normalizedPositions.some((position) => !position.symbol || !Number.isFinite(position.quantity))) {
        throw new Error('SCHWAB_POSITION_QUANTITY_INCOMPLETE');
      }
      const positions = normalizedPositions.filter((position) => position.quantity !== 0);
      const balances = account.currentBalances ?? {};
      const positionMarketValue = positions.every((position) => Number.isFinite(position.marketValue))
        ? positions.reduce((sum, position) => sum + position.marketValue, 0) : null;
      const nav = finite(balances.liquidationValue ?? balances.equity);
      const reportedCash = finite(balances.cashBalance ?? balances.moneyMarketFund ?? balances.availableFunds);
      // In a margin account Schwab may report cashBalance=0 while the marked
      // positions exceed liquidation value. Net liquidation less marked
      // positions is the actual cash/debit that must reconcile economically.
      const cash = nav != null && positionMarketValue != null
        ? nav - positionMarketValue : reportedCash;
      return {
        accountRef: String(number.hashValue),
        accountMask: String(number.accountNumber ?? '').slice(-4).padStart(4, '•'),
        cash, reportedCashBalance: reportedCash,
        buyingPower: finite(balances.buyingPower ?? balances.buyingPowerNonMarginableTrade),
        nav, positions,
      };
    });
    if (accounts.some((account) => ![account.cash, account.buyingPower, account.nav].every(Number.isFinite))) {
      throw new Error('SCHWAB_ACCOUNT_BALANCES_INCOMPLETE');
    }
    const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const orderRows = await Promise.all(accounts.map(async (account) => {
      const orders = await this._read(`/accounts/${encodeURIComponent(account.accountRef)}/orders?fromEnteredTime=${encodeURIComponent(from)}&toEnteredTime=${encodeURIComponent(to)}&maxResults=3000`, token);
      return orders.flatMap((order) => flattenOrders(order, account.accountRef, observedAt));
    }));
    const snapshot = {
      asOf: Date.parse(observedAt),
      cash: accounts.reduce((sum, account) => sum + account.cash, 0),
      buyingPower: accounts.reduce((sum, account) => sum + account.buyingPower, 0),
      nav: accounts.reduce((sum, account) => sum + account.nav, 0),
      positions: aggregatePositions(accounts.flatMap((account) => account.positions)),
      openOrders: orderRows.flat().filter(isOpenOrder),
      accounts: accounts.map(({ accountRef, accountMask, cash, reportedCashBalance, buyingPower, nav }) => ({
        accountRef, accountMask, cash, reportedCashBalance, buyingPower, nav,
      })),
    };
    const account = {
      cash: snapshot.cash,
      buyingPower: snapshot.buyingPower,
      nav: snapshot.nav,
      accounts: snapshot.accounts.map(({ accountMask, cash, reportedCashBalance, buyingPower, nav }) => ({
        accountMask, cash, reportedCashBalance, buyingPower, nav,
      })),
    };
    const snapshotHash = await digest(JSON.stringify({
      account, positions: snapshot.positions, openOrders: snapshot.openOrders,
    }));
    await this.env.DB.prepare(`INSERT INTO custody_latest
      (owner_id,snapshot_hash,account_json,positions_json,orders_json,observed_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
      snapshot_hash=excluded.snapshot_hash,account_json=excluded.account_json,
      positions_json=excluded.positions_json,orders_json=excluded.orders_json,
      observed_at=excluded.observed_at,updated_at=excluded.updated_at`).bind(
      ownerId, snapshotHash, JSON.stringify(account), JSON.stringify(snapshot.positions),
      JSON.stringify(snapshot.openOrders), observedAt, observedAt,
    ).run();
    await this.env.DB.prepare(`UPDATE broker_connections SET status='CONNECTED',
      last_successful_sync_at=?,last_error_code=NULL,updated_at=? WHERE owner_id=?`).bind(
      observedAt, observedAt, ownerId,
    ).run();
    return { ...snapshot, snapshotHash };
  }

  async status(ownerId) {
    const row = await this.env.DB.prepare(`SELECT status,last_successful_sync_at,last_error_code,updated_at
      FROM broker_connections WHERE owner_id=?`).bind(ownerId).first();
    return row ?? { status: 'DISCONNECTED', last_successful_sync_at: null, last_error_code: null };
  }
}
