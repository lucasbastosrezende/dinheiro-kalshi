# Dashboard de Bitcoin na Kalshi

Painel local para acompanhar mercados de Bitcoin da Kalshi, comparar o preço do mercado com uma estimativa probabilística e, opcionalmente, simular ou enviar ordens.

O projeto é independente e não é recomendação de investimento. Uma aposta vencedora paga conforme as regras do mercado; uma aposta perdida pode consumir todo o custo da ordem.

## Visão geral

O painel analisa o evento de Bitcoin selecionado em `config.json` e mantém a tela atualizada sem recarregar a página.

- **Mercado**: comparação de oportunidades, custos, chances, retorno esperado, faixas, livro de ofertas, gráficos, arbitragem e regra de resolução.
- **Operações**: modos de análise, semiautomático e totalmente automático, além do modo teste, limites, prévias, sugestões e histórico.
- **Ajustes**: parâmetros do modelo, conta/carteira da Kalshi e guia de conceitos.
- **Tema**: noturno, claro ou sistema, salvo localmente no navegador.

### Fonte dos dados

O preço e o histórico do Bitcoin vêm exclusivamente do gráfico em tempo real do evento Kalshi selecionado. O painel não substitui essa fonte por Binance, Coinbase ou outro preço externo.

As faixas e ofertas do mercado são lidas pela API pública da Kalshi. O servidor recalcula a análise e envia atualizações ao navegador por Server-Sent Events (SSE).

Se o gráfico do evento selecionado estiver encerrado, incompatível ou desatualizado, a análise é interrompida até os dados corretos voltarem. Isso evita mostrar números de um evento diferente.

## Como executar

Requisitos:

- Node.js 18 ou mais recente;
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

O **modo teste** (`dryRun`) deve permanecer ligado durante a validação. Com ele ligado, nenhuma ordem é enviada à Kalshi; o sistema apenas registra o que faria em `data/auto-trade-log.jsonl`.

Para operar com dinheiro real, são exigidos todos estes passos:

1. cadastrar as credenciais da conta;
2. confirmar o modo totalmente automático ou desligar o modo teste digitando exatamente `QUERO APOSTAR DE VERDADE`;
3. revisar limites, saldo, preço e quantidade antes de liberar a operação.

O modo totalmente automático nunca é restaurado sozinho depois de um reinício: o servidor o rebaixa para semiautomático por segurança. Cada ordem passa por uma conferência final de preço, quantidade, custo por ordem e limite total. As ordens enviadas usam `immediate_or_cancel`.

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
