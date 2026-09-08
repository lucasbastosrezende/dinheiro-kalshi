'use strict';
const mean = xs => xs.length ? xs.reduce((a,b) => a+b,0)/xs.length : null;
function evaluate(records, settings = {}, now = Date.now()) {
  // First decision per event: correlated strikes and repeated decisions never inflate N.
  const events = new Map();
  for (const r of records.slice().sort((a,b) => a.timestamp-b.timestamp)) {
    if (!r.eventTicker || !r.resolvedAt || r.resolvedAt > now || !(r.timestamp < Date.parse(r.closeTime)) ||
        !(r.timestamp < r.resolvedAt) || ![0,1].includes(r.outcome) ||
        !Number.isFinite(r.modelProb) || !Number.isFinite(r.impliedProb) || !Number.isFinite(r.netPnl)) continue;
    if (!events.has(r.eventTicker)) events.set(r.eventTicker,r);
  }
  const rows = [...events.values()].sort((a,b) => a.resolvedAt-b.resolvedAt);
  const bins = Array.from({length:10},(_,i) => {
    const rs = rows.filter(r => Math.min(9,Math.floor(r.modelProb*10)) === i);
    return { lower:i/10, upper:(i+1)/10, count:rs.length, predicted:mean(rs.map(r=>r.modelProb)), observed:mean(rs.map(r=>r.outcome)) };
  });
  const brier = mean(rows.map(r => (r.modelProb-r.outcome)**2));
  const marketBrier = mean(rows.map(r => (r.impliedProb-r.outcome)**2));
  const calibrationError = rows.length ? bins.reduce((s,b) => s+b.count*Math.abs((b.predicted||0)-(b.observed||0)),0)/rows.length : null;
  let equity=0, peak=0, maxDrawdown=0;
  for (const r of rows) { equity+=r.netPnl; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,peak-equity); }
  const returns=rows.map(r => r.netPnl/r.cost).filter(Number.isFinite), avg=mean(returns);
  const sd=returns.length>1 ? Math.sqrt(returns.reduce((s,r)=>s+(r-avg)**2,0)/(returns.length-1)) : 0;
  const groups = field => Object.fromEntries([...new Set(rows.map(field))].map(k => {
    const rs=rows.filter(r=>field(r)===k); return [k,{ count:rs.length, brier:mean(rs.map(r=>(r.modelProb-r.outcome)**2)), netPnl:rs.reduce((s,r)=>s+r.netPnl,0) }];
  }));
  const validated = rows.length >= (settings.minEvents ?? 200) && brier <= (settings.maxBrier ?? 0.2) &&
    calibrationError <= (settings.maxCalibrationError ?? 0.05) && brier <= marketBrier-(settings.minBrierImprovement ?? 0.005);
  return { observations:rows.length, rawRecords:records.length, hitRate:mean(rows.map(r=>Number((r.modelProb>=0.5)===(r.outcome===1)))),
    brier, marketBrier, calibration:bins, calibrationError, netReturn:equity, maxDrawdown,
    sharpePerEvent:sd>0 ? avg/sd : null, modelValidated:validated,
    byProbability:groups(r=>String(Math.min(9,Math.floor(r.modelProb*10))/10)),
    byHorizon:groups(r=>r.minutesToClose<60?'under1h':r.minutesToClose<1440?'1h-1d':'over1d'),
    byLiquidity:groups(r=>r.availableQuantity<10?'under10':r.availableQuantity<100?'10-100':'over100'),
    byKind:groups(r=>r.kind) };
}
module.exports = { evaluate };
