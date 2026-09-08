'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpotStream, parseEventChart } = require('../lib/streams');
const payload = (ticker = 'A', t = Date.now()) => ({ live_data: { type: 'crypto', details: {
  coin: 'BTC', event_ticker: ticker, timeseries: [{ t, v: 79000 }], candlesticks: { '1M': [] }
} } });
test('uses selected event chart and rejects wrong event, stale and historical data', () => {
  assert.equal(parseEventChart(payload(), 'A').price, 79000);
  assert.throws(() => parseEventChart(payload('B'), 'A'));
  assert.throws(() => parseEventChart(payload('A', Date.now() - 31000), 'A'));
  const old = payload(); old.live_data.is_historical = true;
  assert.throws(() => parseEventChart(old, 'A'));
});
test('discards in-flight prices after switching events and clears failures', async () => {
  let resolve;
  const stream = new SpotStream({ publicGet: () => new Promise(r => { resolve = r; }) }, 'A');
  const pending = stream.refresh();
  stream.setEventTicker('B');
  resolve(payload()); await pending;
  assert.equal(stream.price, 0);
  stream.client.publicGet = async () => payload('B');
  await stream.refresh(); assert.equal(stream.price, 79000);
  stream.client.publicGet = async () => { throw new Error('offline'); };
  await stream.refresh(); assert.equal(stream.price, 0); assert.deepEqual(stream.history, []);
});
