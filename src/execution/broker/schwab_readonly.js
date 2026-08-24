import { BrokerAdapter } from './adapter.js';

/**
 * Fail-closed Schwab custody adapter. The injected client owns OAuth and
 * normalization; this broker port can observe but has no mutation path.
 */
export class SchwabReadOnlyBroker extends BrokerAdapter {
  constructor({ client, ownerId, now = () => Date.now() } = {}) {
    super('schwab-read-only');
    if (!client) throw new Error('SchwabReadOnlyBroker requires a client.');
    if (!ownerId) throw new Error('SchwabReadOnlyBroker requires ownerId.');
    this.client = client;
    this.ownerId = ownerId;
    this.now = now;
    this.snapshotPromise = null;
  }

  async _snapshot() {
    if (!this.snapshotPromise) this.snapshotPromise = this.client.snapshot(this.ownerId);
    return this.snapshotPromise;
  }

  clearSnapshot() { this.snapshotPromise = null; }

  async accountState() {
    try {
      const snapshot = await this._snapshot();
      return {
        value: {
          cash: snapshot.cash,
          buyingPower: snapshot.buyingPower,
          nav: snapshot.nav,
        },
        asOf: snapshot.asOf,
        source: 'SCHWAB_READ_ONLY',
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async positions() {
    try {
      const snapshot = await this._snapshot();
      return { value: snapshot.positions, asOf: snapshot.asOf, source: 'SCHWAB_READ_ONLY' };
    } catch (error) {
      return { error: error.message };
    }
  }

  async openOrders() {
    try {
      const snapshot = await this._snapshot();
      return { value: snapshot.openOrders, asOf: snapshot.asOf, source: 'SCHWAB_READ_ONLY' };
    } catch (error) {
      return { error: error.message };
    }
  }

  async submit() { return { error: 'SCHWAB_MUTATION_DISABLED_SHADOW_ONLY' }; }
  async cancel() { return { error: 'SCHWAB_MUTATION_DISABLED_SHADOW_ONLY' }; }
}
