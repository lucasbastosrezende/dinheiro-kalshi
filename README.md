# Dashboard de Bitcoin na Kalshi

## Precisão e execução: versão 2

**Fórmula disponível não significa previsão validada.** `modelSupported` exige configuração explícita da série/evento, tipo de strike reconhecido e correspondência de `rules_primary`. `modelValidated` exige pelo menos 200 eventos resolvidos da mesma versão/configuração, fonte e tipo de contrato, Brier ≤ 0,20, erro de calibração ≤ 0,05 e melhora de Brier ≥ 0,005 sobre o mercado. `modelReliable` é a conjunção dos dois. Nenhum desses critérios garante lucro futuro.

Paper trading permite investigar modelos suportados ainda não validados; sugestões são simulações enquanto dry run estiver ligado. Contratos desconhecidos não geram sugestões nem simulações. O modo real exige validação e BRTI. Toda inicialização restaura dry run; full exige novamente a confirmação existente. A configuração distribuída usa `normal` e `dryRun: true`.

### Regras, custos e incerteza

- `contracts.series` e `contracts.events` definem modelos, tipos permitidos, termos obrigatórios das regras e janela de liquidação. Eventos têm precedência. A regra KXBTCD foi conferida na API em 08/09/2026: média dos sessenta segundos de BRTI. Outras séries ficam bloqueadas até configuração explícita. Correspondência de termos é uma barreira adicional, não interpretação jurídica automática.
- O baseline lognormal sem drift continua disponível para above, below e range. O intervalo de sensibilidade usa volatilidade realizada, implícita, estresses de 0,75×/1,25× e margem adicional de 10 pontos percentuais. **Não é um intervalo de confiança estatístico.** O modelo ainda aproxima o preço final e não reproduz exatamente a distribuição da média dos 60 segundos. Histórico real deve validar essa aproximação; não há garantia de assertividade.
- EV e Kelly usam custo com taxa de entrada arredondada por lote. Spread vem do livro; ask é o complemento do bid oposto, com a quantidade desse nível. O preço não pode piorar em relação ao aprovado. A ordem final verifica novamente custo e EV conservador para a quantidade efetiva. A taxa de saída imediata é calculada por lote e exibida no custo de ida e volta.
- A estratégia executável é manter até a liquidação. `strategy.exitMode` diferente de `settlement` bloqueia execução: uma probabilidade de liquidação não fornece o preço esperado de uma venda antecipada. Assim, não se promete EV de saída antes do vencimento sem esse modelo.
- Ordens reais usam fill-or-kill e preço limite; paper exige quantidade integral no melhor nível. Respostas parciais são registradas pela quantidade preenchida. A resposta v2 não promete preço médio: o sistema reserva custo pelo limite aprovado, sem inventar preço de fill. P&L real exato deve ser consultado no portfólio/fills da Kalshi.

### Persistência, exposição e histórico

`data/trading.sqlite` usa WAL, transações SQLite por gravação e sincronização FULL. `auto-trade-log.jsonl` é importado de forma idempotente e preservado. Linhas inválidas são arquivadas; registros antigos incompletos não viram evidência estatística. Logs novos são gravados primeiro em SQLite; falha nessa gravação impede envio. Faça backup consistente do banco com o servidor parado, incluindo os arquivos WAL/SHM se existirem.

Posições, saldo e todas as páginas de ordens resting são consultados no início e a cada 30 s com credenciais. Antes de cada ordem real ocorre outra consulta. A exposição usa o valor informado das posições mais taxas pagas; sem esses campos, reserva responsabilidade binária máxima e taxa. Ordens abertas reservam responsabilidade máxima mais taxa. Intenções confirmadas mantêm reserva adicional até a liquidação para cobrir atraso da API; isso pode contar exposição duas vezes e bloquear cedo. É deliberadamente conservador.

Há tetos total, por evento e por direção BTC (up/down; range e formato desconhecido contam como mistos). Uma segunda aposta correlacionada no mesmo evento é recusada independentemente da distância entre strikes. Paper mantém exposição própria, liberada na resolução. Intenções de envio são persistidas antes da chamada à API. Timeout/resposta incompleta deixa estado `unknown`, que bloqueia novos envios reais inclusive após reinício. Nesse caso confira client_order_id, ordens e fills na Kalshi antes de qualquer intervenção no registro; não há repetição automática.

Cada simulação armazena timestamp, configuração/versão, fonte/idades, regra, prazo individual, preço, spread, taxa, quantidade, probabilidade do modelo e implícita, intervalo, edge, EV, motivo e posteriormente resultado/P&L bruto e líquido. A rotina de resolução consulta resultado oficial settled/finalized a cada 60 s. Ausência de resultado não é derrota nem vitória. Reinicie o servidor após editar parâmetros diretamente no arquivo.

### Métricas e comparação histórica

Abra **Operações → Validação do modelo e paper trading** ou `GET /api/evaluation`. A avaliação usa a primeira decisão por evento, ignorando repetições e strikes correlacionados; exclui resultados ainda indisponíveis na data de corte. Calcula acerto da classe prevista (probabilidade ≥ 50%), Brier, dez faixas de calibração, erro absoluto ponderado de calibração, soma do P&L líquido, drawdown absoluto em dólares e Sharpe não anualizado dos retornos por evento. P&L agregado dessas métricas usa essa amostra independente, não todas as apostas da conta. Segmentações: probabilidade, prazo, liquidez e tipo.

`GET /api/evaluation/compare` compara realizada/implícita/blend usando snapshots anteriores à decisão, velas completas disponíveis naquela hora e as mesmas operações resolvidas. É comparação pareada das probabilidades; o P&L é o das operações observadas, não um backtest de novas políticas de seleção. Escolher parâmetros olhando esses resultados não valida a configuração: é necessária nova amostra prospectiva. Mudanças de modelo, taxas, regras, fontes ou política de risco alteram o identificador e reiniciam a evidência. Não se importam dados históricos artificiais.

### Parâmetros novos em config.json

| Parâmetro | Padrão e motivo |
| --- | --- |
| safety.maxSpotAgeMs / maxMarketAgeMs / maxAnalysisAgeMs | 5000 ms; barreira operacional, não garantia de qualidade |
| safety.maxPortfolioAgeMs | 10000 ms; consulta completa pode demandar mais de uma chamada |
| safety.reconcileIntervalMs | 30000 ms; reconciliação periódica além da final |
| auto.maxEventNotional / maxDirectionNotional | US$ 25 / US$ 50; limites conservadores ajustáveis |
| model.probabilityUncertainty | 0,10; margem exploratória, precisa calibração real |
| model.volStressLow / volStressHigh | 0,75 / 1,25; análise de sensibilidade |
| model.fallbackVolAnnual | 0,50; baseline sem histórico, não estimativa validada |
| validation.minEvents / maxBrier / maxCalibrationError / minBrierImprovement | 200 / 0,20 / 0,05 / 0,005; limiares exploratórios configuráveis |
| priceSources.priority / requireBRTIForReal | BRTI, Coinbase, Binance / true |
| paper.resolutionIntervalMs | 60000 ms |

Pesos de ranking e constantes numéricas do baseline não são parâmetros calibrados; a nota visual não decide validação estatística. Sem amostra histórica suficiente, o bloqueio real é o resultado correto.

### Documentação de API conferida

- [Kalshi CF Benchmarks passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough) e [CF latest_values](https://docs.cfbenchmarks.com/api/rest/latest-values/): entitlement e timestamp do índice.
- [Kalshi orderbook](https://docs.kalshi.com/api-reference/market/get-market-orderbook), [ordem v2](https://docs.kalshi.com/api-reference/orders/create-order-v2) e [posições](https://docs.kalshi.com/api-reference/portfolio/get-positions): tipos fixed point, paginação e resposta de fill.
- [Coinbase ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker) e [Binance market data](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints): preço e timestamp dos fallbacks.

Painel local para acompanhar mercados de Bitcoin da Kalshi, comparar o preço do mercado com uma estimativa probabilística e, opcionalmente, simular ou enviar ordens.

O projeto é independente e não é recomendação de investimento. Uma aposta vencedora paga conforme as regras do mercado; uma aposta perdida pode consumir todo o custo da ordem.

## Visão geral

O painel analisa o evento de Bitcoin selecionado em `config.json` e mantém a tela atualizada sem recarregar a página.

- **Mercado**: comparação de oportunidades, custos, chances, retorno esperado, faixas, livro de ofertas, gráficos, arbitragem e regra de resolução.
- **Operações**: modos de análise, semiautomático e totalmente automático, além do modo teste, limites, prévias, sugestões e histórico.
- **Ajustes**: parâmetros do modelo, conta/carteira da Kalshi e guia de conceitos.
- **Tema**: noturno, claro ou sistema, salvo localmente no navegador.

### Fonte dos dados

A análise prioriza CF Benchmarks BRTI pelo passthrough autenticado da Kalshi. Sem acesso ou com dado vencido, usa Coinbase BTCUSD e depois Binance BTCUSDT, identificados como fallback. A idade vem do timestamp da fonte, não da hora de recebimento. Por padrão dinheiro real exige BRTI.

O gráfico continua usando exclusivamente o evento selecionado na Kalshi. Preço de referência do modelo e gráfico são fluxos distintos. Um gráfico indisponível não autoriza trocar seu histórico por outro evento.

## Como executar

Requisitos:

- Node.js 22.13 ou mais recente (SQLite nativo; testado em 22.23.1);
- acesso à internet para consultar a Kalshi;
- uma porta local livre, por padrão `8787`.

Não há dependências externas no `package.json`.

```bash
npm test
npm start
```

Depois, abra <http://localhost:8787>.

Também é possível iniciar diretamente:

```bash
node server.js
```

Para encerrar, pressione `Ctrl+C` no terminal do servidor.

## Escolher o mercado

Use **Explorar mercados** no cabeçalho para listar os eventos abertos de Bitcoin e selecionar um. A escolha também pode ser feita diretamente em `config.json`:

```json
{
  "eventTicker": "KXBTCD-26SEP0816",
  "seriesTicker": "KXBTCD"
}
```

O `seriesTicker` é atualizado automaticamente quando o evento muda pela interface. O ticker exibido no exemplo é apenas o evento atualmente salvo nesta cópia; eventos encerram e devem ser trocados conforme necessário.

## Como ler os cálculos

Cada faixa oferece os dois lados do contrato: **vai passar** (`yes`) e **não vai passar** (`no`). O preço de entrada fica entre US$ 0,01 e US$ 0,99; um contrato vencedor paga US$ 1,00, descontada eventual taxa de liquidação.

O custo da ordem é calculado para o lote inteiro:

```text
custo = preço × contratos + taxa de negociação arredondada
```

O dimensionamento aceita centésimos de contrato e procura a maior quantidade que cabe no orçamento já com a taxa. A tabela separa deliberadamente:

- `orderCost`: custo total da ordem;
- `maxPayout`: pagamento máximo se todos os contratos vencerem;
- `maxGain`: pagamento menos custo;
- `maxLoss`: custo total se a aposta perder;
- `evPct`: retorno esperado sobre o custo da ordem;
- `winReturnPct`: retorno líquido se a ordem vencer;
- `evPctCapital` e `winReturnPctCapital`: os mesmos retornos compostos com a valorização do capital informado.

As chances são estimativas do modelo, não garantias de resultado ou de execução. Filtros de nota, liquidez e retorno não garantem que uma ordem será preenchida.

## Operações e modo teste

Há três modos de operação:

| Modo | Comportamento |
| --- | --- |
| **Somente análise** | Calcula e exibe oportunidades; não cria sugestões nem ordens. |
| **Semiautomático** | Cria uma sugestão temporária para aprovação manual. |
| **Totalmente automático** | Tenta enviar ordens sem aprovação individual. |

O **modo teste** (`dryRun`) deve permanecer ligado durante a validação. Com ele ligado, nenhuma ordem é enviada à Kalshi; o sistema registra operações completas em SQLite e mantém o log JSONL para compatibilidade.

Para operar com dinheiro real, são exigidos todos estes passos:

1. cadastrar as credenciais da conta;
2. confirmar o modo totalmente automático ou desligar o modo teste digitando exatamente `QUERO APOSTAR DE VERDADE`;
3. revisar limites, saldo, preço e quantidade antes de liberar a operação.

O modo totalmente automático nunca é restaurado sozinho depois de um reinício: o servidor o rebaixa para semiautomático por segurança. Cada ordem passa por uma conferência final de preço, quantidade, custo por ordem e limite total. As ordens enviadas usam `fill_or_kill`.

## Credenciais da Kalshi

A leitura pública funciona sem conta. Portfolio, saldo e envio de ordens precisam de `apiKeyId` e chave privada RSA.

Crie `credentials.json` na raiz — ele está no `.gitignore` — sem colocar segredos no Git:

```json
{
  "apiKeyId": "SEU_API_KEY_ID",
  "privateKeyPath": "kalshi-private-key.pem",
  "environment": "prod"
}
```

O arquivo `kalshi-private-key.pem` também é ignorado. O ambiente pode ser `prod` ou `demo`. Como alternativa, use as variáveis `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH` e `KALSHI_ENV`.

Mesmo com credenciais configuradas, o modo teste continua sendo a proteção padrão para não enviar ordens acidentalmente.

## Configuração principal

Os valores persistidos ficam em `config.json` e também podem ser alterados pela interface.

| Grupo | O que controla |
| --- | --- |
| `eventTicker` | Evento Kalshi analisado. |
| `port` | Porta do servidor local. |
| `model` | Fonte e janela da volatilidade, meia-vida, mistura e limites da estimativa. |
| `fees` | Taxas de negociação e liquidação usadas nos cálculos. |
| `ranking` | Pesos de vantagem, segurança, liquidez e Kelly, além dos filtros mínimos. |
| `auto` | Modo, modo teste, validade de sugestões, limites de risco e dimensionamento. |
| `pollIntervalMs` | Intervalo mínimo de consulta das faixas e ofertas da Kalshi. |
| `autoCheckSeconds` | Frequência de avaliação do robô quando ele está habilitado. |
| `capital` | Capital inicial e capital atual usados nos indicadores compostos. |

O painel salva alterações feitas em **Ajustes** no próprio `config.json`.

## Endpoints locais úteis

São endpoints internos usados pela interface:

| Endpoint | Função |
| --- | --- |
| `GET /api/analysis` | Análise completa atual, depois que os dados ficam prontos. |
| `GET /api/stream` | Fluxo SSE das atualizações do painel. |
| `GET /api/btc-history` | Histórico do gráfico do evento Kalshi selecionado. |
| `GET /api/btc-board` | Lista de mercados de Bitcoin disponíveis para seleção. |
| `GET /api/orderbook?ticker=...` | Livro de ofertas de uma faixa. |
| `GET /api/portfolio` | Saldo, posições e ordens; exige credenciais. |
| `GET /api/auto/preview` | Prévia do que o robô faria sem enviar ordens. |

## Estrutura do projeto

```text
server.js             servidor HTTP, SSE e API local
config.json           configuração persistida
lib/kalshi.js         cliente público/privado da Trade API v2
lib/streams.js        gráfico do evento selecionado e atualização das faixas
lib/analytics.js      probabilidades, taxas, retorno, ranking e dimensionamento
lib/autotrader.js     limites, sugestões, modo teste e envio de ordens
lib/execution.js      atualização final e intenção durável de envio
lib/prices.js         BRTI e fontes alternativas com timestamp
lib/safety.js         regras explícitas, validade e livro executável
lib/portfolio.js      reconciliação e limites de exposição
lib/journal.js        SQLite, migração e resolução de paper
lib/evaluation.js     métricas agrupadas por evento
lib/backtest.js       comparação pareada de configurações
lib/btcboard.js       catálogo de eventos de Bitcoin para seleção
public/index.html     estrutura da interface
public/app.js         estado, renderização e chamadas da interface
public/style.css      layout, responsividade e temas
public/theme.js       persistência do tema claro/noturno/sistema
test/                 testes automatizados
data/                 logs locais do robô; não entram no Git
```

## Testes e validação

Execute os testes automatizados com:

```bash
npm test
```

Para uma verificação rápida adicional:

```bash
node --check server.js
node --check lib/analytics.js
node --check lib/autotrader.js
node --check lib/kalshi.js
node --check lib/streams.js
node --check public/app.js
git diff --check
```

Com o servidor em execução, a validação HTTP mínima é abrir o painel e conferir se o evento selecionado, o preço do Bitcoin, o contador e a tabela de oportunidades deixam o estado de carregamento.

## Segurança e responsabilidade

- Nunca versione `credentials.json`, arquivos `.pem` ou dados de conta.
- Comece e valide sempre com `dryRun: true`.
- Não desligue o modo teste sem revisar o evento, o saldo e os limites.
- Uma chance estimada não elimina risco de modelo, liquidez, latência ou execução.
- Este software é uma ferramenta de análise e automação; a decisão e a responsabilidade financeira são do operador.
