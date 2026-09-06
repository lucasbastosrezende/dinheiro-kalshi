'use strict';

// Lista para a pessoa ESCOLHER qual aposta de Bitcoin quer analisar — nao so a que esta
// configurada em config.eventTicker. Busca todas as series marcadas com a tag "BTC" dentro
// de "Crypto" (a API da Kalshi nao tem um jeito de listar isso numa unica chamada: o
// endpoint /events ignora filtro de categoria/tag), pega os eventos ainda abertos de cada
// serie e agrupa como o site da Kalshi agrupa: cada evento vira um cartao, com a categoria
// (15 min, horario, diario...) vinda do proprio campo "cadence" que a Kalshi manda.
//
// Isso e uma varredura de ~45 chamadas, entao NAO roda sozinho em segundo plano: so busca
// quando alguem abre o seletor (getFresh), e guarda o resultado por um tempo (CACHE_MS)
// para reabrir o seletor ser instantaneo. Rodar isso o tempo todo brigaria com o poller
// rapido do mercado configurado (a cada poucos ms) pelo mesmo limite de requisicoes da
// Kalshi, e o seletor nunca terminaria de carregar.

const { EventEmitter } = require('events');

const CATEGORY = 'Crypto';
const TAG = 'BTC';
const CACHE_MS = 60000;

// Ordem e nomes dos filtros, iguais aos do site (aba Cripto > BTC). A Kalshi manda uma
// "cadence" por evento; quando ela nao e nenhuma destas seis (ex: "custom", horario fixo
// que so acontece uma vez), o site trata como "Uma Vez" — e este codigo faz o mesmo.
const FREQ_ORDER = ['fifteen_min', 'hourly', 'daily', 'weekly', 'monthly', 'annual', 'one_off'];
const FREQ_LABEL = {
  fifteen_min: '15 min',
  hourly: 'Horário',
  daily: 'Diário',
  weekly: 'Semanal',
  monthly: 'Mensal',
  annual: 'Anual',
  one_off: 'Uma Vez',
};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeFreq(v) {
  const f = String(v || '').toLowerCase().replace(/\s+/g, '_');
  return FREQ_ORDER.includes(f) ? f : 'one_off';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A API publica da Kalshi derruba (HTTP 429) se disparar muitas chamadas de uma vez.
// Tenta de novo, esperando cada vez mais, antes de desistir daquela serie.
async function withRetry429(fn, tries = 5) {
  let wait = 500;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.statusCode === 429 && i < tries - 1) {
        await sleep(wait + Math.random() * 200);
        wait *= 2;
        continue;
      }
      throw e;
    }
  }
}

// Roda no maximo `limit` chamadas ao mesmo tempo, com uma pequena pausa entre cada uma
// dentro do mesmo "worker", para nao estourar o limite de requisicoes da Kalshi.
// Nunca rejeita: cada resultado vem com status/value ou reason, como Promise.allSettled.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
      await sleep(80);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Junta um evento (com suas faixas) num cartao pronto para a tela.
function buildGroup(event, seriesInfo) {
  const markets = event.markets || [];
  const freq = normalizeFreq((event.product_metadata && event.product_metadata.cadence) || (seriesInfo && seriesInfo.frequency));
  const volume = markets.reduce((s, m) => s + num(m.volume_fp ?? m.volume), 0);
  const openInterest = markets.reduce((s, m) => s + num(m.open_interest_fp ?? m.open_interest), 0);

  // As duas faixas com mais negocios, para dar um resumo do evento no cartao.
  const top = markets
    .map((m) => {
      const yesBid = num(m.yes_bid_dollars);
      const yesAsk = num(m.yes_ask_dollars);
      const impliedProb = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : yesBid || yesAsk || num(m.last_price_dollars);
      return {
        ticker: m.ticker,
        label: m.yes_sub_title || m.subtitle || m.title || '',
        impliedProb,
        volume: num(m.volume_fp ?? m.volume),
      };
    })
    .filter((m) => m.impliedProb > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 2);

  const closeTime = markets.reduce((min, m) => {
    const t = m.close_time ? new Date(m.close_time).getTime() : 0;
    return t && (!min || t < min) ? t : min;
  }, 0);

  return {
    eventTicker: event.event_ticker,
    seriesTicker: event.series_ticker,
    freq,
    title: event.title || (seriesInfo && seriesInfo.title) || event.event_ticker,
    subTitle: event.sub_title || '',
    closeTime: closeTime ? new Date(closeTime).toISOString() : null,
    marketsCount: markets.length,
    volume,
    openInterest,
    top,
  };
}

class BtcBoard extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.groups = [];
    this.counts = {};
    this.updatedAt = 0;
    this.lastError = null;
    this._series = null;
    this._refreshing = null;
  }

  status() {
    return {
      updatedAt: this.updatedAt,
      groups: this.groups,
      counts: this.counts,
      freqOrder: FREQ_ORDER,
      freqLabel: FREQ_LABEL,
      error: this.lastError,
    };
  }

  // Usa o resultado guardado se ele ainda estiver fresco; so bate na Kalshi de novo
  // se nunca buscou ou se passou do tempo de cache. E assim que o seletor evita
  // varrer as 45 series toda vez que a pessoa abre e fecha a janela.
  async getFresh(maxAgeMs = CACHE_MS) {
    if (this.updatedAt && Date.now() - this.updatedAt < maxAgeMs) return this.status();
    try {
      return await this.refresh();
    } catch (e) {
      this.lastError = e.message;
      return this.status();
    }
  }

  // A lista de series muda muito raramente, entao so busca ela uma vez por execucao.
  async _loadSeries() {
    if (this._series) return this._series;
    this._series = await this.client.getSeriesByCategoryTag(CATEGORY, TAG);
    return this._series;
  }

  // Evita duas buscas rodando ao mesmo tempo se a pessoa clicar "tentar de novo"
  // enquanto uma busca anterior ainda esta em andamento.
  refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _doRefresh() {
    const series = await this._loadSeries();

    // So 3 chamadas por vez, com pausa entre elas: a API publica da Kalshi e sensivel
    // a rajadas, ainda mais com o poller do mercado configurado rodando ao mesmo tempo.
    const results = await mapWithConcurrency(series, 3, (s) => withRetry429(() => this.client.getOpenEventsForSeries(s.ticker)));

    const groups = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const seriesInfo = series[i];
      for (const ev of r.value) {
        if (ev.markets && ev.markets.length) groups.push(buildGroup(ev, seriesInfo));
      }
    });

    groups.sort((a, b) => b.volume - a.volume);

    const counts = { all: groups.length };
    for (const f of FREQ_ORDER) counts[f] = 0;
    for (const g of groups) counts[g.freq]++;

    this.groups = groups;
    this.counts = counts;
    this.updatedAt = Date.now();
    this.lastError = null;
    this.emit('update', this.status());
    return this.status();
  }
}

module.exports = { BtcBoard, FREQ_ORDER, FREQ_LABEL };
