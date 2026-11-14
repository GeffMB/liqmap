"""Diagnóstico da sincronização do LiqMap (só leitura).

Mostra o que está guardado na nuvem SEM expor conteúdo: tamanho do arquivo, quais chaves existem,
quantos desenhos/alertas/notas há por moeda e quando cada chave foi editada. Os logs do Actions são
públicos neste repositório, por isso não imprime preços, notas nem o tópico do celular.
"""
import json
import time
from vigia import gh, achar_gist, conteudo, ARQ_SYNC, TOKEN


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


if __name__ == "__main__":
    main()
