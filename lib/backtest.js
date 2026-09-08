'use strict';
const {analyze}=require('./analytics');
const {evaluate}=require('./evaluation');
function compare(snapshots,settled,variants,settings) {
  // Configuration candidates are evaluated separately; selection never grants live validation.
  return variants.map(model=>{
    const rows=[];
    for(const s of snapshots){
      const config={...s.config,model:{...s.config.model,...model}};
      const a=analyze({rawMarkets:s.rawMarkets,spot:s.spot,candles:s.candles,config,now:s.timestamp});
      const outcome=settled.find(r=>r.id===s.paperId);
      if(!outcome?.resolvedAt || outcome.resolvedAt<=s.timestamp)continue;
      const o=a.opportunities.find(o=>o.ticker===outcome.ticker&&o.side===outcome.side);
      if(!o?.modelSupported)continue;
      rows.push({...outcome,modelProb:o.modelProb,timestamp:s.timestamp});
    }
    return {model,metrics:evaluate(rows,settings),selectionValidated:false,
      limitation:'Comparação pareada nas operações registradas; não simula nova política de seleção. Exige amostra futura após escolher parâmetros.'};
  });
}
module.exports={compare};
