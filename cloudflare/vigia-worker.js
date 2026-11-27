// LiqMap — vigia de alertas 24h (Cloudflare Workers)
//
// Roda a cada minuto (Cron Trigger "* * * * *"). Lê os desenhos com alerta ligado no Gist de
// sincronização do LiqMap, confere os candles de 1 minuto mais recentes e, se o preço tocou o
// nível, avisa o celular pelo ntfy e desliga o alerta no Gist.
// Também confere as carteiras da Hyperliquid rastreadas no site (página Carteiras, com 🔔 ligado) e
// avisa quando abrem, aumentam, reduzem, fecham ou viram uma posição.
//
// Avisa ainda os eventos econômicos dos EUA (eventos.json do repositório): na véspera às 20h, 30 min antes
// e o resultado, conforme as opções do site (Ajustes → Alertas no celular). Versão 5.
//
// Configuração no painel do Cloudflare (Settings → Variables and Secrets):
//   GIST_TOKEN  (Secret)  token do GitHub só com a permissão "gist" (o mesmo da sincronização)
//   GIST_ID     (Text, opcional) id do Gist; sem ele o vigia procura o Gist sozinho a cada execução
//
// Preço: candles de 1 min do mercado à vista. Tenta Binance (data-api.binance.vision); se a Binance
// recusar o servidor do Cloudflare, usa Coinbase e depois Hyperliquid. A diferença entre elas e o
// futuro da Binance costuma ser de poucos centésimos de %.

const ARQ_SYNC = "liqmap-sync.json";
const ARQ_VIGIA = "liqmap-vigia.json";
const ARQ_CART = "liqmap-carteiras-vigia.json";   // última posição vista de cada carteira rastreada
const MUDA_PCT = 0.10, MUDA_USD = 25000;          // "aumentou/reduziu": pelo menos 10% e US$ 25 mil
const JANELA_MAX = 60;  // olha no máximo 60 min para trás (cobre execuções atrasadas ou falhas)
const ARQ_EV = "liqmap-eventos-avisados.json";    // avisos de eventos já enviados (compartilhado com o vigia do GitHub)
const URL_EVENTOS = "https://raw.githubusercontent.com/GeffMB/liqmap/main/eventos.json";

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(vigiar(env, new Date(evento.scheduledTime)).catch(e => console.log("Erro:", e.message)));
  },
  // abrir o endereço do Worker no navegador mostra o status; /rodar força uma verificação agora
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/rodar") {
      try { return json(await vigiar(env, new Date(), true)); }
      catch (e) { return json({erro: e.message}, 500); }
    }
    return json({ok: true, servico: "LiqMap vigia 24h", token: !!env.GIST_TOKEN, dica: "abra /rodar para verificar agora"});
  }
};

const json = (o, st = 200) => new Response(JSON.stringify(o, null, 2), {status: st, headers: {"content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*"}});

async function gh(env, caminho, op = {}) {
  const r = await fetch("https://api.github.com" + caminho, {
    method: op.method || "GET",
    body: op.body ? JSON.stringify(op.body) : undefined,
    headers: {"Authorization": "Bearer " + env.GIST_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "liqmap-vigia", "Content-Type": "application/json"}
  });
  if (!r.ok) throw new Error("GitHub " + r.status + (r.status === 401 ? " (token inválido ou vencido)" : ""));
  return r.json();
}

async function acharGist(env) {
  if (env.GIST_ID) return env.GIST_ID;
  for (let pg = 1; pg <= 5; pg++) {
    const lista = await gh(env, "/gists?per_page=100&page=" + pg);
    const g = lista.find(x => x.files && x.files[ARQ_SYNC]);
    if (g) return g.id;
    if (lista.length < 100) break;
  }
  return null;
}

async function conteudo(g, nome) {
  const f = g.files && g.files[nome];
  if (!f) return null;
  const txt = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

const pr = p => {
  const casas = p >= 1000 ? 1 : p >= 10 ? 2 : 4;
  return p.toLocaleString("pt-BR", {minimumFractionDigits: casas, maximumFractionDigits: casas});
};

// níveis (preço, descrição) do desenho no instante t (segundos)
function niveis(d, t) {
  const pts = d.pts || [], tipo = d.tipo;
  if (!pts.length) return [];
  if (tipo === "horizontal" || tipo === "raioH") return [[pts[0].p, "a linha em " + pr(pts[0].p)]];
  if ((tipo === "zonaLiq" || tipo === "retangulo") && pts.length >= 2) {
    const lo = Math.min(pts[0].p, pts[1].p), hi = Math.max(pts[0].p, pts[1].p);
    return [[lo, "o fundo da zona (" + pr(lo) + ")"], [hi, "o topo da zona (" + pr(hi) + ")"]];
  }
  if (tipo === "posicao" && pts.length >= 3) return [[pts[1].p, "o STOP (" + pr(pts[1].p) + ")"], [pts[2].p, "o ALVO (" + pr(pts[2].p) + ")"]];
  if ((tipo === "linha" || tipo === "raio") && pts.length >= 2) {
    const t0 = pts[0].t, t1 = pts[1].t;
    if (t1 === t0) return [];
    if (tipo === "linha" && (t < Math.min(t0, t1) || t > Math.max(t0, t1))) return [];
    if (tipo === "raio" && (t - t0) * (t1 - t0) < 0) return [];
    const p = pts[0].p + (pts[1].p - pts[0].p) * (t - t0) / (t1 - t0);
    return [[p, (tipo === "raio" ? "a linha do raio" : "a linha de tendência") + " (" + pr(p) + ")"]];
  }
  return [];
}

async function chave(simb, d) {
  const base = JSON.stringify([simb, d.tipo, d.pts, d.alertaDesde || null]);
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(base));
  return [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

// candles de 1 min desde "desde" (segundos); devolve {ks, fonte, erros}
async function candles(simb, desde) {
  const base = simb.replace(/USDT$/, ""), erros = [];
  const fontes = [
    ["binance", async () => {
      const r = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=" + simb + "&interval=1m&startTime=" + Math.floor(desde) * 1000 + "&limit=120");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).map(k => ({t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4]}));
    }],
    ["coinbase", async () => {
      const q = "granularity=60&start=" + new Date(desde * 1000).toISOString() + "&end=" + new Date().toISOString();
      const r = await fetch("https://api.exchange.coinbase.com/products/" + base + "-USD/candles?" + q, {headers: {"User-Agent": "liqmap-vigia"}});
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).map(k => ({t: k[0], l: +k[1], h: +k[2], o: +k[3], c: +k[4]})).sort((a, b) => a.t - b.t);
    }],
    ["hyperliquid", async () => {
      const r = await fetch("https://api.hyperliquid.xyz/info", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({type: "candleSnapshot", req: {coin: base, interval: "1m", startTime: Math.floor(desde) * 1000, endTime: Date.now()}})});
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (await r.json()).map(k => ({t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c}));
    }]
  ];
  for (const [nome, f] of fontes) {
    try { const ks = await f(); if (ks.length) return {ks, fonte: nome, erros}; erros.push(nome + ": vazio"); }
    catch (e) { erros.push(nome + ": " + e.message); }
  }
  throw new Error(erros.join("; "));
}

// Telegram do usuário (bot próprio), lido dos ajustes sincronizados; vale para todos os avisos
let TG = null;
async function ntfy(topico, titulo, txt, link = "https://geffmb.github.io/liqmap/", tags = "bell,chart_with_upwards_trend") {
  const envios = [];
  if (topico) {
    const q = new URLSearchParams({title: titulo, priority: "high", tags, click: link});
    envios.push(fetch("https://ntfy.sh/" + encodeURIComponent(topico) + "?" + q, {method: "POST", body: txt}));
  }
  if (TG) envios.push(fetch("https://api.telegram.org/bot" + TG.token + "/sendMessage", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({chat_id: TG.chat, text: "🔔 " + titulo + "\n" + txt, disable_web_page_preview: true})}));
  await Promise.all(envios);
}

async function vigiar(env, quando, forcarStatus = false) {
  if (!env.GIST_TOKEN) return {erro: "configure o segredo GIST_TOKEN"};
  const gid = await acharGist(env);
  if (!gid) return {erro: "nenhum Gist do LiqMap (ligue a sincronização no site)"};
  const g = await gh(env, "/gists/" + gid);
  const pac = (await conteudo(g, ARQ_SYNC)) || {};
  const estado = (await conteudo(g, ARQ_VIGIA)) || {};
  const dados = pac.dados || {};
  let cfg = {};
  try { cfg = JSON.parse(dados.liqmap2 || "{}"); } catch (e) {}
  TG = cfg.telegram && cfg.telegram.token && cfg.telegram.chat ? cfg.telegram : null;
  const agora = Date.now() / 1000;
  const disparados = {};
  for (const [k, v] of Object.entries(estado.disparados || {})) if (agora - v < 30 * 86400) disparados[k] = v;

  let mudouSync = false, ativos = 0;
  const avisos = [], fontesPreco = {}, errosPreco = {};
  // olha desde a última verificação registrada (com folga), no máximo 60 min
  const desde = Math.max(agora - JANELA_MAX * 60, (estado.ultimo || agora - 600) - 120);
  for (const k of Object.keys(dados)) {
    if (!k.startsWith("liqmap-des-")) continue;
    const simb = k.slice("liqmap-des-".length);
    let desenhos;
    try { desenhos = JSON.parse(dados[k]); } catch (e) { continue; }
    const comAlerta = desenhos.filter(d => d.alerta);
    if (!comAlerta.length) continue;
    ativos += comAlerta.length;
    let ks;
    try { const r = await candles(simb, desde); ks = r.ks; fontesPreco[simb] = r.fonte; if (r.erros.length) errosPreco[simb] = r.erros.join("; "); }
    catch (e) { console.log("Candles", simb, e.message); errosPreco[simb] = e.message; continue; }
    let mudou = false;
    for (const d of comAlerta) {
      const ch = await chave(simb, d);
      if (disparados[ch]) { d.alerta = false; mudou = true; continue; }
      let achou = null;
      const ligado = (d.alertaDesde || 0) / 1000;   // só vale o que aconteceu depois de o alerta ser ligado
      for (const c of ks) {
        if (c.t + 60 < ligado) continue;
        for (const [nv, desc] of niveis(d, c.t + 30)) if (c.l <= nv && nv <= c.h) { achou = [c, desc]; break; }
        if (achou) break;
      }
      if (achou) {
        const [c, desc] = achou;
        const hora = new Date(c.t * 1000).toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"});
        avisos.push(simb + " " + (c.c >= c.o ? "subiu" : "caiu") + " e tocou " + desc + " às " + hora + (d.nota ? " — " + d.nota : ""));
        d.alerta = false; d.disparadoVigia = Date.now();
        disparados[ch] = agora; mudou = true;
      }
    }
    if (mudou) { dados[k] = JSON.stringify(desenhos); mudouSync = true; }
  }

  for (const a of avisos) {
    console.log("ALERTA:", a);
    if (cfg.ntfy || TG) await ntfy(cfg.ntfy, "LiqMap — alerta 24h", a).catch(e => console.log("ntfy", e.message));
  }

  // ---------- carteiras rastreadas (Hyperliquid) ----------
  let rastreadas = [];
  try { rastreadas = JSON.parse(dados["liqmap-carteiras"] || "[]").filter(c => !c.del && c.notif && /^0x[0-9a-f]{40}$/.test(c.addr)).slice(0, 20); } catch (e) {}
  const antCart = (await conteudo(g, ARQ_CART)) || {};
  const snaps = antCart.snaps || {}, novosSnaps = {};
  const avisosCart = [];
  if (rastreadas.length) {
    let mids = {};
    try { mids = await hl({type: "allMids"}); } catch (e) {}
    for (const c of rastreadas) {
      let st;
      try { st = await hl({type: "clearinghouseState", user: c.addr}); } catch (e) { if (snaps[c.addr]) novosSnaps[c.addr] = snaps[c.addr]; continue; }
      const atual = {}, pxs = {};
      for (const p of st.assetPositions || []) { const x = p.position, szi = +x.szi; if (!szi) continue; atual[x.coin] = szi; pxs[x.coin] = Math.abs(+x.positionValue / szi); }
      novosSnaps[c.addr] = atual;
      const ant = snaps[c.addr];
      if (!ant) continue;   // primeira vez: só guarda
      const quem = c.nome || (c.addr.slice(0, 6) + "…" + c.addr.slice(-4));
      for (const coin of new Set([...Object.keys(ant), ...Object.keys(atual)])) {
        const t = mudanca(ant[coin] || 0, atual[coin] || 0, pxs[coin] || +mids[coin] || 0, coin);
        if (t) avisosCart.push("🐋 " + quem + " " + t + (mids[coin] ? " · " + coin + " a " + pr(+mids[coin]) : ""));
      }
    }
  }
  for (const a of avisosCart) {
    console.log("CARTEIRA:", a);
    if (cfg.ntfy || TG) await ntfy(cfg.ntfy, "LiqMap — carteira rastreada", a, "https://geffmb.github.io/liqmap/carteiras.html", "whale").catch(e => console.log("ntfy", e.message));
  }
  const mudouCart = JSON.stringify(novosSnaps) !== JSON.stringify(snaps);

  // ---------- eventos econômicos (lê a agenda a cada 5 min) ----------
  let novoEv = null, avisosEv = [];
  if ((cfg.ntfy || TG) && (Math.floor(agora / 60) % 5 === 0 || forcarStatus)) {
    try {
      const evs = ((await (await fetch(URL_EVENTOS, {cf: {cacheTtl: 120}})).json()).eventos) || [];
      const ant = (await conteudo(g, ARQ_EV)) || {};
      const enviados = {};
      for (const [k, v] of Object.entries(ant.enviados || {})) if (agora - v < 20 * 86400) enviados[k] = v;
      for (const [chaves, titulo, txt] of planejarEventos(evs, cfg.avEv, enviados, agora)) {
        try { await ntfy(cfg.ntfy, titulo, txt, "https://geffmb.github.io/liqmap/", "calendar"); }
        catch (e) { console.log("ntfy", e.message); continue; }
        for (const k of chaves) enviados[k] = agora;
        avisosEv.push(titulo + ": " + txt);
      }
      if (avisosEv.length) novoEv = JSON.stringify({ultimo: agora, fonte: "cloudflare", enviados});
    } catch (e) { console.log("Eventos:", e.message); }
  }

  // status para o site: grava a cada 10 min (ou quando algo mudou) para não encher o histórico do Gist
  const arquivos = {};
  const minuto = Math.floor(agora / 60);
  if (mudouSync || forcarStatus || minuto % 10 === 0 || !estado.ultimo || agora - estado.ultimo > 900 || estado.ativos !== ativos || JSON.stringify(estado.errosPreco || {}) !== JSON.stringify(errosPreco))
    arquivos[ARQ_VIGIA] = {content: JSON.stringify({ultimo: agora, disparados, ativos, fonte: "cloudflare", versao: 6, telegram: !!TG, carteiras: Object.keys(novosSnaps).length, fontesPreco, errosPreco})};
  if (mudouCart || (rastreadas.length && minuto % 10 === 0)) arquivos[ARQ_CART] = {content: JSON.stringify({ultimo: agora, fonte: "cloudflare", snaps: novosSnaps})};
  if (novoEv) arquivos[ARQ_EV] = {content: novoEv};
  if (mudouSync) {
    pac.dados = dados; pac.atualizado = Date.now();
    arquivos[ARQ_SYNC] = {content: JSON.stringify(pac)};
  }
  if (Object.keys(arquivos).length) await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: arquivos}});
  return {ok: true, versao: 6, telegram: TG ? "conectado (@" + (TG.bot || "bot") + ")" : "desligado", gist: gid, ativos, disparados: avisos, carteiras: rastreadas.length, avisosCarteiras: avisosCart, avisosEventos: avisosEv, fontesPreco, errosPreco, quando: quando.toISOString()};
}

// ---------- eventos econômicos: mesma lógica do vigia.py (planejar_eventos) ----------
const DIAS_SEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const partesBRT = s => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"})
  .formatToParts(new Date(s * 1000)).map(p => [p.type, p.value]));
const horaBRT = s => { const p = partesBRT(s); return p.hour + "h" + p.minute; };
const evId = e => (e.orig || e.titulo || "") + "|" + new Date(e.t).toISOString().slice(0, 10);
function evLinha(e, comHora = true) {
  const extra = [e.previsao && "previsão " + e.previsao, e.anterior && "anterior " + e.anterior].filter(Boolean);
  return (comHora ? horaBRT(e.t / 1000) + " " : "") + (e.titulo || "") + (extra.length ? " (" + extra.join(", ") + ")" : "");
}
// meia-noite (horário de Brasília, UTC−3 fixo) do dia do evento, em segundos
const meiaNoiteBRT = s => { const p = partesBRT(s); return Date.UTC(+p.year, +p.month - 1, +p.day, 3) / 1000; };
function planejarEventos(evs, av, enviados, agora) {
  const lig = k => !av || av[k] !== false;
  const vespera = new Map(), antes = new Map(), result = new Map();
  const add = (m, k, e) => { if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
  for (const e of evs) {
    const imp = e.impacto, t = e.t / 1000;
    if (imp !== "High" && imp !== "Medium") continue;
    const id = evId(e), dia = meiaNoiteBRT(t);
    if (imp === "High" && lig("v") && dia - 4 * 3600 <= agora && agora < t - 3600 && !enviados["v|" + id]) add(vespera, dia, e);
    if (lig(imp === "High" ? "a" : "m") && t - 1800 <= agora && agora < t + 600 && !enviados["a|" + id]) add(antes, e.t, e);
    if (imp === "High" && lig("r") && e.atual && t <= agora && agora < t + 6 * 3600 && !enviados["r|" + id]) add(result, e.t, e);
  }
  const saida = [], ord = m => [...m.entries()].sort((a, b) => a[0] - b[0]);
  for (const [dia, lista] of ord(vespera)) {
    const p = partesBRT(dia + 3600), d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    let txt = `Amanhã (${DIAS_SEM[d.getUTCDay()]}, ${p.day}/${p.month}), horário de Brasília:\n` + lista.map(e => "• " + evLinha(e)).join("\n");
    txt += "\nRegra: nada de posição nova 15 min antes; entrar só depois da primeira vela de 1h.";
    saida.push([lista.map(e => "v|" + evId(e)), "LiqMap — agenda de amanhã", txt]);
  }
  for (const [t, lista] of ord(antes)) {
    const mins = Math.round((t / 1000 - agora) / 60), quando = mins > 0 ? `Em ${mins} min` : "Saindo agora";
    let txt = `${quando} (${horaBRT(t / 1000)}): ` + lista.map(e => evLinha(e, false)).join("; ");
    if (lista.some(e => e.impacto === "High")) txt += "\nSem posição nova até fechar a primeira vela de 1h.";
    saida.push([lista.map(e => "a|" + evId(e)), "LiqMap — " + quando.toLowerCase(), txt]);
  }
  for (const [, lista] of ord(result))
    saida.push([lista.map(e => "r|" + evId(e)), "LiqMap — resultado", lista.map(e => `${e.titulo}: ${e.atual}` + evLinha(Object.assign({}, e, {titulo: ""}), false)).join("\n")]);
  return saida;
}

async function hl(corpo) {
  const r = await fetch("https://api.hyperliquid.xyz/info", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(corpo)});
  if (!r.ok) throw new Error("Hyperliquid " + r.status);
  return r.json();
}
const usd = x => { const a = Math.abs(x); return "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(1) + "K" : a.toFixed(0)); };
// a = tamanho antes, b = agora (positivo = long, negativo = short); devolve o texto do aviso ou null
function mudanca(a, b, px, coin) {
  const L = x => x > 0 ? "LONG" : "SHORT";
  if (!a && b) return "abriu " + L(b) + " " + coin + " de " + usd(Math.abs(b) * px);
  if (a && !b) return "fechou o " + L(a) + " " + coin + " (" + usd(Math.abs(a) * px) + ")";
  if (a && b && Math.sign(a) !== Math.sign(b)) return "virou de " + L(a) + " para " + L(b) + " " + coin + " (" + usd(Math.abs(b) * px) + ")";
  if (a && b) {
    const d = Math.abs(b) - Math.abs(a);
    if (Math.abs(d) / Math.abs(a) >= MUDA_PCT && Math.abs(d) * px >= MUDA_USD)
      return (d > 0 ? "aumentou" : "reduziu") + " o " + L(b) + " " + coin + " em " + usd(Math.abs(d) * px) + " (agora " + usd(Math.abs(b) * px) + ")";
  }
  return null;
}
