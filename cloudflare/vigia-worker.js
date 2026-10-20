// LiqMap — vigia de alertas 24h (Cloudflare Workers)
//
// Roda a cada minuto (Cron Trigger "* * * * *"). Lê os desenhos com alerta ligado no Gist de
// sincronização do LiqMap, confere os candles de 1 minuto mais recentes e, se o preço tocou o
// nível, avisa o celular pelo ntfy e desliga o alerta no Gist.
//
// Configuração no painel do Cloudflare (Settings → Variables and Secrets):
//   GIST_TOKEN  (Secret)  token do GitHub só com a permissão "gist" (o mesmo da sincronização)
//   GIST_ID     (Text, opcional) id do Gist; sem ele o vigia procura o Gist sozinho a cada execução
//
// Preço: candles do mercado à vista da Binance (data-api.binance.vision), que respondem de qualquer
// lugar; a diferença para o futuro (basis) costuma ser de poucos centésimos de %.

const ARQ_SYNC = "liqmap-sync.json";
const ARQ_VIGIA = "liqmap-vigia.json";
const JANELA_MIN = 5;   // olha os últimos 5 candles de 1 min (cobre execuções atrasadas)

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

async function candles(simb) {
  const r = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=" + simb + "&interval=1m&limit=" + JANELA_MIN);
  if (!r.ok) throw new Error("Binance " + r.status);
  return (await r.json()).map(k => ({t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4]}));
}

async function ntfy(topico, titulo, txt) {
  const q = new URLSearchParams({title: titulo, priority: "high", tags: "bell,chart_with_upwards_trend", click: "https://geffmb.github.io/liqmap/"});
  await fetch("https://ntfy.sh/" + encodeURIComponent(topico) + "?" + q, {method: "POST", body: txt});
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
  const agora = Date.now() / 1000;
  const disparados = {};
  for (const [k, v] of Object.entries(estado.disparados || {})) if (agora - v < 30 * 86400) disparados[k] = v;

  let mudouSync = false, ativos = 0;
  const avisos = [];
  for (const k of Object.keys(dados)) {
    if (!k.startsWith("liqmap-des-")) continue;
    const simb = k.slice("liqmap-des-".length);
    let desenhos;
    try { desenhos = JSON.parse(dados[k]); } catch (e) { continue; }
    const comAlerta = desenhos.filter(d => d.alerta);
    if (!comAlerta.length) continue;
    ativos += comAlerta.length;
    let ks;
    try { ks = await candles(simb); } catch (e) { console.log("Candles", simb, e.message); continue; }
    let mudou = false;
    for (const d of comAlerta) {
      const ch = await chave(simb, d);
      if (disparados[ch]) { d.alerta = false; mudou = true; continue; }
      let achou = null;
      for (const c of ks) {
        for (const [nv, desc] of niveis(d, c.t + 30)) if (c.l <= nv && nv <= c.h) { achou = [c, desc]; break; }
        if (achou) break;
      }
      if (achou) {
        const [c, desc] = achou;
        const hora = new Date(c.t * 1000).toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"});
        avisos.push(simb + " " + (c.c >= c.o ? "subiu" : "caiu") + " e tocou " + desc + " às " + hora);
        d.alerta = false; d.disparadoVigia = Date.now();
        disparados[ch] = agora; mudou = true;
      }
    }
    if (mudou) { dados[k] = JSON.stringify(desenhos); mudouSync = true; }
  }

  for (const a of avisos) {
    console.log("ALERTA:", a);
    if (cfg.ntfy) await ntfy(cfg.ntfy, "LiqMap — alerta 24h", a).catch(e => console.log("ntfy", e.message));
  }

  // status para o site: grava a cada 10 min (ou quando algo mudou) para não encher o histórico do Gist
  const arquivos = {};
  const minuto = Math.floor(agora / 60);
  if (mudouSync || forcarStatus || minuto % 10 === 0 || !estado.ultimo || agora - estado.ultimo > 900 || estado.ativos !== ativos)
    arquivos[ARQ_VIGIA] = {content: JSON.stringify({ultimo: agora, disparados, ativos, fonte: "cloudflare", versao: 2})};
  if (mudouSync) {
    pac.dados = dados; pac.atualizado = Date.now();
    arquivos[ARQ_SYNC] = {content: JSON.stringify(pac)};
  }
  if (Object.keys(arquivos).length) await gh(env, "/gists/" + gid, {method: "PATCH", body: {files: arquivos}});
  return {ok: true, gist: gid, ativos, disparados: avisos, quando: quando.toISOString()};
}
