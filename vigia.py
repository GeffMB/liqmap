"""Vigia 24h do LiqMap.

Roda no GitHub Actions a cada ~5 minutos. Lê os desenhos com alerta ligado no Gist de
sincronização do usuário, confere os candles de 1 minuto desde a última verificação e,
se o preço tocou o nível, manda a notificação para o celular (ntfy) e desliga o alerta.

Precisa do segredo GIST_TOKEN (token do GitHub só com a permissão "gist").
Preço: candles do mercado à vista da Binance (data-api.binance.vision), que respondem de
qualquer país; a diferença para o futuro (basis) costuma ser de poucos centésimos de %.
"""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ARQ_SYNC = "liqmap-sync.json"
ARQ_VIGIA = "liqmap-vigia.json"
ARQ_CART = "liqmap-carteiras-vigia.json"   # última posição vista de cada carteira rastreada
MUDA_PCT, MUDA_USD = 0.10, 25000
TOKEN = os.environ.get("GIST_TOKEN", "").strip()


def req(url, metodo="GET", corpo=None, cab=None):
    cab = dict(cab or {})
    dados = None
    if corpo is not None:
        dados = corpo if isinstance(corpo, bytes) else json.dumps(corpo).encode()
        cab.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=dados, method=metodo, headers=cab)
    with urllib.request.urlopen(r, timeout=30) as resp:
        txt = resp.read().decode()
    return json.loads(txt) if txt.strip().startswith(("{", "[")) else txt


def gh(caminho, metodo="GET", corpo=None):
    return req("https://api.github.com" + caminho, metodo, corpo,
               {"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "liqmap-vigia"})


def achar_gist():
    for pg in range(1, 6):
        lista = gh(f"/gists?per_page=100&page={pg}")
        for g in lista:
            if ARQ_SYNC in (g.get("files") or {}):
                return g["id"]
        if len(lista) < 100:
            break
    return None


def conteudo(g, nome):
    f = (g.get("files") or {}).get(nome)
    if not f:
        return None
    txt = req(f["raw_url"]) if f.get("truncated") else f.get("content")
    if isinstance(txt, (dict, list)):
        return txt
    try:
        return json.loads(txt)
    except Exception:
        return None


def pr(p):
    casas = 1 if p >= 1000 else 2 if p >= 10 else 4
    return f"{p:,.{casas}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def niveis(d, t):
    """Lista de (preço, descrição) do desenho no instante t (segundos)."""
    pts, tipo = d.get("pts") or [], d.get("tipo")
    if not pts:
        return []
    if tipo in ("horizontal", "raioH"):
        return [(pts[0]["p"], "a linha em " + pr(pts[0]["p"]))]
    if tipo in ("zonaLiq", "retangulo") and len(pts) >= 2:
        lo, hi = sorted([pts[0]["p"], pts[1]["p"]])
        return [(lo, f"o fundo da zona ({pr(lo)})"), (hi, f"o topo da zona ({pr(hi)})")]
    if tipo == "posicao" and len(pts) >= 3:
        return [(pts[1]["p"], f"o STOP ({pr(pts[1]['p'])})"), (pts[2]["p"], f"o ALVO ({pr(pts[2]['p'])})")]
    if tipo in ("linha", "raio") and len(pts) >= 2:
        t0, t1 = pts[0]["t"], pts[1]["t"]
        if t1 == t0:
            return []
        if tipo == "linha" and not (min(t0, t1) <= t <= max(t0, t1)):
            return []
        if tipo == "raio" and (t - t0) * (t1 - t0) < 0:
            return []
        p = pts[0]["p"] + (pts[1]["p"] - pts[0]["p"]) * (t - t0) / (t1 - t0)
        return [(p, ("a linha do raio" if tipo == "raio" else "a linha de tendência") + f" ({pr(p)})")]
    return []


def chave(simb, d):
    base = json.dumps([simb, d.get("tipo"), d.get("pts"), d.get("alertaDesde")], sort_keys=True)
    return hashlib.sha1(base.encode()).hexdigest()[:16]


def candles(simb, desde_ms):
    q = urllib.parse.urlencode({"symbol": simb, "interval": "1m", "startTime": int(desde_ms), "limit": 1000})
    return [{"t": k[0] / 1000, "h": float(k[2]), "l": float(k[3]), "o": float(k[1]), "c": float(k[4])}
            for k in req("https://data-api.binance.vision/api/v3/klines?" + q)]


def ntfy(topico, titulo, txt):
    q = urllib.parse.urlencode({"title": titulo, "priority": "high", "tags": "bell,chart_with_upwards_trend",
                                "click": "https://geffmb.github.io/liqmap/"})
    req(f"https://ntfy.sh/{urllib.parse.quote(topico)}?{q}", "POST", txt.encode())


def hl(corpo):
    return req("https://api.hyperliquid.xyz/info", "POST", corpo)


def usd(x):
    a = abs(x)
    return "$" + (f"{a/1e9:.2f}B" if a >= 1e9 else f"{a/1e6:.2f}M" if a >= 1e6 else f"{a/1e3:.1f}K" if a >= 1e3 else f"{a:.0f}")


def mudanca(a, b, px, coin):
    L = lambda x: "LONG" if x > 0 else "SHORT"
    if not a and b:
        return f"abriu {L(b)} {coin} de {usd(abs(b) * px)}"
    if a and not b:
        return f"fechou o {L(a)} {coin} ({usd(abs(a) * px)})"
    if a and b and (a > 0) != (b > 0):
        return f"virou de {L(a)} para {L(b)} {coin} ({usd(abs(b) * px)})"
    if a and b:
        d = abs(b) - abs(a)
        if abs(d) / abs(a) >= MUDA_PCT and abs(d) * px >= MUDA_USD:
            return f"{'aumentou' if d > 0 else 'reduziu'} o {L(b)} {coin} em {usd(abs(d) * px)} (agora {usd(abs(b) * px)})"
    return None


def carteiras(g, dados, topico, agora):
    """Confere as carteiras rastreadas (página Carteiras). Devolve o conteúdo novo do arquivo ou None."""
    try:
        lista = [c for c in json.loads(dados.get("liqmap-carteiras") or "[]") if not c.get("del") and c.get("notif")][:20]
    except Exception:
        lista = []
    ant = conteudo(g, ARQ_CART) or {}
    if not lista:
        return None
    # o vigia do Cloudflare (a cada minuto) cuida disso; este aqui é só reserva
    if ant.get("fonte") == "cloudflare" and agora - (ant.get("ultimo") or 0) < 15 * 60:
        print("Carteiras: o vigia do Cloudflare está ativo, nada a fazer aqui.")
        return None
    snaps, novos = ant.get("snaps") or {}, {}
    try:
        mids = hl({"type": "allMids"})
    except Exception:
        mids = {}
    for c in lista:
        try:
            st = hl({"type": "clearinghouseState", "user": c["addr"]})
        except Exception as e:
            print("Falha ao ler carteira", c["addr"][:8], e)
            if c["addr"] in snaps:
                novos[c["addr"]] = snaps[c["addr"]]
            continue
        atual, pxs = {}, {}
        for p in st.get("assetPositions") or []:
            x = p["position"]
            szi = float(x["szi"])
            if szi:
                atual[x["coin"]] = szi
                pxs[x["coin"]] = abs(float(x["positionValue"]) / szi)
        novos[c["addr"]] = atual
        a0 = snaps.get(c["addr"])
        if a0 is None:
            continue
        quem = c.get("nome") or (c["addr"][:6] + "…" + c["addr"][-4:])
        for coin in set(a0) | set(atual):
            t = mudanca(a0.get(coin, 0), atual.get(coin, 0), pxs.get(coin) or float(mids.get(coin) or 0), coin)
            if t:
                msg = f"🐋 {quem} {t}"
                print("CARTEIRA:", msg)
                if topico:
                    try:
                        ntfy(topico, "LiqMap — carteira rastreada", msg)
                    except Exception as e:
                        print("Falha no ntfy:", e)
    print(f"Carteiras conferidas: {len(novos)}")
    return json.dumps({"ultimo": agora, "fonte": "github", "snaps": novos}, separators=(",", ":"))


def main():
    if not TOKEN:
        print("Sem GIST_TOKEN: configure o segredo no repositório para ligar o vigia 24h.")
        return
    gid = achar_gist()
    if not gid:
        print("Nenhum Gist do LiqMap encontrado (ligue a sincronização no site primeiro).")
        return
    g = gh("/gists/" + gid)
    pac = conteudo(g, ARQ_SYNC) or {}
    estado = conteudo(g, ARQ_VIGIA) or {}
    dados = pac.get("dados") or {}
    try:
        cfg = json.loads(dados.get("liqmap2") or "{}")
    except Exception:
        cfg = {}
    topico = cfg.get("ntfy") or ""
    agora = time.time()
    ultimo = estado.get("ultimo") or (agora - 600)
    ultimo = max(ultimo, agora - 6 * 3600)          # depois de um intervalo grande, olha no máximo 6 h para trás
    disparados = {k: v for k, v in (estado.get("disparados") or {}).items() if agora - v < 30 * 86400}

    mudou_sync, avisos, ativos = False, [], 0
    for k, v in list(dados.items()):
        if not k.startswith("liqmap-des-"):
            continue
        simb = k[len("liqmap-des-"):]
        try:
            desenhos = json.loads(v)
        except Exception:
            continue
        com_alerta = [d for d in desenhos if d.get("alerta")]
        if not com_alerta:
            continue
        ativos += len(com_alerta)
        try:
            ks = candles(simb, (ultimo - 60) * 1000)
        except Exception as e:
            print("Falha ao ler candles de", simb, e)
            continue
        for d in com_alerta:
            ch = chave(simb, d)
            if ch in disparados:
                d["alerta"] = False
                mudou_sync = True
                continue
            achou = None
            for c in ks:
                for nv, desc in niveis(d, c["t"] + 30):
                    if c["l"] <= nv <= c["h"]:
                        achou = (c, nv, desc)
                        break
                if achou:
                    break
            if achou:
                c, nv, desc = achou
                subiu = c["c"] >= c["o"]
                hora = time.strftime("%H:%M", time.gmtime(c["t"] - 3 * 3600))
                avisos.append(f"{simb} {'subiu' if subiu else 'caiu'} e tocou {desc} às {hora} (Brasília)" + (f" — {d['nota']}" if d.get("nota") else ""))
                d["alerta"] = False
                d["disparadoVigia"] = int(agora * 1000)
                disparados[ch] = agora
                mudou_sync = True
        dados[k] = json.dumps(desenhos, separators=(",", ":"))

    for a in avisos:
        print("ALERTA:", a)
        if topico:
            try:
                ntfy(topico, "LiqMap — alerta 24h", a)
            except Exception as e:
                print("Falha no ntfy:", e)

    arquivos = {ARQ_VIGIA: {"content": json.dumps({"ultimo": agora, "disparados": disparados, "ativos": ativos,
                                                    "versao": 1}, separators=(",", ":"))}}
    novo_cart = carteiras(g, dados, topico, agora)
    if novo_cart:
        arquivos[ARQ_CART] = {"content": novo_cart}
    if mudou_sync:
        pac["dados"] = dados
        pac["atualizado"] = int(agora * 1000)
        arquivos[ARQ_SYNC] = {"content": json.dumps(pac, separators=(",", ":"))}
    gh("/gists/" + gid, "PATCH", {"files": arquivos})
    print(f"Verificado: {ativos} alerta(s) ativo(s), {len(avisos)} disparado(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Erro:", e)
        sys.exit(1)
