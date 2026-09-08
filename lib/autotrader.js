'use strict';

// Motor de decisao com tres modos:
//
//   normal  - so analisa. Nunca sugere nem aposta. E o modo padrao.
//   semi    - sugere uma aposta por vez e espera voce aprovar ou recusar.
//   full    - aposta sozinho, sem perguntar. Desligado por padrao e nunca volta
//             ligado sozinho depois que o servidor reinicia.
//
// Alem do modo existe o interruptor "modo teste" (dryRun). Com ele ligado, nada e
// enviado para a Kalshi em nenhum dos modos: as aprovacoes sao apenas simuladas.
//
// Como isso mexe com dinheiro, toda ordem passa por duas verificacoes: uma quando a
// sugestao nasce e outra imediatamente antes de enviar. Se o preco piorou, se algum
// limite estourou ou se a sugestao venceu, ela e cancelada em vez de enviada.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { orderCostDollars, maxContractsForBudget, tradingFeeDollars } = require('./analytics');
const { freshness, executableBook }=require('./safety');
const { Journal }=require('./journal');
const { Portfolio, exposureVeto }=require('./portfolio');

const LOG_FILE = path.join(__dirname, '..', 'data', 'auto-trade-log.jsonl');
const MODOS = ['normal', 'semi', 'full'];

function ensureDataDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const dinheiro = (v) => 'US$ ' + Number(v).toFixed(2).replace('.', ',');

class AutoTrader {
  constructor(client, config, journal = new Journal()) {
    this.client = client;
    this.config = config;
    this.journal=journal;
    this.portfolio=new Portfolio(client,config);

    let modo = MODOS.includes(config.auto.mode) ? config.auto.mode : 'normal';
    let rebaixado = null;
    // Seguranca: o modo totalmente automatico nunca volta sozinho depois de um reinicio.
    // Quem religa e uma pessoa, na tela, digitando a frase de confirmacao.
    if (modo === 'full') {
      modo = 'semi';
      rebaixado = 'o servidor reiniciou; o modo totalmente automático voltou para semiautomático por segurança';
    }

    this.state = {
      mode: modo,
      dryRun: true,
      lastRunAt: null,
      ordersThisHour: [],
      openNotional: 0,
      lastOrderPerMarket: {},
      history: [],
      lastError: null,
      suggestions: [],      // sugestoes pendentes e recentes (modo semi)
      enviando: new Set(),  // trava contra clique duplo
    };

    ensureDataDir();
    if(journal.file!==':memory:')journal.migrate(LOG_FILE);
    const history=[...journal.all('paper'),...journal.all('intent')];
    for(const r of history){this.state.lastOrderPerMarket[r.ticker]=Math.max(this.state.lastOrderPerMarket[r.ticker]||0,r.timestamp);if(r.timestamp>Date.now()-3600000)this.state.ordersThisHour.push(r.timestamp);}
    this.syncExposure();
    if (rebaixado) this._log({ type: 'seguranca', reason: rebaixado });
  }

  // ---------- estado ----------

  setMode(mode) {
    if (!MODOS.includes(mode)) throw new Error(`modo desconhecido: ${mode}`);
    if (mode !== this.state.mode) {
      this.state.mode = mode;
      // Ao sair do semiautomatico, nada fica pendente esperando aprovacao.
      if (mode !== 'semi') this._expirarTodas('o modo mudou');
      this._log({ type: 'mode', mode });
    }
    return this.status();
  }

  setDryRun(dryRun) {
    this.state.dryRun = !!dryRun;
    this.syncExposure();
    this._log({ type: 'dry-run-toggle', dryRun: this.state.dryRun });
    return this.status();
  }

  updateSettings(patch) {
    const limpo = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'mode' || k === 'dryRun' || k === 'allowedSides') continue; // mudam por caminho proprio
      if (typeof v === 'number' && isFinite(v) && v >= 0) limpo[k] = v;
    }
    Object.assign(this.config.auto, limpo);
    this._log({ type: 'settings', patch: limpo });
    return this.status();
  }

  status() {
    this.syncExposure();
    this._pruneHourWindow();
    this._expirarVencidas();
    return {
      mode: this.state.mode,
      dryRun: this.state.dryRun,
      hasCredentials: this.client.hasCredentials(),
      podeEnviarDeVerdade: !this.state.dryRun && this.client.hasCredentials(),
      ordersLastHour: this.state.ordersThisHour.length,
      openNotional: this.state.openNotional,
      portfolioUpdatedAt:this.portfolio.updatedAt, portfolioError:this.portfolio.error,
      lastRunAt: this.state.lastRunAt,
      lastError: this.state.lastError,
      settings: this.config.auto,
      suggestions: this.state.suggestions.slice(-12).reverse(),
      history: this.state.history.slice(-40).reverse(),
    };
  }

  _pruneHourWindow() {
    const corte = Date.now() - 3600_000;
    this.state.ordersThisHour = this.state.ordersThisHour.filter((t) => t > corte);
  }

  _log(entry) {
    const rec = Object.assign({ ts: new Date().toISOString() }, entry);
    this.journal.log(rec);
    this.state.history.push(rec);
    if (this.state.history.length > 500) this.state.history.shift();
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
    } catch (_) {
      /* o registro em disco e um extra; a tela nao depende dele */
    }
    return rec;
  }

  // ---------- limites de risco ----------

  // Devolve a lista de motivos para NAO apostar. Lista vazia significa liberado.
  vetoes(opportunity, analysis, { ignorarCooldownDe } = {}) {
    const a = this.config.auto;
    const motivos = [];
    const segundosParaFechar = (Date.parse(opportunity?.closeTime)-Date.now()) / 1000;
    const n1 = (v) => v.toFixed(1).replace('.', ',');

    if (!opportunity) return ['aposta não encontrada'];
    // Trava dura: sem modelo de probabilidade confiavel para o tipo de contrato, a
    // "vantagem" calculada nao significa nada e nunca pode virar ordem.
    motivos.push(...freshness(analysis,this.config));
    if (opportunity.modelSupported !== true) motivos.push('contrato sem modelo/regra suportados');
    if (!this.state.dryRun && opportunity.modelReliable !== true) motivos.push('modelo ainda não validado');
    if (!this.state.dryRun && this.config.priceSources?.requireBRTIForReal !== false && analysis.spotSourceId !== 'brti') motivos.push('modo real exige BRTI');
    if (!Number.isFinite(segundosParaFechar)) motivos.push('vencimento individual inválido');
    if (opportunity.status !== 'active') motivos.push('mercado não ativo');
    if (!(opportunity.conservativeEdge>0)) motivos.push('edge conservador não positivo');
    if ((this.config.strategy?.exitMode || 'settlement') !== 'settlement') motivos.push('saída antecipada sem modelo de preço de saída validado');
    if (!this.state.dryRun && !this.portfolio.updatedAt) motivos.push('posição/saldo não reconciliados');
    motivos.push(...exposureVeto(this.exposureItems(),opportunity,0,a));
    if (!opportunity.eligible) motivos.push('pouca gente negociando nessa faixa');
    if (!(opportunity.price > 0 && opportunity.price < 1)) motivos.push('essa aposta não tem preço negociável agora');
    if (opportunity.edge < a.minEdge) motivos.push(`vantagem de apenas ${n1(opportunity.edge * 100)} pontos (o mínimo pedido é ${n1(a.minEdge * 100)})`);
    if (opportunity.modelProb < a.minModelProb) motivos.push(`chance de acerto de ${n1(opportunity.modelProb * 100)}% (o mínimo pedido é ${n1(a.minModelProb * 100)}%)`);
    if (opportunity.score < a.minScore) motivos.push(`nota ${opportunity.score.toFixed(0)} (a mínima pedida é ${a.minScore})`);
    if (opportunity.evPct <= 0) motivos.push('não compensa depois das taxas');
    if (!a.allowedSides.includes(opportunity.side)) motivos.push('esse tipo de aposta está bloqueado nos ajustes');
    if (segundosParaFechar < a.minSecondsToClose) motivos.push(`falta pouco tempo para encerrar (${Math.round(segundosParaFechar)} segundos)`);
    if (segundosParaFechar > a.maxSecondsToClose) motivos.push('ainda falta muito tempo para encerrar');

    this._pruneHourWindow();
    if (this.state.ordersThisHour.length >= a.maxOrdersPerHour) motivos.push(`já apostou ${a.maxOrdersPerHour} vezes nesta hora`);

    const ultima = this.state.lastOrderPerMarket[opportunity.ticker];
    if (ultima && opportunity.ticker !== ignorarCooldownDe && Date.now() - ultima < a.cooldownSecondsPerMarket * 1000) {
      const faltam = Math.round((a.cooldownSecondsPerMarket * 1000 - (Date.now() - ultima)) / 1000);
      motivos.push(`já apostou nessa faixa há pouco (espera de ${faltam} segundos)`);
    }

    if (this.state.openNotional >= a.maxOpenNotionalTotal) {
      motivos.push(`já colocou ${dinheiro(this.state.openNotional)} do limite de ${dinheiro(a.maxOpenNotionalTotal)}`);
    }

    return motivos;
  }

  // Tamanho da aposta: parte do que a matematica indica, limitado pelos tetos.
  sizeOrder(opportunity) {
    const a = this.config.auto;
    const disponivel = Math.max(0, a.maxOpenNotionalTotal - this.state.openNotional);
    const pelaMatematica = disponivel * (opportunity.conservativeKelly ?? opportunity.kelly) * a.kellyFraction;
    const valor = Math.min(pelaMatematica, a.maxNotionalPerOrder, disponivel);
    const preco = Math.max(0.01, opportunity.price);
    // A taxa e arredondada por ordem, portanto nao basta dividir o orcamento
    // pelo preco. A Kalshi aceita centesimos de contrato.
    const cap=Math.min(a.maxContractsPerOrder,opportunity.availableQuantity ?? a.maxContractsPerOrder);
    const contratos = cap>0 ? maxContractsForBudget(preco, valor, this.config.fees, cap) : 0;
    return { contracts: contratos, price: preco, estimatedCost: orderCostDollars(preco, contratos, this.config.fees) };
  }

  // ---------- sugestoes (modo semiautomatico) ----------

  _expirarVencidas() {
    const agora = Date.now();
    for (const s of this.state.suggestions) {
      if (s.status === 'pendente' && agora > s.expiraEm) {
        s.status = 'expirada';
        s.motivo = 'a sugestão venceu antes de você responder (os preços mudam rápido)';
      }
    }
  }

  _expirarTodas(motivo) {
    for (const s of this.state.suggestions) {
      if (s.status === 'pendente') {
        s.status = 'expirada';
        s.motivo = motivo;
      }
    }
  }

  get pendentes() {
    this._expirarVencidas();
    return this.state.suggestions.filter((s) => s.status === 'pendente');
  }

  _criarSugestao(oportunidade, tamanho) {
    const a = this.config.auto;
    const s = {
      id: crypto.randomUUID(),
      criadaEm: Date.now(),
      expiraEm: Date.now() + (a.suggestionTtlSeconds || 45) * 1000,
      status: 'pendente',
      ticker: oportunidade.ticker,
      closeTime:oportunidade.closeTime, msToClose:oportunidade.msToClose, minutesToClose:oportunidade.minutesToClose,
      strike: oportunidade.strike,
      side: oportunidade.side,
      price: tamanho.price,
      contracts: tamanho.contracts,
      estimatedCost: tamanho.estimatedCost,
      modelProb: oportunidade.modelProb,
      edge: oportunidade.edge,
      evPct: oportunidade.evPct,
      evDollars: oportunidade.evDollars,
      breakevenProb: oportunidade.breakevenProb,
      kelly: oportunidade.kelly,
      score: oportunidade.score,
      safety: oportunidade.scores.safety,
      motivo: null,
    };
    this.state.suggestions.push(s);
    if (this.state.suggestions.length > 60) this.state.suggestions.shift();
    this._log({ type: 'sugestao', id: s.id, ticker: s.ticker, strike: s.strike, side: s.side, contracts: s.contracts, price: s.price, edge: s.edge });
    return s;
  }

  // Busca a aposta atual equivalente a uma sugestao, para conferir se o preco piorou.
  _oportunidadeAtual(analysis, ticker, side) {
    return analysis.opportunities.find((o) => o.ticker === ticker && o.side === side) || null;
  }

  // ---------- ciclo principal ----------

  async runOnce(analysis) {
    if(this.running)return {acted:false,reason:'ciclo já em andamento'};
    this.running=true;
    try {return await this._runOnce(analysis);} finally {this.running=false;}
  }

  async prepareBook(o) {
    const book=executableBook(await this.client.getOrderbook(o.ticker,1),o.side);
    if(book.price>o.price+1e-9 || book.spread*100>this.config.ranking.maxSpreadCents){o.availableQuantity=0;return false;}
    o.availableQuantity=book.availableQuantity;
    return book.availableQuantity>0;
  }

  async _runOnce(analysis) {
    this.state.lastRunAt = new Date().toISOString();
    this._expirarVencidas();

    if (this.state.mode === 'normal') {
      return { acted: false, reason: 'o modo normal só analisa, não aposta' };
    }

    const a = this.config.auto;

    if (this.state.mode === 'semi') {
      const teto = a.maxPendingSuggestions || 1;
      if (this.pendentes.length >= teto) return { acted: false, reason: 'já existe uma sugestão esperando sua resposta' };

      for (const o of analysis.bestOverall.slice(0, 8)) {
        const reasons=this.vetoes(o,analysis);
        if (reasons.length) {this._log({type:'skip',ticker:o.ticker,side:o.side,reason:reasons.join('; ')});continue;}
        if (!await this.prepareBook(o)) continue;
        if(this.vetoes(o,analysis).length)continue;
        const tamanho = this.sizeOrder(o);
        if (tamanho.contracts < 0.01) continue;
        // Nao sugere de novo o que ja esta pendente para a mesma faixa e lado.
        if (this.pendentes.some((s) => s.ticker === o.ticker && s.side === o.side)) continue;
        return { acted: true, suggested: true, suggestion: this._criarSugestao(o, tamanho) };
      }
      return { acted: false, reason: 'nenhuma aposta passou nos limites de segurança' };
    }

    // modo totalmente automatico
    const avaliadas = analysis.bestOverall.slice(0, 8).map((o) => ({ o, motivos: this.vetoes(o, analysis) }));
    const liberadas = avaliadas.filter((e) => !e.motivos.length);
    if (!liberadas.length) {
      const rec = this._log({
        type: 'skip',
        reason: 'nenhuma aposta passou nos limites de segurança',
        inspected: avaliadas.map((e) => ({ ticker: e.o.ticker, side: e.o.side, vetoes: e.motivos })),
      });
      return { acted: false, reason: rec.reason, detail: rec.inspected };
    }

    const escolhida = liberadas[0].o;
    if(!await this.prepareBook(escolhida))return {acted:false,reason:'livro sem liquidez/preço aprovado'};
    const tamanho = this.sizeOrder(escolhida);
    if (tamanho.contracts < 0.01) {
      const rec = this._log({ type: 'skip', reason: 'o valor daria menos de 0,01 contrato', ticker: escolhida.ticker });
      return { acted: false, reason: rec.reason };
    }

    return this._executar(
      {
        ticker: escolhida.ticker,
        strike: escolhida.strike,
        side: escolhida.side,
        price: tamanho.price,
        contracts: tamanho.contracts,
        estimatedCost: tamanho.estimatedCost,
        modelProb: escolhida.modelProb,
        edge: escolhida.edge,
        evPct: escolhida.evPct,
        origem: 'automático',
      },
      analysis
    );
  }

  // ---------- aprovacao manual ----------

  async aprovar(id, analysis) {
    const s = this.state.suggestions.find((x) => x.id === id);
    if (!s) return { ok: false, reason: 'sugestão não encontrada' };

    this._expirarVencidas();
    if (s.status !== 'pendente') return { ok: false, reason: `esta sugestão já está como "${s.status}"` };
    if (this.state.enviando.has(id)) return { ok: false, reason: 'esta sugestão já está sendo enviada' };

    this.state.enviando.add(id);
    s.status = 'enviando';
    try {
      // Segunda verificacao, agora com o preco de mercado deste instante.
      const atual = this._oportunidadeAtual(analysis, s.ticker, s.side);
      if (!atual) {
        s.status = 'cancelada';
        s.motivo = 'não consegui reler o preço desta faixa';
        return { ok: false, reason: s.motivo };
      }
      if (atual.price > s.price) {
        s.status = 'cancelada';
        s.motivo = `o preço subiu de ${dinheiro(s.price)} para ${dinheiro(atual.price)} enquanto você decidia; não vou pagar mais caro do que o aprovado`;
        this._log({ type: 'cancelada', id, reason: s.motivo });
        return { ok: false, reason: s.motivo };
      }
      const motivos = this.vetoes(atual, analysis, { ignorarCooldownDe: s.ticker });
      if (motivos.length) {
        s.status = 'cancelada';
        s.motivo = 'as condições mudaram: ' + motivos.join('; ');
        this._log({ type: 'cancelada', id, reason: s.motivo });
        return { ok: false, reason: s.motivo };
      }

      // Nunca paga mais que o aprovado; se ficou mais barato, aproveita o preco melhor.
      const preco = Math.min(s.price, atual.price);
      const r = await this._executar(
        {
          ticker: s.ticker,
          strike: s.strike,
          side: s.side,
          price: preco,
          contracts: s.contracts,
          estimatedCost: orderCostDollars(preco, s.contracts, this.config.fees),
          modelProb: atual.modelProb,
          edge: atual.edge,
          evPct: atual.evPct,
          origem: 'aprovada por você',
          suggestionId: id,
        },
        analysis
      );

      s.status = r.acted ? (r.simulated ? 'simulada' : 'executada') : 'falhou';
      s.motivo = r.acted ? null : r.reason;
      s.resultado = r.order || null;
      return { ok: r.acted, reason: r.reason || null, order: r.order || null, simulated: !!r.simulated };
    } finally {
      this.state.enviando.delete(id);
    }
  }

  recusar(id) {
    const s = this.state.suggestions.find((x) => x.id === id);
    if (!s) return { ok: false, reason: 'sugestão não encontrada' };
    if (s.status !== 'pendente') return { ok: false, reason: `esta sugestão já está como "${s.status}"` };
    s.status = 'recusada';
    s.motivo = 'você recusou';
    this._log({ type: 'recusada', id, ticker: s.ticker, side: s.side });
    return { ok: true };
  }

  // ---------- envio ----------

  // Ultima barreira antes de gastar dinheiro. Confere numero por numero.
  _conferirOrdem(ordem) {
    const a = this.config.auto;
    const erros = [];
    if (!ordem.ticker) erros.push('faixa vazia');
    if (ordem.side !== 'yes' && ordem.side !== 'no') erros.push('tipo de aposta inválido');
    if (!(Number.isFinite(ordem.contracts) && ordem.contracts >= 0.01) || Math.abs(ordem.contracts * 100 - Math.round(ordem.contracts * 100)) > 1e-7) erros.push('quantidade inválida');
    if (ordem.contracts > a.maxContractsPerOrder) erros.push(`quantidade acima do teto de ${a.maxContractsPerOrder} contratos`);
    if (!(ordem.price >= 0.01 && ordem.price <= 0.99)) erros.push('preço fora da faixa de 0,01 a 0,99');
    const custo = orderCostDollars(ordem.price, ordem.contracts, this.config.fees);
    ordem.estimatedCost = custo;
    if (custo > a.maxNotionalPerOrder + 1e-9) erros.push(`custo de ${dinheiro(custo)} acima do teto de ${dinheiro(a.maxNotionalPerOrder)} por aposta`);
    if (this.state.openNotional + custo > a.maxOpenNotionalTotal + 1e-9) {
      erros.push(`custo de ${dinheiro(custo)} estouraria o limite total de ${dinheiro(a.maxOpenNotionalTotal)}`);
    }
    return erros;
  }

  exposureItems() {
    const paper=this.journal.all('paper').filter(r=>!r.resolvedAt).map(r=>({...r,cost:r.cost}));
    const reserves=this.journal.all('intent').filter(r=>!r.closed && (r.status==='pending'||r.status==='unknown'||r.filled>0))
      .map(r=>({...r,cost:r.status==='confirmed'?r.reservedCost:r.cost}));
    const real=[...this.portfolio.items,...reserves];
    return this.state.dryRun ? paper : real;
  }
  syncExposure() { this.state.openNotional=this.exposureItems().reduce((s,r)=>s+r.cost,0); }
  async _executar(ordem, analysis) { return require('./execution').execute(this,ordem,analysis); }
}
module.exports = { AutoTrader, LOG_FILE, MODOS };
