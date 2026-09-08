'use strict';
const crypto = require('crypto');

const MODEL_VERSION = 'lognormal-baseline-v2';
function modelKey(config) {
  return crypto.createHash('sha256').update(JSON.stringify({ version: MODEL_VERSION, model: config.model,
    contracts: config.contracts, fees: config.fees, sources: config.priceSources, ranking:config.ranking,
    strategy:config.strategy, safety:config.safety,
    auto: Object.fromEntries(Object.entries(config.auto || {}).filter(([k])=>!['mode','dryRun'].includes(k))) })).digest('hex');
}
function contractSpec(config, market) {
  const spec = config.contracts?.events?.[market.eventTicker || config.eventTicker] ||
    config.contracts?.series?.[config.seriesTicker];
  if (!spec || spec.model !== 'terminal' || !spec.kinds?.includes(market.kind)) return null;
  if (!market.rules || !Array.isArray(spec.rulesContain) || !spec.rulesContain.length ||
      !spec.rulesContain.every(s => market.rules.toLowerCase().includes(s.toLowerCase()))) return null;
  if (market.kind === 'range' && !(market.capStrike > market.floorStrike)) return null;
  return spec;
}
function freshness(analysis, config, now = Date.now()) {
  const limits = config.safety || {};
  const checks = [['spot', analysis?.spotUpdatedAt, limits.maxSpotAgeMs ?? 5000],
    ['mercado', analysis?.marketUpdatedAt, limits.maxMarketAgeMs ?? 5000],
    ['análise', Date.parse(analysis?.generatedAt), limits.maxAnalysisAgeMs ?? 5000]];
  return checks.filter(([, ts, max]) => !Number.isFinite(ts) || ts <= 0 || now - ts > max || ts > now + 1000)
    .map(([name]) => `${name}: dado vencido ou timestamp inválido`);
}
function executableBook(response, side) {
  const fp = response?.orderbook_fp;
  const legacy = response?.orderbook;
  const levels = name => (fp?.[name + '_dollars'] || legacy?.[name] || []).map(([p,q]) =>
    [Number(p) / (fp ? 1 : 100), Number(q)]).filter(([p,q]) => p > 0 && p < 1 && q > 0 && Number.isFinite(q))
    .sort((a,b) => b[0]-a[0]);
  const opposite = levels(side === 'yes' ? 'no' : 'yes');
  const own = levels(side);
  if (!opposite.length) return { price: 0, availableQuantity: 0, spread: 1 };
  const price = +(1-opposite[0][0]).toFixed(4);
  return { price, availableQuantity: opposite.filter(x => x[0] === opposite[0][0]).reduce((s,x) => s+x[1],0),
    spread: own.length ? price-own[0][0] : 1, bid: own[0]?.[0] || 0 };
}
function direction(o) {
  if (o.kind === 'range' || o.kind === 'unknown') return 'mixed';
  return (o.kind === 'above') === (o.side === 'yes') ? 'up' : 'down';
}
module.exports = { MODEL_VERSION, modelKey, contractSpec, freshness, executableBook, direction };
