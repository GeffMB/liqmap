"""Calendário econômico (EUA) para o LiqMap.

Roda no GitHub Actions algumas vezes por dia e grava eventos.json com:
  - os eventos de alto e médio impacto dos EUA da semana (ForexFactory), com previsão e anterior;
  - as datas oficiais já conhecidas de FOMC (Fed) e CPI (BLS) dos próximos meses;
  - o histórico acumulado dos eventos já passados (para aparecerem nos candles antigos).
O site lê o arquivo do próprio repositório (sem problema de CORS).
"""
import json
import os
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
ARQ = "eventos.json"
FONTES = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json",
          "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]

# Datas oficiais: Fed (federalreserve.gov) e BLS (bls.gov/schedule/news_release/cpi.htm)
FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
        "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"]
CPI = ["2026-11-10", "2026-12-10", "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10",
       "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10"]

TRADUCAO = {
    "FOMC Statement": "Decisão de juros do Fed (FOMC)", "Federal Funds Rate": "Taxa de juros do Fed",
    "FOMC Press Conference": "Coletiva do presidente do Fed", "FOMC Meeting Minutes": "Ata do FOMC",
    "CPI m/m": "Inflação CPI (mês)", "CPI y/y": "Inflação CPI (ano)", "Core CPI m/m": "Inflação CPI núcleo (mês)",
    "PPI m/m": "Inflação ao produtor PPI (mês)", "Core PPI m/m": "PPI núcleo (mês)",
    "Non-Farm Employment Change": "Payroll (empregos)", "Unemployment Rate": "Taxa de desemprego",
    "Average Hourly Earnings m/m": "Salário médio por hora", "Advance GDP q/q": "PIB (prévia)", "GDP q/q": "PIB",
    "Core PCE Price Index m/m": "Inflação PCE núcleo", "Retail Sales m/m": "Vendas no varejo",
    "Unemployment Claims": "Pedidos de seguro-desemprego", "ISM Manufacturing PMI": "PMI industrial ISM",
    "ISM Services PMI": "PMI de serviços ISM", "JOLTS Job Openings": "Vagas de emprego JOLTS",
    "Prelim UoM Consumer Sentiment": "Confiança do consumidor (Michigan)",
    "Revised UoM Consumer Sentiment": "Confiança do consumidor Michigan (revisada)",
    "Prelim UoM Inflation Expectations": "Expectativa de inflação Michigan", "Revised UoM Inflation Expectations": "Expectativa de inflação Michigan (revisada)",
    "Flash Manufacturing PMI": "PMI industrial (prévia)", "Flash Services PMI": "PMI de serviços (prévia)",
    "Final Manufacturing PMI": "PMI industrial (final)", "Final Services PMI": "PMI de serviços (final)",
    "ADP Non-Farm Employment Change": "Empregos ADP", "Durable Goods Orders m/m": "Pedidos de bens duráveis",
    "Core Durable Goods Orders m/m": "Bens duráveis (núcleo)", "Existing Home Sales": "Vendas de casas usadas",
    "New Home Sales": "Vendas de casas novas", "Pending Home Sales m/m": "Vendas pendentes de casas",
    "Empire State Manufacturing Index": "Índice industrial Empire State", "Philly Fed Manufacturing Index": "Índice industrial Philly Fed",
    "Fed Chair Powell Speaks": "Discurso do presidente do Fed", "Prelim GDP q/q": "PIB (preliminar)", "Final GDP q/q": "PIB (final)",
    "PCE Price Index m/m": "Inflação PCE", "Core Retail Sales m/m": "Vendas no varejo (núcleo)", "Trade Balance": "Balança comercial", "CB Consumer Confidence": "Confiança do consumidor (CB)",
}


def baixar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (LiqMap calendario)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def ms(dt):
    return int(dt.timestamp() * 1000)


def chave(e):
    return e.get("orig", e["titulo"]) + "|" + datetime.fromtimestamp(e["t"] / 1000, timezone.utc).strftime("%Y-%m-%d")


def main():
    try:
        antigos = json.load(open(ARQ, encoding="utf-8")).get("eventos", [])
    except Exception:
        antigos = []
    for e in antigos:
        e["titulo"] = TRADUCAO.get(e.get("orig", ""), e["titulo"])
    eventos = {chave(e): e for e in antigos}

    # calendário oficial (horário de Nova York convertido para UTC)
    for d in FOMC:
        t = datetime.fromisoformat(d + "T14:00").replace(tzinfo=NY)
        e = {"t": ms(t), "titulo": TRADUCAO["FOMC Statement"], "orig": "FOMC Statement", "impacto": "High", "fonte": "Fed"}
        eventos.setdefault(chave(e), e)
    for d in CPI:
        t = datetime.fromisoformat(d + "T08:30").replace(tzinfo=NY)
        e = {"t": ms(t), "titulo": TRADUCAO["CPI m/m"], "orig": "CPI m/m", "impacto": "High", "fonte": "BLS"}
        eventos.setdefault(chave(e), e)

    # semana do ForexFactory (substitui/completa os oficiais com previsão e anterior)
    ok = 0
    for url in FONTES:
        try:
            lista = baixar(url)
        except Exception as ex:
            print("Falha em", url, ex)
            continue
        ok += 1
        for x in lista:
            if x.get("country") != "USD" or x.get("impact") not in ("High", "Medium"):
                continue
            try:
                t = datetime.fromisoformat(x["date"])
            except Exception:
                continue
            orig = x.get("title", "")
            e = {"t": ms(t), "titulo": TRADUCAO.get(orig, orig), "orig": orig, "impacto": x["impact"],
                 "previsao": x.get("forecast") or "", "anterior": x.get("previous") or "", "fonte": "ForexFactory"}
            if x.get("actual"):
                e["atual"] = x["actual"]
            k = chave(e)
            if k in eventos:
                eventos[k].update({kk: vv for kk, vv in e.items() if vv != ""})
            else:
                eventos[k] = e

    limite = ms(datetime.now(timezone.utc)) - 400 * 86400 * 1000      # guarda ~13 meses de histórico
    lista = sorted((e for e in eventos.values() if e["t"] >= limite), key=lambda e: e["t"])
    json.dump({"atualizado": ms(datetime.now(timezone.utc)), "fontesSemana": ok, "eventos": lista},
              open(ARQ, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(lista)} eventos gravados (semana: {ok} fonte(s) ok)")


if __name__ == "__main__":
    main()
