#!/usr/bin/env python3
"""Build preview/v2/standalone.html: one self-contained file (CSS/JS/fonts/wallpapers inlined).
Fonts: subsets of the repo's self-hosted fonts (public/fonts) to the characters this preview uses."""
import base64, io, os, re, sys
sys.path.insert(0, "/workspace/work/.tools/py")
from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); PUB = os.path.join(HERE, "..", "..", "public")
html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
css = open(os.path.join(HERE, "v2.css"), encoding="utf-8").read()
js = open(os.path.join(HERE, "v2.js"), encoding="utf-8").read()
text = html + js + css + "0123456789—「」，。：；！？（）、·…"
def b64(data): return base64.b64encode(data).decode()
def sub(src, chars, extra_feat=()):
    opts = subset.Options(); opts.flavor = "woff2"; opts.layout_features = ["*"]; opts.name_IDs = ["*"]; opts.notdef_outline = True
    f = TTFont(src); s = subset.Subsetter(opts); s.populate(text="".join(sorted(set(chars)))); s.subset(f)
    out = io.BytesIO(); f.flavor = "woff2"; f.save(out); return out.getvalue()
cjk = {c for c in text if ord(c) > 0x2000} | set(" !\"#$%&'()*+,-./:;<=>?@[]_{}|~") | {chr(c) for c in range(0x20, 0x7f)}
serif = sub(os.path.join(PUB, "fonts/notoserifsc-500-core.woff2"), cjk)
latin = {chr(c) for c in range(0x20, 0x7f)} | set("—’‘“”…·")
corm = sub(os.path.join(PUB, "fonts/cormorantgaramond-300-latin.woff2"), latin)
cormi = sub(os.path.join(PUB, "fonts/cormorantgaramond-400italic-latin.woff2"), latin)
missing = sorted(c for c in cjk if ord(c) > 0x3000 and ord(c) not in TTFont(io.BytesIO(serif)).getBestCmap())
extfont = b""; ext_range = ""
if missing:
    extf = TTFont(os.path.join(PUB, "fonts/notoserifsc-500-ext.woff2")); have = extf.getBestCmap()
    got = [c for c in missing if ord(c) in have]
    if got:
        extfont = sub(os.path.join(PUB, "fonts/notoserifsc-500-ext.woff2"), got); ext_range = ",".join("U+%04X" % ord(c) for c in got)
        missing = [c for c in missing if c not in got]
fonts = (
  "@font-face{font-family:'Noto Serif SC';font-weight:500;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}\n"
  "@font-face{font-family:'Noto Serif SC';font-weight:400;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}\n"
  "@font-face{font-family:'Cormorant Garamond';font-weight:300;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}\n"
  "@font-face{font-family:'Cormorant Garamond';font-weight:400;font-style:italic;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2')}\n"
) % (b64(serif), b64(serif), b64(corm), b64(cormi))
if extfont:
    fonts += "@font-face{font-family:'Noto Serif SC';font-weight:500;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s}\n" % (b64(extfont), ext_range)
def jpg(path, maxw, q):
    im = Image.open(path).convert("RGB")
    if im.width > maxw: im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    o = io.BytesIO(); im.save(o, "JPEG", quality=q, optimize=True, progressive=True); return o.getvalue()
wd = jpg(os.path.join(PUB, "bg-desktop.jpg"), 2000, 80); wm = jpg(os.path.join(PUB, "bg-mobile.jpg"), 704, 82)
out = html
out = re.sub(r"<!--v2:fonts-->.*?<!--/v2:fonts-->", lambda m: "<style>\n" + fonts + "</style>", out, flags=re.S)
out = re.sub(r"<!--v2:css-->.*?<!--/v2:css-->", lambda m: "<style>\n" + css + "\n</style>", out, flags=re.S)
out = re.sub(r"<!--v2:js-->.*?<!--/v2:js-->", lambda m: "<script>\n" + js.replace("</script", "<\\/script") + "\n</script>", out, flags=re.S)
out = re.sub(r"<!--v2:icon-->.*?<!--/v2:icon-->", lambda m: '<link rel="icon" href="data:image/svg+xml;base64,%s" />' % b64(open(os.path.join(PUB, "favicon.svg"), "rb").read()), out, flags=re.S)
out = out.replace('src="../../public/bg-desktop.jpg"', 'src="data:image/jpeg;base64,%s"' % b64(wd))
out = out.replace('src="../../public/bg-mobile.jpg"', 'src="data:image/jpeg;base64,%s"' % b64(wm))
assert "../../public" not in out, "unresolved asset reference"
open(os.path.join(HERE, "standalone.html"), "w", encoding="utf-8").write(out)
print("ext %d B, serif %d B, cormorant %d+%d B, wallpaper d %d m %d B, total %d B, glyphs missing from Noto Serif subset (fall back to system serif): %s" % (
  len(extfont), len(serif), len(corm), len(cormi), len(wd), len(wm), len(out.encode()), "".join(missing) or "none"))
