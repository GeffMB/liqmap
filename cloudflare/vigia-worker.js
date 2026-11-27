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
    ctx.waitUntil((async () => { const b = await base(env); if (TG) await automaticosBot(env, b, evento.scheduledTime / 1000); })().catch(e => console.log("Bot auto:", e.message)));
  },
  // abrir o endereço do Worker no navegador mostra o status; /rodar força uma verificação agora
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === "/tg" && req.method === "POST") {
      // mensagens do Telegram: confere o segredo, responde 200 na hora e processa em segundo plano
      let upd; try { upd = await req.json(); } catch (e) { return new Response("ok"); }
      const seg = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      ctx.waitUntil((async () => {
        const b = await base(env);
        if (!TG || seg !== await segredoTG(TG.token)) return;
        await atenderTelegram(env, upd, b);
      })().catch(async e => { console.log("bot", e.message); try { if (TG) await enviar("⚠️ Erro ao responder: " + e.message); } catch (x) {} }));
      return new Response("ok");
    }
    if (u.pathname === "/rodar") {
      try {
        const r = await vigiar(env, new Date(), true);
        if (TG) {   // registra o webhook do bot (só muda algo se o endereço/token mudou)
          const b = await base(env), url = u.origin + "/tg", ass = url + "|" + (await segredoTG(TG.token)).slice(0, 8);
          if (b.bot.webhook !== ass || u.searchParams.has("webhook")) { const w = await configurarWebhook(url); r.bot = w.ok ? "webhook registrado agora" : "erro no webhook: " + w.description; if (w.ok) { b.bot.webhook = ass; await salvarBot(env, b.gid, b.bot); } }
          else r.bot = "webhook ok";
          const info = await tg("getWebhookInfo", {}); if (info.ok) { r.botPendentes = info.result.pending_update_count; if (info.result.last_error_message) r.botUltimoErro = info.result.last_error_message; }
        }
        return json(r);
      }
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
    arquivos[ARQ_VIGIA] = {content: JSON.stringify({ultimo: agora, disparados, ativos, fonte: "cloudflare", versao: 7, telegram: !!TG, carteiras: Object.keys(novosSnaps).length, fontesPreco, errosPreco})};
  if (mudouCart || (rastreadas.length && minuto % 10 === 0)) arquivos[ARQ_CART] = {content: JSON.stringify({ultimo: agora, fonte: "cloudflare", snaps: novosSnaps})};
  if (novoEv) arquivos[ARQ_EV] = {content: novoEv};
  if (mudouSync) {
    pac.dados = dados; pac.atualizado = Date.now();
    arquivos[ARQ_SYNC] = {content: JSON.stringify(pac)};
  }
  if (Object.keys(arquivos).length) await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: arquivos}});
  return {ok: true, versao: 7, telegram: TG ? "conectado (@" + (TG.bot || "bot") + ")" : "desligado", gist: gid, ativos, disparados: avisos, carteiras: rastreadas.length, avisosCarteiras: avisosCart, avisosEventos: avisosEv, fontesPreco, errosPreco, quando: quando.toISOString()};
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

// =====================================================================================
// BOT DO TELEGRAM: comandos (/preco, /alerta, /alertas, /fundo, /relatorio) e avisos
// automáticos (resumo da manhã, painel de fundo mudou de faixa, movimento brusco, ETFs).
// O Telegram entrega as mensagens em /tg (webhook); o vigia (a cada minuto) roda os automáticos.
// Preço e indicadores: Kraken (spot, responde de qualquer servidor); derivativos: Hyperliquid.
// =====================================================================================
const MOEDAS_BOT = {
  BTC: {s: "BTCUSDT", kr: "XBTUSD", hl: "BTC", cm: "btc", etf: "etfBtc", cx: "btc", brusco: 2},
  ETH: {s: "ETHUSDT", kr: "ETHUSD", hl: "ETH", cm: "eth", etf: "etfEth", cx: "eth", brusco: 2.5},
  SOL: {s: "SOLUSDT", kr: "SOLUSD", hl: "SOL", brusco: 3.5},
  XRP: {s: "XRPUSDT", kr: "XRPUSD", hl: "XRP", brusco: 3.5},
  QNT: {s: "QNTUSDT", kr: "QNTUSD"}
};
const ARQ_BOT = "liqmap-bot.json";
const URL_FLUXOS = "https://geffmb.github.io/liqmap/fluxos.json";
const SITE = "https://geffmb.github.io/liqmap/";
const AJUDA = `🤖 LiqMap — comandos

/precoBTC — preço, tendência e derivativos (troque BTC por ETH, SOL, XRP ou QNT)
/alertaETH 1700 — cria uma linha com alerta em 1.700 no gráfico (pode pôr uma nota: /alertaETH 1700 suporte)
/alertas — suas linhas com alerta, com botões para desligar ou apagar
/fundoBTC — placar do Painel de fundo (BTC ou ETH)
/relatorioETH — relatório completo em texto, pronto para colar na IA
/silenciar e /retomar — pausa ou volta os avisos automáticos (os alertas de linha continuam)

Avisos automáticos: resumo às 8h, Painel de fundo mudando de faixa, movimentos bruscos (≥2% em 15 min) e fluxo diário dos ETFs.`;

// ---------- Telegram ----------
async function segredoTG(token){
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("liqmap:" + token));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function tg(metodo, corpo){
  const r = await fetch("https://api.telegram.org/bot" + TG.token + "/" + metodo, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(corpo)});
  return r.json();
}
async function enviar(txt, extra = {}){
  const partes = []; let resto = String(txt);
  while (resto.length > 3800) { let i = resto.lastIndexOf("\n", 3800); if (i < 1000) i = 3800; partes.push(resto.slice(0, i)); resto = resto.slice(i).replace(/^\n/, ""); }
  partes.push(resto);
  for (let i = 0; i < partes.length; i++) await tg("sendMessage", Object.assign({chat_id: TG.chat, text: partes[i], disable_web_page_preview: true}, i === partes.length - 1 ? extra : {}));
}
const botoesMoeda = (cmd, quais = Object.keys(MOEDAS_BOT)) => ({reply_markup: {inline_keyboard: [quais.map(m => ({text: m, callback_data: cmd + ":" + m}))]}});
async function configurarWebhook(url){
  const s = await segredoTG(TG.token);
  const r = await tg("setWebhook", {url, secret_token: s, allowed_updates: ["message", "callback_query"], drop_pending_updates: true});
  await tg("setMyCommands", {commands: [
    {command: "precobtc", description: "Preço e tendência do BTC"}, {command: "precoeth", description: "Preço e tendência do ETH"},
    {command: "alertas", description: "Minhas linhas com alerta"}, {command: "fundobtc", description: "Painel de fundo do BTC"},
    {command: "relatoriobtc", description: "Relatório completo do BTC"}, {command: "relatorioeth", description: "Relatório completo do ETH"},
    {command: "ajuda", description: "Todos os comandos"}]});
  return r;
}

// ---------- formatação ----------
const f2 = (x, d = 2) => x == null || !isFinite(x) ? "—" : (+x).toLocaleString("pt-BR", {minimumFractionDigits: d, maximumFractionDigits: d});
const pcB = (x, d = 1) => x == null || !isFinite(x) ? "—" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d).replace(".", ",") + "%";
const usB = (x, sinal) => { if (x == null || !isFinite(x)) return "—"; const a = Math.abs(x), s = x < 0 ? "−" : sinal ? "+" : "";
  return s + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + " bi" : a >= 1e6 ? (a / 1e6).toFixed(1) + " mi" : a >= 1e3 ? (a / 1e3).toFixed(0) + " mil" : a.toFixed(0)).replace(".", ","); };
const P = p => p == null || !isFinite(p) ? "—" : pr(p);
const dataBRT = (ms, comHora = true) => new Date(ms).toLocaleString("pt-BR", Object.assign({timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit"}, comHora ? {hour: "2-digit", minute: "2-digit"} : {}));

// ---------- dados de mercado ----------
async function kraken(m, intervalo){
  const r = await fetch("https://api.kraken.com/0/public/OHLC?pair=" + MOEDAS_BOT[m].kr + "&interval=" + intervalo);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error("Kraken " + j.error[0]);
  const k = Object.keys(j.result).find(x => x !== "last");
  return j.result[k].map(x => ({t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6]}));
}
async function hlCtx(){
  const j = await hl({type: "metaAndAssetCtxs"}); const out = {};
  j[0].universe.forEach((u, i) => out[u.name] = j[1][i]);
  return out;
}
const pega = p => p.catch(() => null);
function emaB(a, n){ const k = 2 / (n + 1), out = []; let e = null, s = 0; a.forEach((x, i) => { if (i < n) { s += x; if (i === n - 1) e = s / n; } else e = x * k + e * (1 - k); out.push(e); }); return out; }
function smaB(a, n){ if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; }
function rsiB(c, n = 14){ if (c.length <= n) return null; let g = 0, p = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], a = Math.max(d, 0), b = Math.max(-d, 0);
  if (i <= n) { g += a / n; p += b / n; } else { g = (g * (n - 1) + a) / n; p = (p * (n - 1) + b) / n; } } return p === 0 ? 100 : 100 - 100 / (1 + g / p); }
function macdB(c){
  const r = emaB(c, 12), l = emaB(c, 26), m = []; c.forEach((_, i) => { if (r[i] != null && l[i] != null) m.push(r[i] - l[i]); });
  if (m.length < 12) return null;
  const s = emaB(m, 9), h = m.map((x, i) => s[i] == null ? null : x - s[i]).filter(x => x != null);
  let cruz = ""; for (let i = Math.max(1, h.length - 3); i < h.length; i++) { if (h[i - 1] < 0 && h[i] >= 0) cruz = "cruzou p/ cima"; if (h[i - 1] > 0 && h[i] <= 0) cruz = "cruzou p/ baixo"; }
  return {linha: m[m.length - 1], hist: h[h.length - 1], subindo: h[h.length - 1] > h[h.length - 2], subindo2: h[h.length - 1] > h[h.length - 2] && h[h.length - 2] > h[h.length - 3], cruz};
}
function linhaTF(nome, v){
  if (!v || v.length < 30) return `• ${nome}: sem dados`;
  const c = v.map(x => x.c), p = c[c.length - 1], e21 = emaB(c, 21).pop(), s200 = smaB(c, 200), r = rsiB(c), m = macdB(c);
  const pos = x => x == null ? "—" : p >= x ? "acima" : "abaixo";
  return `• ${nome}: MME21 ${pos(e21)} · MMS200 ${s200 ? pos(s200) : "—"} · IFR ${f2(r, 0)}${r >= 70 ? " (sobrecomprado)" : r <= 30 ? " (sobrevendido)" : ""} · MACD ${m ? (m.hist >= 0 ? "positivo" : "negativo") + (m.subindo ? " subindo" : " caindo") + (m.cruz ? ", " + m.cruz : "") : "—"}`;
}

// ---------- base (Gist) ----------
async function base(env){
  const gid = await acharGist(env);
  const g = await gh(env, "/gists/" + gid);
  const pac = (await conteudo(g, ARQ_SYNC)) || {};
  const dados = pac.dados || {};
  let cfg = {}; try { cfg = JSON.parse(dados.liqmap2 || "{}"); } catch (e) {}
  TG = cfg.telegram && cfg.telegram.token && cfg.telegram.chat ? cfg.telegram : null;
  const bot = (await conteudo(g, ARQ_BOT)) || {};
  return {gid, g, pac, dados, cfg, bot};
}
async function salvarBot(env, gid, bot){ await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: {[ARQ_BOT]: {content: JSON.stringify(bot)}}}}); }
function linhasDe(dados, m){
  const s = MOEDAS_BOT[m].s; let ds = [];
  try { ds = JSON.parse(dados["liqmap-des-" + s] || "[]"); } catch (e) {}
  return ds;
}

// ---------- preço ----------
async function textoPreco(m, dados){
  const M = MOEDAS_BOT[m];
  const [h1, h4, d1, ctx] = await Promise.all([pega(kraken(m, 60)), pega(kraken(m, 240)), pega(kraken(m, 1440)), M.hl ? pega(hlCtx()) : null]);
  if (!h1) return `Não consegui o preço de ${m} agora. Tente de novo em instantes.`;
  const c = h1.map(x => x.c), p = c[c.length - 1], u24 = h1.slice(-24);
  const L = [`💰 ${m} — ${P(p)} (spot)`];
  L.push(`1h ${pcB((p / c[c.length - 2] - 1) * 100, 2)} · 24h ${pcB((p / c[c.length - 25] - 1) * 100, 2)}` + (d1 ? ` · 7d ${pcB((p / d1[d1.length - 8].c - 1) * 100)} · 30d ${pcB((p / d1[d1.length - 31].c - 1) * 100)}` : ""));
  L.push(`Máx/mín 24h: ${P(Math.max(...u24.map(x => x.h)))} / ${P(Math.min(...u24.map(x => x.l)))}`);
  L.push("", "📈 Tendência");
  L.push(linhaTF("1h", h1)); L.push(linhaTF("4h", h4)); L.push(linhaTF("Diário", d1));
  const x = ctx && M.hl ? ctx[M.hl] : null;
  if (x) {
    const f8 = +x.funding * 100 * 8;
    L.push("", "⚙️ Derivativos (Hyperliquid)");
    L.push(`Funding ${f2(f8, 4)}% por 8h${f8 < 0 ? " (vendidos pagando)" : f8 > 0.03 ? " (comprados pagando caro)" : ""} · OI ${usB(+x.openInterest * +x.markPx)} · volume 24h ${usB(+x.dayNtlVlm)}`);
  }
  const al = linhasDe(dados, m).filter(d => d.alerta && (d.tipo === "horizontal" || d.tipo === "raioH") && d.pts && d.pts[0]).map(d => d.pts[0].p);
  const acima = al.filter(v => v > p).sort((a, b) => a - b)[0], abaixo = al.filter(v => v < p).sort((a, b) => b - a)[0];
  if (acima || abaixo) L.push("", `🔔 Seus alertas mais perto: ${acima ? "acima " + P(acima) + " (" + pcB((acima / p - 1) * 100) + ")" : ""}${acima && abaixo ? " · " : ""}${abaixo ? "abaixo " + P(abaixo) + " (" + pcB((abaixo / p - 1) * 100) + ")" : ""}`);
  // leitura rápida
  const ler = [];
  if (d1) { const cd = d1.map(k => k.c), s200 = smaB(cd, 200), r = rsiB(cd), mm = macdB(cd);
    if (s200) ler.push(p >= s200 ? "acima da média de 200 dias (tendência longa de alta)" : "abaixo da média de 200 dias (tendência longa de baixa)");
    if (r != null && r <= 30) ler.push("IFR diário sobrevendido");
    if (r != null && r >= 70) ler.push("IFR diário sobrecomprado");
    if (mm && mm.linha < 0 && mm.subindo2) ler.push("MACD diário perdendo força vendedora");
    if (mm && mm.linha > 0 && !mm.subindo && mm.hist > 0) ler.push("MACD diário perdendo força compradora"); }
  if (x && +x.funding < 0) ler.push("funding negativo: mercado vendido, combustível para repique");
  if (ler.length) L.push("", "🧭 Leitura: " + ler.join("; ") + ".");
  return L.join("\n");
}

// ---------- painel de fundo (versão do bot) ----------
async function calcFundo(m, comp = {}){
  const M = MOEDAS_BOT[m]; if (!M.cm) return null;
  const [w1, d1, mv, fng, flx, fund, ctx] = await Promise.all([
    comp["w" + m] || pega(kraken(m, 10080)), comp["d" + m] || pega(kraken(m, 1440)),
    comp.mvrv || pega(fetch("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc,eth&metrics=CapMVRVCur&frequency=1d&page_size=40&start_time=" + new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10)).then(r => r.json())),
    comp.fng || pega(fetch("https://api.alternative.me/fng/?limit=7").then(r => r.json())),
    comp.flx || pega(fetch(URL_FLUXOS, {cf: {cacheTtl: 300}}).then(r => r.json())),
    pega(hl({type: "fundingHistory", coin: M.hl, startTime: Date.now() - 3 * 864e5})),
    comp.ctx || pega(hlCtx())
  ]);
  const out = [], add = (nome, valor, st) => out.push({nome, valor, st});
  const p = d1 ? d1[d1.length - 1].c : null;
  // 1 MVRV
  const pts = mv && mv.data ? mv.data.filter(x => x.asset === M.cm && x.CapMVRVCur != null) : [];
  if (pts.length) { const v = +pts[pts.length - 1].CapMVRVCur; add("MVRV abaixo de 1", f2(v), v <= 1 ? 2 : v <= 1.3 ? 1 : 0); } else add("MVRV abaixo de 1", "sem dado", -1);
  // 2 média de 200 semanas
  if (w1 && w1.length >= 200 && p) { const ms = smaB(w1.map(x => x.c), 200), d = (p / ms - 1) * 100; add("Preço perto da média de 200 semanas", pcB(d) + " da média (" + P(ms) + ")", d <= 5 ? 2 : d <= 20 ? 1 : 0); }
  else add("Preço perto da média de 200 semanas", "sem dado", -1);
  // 3 IFR
  if (d1 && w1) { const rd = rsiB(d1.map(x => x.c)), rw = rsiB(w1.map(x => x.c)); add("IFR sobrevendido", "diário " + f2(rd, 1) + " · semanal " + f2(rw, 1), rd <= 30 || rw <= 35 ? 2 : rd <= 40 || rw <= 45 ? 1 : 0); }
  else add("IFR sobrevendido", "sem dado", -1);
  // 4 MACD diário
  if (d1) { const mm = macdB(d1.map(x => x.c)); const st = mm && mm.linha < 0 && (mm.cruz === "cruzou p/ cima" || (mm.hist < 0 && mm.subindo2)) ? 2 : mm && mm.linha < 0 && mm.subindo ? 1 : 0;
    add("MACD diário virando para cima", mm ? "hist. " + f2(mm.hist, 2) + (mm.linha < 0 ? " · abaixo de zero" : " · acima de zero") + (mm.cruz ? " · " + mm.cruz : mm.subindo ? " · subindo" : " · caindo") : "—", st); }
  else add("MACD diário virando para cima", "sem dado", -1);
  // 5 funding 3 dias (Hyperliquid, convertido para 8h)
  if (fund && fund.length) { const v = fund.reduce((a, x) => a + +x.fundingRate, 0) / fund.length * 100 * 8; add("Funding neutro ou negativo", f2(v, 4) + "% (média 3 dias, Hyperliquid)", v <= 0 ? 2 : v <= 0.005 ? 1 : 0); }
  else add("Funding neutro ou negativo", "sem dado", -1);
  // 6 open interest vs pico (histórico guardado pelo próprio vigia)
  add("Alavancagem limpa (OI caiu)", "—", -1);
  // 7 medo e ganância
  if (fng && fng.data) { const v = +fng.data[0].value; add("Medo extremo", v + "/100", v <= 25 ? 2 : v <= 40 ? 1 : 0); } else add("Medo extremo", "sem dado", -1);
  // 8 ETFs
  const e = flx && flx[M.etf] ? flx[M.etf].dias.filter(x => x.total != null) : [];
  if (e.length >= 5) { const u = e.slice(-5), s = u.reduce((a, x) => a + x.total, 0), ul = u[u.length - 1].total; add("ETFs voltando a comprar", usB(s * 1e6, true) + " em 5 dias", s > 0 && ul > 0 ? 2 : s > 0 || ul > 0 ? 1 : 0); }
  else add("ETFs voltando a comprar", "sem dado", -1);
  // 9 stablecoins
  const sr = flx && flx.stables ? flx.stables.serie : [];
  if (sr.length >= 8) { const d = (sr[sr.length - 1][1] / sr[sr.length - 8][1] - 1) * 100; add("Stablecoins crescendo", pcB(d, 2) + " em 7 dias", d > 0.5 ? 2 : d > 0 ? 1 : 0); }
  else add("Stablecoins crescendo", "sem dado", -1);
  // 10 corretoras (só moedas)
  const cx = flx && flx.cex ? flx.cex : [];
  if (cx.length) { const s7 = cx.reduce((a, c) => a + (c.d7_mo ?? c.d7 ?? 0), 0), s1 = cx.reduce((a, c) => a + (c.d1_mo ?? c.d1 ?? 0), 0); add("Moedas saindo das corretoras", usB(s7, true) + " em 7 dias", s7 < 0 ? 2 : s1 < 0 ? 1 : 0); }
  else add("Moedas saindo das corretoras", "sem dado", -1);
  return {out, n: out.filter(x => x.st === 2).length, meio: out.filter(x => x.st === 1).length, preco: p};
}
// alavancagem: guarda 1 foto por dia do OI da Hyperliquid (em moedas) e compara com o pico de 30 dias
function aplicarOI(f, m, bot){
  const h = (bot.oiHist || {})[m] || [];
  const item = f.out.find(x => x.nome.startsWith("Alavancagem"));
  if (!item || h.length < 7) { if (item) item.valor = "juntando histórico (" + h.length + " de 7 dias)"; return; }
  const pico = Math.max(...h.map(x => x[1])), atual = h[h.length - 1][1], d = (atual / pico - 1) * 100;
  item.valor = pcB(d) + " do pico de " + h.length + " dias (Hyperliquid)"; item.st = d <= -15 ? 2 : d <= -8 ? 1 : 0;
  f.n = f.out.filter(x => x.st === 2).length; f.meio = f.out.filter(x => x.st === 1).length;
}
const faixaFundo = n => n >= 7 ? "sinais fortes de fundo" : n >= 4 ? "zona de atenção" : "longe de um fundo";
function textoFundo(m, f){
  return `🎯 Painel de fundo ${m}: ${f.n}/10 ✅${f.meio ? " (+" + f.meio + " ⚠️)" : ""} — ${faixaFundo(f.n)}\n` +
    f.out.map(x => `${x.st === 2 ? "✅" : x.st === 1 ? "⚠️" : x.st === 0 ? "✖" : "…"} ${x.nome}: ${x.valor}`).join("\n") +
    `\n\n(No bot, preço e funding vêm da Kraken e Hyperliquid; pode diferir um pouco da página do site.)`;
}

// ---------- relatório ----------
async function textoRelatorio(m, dados, bot){
  const M = MOEDAS_BOT[m];
  const [h1, h4, d1, w1, ctx, flx] = await Promise.all([pega(kraken(m, 60)), pega(kraken(m, 240)), pega(kraken(m, 1440)), pega(kraken(m, 10080)), M.hl ? pega(hlCtx()) : null, pega(fetch(URL_FLUXOS).then(r => r.json()))]);
  const L = [`RELATÓRIO LIQMAP (bot) — ${m} — ${dataBRT(Date.now())} (Brasília)`, "Dados públicos: Kraken (preço), Hyperliquid (derivativos), CoinMetrics, alternative.me, Farside, DefiLlama.", ""];
  if (h1) { const c = h1.map(x => x.c), p = c[c.length - 1], u = h1.slice(-24);
    L.push("1) PREÇO", `- Spot: ${P(p)} · 1h ${pcB((p / c[c.length - 2] - 1) * 100, 2)} · 24h ${pcB((p / c[c.length - 25] - 1) * 100, 2)}` + (d1 ? ` · 7d ${pcB((p / d1[d1.length - 8].c - 1) * 100)} · 30d ${pcB((p / d1[d1.length - 31].c - 1) * 100)}` : ""),
      `- Máx/mín 24h: ${P(Math.max(...u.map(x => x.h)))} / ${P(Math.min(...u.map(x => x.l)))}`, ""); }
  L.push("2) TENDÊNCIA (MME 21, MMS 200, IFR 14, MACD 12/26/9)", linhaTF("1h", h1), linhaTF("4h", h4), linhaTF("Diário", d1), linhaTF("Semanal", w1));
  if (w1 && w1.length >= 200 && h1) { const ms = smaB(w1.map(x => x.c), 200); L.push(`• Média de 200 semanas: ${P(ms)} (preço ${pcB((h1[h1.length - 1].c / ms - 1) * 100)})`); }
  L.push("");
  const x = ctx && M.hl ? ctx[M.hl] : null;
  if (x) L.push("3) DERIVATIVOS (Hyperliquid)", `- Funding ${f2(+x.funding * 800, 4)}% por 8h · open interest ${usB(+x.openInterest * +x.markPx)} · volume 24h ${usB(+x.dayNtlVlm)} · prêmio sobre o índice ${pcB(+x.premium * 100, 3)}`, "");
  if (M.cm) { const f = await calcFundo(m, {["w" + m]: Promise.resolve(w1), ["d" + m]: Promise.resolve(d1), flx: Promise.resolve(flx), ctx: Promise.resolve(ctx)}); if (f) { aplicarOI(f, m, bot); L.push("4) " + textoFundo(m, f).split("\n\n")[0], ""); } }
  if (flx) {
    L.push("5) FLUXO DE DINHEIRO");
    for (const [k, nome] of [["etfBtc", "BTC"], ["etfEth", "ETH"]]) { const e = (flx[k] && flx[k].dias || []).filter(d => d.total != null); if (e.length) { const u = e[e.length - 1], s5 = e.slice(-5).reduce((a, d) => a + d.total, 0);
      L.push(`- ETFs de ${nome}: último pregão (${u.data.split("-").reverse().slice(0, 2).join("/")}) ${usB(u.total * 1e6, true)} · 5 pregões ${usB(s5 * 1e6, true)}`); } }
    const sr = flx.stables ? flx.stables.serie : []; if (sr.length >= 8) L.push(`- Stablecoins: ${pcB((sr[sr.length - 1][1] / sr[sr.length - 8][1] - 1) * 100, 2)} em 7 dias`);
    const cx = flx.cex || []; if (cx.length) { const k7 = M.cx ? "d7_" + M.cx : "d7_mo"; const s7 = cx.reduce((a, c) => a + (c[k7] ?? 0), 0);
      L.push(`- Corretoras (7 dias, ${M.cx ? "só " + m : "todas as moedas"}): ${usB(s7, true)} ${s7 < 0 ? "(saindo: acumulação)" : "(entrando: possível venda)"}`); }
    L.push("");
  }
  const al = linhasDe(dados, m).filter(d => (d.tipo === "horizontal" || d.tipo === "raioH") && d.pts && d.pts[0]);
  if (al.length) L.push("6) MINHAS LINHAS", ...al.sort((a, b) => b.pts[0].p - a.pts[0].p).map(d => `- ${P(d.pts[0].p)}${d.alerta ? " [alerta]" : ""}${d.nota ? ' "' + d.nota + '"' : ""}`), "");
  try { const evs = ((await (await fetch(URL_EVENTOS)).json()).eventos || []).filter(e => e.t > Date.now() && e.t < Date.now() + 7 * 864e5 && e.impacto === "High").slice(0, 6);
    L.push("7) AGENDA (EUA, alto impacto, 7 dias)", ...(evs.length ? evs.map(e => `- ${dataBRT(e.t)}: ${e.titulo}`) : ["- nada de alto impacto"]), ""); } catch (e) {}
  L.push("Mapa de liquidações, POCs e futuros por período: use o 📋 Relatório do site.", "Não é recomendação de investimento.");
  return L.join("\n");
}

// ---------- alertas ----------
function lerPrecoTxt(t, ref){
  t = String(t).trim().replace(/\s|\$/g, ""); if (!t) return null;
  if (t.includes(",")) return +t.replace(/\./g, "").replace(",", ".");
  const a = +t, b = +t.replace(/\./g, "");
  if (!isFinite(a)) return null;
  if (!t.includes(".") || !ref) return a;
  return Math.abs(Math.log(a / ref)) <= Math.abs(Math.log(b / ref)) ? a : b;
}
async function mexerDesenhos(env, sym, f){
  const gid = await acharGist(env);
  const g = await gh(env, "/gists/" + gid);
  const pac = (await conteudo(g, ARQ_SYNC)) || {}; pac.dados = pac.dados || {}; pac.mod = pac.mod || {};
  const k = "liqmap-des-" + sym; let ds = []; try { ds = JSON.parse(pac.dados[k] || "[]"); } catch (e) {}
  const r = f(ds);
  if (r === false) return false;
  pac.dados[k] = JSON.stringify(ds); pac.mod[k] = Date.now(); pac.atualizado = Date.now();
  await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: {[ARQ_SYNC]: {content: JSON.stringify(pac)}}}});
  return r;
}
async function criarAlerta(env, m, args){
  const M = MOEDAS_BOT[m];
  const h1 = await pega(kraken(m, 60)); const ref = h1 ? h1[h1.length - 1].c : null;
  const [ptxt, ...resto] = args.split(/\s+/);
  const p = lerPrecoTxt(ptxt, ref);
  if (!p || !isFinite(p) || p <= 0) return `Faltou o preço. Exemplo: /alerta${m} ${ref ? Math.round(ref) : 1000}`;
  if (ref && Math.abs(p / ref - 1) > 0.6) return `${P(p)} está muito longe do preço atual de ${m} (${P(ref)}). Confira o valor.`;
  const nota = resto.join(" ").slice(0, 40);
  const agora = Date.now();
  await mexerDesenhos(env, M.s, ds => { ds.push(Object.assign({id: "t" + agora.toString(36), tipo: "horizontal", pts: [{t: Math.floor(agora / 1000), p}], alerta: true, alertaDesde: agora, mod: agora}, nota ? {nota} : {})); });
  return `✅ Alerta criado: ${m} em ${P(p)}${ref ? " (" + pcB((p / ref - 1) * 100) + " do preço atual " + P(ref) + ")" : ""}${nota ? ' — "' + nota + '"' : ""}\nA linha aparece no gráfico do site e o aviso chega aqui quando o preço tocar.`;
}
async function listarAlertas(dados, filtro){
  const linhas = [], botoes = [];
  for (const m of Object.keys(MOEDAS_BOT)) {
    if (filtro && filtro !== m) continue;
    for (const d of linhasDe(dados, m)) {
      if (!d.alerta || !d.pts || !d.pts[0]) continue;
      const desc = (d.tipo === "horizontal" || d.tipo === "raioH") ? P(d.pts[0].p) : d.tipo === "linha" ? "linha inclinada" : d.tipo;
      linhas.push(`🔔 ${m} ${desc}${d.nota ? ' "' + d.nota + '"' : ""}`);
      if (d.id) botoes.push([{text: "🔕 " + m + " " + desc, callback_data: "off:" + m + ":" + d.id}, {text: "🗑 apagar", callback_data: "del:" + m + ":" + d.id}]);
    }
  }
  if (!linhas.length) return {txt: "Nenhuma linha com alerta ligado" + (filtro ? " em " + filtro : "") + ". Crie com /alertaBTC 60000"};
  return {txt: "Suas linhas com alerta (🔕 desliga o alerta e mantém a linha; 🗑 apaga a linha):\n\n" + linhas.join("\n"), extra: {reply_markup: {inline_keyboard: botoes.slice(0, 40)}}};
}

// ---------- recebe as mensagens do Telegram ----------
async function atenderTelegram(env, upd, b){
  if (!TG) return;
  const cq = upd.callback_query, msg = upd.message;
  const chat = cq ? cq.message && cq.message.chat && cq.message.chat.id : msg && msg.chat && msg.chat.id;
  if (String(chat) !== String(TG.chat)) return;   // só o dono do bot
  if (cq) {
    await tg("answerCallbackQuery", {callback_query_id: cq.id});
    const [acao, m, id] = String(cq.data || "").split(":");
    if ((acao === "off" || acao === "del") && MOEDAS_BOT[m]) {
      const ok = await mexerDesenhos(env, MOEDAS_BOT[m].s, ds => { const i = ds.findIndex(d => d.id === id); if (i < 0) return false;
        if (acao === "del") ds.splice(i, 1); else { ds[i].alerta = false; ds[i].mod = Date.now(); } return true; });
      return enviar(ok ? (acao === "del" ? "🗑 Linha apagada." : "🔕 Alerta desligado (a linha continua no gráfico).") : "Não achei essa linha (talvez já tenha sido apagada).");
    }
    if (MOEDAS_BOT[m]) return comando(env, b, acao, m, "");
    return;
  }
  const txt = (msg && msg.text || "").trim();
  const r = txt.match(/^\/([a-zçã]+?)(btc|eth|sol|xrp|qnt)?(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!r) return enviar("Não entendi. Envie /ajuda para ver os comandos.");
  let cmd = r[1].toLowerCase(), m = r[2] ? r[2].toUpperCase() : null, args = (r[3] || "").trim();
  if (!m && args) { const t = args.split(/\s+/)[0].toUpperCase(); if (MOEDAS_BOT[t]) { m = t; args = args.slice(t.length).trim(); } }
  return comando(env, b, cmd, m, args);
}
async function comando(env, b, cmd, m, args){
  if (cmd === "start" || cmd === "ajuda" || cmd === "help") return enviar(AJUDA);
  if (cmd === "silenciar" || cmd === "retomar") { b.bot.auto = cmd === "retomar"; await salvarBot(env, b.gid, b.bot); return enviar(cmd === "retomar" ? "🔔 Avisos automáticos ligados." : "🔕 Avisos automáticos pausados. Os alertas das suas linhas continuam. Use /retomar para voltar."); }
  if (cmd === "alertas") { const l = await listarAlertas(b.dados, m); return enviar(l.txt, l.extra || {}); }
  const precisa = {preco: "preço", alerta: "alerta", fundo: "painel de fundo", relatorio: "relatório"}[cmd];
  if (!precisa) return enviar("Comando desconhecido. Envie /ajuda para ver os comandos.");
  if (!m) return enviar("Escolha a moeda para o " + precisa + (cmd === "alerta" ? " (depois envie, por exemplo, /alertaETH 1700)" : "") + ":", botoesMoeda(cmd, cmd === "fundo" ? ["BTC", "ETH"] : undefined));
  if (cmd === "preco") return enviar(await textoPreco(m, b.dados));
  if (cmd === "alerta") {
    if (!args) { const h = await pega(kraken(m, 60)), p = h ? h[h.length - 1].c : null; return enviar(`${m} está em ${P(p)}. Envie o preço do alerta assim:\n/alerta${m} ${p ? (+p.toPrecision(3)) : 1000}\n(pode acrescentar uma nota depois do preço)`); }
    return enviar(await criarAlerta(env, m, args));
  }
  if (cmd === "fundo") { if (!MOEDAS_BOT[m].cm) return enviar("O Painel de fundo existe para BTC e ETH."); const f = await calcFundo(m); aplicarOI(f, m, b.bot); return enviar(textoFundo(m, f)); }
  if (cmd === "relatorio") return enviar(await textoRelatorio(m, b.dados, b.bot));
}

// ---------- avisos automáticos (chamado pelo vigia a cada minuto) ----------
async function automaticosBot(env, b, agoraS){
  if (!TG) return [];
  const {gid, dados, bot} = b;
  const feitos = []; let mudou = false;
  const p = partesBRT(agoraS), hoje = p.year + "-" + p.month + "-" + p.day, min = Math.floor(agoraS / 60);
  // foto diária do open interest (Hyperliquid) para o critério de alavancagem do painel de fundo
  if (bot.oiDia !== hoje) {
    try { const ctx = await hlCtx(); bot.oiHist = bot.oiHist || {};
      for (const m of ["BTC", "ETH"]) { const h = bot.oiHist[m] || []; h.push([hoje, +ctx[m].openInterest]); bot.oiHist[m] = h.slice(-30); }
      bot.oiDia = hoje; mudou = true; } catch (e) {}
  }
  let pesado = false;   // o plano grátis do Cloudflare limita as consultas por minuto: tarefa pesada pula o "brusco" daquele minuto
  if (bot.auto !== false) {
    // 1) resumo da manhã, a partir das 8h (horário de Brasília)
    if (bot.resumo !== hoje && +p.hour >= 8 && +p.hour < 12) {
      try {
        const flx = pega(fetch(URL_FLUXOS).then(r => r.json())), fng = pega(fetch("https://api.alternative.me/fng/?limit=7").then(r => r.json())), ctx = pega(hlCtx());
        const L = [`☀️ Bom dia! Resumo LiqMap — ${dataBRT(agoraS * 1000, false)}`];
        for (const m of ["BTC", "ETH"]) {
          const d1 = await pega(kraken(m, 1440)), w1 = await pega(kraken(m, 10080));
          const f = await calcFundo(m, {["d" + m]: Promise.resolve(d1), ["w" + m]: Promise.resolve(w1), flx, fng, ctx});
          if (f) { aplicarOI(f, m, bot); bot.fundo = bot.fundo || {}; bot.fundo[m] = f.n; }
          if (d1) { const c = d1.map(k => k.c), pp = c[c.length - 1], r = rsiB(c);
            L.push("", `${m}: ${P(pp)} (24h ${pcB((pp / c[c.length - 2] - 1) * 100)}, 7d ${pcB((pp / c[c.length - 8] - 1) * 100)}) · IFR diário ${f2(r, 0)}` + (f ? `\n🎯 Fundo ${f.n}/10 ✅ — ${faixaFundo(f.n)}` : "")); }
        }
        const x = await ctx; if (x) L.push("", `Funding (8h): BTC ${f2(+x.BTC.funding * 800, 4)}% · ETH ${f2(+x.ETH.funding * 800, 4)}%`);
        const fg = await fng; if (fg && fg.data) L.push(`Medo e Ganância: ${fg.data[0].value}/100 (${fg.data[0].value_classification})`);
        try { const evs = ((await (await fetch(URL_EVENTOS)).json()).eventos || []).filter(e => { const q = partesBRT(e.t / 1000); return q.year + "-" + q.month + "-" + q.day === hoje && e.impacto === "High"; });
          L.push("", evs.length ? "📅 Hoje (EUA): " + evs.map(e => horaBRT(e.t / 1000) + " " + e.titulo).join(" · ") : "📅 Sem evento de alto impacto nos EUA hoje."); } catch (e) {}
        let n = 0; for (const m of Object.keys(MOEDAS_BOT)) n += linhasDe(dados, m).filter(d => d.alerta).length;
        L.push(`🔔 ${n} alerta(s) de linha ligado(s). /alertas para ver.`);
        await enviar(L.join("\n")); bot.resumo = hoje; mudou = true; pesado = true; feitos.push("resumo");
      } catch (e) { console.log("resumo", e.message); }
    }
    // 2) painel de fundo mudou de faixa (a cada 30 min)
    else if (min % 30 === 7) {
      pesado = true;
      try {
        const flx = pega(fetch(URL_FLUXOS).then(r => r.json())), fng = pega(fetch("https://api.alternative.me/fng/?limit=7").then(r => r.json())), ctx = pega(hlCtx());
        bot.fundo = bot.fundo || {};
        for (const m of ["BTC", "ETH"]) {
          const f = await calcFundo(m, {flx, fng, ctx}); if (!f) continue; aplicarOI(f, m, bot);
          const ant = bot.fundo[m], fx = n => n >= 7 ? 2 : n >= 4 ? 1 : 0;
          if (ant != null && fx(ant) !== fx(f.n)) { await enviar(`🎯 Painel de fundo ${m} mudou: ${ant}/10 → ${f.n}/10 ✅ — agora "${faixaFundo(f.n)}".\n\n` + textoFundo(m, f)); feitos.push("fundo " + m); }
          if (ant !== f.n) { bot.fundo[m] = f.n; mudou = true; }
        }
      } catch (e) { console.log("fundo", e.message); }
    }
    // 3) ETFs: novo pregão publicado (a cada 30 min)
    else if (min % 30 === 17) {
      try {
        const flx = await (await fetch(URL_FLUXOS)).json();
        const ub = (flx.etfBtc && flx.etfBtc.dias || []).filter(d => d.total != null).pop(), ue = (flx.etfEth && flx.etfEth.dias || []).filter(d => d.total != null).pop();
        if (ub && bot.etfDia && ub.data > bot.etfDia) {
          const top = d => Object.entries(d.fundos || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2).map(([k, v]) => k + " " + usB(v * 1e6, true)).join(", ");
          const s5 = k => (flx[k].dias || []).filter(d => d.total != null).slice(-5).reduce((a, d) => a + d.total, 0);
          await enviar(`📊 ETFs dos EUA — pregão de ${ub.data.split("-").reverse().slice(0, 2).join("/")}\nBTC: ${usB(ub.total * 1e6, true)} (${top(ub)}) · 5 dias ${usB(s5("etfBtc") * 1e6, true)}` +
            (ue ? `\nETH: ${usB(ue.total * 1e6, true)} (${top(ue)}) · 5 dias ${usB(s5("etfEth") * 1e6, true)}` : "") +
            `\n${ub.total > 0 ? "Instituições comprando." : "Instituições vendendo."}`);
          feitos.push("etf");
        }
        if (ub && bot.etfDia !== ub.data) { bot.etfDia = ub.data; mudou = true; }
      } catch (e) { console.log("etf", e.message); }
    }
    // 4) movimento brusco: ≥ 2% em 15 minutos (BTC; ETH 2,5%; SOL/XRP 3,5%)
    if (!pesado) try {
      bot.brusco = bot.brusco || {};
      // BTC e ETH todo minuto; SOL e XRP alternando (a janela de 16 min cobre a folga)
      for (const m of ["BTC", "ETH", min % 2 ? "SOL" : "XRP"]) {
        const ks = await hl({type: "candleSnapshot", req: {coin: m, interval: "1m", startTime: Date.now() - 17 * 6e4, endTime: Date.now()}});
        if (!ks || ks.length < 15) continue;
        const ini = +ks[ks.length - 16 >= 0 ? ks.length - 16 : 0].o, fim = +ks[ks.length - 1].c, d = (fim / ini - 1) * 100;
        const lado = d > 0 ? "alta" : "queda", k = m + lado;
        if (Math.abs(d) >= MOEDAS_BOT[m].brusco && agoraS - (bot.brusco[k] || 0) > 3600) {
          const mx = Math.max(...ks.map(x => +x.h)), mn = Math.min(...ks.map(x => +x.l));
          await enviar(`⚡ ${m} ${d > 0 ? "subiu" : "caiu"} ${pcB(d)} em 15 min (${P(ini)} → ${P(fim)}; máx ${P(mx)}, mín ${P(mn)}).\nMovimento brusco: provável cascata de liquidações de ${d > 0 ? "shorts" : "longs"}. Veja o mapa no site.`);
          bot.brusco[k] = agoraS; mudou = true; feitos.push("brusco " + m);
        }
      }
    } catch (e) { console.log("brusco", e.message); }
  }
  if (mudou) await salvarBot(env, gid, bot);
  return feitos;
}
