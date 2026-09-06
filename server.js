'use strict';

// Servidor local do painel. Serve a pasta /public e mantem os dados sempre atualizados.
//
// O navegador NAO fica perguntando por dados novos. Ele abre uma conexao permanente
// (/api/stream) e o servidor empurra cada atualizacao assim que ela acontece.
// Sem dependencias externas: apenas Node 18 ou mais novo.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { KalshiClient, getSpotBtc, getBtcMinuteCandles } = require('./lib/kalshi');
const { SpotStream, MarketPoller } = require('./lib/streams');
const { analyze } = require('./lib/analytics');
const { AutoTrader } = require('./lib/autotrader');
const { BtcBoard } = require('./lib/btcboard');

// Frase que o usuario precisa digitar para liberar apostas com dinheiro real.
const FRASE_CONFIRMACAO = 'QUERO APOSTAR DE VERDADE';

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const client = new KalshiClient(config);
const trader = new AutoTrader(client, config);
const board = new BtcBoard(client);

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------- dados ao vivo ----------

const spot = new SpotStream(getSpotBtc);
const poller = new MarketPoller(client, config.eventTicker, config.pollIntervalMs || 750);

let candles = [];
let candlesAt = 0;
async function refreshCandles() {
  try {
    candles = await getBtcMinuteCandles(config.model.volLookbackMinutes);
    candlesAt = Date.now();
  } catch (_) {}
}

let analysis = null;      // ultima analise completa
let version = 0;          // aumenta a cada analise nova
let lastComputeAt = 0;
let pendingCompute = null;

const MIN_COMPUTE_INTERVAL_MS = 200; // no maximo 5 recalculos por segundo

function computeNow() {
  if (!poller.markets.length || !spot.price) return null;
  analysis = analyze({ rawMarkets: poller.markets, spot: spot.price, candles, config });
  analysis.spotSource = spot.source;
  analysis.candleCount = candles.length;
  analysis.live = {
    spotAgeMs: Date.now() - spot.updatedAt,
    marketsAgeMs: Date.now() - poller.updatedAt,
    kalshiLatencyMs: poller.lastLatencyMs,
    pollIntervalMs: poller.intervalMs,
    kalshiError: poller.lastError,
  };
  version++;
  lastComputeAt = Date.now();
  broadcast();
  return analysis;
}

// Junta varias mudancas seguidas em um unico recalculo.
function scheduleCompute() {
  if (pendingCompute) return;
  const since = Date.now() - lastComputeAt;
  const wait = Math.max(0, MIN_COMPUTE_INTERVAL_MS - since);
  pendingCompute = setTimeout(() => {
    pendingCompute = null;
    computeNow();
  }, wait);
}

spot.on('price', scheduleCompute);
poller.on('markets', scheduleCompute);

spot.start();
poller.start();
refreshCandles();
setInterval(refreshCandles, 60000);

// ---------- conexoes abertas com o navegador ----------

const clients = new Set();

// Cada envio precisa ser pequeno para chegar rapido. Entao o servidor manda apenas as
// faixas de preco com os numeros de cada uma, arredondados. A lista completa de apostas,
// as listas de melhores e os dados dos graficos sao montados pelo proprio navegador a
// partir disso — a conta e a mesma, so muda quem faz.
const r4 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : v);

function streamPayload(a) {
  return {
    v: version,
    generatedAt: a.generatedAt,
    spot: r2(a.spot),
    spotSource: a.spotSource,
    candleCount: a.candleCount,
    live: a.live,
    event: a.event,
    vol: {
      realizedAnnual: r4(a.vol.realizedAnnual),
      impliedAnnual: r4(a.vol.impliedAnnual),
      usedAnnual: r4(a.vol.usedAnnual),
      sigmaPeriod: r4(a.vol.sigmaPeriod),
      sigmaDollars: r2(a.vol.sigmaDollars),
    },
    impliedMedian: r2(a.impliedMedian),
    totals: a.totals,
    arbitrage: a.arbitrage,
    rows: a.rows.map((r) => ({
      ticker: r.ticker,
      strike: r.strike,
      floorStrike: r.floorStrike,
      capStrike: r.capStrike,
      kind: r.kind,
      subtitle: r.subtitle,
      modelReliable: r.modelReliable,
      closeTime: r.closeTime,
      yesBid: r.yesBid, yesAsk: r.yesAsk, noBid: r.noBid, noAsk: r.noAsk,
      yesSpread: r4(r.yesSpread),
      mid: r4(r.mid), last: r.last, change: r4(r.change),
      volume: r2(r.volume), openInterest: r2(r.openInterest),
      modelProbYes: r4(r.modelProbYes),
      sigmaMoves: r4(r.sigmaMoves),
      distanceDollars: r2(r.distanceDollars),
      bestSide: r.bestLeg.side,
      legs: r.legs.map((l) => ({
        side: l.side,
        price: l.price,
        modelProb: r4(l.modelProb),
        edge: r4(l.edge),
        breakevenProb: r4(l.breakevenProb),
        evPct: r4(l.evPct),
        evDollars: r4(l.evDollars),
        grossReturnPct: r4(l.grossReturnPct),
        maxLossPerContract: r4(l.maxLossPerContract),
        kelly: r4(l.kelly),
        feePerContract: r4(l.feePerContract),
        roundTripCost: r4(l.roundTripCost),
        safety: Math.round(l.scores.safety),
        liquidity: Math.round(l.scores.liquidity),
        score: Math.round(l.score),
        eligible: l.eligible,
        filtersFailed: l.filtersFailed,
      })),
    })),
  };
}

function broadcast() {
  if (!analysis || !clients.size) return;
  const data = 'data: ' + JSON.stringify(streamPayload(analysis)) + '\n\n';
  for (const res of clients) {
    try { res.write(data); } catch (_) { clients.delete(res); }
  }
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  clients.add(res);
  if (analysis) res.write('data: ' + JSON.stringify(streamPayload(analysis)) + '\n\n');
  // Sinal de vida, para a conexao nao ser derrubada por inatividade.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

// ---------- robo que aposta sozinho ----------

// No modo normal isso nao faz nada. No semiautomatico gera sugestoes; no totalmente
// automatico envia as ordens. Uma execucao por vez, para nunca haver duas em paralelo.
let roboOcupado = false;
setInterval(async () => {
  if (roboOcupado || !analysis || trader.state.mode === 'normal') return;
  roboOcupado = true;
  try {
    await trader.runOnce(analysis);
  } catch (e) {
    trader.state.lastError = e.message;
  } finally {
    roboOcupado = false;
  }
}, Math.max(5, config.autoCheckSeconds || 10) * 1000);

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('o navegador enviou dados invalidos'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('acesso negado');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('pagina nao encontrada'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Espera a primeira analise ficar pronta (usado logo depois que o servidor sobe).
function whenReady(timeoutMs = 15000) {
  if (analysis) return Promise.resolve(analysis);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (analysis) { clearInterval(iv); resolve(analysis); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('ainda estou buscando os primeiros dados, tente de novo em instantes')); }
    }, 100);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/stream') return openStream(req, res);

    if (p === '/api/analysis') {
      const a = await whenReady();
      return sendJson(res, 200, streamPayload(a));
    }

    if (p === '/api/config' && req.method === 'GET') {
      const safe = JSON.parse(JSON.stringify(config));
      safe.credentials = {
        apiKeyId: config.credentials.apiKeyId ? '***cadastrada***' : '',
        privateKeyPath: config.credentials.privateKeyPath,
        environment: config.credentials.environment,
      };
      return sendJson(res, 200, safe);
    }

    if (p === '/api/config' && req.method === 'POST') {
      const patch = await readBody(req);
      if (patch.model) Object.assign(config.model, patch.model);
      if (patch.ranking) Object.assign(config.ranking, patch.ranking);
      if (patch.fees) Object.assign(config.fees, patch.fees);
      if (patch.pollIntervalMs) {
        config.pollIntervalMs = Math.max(250, patch.pollIntervalMs);
        poller.intervalMs = config.pollIntervalMs;
      }
      if (patch.eventTicker && patch.eventTicker !== config.eventTicker) {
        config.eventTicker = patch.eventTicker;
        config.seriesTicker = String(patch.eventTicker).split('-')[0];
        poller.setEventTicker(patch.eventTicker);
        // A analise que esta em memoria é da aposta ANTERIOR. Sem apagar ela, quem
        // perguntasse agora receberia numeros da aposta velha rotulados com o nome da
        // nova. Zerar faz /api/analysis esperar os dados certos chegarem.
        analysis = null;
      }
      saveConfig();
      computeNow();
      return sendJson(res, 200, { ok: true, eventTicker: config.eventTicker });
    }

    if (p === '/api/capital' && req.method === 'GET') {
      return sendJson(res, 200, config.capital || { inicial: null, atual: null });
    }

    if (p === '/api/capital' && req.method === 'POST') {
      const body = await readBody(req);
      const inicial = Number(body.inicial);
      const atual = Number(body.atual);
      if (!Number.isFinite(inicial) || inicial <= 0) return sendJson(res, 400, { error: 'capital inicial precisa ser um número maior que zero' });
      if (!Number.isFinite(atual) || atual < 0) return sendJson(res, 400, { error: 'capital atual precisa ser um número válido' });
      config.capital = { inicial, atual };
      saveConfig();
      return sendJson(res, 200, config.capital);
    }

    if (p === '/api/auto/status') return sendJson(res, 200, trader.status());

    if (p === '/api/auto/toggle' && req.method === 'POST') {
      const body = await readBody(req);

      // Duas mudancas exigem a frase digitada por uma pessoa:
      // ligar o modo totalmente automatico e desligar o modo teste.
      const querFull = body.mode === 'full';
      const querSair = body.dryRun === false;
      if ((querFull || querSair) && body.confirm !== FRASE_CONFIRMACAO) {
        return sendJson(res, 400, {
          error: `para ${querFull ? 'ligar o modo totalmente automático' : 'desligar o modo teste'} envie confirm: "${FRASE_CONFIRMACAO}"`,
        });
      }
      // Sem conta cadastrada nao existe motivo para sair do modo teste.
      if (querSair && !client.hasCredentials()) {
        return sendJson(res, 400, { error: 'sua conta da Kalshi não está cadastrada; sem ela só dá para simular' });
      }

      if (typeof body.mode === 'string') trader.setMode(body.mode);
      if (typeof body.dryRun === 'boolean') trader.setDryRun(body.dryRun);

      config.auto.mode = trader.state.mode;
      config.auto.dryRun = trader.state.dryRun;
      saveConfig();
      return sendJson(res, 200, trader.status());
    }

    // Aprovar ou recusar uma sugestao do modo semiautomatico
    if (p === '/api/auto/aprovar' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'faltou dizer qual sugestão' });
      const a = await whenReady();
      return sendJson(res, 200, await trader.aprovar(body.id, a));
    }

    if (p === '/api/auto/recusar' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: 'faltou dizer qual sugestão' });
      return sendJson(res, 200, trader.recusar(body.id));
    }

    if (p === '/api/auto/settings' && req.method === 'POST') {
      trader.updateSettings(await readBody(req));
      saveConfig();
      return sendJson(res, 200, trader.status());
    }

    // Avalia agora, respeitando o modo teste e todos os limites
    if (p === '/api/auto/run' && req.method === 'POST') {
      const a = await whenReady();
      return sendJson(res, 200, await trader.runOnce(a));
    }

    // Mostra o que o robo faria, sem nunca apostar
    if (p === '/api/auto/preview') {
      const a = await whenReady();
      const preview = a.bestOverall.slice(0, 8).map((o) => ({
        ticker: o.ticker, side: o.side, strike: o.strike, price: o.price,
        modelProb: o.modelProb, edge: o.edge, evPct: o.evPct, score: o.score,
        sizing: trader.sizeOrder(o),
        vetoes: trader.vetoes(o, a),
      }));
      return sendJson(res, 200, { preview });
    }

    if (p === '/api/portfolio') {
      if (!client.hasCredentials()) return sendJson(res, 200, { configured: false });
      const [balance, positions, orders] = await Promise.all([
        client.getBalance().catch((e) => ({ error: e.message })),
        client.getPositions().catch((e) => ({ error: e.message })),
        client.getOrders('resting').catch((e) => ({ error: e.message })),
      ]);
      return sendJson(res, 200, { configured: true, balance, positions, orders });
    }

    if (p === '/api/orderbook') {
      const ticker = url.searchParams.get('ticker');
      if (!ticker) return sendJson(res, 400, { error: 'faltou dizer qual faixa' });
      return sendJson(res, 200, await client.getOrderbook(ticker, 20));
    }

    if (p === '/api/btc-history') {
      if (!candles.length) await refreshCandles();
      return sendJson(res, 200, { candles: candles.slice(-360).map((c) => ({ ts: c.ts, close: c.close })) });
    }

    // Lista para ESCOLHER qual aposta de Bitcoin analisar (todas as series, nao so a
    // configurada acima), ja agrupada por evento e com a mesma frequencia do site
    // (15 min, diario...). So busca de verdade na Kalshi quando o cache esta velho.
    if (p === '/api/btc-board') {
      const s = await board.getFresh();
      return sendJson(res, 200, s);
    }

    if (p === '/api/btc-board/refresh' && req.method === 'POST') {
      const s = await board.refresh();
      return sendJson(res, 200, s);
    }

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(config.port, () => {
  console.log(`\n  Painel de Apostas no Bitcoin`);
  console.log(`  Abra no navegador: http://localhost:${config.port}`);
  console.log(`  Evento: ${config.eventTicker}`);
  console.log(`  Preco do Bitcoin: ao vivo (WebSocket) | Precos da Kalshi: a cada ${poller.intervalMs} ms`);
  const nomeModo = { normal: 'normal (so analisa)', semi: 'semiautomatico (sugere e espera voce)', full: 'TOTALMENTE AUTOMATICO' };
  console.log(`  Modo: ${nomeModo[trader.state.mode]} | Modo teste: ${trader.state.dryRun ? 'ligado (nada e enviado)' : 'DESLIGADO - APOSTA DE VERDADE'}`);
  console.log(`  Conta da Kalshi: ${client.hasCredentials() ? 'cadastrada' : 'nao cadastrada (so analise)'}\n`);
});
