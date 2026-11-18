"""Diagnóstico da sincronização do LiqMap (só leitura).

Mostra o que está guardado na nuvem SEM expor conteúdo: tamanho do arquivo, quais chaves existem,
quantos desenhos/alertas/notas há por moeda e quando cada chave foi editada. Os logs do Actions são
públicos neste repositório, por isso não imprime preços, notas nem o tópico do celular.
"""
import json
import time
from vigia import gh, achar_gist, conteudo, ARQ_SYNC, TOKEN


def alertas_perto(simb, v):
    """Para cada alerta ligado: distância (%) do preço atual e se o preço passou pelo nível nas últimas 24h (sem mostrar o preço)."""
    import urllib.request
    try:
        ks = json.loads(urllib.request.urlopen(f"https://data-api.binance.vision/api/v3/klines?symbol={simb}&interval=1h&limit=24", timeout=20).read())
        lo, hi, agora = min(float(x[3]) for x in ks), max(float(x[2]) for x in ks), float(ks[-1][4])
    except Exception as e:
        print("   (sem preço:", e, ")")
        return
    for d in json.loads(v):
        if not d.get("alerta") or not d.get("pts"):
            continue
        if d.get("tipo") in ("horizontal", "raioH"):
            p = d["pts"][0]["p"]
            print(f"   alerta {d.get('tipo')}: {(p / agora - 1) * 100:+.1f}% do preço atual | tocado nas últimas 24h: {'SIM' if lo <= p <= hi else 'não'}")
            if lo <= p <= hi:
                horas = [time.strftime("%d/%m %H:00", time.gmtime(int(x[0]) / 1000)) for x in ks if float(x[3]) <= p <= float(x[2])]
                print("      tocado nas horas (UTC):", ", ".join(horas), "| alerta ligado desde (UTC):", time.strftime("%d/%m %H:%M", time.gmtime(d["alertaDesde"] / 1000)) if d.get("alertaDesde") else "?")
        else:
            print(f"   alerta {d.get('tipo')}: (linha inclinada/zona, não calculado)")


def main():
    if not TOKEN:
        print("Sem GIST_TOKEN.")
        return
    gid = achar_gist()
    if not gid:
        print("Nenhum Gist do LiqMap encontrado.")
        return
    g = gh("/gists/" + gid)
    f = (g.get("files") or {}).get(ARQ_SYNC) or {}
    print("Gist atualizado em:", g.get("updated_at"), "| tamanho do arquivo:", f.get("size"), "bytes | truncado na API:", f.get("truncated"))
    vg = conteudo(g, "liqmap-vigia.json") or {}
    print("Vigia: fonte", vg.get("fonte"), "| versão", vg.get("versao"), "| alertas ativos", vg.get("ativos"), "| carteiras", vg.get("carteiras"),
          "| última verificação (UTC)", time.strftime("%Y-%m-%d %H:%M", time.gmtime(vg["ultimo"])) if vg.get("ultimo") else "-")
    disp = vg.get("disparados") or {}
    print("Vigia: alertas disparados nos últimos 30 dias:", len(disp), "| horários (UTC):", ", ".join(sorted(time.strftime("%d/%m %H:%M", time.gmtime(t)) for t in disp.values())[-8:]))
    try:
        cfg = json.loads((conteudo(g, ARQ_SYNC) or {}).get("dados", {}).get("liqmap2") or "{}")
        print("Canal do celular (ntfy) configurado:", bool(cfg.get("ntfy")))
    except Exception as e:
        print("ntfy: erro", e)
    cv = conteudo(g, "liqmap-carteiras-vigia.json") or {}
    print("Carteiras no vigia: fonte", cv.get("fonte"), "| carteiras com foto", len(cv.get("snaps") or {}),
          "| atualizado (UTC)", time.strftime("%Y-%m-%d %H:%M", time.gmtime(cv["ultimo"])) if cv.get("ultimo") else "-")
    pac = conteudo(g, ARQ_SYNC) or {}
    dados, mod = pac.get("dados") or {}, pac.get("mod") or {}
    at = pac.get("atualizado")
    print("Pacote atualizado em (UTC):", time.strftime("%Y-%m-%d %H:%M", time.gmtime(at / 1000)) if at else "?")
    for k in sorted(dados):
        v = dados[k] or ""
        m = mod.get(k)
        quando = time.strftime("%Y-%m-%d %H:%M", time.gmtime(m / 1000)) if m else "-"
        extra = ""
        if k.startswith("liqmap-des-"):
            try:
                ds = json.loads(v)
                tipos = {}
                for d in ds:
                    tipos[d.get("tipo", "?")] = tipos.get(d.get("tipo", "?"), 0) + 1
                ult = max([d.get("mod", 0) for d in ds] or [0])
                extra = (f" | desenhos {len(ds)} | com alerta {sum(1 for d in ds if d.get('alerta'))}"
                         f" | alerta já disparado {sum(1 for d in ds if d.get('disparadoVigia'))} | com nota {sum(1 for d in ds if d.get('nota'))}"
                         f" | último desenho editado (UTC) {time.strftime('%Y-%m-%d %H:%M', time.gmtime(ult / 1000)) if ult else '-'} | tipos {tipos}")
            except Exception as e:
                extra = " | erro ao ler: " + str(e)
        print(f"{k}: {len(v)} bytes | editado (UTC) {quando}{extra}")
        if k.startswith("liqmap-des-"):
            alertas_perto(k[len("liqmap-des-"):], v)


if __name__ == "__main__":
    main()
