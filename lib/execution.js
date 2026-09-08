'use strict';
const crypto=require('crypto');
const {executableBook,freshness,direction,modelKey}=require('./safety');
const {orderCostDollars,tradingFeeDollars}=require('./analytics');
const {exposureVeto}=require('./portfolio');

async function execute(trader,order,analysis) {
  if(trader.executing)return {acted:false,reason:'outra execução em andamento'};
  trader.executing=true;
  let intent=null;
  const cancel=reason=>{trader._log({type:'cancelada',ticker:order.ticker,reason});return {acted:false,reason};};
  try {
    if(!trader.refreshAnalysis)return cancel('atualização final não configurada');
    const dryRun=trader.state.dryRun, mode=trader.state.mode, key=modelKey(trader.config);
    if(mode==='normal')return cancel('modo normal');
    if(!dryRun){
      if(!trader.client.hasCredentials())return cancel('sem credenciais');
      if(trader.journal.all('intent').some(i=>i.status==='pending'||i.status==='unknown'))return cancel('envio anterior incerto; reconciliação manual necessária');
      await trader.portfolio.refresh();
    }
    analysis=await trader.refreshAnalysis();
    if(!analysis)return cancel('sem análise atualizada');
    const o=trader._oportunidadeAtual(analysis,order.ticker,order.side);
    if(!o)return cancel('mercado não está ativo');
    const bookStart=Date.now();
    const book=executableBook(await trader.client.getOrderbook(order.ticker,1),order.side);
    if(book.price>order.price+1e-9)return cancel('preço piorou');
    if(!(book.availableQuantity>=order.contracts) || !(book.price>0))return cancel('liquidez não cobre a ordem');
    order.price=book.price;
    const cost=orderCostDollars(order.price,order.contracts,trader.config.fees);
    const settlement=order.contracts*(trader.config.fees.settlementFeePerContract||0);
    const conservativeEV=o.probabilityLower*(order.contracts-settlement)-cost;
    const vetoes=[...trader.vetoes(o,analysis),...trader._conferirOrdem(order),
      ...exposureVeto(trader.exposureItems(),o,cost,trader.config.auto)];
    if(!(conservativeEV>0))vetoes.push('EV conservador não positivo após taxas do lote');
    if(book.spread*100>trader.config.ranking.maxSpreadCents)vetoes.push('spread final excedido');
    if(Date.now()-bookStart>(trader.config.safety?.maxMarketAgeMs??5000))vetoes.push('livro vencido');
    if(!dryRun && (Date.now()-trader.portfolio.updatedAt>(trader.config.safety?.maxPortfolioAgeMs??10000) || !(trader.portfolio.balance>=cost)))vetoes.push('saldo/posição vencidos ou saldo insuficiente');
    if(trader.state.dryRun!==dryRun || trader.state.mode!==mode || modelKey(trader.config)!==key || analysis.modelKey!==key)vetoes.push('modo/configuração mudou durante conferência');
    vetoes.push(...freshness(analysis,trader.config));
    if(vetoes.length)return cancel([...new Set(vetoes)].join('; '));
    const now=Date.now(), id=order.suggestionId||crypto.randomUUID();
    if(trader.journal.all('paper').some(r=>r.id===id)||trader.journal.all('intent').some(r=>r.id===id))return cancel('decisão já registrada');
    const record={id,timestamp:now,eventTicker:o.eventTicker,ticker:o.ticker,kind:o.kind,side:o.side,direction:direction(o),
      closeTime:o.closeTime,rules:o.rules,minutesToClose:(Date.parse(o.closeTime)-now)/60000,modelVersion:analysis.modelVersion,modelKey:key,
      config:JSON.parse(JSON.stringify({eventTicker:trader.config.eventTicker,seriesTicker:trader.config.seriesTicker,ranking:trader.config.ranking,capital:trader.config.capital,model:trader.config.model,fees:trader.config.fees,auto:trader.config.auto,contracts:trader.config.contracts,safety:trader.config.safety})),
      source:analysis.spotSource,sourceId:analysis.spotSourceId,spotAgeMs:now-analysis.spotUpdatedAt,marketAgeMs:now-analysis.marketUpdatedAt,
      analysisAgeMs:now-Date.parse(analysis.generatedAt),price:order.price,spread:book.spread,entryFee:tradingFeeDollars(order.price,order.contracts,trader.config.fees.tradingFeeRate),
      settlementFeePerContract:trader.config.fees.settlementFeePerContract||0,quantity:order.contracts,cost,availableQuantity:book.availableQuantity,
      modelProb:o.modelProb,impliedProb:o.impliedProb,probabilityLower:o.probabilityLower,probabilityUpper:o.probabilityUpper,
      edge:o.modelProb-order.price,ev:o.modelProb*(order.contracts-settlement)-cost,conservativeEV,
      reason:dryRun?'paper: todas as verificações operacionais aprovadas; modelo em avaliação':'real: modelo validado e verificações aprovadas',result:null,grossPnl:null,netPnl:null};
    if(dryRun){
      trader.journal.put(id,'snapshot',{paperId:id,timestamp:now,config:record.config,rawMarkets:analysis.rawMarkets,
        spot:analysis.spot,candles:analysis.candles || []});
      trader.journal.put(id,'paper',record);
      trader.state.ordersThisHour.push(now);trader.state.lastOrderPerMarket[o.ticker]=now;trader.syncExposure();
      const rec=trader._log({...record,type:'order',dryRun:true,result:'simulado',contracts:record.quantity,estimatedCost:cost});
      return {acted:true,simulated:true,order:rec};
    }
    intent={...record,status:'pending'};trader.journal.put(id,'intent',intent);
    // Durable intent BEFORE network side effect. Never retry an ambiguous response automatically.
    const response=await trader.client.createOrder({ticker:o.ticker,side:o.side,priceDollars:order.price,count:order.contracts,clientOrderId:id,timeInForce:'fill_or_kill'});
    const filled=Number(response.fill_count),remaining=Number(response.remaining_count);
    if(!response.order_id || !Number.isFinite(filled)||filled<0||filled>order.contracts||!Number.isFinite(remaining)||remaining!==0)throw new Error('resposta de execução incompleta/ordem restante');
    intent.status='confirmed';intent.orderId=response.order_id;intent.filled=filled;intent.remaining=remaining;
    // Response v2 does not promise average_fill_price: reserve the approved limit, not an invented fill price.
    intent.reservedCost=orderCostDollars(order.price,filled,trader.config.fees);
    trader.journal.put(id,'intent',intent);
    trader.state.ordersThisHour.push(now);trader.state.lastOrderPerMarket[o.ticker]=now;
    await trader.portfolio.refresh();trader.syncExposure();
    const rec=trader._log({...intent,type:'order',dryRun:false,result:filled?'executada':'sem preenchimento',contracts:filled,estimatedCost:intent.reservedCost});
    return {acted:filled>0,simulated:false,order:rec,response};
  }catch(e){
    if(intent){intent.status='unknown';trader.journal.put(intent.id,'intent',intent);}
    trader.state.lastError=e.message;
    return cancel(e.message);
  }finally{trader.executing=false;}
}
module.exports={execute};
