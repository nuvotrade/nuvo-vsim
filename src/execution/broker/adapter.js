/**
 * Broker adapter interface.
 *
 * Every method must be able to say "I do not know". Returning a plausible
 * value on failure is the single most dangerous thing an adapter can do,
 * because it defeats the Truth Engine at the one boundary it cannot see past.
 */
export class BrokerAdapter {
  constructor(name) { this.name = name; }
  /* eslint-disable no-unused-vars */
  async accountState() { return { error: 'not implemented' }; }
  async positions() { return { error: 'not implemented' }; }
  async openOrders() { return { error: 'not implemented' }; }
  async submit(order) { return { error: 'not implemented' }; }
  async cancel(brokerOrderId) { return { error: 'not implemented' }; }
  /* eslint-enable no-unused-vars */
}
