'use strict';

// Fontes de dados ao vivo.
//
// Preco do Bitcoin: WebSocket publico da Binance (cada negocio chega em milissegundos).
//   Se cair, tenta a Coinbase e, em ultimo caso, volta a consultar por HTTP.
// Precos da Kalshi: a Kalshi so aceita WebSocket com conta cadastrada, entao aqui a leitura
//   e por consulta rapida e repetida, avisando apenas quando algum preco realmente muda.

const { EventEmitter } = require('events');

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';

class SpotStream extends EventEmitter {
  constructor(getSpotHttp) {
    super();
    this.price = 0;
    this.updatedAt = 0;
    this.source = '—';
    this.getSpotHttp = getSpotHttp;
    this._ws = null;
    this._closed = false;
    this._backoff = 1000;
    this._httpTimer = null;
  }

  start() {
    this._connectBinance();
    // Rede de seguranca: se nenhum negocio chegar por 20 segundos, busca por HTTP.
    this._httpTimer = setInterval(() => {
      if (Date.now() - this.updatedAt > 20000) this._httpFallback();
    }, 10000);
    this._httpFallback();
  }

  stop() {
    this._closed = true;
    clearInterval(this._httpTimer);
    try { this._ws && this._ws.close(); } catch (_) {}
  }

  _set(price, source) {
    if (!(price > 0)) return;
    const changed = price !== this.price;
    this.price = price;
    this.source = source;
    this.updatedAt = Date.now();
    if (changed) this.emit('price', price);
  }

  async _httpFallback() {
    try {
      const v = await this.getSpotHttp();
      this._set(v.price, v.source);
    } catch (_) {}
  }

  _connectBinance() {
    if (this._closed) return;
    let ws;
    try {
      ws = new WebSocket(BINANCE_WS);
    } catch (_) {
      return this._retry(() => this._connectBinance());
    }
    this._ws = ws;
    ws.onopen = () => { this._backoff = 1000; };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.p) this._set(parseFloat(m.p), 'binance ao vivo');
      } catch (_) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (!this._closed) this._retry(() => this._connectCoinbase()); };
  }

  _connectCoinbase() {
    if (this._closed) return;
    let ws;
    try {
      ws = new WebSocket(COINBASE_WS);
    } catch (_) {
      return this._retry(() => this._connectBinance());
    }
    this._ws = ws;
    ws.onopen = () => {
      this._backoff = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'ticker' && m.price) this._set(parseFloat(m.price), 'coinbase ao vivo');
      } catch (_) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (!this._closed) this._retry(() => this._connectBinance()); };
  }

  _retry(fn) {
    const wait = this._backoff;
    this._backoff = Math.min(30000, this._backoff * 2);
    setTimeout(fn, wait);
  }
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
        const markets = await this.client.getMarkets(this.eventTicker);
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

module.exports = { SpotStream, MarketPoller };
