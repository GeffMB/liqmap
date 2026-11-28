"""Histórico dos desenhos no Gist (só leitura): quantos desenhos cada moeda tinha em cada versão das últimas 36h
e quais desenhos sumiram (só o id e o tipo; sem preços nem notas, porque os logs são públicos)."""
import json
import time
from vigia import gh, achar_gist, conteudo, ARQ_SYNC

gid = achar_gist()
limite = time.time() - 36 * 3600
commits = []
for pg in range(1, 20):
    lote = gh(f"/gists/{gid}/commits?per_page=100&page={pg}")
    commits += lote
    if len(lote) < 100 or time.mktime(time.strptime(lote[-1]["committed_at"], "%Y-%m-%dT%H:%M:%SZ")) < limite:
        break
print("versões do Gist lidas:", len(commits))
vistos = {}      # id -> (simb, tipo, primeira vez, última vez)
linha_ant = None
for c in reversed(commits):
    t = time.mktime(time.strptime(c["committed_at"], "%Y-%m-%dT%H:%M:%SZ"))
    if t < limite:
        continue
    if (c.get("change_status") or {}).get("total", 1) == 0:
        continue
    try:
        g = gh(f"/gists/{gid}/{c['version']}")
    except Exception as e:
        print("erro na versão", c["committed_at"], e)
        continue
    pac = conteudo(g, ARQ_SYNC) or {}
    dados = pac.get("dados") or {}
    cont = {}
    for k, v in dados.items():
        if not k.startswith("liqmap-des-"):
            continue
        s = k[len("liqmap-des-"):].replace("USDT", "")
        try:
            ds = json.loads(v)
        except Exception:
            continue
        cont[s] = len(ds)
        for d in ds:
            i = d.get("id") or "?"
            a = vistos.get(i)
            vistos[i] = (s, d.get("tipo"), a[2] if a else c["committed_at"], c["committed_at"])
    linha = " ".join(f"{s}:{n}" for s, n in sorted(cont.items()))
    if linha != linha_ant:
        print(c["committed_at"], "(UTC) desenhos ->", linha)
        linha_ant = linha
ultimo = max((v[3] for v in vistos.values()), default="")
print("\nDesenhos que existiram nas últimas 36h e NÃO estão na versão atual:")
for i, (s, tipo, ini, fim) in sorted(vistos.items(), key=lambda x: x[1][3]):
    if fim != ultimo:
        print(f"  {s} {tipo} id={i} | apareceu {ini} | visto pela última vez {fim}")
