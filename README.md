# Painel de Apostas no Bitcoin (Kalshi)

Um painel que roda no seu computador e analisa **todas as apostas** de um evento de Bitcoin da Kalshi
(por padrão o de 6 de setembro, `KXBTCD-26SEP0617`). Ele calcula a chance real de cada aposta dar
certo, compara com o preço que está sendo cobrado e monta uma lista das **mais seguras** e das que
**mais valem a pena**.

Também tem um modo em que o programa aposta sozinho. Ele é opcional, vem desligado e vem em modo
teste.

---

## Como usar

Você só precisa do Node.js versão 18 ou mais nova. Não precisa instalar mais nada.

```bash
node server.js
```

Depois abra <http://localhost:8787> no navegador.

Os preços da Kalshi e o preço do Bitcoin são públicos, então o painel funciona na hora, sem cadastrar
conta nenhuma. Sem conta cadastrada ele só analisa — não vê seu saldo nem consegue apostar.

### Tudo se atualiza sozinho

Não existe botão de atualizar. A tela nunca fica perguntando se tem novidade: quem avisa é o
servidor, por uma conexão que fica aberta o tempo todo.

- **Preço do Bitcoin:** chega por WebSocket da Binance, negócio a negócio, em milissegundos. Se a
  Binance cair, ele passa para a Coinbase sozinho, e se as duas caírem volta a consultar por HTTP.
- **Preços da Kalshi:** a Kalshi só aceita WebSocket para quem tem conta cadastrada, então o painel
  consulta as 80 faixas a cada 0,75 segundo numa chamada só. Ele compara com a leitura anterior e só
  reprocessa quando algum preço realmente mudou. Dá para deixar mais rápido ou mais devagar na aba
  Ajustes.
- **Da conta até a tela:** cada nova leitura vira uma atualização empurrada na hora, cerca de 2 a 3
  vezes por segundo. As tabelas são redesenhadas no máximo uma vez por segundo, para você conseguir
  ler e clicar sem a tela pulando embaixo do dedo.

No canto direito do cabeçalho o painel mostra o tempo de resposta de cada fonte, e a bolinha verde
pisca a cada dado novo. Se a conexão cair, ela fica vermelha e volta sozinha quando o servidor
retornar.

---

## Entendendo a aposta em 30 segundos

Cada aposta pergunta: **o Bitcoin vai encerrar acima de um certo preço?**

- Existem 80 preços de referência, de US$ 69.500 até US$ 87.750.
- Em cada um você escolhe **vai passar** (encerra acima) ou **não passa** (encerra abaixo).
- Um contrato custa entre US$ 0,01 e US$ 0,99. Se você acertar, ele vira **US$ 1,00**. Se errar,
  vira **zero** — não existe perda parcial.
- O preço já é a chance: pagar US$ 0,70 é o mercado dizendo que há 70% de chance de dar certo.
- O resultado sai da média do preço do Bitcoin nos 60 segundos antes do encerramento, usando o índice
  BRTI da CF Benchmarks. Não é o preço de uma corretora específica.

---

## O que tem em cada aba

**Resumo** — os números gerais do dia e as duas listas que mais importam: as 5 apostas mais seguras e
as 5 que mais valem a pena. Embaixo, a explicação de como a aposta funciona e a regra oficial
traduzida.

**Melhores apostas** — a lista completa: 160 apostas (as duas opções em cada um dos 80 preços). Para
cada uma o painel mostra quanto custa, a chance que o mercado dá, a chance calculada aqui, a vantagem
entre as duas, quanto rende se der certo, quanto se perde se errar, quanto vale a pena apostar e as
notas de segurança e geral. Dá para ordenar por qualquer um desses critérios. Passando o mouse no
título de cada coluna aparece a explicação dela.

**Todas as faixas** — os 80 preços com as ofertas de compra e venda dos dois lados. Clicando numa
linha abre o detalhe daquela faixa com as ofertas ao vivo.

**Gráficos** — o que o mercado acha comparado com o que a conta calcula, onde o mercado acha que o
preço vai parar, a vantagem em cada faixa e o Bitcoin nas últimas 6 horas.

**Lucro garantido** — combinações de apostas que rendem dinheiro dê no que der. Aparecem raramente e
somem em segundos.

**Apostar sozinho** — o modo automático, explicado mais abaixo.

**Ajustes** — mudar como a conta é feita, os pesos das notas, os filtros mínimos, e ver seu saldo se
a conta estiver cadastrada. Tem também um dicionário com todas as palavras usadas no painel.

---

## Como a chance é calculada

O painel supõe que o Bitcoin anda de forma parecida com o que ele vem andando, sem tendência para
cima nem para baixo (que é a suposição padrão para poucas horas à frente). Com o preço de agora, o
tempo que falta e o tamanho normal das oscilações, dá para calcular a chance de ele terminar acima de
qualquer preço.

O tamanho das oscilações vem de dois lugares:

1. **O que o Bitcoin fez de verdade** — quanto ele balançou nos últimos minutos, dando mais peso para
   os minutos mais recentes.
2. **O que o mercado espera** — o painel procura o tamanho de oscilação que melhor explica os preços
   de todas as 80 faixas ao mesmo tempo.

Por padrão ele mistura os dois (35% do primeiro, 65% do segundo). Assim ele não fica nervoso com um
minuto agitado nem simplesmente copia o mercado. Nos Ajustes dá para usar só um dos dois — usando só
o primeiro, o painel discorda mais do mercado e as vantagens exibidas ficam maiores, porém com menos
base.

Todos os números já descontam a taxa da Kalshi. Ela é maior perto de US$ 0,50 e menor nos extremos —
por isso apostas quase certas quase não pagam taxa, enquanto apostas em torno de meio a meio precisam
de bem mais vantagem para compensar.

---

## Os três modos

O painel tem três modos de agir, escolhidos na aba **Apostar sozinho**:

| Modo | O que ele faz |
| --- | --- |
| **Normal** | Só analisa e mostra as melhores apostas. Nunca aposta nem sugere. **É o modo padrão.** |
| **Semiautomático** | Ele procura a aposta e mostra um cartão com todos os números. Só acontece alguma coisa se você clicar em aprovar. |
| **Totalmente automático** | Ele aposta sozinho, sem perguntar. Exige digitar a frase de confirmação para ligar. |

Além do modo existe o **modo teste**, que vem ligado e vale para os três: com ele ligado, nada é
enviado para a Kalshi — nem quando você aprova uma sugestão. O programa apenas anota no arquivo
`data/auto-trade-log.jsonl` o que teria feito. É assim que dá para testar o fluxo inteiro sem risco.

### O caminho recomendado para ir testando

1. Fique no **normal** por um tempo e compare as sugestões da lista com o que o mercado fez depois.
2. Passe para o **semiautomático** com o modo teste ligado. Você vai receber cartões de sugestão e
   pode aprovar à vontade — tudo é simulado, nada custa dinheiro.
3. Quando confiar no comportamento, cadastre a conta e desligue o modo teste. Aí o botão de aprovar
   passa a dizer "Aprovar e apostar de verdade", e pede uma confirmação a mais antes de enviar.
4. O **totalmente automático** só depois disso, e sabendo que ele não pergunta nada.

### Como funciona o cartão de sugestão

Cada sugestão mostra a faixa, o tipo de aposta, quantos contratos ele compraria, a que preço, quanto
gastaria, a chance de acerto, quanto precisa para empatar, a vantagem, o retorno esperado, quanto
ganha se acertar e quanto perde se errar.

Ela vale **45 segundos** (ajustável). Se você não responder, ela vence sozinha e nada é enviado —
porque o preço que fazia aquela aposta valer a pena já mudou.

Ao aprovar, o programa **confere tudo de novo com o preço daquele instante**:

- Se o preço subiu enquanto você decidia, ele **cancela** e avisa. Nunca paga mais caro do que o que
  você aprovou. Se o preço caiu, ele aproveita o preço melhor.
- Se qualquer limite de segurança passou a reprovar, ele cancela.
- Confere seu saldo antes de tentar.
- A mesma sugestão nunca vira duas ordens, mesmo com clique duplo ou resposta perdida no caminho: o
  identificador da sugestão vai junto com a ordem.
- A ordem é enviada como "executa agora ao meu preço ou cancela". Ela nunca fica parada na Kalshi
  esperando, com um preço que já envelheceu.

### Para valer dinheiro de verdade

1. Criar uma chave de acesso na sua conta da Kalshi. O código dela já está em `credentials.json`;
   falta salvar o arquivo da chave privada como `kalshi-private-key.pem` na pasta do projeto.
2. Escolher semiautomático ou totalmente automático.
3. Desligar o modo teste digitando exatamente `QUERO APOSTAR DE VERDADE`.

Enquanto o arquivo `.pem` não existir, o painel se recusa a sair do modo teste e diz isso na tela.

### Duas travas que valem repetir

- **O totalmente automático nunca volta ligado sozinho.** Se o servidor reiniciar com ele ativo, o
  painel rebaixa para semiautomático e registra o motivo. Quem religa é uma pessoa, digitando a frase.
- **Toda ordem passa por uma conferência final** antes de sair: faixa, tipo de aposta, quantidade
  inteira, preço entre US$ 0,01 e US$ 0,99, custo dentro do teto por aposta e dentro do teto total.
  Qualquer número fora do lugar cancela o envio e vira uma linha no histórico.

### Limites de segurança

Uma aposta só é feita se passar em **todos** os limites abaixo. Se qualquer um reprovar, o programa
fica parado — e anota o motivo em português na tela.

| Limite | Padrão | O que faz |
| --- | --- | --- |
| Vantagem mínima | 6 pontos | só aposta se a conta discordar bastante do mercado |
| Chance mínima | 80% | não aposta em nada abaixo disso |
| Nota mínima | 60 | de 0 a 100 |
| Contratos por aposta | 10 | teto de quantidade |
| Dólares por aposta | US$ 25 | teto de uma aposta só |
| Dólares no total | US$ 100 | teto de tudo somado |
| Apostas por hora | 4 | para ele não sair apostando demais |
| Parar antes do fim | 5 minutos | não aposta no sufoco |
| Não apostar cedo demais | 12 horas | espera chegar mais perto do encerramento |
| Prudência no tamanho | um quarto | usa 25% do que a matemática indicaria |
| Espera na mesma faixa | 10 minutos | evita repetir a mesma aposta |
| Validade da sugestão | 45 segundos | depois disso ela vence sozinha |
| Sugestões esperando | 1 | não enche a tela de cartões |

O tamanho de cada aposta é o menor valor entre o que a matemática indica, o teto em dólares e o teto
de contratos.

Antes de ligar qualquer coisa, olhe a tabela **"O que ele faria agora"**: ela mostra as melhores
apostas do momento, quantos contratos ele compraria, quanto gastaria e, em português, por que ele
recusou cada uma. O botão "Ver o que ele faria agora" força uma verificação na hora, respeitando o
modo teste e todos os limites.

---

## Arquivos do projeto

```
server.js              o servidor que roda no seu computador e empurra os dados para a tela
config.json            todas as configurações salvas
credentials.json       o código da sua chave da Kalshi (fica fora do controle de versão)
kalshi-private-key.pem sua chave privada — você precisa criar este arquivo
lib/kalshi.js          conversa com a Kalshi e busca o preço do Bitcoin
lib/streams.js         as fontes ao vivo: WebSocket do Bitcoin e leitura contínua da Kalshi
lib/analytics.js       toda a matemática: chances, retorno, taxas, notas
lib/autotrader.js      o robô que aposta sozinho, com os limites de segurança
public/                a tela do painel
data/                  o caderno onde o robô anota tudo que fez
```

Para analisar outro evento, troque o `eventTicker` no `config.json` (ou na aba Ajustes). Qualquer
evento de faixas de preço do Bitcoin funciona — o código do evento aparece no endereço da página da
Kalshi.

---

## Antes de colocar dinheiro, leia

Uma aposta errada perde **tudo**. Não existe sair no meio com prejuízo pequeno: o contrato vira zero.
Uma aposta de US$ 0,98 com 99% de chance ainda erra 1 vez a cada 100 — e o ganho de 2% das outras 99
vezes não cobre essa perda se a conta estiver calibrada errada.

E a conta pode estar errada justamente nas apostas que parecem mais seguras. O Bitcoin dá pulos
maiores e mais frequentes do que qualquer fórmula prevê. As apostas de preço distante, que aparecem
com 99% de chance, são exatamente as mais sensíveis a esse erro.

Este é um painel de análise, não é conselho de investimento. As apostas feitas pelo modo automático
são responsabilidade de quem o liga.
