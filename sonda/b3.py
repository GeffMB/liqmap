import urllib.request, urllib.error, json, re
UA = {"User-Agent": "Mozilla/5.0 (b3_opcoes.py; uso pessoal)"}
def nota(s): print("::notice::" + s.replace("\n", " ⏎ ")[:1800])
def ver(url):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60); return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
    except Exception as e: return "ERR", str(e).encode()
B = "https://arquivos.b3.com.br/api/download"
st, b = ver(f"{B}/requestname?fileName=DerivativesOpenPositionFile&date=2026-11-25"); nota(f"json completo: {b[:600]!r}")
for data in ("2026-11-25", "2026-11-24", "2026-11-21", "2026-11-20", "2026-11-19", "2026-11-13"):
    st, b = ver(f"{B}/requestname?fileName=InstrumentsConsolidatedFile&date={data}"); nota(f"Instr {data}: {st}")
for nome in ("InstrumentsEquitiesFile", "EquitiesInstrumentsFile", "InstrumentsConsolidatedFileV2", "DerivativesInstrumentsFile", "OptionsInstrumentsFile", "InstrumentsFile", "EquityOptionsFile", "ListedOptionsFile"):
    st, b = ver(f"{B}/requestname?fileName={nome}&date=2026-11-25"); nota(f"{nome}: {st} {b[:80]!r}")
st, h = ver("https://arquivos.b3.com.br/")
srcs = re.findall(rb'src="([^"]+\.js)"', h); nota(f"scripts {srcs}")
for s in srcs:
    u = s.decode(); u = u if u.startswith("http") else "https://arquivos.b3.com.br/" + u.lstrip("/")
    st, j = ver(u)
    for m in sorted(set(re.findall(rb'["\'`](/?api/[A-Za-z0-9_/{}$.?=&-]+)', j)))[:40]: nota(f"API {u.rsplit('/',1)[-1]}: {m.decode()}")
for u in ("https://arquivos.b3.com.br/api/channels", "https://arquivos.b3.com.br/api/channels/34dcaaeb-0306-4f45-a83e-4f66a23b42fa/subchannels/9c1e4a35-e4d0-4cc3-9bf0-a5a2b2cdb7c0/publications?&lang=pt"):
    st, b = ver(u); nota(f"{u[-60:]}: {st} {b[:500]!r}")
