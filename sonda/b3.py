import urllib.request, urllib.error, io, zipfile, re
UA = {"User-Agent": "Mozilla/5.0 (b3_opcoes.py; uso pessoal)"}
def nota(s): print("::notice::" + s.replace("\n", " ⏎ ")[:1800])
def ver(url):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180); return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
    except Exception as e: return "ERR", str(e).encode()
for nome in ("IN261125.zip", "IN261124.zip"):
    st, b = ver(f"https://www.b3.com.br/pesquisapregao/download?filelist={nome}")
    nota(f"{nome}: {st} {len(b)} bytes {b[:20]!r}")
    if st != 200 or not b.startswith(b"PK"): continue
    z = zipfile.ZipFile(io.BytesIO(b)); nota(f"zip: {[(i.filename, i.file_size) for i in z.infolist()]}")
    for inner in z.namelist():
        data = z.read(inner)
        if data.startswith(b"PK"):
            z2 = zipfile.ZipFile(io.BytesIO(data)); nota(f"  interno {inner}: {[(i.filename, i.file_size) for i in z2.infolist()][:8]}")
            for f in z2.namelist()[:6]:
                x = z2.read(f)
                i = x.find(b"BBASS")
                if i < 0: i = x.find(b"BBAS")
                nota(f"   {f} {len(x)}: cab {x[:300]!r}")
                j = x.find(b"<OptnOnEqtsInf")
                if j > 0:
                    k = x.rfind(b"<Instrm>", 0, j); nota(f"   OPCAO exemplo: {x[k if k>0 else j-1500:j+900]!r}")
                    break
    break
