'use strict';
const { SpotStream }=require('./streams');
async function json(url) {
  const r=await fetch(url,{signal:AbortSignal.timeout(4000)});
  if (!r.ok) throw new Error(`fonte HTTP ${r.status}`);
  return r.json();
}
function parseBRTI(r) {
  const value=r?.data?.payload?.latest_values?.BRTI;
  if (r?.data?.error || value?.repeatOfPreviousValue) throw new Error('BRTI indisponível ou repetido por erro');
  return {price:Number(value?.value),updatedAt:Number(value?.time),source:'CF Benchmarks BRTI',sourceId:'brti'};
}
class PriceSources extends SpotStream {
  constructor(client,ticker,config) { super(client,ticker); this.config=config; this.failures={}; }
  async refresh() {
    if(this.pending) return this.pending;
    this.pending=this._refreshPrice();
    try {return await this.pending;} finally {this.pending=null;}
  }
  async _refreshPrice() {
    const generation=this.generation;
    const providers={
      brti:async()=>{if(!this.client.hasCredentials())throw new Error('sem credenciais/permissão'); return parseBRTI(await this.client.getBRTI());},
      coinbase:async()=>{const r=await json('https://api.exchange.coinbase.com/products/BTC-USD/ticker');return {price:Number(r.price),updatedAt:Date.parse(r.time),source:'Coinbase BTCUSD (fallback)',sourceId:'coinbase'};},
      binance:async()=>{const rs=await json('https://api.binance.com/api/v3/trades?symbol=BTCUSDT&limit=1');const r=rs[0];return {price:Number(r?.price),updatedAt:Number(r?.time),source:'Binance BTCUSDT (fallback)',sourceId:'binance'};}
    };
    for(const name of this.config.priceSources?.priority || ['brti','coinbase','binance']) {
      try {
        if(!providers[name])throw new Error('fonte desconhecida');
        const p=await providers[name]();
        if(generation!==this.generation || this._closed)return;
        if(!(p.price>0) || !Number.isFinite(p.updatedAt) || Date.now()-p.updatedAt>(this.config.safety?.maxSpotAgeMs??5000) || p.updatedAt>Date.now()+1000)throw new Error('preço inválido/vencido');
        if(this.sourceId!==p.sourceId){this.candles=[];this.history=[];}
        Object.assign(this,p); this.lastError=null; delete this.failures[name];
        this.history.push({ts:p.updatedAt,close:p.price});this.history=this.history.filter(x=>x.ts>Date.now()-86400000);
        const ts=Math.floor(p.updatedAt/60000)*60000;
        if(this.candles.at(-1)?.ts===ts)this.candles.at(-1).close=p.price;else this.candles.push({ts,close:p.price});
        this.candles=this.candles.slice(-(this.config.model.volLookbackMinutes+1));
        this.emit('price',this.price);return;
      }catch(e){this.failures[name]=e.message;}
    }
    if(generation===this.generation)this.clear('Todas as fontes de preço estão indisponíveis');
  }
}
module.exports={PriceSources,parseBRTI};
