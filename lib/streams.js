'use strict';
const { EventEmitter } = require('events');

// Only the selected event's own Kalshi chart may supply BTC values.
function parseEventChart(response, eventTicker) {
  const live = response.live_data;
  const d = live?.details;
  if (live?.type !== 'crypto' || d?.event_ticker !== eventTicker || d?.coin !== 'BTC')
    throw new Error('Gráfico incompatível com a aposta selecionada');
  const points = (d.timeseries || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0).sort((a,b) => a.t-b.t);
  const last = points.at(-1);
  if (!last) throw new Error('Gráfico da aposta sem preço disponível');
  if (live.is_historical || Date.now() - last.t > 30000 || last.t > Date.now() + 5000)
    throw new Error('Gráfico da aposta encerrado ou desatualizado');
  const candles = (d.candlesticks?.['1M'] || [])
    .filter(c => Number.isFinite(c.open_ts_ms) && Number.isFinite(c.close) && c.close > 0)
    .map(c => ({ ...c, ts: c.open_ts_ms })).sort((a,b) => a.ts-b.ts);
  return { price: last.v, updatedAt: last.t, candles,
    history: points.map(p => ({ ts: p.t, close: p.v })) };
}

class SpotStream extends EventEmitter {
  constructor(client, eventTicker) {
    super();
    this.client = client;
    this.eventTicker = eventTicker;
    this.price = 0;
    this.updatedAt = 0;
    this.candles = [];
    this.history = [];
    this.source = 'gráfico da aposta na Kalshi';
    this._closed = false;
    this.generation = 0;
  }
  setEventTicker(t) {
    this.eventTicker = t;
    this.generation++;
    this.clear('Carregando gráfico da aposta selecionada');
  }
  clear(message) {
    this.price = 0;
    this.updatedAt = 0;
    this.candles = [];
    this.history = [];
    this.lastError = message;
    this.emit('unavailable', message);
  }
  async refresh() {
    const ticker = this.eventTicker, generation = this.generation;
    try {
      const response = await this.client.publicGet('/live_data/events/' + encodeURIComponent(ticker));
      if (generation !== this.generation || this._closed) return;
      Object.assign(this, parseEventChart(response, ticker));
      this.lastError = null;
      this.source = 'gráfico da aposta na Kalshi · ' + ticker;
      this.emit('price', this.price);
    } catch (e) {
      if (generation === this.generation && !this._closed) this.clear(e.message);
    }
  }
  async start() {
    while (!this._closed) {
      await this.refresh();
      await new Promise(r => { this._timer = setTimeout(r, 1000); this._wake = r; });
    }
  }
  stop() { this._closed = true; clearTimeout(this._timer); this._wake?.(); }
}

class MarketPoller extends EventEmitter {
  constructor(client, eventTicker, intervalMs = 750) {
    super();
    this.client = client;
    this.eventTicker = eventTicker;
    this.intervalMs = intervalMs;
    this.markets = [];
    this.updatedAt = 0;
    this.lastLatencyMs = 0;
    this.errors = 0;
    this.lastError = null;
    this._stopped = false;
    this._fingerprint = '';
  }

  setEventTicker(t) {
    if (t === this.eventTicker) return;
    this.eventTicker = t;
    this._fingerprint = '';
    this.markets = [];
  }

  start() {
    this._loop();
  }

  stop() {
    this._stopped = true;
  }

  // Resumo curto do estado do book: se ele nao mudou, nao ha nada para reprocessar.
  _fp(markets) {
    let s = '';
    for (const m of markets) s += m.yes_bid_dollars + ',' + m.yes_ask_dollars + ',' + m.no_bid_dollars + ',' + m.no_ask_dollars + ',' + m.volume_fp + ';';
    return s;
  }

  async _loop() {
    while (!this._stopped) {
      const t0 = Date.now();
      try {
        const eventTicker = this.eventTicker;
        const markets = await this.client.getMarkets(eventTicker);
        if (eventTicker !== this.eventTicker || this._stopped) continue;
        this.lastLatencyMs = Date.now() - t0;
        this.updatedAt = Date.now();
        this.errors = 0;
        this.lastError = null;
        const fp = this._fp(markets);
        this.markets = markets;
        if (fp !== this._fingerprint) {
          this._fingerprint = fp;
          this.emit('markets', markets);
        }
      } catch (e) {
        this.errors++;
        this.lastError = e.message;
      }
      // Depois de erros seguidos, espera mais para nao insistir contra a Kalshi.
      const wait = this.errors ? Math.min(15000, this.intervalMs * 2 ** this.errors) : this.intervalMs;
      const gasto = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(50, wait - gasto)));
    }
  }
}

module.exports = { SpotStream, MarketPoller, parseEventChart };
