'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  analysis: null,
  auto: null,
  config: null,
  btc: null,
  conectado: false,
  recebidoEm: 0,
  capital: null, // { inicial, atual, fator } — fator = atual/inicial, aplicado a toda estatística de dinheiro da tela
};

// Como cada tipo de aposta aparece para o usuario.
const LADO = { yes: 'VAI PASSAR', no: 'NÃO PASSA' };

// ---------- formatadores ----------
const money = (v, d = 2) => (v == null || !isFinite(v) ? '—' : 'US$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%');
const sig = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
const num = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('pt-BR'));
const contratos = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const alvo = (v) => 'US$ ' + Math.round(v).toLocaleString('pt-BR');

// Em que condição a faixa paga. A Kalshi tem quatro formatos e cada um ganha numa
// situação diferente — dizer "acima de X" em todos, como esta tela fazia antes,
// descreve errado as faixas "de X até Y" e "abaixo de X".
function descreveFaixa(r, a) {
  const encostar = a && a.event && a.event.contractModel === 'touch';
  if (r.kind === 'range') return `entre ${alvo(r.floorStrike)} e ${alvo(r.capStrike)}`;
  if (r.kind === 'below') return encostar ? `chega a cair até ${alvo(r.capStrike)}` : `abaixo de ${alvo(r.capStrike)}`;
  if (r.kind === 'above') return encostar ? `chega a encostar em ${alvo(r.floorStrike)}` : `acima de ${alvo(r.floorStrike)}`;
  return r.subtitle || 'condição especial';
}

// Título curto da faixa. Numa aposta sem preço-alvo (ex: "50.000 primeiro") o texto da
// própria Kalshi é a única descrição que existe.
function tituloFaixa(r) {
  if (r.kind === 'unknown') return r.subtitle || r.ticker;
  if (r.kind === 'range') return `${alvo(r.floorStrike)} a ${alvo(r.capStrike)}`;
  return alvo(r.strike);
}

// A pergunta que a aposta responde. Muda conforme o formato do contrato: as de preço
// final olham onde o Bitcoin PARA, e as de encostar olham se ele PASSA por um valor em
// algum momento — dizer "encerra acima de" nas duas, como esta tela fazia, descreve
// errado metade das apostas de Bitcoin da Kalshi.
function perguntaFaixa(r, a) {
  const encostar = a && a.event && a.event.contractModel === 'touch';
  if (r.kind === 'unknown') return `Esta aposta paga se: ${r.subtitle || 'condição própria da Kalshi'}.`;
  if (encostar) {
    if (r.kind === 'above') return `O Bitcoin chega a encostar em ${alvo(r.floorStrike)} em algum momento até o encerramento?`;
    if (r.kind === 'below') return `O Bitcoin chega a cair até ${alvo(r.capStrike)} em algum momento até o encerramento?`;
  }
  if (r.kind === 'range') return `O Bitcoin encerra entre ${alvo(r.floorStrike)} e ${alvo(r.capStrike)}?`;
  if (r.kind === 'below') return `O Bitcoin encerra abaixo de ${alvo(r.capStrike)}?`;
  return `O Bitcoin encerra acima de ${alvo(r.floorStrike)}?`;
}
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim');
const pontos = (v) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1).replace('.', ',') + ' pontos');

function fmtDuration(ms) {
  if (ms <= 0) return 'encerrado';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + 'h ' : '') + m + 'min ' + String(ss).padStart(2, '0') + 's';
}

function scoreBar(v, color) {
  const w = Math.max(0, Math.min(100, v));
  return `<div class="bar"><i style="width:${w}%;background:${color};opacity:.35"></i><b>${v.toFixed(0)}</b></div>`;
}

// Traduz os motivos tecnicos de recusa para linguagem do dia a dia.
function traduzMotivo(m) {
  return m
    .replace(/reprovado nos filtros de liquidez\/spread/i, 'pouca gente negociando ou preços muito distantes')
    .replace(/edge ([\d.,]+)% < minimo ([\d.,]+)%/i, 'vantagem de apenas $1 pontos (o mínimo pedido é $2)')
    .replace(/prob modelo ([\d.,]+)% < minimo ([\d.,]+)%/i, 'chance de $1 (o mínimo pedido é $2)')
    .replace(/score ([\d.,]+) < minimo ([\d.,]+)/i, 'nota $1 (a mínima pedida é $2)')
    .replace(/EV nao positivo apos taxas/i, 'não compensa depois das taxas')
    .replace(/lado (\w+) nao permitido/i, 'esse tipo de aposta está bloqueado nos ajustes')
    .replace(/faltam (\d+)s para o fechamento \(minimo (\d+)s\)/i, 'falta pouco tempo para encerrar ($1 segundos)')
    .replace(/fechamento distante demais \((\d+)s > (\d+)s\)/i, 'ainda falta muito tempo para encerrar')
    .replace(/limite de (\d+) ordens\/hora atingido/i, 'já apostou $1 vezes nesta hora')
    .replace(/cooldown ativo neste mercado \((\d+)s restantes\)/i, 'já apostou nessa faixa há pouco (espera de $1 segundos)')
    .replace(/exposicao total ja em US\$ ([\d.,]+) \(teto US\$ ([\d.,]+)\)/i, 'já colocou US$ $1 do limite de US$ $2')
    .replace(/tamanho calculado abaixo de 1 contrato/i, 'o valor daria menos de um contrato')
    .replace(/nenhum candidato passou nas travas/i, 'nenhuma aposta passou nos limites de segurança')
    .replace(/modo automatico desligado/i, 'o modo automático está desligado')
    .replace(/credenciais Kalshi ausentes.*/i, 'a conta da Kalshi não está cadastrada');
}

// ---------- busca de dados ----------
async function api(path, opts) {
  let r;
  try {
    r = await fetch(path, opts);
  } catch (_) {
    throw new Error('o servidor não respondeu — ele ainda está rodando?');
  }

  // Nem toda resposta é JSON: um 404 do servidor de arquivos volta como texto puro.
  // Tentar ler isso como JSON explodia com uma mensagem sem sentido para quem lê a tela
  // ("Unexpected token 'p'"), escondendo o problema real.
  const texto = await r.text();
  let j = null;
  try {
    j = texto ? JSON.parse(texto) : null;
  } catch (_) {
    if (!r.ok) {
      throw new Error(
        r.status === 404
          ? `o servidor não conhece "${path}" (HTTP 404) — provavelmente ele está rodando uma versão antiga do código; reinicie o servidor`
          : `o servidor respondeu ${r.status} sem ser JSON: ${texto.slice(0, 120)}`
      );
    }
    throw new Error('o servidor respondeu num formato inesperado');
  }

  if (!r.ok) throw new Error((j && j.error) || `o servidor respondeu ${r.status}`);
  return j;
}

// O servidor mantém uma conexão aberta e empurra cada atualização assim que ela acontece.
// A tela nunca fica perguntando por dados novos.
function conectarAoVivo() {
  const es = new EventSource('/api/stream');

  es.onopen = () => {
    state.conectado = true;
    $('#liveDot').classList.remove('stale');
  };

  es.addEventListener('unavailable', (e) => {
    state.analysis = null;
    document.body.classList.add('chart-unavailable');
    state.btc = null;
    $('#spot').textContent = '—';
    $('#spotSource').textContent = 'Gráfico da aposta indisponível';
    $('#liveDot').classList.add('stale');
    $('#liveDetail').textContent = JSON.parse(e.data).message;
    $('#chartBtc').innerHTML = '';
  });
  es.onmessage = (e) => {
    document.body.classList.remove('chart-unavailable');
    state.analysis = prepararDados(JSON.parse(e.data));
    state.recebidoEm = performance.now();
    state.conectado = true;
    const dot = $('#liveDot');
    dot.classList.remove('stale', 'pulse');
    void dot.offsetWidth; // reinicia a animação
    dot.classList.add('pulse');
    render();
  };

  es.onerror = () => {
    state.conectado = false;
    $('#liveDot').classList.add('stale');
    $('#liveLabel').textContent = 'reconectando...';
    $('#liveDetail').textContent = 'o servidor caiu ou está reiniciando';
    // O EventSource reconecta sozinho.
  };
}

// O servidor manda só as faixas de preço. A lista completa de apostas, as listas de
// melhores e os dados dos gráficos são montados aqui, para o envio ficar pequeno e chegar
// rápido. É a mesma conta — só muda quem monta.
function prepararDados(a) {
  a.opportunities = [];
  for (const r of a.rows) {
    r.bestScore = Math.max(...r.legs.map((l) => l.score));
    for (const l of r.legs) {
      a.opportunities.push({
        ticker: r.ticker,
        strike: r.strike,
        kind: r.kind,
        floorStrike: r.floorStrike,
        capStrike: r.capStrike,
        subtitle: r.subtitle,
        modelReliable: r.modelReliable, modelSupported:r.modelSupported, modelValidated:r.modelValidated,
        probabilityLower:l.probabilityLower,probabilityUpper:l.probabilityUpper,
        side: l.side,
        price: l.price,
        impliedProb: l.price,
        modelProb: l.modelProb,
        edge: l.edge,
        evPct: l.evPct,
        evDollars: l.evDollars,
        grossReturnPct: l.grossReturnPct,
        winReturnPct: l.winReturnPct,
        evPctCapital: l.evPctCapital,
        winReturnPctCapital: l.winReturnPctCapital,
        contracts: l.contracts,
        orderCost: l.orderCost,
        maxPayout: l.maxPayout,
        maxGain: l.maxGain,
        maxLoss: l.maxLoss,
        entryCostPerContract: l.entryCostPerContract,
        maxPayoutPerContract: l.maxPayoutPerContract,
        maxGainPerContract: l.maxGainPerContract,
        maxLossPerContract: l.maxLossPerContract,
        kelly: l.kelly,
        breakevenProb: l.breakevenProb,
        feePerContract: l.feePerContract,
        roundTripCost: l.roundTripCost,
        volume: r.volume,
        openInterest: r.openInterest,
        spread: r.yesSpread,
        sigmaMoves: l.side === 'yes' ? r.sigmaMoves : -r.sigmaMoves,
        scores: { safety: l.safety, liquidity: l.liquidity },
        score: l.score,
        eligible: l.eligible,
        filtersFailed: l.filtersFailed,
      });
    }
  }

  const aprovadas = a.opportunities.filter((o) => o.eligible);
  const melhores = (campo) => aprovadas.slice().sort((x, y) => campo(y) - campo(x)).slice(0, 12);
  a.safest = melhores((o) => o.scores.safety);
  a.mostProfitable = melhores((o) => o.evPct);
  a.bestOverall = melhores((o) => o.score);

  // Dados dos gráficos: chance do mercado e chance calculada em cada faixa...
  a.distribution = a.rows.map((r) => ({ strike: r.strike, kind: r.kind, marketProb: r.mid, modelProb: r.modelProbYes }));

  // ...e onde o mercado acha que o preço vai parar. A conta muda conforme o formato do
  // evento: numa escada "X ou mais" o preço é acumulado (a chance de cada intervalo é a
  // diferença entre dois degraus), enquanto num evento de faixas "de X até Y" o preço de
  // cada faixa já é a chance daquele intervalo.
  const escada = a.rows.filter((r) => r.kind === 'above').sort((x, y) => x.strike - y.strike);
  const faixas = a.rows.filter((r) => r.kind === 'range').sort((x, y) => x.strike - y.strike);
  a.density = [];
  if (escada.length >= 3) {
    for (let i = 0; i < escada.length - 1; i++) {
      const x = escada[i], y = escada[i + 1];
      if (y.strike > x.strike) a.density.push({ strike: (x.strike + y.strike) / 2, prob: Math.max(0, x.mid - y.mid) });
    }
  } else if (faixas.length >= 3) {
    for (const r of faixas) a.density.push({ strike: r.strike, prob: Math.max(0, r.mid) });
  }
  return a;
}

async function atualizarRobo() {
  try {
    state.auto = await api('/api/auto/status');
    renderAuto();
  } catch (_) {}
}

// ---------- tela principal ----------
function render() {
  const a = state.analysis;
  if (!a) return;

  $('#eventTicker').textContent = a.event.ticker;
  $('#selectedEvent').textContent = a.event.title || 'Bitcoin · ' + a.event.ticker;
  const hasMarkets = a.rows.length > 0;
  const hasClose = a.event.closeTime && Number.isFinite(new Date(a.event.closeTime).getTime());
  $('#marketEmpty').classList.toggle('hidden', hasMarkets);

  // Deixa explícito o formato do contrato, porque ele muda o significado de tudo o que
  // aparece na tela (e a conta por trás).
  const FORMATO = { escada: 'acima/abaixo de um preço', faixas: 'faixas de preço', outro: 'formato próprio' };
  $('#tipoAposta').textContent = a.event.contractModel === 'touch' ? 'encostar no preço' : 'preço no encerramento';
  $('#tipoApostaDetalhe').textContent = FORMATO[a.event.shape] || '';

  $('#spot').textContent = alvo(a.spot);
  $('#spotSource').textContent = 'fonte: ' + (a.spotSource || '') + ' · idade: ' + Math.max(0,(Date.now()-a.spotUpdatedAt)/1000).toFixed(1) + ' s';
  $('#closeTime').textContent = hasClose ? new Date(a.event.closeTime).toLocaleString('pt-BR') : 'Horário indisponível';
  $('#volUsed').textContent = pct(a.vol.usedAnnual, 0);
  $('#volDetail').textContent = `medida agora ${pct(a.vol.realizedAnnual, 0)} · esperada pelo mercado ${pct(a.vol.impliedAnnual, 0)}`;
  $('#impliedMedian').textContent = a.impliedMedian ? alvo(a.impliedMedian) : '—';
  $('#sigmaDollars').textContent = '± ' + alvo(a.vol.sigmaDollars);

  // A explicação muda conforme o formato do evento escolhido. Antes o texto era fixo
  // ("onde o preço vai estar"), o que descrevia errado as apostas de encostar e as de faixa.
  const horas = (a.event.minutesToClose / 60).toFixed(1).replace('.', ',');
  const quando = new Date(a.event.closeTime).toLocaleString('pt-BR');
  const encostar = a.event.contractModel === 'touch';
  const oQuePergunta = encostar
    ? `se o Bitcoin <strong>chega a encostar</strong> em certos valores em algum momento até ${quando}`
    : a.event.shape === 'faixas'
      ? `<strong>em qual faixa de preço</strong> o Bitcoin vai encerrar em ${quando}`
      : `<strong>onde o preço do Bitcoin vai estar</strong> em ${quando}`;

  $('#howItWorks').innerHTML =
    `Esta aposta é sobre ${oQuePergunta} (daqui a ${horas} horas). ` +
    `Cada linha tem duas pontas: <strong>vai passar</strong> (a condição acontece) e ` +
    `<strong>não passa</strong> (não acontece). ` +
    `Cada contrato custa entre US$ 0,01 e US$ 0,99 e vale <strong>US$ 1,00 se você acertar</strong> ou ` +
    `<strong>zero se errar</strong>. O preço é a própria chance: pagar US$ 0,70 é o mercado dizendo que há 70% de chance. ` +
    `O Bitcoin está agora em ${alvo(a.spot)} e costuma variar cerca de ${alvo(a.vol.sigmaDollars)} para cima ou para baixo até o encerramento.` +
    (encostar
      ? ` <strong>Atenção:</strong> aqui basta o preço tocar o valor uma vez — não precisa terminar lá. Por isso a chance é maior do que a de encerrar naquele nível.`
      : '');

  $('#rulesPt').textContent = encostar
    ? `O resultado olha o maior (ou o menor) preço que o Bitcoin atingiu durante todo o período, ` +
      `pelo índice BRTI da CF Benchmarks — não o preço de uma corretora específica. ` +
      `Basta encostar no valor uma única vez para quem apostou em "vai passar" receber US$ 1,00 por contrato.`
    : `O resultado sai da média do preço do Bitcoin nos sessenta segundos antes do horário de encerramento, ` +
      `usando o índice BRTI da CF Benchmarks — não o preço de uma corretora específica. ` +
      `Se essa média cair dentro da condição da faixa, quem apostou em "vai passar" recebe US$ 1,00 por contrato.`;
  $('#rules').textContent = 'Texto original da Kalshi: ' + a.event.rules;
  if (!hasMarkets) {
    $('#tipoAposta').textContent = '—';
    $('#tipoApostaDetalhe').textContent = 'Sem faixas para analisar';
    $('#sigmaDollars').textContent = '—';
    $('#howItWorks').textContent = 'Selecione um evento com faixas disponíveis para consultar as condições dos contratos e as regras de resolução.';
    $('#rulesPt').textContent = '';
    $('#rules').textContent = '';
  }

  $('#lastUpdate').textContent =
    'última mudança de preço às ' + new Date(a.generatedAt).toLocaleTimeString('pt-BR') + ` · ${a.totals.markets} faixas de preço`;

  // Aviso quando a conta não vale para esta aposta. O modelo usado aqui projeta o PREÇO
  // do Bitcoin no fechamento; apostas como "chega a 50k antes de 100k" ou "quando cruza
  // 85k" dependem do caminho até lá, não só do valor final, e não têm chance calculável
  // por este modelo. Nesse caso a tela mostra só os dados do mercado, sem vantagem.
  const semModelo = a.rows.filter((r) => r.modelSupported === false).length;
  const aviso = $('#avisoModelo');
  if (semModelo) {
    aviso.classList.remove('hidden');
    aviso.textContent = semModelo + ' faixas sem regra/modelo suportados. Sugestões e ordens bloqueadas nessas faixas.';
  } else if(a.rows.some(r=>!r.modelValidated)) {
    aviso.classList.remove('hidden');
    aviso.textContent = 'Modelo em avaliação: fórmula disponível, sem evidência histórica suficiente. Apenas paper trading; dinheiro real bloqueado. Intervalo exibido é de sensibilidade, não confiança estatística.';
  } else { aviso.classList.add('hidden'); aviso.textContent=''; }

  renderPainelVisivel();
}

// Só desenha a aba que está na tela — assim as atualizações chegam rápido sem pesar.
// As tabelas são redesenhadas no máximo uma vez por segundo, para dar tempo de ler e clicar.
let ultimoDesenhoPesado = 0;
let desenhoAgendado = null;
const abaAtual = () => (document.querySelector('.tab.active') || {}).dataset?.tab || 'resumo';

function renderPainelVisivel(forcar) {
  if (!state.analysis) return;
  const agora = performance.now();
  const espera = Math.max(0, 1000 - (agora - ultimoDesenhoPesado));
  if (espera > 0 && !forcar) {
    if (!desenhoAgendado) desenhoAgendado = setTimeout(() => { desenhoAgendado = null; renderPainelVisivel(true); }, espera);
    return;
  }
  clearTimeout(desenhoAgendado);
  desenhoAgendado = null;
  ultimoDesenhoPesado = agora;

  const aba = abaAtual();
  if (aba === 'resumo') {
    renderSummary();
    renderRanking();
    if ($('#marketQuotes').open) renderMarkets();
    if ($('#marketCharts').open) renderCharts();
    if ($('#marketArbitrage').open) renderArb();
  }
}

function tickCountdown() {
  const a = state.analysis;
  if (!a) return;
  const close = a.event.closeTime && new Date(a.event.closeTime).getTime();
  $('#countdown').textContent = close && Number.isFinite(close) ? fmtDuration(close - Date.now()) : '—';

  // Mostra há quanto tempo cada fonte de dado falou pela última vez.
  const desdeRecebido = state.recebidoEm ? (performance.now() - state.recebidoEm) / 1000 : null;
  const l = a.live || {};
  if (state.conectado) {
    $('#liveLabel').textContent = desdeRecebido != null && desdeRecebido < 3 ? 'recebendo agora' : 'conectado';
    $('#liveDetail').textContent =
      `Bitcoin ${(l.spotAgeMs / 1000).toFixed(1).replace('.', ',')}s · ` +
      `Kalshi a cada ${(l.pollIntervalMs / 1000).toFixed(2).replace('.', ',')}s (resposta em ${l.kalshiLatencyMs} ms)`;
  }
}
setInterval(tickCountdown, 500);

// ---------- RESUMO ----------
function renderSummary() {
  const a = state.analysis;
  const t = a.totals;
  const cards = [
    { l: 'Faixas disponíveis', v: t.markets, s: t.opportunitiesEligible + ' oportunidades com liquidez' },
    { l: 'Retorno esperado positivo', v: t.positiveEvCount, s: 'estimativa após taxas' },
    { l: 'Diferença compra/venda', v: sig(t.avgSpreadCents) + ' ¢', s: 'média do evento' },
  ];
  $('#summaryCards').innerHTML = cards.map(c => `<div class="kpi"><label>${c.l}</label><strong>${c.v}</strong><span>${c.s}</span></div>`).join('');
  $('#arbCount').textContent = a.arbitrage.length;

}

// ---------- MELHORES APOSTAS ----------
const COL_AJUDA = {
  alvo: 'O preço de referência da aposta.',
  tipo: 'Vai passar = o Bitcoin encerra acima do preço-alvo. Não passa = encerra abaixo.',
  custo: 'Custo efetivo da ordem de referência: preço dos contratos mais a taxa da Kalshi.',
  mercado: 'A chance que o mercado dá. É o próprio preço em porcentagem.',
  conta: 'A chance calculada aqui, com base no preço atual, no tempo que falta e na oscilação do Bitcoin.',
  vantagem: 'Chance calculada menos chance do mercado. Quanto maior, mais barata está a aposta.',
  equilibrio: 'Chance mínima de acerto para não sair no prejuízo, já com a taxa.',
  retorno: 'Quanto rende em média cada real gasto, já descontando a taxa, se você repetisse essa aposta muitas vezes.',
  ganho: 'Ganho médio em dinheiro por contrato.',
  paga: 'Retorno líquido sobre o custo total se a aposta der certo, já descontando a taxa de entrada.',
  retornoCapital: 'Retorno esperado desta aposta composto com a valorização já acumulada do seu capital: novo saldo acumulado se a expectativa se confirmar.',
  pagaCapital: 'Saldo acumulado (capital inicial → atual → esta aposta) se você ganhar, em % composta sobre o capital total.',
  perde: 'Quanto você perde por contrato se errar. É sempre tudo.',
  quanto: 'Fatia do seu dinheiro que a matemática indicaria para essa aposta.',
  distancia: 'Quantas oscilações normais o Bitcoin precisa andar para chegar no preço-alvo.',
  diferenca: 'Diferença entre quem compra e quem vende. Quanto menor, mais fácil sair da aposta.',
  negociados: 'Contratos já negociados nesta faixa.',
  abertos: 'Contratos ainda de pé nesta faixa.',
  seguranca: 'Nota de 0 a 100 juntando chance de acerto, folga e movimento do mercado.',
  nota: 'Nota geral de 0 a 100 misturando retorno, segurança e movimento.',
  situacao: 'Se a aposta passou nos filtros mínimos de movimento do mercado.',
};

function th(label, key) {
  return `<th title="${COL_AJUDA[key]}">${label}</th>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

Object.assign(COL_AJUDA, {
  alvo: 'Condição definida pelo contrato. SIM aposta que ela acontece; NÃO aposta que ela não acontece.',
  tipo: 'SIM e NÃO se referem à condição do contrato, conforme as regras de liquidação do evento.',
  ganho: 'Lucro ou prejuízo esperado para a ordem inteira, em dólares, após a taxa de entrada estimada.',
  perde: 'Perda máxima da ordem na liquidação: todo o custo de entrada, incluindo a taxa estimada.',
  quantidade: 'Quantidade de contratos da ordem de referência usada nos cálculos.',
  lucroOrdem: 'Lucro líquido da ordem se vencer na liquidação: pagamento menos custo e taxa de entrada estimada.',
  situacao: 'Resultado dos filtros de volume, contratos em aberto, spread, preço e disponibilidade do modelo. Não garante execução nem lucro.',
});

function renderRanking() {
  const a = state.analysis;
  if (!a) return;
  const sortKey = $('#rankSort').value;
  const sideF = $('#rankSide').value;
  const onlyEl = $('#onlyEligible').checked;
  const onlyEv = $('#onlyPositiveEv').checked;

  let rows = a.opportunities.filter((o) => o.price > 0 && o.price < 1);
  if (sideF !== 'all') rows = rows.filter((o) => o.side === sideF);
  if (onlyEl) rows = rows.filter((o) => o.eligible);
  if (onlyEv) rows = rows.filter((o) => o.evPct > 0);

  const get = (o) => (sortKey === 'safety' ? o.scores.safety : o[sortKey]);
  rows.sort((x, y) => get(y) - get(x));

  $('#rankCount').textContent = `${rows.length} apostas na lista`;

  const head = `<thead><tr>
    ${th('Condição do contrato', 'alvo')}${th('Lado', 'tipo')}${th('Custo / perda máxima', 'custo')}
    ${th('Preço implícito (%)', 'mercado')}${th('Chance estimada', 'conta')}${th('Vantagem', 'vantagem')}
    ${th('Chance de equilíbrio', 'equilibrio')}${th('Retorno esperado', 'retorno')}${th('Lucro esperado (US$)', 'ganho')}
    ${th('Retorno se ganhar', 'paga')}${th('Retorno esperado (capital)', 'retornoCapital')}${th('Se ganhar (capital)', 'pagaCapital')}
    ${th('Perde se errar', 'perde')}${th('Quanto apostar', 'quanto')}
    ${th('Distância', 'distancia')}${th('Diferença', 'diferenca')}${th('Negociados', 'negociados')}
    ${th('Em aberto', 'abertos')}${th('Segurança', 'seguranca')}${th('Nota', 'nota')}${th('Filtros', 'situacao')}${th('Contratos', 'quantidade')}${th('Lucro se ganhar', 'lucroOrdem')}
  </tr></thead>`;

  const body = rows
    .map((o) => {
      const st = o.eligible
        ? '<span class="pill yes">Passou nos filtros</span>'
        : `<span class="pill warn" title="${escapeHtml(o.filtersFailed.map(traduzMotivo).join(', '))}">Ver restrições</span>`;
      const market = a.rows.find((m) => m.ticker === o.ticker);
      const condition = market ? descreveFaixa(market, a) : (o.subtitle || alvo(o.strike));
      return `<tr>
      <td>${escapeHtml(condition)}</td>
      <td><span class="pill ${o.side}">${o.side === 'yes' ? 'SIM' : 'NÃO'}</span></td>
      <td>${money(o.orderCost)}</td>
      <td>${pct(o.impliedProb)}</td>
      <td title="Intervalo de sensibilidade: ${pct(o.probabilityLower)} a ${pct(o.probabilityUpper)}"><strong>${o.modelSupported === false ? 'Sem modelo' : (o.modelProb > 0.9995 && o.modelProb < 1 ? '>99,9%' : pct(o.modelProb))}</strong>${o.modelSupported ? `<small class="muted">${pct(o.probabilityLower)}–${pct(o.probabilityUpper)} · ${o.modelValidated ? 'validado' : 'em avaliação'}</small>` : ''}</td>
      <td class="${cls(o.edge)}">${pontos(o.edge)}</td>
      <td>${pct(o.breakevenProb)}</td>
      <td class="${cls(o.evPct)}"><strong>${pct(o.evPct)}</strong></td>
      <td class="${cls(o.evDollars)}">${money(o.evDollars, 3)}</td>
      <td>${pct(o.winReturnPct, 1)}</td>
      <td class="${cls(o.evPctCapital)}">${pct(o.evPctCapital, 1)}</td>
      <td>${pct(o.winReturnPctCapital, 1)}</td>
      <td class="neg">${money(-o.maxLoss)}</td>
      <td>${pct(o.kelly, 0)}</td>
      <td>${sig(Math.abs(o.sigmaMoves))}</td>
      <td>${(o.spread * 100).toFixed(0)} c</td>
      <td>${num(o.volume)}</td>
      <td>${num(o.openInterest)}</td>
      <td>${scoreBar(o.scores.safety, 'var(--green)')}</td>
      <td>${scoreBar(o.score, 'var(--blue)')}</td>
      <td>${st}</td>
      <td>${contratos(o.contracts)}</td>
      <td class="${cls(o.maxGain)}">${money(o.maxGain)}</td>
    </tr>`;
    })
    .join('');

  $('#rankTable').innerHTML = head + '<tbody>' + (body || '<tr><td colspan="23" class="empty-state">Nenhum contrato para estes filtros. Ajuste os filtros ou selecione outro mercado.</td></tr>') + '</tbody>';
}

// ---------- TODAS AS FAIXAS ----------
function renderMarkets() {
  const a = state.analysis;
  if (!a) return;
  const f = $('#filterStrike').value.trim().replace(/\D/g, '');
  const hideDead = $('#hideDead').checked;
  let rows = a.rows;
  if (f) rows = rows.filter((r) => String(Math.round(r.strike)).includes(f));
  if (hideDead) rows = rows.filter((r) => r.yesBid > 0 || r.volume > 0);

  $('#marketCount').textContent = `${rows.length} faixas`;

  const head = `<thead><tr>
    ${th('Preço-alvo', 'alvo')}<th>Descrição</th>
    <th title="Melhor oferta de quem quer comprar a aposta &quot;vai passar&quot;">Passa: compra</th>
    <th title="Melhor oferta de quem quer vender a aposta &quot;vai passar&quot;. É o que você paga.">Passa: venda</th>
    <th title="Melhor oferta de quem quer comprar a aposta &quot;não passa&quot;">Não passa: compra</th>
    <th title="É o que você paga para apostar em &quot;não passa&quot;">Não passa: venda</th>
    <th title="Preço do último negócio fechado">Último</th><th title="Variação desde o negócio anterior">Variação</th>
    ${th('Chance do mercado', 'mercado')}${th('Chance calculada', 'conta')}${th('Vantagem', 'vantagem')}
    <th title="Diferença em dólares entre o preço de agora e o preço-alvo">Falta</th>
    ${th('Distância', 'distancia')}${th('Diferença', 'diferenca')}${th('Negociados', 'negociados')}${th('Em aberto', 'abertos')}
    <th title="A aposta com a melhor nota nesta faixa">Melhor aposta</th>${th('Nota', 'nota')}
  </tr></thead>`;

  const body = rows
    .map((r) => {
      return `<tr class="clickable" data-ticker="${r.ticker}">
      <td><strong>${alvo(r.strike)}</strong></td>
      <td class="dim">${descreveFaixa(r, a)}</td>
      <td>${money(r.yesBid)}</td><td>${money(r.yesAsk)}</td>
      <td>${money(r.noBid)}</td><td>${money(r.noAsk)}</td>
      <td>${money(r.last)}</td>
      <td class="${cls(r.change)}">${r.change ? (r.change * 100).toFixed(0) + ' c' : '—'}</td>
      <td>${pct(r.mid)}</td>
      <td>${pct(r.modelProbYes)}</td>
      <td class="${cls(r.modelProbYes - r.mid)}">${pontos(r.modelProbYes - r.mid)}</td>
      <td class="${cls(r.distanceDollars)}">${money(r.distanceDollars, 0)}</td>
      <td>${sig(Math.abs(r.sigmaMoves))}</td>
      <td>${(r.yesSpread * 100).toFixed(0)} c</td>
      <td>${num(r.volume)}</td><td>${num(r.openInterest)}</td>
      <td><span class="pill ${r.bestSide}">${LADO[r.bestSide]}</span></td>
      <td>${scoreBar(r.bestScore, 'var(--blue)')}</td>
    </tr>`;
    })
    .join('');

  const table = $('#marketTable');
  table.innerHTML = head + '<tbody>' + (body || '<tr><td colspan="18" class="empty-state">Nenhuma faixa encontrada. Experimente outro preço-alvo ou evento.</td></tr>') + '</tbody>';
  table.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => showMarketDetail(tr.dataset.ticker)));
}

// ---------- ESCOLHER APOSTA (busca sob demanda, so quando o seletor esta aberto) ----------
let boardFreq = 'all';
let boardBusca = '';
let boardCarregando = false;
let boardErro = null;

function abrirPicker() {
  $('#pickerOverlay').classList.remove('hidden');
  renderBoard();
  // So busca de novo se nunca buscou ou se os dados ja estao velhos (mais de 1 minuto).
  if (!state.board || !state.board.updatedAt || Date.now() - state.board.updatedAt > 60000) carregarBoard();
}

function fecharPicker() {
  $('#pickerOverlay').classList.add('hidden');
}

$('#openPicker').addEventListener('click', abrirPicker);
$('#closePicker').addEventListener('click', fecharPicker);
$('#pickerOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'pickerOverlay') fecharPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#pickerOverlay').classList.contains('hidden')) fecharPicker();
});
$('#pickerSearch').addEventListener('input', (e) => {
  boardBusca = e.target.value.trim().toLowerCase();
  renderBoard();
});

// Varrer todas as series de Bitcoin na Kalshi demora alguns segundos (são ~45 séries).
// Por isso só roda quando a pessoa abre o seletor, nunca em segundo plano sem parar.
async function carregarBoard() {
  boardCarregando = true;
  boardErro = null;
  renderBoard();
  try {
    state.board = await api('/api/btc-board');
    if (state.board.error && !state.board.groups.length) boardErro = state.board.error;
  } catch (e) {
    boardErro = e.message;
  } finally {
    boardCarregando = false;
    renderBoard();
  }
}

function renderBoard() {
  const wrapFiltros = $('#boardFilters');
  const wrapGrid = $('#boardGrid');
  const b = state.board;

  if (!b || !b.groups.length) {
    wrapFiltros.innerHTML = '';
    $('#boardCount').textContent = '';
    $('#boardUpdated').textContent = '';
    if (boardCarregando) {
      wrapGrid.innerHTML = `<div class="picker-state"><span class="spin"></span>buscando todas as apostas de Bitcoin abertas na Kalshi agora (são dezenas de séries, leva alguns segundos)...</div>`;
    } else if (boardErro) {
      wrapGrid.innerHTML = `<div class="picker-state">não consegui buscar as apostas: ${boardErro}<br /><button type="button" class="btn primary" id="boardTentarDeNovo">tentar de novo</button></div>`;
      $('#boardTentarDeNovo').addEventListener('click', carregarBoard);
    } else {
      wrapGrid.innerHTML = `<div class="picker-state">nenhuma aposta de Bitcoin aberta agora.<br /><button type="button" class="btn primary" id="boardTentarDeNovo">buscar</button></div>`;
      $('#boardTentarDeNovo').addEventListener('click', carregarBoard);
    }
    return;
  }

  const filtros = [{ key: 'all', label: 'Todos' }, ...b.freqOrder.map((f) => ({ key: f, label: b.freqLabel[f] }))];
  wrapFiltros.innerHTML = filtros
    .map(
      (f) =>
        `<button type="button" class="boardFilter ${f.key === boardFreq ? 'active' : ''}" data-freq="${f.key}">
      ${f.label} <b>${f.key === 'all' ? b.counts.all : b.counts[f.key] || 0}</b>
    </button>`
    )
    .join('');
  wrapFiltros.querySelectorAll('.boardFilter').forEach((el) =>
    el.addEventListener('click', () => {
      boardFreq = el.dataset.freq;
      renderBoard();
    })
  );

  let grupos = boardFreq === 'all' ? b.groups : b.groups.filter((g) => g.freq === boardFreq);
  if (boardBusca) grupos = grupos.filter((g) => g.title.toLowerCase().includes(boardBusca));

  $('#boardCount').textContent = `${grupos.length} aposta${grupos.length === 1 ? '' : 's'} de Bitcoin`;
  $('#boardUpdated').textContent = b.updatedAt ? 'atualizado às ' + new Date(b.updatedAt).toLocaleTimeString('pt-BR') : '';

  const atual = state.analysis && state.analysis.event ? state.analysis.event.ticker : null;

  wrapGrid.innerHTML =
    grupos
      .map((g) => {
        const outcomes = g.top
          .map(
            (o) => `<div class="boardOutcome">
          <span class="lbl">${o.label}</span>
          <span class="bar"><i style="width:${Math.round(o.impliedProb * 100)}%"></i></span>
          <span class="prob">${pct(o.impliedProb, 0)}</span>
        </div>`
          )
          .join('') || '<p class="muted" style="margin:0;font-size:11px">sem negócios ainda</p>';

        const selecionado = g.eventTicker === atual;
        return `<div class="boardCard ${selecionado ? 'selecionado' : ''}">
          <div class="topo">
            <span class="badge">${b.freqLabel[g.freq] || g.freq}</span>
            <span class="sub">${num(g.marketsCount)} faixa${g.marketsCount === 1 ? '' : 's'}</span>
          </div>
          <h3>${g.title}</h3>
          <div class="boardOutcomes">${outcomes}</div>
          <div class="rodape">
            <span>${num(g.volume)} contratos negociados</span>
            <button type="button" class="btn ${selecionado ? 'primary' : ''}" data-event="${g.eventTicker}">
              ${selecionado ? 'escolhida' : 'escolher esta'}
            </button>
          </div>
        </div>`;
      })
      .join('') || '<p class="muted">nenhuma aposta encontrada com esse filtro/busca.</p>';

  wrapGrid.querySelectorAll('[data-event]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const eventTicker = btn.dataset.event;
      if (eventTicker === atual) return;
      btn.disabled = true;
      btn.textContent = 'carregando...';
      try {
        await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventTicker }) });
        fecharPicker();
        $$('.tab').forEach((x) => x.classList.remove('active'));
        $$('.panel').forEach((x) => x.classList.remove('active'));
        $('.tab[data-tab="resumo"]').classList.add('active');
        updatePageHeading('resumo');
        $('#tab-resumo').classList.add('active');
        renderPainelVisivel(true);
      } catch (err) {
        alert(err.message);
        renderBoard();
      }
    })
  );
}

async function showMarketDetail(ticker, silencioso) {
  if (!state.analysis) return;
  const r = state.analysis.rows.find((x) => x.ticker === ticker);
  if (!r) return;
  state.faixaAberta = ticker;
  const box = $('#marketDetail');
  box.classList.remove('hidden');
  if (!silencioso) box.innerHTML = `<h2>${tituloFaixa(r)}</h2><p class="muted">buscando as ofertas...</p>`;

  let ob = null;
  try { ob = await api('/api/orderbook?ticker=' + encodeURIComponent(ticker)); } catch (_) {}

  const legTable = r.legs
    .map(
      (l) => `<tr><td><span class="pill ${l.side}">${LADO[l.side]}</span></td>
    <td>${money(l.price)}</td><td>${pct(l.modelProb)}</td><td class="${cls(l.edge)}">${pontos(l.edge)}</td>
    <td>${pct(l.breakevenProb)}</td><td class="${cls(l.evPct)}">${pct(l.evPct)}</td><td>${pct(l.kelly, 0)}</td>
    <td>${money(l.feePerContract, 3)}</td><td>${money(l.roundTripCost, 2)}</td>
    <td>${l.safety}</td><td>${l.liquidity}</td><td>${l.score}</td></tr>`
    )
    .join('');

  const levels = ob && ob.orderbook_fp ? ob.orderbook_fp : {};
  const renderSide = (arr, label, color) =>
    `<div><h3 style="font-size:12px;color:${color}">${label}</h3>` +
    ((arr || []).slice().reverse().slice(0, 10).map((l) => `<div class="muted">${money(+l[0])} — ${num(+l[1])} contratos</div>`).join('') ||
      '<span class="muted">ninguém oferecendo</span>') +
    '</div>';

  box.innerHTML = `
    <h2>${tituloFaixa(r)}</h2>
    <p class="muted">${perguntaFaixa(r, state.analysis)} Encerra ${new Date(r.closeTime).toLocaleString('pt-BR')}.
    O Bitcoin está agora em ${alvo(state.analysis.spot)}${r.strike > 0 ? `, ou seja, ${alvo(Math.abs(r.distanceDollars))} ${r.distanceDollars >= 0 ? 'acima' : 'abaixo'} do alvo` : ''}.</p>
    <div class="tablewrap" style="margin:10px 0">
      <table class="data"><thead><tr>
        <th>Aposta</th>${th('Custa', 'custo')}${th('Chance calculada', 'conta')}${th('Vantagem', 'vantagem')}
        ${th('Precisa de', 'equilibrio')}${th('Retorno esperado', 'retorno')}${th('Quanto apostar', 'quanto')}
        <th title="Taxa cobrada pela Kalshi por contrato">Taxa</th>
        <th title="Quanto você perderia se comprasse e vendesse na hora">Custo de desistir</th>
        ${th('Segurança', 'seguranca')}<th title="O quanto essa faixa é movimentada">Movimento</th>${th('Nota', 'nota')}
      </tr></thead><tbody>${legTable}</tbody></table>
    </div>
    <div class="grid2">${renderSide(levels.yes_dollars, 'Ofertas para "vai passar"', 'var(--green)')}${renderSide(levels.no_dollars, 'Ofertas para "não passa"', 'var(--red)')}</div>
    <p class="hint">As ofertas acima se atualizam sozinhas enquanto esta faixa estiver aberta.</p>`;
}

// ---------- GRAFICOS ----------
function svgChart(el, { series, xLabel, yFmt, xFmt, yDomain, bars }) {
  const W = el.clientWidth || 700, H = el.clientHeight || 280;
  const pad = { l: 56, r: 24, t: W < 420 ? 48 : 30, b: 48 };
  // O domínio precisa considerar tanto as linhas quanto as barras.
  const all = series.flatMap((s) => s.points).concat(bars ? bars.points : []);
  if (!all.length) { el.innerHTML = '<p class="muted">sem dados</p>'; return; }
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  // Barras sempre partem do zero; linhas usam o próprio mínimo.
  const yMin = bars ? Math.min(0, ...ys) : Math.min(...ys);
  const y0 = yDomain ? yDomain[0] : yMin, y1 = yDomain ? yDomain[1] : Math.max(...ys);
  const barInset = bars ? (W - pad.l - pad.r) / Math.max(2, bars.points.length * 2) : 0;
  const sx = (v) => pad.l + barInset + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r - 2 * barInset);
  const sy = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    const y = sy(v);
    g += `<line class="grid" x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  const ticks = W < 500 ? 2 : 5;
  for (let i = 0; i <= ticks; i++) {
    const v = x0 + ((x1 - x0) * i) / ticks;
    g += `<text x="${sx(v)}" y="${H - 27}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${xFmt(v)}</text>`;
  }

  let content = '';
  if (bars) {
    const bw = Math.max(2, ((W - pad.l - pad.r) / bars.points.length) * 0.8);
    content += bars.points.map((p) => `<rect x="${sx(p.x) - bw / 2}" y="${sy(p.y)}" width="${bw}" height="${Math.max(0, H - pad.b - sy(p.y))}" fill="${bars.color}" opacity=".5"/>`).join('');
  }
  content += series
    .map((s) => {
      const d = s.points.map((p, i) => (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1)).join(' ');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="4 3"' : ''}/>`;
    })
    .join('');

  const legend = series
    .map((s, i) => `<g transform="translate(${pad.l + (W < 420 ? 0 : i * 165)},${10 + (W < 420 ? i * 17 : 0)})"><rect width="10" height="3" fill="${s.color}"/><text x="15" y="4">${s.label}</text></g>`)
    .join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${g}
    <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}"/>
    <line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>
    ${content}${legend}
    <text x="${W / 2}" y="${H - 5}" text-anchor="middle">${xLabel}</text>
  </svg>`;
}

const eixoPreco = (v) => 'US$ ' + (v / 1000).toFixed(1).replace('.', ',') + ' mil';

function renderCharts() {
  const a = state.analysis;
  // Só entram faixas com preço-alvo e com chance calculável: as demais virariam pontos
  // em zero, inventando uma linha que não quer dizer nada.
  const comModelo = a.rows.filter((r) => r.modelSupported !== false && r.strike > 0);
  const eixoX = a.event.contractModel === 'touch' ? 'valor que o Bitcoin precisa encostar' : 'preço-alvo do Bitcoin';

  svgChart($('#chartCurve'), {
    series: [
      { label: 'o que o mercado acha', color: 'var(--blue)', points: comModelo.filter((r) => r.mid > 0).map((r) => ({ x: r.strike, y: r.mid })) },
      { label: 'o que a conta diz', color: 'var(--purple)', dash: true, points: comModelo.map((r) => ({ x: r.strike, y: r.modelProbYes })) },
    ],
    yDomain: [0, 1],
    yFmt: (v) => (v * 100).toFixed(0) + '%',
    xFmt: eixoPreco,
    xLabel: eixoX,
  });

  svgChart($('#chartDensity'), {
    series: [],
    bars: { color: 'var(--green)', points: a.density.map((p) => ({ x: p.strike, y: p.prob })) },
    yFmt: (v) => (v * 100).toFixed(0) + '%',
    xFmt: eixoPreco,
    xLabel: 'faixa de preço no encerramento',
  });

  const edge = comModelo.filter((r) => r.mid > 0).map((r) => ({ x: r.strike, y: r.modelProbYes - r.mid }));
  svgChart($('#chartEdge'), {
    series: [{ label: 'vantagem', color: 'var(--yellow)', points: edge }],
    yFmt: (v) => (v * 100).toFixed(0) + ' pt',
    xFmt: eixoPreco,
    xLabel: eixoX,
  });

  if (!state.btcFetchAt || Date.now() - state.btcFetchAt > 1000) {
    state.btcFetchAt = Date.now();
    api('/api/btc-history').then((r) => {
      if (r.eventTicker !== state.analysis?.event?.eventTicker && r.eventTicker !== state.analysis?.event?.ticker) return;
      state.btc = r.candles; drawBtc();
    }).catch(() => {});
  } else drawBtc();
}

function drawBtc() {
  if (!state.btc) return;
  svgChart($('#chartBtc'), {
    series: [{ label: 'preço do Bitcoin', color: 'var(--yellow)', points: state.btc.map((c) => ({ x: c.ts, y: c.close })) }],
    yFmt: eixoPreco,
    xFmt: (v) => new Date(v).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    xLabel: 'horário',
  });
}

// ---------- LUCRO GARANTIDO ----------
function renderArb() {
  const arb = state.analysis.arbitrage;
  if (!arb.length) {
    $('#arbList').innerHTML =
      '<p class="muted">Nenhuma combinação dessas agora. Os preços estão consistentes entre si, que é o normal. ' +
      'Continue de olho: quando aparece, costuma durar poucos segundos.</p>';
    return;
  }
  $('#arbList').innerHTML = arb
    .map(
      (x) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line-soft)">
      <strong class="pos">ganha ${money(x.profitPerContract, 3)} por contrato, dê no que der</strong>
      <div>${x.label}</div>
      <div class="muted">${x.detail}</div>
    </div>`
    )
    .join('');
}

// ---------- APOSTAR SOZINHO ----------
const AUTO_FIELDS = [
  ['minEdge', 'Vantagem mínima', 'só aposta se a conta discordar do mercado por pelo menos isso. 0,06 = 6 pontos', 0.01],
  ['minModelProb', 'Chance mínima de acerto', '0,80 = só aposta no que tem 80% ou mais de chance', 0.01],
  ['minScore', 'Nota mínima', 'de 0 a 100', 1],
  ['maxContractsPerOrder', 'Máximo de contratos por aposta', 'teto absoluto', 1],
  ['maxNotionalPerOrder', 'Máximo de dólares por aposta', 'quanto pode gastar de uma vez', 1],
  ['maxOpenNotionalTotal', 'Máximo de dólares no total', 'teto de tudo que ele pode apostar', 1],
  ['maxOrdersPerHour', 'Máximo de apostas por hora', 'para ele não sair apostando demais', 1],
  ['minSecondsToClose', 'Parar quantos segundos antes do fim', 'evita apostar no sufoco', 10],
  ['maxSecondsToClose', 'Não apostar antes de faltar (segundos)', 'evita apostar cedo demais', 60],
  ['kellyFraction', 'Prudência no tamanho', '0,25 = usa um quarto do que a matemática indicaria', 0.05],
  ['cooldownSecondsPerMarket', 'Espera entre apostas na mesma faixa (segundos)', 'evita repetir a mesma aposta', 30],
];

const NOME_MODO = {
  normal: 'Normal — só analisa',
  semi: 'Semiautomático — sugere e espera você',
  full: 'TOTALMENTE AUTOMÁTICO — aposta sozinho',
};

function renderAuto() {
  const s = state.auto;
  if (!s) return;

  const radio = document.querySelector(`input[name="modo"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  $$('.modo').forEach((el) => el.classList.toggle('ativo', el.dataset.modo === s.mode));
  $('#autoDryRun').checked = s.dryRun;

  const conta = s.hasCredentials
    ? '<span class="pos">cadastrada</span>'
    : '<span class="neg">não cadastrada — só dá para simular</span>';

  const valeDinheiro = s.podeEnviarDeVerdade && s.mode !== 'normal';

  $('#autoStatus').innerHTML = `
    <div>Modo: <strong class="${s.mode === 'full' ? 'neg' : s.mode === 'semi' ? 'pos' : 'dim'}">${NOME_MODO[s.mode]}</strong></div>
    <div>Modo teste: <strong class="${s.dryRun ? 'pos' : 'neg'}">${s.dryRun ? 'ligado — nada é enviado' : 'DESLIGADO'}</strong>
      · Agora vale dinheiro de verdade? <strong class="${valeDinheiro ? 'neg' : 'pos'}">${valeDinheiro ? 'SIM' : 'não'}</strong></div>
    <div>Sua conta na Kalshi: ${conta}</div>
    <div>Apostou ${s.ordersLastHour} de ${s.settings.maxOrdersPerHour} vezes nesta hora · já colocou ${money(s.openNotional)} do limite de ${money(s.settings.maxOpenNotionalTotal)}</div>
    <div>Última verificação: ${s.lastRunAt ? new Date(s.lastRunAt).toLocaleTimeString('pt-BR') : 'ainda não verificou'}</div>
    ${s.lastError ? `<div class="neg">Último problema: ${traduzMotivo(s.lastError)}</div>` : ''}`;

  renderSugestoes(s);

  if (!$('#autoSettings').dataset.built) {
    $('#autoSettings').innerHTML = AUTO_FIELDS.map(
      ([k, label, desc, step]) =>
        `<div class="setting"><label>${label}</label><input type="number" step="${step}" data-auto="${k}" /><div class="desc">${desc}</div></div>`
    ).join('');
    $('#autoSettings').dataset.built = '1';
  }
  AUTO_FIELDS.forEach(([k]) => {
    const el = $(`[data-auto="${k}"]`);
    if (el && document.activeElement !== el) el.value = s.settings[k];
  });

  $('#autoHistory').innerHTML =
    (s.history || [])
      .map((h) => {
        const c = h.type === 'order' ? 'order' : h.type === 'error' ? 'error' : '';
        const t = new Date(h.ts).toLocaleTimeString('pt-BR');
        let txt;
        const ondeQuanto = () =>
          `${LADO[h.side].toLowerCase()} em ${alvo(h.strike)} — ${h.contracts} contratos a ${money(h.price)}`;
        if (h.type === 'order') {
          const oque = h.dryRun ? 'teria apostado' : h.result === 'executada' ? 'apostou' : `tentou apostar (${h.result})`;
          const vantagem = ` (vantagem de ${(h.edge * 100).toFixed(1).replace('.', ',')} pontos, ${h.origem})`;
          txt = oque + ' ' + ondeQuanto() + vantagem;
        } else if (h.type === 'sugestao') txt = 'sugeriu ' + ondeQuanto();
        else if (h.type === 'recusada') txt = 'você recusou a sugestão';
        else if (h.type === 'cancelada') txt = 'cancelou antes de enviar: ' + traduzMotivo(h.reason);
        else if (h.type === 'seguranca') txt = 'segurança: ' + h.reason;
        else if (h.type === 'skip') txt = 'não apostou: ' + traduzMotivo(h.reason);
        else if (h.type === 'error') txt = 'problema: ' + traduzMotivo(h.reason);
        else if (h.type === 'mode') txt = 'modo alterado para ' + (NOME_MODO[h.mode] || h.mode);
        else if (h.type === 'dry-run-toggle') txt = h.dryRun ? 'modo teste ligado' : 'modo teste DESLIGADO';
        else if (h.type === 'settings') txt = 'limites de segurança alterados';
        else txt = h.type;
        return `<div class="${c}">${t} — ${txt}</div>`;
      })
      .join('') || '<div>ele ainda não fez nada</div>';

  loadPreview();
}

const ROTULO_STATUS = {
  pendente: ['warn', 'esperando você'],
  enviando: ['warn', 'enviando...'],
  executada: ['yes', 'apostada de verdade'],
  simulada: ['yes', 'simulada (modo teste)'],
  recusada: ['no', 'você recusou'],
  expirada: ['no', 'venceu'],
  cancelada: ['no', 'cancelada na conferência'],
  falhou: ['no', 'falhou'],
};

function renderSugestoes(s) {
  const lista = s.suggestions || [];
  const box = $('#sugestoes');

  if (s.mode === 'normal') {
    box.innerHTML = '<p class="muted">No modo normal o programa não sugere nada. Escolha o semiautomático acima para começar a receber sugestões.</p>';
    return;
  }
  if (!lista.length) {
    box.innerHTML = '<p class="muted">Nenhuma sugestão ainda. Ele avisa aqui assim que encontrar uma aposta que passe em todos os limites.</p>';
    return;
  }

  box.innerHTML = lista
    .map((x) => {
      const [cor, rotulo] = ROTULO_STATUS[x.status] || ['warn', x.status];
      const pendente = x.status === 'pendente';
      const segundos = Math.max(0, Math.round((x.expiraEm - Date.now()) / 1000));
      return `<div class="sugestao ${pendente ? 'pendente' : ''}">
        <div class="sug-topo">
          <span class="pill ${x.side}">${LADO[x.side]}</span>
          <strong>${alvo(x.strike)}</strong>
          <span class="pill ${cor}">${rotulo}</span>
          ${pendente ? `<span class="prazo" data-expira="${x.expiraEm}">vence em ${segundos}s</span>` : ''}
        </div>
        <div class="sug-numeros">
          <div><label>Compraria</label><strong>${x.contracts} contratos</strong></div>
          <div><label>A</label><strong>${money(x.price)} cada</strong></div>
          <div><label>Gastaria</label><strong>${money(x.estimatedCost)}</strong></div>
          <div><label>Chance de acerto</label><strong>${pct(x.modelProb)}</strong></div>
          <div><label>Precisa de</label><strong>${pct(x.breakevenProb)}</strong></div>
          <div><label>Vantagem</label><strong class="${cls(x.edge)}">${pontos(x.edge)}</strong></div>
          <div><label>Retorno esperado (capital)</label><strong class="${cls(x.evPctCapital)}">${pct(x.evPctCapital)}</strong></div>
          <div><label>Se ganhar (capital)</label><strong class="${cls(x.winReturnPctCapital)}">${pct(x.winReturnPctCapital)}</strong></div>
          <div><label>Ganha se acertar</label><strong class="pos">${money(x.contracts - x.estimatedCost)}</strong></div>
          <div><label>Perde se errar</label><strong class="neg">${money(x.estimatedCost)}</strong></div>
        </div>
        ${
          pendente
            ? `<div class="sug-acoes">
                 <button class="btn primary" data-aprovar="${x.id}">Aprovar${s.podeEnviarDeVerdade ? ' e apostar de verdade' : ' (só simula)'}</button>
                 <button class="btn" data-recusar="${x.id}">Recusar</button>
               </div>`
            : x.motivo
            ? `<div class="muted">${x.motivo}</div>`
            : ''
        }
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-aprovar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const dinheiroDeVerdade = state.auto.podeEnviarDeVerdade;
      if (dinheiroDeVerdade && !confirm('Isso vai comprar contratos com dinheiro de verdade na sua conta da Kalshi. Confirma?')) return;
      b.disabled = true;
      b.textContent = 'enviando...';
      try {
        const r = await api('/api/auto/aprovar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.dataset.aprovar }),
        });
        if (!r.ok) alert('Não deu para apostar: ' + traduzMotivo(r.reason || 'motivo desconhecido'));
        else if (r.simulated) alert('Aposta simulada e anotada. Nada foi enviado para a Kalshi.');
        else alert('Aposta enviada para a Kalshi.');
      } catch (e) {
        alert('Erro: ' + e.message);
      }
      atualizarRobo();
    })
  );

  box.querySelectorAll('[data-recusar]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/api/auto/recusar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.recusar }),
      });
      atualizarRobo();
    })
  );
}

// A contagem regressiva das sugestões corre a cada segundo, sem redesenhar o cartão.
setInterval(() => {
  $$('.prazo').forEach((el) => {
    const s = Math.max(0, Math.round((+el.dataset.expira - Date.now()) / 1000));
    el.textContent = s > 0 ? `vence em ${s}s` : 'venceu';
    el.classList.toggle('urgente', s <= 10);
  });
}, 1000);

let previewBusy = false;
async function loadPreview() {
  if (previewBusy) return;
  previewBusy = true;
  try {
    const { preview } = await api('/api/auto/preview');
    const head = `<thead><tr>${th('Preço-alvo', 'alvo')}${th('Aposta', 'tipo')}${th('Custa', 'custo')}${th('Chance calculada', 'conta')}
      ${th('Vantagem', 'vantagem')}${th('Retorno esperado', 'retorno')}${th('Nota', 'nota')}
      <th>Contratos</th><th>Gastaria</th><th>Por que ele não aposta</th></tr></thead>`;
    const body = preview
      .map(
        (p) => `<tr>
      <td>${alvo(p.strike)}</td>
      <td><span class="pill ${p.side}">${LADO[p.side]}</span></td>
      <td>${money(p.price)}</td><td>${pct(p.modelProb)}</td>
      <td class="${cls(p.edge)}">${pontos(p.edge)}</td>
      <td class="${cls(p.evPct)}">${pct(p.evPct)}</td>
      <td>${p.score.toFixed(0)}</td>
      <td>${p.sizing.contracts}</td>
      <td>${money(p.sizing.estimatedCost)}</td>
      <td style="text-align:left">${p.vetoes.length ? '<span class="neg">' + p.vetoes.map(traduzMotivo).join('; ') + '</span>' : '<span class="pos">nada — esta ele apostaria</span>'}</td>
    </tr>`
      )
      .join('');
    $('#previewTable').innerHTML = head + '<tbody>' + body + '</tbody>';
  } catch (e) {
    $('#previewTable').innerHTML = `<tbody><tr><td class="neg">${e.message}</td></tr></tbody>`;
  } finally {
    previewBusy = false;
  }
}

// ---------- AJUSTES ----------
const MODEL_FIELDS = [
  ['model.volSource', 'De onde vem a oscilação usada na conta', 'select', [
    ['blend', 'misturar as duas (recomendado)'],
    ['realized', 'só o que o Bitcoin fez de verdade'],
    ['implied', 'só o que o mercado espera'],
  ]],
  ['model.blendWeightRealized', 'Peso do que o Bitcoin fez de verdade', 'number', 0.05],
  ['model.volLookbackMinutes', 'Quantos minutos de histórico olhar', 'number', 30],
  ['model.ewmaHalfLifeMinutes', 'Peso maior para os últimos minutos', 'number', 10],
  ['fees.tradingFeeRate', 'Taxa cobrada pela Kalshi', 'number', 0.005],
  ['ranking.weightEdge', 'Na nota, peso do retorno', 'number', 0.05],
  ['ranking.weightSafety', 'Na nota, peso da segurança', 'number', 0.05],
  ['ranking.weightLiquidity', 'Na nota, peso do movimento do mercado', 'number', 0.05],
  ['ranking.weightKelly', 'Na nota, peso do tamanho recomendado', 'number', 0.05],
  ['ranking.minVolume', 'Mínimo de contratos negociados', 'number', 50],
  ['ranking.minOpenInterest', 'Mínimo de contratos em aberto', 'number', 50],
  ['ranking.maxSpreadCents', 'Diferença compra/venda máxima (centavos)', 'number', 1],
  ['pollIntervalMs', 'Consultar os preços da Kalshi a cada (milissegundos)', 'number', 50],
];

async function renderConfigTab() {
  state.config = await api('/api/config');
  const get = (pathStr) => pathStr.split('.').reduce((o, k) => (o ? o[k] : undefined), state.config);
  $('#modelSettings').innerHTML = MODEL_FIELDS.map(([k, label, type, arg]) => {
    if (type === 'select')
      return `<div class="setting"><label>${label}</label><select data-cfg="${k}">${arg
        .map(([v, txt]) => `<option value="${v}" ${get(k) === v ? 'selected' : ''}>${txt}</option>`)
        .join('')}</select></div>`;
    return `<div class="setting"><label>${label}</label><input type="number" step="${arg}" data-cfg="${k}" value="${get(k)}" /></div>`;
  }).join('');

  try {
    const p = await api('/api/portfolio');
    if (!p.configured) {
      $('#portfolioBox').innerHTML =
        '<p class="muted">Sua conta ainda não está cadastrada, então o painel só mostra análise — ele não consegue ver seu saldo nem apostar. ' +
        'Para cadastrar, crie uma chave de acesso no site da Kalshi, coloque o código dela no arquivo <code>config.json</code> ' +
        'e salve o arquivo da chave como <code>kalshi-private-key.pem</code> na pasta do projeto.</p>';
    } else {
      // A API entrega valores como texto em dólares (campos *_dollars) e a quantidade em
      // position_fp, onde negativo quer dizer contratos de "não passa".
      const bal = p.balance && (p.balance.balance_dollars != null ? +p.balance.balance_dollars : p.balance.balance != null ? p.balance.balance / 100 : null);
      const pos = ((p.positions && p.positions.market_positions) || []).filter((x) => +x.position_fp !== 0);
      const emAberto = (p.orders && p.orders.orders) || [];

      $('#portfolioBox').innerHTML = `
        <div class="cards" style="margin-bottom:12px">
          <div class="kpi"><label>Saldo disponível</label><strong>${bal != null ? money(bal) : '—'}</strong></div>
          <div class="kpi"><label>Apostas em aberto</label><strong>${pos.length}</strong></div>
          <div class="kpi"><label>Ordens esperando</label><strong>${emAberto.length}</strong></div>
        </div>
        <div class="tablewrap"><table class="data"><thead><tr>
          <th>Faixa</th><th>Aposta</th><th>Contratos</th><th>Valor aplicado</th><th>Total negociado</th><th>Taxas pagas</th><th>Resultado já fechado</th>
        </tr></thead><tbody>
        ${pos
          .map((x) => {
            const qtd = +x.position_fp;
            const lado = qtd > 0 ? 'yes' : 'no';
            const pnl = +(x.realized_pnl_dollars || 0);
            return `<tr><td>${x.ticker}</td>
              <td><span class="pill ${lado}">${LADO[lado]}</span></td>
              <td>${Math.abs(qtd)}</td>
              <td>${money(+(x.market_exposure_dollars || 0))}</td>
              <td>${money(+(x.total_traded_dollars || 0))}</td>
              <td>${money(+(x.fees_paid_dollars || 0))}</td>
              <td class="${cls(pnl)}">${money(pnl)}</td></tr>`;
          })
          .join('') || '<tr><td colspan="7" class="muted">nenhuma aposta em aberto</td></tr>'}
        </tbody></table></div>`;
    }
  } catch (e) {
    $('#portfolioBox').innerHTML = `<p class="neg">${e.message}</p>`;
  }
}

// Render expanded analysis only when it is visible, including after opening it.
['marketQuotes', 'marketCharts', 'marketArbitrage'].forEach(id => {
  $('#' + id).addEventListener('toggle', () => {
    if ($('#' + id).open) renderPainelVisivel(true);
  });
});
// ---------- eventos ----------
$('#emptyPicker').addEventListener('click', () => $('#openPicker').click());
$('#rankAdvanced').addEventListener('change', (event) => $('#rankTable').classList.toggle('expanded', event.target.checked));
$('#marketAdvanced').addEventListener('change', (event) => $('#marketTable').classList.toggle('expanded', event.target.checked));
function updatePageHeading(id) {
  const pages = {
    resumo: ['Mercado', 'Compare oportunidades e abra os detalhes sem trocar de tela.'],
    auto: ['Operações', 'Controle o modo de operação, revise sugestões e defina seus limites.'],
    config: ['Ajustes', 'Ajuste o modelo de análise e consulte os dados da sua conta.'],
  };
  const [title, description] = pages[id] || pages.resumo;
  $('#pageTitle').textContent = title;
  $('#breadcrumbPage').textContent = title;
  $('#pageDescription').textContent = description;
  document.title = title + ' · Kalshi Bitcoin';
  $$('.tab').forEach((tab) => {
    if (tab.dataset.tab === id) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

$('.identity').addEventListener('click', (event) => {
  event.preventDefault();
  $('.tab[data-tab="resumo"]').click();
  window.scrollTo(0, 0);
});

// Keep keyboard focus inside the active dialog and return it to its opener.
$$('.picker-overlay').forEach((overlay) => {
  const panel = overlay.querySelector('.picker-panel');
  const heading = panel.querySelector('h2');
  heading.id = overlay.id + 'Title';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', heading.id);
  let opener;
  const focusable = () => Array.from(panel.querySelectorAll('button,input,select,a[href],summary,[tabindex="0"]')).filter((el) => !el.disabled && el.getClientRects().length);
  new MutationObserver(() => {
    if (!overlay.classList.contains('hidden')) {
      opener = document.activeElement;
      (panel.querySelector('input') || focusable()[0])?.focus();
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      opener?.focus();
    }
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.classList.add('hidden');
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') overlay.classList.add('hidden');
    if (event.key !== 'Tab') return;
    const elements = focusable();
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
});

$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    updatePageHeading(t.dataset.tab);
    if (t.dataset.tab === 'config') renderConfigTab();
    else if (t.dataset.tab === 'auto') atualizarRobo();
    else renderPainelVisivel(true);
  })
);

['#rankSort', '#rankSide', '#onlyEligible', '#onlyPositiveEv'].forEach((s) => $(s).addEventListener('change', renderRanking));
['#filterStrike', '#hideDead'].forEach((s) => $(s).addEventListener('input', renderMarkets));

const FRASE = 'QUERO APOSTAR DE VERDADE';

function enviarModo(corpo) {
  return api('/api/auto/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
}

$$('input[name="modo"]').forEach((r) =>
  r.addEventListener('change', async (e) => {
    const modo = e.target.value;
    const corpo = { mode: modo };

    if (modo === 'full') {
      const aviso = state.auto && state.auto.podeEnviarDeVerdade
        ? 'ATENÇÃO: o modo teste está desligado. No modo totalmente automático o programa vai comprar contratos com DINHEIRO DE VERDADE, sozinho, sem perguntar nada.'
        : 'No modo totalmente automático o programa aposta sozinho, sem perguntar. Agora ele ainda está em modo teste, mas se você desligar o modo teste depois, ele passa a valer dinheiro de verdade na hora.';
      const txt = prompt(aviso + '\n\nSe tem certeza, digite exatamente: ' + FRASE);
      if (txt !== FRASE) { renderAuto(); return; }
      corpo.confirm = txt;
    }

    try {
      state.auto = await enviarModo(corpo);
    } catch (err) {
      alert(err.message);
    }
    renderAuto();
  })
);

$('#autoDryRun').addEventListener('change', async (e) => {
  try {
    if (!e.target.checked) {
      const txt = prompt(
        'Desligar o modo teste faz as aprovações valerem dinheiro de verdade na sua conta da Kalshi.\n\n' +
          'Se tem certeza, digite exatamente: ' + FRASE
      );
      if (txt !== FRASE) { e.target.checked = true; return; }
      state.auto = await enviarModo({ dryRun: false, confirm: txt });
    } else {
      state.auto = await enviarModo({ dryRun: true });
    }
  } catch (err) {
    alert(err.message);
  }
  renderAuto();
});

$('#saveAuto').addEventListener('click', async () => {
  const patch = {};
  AUTO_FIELDS.forEach(([k]) => {
    const el = $(`[data-auto="${k}"]`);
    if (el && el.value !== '') patch[k] = parseFloat(el.value);
  });
  state.auto = await api('/api/auto/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  renderAuto();
  alert('Limites salvos.');
});

$('#autoRunNow').addEventListener('click', async () => {
  const r = await api('/api/auto/run', { method: 'POST' });
  if (r.suggested) alert('Achei uma aposta. Ela apareceu como sugestão aqui embaixo, esperando sua resposta.');
  else if (r.acted) alert(r.simulated ? 'Aposta simulada e anotada. Nada foi enviado para a Kalshi.' : 'Aposta enviada para a Kalshi.');
  else alert('Nada a fazer agora: ' + traduzMotivo(r.reason));
  atualizarRobo();
});

$('#saveConfig').addEventListener('click', async () => {
  const patch = { model: {}, ranking: {}, fees: {} };
  $$('[data-cfg]').forEach((el) => {
    const [a, b] = el.dataset.cfg.split('.');
    const v = el.type === 'number' ? parseFloat(el.value) : el.value;
    if (b) patch[a][b] = v;
    else patch[a] = v;
  });
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  alert('Ajustes salvos. A tela já está usando os novos valores.');
});

// O robô e o detalhe de uma faixa se atualizam sozinhos enquanto estiverem na tela.
setInterval(() => {
  if (abaAtual() === 'auto') atualizarRobo();
}, 3000);

setInterval(() => {
  if (abaAtual() === 'resumo' && $('#marketQuotes').open && state.faixaAberta) showMarketDetail(state.faixaAberta, true);
}, 1500);

// ---------- CAPITAL ----------
function renderCapitalHeader() {
  const c = state.capital;
  const pctEl = $('#capitalPct');
  const detEl = $('#capitalDetail');
  if (!c || !Number.isFinite(Number(c.inicial)) || Number(c.inicial) <= 0 || !Number.isFinite(Number(c.atual)) || Number(c.atual) < 0) {
    pctEl.textContent = '—';
    pctEl.className = '';
    detEl.textContent = 'defina seu capital inicial e atual';
    return;
  }
  const variacao = c.atual / c.inicial - 1;
  pctEl.textContent = (variacao >= 0 ? '+' : '') + pct(variacao);
  pctEl.className = cls(variacao);
  detEl.textContent = `${money(c.inicial)} → ${money(c.atual)}`;
}

async function carregarCapital() {
  try {
    state.capital = await api('/api/capital');
  } catch (_) {
    state.capital = null;
  }
  renderCapitalHeader();
}

function abrirCapital() {
  const c = state.capital;
  $('#capitalInicial').value = c && c.inicial != null ? c.inicial : '';
  $('#capitalAtual').value = c && c.atual != null ? c.atual : '';
  atualizarResumoCapital();
  $('#capitalOverlay').classList.remove('hidden');
}

function atualizarResumoCapital() {
  const inicial = parseFloat($('#capitalInicial').value);
  const atual = parseFloat($('#capitalAtual').value);
  const box = $('#capitalResumo');
  if (!isFinite(inicial) || !isFinite(atual) || inicial <= 0) {
    box.textContent = '';
    return;
  }
  const variacao = atual / inicial - 1;
  box.innerHTML = `Isso é uma <span class="${cls(variacao)}">${variacao >= 0 ? 'valorização' : 'desvalorização'} de ${pct(Math.abs(variacao))}</span> sobre o capital inicial.`;
}

$('#openCapital').addEventListener('click', abrirCapital);
$('#closeCapital').addEventListener('click', () => $('#capitalOverlay').classList.add('hidden'));
['#capitalInicial', '#capitalAtual'].forEach((s) => $(s).addEventListener('input', atualizarResumoCapital));

$('#saveCapital').addEventListener('click', async () => {
  const inicial = parseFloat($('#capitalInicial').value);
  const atual = parseFloat($('#capitalAtual').value);
  if (!isFinite(inicial) || inicial <= 0) return alert('Informe um capital inicial maior que zero.');
  if (!isFinite(atual) || atual < 0) return alert('Informe um capital atual válido.');
  try {
    state.capital = await api('/api/capital', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inicial, atual }),
    });
    renderCapitalHeader();
    $('#capitalOverlay').classList.add('hidden');
    if (abaAtual() === 'config') renderConfigTab();
    else renderPainelVisivel(true);
  } catch (e) {
    alert('Erro: ' + e.message);
  }
});

carregarCapital();
conectarAoVivo();
atualizarRobo();

// Idade calculada pelo relógio atual, mesmo quando a conexão para de atualizar.
setInterval(() => {
  const a=state.analysis;if(!a?.spotUpdatedAt)return;
  const age=Math.max(0,Date.now()-a.spotUpdatedAt);
  $('#spotSource').textContent='fonte: '+a.spotSource+' · '+(age/1000).toFixed(1)+' s'+(age>(state.config?.safety?.maxSpotAgeMs??5000)?' · VENCIDO':'');
},1000);
$('#evaluationDetails').addEventListener('toggle',async(e)=>{
  if(!e.target.open)return;
  const target=$('#evaluationMetrics');
  try {
    const {metrics:m}=await api('/api/evaluation');
    target.textContent='Eventos: '+m.observations+' · Brier modelo: '+(m.brier?.toFixed(4)??'—')+' · Brier mercado: '+(m.marketBrier?.toFixed(4)??'—')+' · Erro de calibração: '+pct(m.calibrationError)+' · P&L líquido: '+money(m.netReturn)+' · Drawdown: '+money(m.maxDrawdown)+' · Sharpe por evento: '+(m.sharpePerEvent?.toFixed(3)??'—')+'. A autorização real é avaliada por tipo de contrato e fonte, separadamente.';
  }catch(e){target.textContent='Não foi possível consultar: '+e.message;}
});
