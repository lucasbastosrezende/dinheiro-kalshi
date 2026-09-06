'use strict';

// Cliente HTTP para a API publica e privada da Kalshi (Trade API v2).
// Endpoints de leitura de mercado nao exigem autenticacao.
// Endpoints de portfolio/ordens exigem assinatura RSA-PSS com a chave privada da conta.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOSTS = {
  prod: 'api.elections.kalshi.com',
  demo: 'demo-api.kalshi.co',
};

const BASE_PATH = '/trade-api/v2';

// As credenciais ficam fora do config.json, num arquivo que nao vai para o controle de
// versao. A ordem de busca e: variaveis de ambiente, credentials.json, config.json.
function credenciais(config) {
  const doConfig = (config && config.credentials) || {};
  let doArquivo = {};
  const caminho = path.join(__dirname, '..', 'credentials.json');
  try {
    if (fs.existsSync(caminho)) doArquivo = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch (_) {
    /* arquivo quebrado e tratado como ausente */
  }
  const chave = process.env.KALSHI_API_KEY_ID || doArquivo.apiKeyId || doConfig.apiKeyId || '';
  const pem = process.env.KALSHI_PRIVATE_KEY_PATH || doArquivo.privateKeyPath || doConfig.privateKeyPath || 'kalshi-private-key.pem';
  return {
    apiKeyId: chave,
    privateKeyPath: path.isAbsolute(pem) ? pem : path.join(__dirname, '..', pem),
    environment: process.env.KALSHI_ENV || doArquivo.environment || doConfig.environment || 'prod',
  };
}

function request(host, method, path, { body = null, headers = {}, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host,
        method,
        path,
        headers: Object.assign(
          {
            'User-Agent': 'kalshi-btc-dashboard/1.0',
            Accept: 'application/json',
          },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          headers
        ),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (_) {
            parsed = { raw };
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Kalshi ${method} ${path} -> HTTP ${res.statusCode}: ${raw.slice(0, 400)}`);
            err.statusCode = res.statusCode;
            err.payload = parsed;
            return reject(err);
          }
          resolve(parsed);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout em ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class KalshiClient {
  constructor(config) {
    const cred = credenciais(config);
    this.env = cred.environment || 'prod';
    this.host = HOSTS[this.env] || HOSTS.prod;
    this.apiKeyId = cred.apiKeyId || '';
    this.privateKeyPath = cred.privateKeyPath || '';
    this._privateKey = null;
  }

  hasCredentials() {
    if (!this.apiKeyId) return false;
    try {
      return !!this._loadKey();
    } catch (_) {
      return false;
    }
  }

  _loadKey() {
    if (this._privateKey) return this._privateKey;
    if (!this.privateKeyPath || !fs.existsSync(this.privateKeyPath)) return null;
    const pem = fs.readFileSync(this.privateKeyPath, 'utf8');
    this._privateKey = crypto.createPrivateKey(pem);
    return this._privateKey;
  }

  // Assinatura exigida pela Kalshi: RSA-PSS(SHA256) sobre `timestampMs + METHOD + path`.
  _authHeaders(method, path) {
    const key = this._loadKey();
    if (!key || !this.apiKeyId) throw new Error('credenciais Kalshi ausentes (apiKeyId ou chave privada)');
    const ts = Date.now().toString();
    const message = ts + method.toUpperCase() + path;
    const signature = crypto.sign('sha256', Buffer.from(message, 'utf8'), {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
      'KALSHI-ACCESS-TIMESTAMP': ts,
    };
  }

  publicGet(subPath) {
    return request(this.host, 'GET', BASE_PATH + subPath);
  }

  signedRequest(method, subPath, body) {
    const path = BASE_PATH + subPath;
    // A assinatura cobre o path sem query string.
    const pathForSig = path.split('?')[0];
    return request(this.host, method, path, { body, headers: this._authHeaders(method, pathForSig) });
  }

  // ---- leitura publica ----

  async getMarkets(eventTicker) {
    const out = [];
    let cursor = '';
    do {
      const q = `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await this.publicGet(q);
      out.push(...(page.markets || []));
      cursor = page.cursor || '';
    } while (cursor && out.length < 1000);
    return out;
  }

  getEvent(eventTicker) {
    return this.publicGet(`/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
  }

  // Todas as series de uma categoria com uma tag (ex: Crypto + BTC). E assim que o
  // proprio site da Kalshi monta a lista "BTC" dentro de "Cripto".
  async getSeriesByCategoryTag(category, tag) {
    const out = [];
    let cursor = '';
    do {
      const q =
        `/series?category=${encodeURIComponent(category)}&tags=${encodeURIComponent(tag)}&limit=200` +
        (cursor ? `&cursor=${cursor}` : '');
      const page = await this.publicGet(q);
      out.push(...(page.series || []));
      cursor = page.cursor || '';
    } while (cursor);
    return out;
  }

  // Eventos ainda abertos de uma serie, com as faixas (markets) ja dentro de cada evento.
  async getOpenEventsForSeries(seriesTicker) {
    const out = [];
    let cursor = '';
    do {
      const q =
        `/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&with_nested_markets=true&limit=200` +
        (cursor ? `&cursor=${cursor}` : '');
      const page = await this.publicGet(q);
      out.push(...(page.events || []));
      cursor = page.cursor || '';
    } while (cursor);
    return out;
  }

  getOrderbook(ticker, depth = 10) {
    return this.publicGet(`/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`);
  }

  getTrades(ticker, limit = 100) {
    return this.publicGet(`/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`);
  }

  getCandles(seriesTicker, ticker, startTs, endTs, periodInterval = 1) {
    return this.publicGet(
      `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks` +
        `?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`
    );
  }

  // ---- portfolio (exige credenciais) ----

  getBalance() {
    return this.signedRequest('GET', '/portfolio/balance');
  }

  getPositions() {
    return this.signedRequest('GET', '/portfolio/positions?limit=200');
  }

  getOrders(status) {
    return this.signedRequest('GET', `/portfolio/orders?limit=200${status ? `&status=${status}` : ''}`);
  }

  getFills(limit = 100) {
    return this.signedRequest('GET', `/portfolio/fills?limit=${limit}`);
  }

  // Envia uma ordem de compra.
  //
  // ATENCAO ao formato de preco. A API v2 (/portfolio/events/orders) cota TUDO pelo lado
  // "vai passar" (yes):
  //   side 'bid' = comprar "vai passar" ao preco informado;
  //   side 'ask' = vender "vai passar", que e economicamente o mesmo que comprar
  //                "nao passa" por (1 - preco).
  // Por isso, para comprar "nao passa" a US$ 0,03 enviamos ask com preco 0,97.
  //
  // priceDollars e sempre o preco DO LADO ESCOLHIDO (o que o usuario ve e aprova).
  // A conversao para a cotacao do lado "vai passar" acontece aqui, num lugar so.
  createOrder({ ticker, side, priceDollars, count, clientOrderId, timeInForce = 'immediate_or_cancel' }) {
    if (side !== 'yes' && side !== 'no') throw new Error(`lado invalido: ${side}`);
    if (typeof ticker !== 'string' || !ticker) throw new Error('faixa invalida');

    const preco = Number(priceDollars);
    if (!(preco >= 0.01 && preco <= 0.99)) throw new Error(`preco fora da faixa permitida: ${priceDollars}`);

    const qtd = Number(count);
    if (!Number.isFinite(qtd) || qtd <= 0) throw new Error(`quantidade invalida: ${count}`);

    // Preco cotado pelo lado "vai passar", arredondado ao centavo (formato deste mercado).
    const yesPrice = side === 'yes' ? preco : 1 - preco;
    const yesPriceCents = Math.round(yesPrice * 100);
    if (yesPriceCents < 1 || yesPriceCents > 99) throw new Error(`preco convertido fora da faixa: ${yesPrice}`);

    const body = {
      ticker,
      client_order_id: clientOrderId || crypto.randomUUID(),
      side: side === 'yes' ? 'bid' : 'ask',
      count: qtd.toFixed(2),
      price: (yesPriceCents / 100).toFixed(2),
      time_in_force: timeInForce,
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
    };

    return this.signedRequest('POST', '/portfolio/events/orders', body);
  }

  cancelOrder(orderId) {
    return this.signedRequest('DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}`);
  }
}

// ---- fontes externas de preco spot / historico do BTC ----

function httpGetJson(host, path) {
  return request(host, 'GET', path);
}

async function getSpotBtc() {
  const sources = [
    async () => {
      const r = await httpGetJson('api.coinbase.com', '/v2/prices/BTC-USD/spot');
      return { price: parseFloat(r.data.amount), source: 'coinbase' };
    },
    async () => {
      const r = await httpGetJson('api.binance.com', '/api/v3/ticker/price?symbol=BTCUSDT');
      return { price: parseFloat(r.price), source: 'binance' };
    },
  ];
  const errors = [];
  for (const fn of sources) {
    try {
      const v = await fn();
      if (v.price > 0) return v;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error('nenhuma fonte de spot BTC respondeu: ' + errors.join(' | '));
}

// Candles de 1 minuto para estimar volatilidade realizada.
async function getBtcMinuteCandles(minutes = 720) {
  const limit = Math.min(1000, Math.max(60, minutes));
  try {
    const rows = await httpGetJson('api.binance.com', `/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`);
    return rows.map((r) => ({ ts: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
  } catch (e) {
    const r = await httpGetJson('api.exchange.coinbase.com', '/products/BTC-USD/candles?granularity=60');
    return r
      .map((c) => ({ ts: c[0] * 1000, low: +c[1], high: +c[2], open: +c[3], close: +c[4], volume: +c[5] }))
      .sort((a, b) => a.ts - b.ts);
  }
}

module.exports = { KalshiClient, getSpotBtc, getBtcMinuteCandles, HOSTS };
