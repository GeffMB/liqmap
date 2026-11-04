"""Fluxo de dinheiro entrando/saindo do mercado cripto, para a página fluxos.html do LiqMap.

Roda no GitHub Actions a cada ~2 horas e grava fluxos.json com:
  - CEX: reservas das maiores corretoras (prova de reservas publicada no DefiLlama) e o fluxo líquido
    em 24h / 7d / 30d, calculado pela variação da QUANTIDADE de cada moeda × preço atual
    (assim a alta ou queda do preço não conta como entrada/saída);
  - ETFs de BTC e ETH dos EUA (BlackRock, Fidelity, Grayscale...): fluxo diário por fundo (Farside);
  - Stablecoins: variação da oferta total (dinheiro novo em dólar digital entrando no cripto).
Cada fonte é independente: se uma falhar, as outras continuam e o arquivo anterior daquela parte é mantido.
"""
import html
import json
import re
import time
import urllib.request
from html.parser import HTMLParser

ARQ = "fluxos.json"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
DIA = 86400


def baixar(url, js=True, tentativas=2):
    for k in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                txt = r.read().decode("utf-8", "replace")
            return json.loads(txt) if js else txt
        except Exception as e:
            if k == tentativas - 1:
                raise
            time.sleep(3)


# ---------- CEX (DefiLlama, gratuito) ----------
def cex():
    protos = baixar("https://api.llama.fi/protocols")
    lista = sorted([p for p in protos if p.get("category") == "CEX" and (p.get("tvl") or 0) > 0],
                   key=lambda p: -p["tvl"])[:12]
    out = []
    for p in lista:
        try:
            d = baixar("https://api.llama.fi/protocol/" + p["slug"])
            qtd, usd = d.get("tokens") or [], d.get("tokensInUsd") or []
            if len(qtd) < 2 or not usd:
                continue
            ult_q, ult_u = qtd[-1]["tokens"], usd[-1]["tokens"]
            preco = {s: ult_u[s] / q for s, q in ult_q.items() if q and s in ult_u and ult_u[s]}
            linha = {"nome": p["name"].replace(" CEX", ""), "slug": p["slug"], "logo": p.get("logo"),
                     "ativos": sum(v for v in ult_u.values() if v and v > 0), "atualizado": qtd[-1]["date"]}
            for nome, seg in (("d1", DIA), ("d7", 7 * DIA), ("d30", 30 * DIA)):
                alvo = qtd[-1]["date"] - seg
                ant = next((x for x in reversed(qtd[:-1]) if x["date"] <= alvo + 3 * 3600), None)
                if not ant:
                    linha[nome] = None
                    continue
                q0 = ant["tokens"]
                total = 0.0
                for s in set(ult_q) | set(q0):
                    pr = preco.get(s)
                    if pr is None:
                        continue
                    total += (ult_q.get(s, 0) - q0.get(s, 0)) * pr
                linha[nome] = total
            # moedas principais (para o detalhe)
            top = sorted(ult_u.items(), key=lambda kv: -(kv[1] or 0))[:6]
            linha["composicao"] = [[s, v] for s, v in top]
            out.append(linha)
            print("CEX ok:", linha["nome"], round(linha["ativos"] / 1e9, 2), "bi")
        except Exception as e:
            print("CEX falhou:", p["slug"], e)
    return out


# ---------- ETFs (Farside) ----------
class Tabela(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tabelas, self._t, self._l, self._c, self._dentro = [], None, None, None, 0

    def handle_starttag(self, tag, a):
        if tag == "table":
            self._t = []
        elif tag == "tr" and self._t is not None:
            self._l = []
        elif tag in ("td", "th") and self._l is not None:
            self._c = ""

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._c is not None and self._l is not None:
            self._l.append(html.unescape(self._c).strip())
            self._c = None
        elif tag == "tr" and self._l is not None and self._t is not None:
            if self._l:
                self._t.append(self._l)
            self._l = None
        elif tag == "table" and self._t is not None:
            self.tabelas.append(self._t)
            self._t = None

    def handle_data(self, d):
        if self._c is not None:
            self._c += d


def num(txt):
    t = txt.replace(",", "").strip()
    if t in ("", "-", "–"):
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


MESES = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def etf(url):
    pag = baixar(url, js=False)
    p = Tabela()
    p.feed(pag)
    melhor = max(p.tabelas, key=len) if p.tabelas else []
    cab = None
    dias = []
    for linha in melhor:
        if cab is None and any(c in ("IBIT", "ETHA", "Total") for c in linha):
            cab = linha
            continue
        if not cab or not linha:
            continue
        m = re.match(r"(\d{1,2}) (\w{3}) (\d{4})", linha[0])
        if not m or m.group(2) not in MESES:
            continue
        data = f"{m.group(3)}-{MESES[m.group(2)]:02d}-{int(m.group(1)):02d}"
        vals = {cab[i]: num(linha[i]) for i in range(1, min(len(cab), len(linha))) if cab[i]}
        if all(v is None for v in vals.values()):
            continue
        dias.append({"data": data, "fundos": {k: v for k, v in vals.items() if k != "Total" and v is not None},
                     "total": vals.get("Total")})
    if not dias:
        raise ValueError("tabela não encontrada")
    return {"fundos": [c for c in cab[1:] if c and c != "Total"], "dias": dias[-400:]}


# ---------- stablecoins (DefiLlama, gratuito) ----------
def stables():
    d = baixar("https://stablecoins.llama.fi/stablecoincharts/all")
    pts = [(int(x["date"]), sum(v for v in x["totalCirculatingUSD"].values() if v)) for x in d if x.get("totalCirculatingUSD")]
    return {"serie": pts[-400:]}


def main():
    try:
        atual = json.load(open(ARQ, encoding="utf-8"))
    except Exception:
        atual = {}
    status = {}
    for nome, f in (("cex", cex), ("etfBtc", lambda: etf("https://farside.co.uk/bitcoin-etf-flow-all-data/")),
                    ("etfEth", lambda: etf("https://farside.co.uk/ethereum-etf-flow-all-data/")), ("stables", stables)):
        try:
            v = f()
            if not v:
                raise ValueError("vazio")
            atual[nome] = v
            status[nome] = "ok"
        except Exception as e:
            status[nome] = "falhou: " + str(e)[:120]
            print(nome, status[nome])
    atual["atualizado"] = int(time.time())
    atual["status"] = status
    json.dump(atual, open(ARQ, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("Status:", status)


if __name__ == "__main__":
    main()
