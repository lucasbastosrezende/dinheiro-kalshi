'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { evaluate } = require('./evaluation');
class Journal {
  constructor(file = path.join(__dirname,'..','data','trading.sqlite')) {
    this.file=file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file),{recursive:true});
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_type ON records(type);');
  }
  put(id,type,body) { this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type, body=excluded.body').run(id,type,JSON.stringify(body)); }
  all(type) { return this.db.prepare('SELECT body FROM records WHERE type=? ORDER BY rowid').all(type).map(r=>JSON.parse(r.body)); }
  log(body) { this.put(crypto.randomUUID(),'log',body); }
  migrate(file) {
    if (!fs.existsSync(file)) return;
    for (const [i,line] of fs.readFileSync(file,'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      const id='legacy:'+crypto.createHash('sha256').update(i+':'+line).digest('hex');
      let record;try {record=JSON.parse(line);}catch{record=null;}
      this.db.prepare('INSERT OR IGNORE INTO records VALUES (?,?,?)').run(id,record?'legacy':'legacy-invalid',JSON.stringify(record||{line:i+1,raw:line}));
    }
  }
  report(key, settings, now) { return evaluate(this.all('paper').filter(r=>r.modelKey===key && !r.legacy),settings,now); }
  async resolve(client, fees) {
    for(const intent of this.all('intent').filter(r=>r.status==='confirmed' && r.filled>0 && !r.closed)) {
      try {const {market}=await client.getMarket(intent.ticker);if(['settled','finalized'].includes(market?.status)){intent.closed=true;this.put(intent.id,'intent',intent);}}
      catch(e){this.log({type:'intent-resolution-error',ticker:intent.ticker,reason:e.message});}
    }
    for (const r of this.all('paper').filter(r=>!r.resolvedAt && Date.parse(r.closeTime)<=Date.now())) {
      try {
        const {market:m}=await client.getMarket(r.ticker);
        if (!['settled','finalized'].includes(m?.status) || !['yes','no'].includes(m.result)) continue;
        r.result=m.result; r.outcome=Number(r.side===m.result); r.resolvedAt=Date.now();
        r.grossPnl=r.quantity*(r.outcome-r.price);
        r.settlementFee=r.outcome*r.quantity*(r.settlementFeePerContract ?? fees.settlementFeePerContract ?? 0);
        r.netPnl=r.grossPnl-r.entryFee-r.settlementFee;
        this.put(r.id,'paper',r);
      } catch (e) { this.log({type:'resolution-error',ticker:r.ticker,reason:e.message,ts:new Date().toISOString()}); }
    }
  }
}
module.exports = { Journal };
