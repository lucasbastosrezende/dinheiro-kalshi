'use strict';

// Motor de analise: volatilidade, probabilidade teorica, edge, EV, Kelly,
// custo de taxas, deteccao de arbitragem e score composto de risco/retorno.

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
const { contractSpec, modelKey, MODEL_VERSION } = require('./safety');

// ---------- utilitarios estatisticos ----------

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return NaN;
  const pos = (sortedArr.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
}

// ---------- volatilidade ----------

// Vol realizada anualizada a partir de retornos log de 1 minuto, com pesagem EWMA.
function realizedVolAnnual(candles, halfLifeMinutes = 90) {
  if (!candles || candles.length < 20) return null;
  const rets = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].ts != null && candles[i-1].ts != null && candles[i].ts-candles[i-1].ts !== 60000) continue;
    const r = Math.log(candles[i].close / candles[i - 1].close);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 20) return null;
  const lambda = Math.pow(0.5, 1 / Math.max(1, halfLifeMinutes));
  let wsum = 0, acc = 0, w = 1;
  for (let i = rets.length - 1; i >= 0; i--) {
    acc += w * rets[i] * rets[i];
    wsum += w;
    w *= lambda;
    if (w < 1e-6) break;
  }
  const varPerMinute = acc / wsum;
  const minutesPerYear = 365 * 24 * 60;
  return Math.sqrt(varPerMinute * minutesPerYear);
}

// Vol implicita: acha o sigma que melhor reproduz os precos medios do mercado
// (ponderado por open interest) sob modelo lognormal sem drift.
// Acha o sigma que melhor reproduz os precos que o mercado esta praticando.
//
// A conta usa exatamente a mesma formula de precificacao que o resto do painel usa para
// aquele tipo de contrato (preco final ou encostar; acima, abaixo ou faixa) e o prazo
// proprio de cada faixa. Uma versao anterior encaixava tudo como se fosse "X ou mais",
// o que dava um sigma errado justamente nos eventos de faixa e de encostar.
function impliedVolFit(markets, spot, contractModel, now, fallbackYears) {
  const pts = markets
    .map((m) => {
      const ms = m.closeTime ? Math.max(0, new Date(m.closeTime).getTime() - now) : fallbackYears * MS_PER_YEAR;
      return { m, years: ms / MS_PER_YEAR, p: m.mid, w: Math.sqrt(1 + (m.openInterest || 0)) };
    })
    .filter((pt) => pt.p > 0.02 && pt.p < 0.98 && pt.years > 0 && (pt.m.openInterest > 0 || pt.m.volume > 0))
    .filter((pt) => modelProbForMarket(pt.m, spot, 0.5, pt.years, contractModel) != null);

  if (pts.length < 4) return null;

  const loss = (sigma) => {
    let e = 0;
    for (const pt of pts) {
      const model = modelProbForMarket(pt.m, spot, sigma, pt.years, contractModel);
      if (model == null) continue;
      e += pt.w * (model - pt.p) ** 2;
    }
    return e;
  };

  // busca ternaria em [1%, 400%] anualizado
  let lo = 0.01, hi = 4.0;
  for (let i = 0; i < 80; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (loss(m1) < loss(m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

// P(S_T > K) sob lognormal martingale (drift zero, medida de risco neutro).
function probAbove(spot, strike, sigmaAnnual, years) {
  if (!(strike > 0) || !(spot > 0)) return null;
  if (years <= 0) return spot > strike ? 1 : 0;
  if (sigmaAnnual <= 0) return spot > strike ? 1 : 0;
  const vol = sigmaAnnual * Math.sqrt(years);
  const d2 = (Math.log(spot / strike) - 0.5 * vol * vol) / vol;
  return clamp(normCdf(d2), 0, 1);
}

// ---------- apostas de "encostar no preço" (one-touch) ----------
//
// Uma parte das apostas de Bitcoin da Kalshi nao pergunta onde o preco TERMINA, e sim se
// ele ENCOSTA num valor em algum momento ate a data ("quão alto o BTC chega em setembro",
// "quando o BTC cruza $85k"). Sao coisas bem diferentes: para encostar basta passar por
// ali uma vez, entao a chance e sempre maior que a de terminar acima.
//
// Formula: principio da reflexao para o maximo/minimo de um movimento browniano
// geometrico sem tendencia (a mesma medida usada no resto do arquivo). Como a tendencia
// em log e exatamente -sigma²/2, o fator de reflexao e^(2*mu*b/sigma²) simplifica para
// spot/barreira, que e o que aparece abaixo.
//
// Conferido contra simulacao de Monte Carlo: bate dentro de 0,5 ponto percentual.

// Chance de o preco encostar em algum momento numa barreira ACIMA do preco de hoje.
function probTouchUp(spot, barrier, sigmaAnnual, years) {
  if (!(spot > 0) || !(barrier > 0)) return null;
  if (barrier <= spot) return 1; // ja esta no nivel ou acima
  if (years <= 0 || sigmaAnnual <= 0) return 0;
  const b = Math.log(barrier / spot);
  const muT = -0.5 * sigmaAnnual * sigmaAnnual * years;
  const s = sigmaAnnual * Math.sqrt(years);
  return clamp(normCdf((muT - b) / s) + (spot / barrier) * normCdf((-b - muT) / s), 0, 1);
}

// Chance de o preco encostar em algum momento numa barreira ABAIXO do preco de hoje.
function probTouchDown(spot, barrier, sigmaAnnual, years) {
  if (!(spot > 0) || !(barrier > 0)) return null;
  if (barrier >= spot) return 1; // ja esta no nivel ou abaixo
  if (years <= 0 || sigmaAnnual <= 0) return 0;
  const b = Math.log(barrier / spot);
  const muT = -0.5 * sigmaAnnual * sigmaAnnual * years;
  const s = sigmaAnnual * Math.sqrt(years);
  return clamp(normCdf((b - muT) / s) + (spot / barrier) * normCdf((b + muT) / s), 0, 1);
}

// Compatibilidade: títulos nunca autorizam modelos. A configuração explícita decide.
function detectContractModel(seriesTicker, title) {
  return 'unknown';
}

// Chance de a aposta "vai passar" (YES) dar certo, conforme o TIPO da faixa.
//
// A Kalshi usa varios formatos de contrato e cada um paga numa condicao diferente.
// Tratar todos como "acima do strike" (o que este arquivo fazia antes) inverte a conta
// nas faixas "abaixo de" e infla ela nas faixas "de X ate Y" — o que criava vantagens
// enormes e falsas justamente nos mercados de faixa.
//
//   above  ($79.500 ou mais)        -> P(S > piso)
//   below  (19.999,99 ou menos)     -> P(S <= teto)          = 1 - P(S > teto)
//   range  ($79.500 a 79.749,99)    -> P(piso <= S <= teto)  = P(S > piso) - P(S > teto)
//   unknown (ex: "50.000 primeiro") -> nao da para modelar com este modelo de preco final
function modelProbForMarket(market, spot, sigmaAnnual, years, contractModel = 'terminal') {
  const { kind, floorStrike, capStrike } = market;
  if (!['terminal','touch'].includes(contractModel)) return null;

  // Apostas de encostar: a direcao vem do proprio formato da faixa — "acima de X" olha
  // o maximo do periodo, "abaixo de X" olha o minimo. Faixa "de X ate Y" nao existe
  // nesse formato, entao fica sem modelo em vez de receber um numero inventado.
  if (contractModel === 'touch') {
    if (kind === 'above') return probTouchUp(spot, floorStrike, sigmaAnnual, years);
    if (kind === 'below') return probTouchDown(spot, capStrike, sigmaAnnual, years);
    return null;
  }

  if (kind === 'above') return probAbove(spot, floorStrike, sigmaAnnual, years);
  if (kind === 'below') {
    const p = probAbove(spot, capStrike, sigmaAnnual, years);
    return p == null ? null : clamp(1 - p, 0, 1);
  }
  if (kind === 'range') {
    const pFloor = probAbove(spot, floorStrike, sigmaAnnual, years);
    const pCap = probAbove(spot, capStrike, sigmaAnnual, years);
    if (pFloor == null || pCap == null) return null;
    return clamp(pFloor - pCap, 0, 1);
  }
  return null;
}

// ---------- taxas Kalshi ----------

// Taxa de negociacao Kalshi: ceil(rate * C * P * (1-P)) ao centavo.
// O epsilon evita cobrar um centavo a mais quando o resultado exato fica
// representado como 1.4699999999999998 pelo JavaScript.
function tradingFeeDollars(priceDollars, contracts, rate) {
  const p = Number(priceDollars);
  const c = Number(contracts);
  const r = Number(rate);
  if (!(p > 0 && p < 1) || !(c > 0) || !(r >= 0)) return 0;
  const cents = Math.ceil(Math.max(0, r * c * p * (1 - p) * 100 - 1e-9));
  return cents / 100;
}

// Custo efetivamente debitado de uma ordem imediata. A taxa e arredondada
// uma vez para o lote inteiro, como na Kalshi, e nao uma vez por contrato.
function orderCostDollars(priceDollars, contracts, fees = {}) {
  const price = Number(priceDollars);
  const count = Number(contracts);
  if (!(price > 0 && price < 1) || !(count > 0)) return 0;
  return price * count + tradingFeeDollars(price, count, fees.tradingFeeRate ?? 0.07);
}

// A tela da Kalshi aceita centesimos de contrato. Encontra a maior quantidade
// que cabe no valor informado, respeitando a taxa arredondada do lote.
function maxContractsForBudget(priceDollars, budgetDollars, fees = {}, maxContracts = Infinity) {
  const price = Number(priceDollars);
  const budget = Number(budgetDollars);
  const cap = Number(maxContracts);
  if (!(price > 0 && price < 1) || !(budget > 0)) return 0;

  let count = Math.min(
    Number.isFinite(cap) && cap > 0 ? cap : Infinity,
    Math.floor((budget / price) * 100 + 1e-9) / 100
  );
  count = Math.floor(count * 100 + 1e-9) / 100;
  while (count >= 0.01 && orderCostDollars(price, count, fees) > budget + 1e-9) {
    count = Math.round((count - 0.01) * 100) / 100;
  }
  return count >= 0.01 ? count : 0;
}

// ---------- parsing de mercado ----------

// Descobre em que condicao a faixa paga, a partir do strike_type da Kalshi e dos
// limites que vierem preenchidos. O strike_type e a fonte principal; os limites servem
// de reserva porque algumas series antigas nao mandam o tipo.
function classifyStrike(rawType, floorStrike, capStrike) {
  const t = String(rawType || '').toLowerCase();
  const temPiso = floorStrike > 0;
  const temTeto = capStrike > 0;

  if (t === 'between') return temPiso && temTeto ? 'range' : 'unknown';
  if (t === 'less' || t === 'less_or_equal') return temTeto ? 'below' : 'unknown';
  if (t === 'greater' || t === 'greater_or_equal') return temPiso ? 'above' : 'unknown';

  return 'unknown';
}

function parseMarket(raw) {
  const num = (v) => (v === undefined || v === null || v === '' ? 0 : parseFloat(v));
  const yesBid = num(raw.yes_bid_dollars ?? (raw.yes_bid != null ? raw.yes_bid / 100 : 0));
  const yesAsk = num(raw.yes_ask_dollars ?? (raw.yes_ask != null ? raw.yes_ask / 100 : 0));
  const noBid = num(raw.no_bid_dollars ?? (raw.no_bid != null ? raw.no_bid / 100 : 0));
  const noAsk = num(raw.no_ask_dollars ?? (raw.no_ask != null ? raw.no_ask / 100 : 0));
  const volume = num(raw.volume_fp ?? raw.volume);
  const volume24h = num(raw.volume_24h_fp ?? raw.volume_24h);
  const openInterest = num(raw.open_interest_fp ?? raw.open_interest);
  const last = num(raw.last_price_dollars ?? (raw.last_price != null ? raw.last_price / 100 : 0));
  const prev = num(raw.previous_price_dollars ?? (raw.previous_price != null ? raw.previous_price / 100 : 0));

  const hasYes = yesBid > 0 && yesAsk > 0;
  const mid = hasYes ? (yesBid + yesAsk) / 2 : yesAsk > 0 ? yesAsk : last;

  const floorStrike = num(raw.floor_strike);
  const capStrike = num(raw.cap_strike);
  const kind = classifyStrike(raw.strike_type, floorStrike, capStrike);

  // Valor unico usado para ordenar e rotular a faixa na tela. Numa faixa "de X ate Y"
  // o ponto central representa melhor a faixa do que qualquer uma das duas pontas.
  const strike =
    kind === 'range' ? (floorStrike + capStrike) / 2 : kind === 'below' ? capStrike : floorStrike || capStrike;

  return {
    ticker: raw.ticker,
    eventTicker: raw.event_ticker,
    title: raw.title,
    subtitle: raw.yes_sub_title || raw.subtitle || '',
    strike,
    floorStrike,
    capStrike,
    kind,
    strikeType: raw.strike_type,
    status: raw.status,
    closeTime: raw.close_time,
    openTime: raw.open_time,
    yesBid, yesAsk, noBid, noAsk,
    yesSpread: yesAsk > 0 && yesBid > 0 ? yesAsk - yesBid : 1,
    mid,
    last,
    prev,
    change: last && prev ? last - prev : 0,
    volume,
    volume24h,
    openInterest,
    liquidity: num(raw.liquidity_dollars),
    yesAskSize: num(raw.yes_ask_size_fp),
    yesBidSize: num(raw.yes_bid_size_fp),
    rules: raw.rules_primary || '',
  };
}

// ---------- avaliacao de uma perna (lado yes ou no) ----------

function evaluateLeg({ side, market, modelProbYes, fees = {}, yearsToClose, sizeContracts = 1, capitalAtual, capitalInicial }) {
  const isYes = side === 'yes';
  const price = isYes ? market.yesAsk : market.noAsk;      // preco pago para entrar (custo)
  const exitBid = isYes ? market.yesBid : market.noBid;    // preco de saida imediata
  const modelProb = isYes ? modelProbYes : 1 - modelProbYes;
  const impliedProb = price;                              // preco = probabilidade implicita

  const requestedCount = Number(sizeContracts);
  const count = Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 0;
  const tradable = price > 0 && price < 1 && count > 0;
  const feeIn = tradable ? tradingFeeDollars(price, count, fees.tradingFeeRate ?? 0.07) : 0;
  const cost = price * count + feeIn;
  const settlementFee = Math.max(0, Number(fees.settlementFeePerContract) || 0);
  const payoff = Math.max(0, 1 - settlementFee) * count;

  const edge = modelProb - impliedProb;                       // vantagem bruta em probabilidade
  const evDollars = tradable ? modelProb * payoff - cost : 0; // valor esperado liquido em US$
  const evPct = cost > 0 ? evDollars / cost : 0;              // retorno esperado sobre capital
  const grossReturnPct = price > 0 ? (1 - price) / price : 0; // retorno se ganhar, sem taxa (legado)
  const winReturnPct = cost > 0 ? (payoff - cost) / cost : 0; // retorno se ganhar, ja com a taxa
  const lossPct = -1;                                         // perde 100% do custo se errar

  // Retorno composto sobre o capital total: quanto o SALDO acumulado (ja incluindo a
  // valorizacao desde o capital inicial) muda se esta aposta resolver. Diferente de
  // evPct/winReturnPct, que medem so o retorno isolado da ordem sobre o proprio custo.
  const capAtualNum = Number(capitalAtual);
  const capIniNum = Number(capitalInicial);
  const temCapital = Number.isFinite(capAtualNum) && capAtualNum > 0;
  const valorizacaoAtual = temCapital && Number.isFinite(capIniNum) && capIniNum > 0 ? capAtualNum / capIniNum - 1 : 0;
  const ganhoEsperadoSobreCapital = temCapital ? evDollars / capAtualNum : evPct;
  const ganhoSeGanharSobreCapital = temCapital ? (payoff - cost) / capAtualNum : winReturnPct;
  const evPctCapital = (1 + valorizacaoAtual) * (1 + ganhoEsperadoSobreCapital) - 1;
  const winReturnPctCapital = (1 + valorizacaoAtual) * (1 + ganhoSeGanharSobreCapital) - 1;

  // Kelly para aposta binaria: f* = (p*b - q)/b, b = odds liquidas apos taxa.
  const b = cost > 0 ? (payoff - cost) / cost : 0;
  const kelly = b > 0 ? clamp((modelProb * b - (1 - modelProb)) / b, 0, 1) : 0;

  // Custo de comprar e vender imediatamente, incluindo as duas taxas.
  const feeOut = tradable && exitBid > 0 && exitBid < 1 ? tradingFeeDollars(exitBid, count, fees.tradingFeeRate ?? 0.07) / count : 0;
  const roundTripCost = tradable && exitBid > 0 ? price + feeIn / count + feeOut - exitBid : price + feeIn / count;
  const entryCostPerContract = count > 0 ? cost / count : 0;
  const maxPayoutPerContract = count > 0 ? payoff / count : 0;
  const maxGainPerContract = count > 0 ? (payoff - cost) / count : 0;

  return {
    side,
    price,
    exitBid,
    tradable,
    impliedProb,
    modelProb,
    edge,
    evDollars,
    evPct,
    grossReturnPct,
    winReturnPct,
    evPctCapital,
    winReturnPctCapital,
    lossPct,
    kelly,
    feePerContract: count > 0 ? feeIn / count : 0,
    breakevenProb: maxPayoutPerContract > 0 ? clamp(entryCostPerContract / maxPayoutPerContract, 0, 1) : 1,
    roundTripCost,
    entryCostPerContract,
    maxPayoutPerContract,
    maxLossPerContract: count > 0 ? cost / count : 0,
    maxGainPerContract,
    contracts: count,
    orderCost: cost,
    maxPayout: payoff,
    maxLoss: cost,
    maxGain: payoff - cost,
    exitFeePerContract: feeOut,
  };
}

// ---------- scores ----------

// Seguranca (0-100): probabilidade do modelo, margem sobre o breakeven,
// distancia do strike em desvios-padrao e qualidade do book.
function safetyScore(leg, market, sigmaMoves) {
  const probComp = clamp((leg.modelProb - 0.5) * 2, 0, 1);                 // 0.5 -> 0, 1.0 -> 1
  const marginComp = clamp((leg.modelProb - leg.breakevenProb) / 0.20, 0, 1);
  const sigmaComp = clamp(Math.abs(sigmaMoves) / 3, 0, 1);                  // 3 sigma de distancia = maximo
  const spreadComp = clamp(1 - market.yesSpread / 0.06, 0, 1);
  const depthComp = clamp(Math.log10(1 + market.openInterest) / 4.5, 0, 1);
  return 100 * (0.34 * probComp + 0.26 * marginComp + 0.16 * sigmaComp + 0.12 * spreadComp + 0.12 * depthComp);
}

// Liquidez (0-100): volume, open interest, spread e tamanho no topo do book.
function liquidityScore(market) {
  const volComp = clamp(Math.log10(1 + market.volume) / 5, 0, 1);
  const oiComp = clamp(Math.log10(1 + market.openInterest) / 4.7, 0, 1);
  const spreadComp = clamp(1 - market.yesSpread / 0.08, 0, 1);
  const sizeComp = clamp(Math.log10(1 + Math.max(market.yesAskSize, market.yesBidSize)) / 4, 0, 1);
  return 100 * (0.3 * volComp + 0.3 * oiComp + 0.25 * spreadComp + 0.15 * sizeComp);
}

// Rentabilidade (0-100): EV percentual normalizado.
function profitScore(leg) {
  return 100 * clamp(leg.evPct / 0.35, 0, 1);
}

function compositeScore(parts, weights) {
  const w = weights;
  const total = w.weightEdge + w.weightSafety + w.weightLiquidity + w.weightKelly || 1;
  const kellyComp = 100 * clamp(parts.kelly / 0.5, 0, 1);
  return (
    (w.weightEdge * parts.profit +
      w.weightSafety * parts.safety +
      w.weightLiquidity * parts.liquidity +
      w.weightKelly * kellyComp) /
    total
  );
}

// ---------- deteccao de arbitragem / inconsistencias ----------

// Contratos digitais so admitem duas restricoes de nao-arbitragem uteis aqui.
// (Convexidade tipo borboleta NAO vale para digitais: o payoff do meio fica negativo.)
//
// Regra geral: comprar YES no strike A e NO no strike B, com A <= B.
//   S <= A         -> YES 0 + NO 1 = $1
//   A <  S <= B    -> YES 1 + NO 1 = $2
//   S >  B         -> YES 1 + NO 0 = $1
// O payoff minimo e sempre $1. Se o custo total (com taxas) ficar abaixo de $1, o lucro
// esta travado independentemente do preco final do BTC. Com A == B esse e o caso classico
// de YES+NO < $1 no mesmo strike.
function findArbitrage(markets, fees) {
  const out = [];
  const live = markets.filter((m) => m.yesAsk > 0 && m.yesAsk < 1 && m.noAsk > 0 && m.noAsk < 1);
  const taxa = (p) => tradingFeeDollars(p, 1, fees.tradingFeeRate);

  // 1) Mesma faixa: YES + NO custando menos de $1. Vale para QUALQUER tipo de contrato,
  // porque as duas pontas da mesma faixa sempre somam exatamente $1 no vencimento.
  for (const m of live) {
    const cost = m.yesAsk + m.noAsk;
    const fee = taxa(m.yesAsk) + taxa(m.noAsk);
    const profit = 1 - cost - fee;
    if (profit > 0.001) {
      out.push({
        type: 'mesma-faixa',
        label: 'comprar as duas pontas da mesma faixa por menos de $1',
        tickers: [m.ticker],
        detail: `comprar "vai passar" a $${m.yesAsk.toFixed(2)} + "não passa" a $${m.noAsk.toFixed(2)} = $${cost.toFixed(2)} (+taxa $${fee.toFixed(3)}), recebe exatamente $1,00`,
        profitPerContract: profit,
        minPayoff: 1,
      });
    }
  }

  // 2) Par de faixas do tipo "X ou mais", com piso A <= piso B:
  //      S <= A      -> YES 0 + NO 1 = $1
  //      A < S <= B  -> YES 1 + NO 1 = $2
  //      S > B       -> YES 1 + NO 0 = $1
  // O recebimento minimo e sempre $1, entao custo total abaixo de $1 trava lucro.
  //
  // Isso SO vale na escada "X ou mais". Em faixas "de X ate Y" (que sao mutuamente
  // exclusivas) essa combinacao pode receber zero, e apontar isso como lucro garantido
  // faria o painel recomendar uma perda certa.
  const escada = live.filter((m) => m.kind === 'above').sort((a, b) => a.floorStrike - b.floorStrike);

  // Menor "não passa" de cada ponto para a frente: permite pular blocos inteiros do laco
  // interno quando nem o melhor preco possivel fecharia conta (188 faixas por evento,
  // recalculado varias vezes por segundo).
  const menorNoAsk = new Array(escada.length);
  for (let i = escada.length - 1; i >= 0; i--) {
    menorNoAsk[i] = Math.min(escada[i].noAsk, i + 1 < escada.length ? menorNoAsk[i + 1] : Infinity);
  }

  for (let i = 0; i < escada.length; i++) {
    const lo = escada[i];
    if (lo.yesAsk + menorNoAsk[i] >= 1) continue; // nenhum par a partir daqui fecha conta
    for (let j = i; j < escada.length; j++) {
      const hi = escada[j];
      if (lo.yesAsk + menorNoAsk[j] >= 1) break; // nem o melhor daqui pra frente serve
      if (i === j) continue; // ja coberto pela regra da mesma faixa
      const cost = lo.yesAsk + hi.noAsk;
      const fee = taxa(lo.yesAsk) + taxa(hi.noAsk);
      const profit = 1 - cost - fee;
      if (profit > 0.001) {
        out.push({
          type: 'par-de-faixas',
          label: '"vai passar" na faixa baixa + "não passa" na faixa alta por menos de $1',
          tickers: [lo.ticker, hi.ticker],
          detail: `comprar "vai passar" de $${lo.floorStrike.toFixed(0)} a $${lo.yesAsk.toFixed(2)} + "não passa" de $${hi.floorStrike.toFixed(0)} a $${hi.noAsk.toFixed(2)} = $${cost.toFixed(2)} (+taxa $${fee.toFixed(3)}), recebe no mínimo $1,00`,
          profitPerContract: profit,
          minPayoff: 1,
        });
      }
    }
  }

  return out.sort((a, b) => b.profitPerContract - a.profitPerContract).slice(0, 40);
}

// ---------- analise completa ----------

function analyze({ rawMarkets, spot, candles, config, validation = {}, now = Date.now() }) {
  // Nem toda aposta tem preco-alvo: "chega a 50k antes de 100k", por exemplo, nao tem
  // strike nenhum. Antes essas eram descartadas aqui e a tela ficava completamente vazia
  // ao escolher esse tipo de aposta. Agora elas entram normalmente — sem chance calculada,
  // mas com preco, movimento e book, que e o que existe de verdade nelas.
  const markets = rawMarkets.map(parseMarket).sort((a, b) => a.strike - b.strike);
  const active = markets.filter((m) => m.status === 'active');

  const closeTs = active.length ? new Date(active[0].closeTime).getTime() : now;
  const msToClose = Math.max(0, closeTs - now);
  const yearsToClose = msToClose / MS_PER_YEAR;
  const minutesToClose = msToClose / 60000;

  // Esta série pergunta o preço FINAL ou se o preço ENCOSTA num valor? Muda a conta toda.
  const contractModel = 'terminal';

  const pastCandles = (candles || []).filter(c => c.ts + 60000 <= now && c.ts >= now-config.model.volLookbackMinutes*60000);
  const volRealized = realizedVolAnnual(pastCandles, config.model.ewmaHalfLifeMinutes);
  const volImplied = impliedVolFit(active.filter(m=>contractSpec(config,m)), spot, contractModel, now, yearsToClose);

  const floor = config.model.volFloorAnnualPct / 100;
  const ceil = config.model.volCeilingAnnualPct / 100;

  // Quanto confiar na oscilacao medida no historico recente.
  //
  // A janela observada (volLookbackMinutes) descreve bem prazos parecidos com ela: para
  // uma aposta que fecha em 4 horas, medir as ultimas 12 horas faz todo sentido. Para uma
  // aposta que fecha daqui a 4 meses, essa mesma janela nao diz quase nada — e misturar
  // ela com peso fixo puxava a conta para baixo e criava vantagens falsas nos prazos
  // longos. Entao o peso do historico cai conforme o prazo passa da janela medida.
  const janelaAnos = (config.model.volLookbackMinutes || 720) / (365 * 24 * 60);
  const vezesMaior = janelaAnos > 0 ? yearsToClose / janelaAnos : Infinity;
  const wR = clamp(config.model.blendWeightRealized, 0, 1) / (1 + Math.max(0, vezesMaior - 1));

  let sigma;
  if (config.model.volSource === 'realized') sigma = volRealized || volImplied;
  else if (config.model.volSource === 'implied') sigma = volImplied || volRealized;
  else if (volRealized && volImplied) sigma = wR * volRealized + (1 - wR) * volImplied;
  else sigma = volRealized || volImplied || config.model.fallbackVolAnnual || 0.5;
  sigma = clamp(sigma, floor, ceil);

  const sigmaPeriod = sigma * Math.sqrt(Math.max(yearsToClose, 1e-9)); // desvio log ate o fechamento
  const sigmaDollars = spot * sigmaPeriod;

  // O retorno depende da taxa arredondada da ordem. Usa o capital atual como
  // tamanho de referencia (a tela da Kalshi compra fracoes de contrato); sem
  // capital informado, usa uma ordem de US$ 1,00.
  const capitalAtual = Number(config.capital && config.capital.atual);
  const capitalInicial = Number(config.capital && config.capital.inicial);
  const referenceBudget = Number.isFinite(capitalAtual) ? Math.max(0, capitalAtual) : 1;

  const rows = [];
  for (const m of active) {
    // Cada faixa tem o seu proprio prazo. Em series como "quando o BTC cruza $85k" as
    // faixas sao datas diferentes no mesmo evento, entao usar um prazo unico para todas
    // (o que este arquivo fazia antes) erra a conta em todas menos a primeira.
    const msFaixa = Math.max(0, Date.parse(m.closeTime) - now);
    const anosFaixa = msFaixa / MS_PER_YEAR;

    const spec = contractSpec(config,m);
    const probYes = spec && Number.isFinite(anosFaixa) ? modelProbForMarket(m, spot, sigma, anosFaixa, spec.model) : null;
    const modelSupported = probYes != null;
    const modelValidated = validation[m.kind]?.modelValidated === true;
    const modelConfiavel = modelSupported && modelValidated;
    // Sem modelo confiavel a analise nao inventa um numero: usa o proprio preco do
    // mercado, o que zera a vantagem e impede o robo de "achar" oportunidade falsa.
    const modelProbYes = modelSupported ? probYes : m.mid;
    const uncertainty = config.model.probabilityUncertainty ?? 0.1;

    // Mesma cotacao usada em "Diferenca" (m.strike), senao faixa mede distancia contra
    // um preco diferente do que a tela mostra ao lado.
    const sigmaFaixa=sigma*Math.sqrt(anosFaixa);
    const sigmaMoves = sigmaFaixa > 0 && m.strike > 0 ? Math.log(spot / m.strike) / sigmaFaixa : 0;
    const distancePct = m.strike > 0 ? (spot - m.strike) / spot : 0;

    const legs = ['yes', 'no'].map((side) => {
      const precoEntrada = side === 'yes' ? m.yesAsk : m.noAsk;
      const contracts = maxContractsForBudget(precoEntrada, referenceBudget, config.fees);
      const leg = evaluateLeg({
        side,
        market: m,
        modelProbYes,
        fees: config.fees,
        yearsToClose: anosFaixa,
        sizeContracts: contracts,
        capitalAtual,
        capitalInicial,
      });
      const stress=[sigma,volRealized,volImplied,sigma*(config.model.volStressLow ?? 0.75),sigma*(config.model.volStressHigh ?? 1.25)]
        .filter(v=>v>0).map(v=>modelSupported?modelProbForMarket(m,spot,v,anosFaixa,spec.model):modelProbYes)
        .map(p=>side==='yes'?p:1-p);
      leg.probabilityLower = Math.max(0,Math.min(...stress)-uncertainty);
      leg.probabilityUpper = Math.min(1,Math.max(...stress)+uncertainty);
      leg.conservativeEdge = leg.probabilityLower-leg.breakevenProb;
      leg.conservativeKelly = leg.maxGain > 0 ? clamp((leg.probabilityLower*leg.maxPayout-leg.orderCost)/leg.maxGain,0,1) : 0;
      const parts = {
        profit: profitScore(leg),
        safety: safetyScore(leg, m, sigmaMoves),
        liquidity: liquidityScore(m),
        kelly: leg.kelly,
      };
      const filtersFailed = [];
      if (m.volume < config.ranking.minVolume) filtersFailed.push('volume baixo');
      if (m.openInterest < config.ranking.minOpenInterest) filtersFailed.push('open interest baixo');
      if (m.yesSpread * 100 > config.ranking.maxSpreadCents) filtersFailed.push('spread largo');
      if (!leg.tradable) filtersFailed.push('sem preco negociavel');
      if (!modelSupported) filtersFailed.push('contrato sem regra explícita suportada');
      return Object.assign(leg, {
        scores: parts,
        score: compositeScore(parts, config.ranking),
        modelReliable: modelConfiavel,
        modelSupported, modelValidated,
        filtersFailed,
        eligible: filtersFailed.length === 0,
      });
    });

    rows.push({
      ...m,
      modelProbYes,
      modelReliable: modelConfiavel,
      modelSupported, modelValidated,
      msToClose: msFaixa,
      minutesToClose: msFaixa / 60000,
      sigmaMoves,
      distanceDollars: spot - m.strike,
      distancePct,
      legs,
      bestLeg: legs.slice().sort((a, b) => b.score - a.score)[0],
    });
  }

  const opportunities = [];
  for (const r of rows) {
    for (const leg of r.legs) {
      opportunities.push({
        ticker: r.ticker,
        strike: r.strike,
        subtitle: r.subtitle,
        kind: r.kind,
        modelReliable: r.modelReliable,
        modelSupported:r.modelSupported, modelValidated:r.modelValidated,
        eventTicker:r.eventTicker || config.eventTicker, status:r.status, rules:r.rules,
        closeTime:r.closeTime, msToClose:r.msToClose, minutesToClose:r.minutesToClose,
        probabilityLower:leg.probabilityLower, probabilityUpper:leg.probabilityUpper,
        conservativeEdge:leg.conservativeEdge, conservativeKelly:leg.conservativeKelly,
        side: leg.side,
        price: leg.price,
        impliedProb: leg.impliedProb,
        modelProb: leg.modelProb,
        edge: leg.edge,
        evPct: leg.evPct,
        evDollars: leg.evDollars,
        grossReturnPct: leg.grossReturnPct,
        winReturnPct: leg.winReturnPct,
        evPctCapital: leg.evPctCapital,
        winReturnPctCapital: leg.winReturnPctCapital,
        contracts: leg.contracts,
        orderCost: leg.orderCost,
        maxPayout: leg.maxPayout,
        maxGain: leg.maxGain,
        maxLoss: leg.maxLoss,
        kelly: leg.kelly,
        breakevenProb: leg.breakevenProb,
        feePerContract: leg.feePerContract,
        roundTripCost: leg.roundTripCost,
        maxLossPerContract: leg.maxLossPerContract,
        maxGainPerContract: leg.maxGainPerContract,
        volume: r.volume,
        openInterest: r.openInterest,
        spread: r.yesSpread,
        sigmaMoves: leg.side === 'yes' ? r.sigmaMoves : -r.sigmaMoves,
        distanceDollars: r.distanceDollars,
        scores: leg.scores,
        score: leg.score,
        eligible: leg.eligible,
        filtersFailed: leg.filtersFailed,
      });
    }
  }

  const eligible = opportunities.filter((o) => o.eligible);
  const safest = eligible.slice().sort((a, b) => b.scores.safety - a.scores.safety).slice(0, 12);
  const mostProfitable = eligible.slice().sort((a, b) => b.evPct - a.evPct).slice(0, 12);
  const bestOverall = eligible.slice().sort((a, b) => b.score - a.score).slice(0, 12);

  const arbitrage = findArbitrage(active, config.fees);

  // Curva de probabilidade agregada do mercado (distribuicao implicita)
  const distribution = rows.map((r) => ({
    strike: r.strike,
    kind: r.kind,
    marketProb: r.mid,
    modelProb: r.modelProbYes,
    volume: r.volume,
    openInterest: r.openInterest,
  }));

  // A curva acumulada so e decrescente na escada "X ou mais". Num evento de faixas
  // ("de X ate Y") cada preco ja e a propria probabilidade daquele intervalo.
  const escadaAcima = rows.filter((r) => r.kind === 'above').sort((a, b) => a.strike - b.strike);
  const faixas = rows.filter((r) => r.kind === 'range').sort((a, b) => a.strike - b.strike);
  const shape = escadaAcima.length >= 3 ? 'escada' : faixas.length >= 3 ? 'faixas' : 'outro';

  // Onde o mercado acha que o preco vai parar.
  //   escada: diferenca entre dois degraus vizinhos da curva acumulada
  //   faixas: o proprio preco de cada intervalo
  const density = [];
  if (shape === 'escada') {
    for (let i = 0; i < escadaAcima.length - 1; i++) {
      const a = escadaAcima[i], b = escadaAcima[i + 1];
      const width = b.strike - a.strike;
      if (width > 0) density.push({ strike: (a.strike + b.strike) / 2, prob: Math.max(0, a.mid - b.mid), width });
    }
  } else if (shape === 'faixas') {
    for (const r of faixas) {
      density.push({ strike: r.strike, prob: Math.max(0, r.mid), width: Math.max(0, r.capStrike - r.floorStrike) });
    }
  }

  const totals = {
    markets: rows.length,
    totalVolume: rows.reduce((s, r) => s + r.volume, 0),
    totalOpenInterest: rows.reduce((s, r) => s + r.openInterest, 0),
    liveMarkets: rows.filter((r) => r.yesBid > 0 && r.yesAsk > 0).length,
    // Media do spread apenas sobre mercados com book dos dois lados; os demais distorceriam a media.
    avgSpreadCents: (() => {
      const live = rows.filter((r) => r.yesBid > 0 && r.yesAsk > 0);
      return live.length ? (live.reduce((s, r) => s + r.yesSpread, 0) / live.length) * 100 : 0;
    })(),
    opportunitiesEligible: eligible.length,
    positiveEvCount: eligible.filter((o) => o.evPct > 0).length,
    modelReliable: rows.length ? rows.every((r) => r.modelReliable) : false,
  };

  // Preco mais provavel segundo o mercado.
  //   escada: onde a curva acumulada cruza os 50%
  //   faixas: media dos centros das faixas, ponderada pela chance de cada uma
  const impliedMedian = (() => {
    if (shape === 'escada') {
      for (let i = 0; i < escadaAcima.length - 1; i++) {
        const a = escadaAcima[i], b = escadaAcima[i + 1];
        if (a.mid >= 0.5 && b.mid < 0.5) {
          const t = (a.mid - 0.5) / (a.mid - b.mid);
          return a.strike + t * (b.strike - a.strike);
        }
      }
      return null;
    }
    if (shape === 'faixas') {
      let pesoTotal = 0, soma = 0;
      for (const r of faixas) {
        if (r.mid > 0) { soma += r.strike * r.mid; pesoTotal += r.mid; }
      }
      return pesoTotal > 0 ? soma / pesoTotal : null;
    }
    return null;
  })();

  return {
    generatedAt: new Date(now).toISOString(),
    modelVersion: MODEL_VERSION, modelKey: modelKey(config), validation,
    event: {
      ticker: config.eventTicker,
      closeTime: active.length ? active[0].closeTime : null,
      msToClose,
      minutesToClose,
      title: active.length ? active[0].title : config.eventTicker,
      rules: active.length ? active[0].rules : '',
      shape,
      contractModel,
      referenceBudget,
    },
    spot,
    vol: {
      realizedAnnual: volRealized,
      impliedAnnual: volImplied,
      usedAnnual: sigma,
      sigmaPeriod,
      sigmaDollars,
      source: config.model.volSource,
    },
    impliedMedian,
    totals,
    rows,
    opportunities,
    safest,
    mostProfitable,
    bestOverall,
    arbitrage,
    distribution,
    density,
  };
}

module.exports = {
  analyze,
  parseMarket,
  classifyStrike,
  modelProbForMarket,
  evaluateLeg,
  detectContractModel,
  probAbove,
  probTouchUp,
  probTouchDown,
  realizedVolAnnual,
  impliedVolFit,
  tradingFeeDollars,
  orderCostDollars,
  maxContractsForBudget,
  normCdf,
  quantile,
  clamp,
};
