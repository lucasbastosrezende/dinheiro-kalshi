'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateLeg, maxContractsForBudget, orderCostDollars, tradingFeeDollars } = require('../lib/analytics');
const { AutoTrader } = require('../lib/autotrader');

const fees = { tradingFeeRate: 0.07, settlementFeePerContract: 0 };
const market = { yesAsk: 0.20, yesBid: 0.19, noAsk: 0.80, noBid: 0.79 };

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`);
}

test('taxa segue a tabela da Kalshi e arredonda o lote inteiro', () => {
  assert.equal(tradingFeeDollars(0.20, 1, 0.07), 0.02);
  assert.equal(tradingFeeDollars(0.50, 100, 0.07), 1.75);
  assert.equal(orderCostDollars(0.20, 10, fees), 2.12);
});

test('ordem de US$ 4,18 a 99c reproduz 4,21 contratos e US$ 4,21 de payout', () => {
  const count = maxContractsForBudget(0.99, 4.18, fees);

  assert.equal(count, 4.21);
  closeTo(orderCostDollars(0.99, count, fees), 4.1779);
});

test('retorno esperado e retorno se ganhar usam o custo com taxa', () => {
  const leg = evaluateLeg({ side: 'yes', market, modelProbYes: 0.264, fees });

  // 20c + 2c de taxa = 22c; o contrato vencedor paga 1 dolar.
  closeTo(leg.entryCostPerContract, 0.22);
  closeTo(leg.breakevenProb, 0.22);
  closeTo(leg.evDollars, 0.044);
  closeTo(leg.evPct, 0.2);
  closeTo(leg.winReturnPct, 0.78 / 0.22);
  closeTo(leg.maxLossPerContract, 0.22);
  closeTo(leg.maxGainPerContract, 0.78);
});

test('taxa de um centavo pode zerar o retorno de uma compra a 99c', () => {
  const leg = evaluateLeg({ side: 'yes', market: { yesAsk: 0.99, yesBid: 0.98 }, modelProbYes: 0.999, fees });

  closeTo(leg.entryCostPerContract, 1);
  closeTo(leg.breakevenProb, 1);
  closeTo(leg.evPct, -0.001);
  closeTo(leg.winReturnPct, 0);
});

test('retorno e taxa por contrato continuam corretos em lote', () => {
  const leg = evaluateLeg({ side: 'yes', market, modelProbYes: 0.264, fees, sizeContracts: 10 });

  closeTo(leg.feePerContract, 0.012);
  closeTo(leg.entryCostPerContract, 0.212);
  closeTo(leg.maxLossPerContract, 0.212);
  closeTo(leg.maxGainPerContract, 0.788);
});

test('dimensionamento nao promete contrato que estoura o orcamento com taxa', () => {
  const config = {
    fees,
    auto: {
      mode: 'normal',
      dryRun: true,
      maxOpenNotionalTotal: 0.21,
      maxNotionalPerOrder: 0.21,
      maxContractsPerOrder: 10,
      kellyFraction: 1,
    },
  };
  const trader = new AutoTrader({ hasCredentials: () => false }, config);
  const size = trader.sizeOrder({ price: 0.20, kelly: 1 });

  assert.equal(size.contracts, 0.95);
  closeTo(size.estimatedCost, 0.21);
});
