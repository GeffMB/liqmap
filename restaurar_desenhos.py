"""Devolve desenhos que sumiram da nuvem, buscando-os no histórico do Gist (pelo id).
Uso: IDS="id1,id2" python3 restaurar_desenhos.py  — não imprime preços (os logs são públicos)."""
import json
import os
import time
from vigia import gh, achar_gist, conteudo, ARQ_SYNC

ids = [x.strip() for x in os.environ.get("IDS", "").split(",") if x.strip()]
gid = achar_gist()
achados = {}
for pg in range(1, 20):
    lote = gh(f"/gists/{gid}/commits?per_page=100&page={pg}")
    for c in lote:
        if len(achados) == len(ids):
            break
        if (c.get("change_status") or {}).get("total", 1) == 0:
            continue
        pac = conteudo(gh(f"/gists/{gid}/{c['version']}"), ARQ_SYNC) or {}
        for k, v in (pac.get("dados") or {}).items():
            if not k.startswith("liqmap-des-"):
                continue
            for d in json.loads(v):
                if d.get("id") in ids and d["id"] not in achados:
                    achados[d["id"]] = (k, d)
                    print("achado", d["id"], "em", c["committed_at"], k, d.get("tipo"), "alerta" if d.get("alerta") else "", "com nota" if d.get("nota") else "")
    if len(achados) == len(ids) or len(lote) < 100:
        break
g = gh("/gists/" + gid)
pac = conteudo(g, ARQ_SYNC) or {}
dados, mod, apag = pac.setdefault("dados", {}), pac.setdefault("mod", {}), pac.setdefault("apagados", {})
agora = int(time.time() * 1000)
for i, (k, d) in achados.items():
    ds = json.loads(dados.get(k) or "[]")
    if any(x.get("id") == i for x in ds):
        print(i, "já está na nuvem")
        continue
    d["mod"] = agora
    if d.get("alerta"):
        d["alertaDesde"] = agora
    ds.append(d)
    dados[k] = json.dumps(ds, separators=(",", ":"))
    mod[k] = agora
    apag.pop(i, None)
    print("devolvido:", i)
pac["atualizado"] = agora
gh("/gists/" + gid, "PATCH", {"files": {ARQ_SYNC: {"content": json.dumps(pac, separators=(",", ":"))}}})
print("pronto")
