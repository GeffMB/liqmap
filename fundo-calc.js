// Cálculo do Painel de fundo (usado pela página fundo.html e pelo relatório do gráfico).
// Fica tudo dentro de uma função para não misturar nomes com a página que carrega o arquivo.
(function(){
"use strict";
const MOEDAS = {BTCUSDT: {nome: "BTC", cm: "btc", etf: "etfBtc"}, ETHUSDT: {nome: "ETH", cm: "eth", etf: "etfEth"}};
const num = (x, d = 2) => (+x).toLocaleString("pt-BR", {minimumFractionDigits: d, maximumFractionDigits: d});
const pct = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d).replace(".", ",") + "%";
const usd = x => { const a = Math.abs(x), s = x < 0 ? "−" : "+"; return s + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : (a / 1e3).toFixed(0) + "K"); };
const pr = p => p >= 1000 ? num(p, 0) : num(p, 2);
async function json(url){ const r = await fetch(url); if (!r.ok) throw new Error(new URL(url).host + " " + r.status); return r.json(); }

// ---------- cálculos ----------
const velasDe = k => k.map(x => ({t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[7]}));
function rsi(c, n = 14){ let g = 0, p = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], a = Math.max(d, 0), b = Math.max(-d, 0);
  if (i <= n) { g += a / n; p += b / n; } else { g = (g * (n - 1) + a) / n; p = (p * (n - 1) + b) / n; } } return p === 0 ? 100 : 100 - 100 / (1 + g / p); }
function ema(a, n){ const k = 2 / (n + 1), out = []; let e = null, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) e = s / n; } else e = x * k + e * (1 - k); out.push(e); }); return out; }
function macdHist(c){ const r = ema(c, 12), l = ema(c, 26), m = c.map((_, i) => r[i] != null && l[i] != null ? r[i] - l[i] : null).filter(x => x != null);
  const s = ema(m, 9); return m.map((x, i) => s[i] == null ? null : x - s[i]).filter(x => x != null).map((h, i, arr) => ({h, m: m[m.length - arr.length + i]})); }

// cada critério devolve {nome, valor, detalhe, regra, st: 2 (✅) | 1 (⚠️) | 0 (✖), porque}
async function calcular(s){
  const M = MOEDAS[s];
  const [kd, kw, fund, oi, fng, flx, mvrv] = await Promise.all([
    json("https://data-api.binance.vision/api/v3/klines?symbol=" + s + "&interval=1d&limit=400").catch(e => e),
    json("https://data-api.binance.vision/api/v3/klines?symbol=" + s + "&interval=1w&limit=500").catch(e => e),
    json("https://fapi.binance.com/fapi/v1/fundingRate?symbol=" + s + "&limit=9").catch(e => e),
    json("https://fapi.binance.com/futures/data/openInterestHist?symbol=" + s + "&period=1d&limit=30").catch(e => e),
    json("https://api.alternative.me/fng/?limit=7").catch(e => e),
    json("fluxos.json?t=" + Math.floor(Date.now() / 6e5)).catch(e => e),
    json("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?" + new URLSearchParams({assets: M.cm, metrics: "CapMVRVCur", frequency: "1d", start_time: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10), page_size: 100})).catch(e => e)
  ]);
  const erro = x => x instanceof Error;
  const out = [];
  const add = (o) => out.push(o);
  const falta = (nome, porque, e) => add({nome, valor: "—", detalhe: "fonte indisponível agora" + (e && e.message ? " (" + e.message + ")" : ""), regra: "", st: -1, porque});
  const D = erro(kd) ? null : velasDe(kd), W = erro(kw) ? null : velasDe(kw);
  const preco = D ? D[D.length - 1].c : null;

  // 1. MVRV
  { const nome = "MVRV abaixo de 1", porque = "Preço de mercado ≤ preço médio pago por todos: a maioria dos investidores está no prejuízo. Historicamente só acontece perto de fundos.";
    const pts = erro(mvrv) ? [] : (mvrv.data || []).filter(x => x.CapMVRVCur != null);
    if (!pts.length) falta(nome, porque, erro(mvrv) ? mvrv : null);
    else { const v = +pts[pts.length - 1].CapMVRVCur; add({nome, valor: num(v), detalhe: "dado de " + new Date(pts[pts.length - 1].time).toLocaleDateString("pt-BR"), regra: "✅ ≤ 1,00 · ⚠️ ≤ 1,30", st: v <= 1 ? 2 : v <= 1.3 ? 1 : 0, porque}); } }

  // 2. Média de 200 semanas
  { const nome = "Preço perto da média de 200 semanas", porque = s === "BTCUSDT"
      ? "A média de ~4 anos (um ciclo inteiro) foi o piso de praticamente todos os fundos do BTC."
      : "No ETH ela é uma referência mais fraca: foi rompida para baixo nos fundos de 2018 e 2022. Vale olhar junto com a do BTC (ao lado), que costuma puxar o mercado.";
    if (!W || W.length < 200 || !preco) falta(nome, porque, erro(kw) ? kw : null);
    else { const c = W.map(x => x.c), m = c.slice(-200).reduce((a, b) => a + b) / 200, d = (preco / m - 1) * 100;
      let extra = "";
      if (s !== "BTCUSDT") {   // mostra o BTC ao lado
        try { const b = velasDe(await json("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=200")).map(x => x.c);
          if (b.length >= 200) extra = " · BTC: " + pct((b[b.length - 1] / (b.reduce((a, x) => a + x) / 200) - 1) * 100) + " da média dele"; } catch (e) {}
      }
      add({nome, valor: pct(d) + " da média", detalhe: "média 200 sem. " + pr(m) + " · preço " + pr(preco) + extra, regra: "✅ até +5% · ⚠️ até +20%", st: d <= 5 ? 2 : d <= 20 ? 1 : 0, porque}); } }

  // 3. RSI
  { const nome = "IFR (RSI) sobrevendido", porque = "Vendas esticadas demais: o diário abaixo de 30 ou o semanal abaixo de 35 marcam exaustão vendedora.";
    if (!D || !W) falta(nome, porque, erro(kd) ? kd : kw);
    else { const rd = rsi(D.map(x => x.c)), rw = rsi(W.map(x => x.c));
      add({nome, valor: "diário " + num(rd, 1) + " · semanal " + num(rw, 1), detalhe: "IFR 14", regra: "✅ diário ≤ 30 ou semanal ≤ 35 · ⚠️ diário ≤ 40 ou semanal ≤ 45",
           st: rd <= 30 || rw <= 35 ? 2 : rd <= 40 || rw <= 45 ? 1 : 0, porque}); } }

  // 4. MACD
  { const nome = "MACD diário virando para cima", porque = "Abaixo de zero e com o histograma subindo: a força vendedora está perdendo fôlego, costuma anteceder a virada.";
    if (!D) falta(nome, porque, kd);
    else { const h = macdHist(D.map(x => x.c)), u = h.slice(-4);
      const subindo = n => u.slice(-n - 1).every((x, i, a) => i === 0 || x.h > a[i - 1].h);
      const cruzou = u.some((x, i) => i > 0 && u[i - 1].h < 0 && x.h >= 0) && u[u.length - 1].m < 0;
      const ab0 = u[u.length - 1].m < 0;
      const st = ab0 && (cruzou || (u[u.length - 1].h < 0 && subindo(2))) ? 2 : ab0 && subindo(1) ? 1 : 0;
      add({nome, valor: "hist. " + (u[u.length - 1].h >= 0 ? "+" : "") + num(u[u.length - 1].h, 2), detalhe: "linha MACD " + (ab0 ? "abaixo" : "acima") + " de zero" + (cruzou ? " · cruzou o sinal" : subindo(2) ? " · histograma subindo há 2+ dias" : subindo(1) ? " · histograma subiu hoje" : " · histograma caindo"),
           regra: "✅ abaixo de zero e virando (cruzou o sinal ou 2 dias subindo) · ⚠️ 1 dia subindo", st, porque}); } }

  // 5. Funding
  { const nome = "Funding neutro ou negativo", porque = "Funding negativo = vendidos pagando para manter o short: o mercado está pessimista e alavancado na venda, combustível para alta.";
    if (erro(fund) || !fund.length) falta(nome, porque, fund);
    else { const m = fund.reduce((a, x) => a + +x.fundingRate, 0) / fund.length * 100;
      add({nome, valor: (m < 0 ? "−" : "") + Math.abs(m).toFixed(4).replace(".", ",") + "%", detalhe: "média dos últimos 3 dias (Binance), por 8h", regra: "✅ ≤ 0 · ⚠️ ≤ 0,005% (neutro é 0,01%)", st: m <= 0 ? 2 : m <= 0.005 ? 1 : 0, porque}); } }

  // 6. Open interest
  { const nome = "Alavancagem limpa (open interest caiu)", porque = "Depois de uma limpeza de posições (liquidações), sobra menos combustível para quedas forçadas.";
    if (erro(oi) || !oi.length) falta(nome, porque, oi);
    else { const q = oi.map(x => +x.sumOpenInterest), pico = Math.max(...q), d = (q[q.length - 1] / pico - 1) * 100;
      add({nome, valor: pct(d) + " do pico", detalhe: "open interest em moedas vs. o maior dos últimos 30 dias (Binance)", regra: "✅ caiu 15% ou mais · ⚠️ caiu 8% ou mais", st: d <= -15 ? 2 : d <= -8 ? 1 : 0, porque}); } }

  // 7. Medo e Ganância
  { const nome = "Medo extremo", porque = "Fundos costumam se formar quando quase todo mundo está com medo (\"compre quando há sangue nas ruas\").";
    if (erro(fng) || !fng.data) falta(nome, porque, fng);
    else { const v = +fng.data[0].value, med = fng.data.reduce((a, x) => a + +x.value, 0) / fng.data.length;
      add({nome, valor: v + " / 100", detalhe: "média de 7 dias " + Math.round(med) + " · índice de cripto em geral", regra: "✅ ≤ 25 · ⚠️ ≤ 40", st: v <= 25 ? 2 : v <= 40 ? 1 : 0, porque}); } }

  // 8. ETFs
  { const nome = "ETFs voltando a comprar", porque = "Dinheiro institucional (BlackRock, Fidelity…) voltando a entrar costuma marcar o fim da pressão vendedora.";
    const e = !erro(flx) && flx[M.etf] ? flx[M.etf].dias.filter(x => x.total != null) : [];
    if (e.length < 5) falta(nome, porque, erro(flx) ? flx : null);
    else { const u = e.slice(-5), soma = u.reduce((a, x) => a + x.total, 0), ult = u[u.length - 1].total;
      add({nome, valor: usd(soma * 1e6) + " em 5 dias", detalhe: "último pregão (" + u[u.length - 1].data.split("-").reverse().slice(0, 2).join("/") + "): " + usd(ult * 1e6), regra: "✅ 5 dias positivos no total e último dia positivo · ⚠️ um dos dois", st: soma > 0 && ult > 0 ? 2 : soma > 0 || ult > 0 ? 1 : 0, porque}); } }

  // 9. Stablecoins
  { const nome = "Stablecoins crescendo", porque = "Mais dólares digitais emitidos = dinheiro novo esperando para comprar cripto.";
    const sr = !erro(flx) && flx.stables ? flx.stables.serie : [];
    if (sr.length < 8) falta(nome, porque, erro(flx) ? flx : null);
    else { const a = sr[sr.length - 8][1], b = sr[sr.length - 1][1], d = (b / a - 1) * 100;
      add({nome, valor: pct(d, 2) + " em 7 dias", detalhe: "oferta total " + usd(b).replace("+", "") , regra: "✅ acima de +0,5% · ⚠️ acima de 0%", st: d > 0.5 ? 2 : d > 0 ? 1 : 0, porque}); } }

  // 10. Corretoras
  { const nome = "Moedas saindo das corretoras", porque = "Saída líquida de moedas (BTC, ETH…) das corretoras = gente tirando para guardar (acumulação), menos oferta disponível para venda. Stablecoins ficam de fora: dólar digital entrando é dinheiro para comprar, sinal positivo.";
    // só a parte de moedas (d7_mo); arquivos antigos sem essa divisão caem no total
    const cx = !erro(flx) && flx.cex ? flx.cex.filter(c => (c.d7_mo ?? c.d7) != null) : [];
    if (!cx.length) falta(nome, porque, erro(flx) ? flx : null);
    else { const s7 = cx.reduce((a, c) => a + (c.d7_mo ?? c.d7), 0), s1 = cx.reduce((a, c) => a + (c.d1_mo ?? c.d1 ?? 0), 0);
      const st7 = cx.reduce((a, c) => a + (c.d7_st || 0), 0), temDiv = cx.some(c => c.d7_mo != null);
      add({nome, valor: usd(s7) + " em 7 dias", detalhe: cx.length + " maiores corretoras, " + (temDiv ? "só moedas · stablecoins à parte: " + usd(st7) : "todas as moedas") + " · 24h: " + usd(s1),
           regra: "✅ saída de moedas em 7 dias · ⚠️ saída só nas últimas 24h", st: s7 < 0 ? 2 : s1 < 0 ? 1 : 0, porque}); } }

  return {out, preco};
}


window.FundoCalc = {MOEDAS, calcular, pr, pct, usd, num};
})();
