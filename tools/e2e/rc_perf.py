#!/usr/bin/env python3
"""V2.0 RC · 性能实测 + 最终截图（Chromium headless，真实 server.js NAS 模式，tools/stage3_env.Env）。

  - 首屏字体：fonts.css 的 font-display、有没有 preload、首屏实际下载了哪些字体子集（传输 / 解码字节）、document.fonts.ready 时间、
    布局偏移 CLS（字体替换造成的跳动会体现在这里）、FCP / LCP
  - 壁纸：默认壁纸 / 用户上传壁纸的像素尺寸、传输字节、解码耗时（img.decode()）
  - JS 堆：载入后、20 次空间切换后（CDP HeapProfiler.collectGarbage + Performance.getMetrics JSHeapUsedSize）
  - 空间切换长任务：CPU 4× 节流（CDP Emulation.setCPUThrottlingRate），桌面 1440 与手机 390 各 8 次
  - 最终 RC 截图：桌面 1440、手机 390
用法：python3 tools/e2e/rc_perf.py <截图目录>
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rc_common import *
from stage3_env import Env
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rc-perf'
os.makedirs(OUT, exist_ok=True)
P = {}
OBS = '''(() => { window.__cls = 0; window.__lcp = 0; window.__lt = [];
  new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) window.__cls += e.value; })).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => { window.__lcp = Math.round(e.startTime); })).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
  document.fonts.ready.then(() => { window.__fontsReady = Math.round(performance.now()); }); })();'''


def ctx_page(b, env, w, h, mobile=False, space=None):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=3 if mobile else 1, is_mobile=mobile, has_touch=mobile, locale='zh-CN', timezone_id='Asia/Shanghai')
    ctx.add_cookies(env.cookies_for()); ctx.add_init_script(OBS)
    if space: ctx.add_init_script('localStorage.setItem("nocturne.space:admin", %s)' % json.dumps(space))
    pg = ctx.new_page(); pg.goto(env.base + '/')
    pg.wait_for_function('document.documentElement.classList.contains("mn-done")', timeout=10000); pg.wait_for_timeout(800)
    return ctx, pg


def heap(cdp):
    cdp.send('HeapProfiler.collectGarbage'); time.sleep(.3)
    m = {x['name']: x['value'] for x in cdp.send('Performance.getMetrics')['metrics']}
    return round(m['JSHeapUsedSize'] / 1048576, 2), int(m['Nodes'])


def switch_bench(pg, cdp, n, rate):
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': rate})
    ids = pg.evaluate('["all"].concat(App.spaces.list().map(s => s.id))')
    out = []
    for i in range(n):
        sid = ids[(i + 1) % len(ids)]
        pg.evaluate('window.__lt = []')
        t = pg.evaluate('''id => new Promise(r => { const t0 = performance.now(); document.querySelector(`.x-sp[data-space="${id}"]`).click(); const s = performance.now() - t0;
            requestAnimationFrame(() => requestAnimationFrame(() => r({ sync: Math.round(s), frame: Math.round(performance.now() - t0) }))); })''', sid)
        pg.wait_for_timeout(1100)
        t['longtasks'] = pg.evaluate('window.__lt.slice()'); out.append(t)
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
    lts = sorted(x for t in out for x in t['longtasks'])
    return {'runs': out, 'sync_ms': sorted(t['sync'] for t in out), 'longtask_max': max(lts) if lts else 0, 'longtask_median': lts[len(lts) // 2] if lts else 0, 'with_longtask': sum(1 for t in out if t['longtasks'])}


with Env() as env, sync_playwright() as p:
    b = launch(p)
    css = open(os.path.join(ROOT, 'public', 'fonts', 'fonts.css')).read()
    idx = open(os.path.join(ROOT, 'public', 'index.html')).read()
    P['fonts_css'] = {'faces': css.count('@font-face'), 'font_display_swap': css.count('font-display: swap'), 'preload_in_index': idx.count('rel="preload"'),
                      'files_kb': {f: round(os.path.getsize(os.path.join(ROOT, 'public', 'fonts', f)) / 1024, 1) for f in sorted(os.listdir(os.path.join(ROOT, 'public', 'fonts'))) if f.endswith('.woff2')}}
    for label, w, h, mob in (('desktop1440', 1440, 900, False), ('mobile390', 390, 844, True)):
        ctx, pg = ctx_page(b, env, w, h, mob)
        cdp = ctx.new_cdp_session(pg); cdp.send('Performance.enable')
        r = pg.evaluate('''() => { const res = performance.getEntriesByType('resource'), nav = performance.getEntriesByType('navigation')[0], fcp = performance.getEntriesByName('first-contentful-paint')[0];
          const fonts = res.filter(r => /\\.woff2/.test(r.name)).map(r => ({ f: r.name.split('/').pop(), kb: Math.round(r.encodedBodySize / 1024), at: Math.round(r.responseEnd) }));
          const wp = res.filter(r => /bg-|wallpaper/.test(r.name)).map(r => ({ f: r.name.split('/').pop().split('?')[0], kb: Math.round(r.encodedBodySize / 1024), at: Math.round(r.responseEnd) }));
          const js = res.filter(r => /\\.js/.test(r.name)).reduce((n, r) => n + r.transferSize, 0);
          return { fcp: fcp ? Math.round(fcp.startTime) : null, lcp: window.__lcp, cls: +window.__cls.toFixed(4), fontsReady: window.__fontsReady, domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            fonts, wallpaper: wp, js_transfer_kb: Math.round(js / 1024), loadLongtasks: window.__lt.slice(), fontStatus: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight + ' ' + f.style) }; }''')
        r['wallpaper_decode'] = pg.evaluate('''async () => { const el = [...document.querySelectorAll('img.x-bg')].find(e => getComputedStyle(e).display !== 'none'); if (!el) return null;
          const u = el.currentSrc || el.src; const im = new Image(); const t0 = performance.now(); im.src = u + '?nocache=' + Math.random(); await im.decode();
          return { url: u.split('/').pop(), px: [el.naturalWidth, el.naturalHeight], viewportPx: [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio], fetch_decode_ms: Math.round(performance.now() - t0) }; }''')
        r['heap_after_load_mb'], r['dom_nodes_after_load'] = heap(cdp)
        ids = pg.evaluate('["all"].concat(App.spaces.list().map(s => s.id))')
        for i in range(20): pg.evaluate('id => App.spaces.select(id)', ids[(i + 1) % len(ids)]); pg.wait_for_timeout(250)
        pg.wait_for_timeout(1200)
        r['heap_after_20_switches_mb'], r['dom_nodes_after_20'] = heap(cdp)
        r['switch_cpu4x'] = switch_bench(pg, cdp, 8, 4)
        P[label] = r; ctx.close()
        print(label, json.dumps({k: v for k, v in r.items() if k != 'switch_cpu4x'}, ensure_ascii=False))
        print(label, 'switch 4x', {k: v for k, v in r['switch_cpu4x'].items() if k != 'runs'})
    # final RC screenshots
    for sid, name in (('all', 'all'), ('s-daily', 'daily'), ('s-fun', 'fun'), ('s-nas', 'nas')):
        ctx, pg = ctx_page(b, env, 1440, 900, space=sid); pg.screenshot(path=os.path.join(OUT, 'rc-desktop-1440-%s.png' % name)); ctx.close()
        ctx, pg = ctx_page(b, env, 390, 844, True, space=sid); pg.screenshot(path=os.path.join(OUT, 'rc-mobile-390-%s.png' % name)); ctx.close()
    # custom (uploaded) wallpaper size handling
    c = Client('http://127.0.0.1:%d' % env.port).login('admin')
    big = wallpaper_jpg(4000, 2250); st, wpr = c.j('PUT', '/api/wallpaper', big, ctype='image/jpeg')
    P['uploaded_wallpaper'] = {'uploaded_px': [4000, 2250], 'uploaded_kb': round(len(big) / 1024), 'stored_kb': round(len(c.req('GET', '/api/wallpaper')[2]) / 1024), 'note': '服务器原样保存，不缩放（前端从相册选择时会先压缩，见 index.html 设置 → 壁纸）'}
    b.close()
json.dump(P, open(os.path.join(OUT, 'rc-perf.json'), 'w'), ensure_ascii=False, indent=1)
print('written', os.path.join(OUT, 'rc-perf.json'))
