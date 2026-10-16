#!/usr/bin/env python3
"""
b3_opcoes.py - Mapa de posicoes em aberto de opcoes da B3 (uso pessoal)

Baixa os arquivos publicos e gratuitos da B3 (arquivos.b3.com.br), cruza:
  - DerivativesOpenPositionFile   -> posicoes em aberto por serie (TtlPos)
  - InstrumentsConsolidatedFile   -> strike, vencimento e tipo (call/put) de cada serie
  - TradeInformationConsolidatedFile -> preco de fechamento do ativo
e gera o arquivo opcoes.json lido pela pagina opcoes.html.

So usa a biblioteca padrao do Python. Os dados sao do fim do pregao (D-1), nao intradiarios.

Uso:
  python b3_opcoes.py                         BBAS3 e AZEV3, ultimo pregao disponivel
  python b3_opcoes.py --ativos BBAS3 PETR4    outros ativos
  python b3_opcoes.py --data 2026-10-15       data especifica
"""
import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://arquivos.b3.com.br/api/download"
UA = {"User-Agent": "Mozilla/5.0 (b3_opcoes.py; uso pessoal)"}


# ---------------------------------------------------------------- download
def _abrir(url, tentativas=3):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None  # arquivo nao existe para a data
            if i == tentativas - 1:
                raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if i == tentativas - 1:
                raise
        time.sleep(3 * (i + 1))
    return None


def baixar(nome, data):
    """Retorna o texto do arquivo da B3 ou None se nao houver para a data."""
    bruto = _abrir(f"{BASE}/requestname?fileName={nome}&date={data}")
    if not bruto:
        return None
    try:
        token = json.loads(bruto.decode("utf-8")).get("token")
    except ValueError:
        return None
    if not token:
        return None
    conteudo = _abrir(f"{BASE}/?token={token}")
    if not conteudo:
        return None
    return conteudo.decode("latin-1")


def ler_csv(texto):
    """Le o CSV da B3 (separador ';'), pulando a linha 'Status do Arquivo'."""
    linhas = texto.splitlines()
    ini = next((i for i, l in enumerate(linhas) if l.startswith("RptDt;")), None)
    if ini is None:
        return []
    cab = linhas[ini].split(";")
    out = []
    for l in linhas[ini + 1:]:
        if not l.strip():
            continue
        c = l.split(";")
        out.append({cab[i]: (c[i] if i < len(c) else "") for i in range(len(cab))})
    return out


def num(s):
    s = (s or "").strip().replace(".", "").replace(",", ".") if "," in (s or "") else (s or "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


# ---------------------------------------------------------------- calculos
def max_pain(strikes):
    """Strike em que o valor total das opcoes no vencimento seria o menor possivel."""
    melhor, menor = None, None
    for alvo in (s["k"] for s in strikes):
        pago = sum(s["call"] * max(0.0, alvo - s["k"]) + s["put"] * max(0.0, s["k"] - alvo) for s in strikes)
        if menor is None or pago < menor:
            melhor, menor = alvo, pago
    return melhor


def resumo_vencimento(strikes, preco):
    tc = sum(s["call"] for s in strikes)
    tp = sum(s["put"] for s in strikes)
    acima = [s for s in strikes if s["k"] >= preco]
    abaixo = [s for s in strikes if s["k"] <= preco]
    parede_call = max(acima, key=lambda s: s["call"], default=None)
    parede_put = max(abaixo, key=lambda s: s["put"], default=None)
    mp = max_pain(strikes) if strikes else None
    return {
        "totalCall": tc,
        "totalPut": tp,
        "pcr": round(tp / tc, 2) if tc else None,
        "maxPain": mp,
        "paredeCall": parede_call["k"] if parede_call and parede_call["call"] > 0 else None,
        "paredePut": parede_put["k"] if parede_put and parede_put["put"] > 0 else None,
    }


def processar(data, ativos):
    print(f"Baixando arquivos da B3 de {data}...")
    t_oi = baixar("DerivativesOpenPositionFile", data)
    if not t_oi:
        return None
    t_inst = baixar("InstrumentsConsolidatedFile", data)
    t_neg = baixar("TradeInformationConsolidatedFile", data)
    if not t_inst or not t_neg:
        return None

    alvo = set(ativos)
    # cadastro das series de opcoes dos ativos pedidos
    series = {}
    for r in ler_csv(t_inst):
        if r.get("SctyCtgyNm") == "OPTION ON EQUITIES" and r.get("Asst") in alvo:
            series[r["TckrSymb"]] = {
                "ativo": r["Asst"],
                "tipo": "call" if r.get("OptnTp", "").lower().startswith("c") else "put",
                "k": round(num(r.get("ExrcPric")), 2),
                "venc": r.get("XprtnDt", ""),
            }

    # precos de fechamento
    precos = {}
    for r in ler_csv(t_neg):
        if r.get("TckrSymb") in alvo and r.get("SgmtNm") == "CASH":
            precos[r["TckrSymb"]] = {"preco": num(r.get("LastPric")), "var": num(r.get("OscnPctg")),
                                     "min": num(r.get("MinPric")), "max": num(r.get("MaxPric"))}

    # posicoes em aberto
    agreg = {a: {} for a in ativos}  # ativo -> venc -> strike -> {call, put, desc}
    termo = {a: 0 for a in ativos}
    for r in ler_csv(t_oi):
        tk = r.get("TckrSymb", "")
        s = series.get(tk)
        if s:
            pos = num(r.get("TtlPos"))
            desc = num(r.get("UcvrdQty"))
            v = agreg[s["ativo"]].setdefault(s["venc"], {})
            d = v.setdefault(s["k"], {"k": s["k"], "call": 0.0, "put": 0.0, "callDesc": 0.0, "putDesc": 0.0})
            d[s["tipo"]] += pos
            d[s["tipo"] + "Desc"] += desc
        elif r.get("SgmtNm") == "EQUITY FORWARD":
            for a in ativos:
                if tk.startswith(a) and tk.endswith("T"):
                    termo[a] += num(r.get("OpnIntrst"))

    saida = {"data": data, "geradoEm": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
             "fonte": "B3 - arquivos publicos (Posicoes em Aberto, Cadastro de Instrumentos, Negocios Consolidados)",
             "ativos": {}}
    for a in ativos:
        p = precos.get(a, {})
        preco = p.get("preco", 0.0)
        vencs = []
        for venc in sorted(agreg[a]):
            strikes = sorted(agreg[a][venc].values(), key=lambda s: s["k"])
            strikes = [s for s in strikes if s["call"] > 0 or s["put"] > 0]
            if not strikes:
                continue
            vencs.append({"venc": venc, **resumo_vencimento(strikes, preco),
                          "strikes": [[s["k"], int(s["call"]), int(s["put"]), int(s["callDesc"]), int(s["putDesc"])]
                                      for s in strikes]})
        saida["ativos"][a] = {"preco": preco, "var": p.get("var"), "min": p.get("min"), "max": p.get("max"),
                              "semOpcoes": not vencs, "termoContratos": int(termo[a]), "vencimentos": vencs}
        print(f"  {a}: preco {preco:.2f} | {len(vencs)} vencimentos com posicao"
              + (" | SEM OPCOES LISTADAS" if not vencs else ""))
    return saida


def main():
    ap = argparse.ArgumentParser(description="Mapa de posicoes em aberto de opcoes da B3")
    ap.add_argument("--ativos", nargs="+", default=["BBAS3", "AZEV3"])
    ap.add_argument("--data", help="AAAA-MM-DD (padrao: ultimo pregao disponivel)")
    ap.add_argument("--saida", default="opcoes.json")
    args = ap.parse_args()
    ativos = [a.upper() for a in args.ativos]

    if args.data:
        datas = [args.data]
    else:
        hoje = datetime.date.today()
        datas = [(hoje - datetime.timedelta(days=i)).isoformat() for i in range(0, 12)
                 if (hoje - datetime.timedelta(days=i)).weekday() < 5]

    for d in datas:
        try:
            res = processar(d, ativos)
        except Exception as e:  # rede, B3 fora do ar etc.
            print(f"  erro em {d}: {e}")
            res = None
        if res:
            with open(args.saida, "w", encoding="utf-8") as f:
                json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
            print(f"Salvo em {os.path.abspath(args.saida)} (pregao de {d})")
            return 0
        print(f"  {d}: arquivos ainda nao publicados, tentando o pregao anterior")
    print("Nenhum pregao com arquivos disponiveis nos ultimos dias.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
