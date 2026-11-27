// Relatório em texto de tudo que o LiqMap mostra, para colar numa conversa com IA no lugar de prints.
// Carregado pelo gráfico (index.html) só quando se clica em "📋 Relatório"; usa os dados que já estão na página.
(function(){
"use strict";
const DIA = 864e5;
const f2 = (x, d = 2) => x == null || !isFinite(x) ? "—" : (+x).toLocaleString("pt-BR", {minimumFractionDigits: d, maximumFractionDigits: d});
const pc = (x, d = 1) => x == null || !isFinite(x) ? "—" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d).replace(".", ",") + "%";
const us = (x, sinal) => { if (x == null || !isFinite(x)) return "—"; const a = Math.abs(x), s = x < 0 ? "−" : sinal ? "+" : "";
  return s + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + " bi" : a >= 1e6 ? (a / 1e6).toFixed(1) + " mi" : a >= 1e3 ? (a / 1e3).toFixed(0) + " mil" : a.toFixed(0)).replace(".", ","); };
const P = p => p == null || !isFinite(p) ? "—" : pr(p);   // preço no formato do gráfico
const dataHora = t => new Date(t).toLocaleString("pt-BR", {day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"});
const dataCurta = t => new Date(t).toLocaleString("pt-BR", {day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
async function J(url){ const r = await fetch(url); if (!r.ok) throw new Error(new URL(url, location.href).host + " " + r.status); return r.json(); }
const ok = p => p.catch(() => null);

// ---------- indicadores ----------
function ema(a, n){ const k = 2 / (n + 1), out = []; let e = null, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) e = s / n; } else e = x * k + e * (1 - k); out.push(e); }); return out; }
function sma(a, n){ if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; }
function rsiW(c, n = 14){ if (c.length <= n) return null; let g = 0, p = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], a = Math.max(d, 0), b = Math.max(-d, 0);
  if (i <= n) { g += a / n; p += b / n; } else { g = (g * (n - 1) + a) / n; p = (p * (n - 1) + b) / n; } } return p === 0 ? 100 : 100 - 100 / (1 + g / p); }
function macd(c){
  const r = ema(c, 12), l = ema(c, 26), m = []; c.forEach((_, i) => { if (r[i] != null && l[i] != null) m.push(r[i] - l[i]); });
  if (m.length < 10) return null;
  const s = ema(m, 9), h = m.map((x, i) => s[i] == null ? null : x - s[i]).filter(x => x != null);
  const u = h[h.length - 1], a = h[h.length - 2], linha = m[m.length - 1], sinal = s[s.length - 1];
  let cruz = ""; for (let i = h.length - 3; i < h.length; i++) if (i > 0 && h[i - 1] < 0 && h[i] >= 0) cruz = "cruzou o sinal para cima recentemente"; else if (i > 0 && h[i - 1] > 0 && h[i] <= 0) cruz = "cruzou o sinal para baixo recentemente";
  return {linha, sinal, hist: u, subindo: u > a, cruz};
}
const kl = k => k.map(x => ({t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], q: +x[7], b: +x[10]}));
function linhaTF(nome, v){
  if (!v || v.length < 30) return `- ${nome}: sem dados`;
  const c = v.map(x => x.c), p = c[c.length - 1];
  const e9 = ema(c, 9).pop(), e21 = ema(c, 21).pop(), s200 = sma(c, 200), r = rsiW(c), m = macd(c);
  const pos = (x) => x == null ? "" : p >= x ? " (preço acima)" : " (preço abaixo)";
  const zr = r == null ? "" : r >= 70 ? " sobrecomprado" : r <= 30 ? " sobrevendido" : "";
  const mt = m ? `MACD ${f2(m.linha, 2)} / sinal ${f2(m.sinal, 2)} / hist. ${f2(m.hist, 2)} (${m.subindo ? "subindo" : "caindo"}${m.linha < 0 ? ", abaixo de zero" : ", acima de zero"}${m.cruz ? ", " + m.cruz : ""})` : "MACD —";
  return `- ${nome}: MME 9 ${P(e9)}${pos(e9)} | MME 21 ${P(e21)}${pos(e21)} | MMS 200 ${s200 ? P(s200) + pos(s200) : "— (menos de 200 candles)"} | IFR 14 ${f2(r, 1)}${zr} | ${mt}`;
}
// perfil de volume simples: POC e área de valor (70%)
function perfil(v){
  if (!v || v.length < 20) return null;
  let lo = Infinity, hi = -Infinity; for (const k of v) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); }
  const N = 120, w = (hi - lo) / N || 1, vol = new Float64Array(N);
  for (const k of v) { const a = Math.max(0, Math.floor((k.l - lo) / w)), z = Math.min(N - 1, Math.floor((k.h - lo) / w)); for (let b = a; b <= z; b++) vol[b] += k.q / (z - a + 1); }
  let poc = 0; for (let b = 1; b < N; b++) if (vol[b] > vol[poc]) poc = b;
  const tot = vol.reduce((a, x) => a + x, 0); let a = poc, z = poc, s = vol[poc];
  while (s < tot * 0.7 && (a > 0 || z < N - 1)) { const da = a > 0 ? vol[a - 1] : -1, dz = z < N - 1 ? vol[z + 1] : -1; if (dz >= da) s += vol[++z]; else s += vol[--a]; }
  return {poc: lo + (poc + 0.5) * w, vah: lo + (z + 1) * w, val: lo + a * w};
}
const saldo = (v, n) => { let s = 0; for (const k of v.slice(-n)) s += 2 * k.b - k.q; return s; };

async function gerar(){
  const s = cfg.simbolo, base = s.replace("USDT", ""), agora = Date.now();
  const fapi = "https://fapi.binance.com", spot = "https://data-api.binance.vision";
  const [h1, h4, d1, w1, prem, fund, oiAg, oiH, lsC, lsT, tk, spotP, fundo] = await Promise.all([
    ok(J(`${fapi}/fapi/v1/klines?symbol=${s}&interval=1h&limit=500`)), ok(J(`${fapi}/fapi/v1/klines?symbol=${s}&interval=4h&limit=500`)),
    ok(J(`${fapi}/fapi/v1/klines?symbol=${s}&interval=1d&limit=500`)), ok(J(`${spot}/api/v3/klines?symbol=${s}&interval=1w&limit=500`)),
    ok(J(`${fapi}/fapi/v1/premiumIndex?symbol=${s}`)), ok(J(`${fapi}/fapi/v1/fundingRate?symbol=${s}&limit=9`)),
    ok(J(`${fapi}/fapi/v1/openInterest?symbol=${s}`)), ok(J(`${fapi}/futures/data/openInterestHist?symbol=${s}&period=1h&limit=25`)),
    ok(J(`${fapi}/futures/data/globalLongShortAccountRatio?symbol=${s}&period=5m&limit=1`)), ok(J(`${fapi}/futures/data/topLongShortPositionRatio?symbol=${s}&period=5m&limit=1`)),
    ok(J(`${fapi}/futures/data/takerlongshortRatio?symbol=${s}&period=1h&limit=24`)), ok(J(`${spot}/api/v3/ticker/price?symbol=${s}`)),
    (s === "BTCUSDT" || s === "ETHUSDT") ? ok(new Promise((res, rej) => {
      const fim = () => window.FundoCalc.calcular(s).then(res, rej);
      if (window.FundoCalc) fim(); else { const sc = document.createElement("script"); sc.src = "fundo-calc.js"; sc.onload = fim; sc.onerror = rej; document.head.append(sc); }
    })) : null
  ]);
  const H1 = h1 && kl(h1), H4 = h4 && kl(h4), D1 = d1 && kl(d1), W1 = w1 && kl(w1);
  const preco = velas.length ? velas[velas.length - 1].close : H1 ? H1[H1.length - 1].c : null;
  const L = [];
  L.push(`RELATÓRIO LIQMAP — ${base} (${s}, Binance Futuros perpétuo) — ${dataHora(agora)} (horário de Brasília)`);
  L.push(`Gerado automaticamente pelo site LiqMap com dados públicos (Binance, CoinMetrics, alternative.me, Farside, DefiLlama). Use como dados de mercado no lugar de prints.`);
  L.push("");

  // 1. preço
  L.push("1) PREÇO");
  const sp = spotP ? +spotP.price : null, mk = prem ? +prem.markPrice : null, ix = prem ? +prem.indexPrice : null;
  L.push(`- Futuro: ${P(preco)} | Spot: ${P(sp)} | basis (futuro vs índice): ${mk && ix ? pc((mk / ix - 1) * 100, 3) : "—"}`);
  if (H1) { const c = H1.map(x => x.c), v24 = H1.slice(-24);
    L.push(`- Variação: 1h ${pc((c[c.length - 1] / c[c.length - 2] - 1) * 100, 2)} · 4h ${pc((c[c.length - 1] / c[c.length - 5] - 1) * 100, 2)} · 24h ${pc((c[c.length - 1] / c[c.length - 25] - 1) * 100, 2)}` + (D1 ? ` · 7 dias ${pc((D1[D1.length - 1].c / D1[D1.length - 8].c - 1) * 100, 1)} · 30 dias ${pc((D1[D1.length - 1].c / D1[D1.length - 31].c - 1) * 100, 1)}` : ""));
    L.push(`- Máxima / mínima 24h: ${P(Math.max(...v24.map(x => x.h)))} / ${P(Math.min(...v24.map(x => x.l)))}` + (D1 ? ` · máxima / mínima 30 dias: ${P(Math.max(...D1.slice(-30).map(x => x.h)))} / ${P(Math.min(...D1.slice(-30).map(x => x.l)))}` : "")); }
  L.push("");

  // 2. tendência
  L.push("2) TENDÊNCIA E MOMENTO (médias, IFR e MACD por tempo gráfico; MACD 12/26/9)");
  L.push(linhaTF("1 hora", H1)); L.push(linhaTF("4 horas", H4)); L.push(linhaTF("Diário", D1)); L.push(linhaTF("Semanal (spot)", W1));
  if (W1 && W1.length >= 200) { const m = sma(W1.map(x => x.c), 200); L.push(`- Média de 200 semanas: ${P(m)} → preço ${pc((preco / m - 1) * 100)} em relação a ela`); }
  L.push("");

  // 3. níveis
  L.push("3) NÍVEIS IMPORTANTES");
  const vp = perfil(H1 && H1.slice(-24 * 30));
  if (vp) L.push(`- Perfil de volume (30 dias, 1h): POC ${P(vp.poc)} | topo da área de valor (VAH) ${P(vp.vah)} | fundo (VAL) ${P(vp.val)} — preço ${preco >= vp.vah ? "acima da área de valor" : preco <= vp.val ? "abaixo da área de valor" : "dentro da área de valor"}`);
  try {
    if ((!perfis || perfisSimb !== s) && typeof carregarPerfis === "function") await carregarPerfis();
    const nus = (perfis || []).map(p => ({...p, d: (p.preco / preco - 1) * 100})).sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, 8);
    if (nus.length) L.push("- POCs nus (ainda não tocados, costumam atrair o preço): " + nus.map(p => `${p.tipo === "S" ? "semana" : "dia"} ${new Date(p.ini).toLocaleDateString("pt-BR", {day: "2-digit", month: "2-digit"})} em ${P(p.preco)} (${pc(p.d)})`).join("; "));
  } catch (e) {}
  const hs = (desenhos || []).filter(d => (d.tipo === "horizontal" || d.tipo === "raioH") && d.pts && d.pts[0]);
  if (hs.length) L.push("- Minhas linhas no gráfico: " + hs.sort((a, b) => b.pts[0].p - a.pts[0].p).map(d => `${P(d.pts[0].p)} (${pc((d.pts[0].p / preco - 1) * 100)})${d.alerta ? " [alerta ligado]" : ""}${d.nota ? ` "${d.nota}"` : ""}`).join("; "));
  const zs = (desenhos || []).filter(d => d.tipo === "zonaLiq" || d.tipo === "retangulo");
  if (zs.length) L.push(`- Zonas desenhadas: ${zs.length}`);
  L.push("");

  // 4. mapa de liquidações
  L.push("4) MAPA DE LIQUIDAÇÕES (estimativa do LiqMap a partir do open interest e da alavancagem)");
  if (mapa && mapa.shorts) {
    const fmt = z => `${P(z.preco)} (${pc(z.dist)}) ${us(z.valor)}`;
    L.push("- Maiores zonas ACIMA do preço (liquidam SHORTS se o preço subir): " + (mapa.shorts.filter(z => z.dist > 0 && z.dist <= 25).map(fmt).join("; ") || "nenhuma relevante até +25%"));
    L.push("- Maiores zonas ABAIXO do preço (liquidam LONGS se o preço cair): " + (mapa.longs.filter(z => z.dist < 0 && z.dist >= -25).map(fmt).join("; ") || "nenhuma relevante até −25%"));
    L.push(mapa.s5 + mapa.l5 > 0
      ? `- Total estimado a até 5% do preço: shorts ${us(mapa.s5)} acima · longs ${us(mapa.l5)} abaixo → ${mapa.s5 > mapa.l5 * 1.15 ? "mais combustível para alta (short squeeze)" : mapa.l5 > mapa.s5 * 1.15 ? "mais combustível para queda (cascata de longs)" : "equilibrado"}`
      : "- A até 5% do preço não há zona de liquidação relevante (já foram limpas): o preço está numa área sem combustível próximo de nenhum dos lados");
  } else L.push("- mapa ainda não calculado nesta tela (ligue o mapa de liquidação no gráfico)");
  L.push("");

  // 5. fluxo
  L.push("5) FLUXO DE AGRESSÃO (Binance futuros: compra a mercado − venda a mercado)");
  if (H1) L.push(`- Saldo: 1h ${us(saldo(H1, 1), true)} · 4h ${us(saldo(H1, 4), true)} · 24h ${us(saldo(H1, 24), true)} · 7 dias ${us(saldo(H1, 168), true)}`);
  if (tk && tk.length) { const b = tk.reduce((a, x) => a + +x.buyVol, 0), v = tk.reduce((a, x) => a + +x.sellVol, 0); L.push(`- Compra ÷ venda a mercado 24h: ${f2(b / v, 3)} (${b >= v ? "compradores mais agressivos" : "vendedores mais agressivos"})`); }
  try { const lq = JSON.parse(localStorage.getItem("liqmap-liqs-" + s) || "[]").filter(x => agora - x.t < DIA);
    if (lq.length) { const lo = lq.filter(x => x.l).reduce((a, x) => a + x.u, 0), sh = lq.filter(x => !x.l).reduce((a, x) => a + x.u, 0);
      L.push(`- Liquidações reais registradas pelo LiqMap em 24h (parcial, só com o site aberto): longs ${us(lo)} · shorts ${us(sh)}`); } } catch (e) {}
  L.push("");

  // 6. derivativos
  L.push("6) DERIVATIVOS (Binance)");
  if (prem) L.push(`- Funding atual: ${f2(+prem.lastFundingRate * 100, 4)}% por 8h` + (fund && fund.length ? ` · média 3 dias ${f2(fund.reduce((a, x) => a + +x.fundingRate, 0) / fund.length * 100, 4)}%` : "") + " (neutro ≈ 0,0100%; negativo = vendidos pagando)");
  if (oiAg && mk) { const q = +oiAg.openInterest; let v24 = null; if (oiH && oiH.length) v24 = (q / +oiH[0].sumOpenInterest - 1) * 100;
    L.push(`- Open interest: ${us(q * mk)} (${f2(q, 0)} ${base}) · variação 24h em moedas ${pc(v24, 2)}`); }
  if (lsC && lsC[0]) L.push(`- Long/short de contas: ${f2(+lsC[0].longShortRatio, 2)} (${Math.round(+lsC[0].longAccount * 100)}% das contas compradas)` + (lsT && lsT[0] ? ` · top traders (posições): ${f2(+lsT[0].longShortRatio, 2)}` : ""));
  L.push("");

  // 7. fluxo de dinheiro (ETFs, stablecoins e corretoras; os futuros estão na seção 5)
  const flx = await ok(J("fluxos.json?t=" + Math.floor(Date.now() / 6e5)));
  if (flx) {
    L.push("7) FLUXO DE DINHEIRO (dinheiro de verdade, fora os futuros: ETFs, stablecoins e corretoras)");
    const dataBR = d => d.split("-").reverse().slice(0, 2).join("/");
    const etf = {};
    for (const [k, nome] of (s === "ETHUSDT" ? [["etfEth", "ETH"], ["etfBtc", "BTC"]] : [["etfBtc", "BTC"], ["etfEth", "ETH"]])) {
      const e = flx[k] && flx[k].dias ? flx[k].dias.filter(x => x.total != null) : [];
      if (e.length < 5) continue;
      const ult = e[e.length - 1], s5 = e.slice(-5).reduce((a, x) => a + x.total, 0), s21 = e.slice(-21).reduce((a, x) => a + x.total, 0);
      const pos = e.slice(-5).filter(x => x.total > 0).length;
      const maior = Object.entries(ult.fundos || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      etf[nome] = s5;
      L.push(`- ETFs de ${nome} (EUA): último pregão (${dataBR(ult.data)}) ${us(ult.total * 1e6, true)} · 5 pregões ${us(s5 * 1e6, true)} (${pos} de 5 dias positivos) · 21 pregões ${us(s21 * 1e6, true)}`
        + (maior && maior[1] ? ` · maior movimento no último pregão: ${maior[0]} ${us(maior[1] * 1e6, true)}` : ""));
    }
    const sr = (flx.stables && flx.stables.serie) || [];
    let st7 = null;
    if (sr.length >= 31) {
      const b = sr[sr.length - 1][1], ant = n => sr[sr.length - 1 - n][1];
      st7 = (b / ant(7) - 1) * 100;
      L.push(`- Stablecoins (oferta total ${us(b)}): 24h ${us(b - ant(1), true)} · 7 dias ${us(b - ant(7), true)} (${pc(st7, 2)}) · 30 dias ${us(b - ant(30), true)} (${pc((b / ant(30) - 1) * 100, 1)})`);
    }
    const cx = flx.cex || [];
    let exMoeda = null;
    if (cx.length) {
      // soma das corretoras, sem as janelas marcadas como instáveis (leitura incompleta do DefiLlama)
      const soma = k => { const j = k.split("_")[0]; let t = 0; const fora = []; for (const c of cx) { if (c.instavel && c.instavel[j]) { fora.push(c.nome); continue; } t += c[k] || 0; } return [t, fora]; };
      const qtd = (q, m) => (q > 0 ? "+" : q < 0 ? "−" : "") + Math.abs(q).toLocaleString("pt-BR", {maximumFractionDigits: 0}) + " " + m;
      const porMoeda = cx.some(c => c.d7_btc_q != null);
      for (const j of ["d7", "d1"]) {
        const [mo, fora] = soma(j + "_mo"), [st] = soma(j + "_st");
        let txt = `- Corretoras (${cx.length} maiores), ${j === "d7" ? "7 dias" : "24h"}: `;
        if (porMoeda) {
          const [bq] = soma(j + "_btc_q"), [bu] = soma(j + "_btc"), [eq] = soma(j + "_eth_q"), [eu] = soma(j + "_eth");
          txt += `BTC ${qtd(bq, "BTC")} (${us(bu, true)}) · ETH ${qtd(eq, "ETH")} (${us(eu, true)}) · `;
          if (j === "d7") exMoeda = s === "ETHUSDT" ? eq : bq;
        } else if (j === "d7") exMoeda = mo;
        L.push(txt + `todas as moedas ${us(mo, true)} · stablecoins ${us(st, true)}` + (fora.length ? ` [sem ${fora.join(", ")}: dado instável]` : ""));
      }
      L.push("  Leitura: moeda ENTRANDO na corretora = mais oferta para venda; SAINDO = gente guardando. Stablecoin entrando = dinheiro para comprar.");
    }
    // resumo: quantas fontes mostram dinheiro entrando no ativo do relatório
    const sinais = [[etf[base], v => v > 0, "ETFs de " + base], [st7, v => v > 0, "stablecoins"], [exMoeda, v => v < 0, "corretoras (" + base + (exMoeda < 0 ? " saindo" : " entrando") + ")"]].filter(x => x[0] != null);
    if (sinais.length) {
      const sim = sinais.filter(x => x[1](x[0])).map(x => x[2]), nao = sinais.filter(x => !x[1](x[0])).map(x => x[2]);
      L.push(`- Resumo: ${sim.length} de ${sinais.length} fontes mostram dinheiro entrando` + (sim.length ? ` (${sim.join(", ")})` : "") + (nao.length ? `; contra: ${nao.join(", ")}` : "") + ". Agressão nos futuros: ver seção 5.");
    }
    L.push("");
  }

  // 8. painel de fundo
  if (fundo && fundo.out) {
    const n = fundo.out.filter(x => x.st === 2).length, m = fundo.out.filter(x => x.st === 1).length;
    L.push(`8) PAINEL DE FUNDO: ${n}/10 ✅` + (m ? ` (+${m} ⚠️ chegando perto)` : "") + ` — ${n >= 7 ? "sinais fortes de fundo" : n >= 4 ? "zona de atenção" : "longe de um fundo"}`);
    for (const x of fundo.out) L.push(`- ${x.st === 2 ? "✅" : x.st === 1 ? "⚠️" : x.st === 0 ? "✖" : "?"} ${x.nome}: ${x.valor} (${x.detalhe})`);
    L.push("");
  }

  // 9. agenda
  const evs = (typeof eventos !== "undefined" ? eventos : []).filter(e => e.t > agora).sort((a, b) => a.t - b.t);
  const janela = evs.filter(e => e.t < agora + 10 * DIA);
  const altos = janela.filter(e => e.impacto === "High").slice(0, 8), medios = janela.filter(e => e.impacto !== "High").slice(0, 6);
  const fmtEv = e => `- ${dataCurta(e.t)}: ${e.titulo}` + (e.previsao ? ` (previsão ${e.previsao}` + (e.anterior ? `, anterior ${e.anterior}` : "") + ")" : "");
  L.push("9) AGENDA (EUA, horário de Brasília)");
  L.push("Alto impacto, próximos 10 dias:");
  L.push(altos.length ? altos.map(fmtEv).join("\n") : (evs.length ? "- nenhum nos próximos 10 dias" : "- agenda indisponível (eventos.json não carregou)"));
  if (medios.length) { L.push("Médio impacto, próximos 10 dias:"); L.push(medios.map(fmtEv).join("\n")); }
  // a próxima decisão do Fed aparece sempre, mesmo fora da janela
  const fomc = evs.find(e => e.orig === "FOMC Statement");
  if (fomc && !altos.includes(fomc)) L.push(`Próxima decisão de juros do Fed (FOMC): ${dataCurta(fomc.t)} (em ${Math.ceil((fomc.t - agora) / DIA)} dias)`);
  L.push("");
  L.push("Observação: estimativas e indicadores técnicos; não é recomendação de investimento.");
  return L.join("\n");
}

// ---------- janela ----------
function janela(){
  let m = document.getElementById("relModal");
  if (m) return m;
  m = document.createElement("div"); m.id = "relModal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(19,23,34,.45);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px";
  m.innerHTML = `<div style="background:#fff;border-radius:10px;width:min(860px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
    <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e0e3eb"><b style="font-size:15px">📋 Relatório para a IA</b>
      <select id="relMoeda" title="Moeda do relatório" style="padding:5px 8px;border:1px solid #e0e3eb;border-radius:6px;font:inherit;background:#f0f3fa;cursor:pointer"></select>
      <span id="relSt" style="color:#787b86;font-size:12px"></span><span style="flex:1"></span>
      <button id="relCopiar" style="background:#2962ff;color:#fff;border:0;border-radius:6px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer">Copiar</button>
      <button id="relBaixar" style="background:#f0f3fa;border:1px solid #e0e3eb;border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer">Baixar .txt</button>
      <button id="relFechar" style="background:none;border:0;font-size:20px;cursor:pointer;color:#787b86">✕</button></div>
    <textarea id="relTxt" readonly style="flex:1;min-height:55vh;border:0;padding:14px 16px;font:12.5px/1.55 ui-monospace,Consolas,monospace;resize:none;outline:none;color:#131722"></textarea>
    <div style="padding:8px 16px;color:#787b86;font-size:11.5px;border-top:1px solid #e0e3eb">Escolha a moeda (ou “Todas”) e clique em Copiar. Para montar o relatório de outra moeda o gráfico muda para ela, porque o mapa de liquidações e os níveis vêm do gráfico.</div></div>`;
  document.body.append(m);
  const sel = m.querySelector("#relMoeda");
  for (const sm of SIMBOLOS) sel.append(new Option(sm.replace("USDT", ""), sm));
  sel.append(new Option("Todas as moedas", "todas"));
  sel.addEventListener("change", () => window.abrirRelatorio(sel.value));
  m.addEventListener("click", e => { if (e.target === m) m.style.display = "none"; });
  m.querySelector("#relFechar").onclick = () => m.style.display = "none";
  m.querySelector("#relCopiar").onclick = async () => { const t = m.querySelector("#relTxt"); try { await navigator.clipboard.writeText(t.value); } catch (e) { t.select(); document.execCommand("copy"); } m.querySelector("#relSt").textContent = "copiado ✓"; };
  m.querySelector("#relBaixar").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([m.querySelector("#relTxt").value], {type: "text/plain;charset=utf-8"}));
    a.download = "liqmap-" + cfg.simbolo + "-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".txt"; a.click(); };
  return m;
}
// troca o gráfico para a moeda e espera o mapa dela ficar pronto
async function irPara(s){
  if (cfg.simbolo !== s) trocar({simbolo: s});
  const ini = Date.now();
  while (Date.now() - ini < 40000) {
    if (cfg.simbolo === s && mapa && mapa.simb === s && velas.length && !ocupado) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return cfg.simbolo === s;
}
let rodando = 0;
window.abrirRelatorio = async function(qual){
  const m = janela(); m.style.display = "flex";
  const st = m.querySelector("#relSt"), tx = m.querySelector("#relTxt"), sel = m.querySelector("#relMoeda");
  qual = qual || cfg.simbolo; sel.value = qual;
  const eu = ++rodando, original = cfg.simbolo;
  const lista = qual === "todas" ? SIMBOLOS.slice() : [qual];
  const partes = [];
  try {
    for (const [i, s] of lista.entries()) {
      st.textContent = lista.length > 1 ? `montando ${s.replace("USDT", "")} (${i + 1} de ${lista.length})…` : "montando…";
      tx.value = (partes.length ? partes.join("\n\n" + "=".repeat(60) + "\n\n") + "\n\n" : "") + "Juntando os dados de " + s + "…";
      await irPara(s);
      if (eu !== rodando) return;   // outra escolha no meio do caminho
      partes.push(await gerar());
    }
    tx.value = partes.join("\n\n" + "=".repeat(60) + "\n\n");
    st.textContent = "pronto · " + new Date().toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"});
    if (qual === "todas" && cfg.simbolo !== original) trocar({simbolo: original});   // volta para a moeda que estava aberta
  } catch (e) { tx.value = "Não foi possível montar o relatório: " + e.message; st.textContent = "erro"; }
};
})();
