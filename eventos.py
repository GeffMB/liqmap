"""Calendário econômico (EUA) para o LiqMap.

Roda no GitHub Actions algumas vezes por dia e grava eventos.json com:
  - os eventos de alto e médio impacto dos EUA da semana (ForexFactory), com previsão e anterior;
  - as datas oficiais já conhecidas de FOMC (Fed), CPI, payroll, PPI e JOLTS (BLS) e do ISM (regra de dias úteis);
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
# BLS (bls.gov/schedule/news_release/empsit.htm e calendários mensais), 8h30 de Nova York.
# O ForexFactory só publica a semana atual; sem estas datas, a agenda ficava vazia antes do payroll.
PAYROLL = ["2026-12-04", "2027-01-08", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04",
           "2027-07-02", "2027-08-06", "2027-09-03", "2027-10-08", "2027-11-05", "2027-12-03"]
PPI = ["2026-12-15", "2027-01-14", "2027-02-12", "2027-05-13", "2027-06-11", "2027-07-15", "2027-08-10",
       "2027-09-10", "2027-12-15"]          # só as datas já confirmadas pelo BLS
JOLTS = ["2026-12-01"]                      # 10h de Nova York
# ISM: industrial no 1º dia útil do mês e serviços no 3º, às 10h de Nova York (regra fixa do ISM)
FERIADOS_EUA = {"2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05",
                "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"}


def dias_uteis(ano, mes):
    d = datetime(ano, mes, 1)
    while d.month == mes:
        if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in FERIADOS_EUA:
            yield d.strftime("%Y-%m-%d")
        d = d.fromordinal(d.toordinal() + 1)


def datas_ism(meses=14):
    hoje = datetime.now(timezone.utc)
    a, m = hoje.year, hoje.month
    for _ in range(meses):
        uteis = list(dias_uteis(a, m))
        yield "ISM Manufacturing PMI", uteis[0]
        yield "ISM Services PMI", uteis[2]
        a, m = (a + 1, 1) if m == 12 else (a, m + 1)

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
    oficiais = [("CPI m/m", d, "08:30", "High", "BLS") for d in CPI]
    oficiais += [("Non-Farm Employment Change", d, "08:30", "High", "BLS") for d in PAYROLL]
    oficiais += [("PPI m/m", d, "08:30", "High", "BLS") for d in PPI]
    oficiais += [("JOLTS Job Openings", d, "10:00", "Medium", "BLS") for d in JOLTS]
    oficiais += [(orig, d, "10:00", "Medium", "ISM") for orig, d in datas_ism()]
    for orig, d, hora, impacto, fonte in oficiais:
        t = datetime.fromisoformat(d + "T" + hora).replace(tzinfo=NY)
        e = {"t": ms(t), "titulo": TRADUCAO[orig], "orig": orig, "impacto": impacto, "fonte": fonte}
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
