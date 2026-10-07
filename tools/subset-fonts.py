#!/usr/bin/env python3
"""
Rebuild public/fonts (subset webfonts) — dev tool, not needed at runtime.

  pip install fonttools brotli
  # original Google Fonts slices live in git history (commit 4c489f7):
  git archive 4c489f7 public/fonts | tar -x -C /tmp/orig
  # character frequency: jieba's dict.txt (pip download jieba --no-deps; untar)
  python3 tools/subset-fonts.py --src /tmp/orig/public/fonts --freq /path/to/jieba/dict.txt

Output (public/fonts):
  notoserifsc-500-core.woff2   every CJK char in index.html / nocturne.js / server.js + top 1,000 common chars (always loaded)
  notoserifsc-500-ext.woff2    common chars 1,001–3,500 (unicode-range: fetched only when the page shows one)
  notoserifsc-400-greet.woff2  greeting words only (the 400 weight is used by the greeting line alone)
  cormorantgaramond-*-latin(-ext).woff2  clock digits / subtitle
Anything rarer falls back to the system serif (Songti SC / STSong / Noto Serif CJK SC).
"""
import argparse, collections, glob, io, os, re, shutil, tempfile
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer
from fontTools.merge import Merger

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASCII = "".join(chr(i) for i in range(0x20, 0x7F))
PUNCT = "，。、；：？！“”‘’（）《》【】—…·「」『』～￥％＃＠＆＊＋－＝／"
GREET = "夜深了早上好中午好下午好晚上好"


def build(src, chars, wght, out):
    need, parts = set(map(ord, chars)), []
    for p in sorted(glob.glob(os.path.join(src, "notoserifsc*.woff2"))):
        f = TTFont(p)
        u = need & set(f.getBestCmap())
        if not u:
            continue
        need -= u
        o = subset.Options()
        o.layout_features = ["kern"]
        o.drop_tables += ["BASE", "STAT", "vhea", "vmtx", "VORG"]
        o.name_IDs = [0, 1, 2, 3, 4, 5, 6]
        o.hinting = False
        o.notdef_outline = True
        s = subset.Subsetter(o); s.populate(unicodes=u); s.subset(f)
        f = instancer.instantiateVariableFont(f, {"wght": wght})
        f["OS/2"].usWeightClass = wght
        sub = {400: "Regular", 500: "Medium"}.get(wght, str(wght))
        for r in f["name"].names:
            if r.nameID in (1, 16): r.string = "Noto Serif SC"
            elif r.nameID in (2, 17): r.string = sub
            elif r.nameID == 4: r.string = "Noto Serif SC " + sub
            elif r.nameID == 6: r.string = "NotoSerifSC-" + sub + "-Nocturne-Subset"
        f.flavor = None
        parts.append(f)
    with tempfile.TemporaryDirectory() as td:
        paths = []
        for i, f in enumerate(parts):
            pth = os.path.join(td, "%d.ttf" % i); f.save(pth); paths.append(pth)
        m = Merger().merge(paths)
    m.flavor = "woff2"
    m.save(out)
    return len(need)


def ranges(cs):
    cps, out, i = sorted(map(ord, cs)), [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1: j += 1
        out.append("U+%X" % cps[i] if i == j else "U+%X-%X" % (cps[i], cps[j])); i = j + 1
    return ", ".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir with the original Google Fonts slices + fonts.css")
    ap.add_argument("--freq", required=True, help="jieba dict.txt (word freq) used to rank characters")
    ap.add_argument("--core", type=int, default=1000)
    ap.add_argument("--ext", type=int, default=3500)
    a = ap.parse_args()
    out_dir = os.path.join(ROOT, "public", "fonts")
    freq = collections.Counter()
    for line in open(a.freq, encoding="utf8"):
        w, f = line.split()[:2]
        for ch in w:
            if "\u4e00" <= ch <= "\u9fff": freq[ch] += int(f)
    top = [c for c, _ in freq.most_common(a.ext)]
    src_text = "".join(open(os.path.join(ROOT, p), encoding="utf8").read() for p in ("public/index.html", "public/nocturne.js", "server.js"))
    core = {c for c in src_text if ord(c) > 0x2E80} | set(top[: a.core]) | set(ASCII) | set(PUNCT)
    ext = set(top) - core
    greet = set(GREET) | set(ASCII) | set(PUNCT)
    for f in os.listdir(out_dir): os.remove(os.path.join(out_dir, f))
    for name, cs, w in (("notoserifsc-500-core.woff2", core, 500), ("notoserifsc-500-ext.woff2", ext, 500), ("notoserifsc-400-greet.woff2", greet, 400)):
        miss = build(a.src, "".join(cs), w, os.path.join(out_dir, name))
        print(name, len(cs), "chars", os.path.getsize(os.path.join(out_dir, name)), "bytes", "(%d not in font)" % miss)
    css, corm = open(os.path.join(a.src, "fonts.css")).read(), []
    for cm, b in re.findall(r"/\* ([\w-]+) \*/\s*@font-face\s*\{([^}]*)\}", css):
        if "Cormorant" not in b or cm not in ("latin", "latin-ext"): continue
        st = re.search(r"font-style:\s*(\w+)", b).group(1); w = re.search(r"font-weight:\s*(\d+)", b).group(1)
        url = re.search(r"url\(([^)]+)\)", b).group(1); ur = re.search(r"unicode-range:\s*([^;]+);", b).group(1)
        name = "cormorantgaramond-%s%s-%s.woff2" % (w, "italic" if st == "italic" else "", cm)
        shutil.copy(os.path.join(a.src, url), os.path.join(out_dir, name))
        corm.append((cm, st, w, name, ur))
    lines = ["/* 夜曲 Nocturne · self-hosted fonts (subset). Regenerate: tools/subset-fonts.py */"]
    for cm, st, w, name, ur in corm:
        lines.append("/* Cormorant Garamond %s %s · %s */\n@font-face { font-family: 'Cormorant Garamond'; font-style: %s; font-weight: %s; font-display: swap; src: url(%s) format('woff2'); unicode-range: %s; }" % (w, st, cm, st, w, name, ur))
    lines.append("/* Noto Serif SC 400 · only the greeting words (问候语) */\n@font-face { font-family: 'Noto Serif SC'; font-style: normal; font-weight: 400; font-display: swap; src: url(notoserifsc-400-greet.woff2) format('woff2'); unicode-range: %s; }" % ranges(greet))
    lines.append("/* Noto Serif SC 500 · next ~2,500 common characters — downloaded only when the page shows one of them */\n@font-face { font-family: 'Noto Serif SC'; font-style: normal; font-weight: 500; font-display: swap; src: url(notoserifsc-500-ext.woff2) format('woff2'); unicode-range: %s; }" % ranges(ext))
    lines.append("/* Noto Serif SC 500 · every character in the UI + the ~1,000 most common characters (declared last = tried first). Anything else falls back to the system serif. */\n@font-face { font-family: 'Noto Serif SC'; font-style: normal; font-weight: 500; font-display: swap; src: url(notoserifsc-500-core.woff2) format('woff2'); }")
    open(os.path.join(out_dir, "fonts.css"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
