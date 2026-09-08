'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyze,modelProbForMarket,evaluateLeg}=require('../lib/analytics');
const {freshness,executableBook,modelKey}=require('../lib/safety');
const {Journal}=require('../lib/journal');
const {AutoTrader}=require('../lib/autotrader');
const {Portfolio,exposureVeto}=require('../lib/portfolio');
const {evaluate}=require('../lib/evaluation');
const {parseBRTI}=require('../lib/prices');
const config=()=>JSON.parse(JSON.stringify(require('../config.json')));
const raw=(ticker='A',minutes=30)=>({ticker,event_ticker:'E',status:'active',close_time:new Date(Date.now()+minutes*60000).toISOString(),strike_type:'greater',floor_strike:70000,rules_primary:'simple average sixty seconds CF Benchmarks BRTI',yes_bid_dollars:'0.19',yes_ask_dollars:'0.20',no_bid_dollars:'0.79',no_ask_dollars:'0.80',volume:10000,open_interest:10000});
test('above below range probabilities and unknown fail closed',()=>{
  const above=modelProbForMarket({kind:'above',floorStrike:100},100,0.5,1);
  const below=modelProbForMarket({kind:'below',capStrike:100},100,0.5,1);
  assert.ok(Math.abs(above+below-1)<1e-10);
  const range=modelProbForMarket({kind:'range',floorStrike:90,capStrike:110},100,0.5,1);
  assert.ok(range>0&&range<1);
  assert.equal(modelProbForMarket({kind:'unknown'},100,0.5,1),null);
  assert.equal(modelProbForMarket({kind:'above',floorStrike:100},100,0.5,1,'unknown'),null);
});
test('explicit rules, supported vs validated and market-specific expiry',()=>{
  const c=config();const ms=[raw('A',5),raw('B',120)];
  const a=analyze({rawMarkets:ms,spot:80000,candles:[],config:c});
  assert.equal(a.rows[0].modelSupported,true);assert.equal(a.rows[0].modelReliable,false);
  assert.ok(a.opportunities.find(o=>o.ticker==='B').msToClose>a.opportunities.find(o=>o.ticker==='A').msToClose);
  c.contracts={};const unknown=analyze({rawMarkets:ms,spot:80000,candles:[],config:c});
  assert.equal(unknown.rows.length,2);assert.equal(unknown.bestOverall.length,0);
  ms[0].rules_primary='a different contract';assert.equal(analyze({rawMarkets:ms,spot:80000,candles:[],config:config()}).rows[0].modelSupported,false);
});
test('freshness rejects stale, absent and future timestamps',()=>{
  const now=Date.now(),a={generatedAt:new Date(now).toISOString(),spotUpdatedAt:now,marketUpdatedAt:now};
  assert.deepEqual(freshness(a,config(),now),[]);
  assert.ok(freshness({...a,spotUpdatedAt:now-6000},config(),now).length);
  assert.ok(freshness({...a,marketUpdatedAt:undefined},config(),now).length);
  assert.ok(freshness({...a,marketUpdatedAt:now+2000},config(),now).length);
});
test('book opposite bid is executable ask with its actual depth',()=>{
  const book={orderbook_fp:{yes_dollars:[['0.1','9'],['0.2','8']],no_dollars:[['0.7','3.25']]}};
  assert.deepEqual(executableBook(book,'yes'),{price:0.3,availableQuantity:3.25,spread:0.3-0.2,bid:0.2});
  assert.equal(executableBook({},'yes').availableQuantity,0);
});
test('net Kelly and exit fees rounded once per lot',()=>{
  const l=evaluateLeg({side:'yes',market:{yesAsk:0.2,yesBid:0.19},modelProbYes:0.6,sizeContracts:10,fees:{tradingFeeRate:0.07}});
  assert.ok(Math.abs(l.kelly-(6-2.12)/(10-2.12))<1e-10);
  assert.equal(l.exitFeePerContract,0.011);
});
test('exposure includes event and BTC direction and prevents correlated duplicates',()=>{
  const items=[{eventTicker:'E',direction:'up',cost:20}];
  const veto=exposureVeto(items,{eventTicker:'E',kind:'above',side:'yes'},10,{maxOpenNotionalTotal:25,maxEventNotional:25,maxDirectionNotional:25});
  assert.equal(veto.length,4);
});
test('portfolio reconstructs positions and open orders; failure invalidates freshness',async()=>{
  const client={getBalance:async()=>({balance:10000}),getPositions:async()=>({market_positions:[{ticker:'A',position_fp:'10'}]}),getOrders:async()=>({orders:[{ticker:'B',remaining_count_fp:'2'}]}),getMarket:async()=>({market:{event_ticker:'E',strike_type:'greater'}})};
  const p=new Portfolio(client,config());await p.refresh();assert.equal(p.balance,100);assert.ok(p.items.reduce((s,r)=>s+r.cost,0)>12);
  client.getBalance=async()=>{throw Error('offline');};await assert.rejects(p.refresh());assert.equal(p.updatedAt,0);
});
function fixture(){
  const c=config();c.auto.mode='semi';c.auto.minEdge=0;c.auto.minModelProb=0;c.auto.minScore=0;c.auto.minSecondsToClose=60;
  const j=new Journal(':memory:');let sends=0;
  const client={hasCredentials:()=>true,getBalance:async()=>({balance:10000}),getPositions:async()=>({market_positions:[]}),getOrders:async()=>({orders:[]}),
    getOrderbook:async()=>({orderbook_fp:{yes_dollars:[['0.19','100']],no_dollars:[['0.8','100']]}}),createOrder:async()=>{sends++;return {order_id:'X',fill_count:'0.50',remaining_count:'0'};}};
  const t=new AutoTrader(client,c,j);t._log=r=>{j.log(r);return r;};
  const o={ticker:'A',eventTicker:'E',kind:'above',side:'yes',status:'active',modelSupported:true,modelReliable:true,modelProb:0.9,probabilityLower:0.8,probabilityUpper:1,impliedProb:0.2,edge:0.7,conservativeEdge:0.58,eligible:true,price:0.2,score:90,evPct:1,closeTime:new Date(Date.now()+600000).toISOString()};
  const a={opportunities:[o],event:{msToClose:0},spotUpdatedAt:Date.now(),marketUpdatedAt:Date.now(),generatedAt:new Date().toISOString(),modelKey:modelKey(c),spotSourceId:'brti',modelVersion:'test',spot:80000,rawMarkets:[],candles:[]};
  t.refreshAnalysis=async()=>a;
  return {c,j,t,client,o,a,sends:()=>sends,order:{ticker:'A',side:'yes',price:0.2,contracts:1}};
}
test('individual expiry veto ignores event expiry; paper bootstraps validation without real orders',async()=>{
  const f=fixture();f.o.modelReliable=false;
  assert.deepEqual(f.t.vetoes(f.o,f.a),[]);
  const r=await f.t._executar(f.order,f.a);assert.equal(r.simulated,true);assert.equal(f.sends(),0);assert.equal(f.j.all('paper').length,1);
  f.t.state.dryRun=false;assert.ok(f.t.vetoes(f.o,f.a).some(s=>s.includes('validado')));
});
test('final check cancels stale or thin book and prevents concurrent duplicate orders',async()=>{
  const f=fixture();f.a.spotUpdatedAt-=6000;assert.equal((await f.t._executar(f.order,f.a)).acted,false);
  f.a.spotUpdatedAt=Date.now();f.order.contracts=101;assert.equal((await f.t._executar(f.order,f.a)).acted,false);
  f.order.contracts=1;const rs=await Promise.all([f.t._executar({...f.order},f.a),f.t._executar({...f.order},f.a)]);assert.equal(rs.filter(r=>r.acted).length,1);
});
test('partial fill records only filled quantity and unknown response blocks later real sends',async()=>{
  const f=fixture();f.t.state.dryRun=false;
  const r=await f.t._executar({...f.order},f.a);assert.equal(r.order.contracts,0.5);assert.equal(f.sends(),1);
  const g=fixture();g.t.state.dryRun=false;g.client.createOrder=async()=>{throw Error('timeout');};
  assert.equal((await g.t._executar({...g.order},g.a)).acted,false);assert.equal(g.j.all('intent')[0].status,'unknown');
  assert.match((await g.t._executar({...g.order},g.a)).reason,/incerto/);
});
test('paper settlement persisted once with gross and net pnl',async()=>{
  const f=fixture();await f.t._executar(f.order,f.a);const r=f.j.all('paper')[0];r.closeTime=new Date(Date.now()-1000).toISOString();f.j.put(r.id,'paper',r);
  await f.j.resolve({getMarket:async()=>({market:{status:'finalized',result:'yes'}})},f.c.fees);
  const done=f.j.all('paper')[0];assert.equal(done.grossPnl,0.8);assert.equal(done.netPnl,0.78);assert.ok(done.resolvedAt);
});
test('evaluation has no future outcomes and treats an event as one observation',()=>{
  const now=Date.now(),r={eventTicker:'E',timestamp:now-10000,closeTime:new Date(now-5000).toISOString(),resolvedAt:now-1000,outcome:1,modelProb:0.8,impliedProb:0.7,netPnl:0.5,cost:0.5,minutesToClose:30,kind:'above',availableQuantity:100};
  const metrics=evaluate([r,{...r,timestamp:r.timestamp+1},{...r,eventTicker:'F',resolvedAt:now+1}],{},now);
  assert.equal(metrics.observations,1);assert.ok(Math.abs(metrics.brier-0.04)<1e-9);assert.equal(metrics.modelValidated,false);
});
test('BRTI parser uses index timestamp and rejects repeated error value',()=>{
  const data={data:{payload:{latest_values:{BRTI:{value:'80000',time:100}}}}};assert.equal(parseBRTI(data).updatedAt,100);
  data.data.payload.latest_values.BRTI.repeatOfPreviousValue=true;assert.throws(()=>parseBRTI(data));
});
test('SQLite survives reopening, legacy migration is idempotent and unknown intent persists',()=>{
  const fs=require('fs'),os=require('os'),path=require('path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kalshi-journal-')),file=path.join(dir,'test.sqlite'),legacy=path.join(dir,'old.jsonl');
  fs.writeFileSync(legacy,'{"type":"order"}\ninvalid\n');
  let j=new Journal(file);j.migrate(legacy);j.migrate(legacy);assert.equal(j.all('legacy').length,1);assert.equal(j.all('legacy-invalid').length,1);
  j.put('X','intent',{id:'X',status:'unknown'});j.db.close();j=new Journal(file);assert.equal(j.all('intent')[0].status,'unknown');j.db.close();
  // Remove only known test files, no recursive directory removal.
  for(const name of ['test.sqlite','test.sqlite-wal','test.sqlite-shm','old.jsonl'])if(fs.existsSync(path.join(dir,name)))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);
});
test('official v2 order payload preserves subcent approved price and flips NO to ask',async()=>{
  const {KalshiClient}=require('../lib/kalshi');const c=new KalshiClient({});let request;
  c.signedRequest=async(method,path,body)=>{request={method,path,body};return {};};
  await c.createOrder({ticker:'X',side:'no',priceDollars:0.207,count:0.5,clientOrderId:'I',timeInForce:'fill_or_kill'});
  assert.equal(request.body.side,'ask');assert.equal(request.body.price,'0.7930');assert.equal(request.body.count,'0.50');assert.equal(request.body.cancel_order_on_pause,true);
});
test('historical comparison excludes future candles and never grants selection validation',()=>{
  const {compare}=require('../lib/backtest');const c=config(),now=Date.now();
  const snapshot={paperId:'P',timestamp:now,config:c,rawMarkets:[raw('A')],spot:80000,candles:[{ts:now+60000,close:1}]};
  const settled={id:'P',ticker:'A',side:'yes',eventTicker:'E',timestamp:now,closeTime:new Date(now+600000).toISOString(),resolvedAt:now+700000,outcome:1,modelProb:0.8,impliedProb:0.2,netPnl:0.78,cost:0.22};
  const result=compare([snapshot],[settled],[{volSource:'realized'}],{});
  assert.equal(result[0].selectionValidated,false);
  const a=analyze({rawMarkets:snapshot.rawMarkets,spot:80000,candles:snapshot.candles,config:c,now});assert.equal(a.vol.realizedAnnual,null);
});
