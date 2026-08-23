/**
 * Data provider interface.
 *
 * Every method returns `{ value, asOf, source }` or `{ error }`. A provider
 * that cannot answer says so; it never substitutes a plausible number.
 * That single convention is what makes §18 enforceable at the boundary.
 */
export class DataProvider {
  constructor(name) {
    this.name = name;
  }

  /* eslint-disable no-unused-vars */
  async quote(symbol) { return { error: 'not implemented' }; }
  async optionChain(symbol, opts) { return { error: 'not implemented' }; }
  async history(symbol, opts) { return { error: 'not implemented' }; }
  async events(symbol) { return { error: 'not implemented' }; }
  async accountState() { return { error: 'not implemented' }; }
  /* eslint-enable no-unused-vars */
}

/**
 * The provider used when nothing is configured. It refuses everything,
 * which is the correct behaviour: an unconfigured NUVO must not trade.
 */
export class NullProvider extends DataProvider {
  constructor() { super('null'); }
  async quote() { return { error: 'no provider configured' }; }
  async optionChain() { return { error: 'no provider configured' }; }
  async history() { return { error: 'no provider configured' }; }
  async events() { return { error: 'no provider configured' }; }
  async accountState() { return { error: 'no provider configured' }; }
}
