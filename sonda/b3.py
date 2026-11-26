import urllib.request, urllib.error, json
UA = {"User-Agent": "Mozilla/5.0 (b3_opcoes.py; uso pessoal)"}
def nota(s): print("::notice::" + s.replace("\n", " ⏎ ")[:1500])
def ver(url, ua=UA):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=60)
        b = r.read(); return r.status, dict(r.headers), b
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return "ERR", {}, str(e).encode()
B = "https://arquivos.b3.com.br/api/download"
for nome in ("DerivativesOpenPositionFile", "InstrumentsConsolidatedFile", "TradeInformationConsolidatedFile"):
    for data in ("2026-11-25", "2026-11-23", "2026-11-19"):
        st, h, b = ver(f"{B}/requestname?fileName={nome}&date={data}")
        nota(f"{nome} {data}: {st} {h.get('Content-Type')} | {b[:300]!r}")
        if st == 200:
            try:
                tok = json.loads(b).get("token")
                st2, h2, b2 = ver(f"{B}/?token={tok}")
                nota(f"   token -> {st2} {h2.get('Content-Type')} {len(b2)} bytes | {b2[:200]!r}")
            except Exception as e: nota(f"   json falhou {e}")
        break
st, h, b = ver("https://arquivos.b3.com.br/", {"User-Agent": "Mozilla/5.0"})
nota(f"home {st} | {b[:400]!r}")
st, h, b = ver(f"{B}/requestname?fileName=InstrumentsConsolidatedFile&date=2026-11-25", {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "Accept": "application/json"})
nota(f"UA navegador {st} | {b[:300]!r}")
