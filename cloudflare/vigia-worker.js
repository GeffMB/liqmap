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
      const job = (async () => {
        const b = await base(env);
        if (!TG || seg !== await segredoTG(TG.token)) return;
        await atenderTelegram(env, upd, b);
      })().catch(async e => { console.log("bot", e.message); try { if (TG) await enviar("⚠️ Não consegui responder agora (" + e.message + "). Tente de novo em 1 minuto."); } catch (x) {} });
      // a análise por IA pode passar dos 30 s do segundo plano: nesse caso o Telegram espera a resposta
      const t = (upd.message && upd.message.text) || (upd.callback_query && upd.callback_query.data) || "";
      if (/^\/?an[aá]lise/i.test(t)) await job; else ctx.waitUntil(job);
      return new Response("ok");
    }
    if (u.pathname === "/rodar") {
      try {
        const r = await vigiar(env, new Date(), true);
        if (TG) {   // registra o webhook do bot (só muda algo se o endereço/token mudou)
          const b = await base(env), url = u.origin + "/tg", ass = url + "|" + (await segredoTG(TG.token)).slice(0, 8) + "|v8" + (IA ? "ia" : "");
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
  const desligar = {};   // desenhos cujo alerta o vigia desligou (aplicados sobre uma cópia nova da nuvem na hora de gravar)
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
      if (disparados[ch]) { d.alerta = false; mudou = true; (desligar[k] = desligar[k] || []).push(d); continue; }
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
        disparados[ch] = agora; mudou = true; (desligar[k] = desligar[k] || []).push(d);
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
    arquivos[ARQ_VIGIA] = {content: JSON.stringify({ultimo: agora, disparados, ativos, fonte: "cloudflare", versao: 8, telegram: !!TG, carteiras: Object.keys(novosSnaps).length, fontesPreco, errosPreco})};
  if (mudouCart || (rastreadas.length && minuto % 10 === 0)) arquivos[ARQ_CART] = {content: JSON.stringify({ultimo: agora, fonte: "cloudflare", snaps: novosSnaps})};
  if (novoEv) arquivos[ARQ_EV] = {content: novoEv};
  if (mudouSync) {
    // relê a nuvem agora (um computador pode ter gravado durante esta verificação) e só desliga os alertas disparados,
    // sem regravar o resto — assim nenhum desenho feito nesse meio-tempo se perde
    const novo = (await conteudo(await gh(env, "/gists/" + gid), ARQ_SYNC)) || pac;
    novo.dados = novo.dados || {}; novo.mod = novo.mod || {};
    const igual = (a, b) => a.id && b.id ? a.id === b.id : a.tipo === b.tipo && JSON.stringify(a.pts) === JSON.stringify(b.pts);
    for (const [k, lista] of Object.entries(desligar)) {
      let ds; try { ds = JSON.parse(novo.dados[k] || "[]"); } catch (e) { continue; }
      for (const d of ds) { const x = lista.find(y => igual(y, d)); if (x && d.alerta) { d.alerta = false; if (x.disparadoVigia) d.disparadoVigia = x.disparadoVigia; } }
      novo.dados[k] = JSON.stringify(ds); novo.mod[k] = Date.now();
    }
    novo.atualizado = Date.now();
    arquivos[ARQ_SYNC] = {content: JSON.stringify(novo)};
  }
  if (Object.keys(arquivos).length) await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: arquivos}});
  return {ok: true, versao: 8, telegram: TG ? "conectado (@" + (TG.bot || "bot") + ")" : "desligado", gist: gid, ativos, disparados: avisos, carteiras: rastreadas.length, avisosCarteiras: avisosCart, avisosEventos: avisosEv, fontesPreco, errosPreco, quando: quando.toISOString()};
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
const AJUDA = `🤖 LiqMap — comandos (troque ETH por BTC, SOL, XRP ou QNT)

💰 Mercado
/precoETH — preço, tendência e derivativos
/graficoETH 4h — gráfico em imagem (1h, 4h, diário, semanal) com suas linhas
/fundoETH — Painel de fundo (BTC ou ETH)
/relatorioETH — relatório completo em texto
/analiseETH — análise por IA com cenários
/carteiras — posições das baleias que você rastreia

🔔 Alertas
/alertaETH 1700 suporte — linha de preço no gráfico (com nota)
/alertaETH -5% — linha 5% abaixo do preço atual (ou +5%)
/alertaETH fecha 1800 diário — só se a vela FECHAR além do nível
/alertaETH ifr 30 diário — IFR chegar em 30
/alertaETH macd 4h — MACD cruzar
/alertaETH mms200 diário — preço perder/recuperar a MMS200 (ou mme21)
/alertas — lista, desliga ou apaga

💼 Diário de operações
/compreiETH 1700 0.5 stop 1600 alvo 1900 — registra a compra e cria stop e alvo no gráfico
/vendiETH 1850 — fecha a posição (ou /vendiETH 1850 0.2 parcial; sem posição, abre short)
/operacoes — posições abertas, resultado e mês

⚙️ /silenciar e /retomar — pausa ou volta os avisos automáticos

Automáticos: resumo às 8h, fechamento da semana (domingo 21h), Painel de fundo mudando de faixa, movimentos bruscos, funding e open interest extremos e fluxo diário dos ETFs.`;

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
    {command: "graficobtc", description: "Gráfico do BTC (imagem)"}, {command: "graficoeth", description: "Gráfico do ETH (imagem)"},
    {command: "alertas", description: "Meus alertas"}, {command: "fundobtc", description: "Painel de fundo do BTC"},
    {command: "fundoeth", description: "Painel de fundo do ETH"}, {command: "operacoes", description: "Diário de operações"},
    {command: "carteiras", description: "Posições das baleias rastreadas"}, {command: "relatorioeth", description: "Relatório completo do ETH"},
    ...(IA ? [{command: "analiseeth", description: "Análise por IA do ETH"}] : []), {command: "ajuda", description: "Todos os comandos"}]});
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
// velas com reserva: Kraken (spot) → OKX (spot) → Hyperliquid (perpétuo). Guarda por alguns minutos para não
// repetir a mesma consulta (a Kraken recusa com "Too many requests" quando o Cloudflare pede demais).
const MEMO_VELAS = new Map();
const OKX_BAR = {60: "1H", 240: "4H", 1440: "1Dutc", 10080: "1Wutc"}, HL_BAR = {15: "15m", 60: "1h", 240: "4h", 1440: "1d", 10080: "1w"};
async function kraken(m, intervalo){
  const k = m + "|" + intervalo, ttl = intervalo <= 60 ? 45e3 : intervalo <= 240 ? 180e3 : 600e3, c = MEMO_VELAS.get(k);
  if (c && Date.now() - c.t < ttl) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    const erros = [];
    const fontes = [
      async () => {
        for (let tent = 0; tent < 2; tent++) {
          const j = await (await fetch("https://api.kraken.com/0/public/OHLC?pair=" + MOEDAS_BOT[m].kr + "&interval=" + intervalo)).json();
          if (j.error && j.error.length) { if (/too many/i.test(j.error[0]) && !tent) { await new Promise(r => setTimeout(r, 1500)); continue; } throw new Error("Kraken " + j.error[0]); }
          const kk = Object.keys(j.result).find(x => x !== "last");
          return j.result[kk].map(x => ({t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6]}));
        }
      },
      async () => {
        if (!OKX_BAR[intervalo]) throw new Error("OKX sem esse tempo");
        const j = await (await fetch("https://www.okx.com/api/v5/market/candles?instId=" + m + "-USDT&bar=" + OKX_BAR[intervalo] + "&limit=300")).json();
        if (j.code !== "0" || !j.data || !j.data.length) throw new Error("OKX " + (j.msg || j.code));
        return j.data.map(x => ({t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5]})).reverse();
      },
      async () => {
        if (!MOEDAS_BOT[m].hl || !HL_BAR[intervalo]) throw new Error("Hyperliquid sem essa moeda");
        const ks = await hl({type: "candleSnapshot", req: {coin: MOEDAS_BOT[m].hl, interval: HL_BAR[intervalo], startTime: Date.now() - 720 * intervalo * 6e4, endTime: Date.now()}});
        if (!ks || !ks.length) throw new Error("Hyperliquid vazio");
        return ks.map(x => ({t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v}));
      }];
    for (const f of fontes) { try { const v = await f(); if (v && v.length) return v; } catch (e) { erros.push(e.message); } }
    throw new Error("sem velas de " + m + " (" + erros.join("; ") + ")");
  })();
  MEMO_VELAS.set(k, {t: 0, p});
  try { const v = await p; MEMO_VELAS.set(k, {t: Date.now(), v}); return v; }
  catch (e) { MEMO_VELAS.delete(k); throw e; }
}
// funding (média de 3 dias, por 8h) e open interest de 30 dias em corretora centralizada (Gate → OKX), como o site faz com a Binance
async function fundingCEX(m){
  try { const j = await (await fetch("https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=" + m + "_USDT&limit=9")).json();
    if (Array.isArray(j) && j.length) return {v: j.reduce((a, x) => a + +x.r, 0) / j.length * 100, fonte: "Gate"}; } catch (e) {}
  try { const j = await (await fetch("https://www.okx.com/api/v5/public/funding-rate-history?instId=" + m + "-USDT-SWAP&limit=9")).json();
    if (j.data && j.data.length) return {v: j.data.reduce((a, x) => a + +x.realizedRate, 0) / j.data.length * 100, fonte: "OKX"}; } catch (e) {}
  try { const f = await hl({type: "fundingHistory", coin: MOEDAS_BOT[m].hl, startTime: Date.now() - 3 * 864e5});
    if (f && f.length) return {v: f.reduce((a, x) => a + +x.fundingRate, 0) / f.length * 100 * 8, fonte: "Hyperliquid"}; } catch (e) {}
  return null;
}
async function oiCEX(m){
  try { const j = await (await fetch("https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=" + m + "_USDT&interval=1d&limit=30")).json();
    if (Array.isArray(j) && j.length >= 7) { const s = j.map(x => +x.open_interest).filter(x => x > 0); if (s.length >= 7) return {pico: Math.max(...s), atual: s[s.length - 1], dias: s.length, fonte: "Gate"}; } } catch (e) {}
  return null;
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
  IA = !!env.ANTHROPIC_API_KEY;
  const gid = await acharGist(env);
  const g = await gh(env, "/gists/" + gid);
  const pac = (await conteudo(g, ARQ_SYNC)) || {};
  const dados = pac.dados || {};
  let cfg = {}; try { cfg = JSON.parse(dados.liqmap2 || "{}"); } catch (e) {}
  TG = cfg.telegram && cfg.telegram.token && cfg.telegram.chat ? cfg.telegram : null;
  const bot = (await conteudo(g, ARQ_BOT)) || {};
  const bu = (await conteudo(g, ARQ_BOTU)) || {};
  if (bu.auto == null && bot.auto != null) bu.auto = bot.auto;
  return {gid, g, pac, dados, cfg, bot, bu};
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
    pega(fundingCEX(m)), pega(oiCEX(m))
  ]);
  const oi = ctx;
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
  if (fund) { const v = fund.v; add("Funding neutro ou negativo", f2(v, 4) + "% por 8h (média 3 dias, " + fund.fonte + ")", v <= 0 ? 2 : v <= 0.005 ? 1 : 0); }
  else add("Funding neutro ou negativo", "sem dado", -1);
  // 6 open interest vs pico (histórico guardado pelo próprio vigia)
  if (oi) { const d = (oi.atual / oi.pico - 1) * 100; add("Alavancagem limpa (OI caiu)", pcB(d) + " do pico de " + oi.dias + " dias (" + oi.fonte + ")", d <= -15 ? 2 : d <= -8 ? 1 : 0); }
  else add("Alavancagem limpa (OI caiu)", "—", -1);
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
  if (item && item.st !== -1) return;   // já veio da corretora
  if (!item || h.length < 7) { if (item) item.valor = "juntando histórico (" + h.length + " de 7 dias)"; return; }
  const pico = Math.max(...h.map(x => x[1])), atual = h[h.length - 1][1], d = (atual / pico - 1) * 100;
  item.valor = pcB(d) + " do pico de " + h.length + " dias (Hyperliquid)"; item.st = d <= -15 ? 2 : d <= -8 ? 1 : 0;
  f.n = f.out.filter(x => x.st === 2).length; f.meio = f.out.filter(x => x.st === 1).length;
}
const faixaFundo = n => n >= 7 ? "sinais fortes de fundo" : n >= 4 ? "zona de atenção" : "longe de um fundo";
function textoFundo(m, f){
  return `🎯 Painel de fundo ${m}: ${f.n}/10 ✅${f.meio ? " (+" + f.meio + " ⚠️)" : ""} — ${faixaFundo(f.n)}\n` +
    f.out.map(x => `${x.st === 2 ? "✅" : x.st === 1 ? "⚠️" : x.st === 0 ? "✖" : "…"} ${x.nome}: ${x.valor}`).join("\n") +
    (f.out.some(x => x.st === -1) ? `\n\n(… = fonte fora do ar agora; tente de novo em alguns minutos.)` : "") +
    `\n\nFontes do bot: preço spot da Kraken (reserva: OKX), funding e OI da Gate. O site usa a Binance; diferenças pequenas são normais.`;
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
const MARCAR_APAGADOS = [];   // ids de desenhos apagados pelo bot: vão para pac.apagados (lista de apagados que os computadores respeitam)
async function mexerDesenhos(env, sym, f){
  const gid = await acharGist(env);
  const g = await gh(env, "/gists/" + gid);
  const pac = (await conteudo(g, ARQ_SYNC)) || {}; pac.dados = pac.dados || {}; pac.mod = pac.mod || {};
  const k = "liqmap-des-" + sym; let ds = []; try { ds = JSON.parse(pac.dados[k] || "[]"); } catch (e) {}
  const r = f(ds);
  if (r === false) return false;
  pac.dados[k] = JSON.stringify(ds); pac.mod[k] = Date.now(); pac.atualizado = Date.now();
  if (MARCAR_APAGADOS.length) { pac.apagados = pac.apagados || {}; for (const id of MARCAR_APAGADOS.splice(0)) if (id) pac.apagados[id] = Date.now(); }
  await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: {[ARQ_SYNC]: {content: JSON.stringify(pac)}}}});
  return r;
}
async function criarAlerta(env, m, args){
  const M = MOEDAS_BOT[m];
  const h1 = await pega(kraken(m, 60)); const ref = h1 ? h1[h1.length - 1].c : null;
  const [ptxt, ...resto] = args.split(/\s+/);
  const pc = ptxt.match(/^([+-]?\d+(?:[.,]\d+)?)%$/);
  const p = pc ? (ref ? ref * (1 + parseFloat(pc[1].replace(",", ".")) / 100) : null) : lerPrecoTxt(ptxt, ref);
  if (!p || !isFinite(p) || p <= 0) return `Faltou o preço. Exemplo: /alerta${m} ${ref ? Math.round(ref) : 1000}`;
  if (ref && Math.abs(p / ref - 1) > 0.6) return `${P(p)} está muito longe do preço atual de ${m} (${P(ref)}). Confira o valor.`;
  const nota = resto.join(" ").slice(0, 40);
  const agora = Date.now();
  await mexerDesenhos(env, M.s, ds => { ds.push(Object.assign({id: "t" + agora.toString(36), tipo: "horizontal", pts: [{t: Math.floor(agora / 1000), p}], alerta: true, alertaDesde: agora, mod: agora}, nota ? {nota} : {})); });
  return `✅ Alerta criado: ${m} em ${P(p)}${ref ? " (" + pcB((p / ref - 1) * 100) + " do preço atual " + P(ref) + ")" : ""}${nota ? ' — "' + nota + '"' : ""}\nA linha aparece no gráfico do site e o aviso chega aqui quando o preço tocar.`;
}
async function listarAlertas(dados, filtro, bu = {}){
  const linhas = [], botoes = [];
  for (const a of bu.ind || []) { if (filtro && filtro !== a.m) continue;
    linhas.push(`📊 ${a.m} ${descInd(a)}`); botoes.push([{text: "🗑 " + a.m + " " + a.tipo.toUpperCase() + " " + NOME_TF[a.iv], callback_data: "deli:" + a.m + ":" + a.id}]); }
  for (const m of Object.keys(MOEDAS_BOT)) {
    if (filtro && filtro !== m) continue;
    for (const d of linhasDe(dados, m)) {
      if (!d.alerta || !d.pts || !d.pts[0]) continue;
      const desc = (d.tipo === "horizontal" || d.tipo === "raioH") ? P(d.pts[0].p) : d.tipo === "linha" ? "linha inclinada" : d.tipo;
      linhas.push(`🔔 ${m} ${desc}${d.nota ? ' "' + d.nota + '"' : ""}`);
      if (d.id) botoes.push([{text: "🔕 " + m + " " + desc, callback_data: "off:" + m + ":" + d.id}, {text: "🗑 apagar", callback_data: "del:" + m + ":" + d.id}]);
    }
  }
  if (!linhas.length) return {txt: "Nenhum alerta ligado" + (filtro ? " em " + filtro : "") + ". Crie com /alertaBTC 60000 ou /alertaBTC ifr 30 diário"};
  return {txt: "Seus alertas (🔕 desliga o alerta e mantém a linha; 🗑 apaga):\n\n" + linhas.join("\n"), extra: {reply_markup: {inline_keyboard: botoes.slice(0, 40)}}};
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
        if (acao === "del") { MARCAR_APAGADOS.push(ds[i].id); ds.splice(i, 1); } else { ds[i].alerta = false; ds[i].mod = Date.now(); } return true; });
      return enviar(ok ? (acao === "del" ? "🗑 Linha apagada." : "🔕 Alerta desligado (a linha continua no gráfico).") : "Não achei essa linha (talvez já tenha sido apagada).");
    }
    if (acao === "deli") { const n = (b.bu.ind || []).length; b.bu.ind = (b.bu.ind || []).filter(a => a.id !== id);
      if (b.bu.ind.length === n) return enviar("Esse alerta já não existe."); await salvarBotU(env, b.gid, b.bu); return enviar("🗑 Alerta de indicador apagado."); }
    if (MOEDAS_BOT[m]) return comando(env, b, acao, m, "");
    return;
  }
  const txt = (msg && msg.text || "").trim();
  const r = txt.match(/^\/([^\s@\d]+?)(btc|eth|sol|xrp|qnt)?(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!r) return enviar("Não entendi. Envie /ajuda para ver os comandos.");
  let cmd = r[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""), m = r[2] ? r[2].toUpperCase() : null, args = (r[3] || "").trim();
  if (!m && args) { const t = args.split(/\s+/)[0].toUpperCase(); if (MOEDAS_BOT[t]) { m = t; args = args.slice(t.length).trim(); } }
  return comando(env, b, cmd, m, args);
}
async function comando(env, b, cmd, m, args){
  const alias = {help: "ajuda", start: "ajuda", grafico: "grafico", chart: "grafico", ops: "operacoes", operacao: "operacoes", posicoes: "operacoes", diario: "operacoes", compra: "comprei", comprar: "comprei", venda: "vendi", vender: "vendi", baleias: "carteiras", carteira: "carteiras", ia: "analise"};
  cmd = alias[cmd] || cmd;
  if (cmd === "ajuda") return enviar(IA ? AJUDA : AJUDA.replace(/\n\/analiseETH[^\n]*/, ""), TECLADO);
  if (cmd === "silenciar" || cmd === "retomar") { b.bu.auto = cmd === "retomar"; await salvarBotU(env, b.gid, b.bu); return enviar(cmd === "retomar" ? "🔔 Avisos automáticos ligados." : "🔕 Avisos automáticos pausados. Os alertas de linha e de indicador continuam. Use /retomar para voltar."); }
  if (cmd === "alertas") { const l = await listarAlertas(b.dados, m, b.bu); return enviar(l.txt, l.extra || {}); }
  if (cmd === "carteiras") return enviar(await textoCarteiras(b.dados));
  if (cmd === "operacoes") return enviar(await textoOps(b.bu));
  if (cmd === "zerardiario") { if (args.toLowerCase() !== "sim") return enviar("Isso apaga todas as operações registradas. Para confirmar, envie: /zerardiario sim");
    b.bu.ops = {pos: {}, hist: []}; await salvarBotU(env, b.gid, b.bu); return enviar("🗑 Diário de operações zerado (as linhas do gráfico continuam)."); }
  const precisa = {preco: "preço", alerta: "alerta", fundo: "painel de fundo", relatorio: "relatório", grafico: "gráfico", analise: "análise", comprei: "registro de compra", vendi: "registro de venda"}[cmd];
  if (!precisa) return enviar("Comando desconhecido. Envie /ajuda para ver os comandos.");
  if (!m) return enviar("Escolha a moeda para o " + precisa + (cmd === "alerta" ? " (depois envie, por exemplo, /alertaETH 1700)" : cmd === "comprei" || cmd === "vendi" ? " (depois envie, por exemplo, /" + cmd + "ETH 1700 0.5)" : "") + ":", botoesMoeda(cmd === "comprei" || cmd === "vendi" ? "preco" : cmd, cmd === "fundo" ? ["BTC", "ETH"] : undefined));
  if (cmd === "preco") return enviar(await textoPreco(m, b.dados), atalhos(m));
  if (cmd === "grafico") return enviarGrafico(m, args, b.dados);
  if (cmd === "analise") return enviar(await analiseIA(env, m, b.dados, b.bot));
  if (cmd === "comprei" || cmd === "vendi") return enviar(await operar(env, b, m, cmd === "comprei" ? 1 : -1, args));
  if (cmd === "alerta") {
    if (!args) { const h = await pega(kraken(m, 60)), p = h ? h[h.length - 1].c : null; return enviar(`${m} está em ${P(p)}. Exemplos:\n/alerta${m} ${p ? (+p.toPrecision(3)) : 1000} — linha de preço\n/alerta${m} -5% — 5% abaixo\n/alerta${m} fecha ${p ? (+p.toPrecision(2)) : 1000} diário — fechamento\n/alerta${m} ifr 30 diário · /alerta${m} macd 4h · /alerta${m} mms200 diário`); }
    const partes = args.split(/\s+/);
    if (/^(ifr|rsi|macd|mms200|mme21|fecha|fechar|fechamento)$/i.test(partes[0])) { if (/^rsi$/i.test(partes[0])) partes[0] = "ifr"; return enviar(await criarAlertaInd(env, b, m, partes)); }
    return enviar(await criarAlerta(env, m, args));
  }
  if (cmd === "fundo") { if (!MOEDAS_BOT[m].cm) return enviar("O Painel de fundo existe para BTC e ETH."); const f = await calcFundo(m); aplicarOI(f, m, b.bot); return enviar(textoFundo(m, f)); }
  if (cmd === "relatorio") return enviar(await textoRelatorio(m, b.dados, b.bot));
}

// ---------- avisos automáticos (chamado pelo vigia a cada minuto) ----------
async function automaticosBot(env, b, agoraS){
  if (!TG) return [];
  const {gid, dados, bot, bu} = b;
  const feitos = []; let mudou = false;
  const p = partesBRT(agoraS), hoje = p.year + "-" + p.month + "-" + p.day, min = Math.floor(agoraS / 60);
  // foto diária do open interest (Hyperliquid) para o critério de alavancagem do painel de fundo
  if (bot.oiDia !== hoje) {
    try { const ctx = await hlCtx(); bot.oiHist = bot.oiHist || {};
      for (const m of ["BTC", "ETH"]) { const h = bot.oiHist[m] || []; h.push([hoje, +ctx[m].openInterest]); bot.oiHist[m] = h.slice(-30); }
      bot.oiDia = hoje; mudou = true; } catch (e) {}
  }
  // (pesado declarado acima) o plano grátis do Cloudflare limita as consultas por minuto: tarefa pesada pula o "brusco" daquele minuto
  let pesado = false;
  // alertas de indicador e de fechamento (são pedidos seus: rodam mesmo com /silenciar), a cada 5 min
  if (min % 5 === 4) { try { const f = await verificarInd(env, b, agoraS); feitos.push(...f); if ((bu.ind || []).length > 2) pesado = true; } catch (e) { console.log("ind", e.message); } }
  if (bu.auto !== false) {
    // 1) resumo da manhã, a partir das 8h (horário de Brasília)
    if (bot.resumo !== hoje && +p.hour >= 8 && +p.hour < 12) {
      try {
        const flx = pega(fetch(URL_FLUXOS).then(r => r.json())), fng = pega(fetch("https://api.alternative.me/fng/?limit=7").then(r => r.json())), ctx = pega(hlCtx());
        const L = [`☀️ Bom dia! Resumo LiqMap — ${dataBRT(agoraS * 1000, false)}`];
        for (const m of ["BTC", "ETH"]) {
          const d1 = await pega(kraken(m, 1440)), w1 = await pega(kraken(m, 10080));
          const f = await calcFundo(m, {["d" + m]: Promise.resolve(d1), ["w" + m]: Promise.resolve(w1), flx, fng, ctx});
          if (f) { aplicarOI(f, m, bot); if (!f.out.some(x => x.st === -1 && !x.nome.startsWith("Alavancagem"))) { bot.fundo = bot.fundo || {}; bot.fundo[m] = f.n; } }
          if (d1) { const c = d1.map(k => k.c), pp = c[c.length - 1], r = rsiB(c);
            L.push("", `${m}: ${P(pp)} (24h ${pcB((pp / c[c.length - 2] - 1) * 100)}, 7d ${pcB((pp / c[c.length - 8] - 1) * 100)}) · IFR diário ${f2(r, 0)}` + (f ? `\n🎯 Fundo ${f.n}/10 ✅ — ${faixaFundo(f.n)}` : "")); }
        }
        const x = await ctx; if (x) L.push("", `Funding (8h): BTC ${f2(+x.BTC.funding * 800, 4)}% · ETH ${f2(+x.ETH.funding * 800, 4)}%`);
        const fg = await fng; if (fg && fg.data) L.push(`Medo e Ganância: ${fg.data[0].value}/100 (${fg.data[0].value_classification})`);
        try { const evs = ((await (await fetch(URL_EVENTOS)).json()).eventos || []).filter(e => { const q = partesBRT(e.t / 1000); return q.year + "-" + q.month + "-" + q.day === hoje && e.impacto === "High"; });
          L.push("", evs.length ? "📅 Hoje (EUA): " + evs.map(e => horaBRT(e.t / 1000) + " " + e.titulo).join(" · ") : "📅 Sem evento de alto impacto nos EUA hoje."); } catch (e) {}
        let n = 0; for (const m of Object.keys(MOEDAS_BOT)) n += linhasDe(dados, m).filter(d => d.alerta).length;
        L.push(`🔔 ${n} alerta(s) de linha ligado(s). /alertas para ver.`);
        if (p.day === "01") { const t = textoMes(bu, agoraS); if (t) L.push("", t); }
        const ab = Object.entries(((bu.ops || {}).pos) || {}).filter(([, x]) => x.q).length; if (ab) L.push(`💼 ${ab} posição(ões) aberta(s) no diário. /operacoes`);
        await enviar(L.join("\n"), atalhos("BTC")); bot.resumo = hoje; mudou = true; pesado = true; feitos.push("resumo");
      } catch (e) { console.log("resumo", e.message); }
    }
    // 1b) fechamento da semana: domingo a partir das 21h (horário de Brasília)
    else if (p.weekday === "Sun" && +p.hour >= 21 && bot.semana !== hoje) {
      pesado = true;
      try { await enviar(await textoSemana(bot, bu, agoraS), atalhos("BTC")); bot.semana = hoje; mudou = true; feitos.push("semana"); } catch (e) { console.log("semana", e.message); }
    }
    // 1c) funding e open interest extremos (a cada 5 min)
    else if (min % 5 === 1) {
      try { const ctx = await hlCtx(); for (const t of extremos(ctx, bot, agoraS)) { await enviar(t); feitos.push("extremo"); } mudou = true; } catch (e) { console.log("extremos", e.message); }
    }
    // 2) painel de fundo mudou de faixa (a cada 30 min)
    else if (min % 30 === 7) {
      pesado = true;
      try {
        const flx = pega(fetch(URL_FLUXOS).then(r => r.json())), fng = pega(fetch("https://api.alternative.me/fng/?limit=7").then(r => r.json())), ctx = pega(hlCtx());
        bot.fundo = bot.fundo || {};
        for (const m of ["BTC", "ETH"]) {
          const f = await calcFundo(m, {flx, fng, ctx}); if (!f) continue; aplicarOI(f, m, bot);
          if (f.out.some(x => x.st === -1 && !x.nome.startsWith("Alavancagem"))) continue;   // fonte fora do ar: não compara (evita aviso falso)
          const ant = bot.fundo[m], fx = n => n >= 7 ? 2 : n >= 4 ? 1 : 0;
          if (ant != null && fx(ant) !== fx(f.n)) { await enviar(`🎯 Painel de fundo ${m} mudou: ${ant}/10 → ${f.n}/10 ✅ — agora "${faixaFundo(f.n)}".\n\n` + textoFundo(m, f), atalhos(m)); feitos.push("fundo " + m); }
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
          await enviar(`⚡ ${m} ${d > 0 ? "subiu" : "caiu"} ${pcB(d)} em 15 min (${P(ini)} → ${P(fim)}; máx ${P(mx)}, mín ${P(mn)}).\nMovimento brusco: provável cascata de liquidações de ${d > 0 ? "shorts" : "longs"}. Veja o mapa no site.`, atalhos(m));
          bot.brusco[k] = agoraS; mudou = true; feitos.push("brusco " + m);
        }
      }
    } catch (e) { console.log("brusco", e.message); }
  }
  if (mudou) await salvarBot(env, gid, bot);
  return feitos;
}

// =====================================================================================
// BOT — parte 2: alertas de indicador e de fechamento, funding/OI extremos, gráfico em imagem,
// fechamento semanal, /carteiras, diário de operações (com stop e alvo) e análise por IA.
// Dados do usuário (alertas de indicador, operações, silenciar) ficam em liqmap-bot-usuario.json,
// separado do estado dos automáticos, para um não sobrescrever o outro.
// =====================================================================================
const ARQ_BOTU = "liqmap-bot-usuario.json";
let IA = false;   // só mostra a análise por IA se a chave ANTHROPIC_API_KEY existir no Cloudflare
const TFS = {"15m": 15, "1h": 60, "4h": 240, "1d": 1440, "d": 1440, "diario": 1440, "diário": 1440, "1w": 10080, "w": 10080, "semanal": 10080};
const NOME_TF = {15: "15m", 60: "1h", 240: "4h", 1440: "diário", 10080: "semanal"};
const lerTF = (t, pad = 1440) => TFS[String(t || "").toLowerCase()] || pad;
async function salvarBotU(env, gid, bu){ await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: {[ARQ_BOTU]: {content: JSON.stringify(bu)}}}}); }
const atalhos = m => ({reply_markup: {inline_keyboard: [
  [{text: "📈 Gráfico " + m, callback_data: "grafico:" + m}, {text: "💰 Preço", callback_data: "preco:" + m}, {text: "🎯 Fundo", callback_data: "fundo:" + (MOEDAS_BOT[m].cm ? m : "BTC")}],
  [{text: "📋 Relatório", callback_data: "relatorio:" + m}].concat(IA ? [{text: "🧠 Análise IA", callback_data: "analise:" + m}] : [])]}});
const TECLADO = {reply_markup: {keyboard: [["/precoBTC", "/precoETH"], ["/graficoBTC", "/graficoETH"], ["/fundoBTC", "/alertas"], ["/operacoes", "/carteiras"]], resize_keyboard: true, is_persistent: true}};
function smaSerie(c, n){ const out = []; let s = 0; c.forEach((x, i) => { s += x; if (i >= n) s -= c[i - n]; out.push(i >= n - 1 ? s / n : null); }); return out; }

// ---------- 1 e 2) alertas de indicador e de fechamento ----------
function estadoInd(a, v){
  const c = v.map(x => x.c);
  if (a.tipo === "ifr") return rsiB(c);
  if (a.tipo === "macd") { const m = macdB(c); return m ? Math.sign(m.hist) : null; }
  if (a.tipo === "mms200" || a.tipo === "mme21") { const ma = a.tipo === "mms200" ? smaB(c, 200) : emaB(c, 21).pop(); return ma ? Math.sign(c[c.length - 1] - ma) : null; }
  return null;
}
const descInd = a => a.tipo === "ifr" ? `IFR ${NOME_TF[a.iv]} ${a.dir > 0 ? "acima de" : "abaixo de"} ${a.lim}`
  : a.tipo === "macd" ? `MACD ${NOME_TF[a.iv]} cruzar (${a.ant > 0 ? "para baixo" : "para cima"})`
  : a.tipo === "fecha" ? `vela ${NOME_TF[a.iv]} fechar ${a.dir > 0 ? "acima de" : "abaixo de"} ${P(a.lim)}`
  : `preço ${a.ant > 0 ? "perder" : "recuperar"} a ${a.tipo === "mms200" ? "MMS200" : "MME21"} ${NOME_TF[a.iv]}`;
async function criarAlertaInd(env, b, m, partes){
  const tipo = partes[0].toLowerCase();
  const v1 = await kraken(m, 60); const ref = v1[v1.length - 1].c;
  let a = {id: "i" + Date.now().toString(36), m, tipo, criado: Date.now()};
  if (tipo === "ifr") {
    const lim = parseFloat(String(partes[1] || "").replace(",", "."));
    if (!(lim > 0 && lim < 100)) return "Exemplo: /alerta" + m + " ifr 30 diário (avisa quando o IFR diário chegar em 30)";
    a.lim = lim; a.iv = lerTF(partes[2]);
    const v = await kraken(m, a.iv), atual = rsiB(v.map(x => x.c)); a.dir = atual > lim ? -1 : 1;
    a.txtAtual = "IFR " + NOME_TF[a.iv] + " agora: " + f2(atual, 1);
  } else if (tipo === "macd" || tipo === "mms200" || tipo === "mme21") {
    a.iv = lerTF(partes[1]);
    const v = await kraken(m, a.iv); a.ant = estadoInd(a, v);
    if (a.ant == null || a.ant === 0) return "Não consegui calcular esse indicador agora.";
    a.txtAtual = tipo === "macd" ? "MACD " + NOME_TF[a.iv] + " agora " + (a.ant > 0 ? "positivo" : "negativo") : "Preço agora " + (a.ant > 0 ? "acima" : "abaixo") + " da média";
  } else if (tipo === "fecha" || tipo === "fechar" || tipo === "fechamento") {
    a.tipo = "fecha"; a.lim = lerPrecoTxt(partes[1] || "", ref); a.iv = lerTF(partes[2]);
    if (!a.lim) return "Exemplo: /alerta" + m + " fecha 1800 diário (avisa só se a vela diária FECHAR além de 1.800)";
    a.dir = a.lim > ref ? 1 : -1; a.txtAtual = "Preço agora: " + P(ref);
  } else return null;
  b.bu.ind = (b.bu.ind || []).concat(a).slice(-30);
  await salvarBotU(env, b.gid, b.bu);
  return `✅ Alerta criado: ${m} — ${descInd(a)}.\n${a.txtAtual}. Confiro a cada 5 minutos.`;
}
async function verificarInd(env, b, agoraS){
  const lista = b.bu.ind || []; if (!lista.length) return [];
  const pares = [...new Set(lista.map(a => a.m + "|" + a.iv))].slice(0, 6), velas = {};
  for (const k of pares) { const [m, iv] = k.split("|"); velas[k] = await pega(kraken(m, +iv)); }
  const ficam = [], feitos = [];
  for (const a of lista) {
    const v = velas[a.m + "|" + a.iv]; if (!v) { ficam.push(a); continue; }
    let disparou = null; const p = v[v.length - 1].c;
    if (a.tipo === "ifr") { const r = rsiB(v.map(x => x.c)); if (a.dir > 0 ? r >= a.lim : r <= a.lim) disparou = `IFR ${NOME_TF[a.iv]} chegou em ${f2(r, 1)}`; }
    else if (a.tipo === "fecha") { const k = v[v.length - 2]; if (k && k.t + a.iv * 6e4 > a.criado && (a.dir > 0 ? k.c > a.lim : k.c < a.lim)) disparou = `vela ${NOME_TF[a.iv]} fechou em ${P(k.c)}, ${a.dir > 0 ? "acima" : "abaixo"} de ${P(a.lim)}`; }
    else { const e = estadoInd(a, v); if (e && e !== a.ant) disparou = a.tipo === "macd" ? `MACD ${NOME_TF[a.iv]} cruzou para ${e > 0 ? "cima" : "baixo"}` : `preço ${e > 0 ? "recuperou" : "perdeu"} a ${a.tipo === "mms200" ? "MMS200" : "MME21"} ${NOME_TF[a.iv]}`; }
    if (disparou) { await enviar(`🔔 ${a.m}: ${disparou} (preço ${P(p)}).`, atalhos(a.m)); feitos.push(a.m + " " + a.tipo); }
    else ficam.push(a);
  }
  if (feitos.length) { b.bu.ind = ficam; await salvarBotU(env, b.gid, b.bu); }
  return feitos;
}

// ---------- 4) funding e open interest extremos (a cada 5 min) ----------
function extremos(ctx, bot, agoraS){
  const msgs = []; bot.ext = bot.ext || {}; bot.oiR = bot.oiR || {};
  const pode = (k, h) => agoraS - (bot.ext[k] || 0) > h * 3600 ? (bot.ext[k] = agoraS, true) : false;
  for (const m of ["BTC", "ETH"]) {
    const x = ctx[m]; if (!x) continue;
    const f8 = +x.funding * 800, oi = +x.openInterest;
    if (f8 >= 0.05 && pode(m + "fAlto", 8)) msgs.push(`🔥 ${m}: funding alto, ${f2(f8, 4)}% por 8h. Comprados pagando caro: mercado alavancado na alta, risco de "long squeeze" (queda rápida).`);
    if (f8 <= -0.03 && pode(m + "fBaixo", 8)) msgs.push(`🧊 ${m}: funding negativo forte, ${f2(f8, 4)}% por 8h. Vendidos pagando: combustível para "short squeeze" (repique rápido).`);
    const h = (bot.oiR[m] || []).filter(([t]) => agoraS - t < 66 * 60); h.push([agoraS, oi]); bot.oiR[m] = h;
    const velho = h.find(([t]) => agoraS - t >= 50 * 60);
    if (velho) { const d = (oi / velho[1] - 1) * 100, lim = m === "BTC" ? 5 : 7;
      if (d >= lim && pode(m + "oiSobe", 3)) msgs.push(`📈 ${m}: open interest subiu ${pcB(d)} em 1h (Hyperliquid). Alavancagem entrando forte: tende a aumentar a volatilidade e o risco de liquidações.`);
      if (d <= -lim && pode(m + "oiCai", 3)) msgs.push(`📉 ${m}: open interest caiu ${pcB(d)} em 1h (Hyperliquid). Desalavancagem: posições fechadas ou liquidadas.`); }
  }
  return msgs;
}

// ---------- 5) gráfico em imagem (QuickChart) ----------
async function enviarGrafico(m, args, dados){
  const iv = lerTF((args || "").split(/\s+/)[0], 240), v = await kraken(m, iv), n = 90, u = v.slice(-n);
  const c = v.map(x => x.c), e21 = emaB(c, 21).slice(-n), s200 = smaSerie(c, 200).slice(-n);
  const lab = u.map(x => { const q = partesBRT(x.t / 1000); return iv >= 1440 ? q.day + "/" + q.month : q.day + " " + q.hour + "h"; });
  const cor = u.map(x => x.c >= x.o ? "#26a69a" : "#ef5350");
  const mx = Math.max(...u.map(x => x.h)), mn = Math.min(...u.map(x => x.l)), fx = (mx - mn) * 0.002;
  const linhas = linhasDe(dados, m).filter(d => (d.tipo === "horizontal" || d.tipo === "raioH") && d.pts && d.pts[0]);
  const vis = linhas.filter(d => d.pts[0].p >= mn * 0.9 && d.pts[0].p <= mx * 1.1), fora = linhas.length - vis.length;
  const ds = [
    {type: "bar", data: u.map(x => [x.l, x.h]), backgroundColor: cor, barPercentage: 0.15, categoryPercentage: 1},
    {type: "bar", data: u.map(x => [Math.min(x.o, x.c), Math.max(x.o, x.c) + (x.o === x.c ? fx : 0)]), backgroundColor: cor, barPercentage: 0.75, categoryPercentage: 1},
    {type: "line", label: "MME21", data: e21, borderColor: "#ff9800", borderWidth: 1.5, pointRadius: 0, fill: false},
  ];
  if (s200.some(x => x != null)) ds.push({type: "line", label: "MMS200", data: s200, borderColor: "#2962ff", borderWidth: 1.5, pointRadius: 0, fill: false, borderDash: [6, 3]});
  vis.slice(0, 8).forEach(d => ds.push({type: "line", label: (d.alerta ? "alerta " : "linha ") + pr(d.pts[0].p) + (d.nota ? " " + d.nota : ""), data: u.map(() => d.pts[0].p),
    borderColor: d.alerta ? "#ffd600" : "#9e9e9e", borderWidth: 1, pointRadius: 0, fill: false, borderDash: [4, 4]}));
  const cfg = {type: "bar", data: {labels: lab, datasets: ds}, options: {
    legend: {labels: {fontColor: "#d1d4dc", boxWidth: 12, filter: "__FILTRO__"}},
    title: {display: true, text: `${m}/USD ${NOME_TF[iv]} — ${pr(c[c.length - 1])} (Kraken) · LiqMap`, fontColor: "#ffffff", fontSize: 15},
    scales: {xAxes: [{stacked: true, ticks: {fontColor: "#9598a1", maxTicksLimit: 8, maxRotation: 0}, gridLines: {color: "rgba(255,255,255,0.06)"}}],
      yAxes: [{position: "right", stacked: false, ticks: {fontColor: "#9598a1"}, gridLines: {color: "rgba(255,255,255,0.06)"}}]}}};
  const r = await fetch("https://quickchart.io/chart", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({version: "2.9.4", width: 900, height: 520, devicePixelRatio: 2, format: "png", backgroundColor: "#131722",
      chart: JSON.stringify(cfg).replace('"__FILTRO__"', "function(it){return it.text!=null&&it.text!=='undefined'&&it.text!==''}")})});
  if (!r.ok) throw new Error("gerador de gráfico HTTP " + r.status);
  const fd = new FormData();
  fd.append("chat_id", String(TG.chat));
  fd.append("caption", `${m} ${NOME_TF[iv]}: laranja = MME21, azul tracejada = MMS200, amarelas = suas linhas com alerta${fora ? ` (${fora} linha(s) fora da tela)` : ""}.\nOutros tempos: /grafico${m} 1h · 4h · diário · semanal`);
  fd.append("reply_markup", JSON.stringify(atalhos(m).reply_markup));
  fd.append("photo", new Blob([await r.arrayBuffer()], {type: "image/png"}), "grafico.png");
  const t = await (await fetch("https://api.telegram.org/bot" + TG.token + "/sendPhoto", {method: "POST", body: fd})).json();
  if (!t.ok) throw new Error("Telegram: " + t.description);
}

// ---------- 7) fechamento semanal (domingo à noite) ----------
async function textoSemana(bot, bu, agoraS){
  const flx = pega(fetch(URL_FLUXOS).then(r => r.json())), fng = pega(fetch("https://api.alternative.me/fng/?limit=8").then(r => r.json())), ctx = pega(hlCtx());
  const L = [`🗓 Fechamento da semana — ${dataBRT(agoraS * 1000, false)}`];
  bot.fundo = bot.fundo || {};
  for (const m of ["BTC", "ETH"]) {
    const d1 = await pega(kraken(m, 1440)), w1 = await pega(kraken(m, 10080));
    if (!d1) continue;
    const seg = Date.UTC(...(() => { const d = new Date(agoraS * 1000 + 3600e3); const dia = (d.getUTCDay() + 6) % 7; return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dia]; })());
    const sem = d1.filter(k => k.t >= seg - 7 * 864e5 && k.t < seg);
    const ab = sem.length ? sem[0].o : d1[d1.length - 8].c, fe = d1[d1.length - 1].c;
    const f = await calcFundo(m, {["d" + m]: Promise.resolve(d1), ["w" + m]: Promise.resolve(w1), flx, fng, ctx});
    if (f) aplicarOI(f, m, bot);
    const ant = (bot.fundoSem || {})[m];
    L.push("", `${m}: ${P(fe)} · semana ${pcB((fe / ab - 1) * 100)}` + (sem.length ? ` · máx ${P(Math.max(...sem.map(k => k.h)))} / mín ${P(Math.min(...sem.map(k => k.l)))}` : ""));
    if (w1 && w1.length >= 200) { const ms = smaB(w1.map(k => k.c), 200); L.push(`Média de 200 semanas: ${P(ms)} (preço ${pcB((fe / ms - 1) * 100)}) · IFR semanal ${f2(rsiB(w1.map(k => k.c)), 1)}`); }
    if (f) { L.push(`🎯 Fundo ${f.n}/10${ant != null ? ` (semana passada ${ant}/10)` : ""} — ${faixaFundo(f.n)}`); bot.fundoSem = bot.fundoSem || {}; bot.fundoSem[m] = f.n; }
  }
  const fl = await flx;
  if (fl) {
    const lim = new Date((agoraS - 7 * 86400) * 1000).toISOString().slice(0, 10);
    for (const [k, nome] of [["etfBtc", "BTC"], ["etfEth", "ETH"]]) { const e = (fl[k] && fl[k].dias || []).filter(d => d.total != null && d.data > lim); if (e.length) L.push(`ETFs ${nome} na semana: ${usB(e.reduce((a, d) => a + d.total, 0) * 1e6, true)} (${e.length} pregões)`); }
    const sr = fl.stables ? fl.stables.serie : []; if (sr.length >= 8) L.push(`Stablecoins: ${pcB((sr[sr.length - 1][1] / sr[sr.length - 8][1] - 1) * 100, 2)} na semana`);
    const cx = fl.cex || []; if (cx.length) { const s7 = cx.reduce((a, c) => a + (c.d7_mo ?? c.d7 ?? 0), 0); L.push(`Corretoras (moedas): ${usB(s7, true)} ${s7 < 0 ? "saindo — acumulação" : "entrando — possível venda"}`); }
  }
  const fg = await fng; if (fg && fg.data && fg.data[7]) L.push(`Medo e Ganância: ${fg.data[0].value} (há 7 dias: ${fg.data[7].value})`);
  try { const evs = ((await (await fetch(URL_EVENTOS)).json()).eventos || []).filter(e => e.t > agoraS * 1000 && e.t < agoraS * 1000 + 7 * 864e5 && e.impacto === "High");
    L.push("", "📅 Semana que vem (EUA, alto impacto):", ...(evs.length ? evs.slice(0, 10).map(e => "• " + dataBRT(e.t) + " " + e.titulo) : ["• nada marcado ainda"])); } catch (e) {}
  const r = resumoOps(bu, 7); if (r) L.push("", r);
  return L.join("\n");
}

// ---------- 8) carteiras rastreadas sob demanda ----------
async function textoCarteiras(dados){
  let cs = []; try { cs = JSON.parse(dados["liqmap-carteiras"] || "[]").filter(c => !c.del && /^0x[0-9a-f]{40}$/.test(c.addr)); } catch (e) {}
  if (!cs.length) return "Nenhuma carteira rastreada. Adicione na página Carteiras do site.";
  const L = ["🐋 Carteiras rastreadas — posições agora (Hyperliquid)"];
  for (const c of cs.slice(0, 10)) {
    const quem = c.nome || (c.addr.slice(0, 6) + "…" + c.addr.slice(-4));
    let st; try { st = await hl({type: "clearinghouseState", user: c.addr}); } catch (e) { L.push("", quem + ": não consegui ler agora"); continue; }
    const ps = (st.assetPositions || []).map(p => p.position).filter(x => +x.szi).sort((a, b) => Math.abs(+b.positionValue) - Math.abs(+a.positionValue));
    L.push("", `${quem} — conta ${usB(+(st.marginSummary || {}).accountValue)}`);
    if (!ps.length) L.push("  sem posições abertas");
    ps.slice(0, 6).forEach(x => L.push(`  ${+x.szi > 0 ? "🟢 LONG" : "🔴 SHORT"} ${x.coin} ${usB(Math.abs(+x.positionValue))} · entrada ${P(+x.entryPx)} · resultado ${usB(+x.unrealizedPnl, true)}${x.liquidationPx ? " · liquida em " + P(+x.liquidationPx) : ""}${x.leverage ? " · " + x.leverage.value + "x" : ""}`));
    if (ps.length > 6) L.push(`  … e mais ${ps.length - 6}`);
  }
  if (cs.length > 10) L.push("", `(mostrando 10 de ${cs.length})`);
  return L.join("\n");
}

// ---------- 9 e 10) diário de operações, com stop e alvo no gráfico ----------
const numTxt = t => { const x = parseFloat(String(t).replace(",", ".")); return isFinite(x) ? x : null; };
async function operar(env, b, m, lado, args){
  const ex = lado > 0 ? "/compreiETH 1700 0.5 stop 1600 alvo 1900" : "/vendiETH 1850 (fecha tudo) ou /vendiETH 1850 0.2 (parcial)";
  const t = args.split(/\s+/).filter(Boolean);
  const v1 = await kraken(m, 60), ref = v1[v1.length - 1].c;
  if (!t.length) return "Exemplo: " + ex.replace(/ETH/g, m);
  const p = /^(agora|mercado|a)$/i.test(t[0]) ? ref : lerPrecoTxt(t[0], ref);
  if (!p || Math.abs(p / ref - 1) > 0.6) return `Preço inválido. Exemplo: ${ex.replace(/ETH/g, m)}`;
  let q = null, stop = null, alvo = null;
  for (let i = 1; i < t.length; i++) { const w = t[i].toLowerCase();
    if (w === "stop" || w === "sl") stop = lerPrecoTxt(t[++i] || "", ref); else if (w === "alvo" || w === "tp") alvo = lerPrecoTxt(t[++i] || "", ref); else if (q == null) q = numTxt(w); }
  const ops = b.bu.ops = b.bu.ops || {pos: {}, hist: []}, pos = ops.pos[m] || {q: 0, pm: 0, ids: []}, agora = Date.now(), L = [];
  if (q == null) { if (pos.q && Math.sign(pos.q) !== lado) q = Math.abs(pos.q); else return `Informe a quantidade de ${m}. Exemplo: ${ex.replace(/ETH/g, m)}`; }
  if (!(q > 0)) return "Quantidade inválida.";
  let resto = q;
  if (pos.q && Math.sign(pos.q) !== lado) {   // fecha (total ou parcial) a posição contrária
    const fecha = Math.min(resto, Math.abs(pos.q)), dir = Math.sign(pos.q), pnl = (p - pos.pm) * fecha * dir;
    ops.hist.push({m, lado: dir > 0 ? "long" : "short", q: fecha, pe: pos.pm, ps: p, pnl, pct: (p / pos.pm - 1) * 100 * dir, te: pos.t, ts: agora});
    ops.hist = ops.hist.slice(-300);
    pos.q -= fecha * dir; resto -= fecha;
    L.push(`${pnl >= 0 ? "✅" : "🔻"} Fechou ${f2(fecha, 4)} ${m} ${dir > 0 ? "long" : "short"}: entrada ${P(pos.pm)} → saída ${P(p)} = ${usB(pnl, true)} (${pcB((p / pos.pm - 1) * 100 * dir, 2)})`);
    if (Math.abs(pos.q) < 1e-12) {
      pos.q = 0;
      if (pos.ids && pos.ids.length) { const ids = pos.ids; await mexerDesenhos(env, MOEDAS_BOT[m].s, ds => { for (let i = ds.length - 1; i >= 0; i--) if (ids.includes(ds[i].id)) { MARCAR_APAGADOS.push(ds[i].id); ds.splice(i, 1); } }); L.push("Linhas de stop/alvo dessa operação foram removidas do gráfico."); }
      pos.ids = []; pos.stop = pos.alvo = null; pos.t = null;
    } else L.push(`Ainda aberto: ${f2(Math.abs(pos.q), 4)} ${m} a ${P(pos.pm)}`);
  }
  if (resto > 1e-12) {   // abre ou aumenta na direção da ordem
    const novo = Math.abs(pos.q) + resto; pos.pm = (pos.pm * Math.abs(pos.q) + p * resto) / novo; pos.q = novo * lado; pos.t = pos.t && Math.abs(pos.q) > resto ? pos.t : agora;
    L.push(`📝 ${lado > 0 ? "🟢 Long" : "🔴 Short"} ${m}: ${f2(resto, 4)} a ${P(p)} · posição ${f2(novo, 4)} ${m} com preço médio ${P(pos.pm)} (${usB(novo * pos.pm)})`);
  }
  if (pos.q && (stop || alvo)) {
    const novos = [];
    await mexerDesenhos(env, MOEDAS_BOT[m].s, ds => {
      if (pos.ids && pos.ids.length) for (let i = ds.length - 1; i >= 0; i--) if (pos.ids.includes(ds[i].id)) { MARCAR_APAGADOS.push(ds[i].id); ds.splice(i, 1); }   // troca stop/alvo antigos
      for (const [val, nome] of [[stop, "stop"], [alvo, "alvo"]]) if (val) { const id = "o" + nome[0] + agora.toString(36); novos.push(id);
        ds.push({id, tipo: "horizontal", pts: [{t: Math.floor(agora / 1000), p: val}], alerta: true, alertaDesde: agora, mod: agora, nota: nome + " " + (pos.q > 0 ? "long" : "short")}); }
    });
    pos.ids = novos; pos.stop = stop || null; pos.alvo = alvo || null;
    const risco = stop ? Math.abs(pos.pm - stop) * Math.abs(pos.q) : null, ganho = alvo ? Math.abs(alvo - pos.pm) * Math.abs(pos.q) : null;
    L.push(`Linhas com alerta criadas no gráfico:${stop ? " stop " + P(stop) + " (risco " + usB(-risco) + ")" : ""}${alvo ? " · alvo " + P(alvo) + " (ganho " + usB(ganho, true) + ")" : ""}${risco && ganho ? " · risco/retorno 1:" + f2(ganho / risco, 1) : ""}`);
  }
  ops.pos[m] = pos;
  await salvarBotU(env, b.gid, b.bu);
  return L.join("\n");
}
function resumoOps(bu, dias, ate = Date.now()){
  const h = ((bu.ops || {}).hist || []).filter(x => x.ts > ate - dias * 864e5 && x.ts <= ate); if (!h.length) return "";
  const tot = h.reduce((a, x) => a + x.pnl, 0), g = h.filter(x => x.pnl > 0).length;
  return `💼 Suas operações (${dias} dias): ${h.length} fechada(s), ${g} com ganho · resultado ${usB(tot, true)}`;
}
async function textoOps(bu){
  const ops = bu.ops || {pos: {}, hist: []}, abertas = Object.entries(ops.pos || {}).filter(([, p]) => p.q);
  const L = ["💼 Suas operações"];
  if (!abertas.length) L.push("", "Nenhuma posição aberta. Registre com /compreiETH 1700 0.5 stop 1600 alvo 1900");
  let totA = 0;
  for (const [m, p] of abertas) {
    const v = await pega(kraken(m, 60)), at = v ? v[v.length - 1].c : null, dir = Math.sign(p.q);
    const pnl = at ? (at - p.pm) * Math.abs(p.q) * dir : null; totA += pnl || 0;
    L.push("", `${dir > 0 ? "🟢 LONG" : "🔴 SHORT"} ${f2(Math.abs(p.q), 4)} ${m} · médio ${P(p.pm)} · agora ${P(at)}`,
      `   resultado ${usB(pnl, true)} (${pcB(at ? (at / p.pm - 1) * 100 * dir : null, 2)})${p.stop ? " · stop " + P(p.stop) + " (" + pcB((p.stop / at - 1) * 100) + ")" : ""}${p.alvo ? " · alvo " + P(p.alvo) + " (" + pcB((p.alvo / at - 1) * 100) + ")" : ""}`);
  }
  if (abertas.length > 1) L.push("", "Total em aberto: " + usB(totA, true));
  const ini = (() => { const q = partesBRT(Date.now() / 1000); return Date.UTC(+q.year, +q.month - 1, 1, 3); })();
  const mes = (ops.hist || []).filter(x => x.ts >= ini);
  L.push("", `📅 Fechadas neste mês: ${mes.length}` + (mes.length ? ` · resultado ${usB(mes.reduce((a, x) => a + x.pnl, 0), true)} · acerto ${Math.round(mes.filter(x => x.pnl > 0).length / mes.length * 100)}%` : ""));
  mes.slice(-8).reverse().forEach(x => L.push(`  ${x.pnl >= 0 ? "✅" : "🔻"} ${dataBRT(x.ts, false)} ${x.m} ${x.lado} ${P(x.pe)} → ${P(x.ps)}: ${usB(x.pnl, true)} (${pcB(x.pct, 2)})`));
  L.push("", "Para apagar o diário: /zerardiario");
  return L.join("\n");
}
function textoMes(bu, agoraS){
  const q = partesBRT(agoraS), fim = Date.UTC(+q.year, +q.month - 1, 1, 3), ini = Date.UTC(+q.year, +q.month - 2, 1, 3);
  const h = ((bu.ops || {}).hist || []).filter(x => x.ts >= ini && x.ts < fim); if (!h.length) return "";
  const tot = h.reduce((a, x) => a + x.pnl, 0), g = h.filter(x => x.pnl > 0), p = h.filter(x => x.pnl <= 0);
  const mg = g.length ? g.reduce((a, x) => a + x.pnl, 0) / g.length : 0, mp = p.length ? p.reduce((a, x) => a + x.pnl, 0) / p.length : 0;
  return `💼 Mês passado: ${h.length} operações · resultado ${usB(tot, true)} · acerto ${Math.round(g.length / h.length * 100)}% · ganho médio ${g.length ? usB(mg, true) : "—"} · perda média ${p.length ? usB(mp, true) : "—"}`;
}

// ---------- 11) análise por IA (Claude) ----------
async function analiseIA(env, m, dados, bot){
  if (!env.ANTHROPIC_API_KEY) return "🧠 A análise por IA ainda não está ligada. Ela precisa de uma chave da API da Anthropic (paga por uso, centavos de dólar por análise):\n1) Crie a chave em console.anthropic.com → API Keys (sem mostrar a ninguém).\n2) No Cloudflare: liqmap-vigia → Settings → Variables and Secrets → Add → tipo Secret, nome ANTHROPIC_API_KEY, cole a chave → Deploy.\nDepois é só mandar /analise" + m + " de novo.";
  await enviar(`🧠 Analisando ${m}… (uns 20 a 40 segundos)`);
  const rel = await textoRelatorio(m, dados, bot);
  const r = await fetch("https://api.anthropic.com/v1/messages", {method: "POST",
    headers: {"x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    body: JSON.stringify({model: env.IA_MODELO || "claude-sonnet-5-5", max_tokens: 1600,
      system: "Você é um analista de mercado de criptomoedas, objetivo e quantitativo. Escreva em português do Brasil, em texto puro para o Telegram (sem markdown, sem asteriscos, sem tabelas), no máximo 2.800 caracteres. Estrutura: 1) Leitura geral em 2 ou 3 linhas. 2) Cenários pessimista, base e otimista, cada um com probabilidade em % (somando 100), gatilho que confirma e alvos de preço. 3) Níveis-chave de suporte e resistência. 4) O que observar nas próximas 24 a 72 horas. Use só os dados do relatório; se faltar algo, diga. Termine com: Não é recomendação de investimento.",
      messages: [{role: "user", content: "Relatório do meu painel LiqMap:\n\n" + rel}]})});
  const j = await r.json();
  if (!r.ok) return "🧠 Erro na IA: " + ((j.error && j.error.message) || "HTTP " + r.status);
  return `🧠 Análise IA — ${m}\n\n` + (j.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
}
