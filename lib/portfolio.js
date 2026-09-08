'use strict';
const { direction } = require('./safety');
const { tradingFeeDollars } = require('./analytics');
class Portfolio {
  constructor(client,config) { this.client=client; this.config=config; this.updatedAt=0; this.items=[]; this.balance=0; this.error=null; }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending=this._refresh();
    try { return await this.pending; } finally { this.pending=null; }
  }
  async _refresh() {
    this.updatedAt=0;
    try {
      const [b,p,o]=await Promise.all([this.client.getBalance(),this.client.getPositions(),this.client.getOrders('resting')]);
      const balance=b.balance_dollars != null ? Number(b.balance_dollars) : Number(b.balance)/100;
      if (!Number.isFinite(balance) || !Array.isArray(p.market_positions) || !Array.isArray(o.orders)) throw new Error('portfólio incompleto');
      const items=[];
      for (const pos of p.market_positions) {
        const qty=Number(pos.position_fp ?? pos.position);
        if (!Number.isFinite(qty)) throw new Error('posição inválida');
        if (!qty) continue;
        // Use reported exposure and fees; binary liability is the safe fallback for missing cost.
        const exposure=pos.market_exposure_dollars != null ? Math.abs(Number(pos.market_exposure_dollars)) :
          pos.market_exposure != null ? Math.abs(Number(pos.market_exposure))/100 : Math.abs(qty);
        const fees=pos.fees_paid_dollars != null ? Number(pos.fees_paid_dollars) :
          pos.fees_paid != null ? Number(pos.fees_paid)/100 : tradingFeeDollars(0.5,Math.abs(qty),this.config.fees.tradingFeeRate);
        if(!Number.isFinite(exposure)||!Number.isFinite(fees))throw new Error('exposição/taxa inválida');
        items.push({ticker:pos.ticker,side:qty>0?'yes':'no',cost:exposure+Math.max(0,fees)});
      }
      for (const order of o.orders) {
        const qty=Number(order.remaining_count_fp ?? order.remaining_count);
        if (!Number.isFinite(qty) || qty<0) throw new Error('ordem aberta inválida');
        if (!qty) continue;
        items.push({ticker:order.ticker,side:'unknown',cost:qty+tradingFeeDollars(0.5,qty,this.config.fees.tradingFeeRate)});
      }
      for (const item of items) {
        const {market:m}=await this.client.getMarket(item.ticker);
        if (!m?.event_ticker) throw new Error('evento da exposição desconhecido');
        const kind=['greater','greater_or_equal'].includes(m.strike_type)?'above':['less','less_or_equal'].includes(m.strike_type)?'below':'unknown';
        item.eventTicker=m.event_ticker; item.direction=item.side==='unknown'?'mixed':direction({kind,side:item.side});
      }
      this.items=items; this.balance=balance; this.updatedAt=Date.now(); this.error=null;
      return this;
    } catch(e) { this.error=e.message; throw e; }
  }
}
function exposureVeto(items,o,cost,auto) {
  const reasons=[], d=direction(o);
  const sum=xs=>xs.reduce((s,x)=>s+x.cost,0);
  if (sum(items)+cost>auto.maxOpenNotionalTotal+1e-9) reasons.push('limite total de exposição');
  const event=items.filter(x=>x.eventTicker===o.eventTicker);
  if (sum(event)+cost>(auto.maxEventNotional ?? auto.maxOpenNotionalTotal)+1e-9) reasons.push('limite de exposição do evento');
  const correlated=items.filter(x=>x.direction===d || x.direction==='mixed' || d==='mixed');
  if (sum(correlated)+cost>(auto.maxDirectionNotional ?? auto.maxOpenNotionalTotal)+1e-9) reasons.push('limite de direção correlacionada BTC');
  if (event.some(x=>x.direction===d || x.direction==='mixed' || d==='mixed')) reasons.push('já existe aposta correlacionada no evento');
  return reasons;
}
module.exports={Portfolio,exposureVeto};
