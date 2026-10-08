#!/usr/bin/env python3
"""V2.0 阶段 3 · 真实浏览器验证（Chromium headless，Linux arm64，无 GPU）。每个子命令自己起停环境（单次 < 120 秒）。
用法：stage3_verify.py <命令> <输出目录>
  look            快速看图（桌面全部 / 手机全部）
  desktop         1440×900：4 个空间、管理空间、⌘K、删除动作面板、经典外观、768 / 820 / 1024 / 1920
  mobile          390×844：4 个空间、合并底栏、软键盘 + 命令面板、删除面板、横屏 844×390、经典
  checks          溢出（375–1920）、键盘导航、减少动态效果、触屏 hover 粘滞、拖动（真实指针）、软键盘模拟、空间切换中间帧
  perf            资源体积、空间切换 / 打开命令面板的长任务与帧间隔（Performance API + CDP）
  rec-desktop / rec-mobile   约 15 秒录屏（webm → mp4 由调用方转码）
  static          纯静态模式（python http.server）截图 + 状态标注检查
结果写到 <输出目录>/results-<命令>.json
"""
import sys, os, json, time
sys.path.insert(0, '/workspace/work/.tools/py')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from stage3_env import Env

R = '/workspace/work/.tools/root'
CMD = sys.argv[1]; OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/s3'
os.makedirs(OUT, exist_ok=True)
res = {'cmd': CMD, 'errors': [], 'console': [], 'checks': {}, 'shots': []}

def launch(p):
    return p.chromium.launch(executable_path=f'{R}/usr/lib/chromium/chromium', args=['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
                             env=dict(os.environ, LD_LIBRARY_PATH=f'{R}/usr/lib/aarch64-linux-gnu:{R}/usr/lib/chromium'))

def page(b, env, w, h, space=None, mobile=False, reduce=False, ui=None, static=False, video=None, extra_storage=None):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile,
                        reduced_motion='reduce' if reduce else 'no-preference', locale='zh-CN', timezone_id='Asia/Shanghai',
                        record_video_dir=video, record_video_size={'width': w, 'height': h} if video else None)
    if not static: ctx.add_cookies(env.cookies_for())
    st = {}
    if space: st['nocturne.space:admin' if not static else 'nocturne.space:~local'] = space
    if ui: st['nocturne.ui'] = ui
    if static:
        cfg = dict(env.config); cfg['groups'] = json.loads(json.dumps(cfg['groups']))
        for g in cfg['groups']:
            for i in g['items']:
                if i['icon'].get('type') == 'image': i['icon'] = {'type': 'emoji', 'value': '🧭', 'bg': ''}
        st['yeqv.v1'] = json.dumps(cfg)
    if extra_storage: st.update(extra_storage)
    ctx.add_init_script(KBD_SIM_INIT)
    ctx.add_init_script("(function(s){ if (!sessionStorage.getItem('nc-seeded')) { for (var k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem('nc-seeded','1'); } })(%s);" % json.dumps(st))
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: res['errors'].append(f'{w}x{h}: {e}'))
    pg.on('console', lambda m: res['console'].append(f'{w}x{h} {m.type}: {m.text}') if m.type in ('error', 'warning') and 'Failed to load resource' not in m.text else None)
    pg.goto(env.static_url if static else env.base + '/')
    pg.wait_for_function('document.documentElement.classList.contains("mn-done") || matchMedia("(prefers-reduced-motion: reduce)").matches', timeout=8000)
    pg.wait_for_timeout(500)
    return ctx, pg

def shot(pg, name, full=False):
    path = os.path.join(OUT, name + '.png'); pg.screenshot(path=path, full_page=full); res['shots'].append(path); return path

def overflow(pg):
    return pg.evaluate('''() => { const w = document.documentElement.clientWidth; let worst = 0, who = "";
      document.querySelectorAll("body *").forEach(e => { const r = e.getBoundingClientRect(); if (!r.width || getComputedStyle(e).position === "fixed" || e.closest(".mn-sky, .x-dock, .x-cmdk, .x-sheet, .x-spm, .x-is, .x-set, .x-menu")) return;
        const o = Math.round(r.right - w); if (o > worst) { worst = o; who = e.className || e.tagName; } });
      return { scrollW: document.documentElement.scrollWidth - w, worst, who: String(who).slice(0, 60) }; }''')

def select(pg, sid):
    pg.evaluate('id => App.spaces.select(id)', sid); pg.wait_for_timeout(900)

def run(fn):
    with Env() as env, sync_playwright() as p:
        b = launch(p)
        try: fn(b, env)
        finally: b.close()
    json.dump(res, open(os.path.join(OUT, f'results-{CMD}.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({k: res[k] for k in ('errors', 'checks')}, ensure_ascii=False, indent=1)[:6000])

KBD_SIM_INIT = ''
SPACES = [('all', '全部'), ('s-daily', '日常'), ('s-fun', '娱乐'), ('s-nas', 'NAS')]

def look(b, env):
    ctx, pg = page(b, env, 1440, 900); shot(pg, 'look-d-all')
    for sid, n in SPACES[1:]: select(pg, sid); shot(pg, 'look-d-' + sid)
    ctx.close()
    ctx, pg = page(b, env, 390, 844, mobile=True); shot(pg, 'look-m-all')
    for sid, n in SPACES[1:]: select(pg, sid); pg.evaluate('scrollTo(0,0)'); shot(pg, 'look-m-' + sid)
    ctx.close()


KBD_SIM = """(function(){ var vv = window.visualViewport; if (!vv) return; window.__vvh = 0;
  Object.defineProperty(vv, 'height', { configurable: true, get: function(){ return window.__vvh || window.innerHeight; } });
  window.__kb = function(h){ window.__vvh = h ? window.innerHeight - h : 0; vv.dispatchEvent(new Event('resize'));
    var k = document.getElementById('__kbd'); if (!h) { if (k) k.remove(); return; }
    if (!k) { k = document.createElement('div'); k.id = '__kbd'; document.documentElement.appendChild(k); }
    k.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:' + h + 'px;z-index:2147483647;background:linear-gradient(#2b2d33,#1d1f24);color:#8b8f99;font:13px/1 sans-serif;display:grid;place-items:center;pointer-events:none';
    k.textContent = '（模拟软键盘区域：visualViewport 缩小 ' + h + 'px）'; }; })();"""

def desktop(b, env):
    ctx, pg = page(b, env, 1440, 900)
    for sid, n in SPACES:
        select(pg, sid); pg.evaluate('scrollTo(0,0)'); shot(pg, 'd1440-' + (sid if sid != 'all' else 'all'))
    select(pg, 's-fun')
    pg.evaluate('App.spaces.manage("s-fun")'); pg.wait_for_timeout(600); shot(pg, 'd1440-manage-sheet')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    res['checks']['manage_focus_returned'] = pg.evaluate('document.activeElement === document.body || !!document.activeElement.closest(".x-wrap")')
    select(pg, 'all')
    pg.keyboard.press('Control+k'); pg.wait_for_timeout(300); pg.keyboard.type('em', delay=60); pg.wait_for_timeout(400); shot(pg, 'd1440-palette')
    res['checks']['palette_rows'] = pg.eval_on_selector_all('.x-cmdk-row b', 'els => els.slice(0,4).map(e => e.textContent)')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    select(pg, 's-fun')
    pg.evaluate('App.emit("edit", {})'); pg.wait_for_timeout(500)
    pg.click('#x-groups [data-id="emby"] .x-ebadge', force=True); pg.wait_for_timeout(500); shot(pg, 'd1440-delete-sheet')
    res['checks']['delete_rows'] = pg.eval_on_selector_all('.x-sheet .x-row', 'els => els.map(e => e.innerText.replace(/\\n/g," / "))')
    pg.click('.x-sheet .x-row.is-red'); pg.wait_for_timeout(500); shot(pg, 'd1440-delete-confirm')
    res['checks']['delete_confirm'] = pg.inner_text('.x-sheet')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    ctx.close()
    ctx, pg = page(b, env, 1440, 900, ui='classic', space='s-fun'); shot(pg, 'd1440-classic-fun'); ctx.close()
    for w, h, sid in [(768, 1024, 's-fun'), (820, 1180, 'all'), (1024, 768, 's-nas'), (1920, 1080, 'all')]:
        ctx, pg = page(b, env, w, h, space=sid, mobile=w < 1000); shot(pg, 't%d-%s' % (w, sid)); res['checks']['overflow_%d' % w] = overflow(pg); ctx.close()

def mobile(b, env):
    ctx, pg = page(b, env, 390, 844, mobile=True)
    for sid, n in SPACES:
        select(pg, sid); pg.evaluate('scrollTo(0,0)'); shot(pg, 'm390-' + sid)
    select(pg, 's-fun'); pg.evaluate('scrollTo(0, 420)'); pg.wait_for_timeout(300); shot(pg, 'm390-merged-dock')
    res['checks']['dock'] = pg.evaluate("""() => { const d = document.querySelector('.x-dock').getBoundingClientRect(), n = document.querySelector('.x-spaces');
      return { inDock: n.parentNode.classList.contains('x-dock'), bars: [...document.querySelectorAll('.x-dock, .x-spaces, .x-ebar')].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0 && getComputedStyle(e).position === 'fixed').length,
        top: d.top, bottom: d.bottom, vh: innerHeight, padBottom: getComputedStyle(document.body).paddingBottom }; }""")
    pg.evaluate('scrollTo(0, document.body.scrollHeight)'); pg.wait_for_timeout(300)
    res['checks']['last_content_clear_of_dock'] = pg.evaluate("""() => { const d = document.querySelector('.x-dock').getBoundingClientRect().top;
      const els = [...document.querySelectorAll('.x-side .x-card, #x-groups .x-tile, #x-groups .x-chip')].filter(e => e.offsetParent); const last = els[els.length - 1].getBoundingClientRect();
      return { lastBottom: Math.round(last.bottom), dockTop: Math.round(d), clear: last.bottom <= d }; }""")
    pg.evaluate('scrollTo(0,0)')
    pg.click('.x-dock [data-act="palette"]'); pg.wait_for_timeout(300); pg.keyboard.type('nas', delay=50)
    pg.evaluate('window.__kb(336)'); pg.wait_for_timeout(500); shot(pg, 'm390-keyboard-palette')
    res['checks']['keyboard'] = pg.evaluate("""() => { const p = document.querySelector('.x-cmdk').getBoundingClientRect(), d = document.querySelector('.x-dock');
      return { kbClass: document.documentElement.classList.contains('mn-kb'), paletteBottom: Math.round(p.bottom), visible: innerHeight - 336, dockOpacity: getComputedStyle(d).opacity, inputFocused: document.activeElement.matches('.x-cmdk input') }; }""")
    pg.evaluate('window.__kb(0)'); pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    pg.evaluate('App.emit("edit", {})'); pg.wait_for_timeout(500)
    pg.tap('#x-groups [data-id="jellyfin"] .x-ebadge', force=True); pg.wait_for_timeout(500); shot(pg, 'm390-delete-sheet')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(400)
    ctx.close()
    ctx, pg = page(b, env, 844, 390, mobile=True, space='s-nas'); shot(pg, 'm844x390-landscape-nas'); res['checks']['overflow_landscape'] = overflow(pg); ctx.close()
    ctx, pg = page(b, env, 390, 844, mobile=True, ui='classic', space='s-fun'); shot(pg, 'm390-classic-fun'); ctx.close()

def page_kbd(b, env, *a, **k):
    ctx, pg = page(b, env, *a, **k); return ctx, pg

def checks(b, env):
    C = res['checks']
    # overflow across widths and spaces
    ov = {}
    for w, h, m in [(375, 812, 1), (390, 844, 1), (430, 932, 1), (768, 1024, 1), (820, 1180, 1), (1024, 768, 0), (1440, 900, 0), (1920, 1080, 0)]:
        ctx, pg = page(b, env, w, h, mobile=bool(m))
        for sid, n in SPACES:
            select(pg, sid); o = overflow(pg); ov['%d-%s' % (w, sid)] = o['scrollW']
            if o['scrollW'] > 0 or o['worst'] > 1: ov['%d-%s-who' % (w, sid)] = o
        pg.evaluate('App.spaces.manage("s-fun")'); pg.wait_for_timeout(400); ov['%d-manage' % w] = overflow(pg)['scrollW']
        ctx.close()
    C['overflow'] = ov
    # keyboard navigation (desktop)
    ctx, pg = page(b, env, 1440, 900)
    pg.evaluate('document.querySelector(\'.x-sp[data-space="s-fun"]\').click()'); pg.wait_for_timeout(90)
    C['midframe'] = pg.evaluate('({ ghost: !!document.querySelector(".mn-ghost"), ghostOpacity: (document.querySelector(".mn-ghost") ? getComputedStyle(document.querySelector(".mn-ghost")).opacity : null), sweep: document.querySelector(".mn-sky").classList.contains("is-sweep"), swap: document.getElementById("x-groups").classList.contains("mn-swap") })')
    shot(pg, 'd1440-switch-midframe')
    pg.wait_for_timeout(900); C['after_switch_clean'] = pg.evaluate('!document.querySelector(".mn-ghost")')
    select(pg, 'all'); pg.evaluate('document.activeElement && document.activeElement.blur(); scrollTo(0,0)')
    pg.keyboard.press('Tab'); seq = []
    for i in range(12):
        seq.append(pg.evaluate('(() => { const e = document.activeElement; return (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 18); })()'))
        pg.keyboard.press('Tab')
    C['tab_order'] = seq
    pg.focus('.x-sp[aria-current="true"]'); pg.keyboard.press('ArrowDown'); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)
    C['switcher_keys'] = pg.evaluate('App.spaces.selected()')
    pg.keyboard.press('Alt+Digit4'); pg.wait_for_timeout(700); C['alt4'] = pg.evaluate('App.spaces.selected()')
    pg.focus('#btn-menu'); pg.keyboard.press('/'); pg.wait_for_timeout(300)
    C['slash_opens_palette'] = pg.evaluate('!document.querySelector(".x-cmdk").hidden && document.activeElement.matches(".x-cmdk input")')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300); C['palette_focus_returns'] = pg.evaluate('document.activeElement.id')
    pg.mouse.click(5, 5)
    # outside click closes palette
    pg.keyboard.press('Control+k'); pg.wait_for_timeout(300); pg.mouse.click(30, 860); pg.wait_for_timeout(300)
    C['outside_click_closes_palette'] = pg.evaluate('!document.querySelector(".x-cmdk").classList.contains("is-on")')
    # focus-visible ring on search is not amber
    pg.focus('#x-q'); pg.wait_for_timeout(400); C['search_focus_border'] = pg.evaluate('getComputedStyle(document.querySelector(".x-bar")).borderColor')
    # space switch mid-frame
    # real-pointer drag (Sortable forceFallback) in edit mode, in 全部
    select(pg, 'all'); pg.evaluate('App.emit("edit", {})'); pg.wait_for_timeout(500)
    before = pg.evaluate('App.state.groups[0].items.map(i => i.id)')
    a = pg.locator('#x-groups [data-id="emby"]').bounding_box(); c = pg.locator('#x-groups [data-id="navidrome"]').bounding_box()
    pg.mouse.move(a['x'] + a['width'] * .6, a['y'] + a['height'] * .6); pg.mouse.down()
    for i in range(1, 21):
        pg.mouse.move(a['x'] + a['width'] * .6 + (c['x'] + c['width'] * .7 - a['x'] - a['width'] * .6) * i / 20, a['y'] + a['height'] * .6 + (c['y'] - a['y']) * i / 20); pg.wait_for_timeout(25)
    C['drag_floating'] = pg.evaluate('(() => { const f = document.querySelector(".is-floating"); return f ? { pos: getComputedStyle(f).position, inlineTransform: !!f.style.transform } : null; })()')
    shot(pg, 'd1440-drag-midway')
    pg.mouse.up(); pg.wait_for_timeout(600)
    C['drag_order'] = {'before': before, 'after': pg.evaluate('App.state.groups[0].items.map(i => i.id)')}
    pg.evaluate('App.undo()'); ctx.close()
    # reduced motion
    ctx, pg = page(b, env, 1440, 900, reduce=True)
    pg.click('.x-sp[data-space="s-nas"]'); pg.wait_for_timeout(30)
    C['reduced'] = pg.evaluate('({ ghost: !!document.querySelector(".mn-ghost"), anims: document.getAnimations().length, domeTransition: getComputedStyle(document.querySelector(".mn-dome")).transitionDuration, tileTransition: getComputedStyle(document.querySelector(".x-tile")).transitionDuration, sweep: getComputedStyle(document.querySelector(".mn-sweep")).display })')
    shot(pg, 'd1440-reduced-nas'); ctx.close()
    # touch: no hover stickiness, press feedback only
    ctx, pg = page(b, env, 390, 844, mobile=True)
    pg.evaluate('document.addEventListener("click", e => { if (e.target.closest("#x-groups a")) e.preventDefault(); }, true)')
    ref = pg.evaluate('getComputedStyle(document.querySelector("#x-groups [data-id=\\"plex\\"]")).boxShadow')
    pg.tap('#x-groups [data-id="emby"]'); pg.wait_for_timeout(400)
    C['touch'] = pg.evaluate('(r) => { const t = document.querySelector("#x-groups [data-id=\\"emby\\"]"), cs = getComputedStyle(t); return { hoverMQ: matchMedia("(hover: hover)").matches, transform: cs.transform, sameShadowAsUntouched: cs.boxShadow === r }; }', ref)
    # soft keyboard sim on main search
    pg.add_script_tag(content=KBD_SIM); pg.focus('#x-q'); pg.evaluate('window.__kb(300)'); pg.wait_for_timeout(400)
    C['kb_search'] = pg.evaluate('({ kb: document.documentElement.classList.contains("mn-kb"), dockOpacity: getComputedStyle(document.querySelector(".x-dock")).opacity })')
    pg.evaluate('window.__kb(0); document.activeElement.blur()'); pg.wait_for_timeout(300)
    C['kb_closed'] = pg.evaluate('!document.documentElement.classList.contains("mn-kb")')
    # long-press enters edit mode (touch), on the merged-dock layout
    cdp = ctx.new_cdp_session(pg); bb = pg.locator('#x-groups [data-id="plex"]').bounding_box(); x, y = bb['x'] + 30, bb['y'] + 30
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]}); pg.wait_for_timeout(700)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(400)
    C['longpress_edit'] = pg.evaluate('document.body.classList.contains("editing")')
    ctx.close()

def perf(b, env):
    P = res['checks']
    ctx, pg = page(b, env, 1440, 900)
    P['resources'] = pg.evaluate("""() => { const out = {}; const add = (k, t, d) => { out[k] = out[k] || { n: 0, transfer: 0, decoded: 0 }; out[k].n++; out[k].transfer += t; out[k].decoded += d; };
      const nav = performance.getEntriesByType('navigation')[0]; add('html', nav.transferSize, nav.decodedBodySize);
      performance.getEntriesByType('resource').forEach(r => { const u = r.name; const k = /\\.css/.test(u) ? 'css' : /\\.js/.test(u) ? 'js' : /\\.woff2/.test(u) ? 'font' : /\\.(jpg|png|webp)/.test(u) ? 'image' : /api\\/icon/.test(u) ? 'icon-svg' : 'other'; add(k, r.transferSize, r.decodedBodySize); });
      return out; }""")
    def measure(action, label, throttle=1):
        cdp = ctx.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate': throttle})
        pg.evaluate("""() => { window.__lt = []; window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))); window.__po.observe({ type: 'longtask' });
          window.__fr = []; let last = performance.now(), n = 0; const step = (t) => { window.__fr.push(t - last); last = t; if (++n < 90) requestAnimationFrame(step); }; requestAnimationFrame(step); }""")
        pg.wait_for_timeout(60); t0 = time.time(); pg.evaluate(action); dt = round((time.time() - t0) * 1000)
        pg.wait_for_timeout(1700)
        r = pg.evaluate("""() => { const f = window.__fr.slice(1).sort((a, b) => a - b); return { frames: f.length, p50: Math.round(f[Math.floor(f.length * .5)]), p95: Math.round(f[Math.floor(f.length * .95)]), max: Math.round(f[f.length - 1]), over50: f.filter(x => x > 50).length, longtasks: window.__lt }; }""")
        r['sync_ms'] = dt; P[label] = r
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1}); cdp.detach()
    for i, sid in enumerate(['s-fun', 's-nas', 'all']): measure('App.spaces.select("%s")' % sid, 'switch_desktop_%s' % sid)
    measure('App.palette.open("")', 'palette_desktop')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    measure('App.spaces.select("s-fun")', 'switch_desktop_cpu4x', 4)
    ctx.close()
    ctx, pg = page(b, env, 390, 844, mobile=True)
    measure('App.spaces.select("s-nas")', 'switch_mobile_cpu4x', 4)
    measure('App.palette.open("")', 'palette_mobile_cpu4x', 4)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    # scroll smoothness (mobile, 4x CPU)
    cdp = ctx.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    pg.evaluate("""() => { window.__fr = []; let last = performance.now(), n = 0; const step = (t) => { window.__fr.push(t - last); last = t; if (++n < 120) requestAnimationFrame(step); }; requestAnimationFrame(step); }""")
    for i in range(10): pg.mouse.wheel(0, 120); pg.wait_for_timeout(50)
    pg.wait_for_timeout(1200)
    P['scroll_mobile_cpu4x'] = pg.evaluate("""() => { const f = window.__fr.slice(1).sort((a, b) => a - b); return { frames: f.length, p50: Math.round(f[Math.floor(f.length * .5)]), p95: Math.round(f[Math.floor(f.length * .95)]), max: Math.round(f[f.length - 1]) }; }""")
    P['blur_surfaces'] = pg.evaluate("""() => [...document.querySelectorAll('body *')].filter(e => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') && e.getBoundingClientRect().height > 0 && s.display !== 'none'; }).map(e => e.className.split(' ')[0])""")
    P['idle_raf_check'] = pg.evaluate("""() => new Promise(r => { let n = 0; const t0 = performance.now(); const orig = window.requestAnimationFrame; let calls = 0; window.requestAnimationFrame = function (f) { calls++; return orig.call(window, f); }; setTimeout(() => { window.requestAnimationFrame = orig; r({ appRafCallsIn2s: calls }); }, 2000); })""")
    ctx.close()

class Cast:
    """CDP 录屏（Page.startScreencast 的每一帧 + 时间戳），结束后用 ffmpeg 按真实时间间隔拼成 mp4（Playwright 自带的录像需要另装 ffmpeg 构建）"""
    def __init__(self, ctx, pg, name, w, h):
        import base64
        self.dir = os.path.join(OUT, '.cast-' + name); os.makedirs(self.dir, exist_ok=True)
        for f in os.listdir(self.dir): os.remove(os.path.join(self.dir, f))
        self.frames, self.name, self.cdp, self.b64 = [], name, ctx.new_cdp_session(pg), base64
        self.cdp.on('Page.screencastFrame', self.on)
        self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 88, 'maxWidth': w, 'maxHeight': h, 'everyNthFrame': 1})
    def on(self, e):
        n = len(self.frames); path = os.path.join(self.dir, '%05d.jpg' % n)
        open(path, 'wb').write(self.b64.b64decode(e['data'])); self.frames.append((path, e['metadata']['timestamp']))
        try: self.cdp.send('Page.screencastFrameAck', {'sessionId': e['sessionId']})
        except Exception: pass
    def stop(self, pg):
        pg.wait_for_timeout(300); self.cdp.send('Page.stopScreencast')
        lst = os.path.join(self.dir, 'list.txt')
        with open(lst, 'w') as f:
            for i, (pth, ts) in enumerate(self.frames):
                d = (self.frames[i + 1][1] - ts) if i + 1 < len(self.frames) else .1
                f.write("file '%s'\nduration %.4f\n" % (pth, max(.001, d)))
            f.write("file '%s'\n" % self.frames[-1][0])
        out = os.path.join(OUT, self.name + '.mp4')
        import subprocess
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', out], check=True)
        res['checks'][self.name] = {'frames': len(self.frames), 'seconds': round(self.frames[-1][1] - self.frames[0][1], 2), 'file': out}
        import shutil; shutil.rmtree(self.dir, ignore_errors=True)

def recdesk(b, env):
    ctx, pg = page(b, env, 1440, 900); cast = Cast(ctx, pg, 'rec-desktop-spaces-palette', 1440, 900)
    pg.wait_for_timeout(800)
    for sid in ['s-daily', 's-fun', 's-nas', 'all']:
        pg.hover('.x-sp[data-space="%s"]' % sid); pg.wait_for_timeout(250); pg.click('.x-sp[data-space="%s"]' % sid); pg.wait_for_timeout(1500)
    pg.keyboard.press('Control+k'); pg.wait_for_timeout(500); pg.keyboard.type('mp', delay=180); pg.wait_for_timeout(700)
    pg.keyboard.press('ArrowDown'); pg.wait_for_timeout(500); pg.keyboard.press('ArrowDown'); pg.wait_for_timeout(500)
    pg.keyboard.press('Control+a'); pg.keyboard.type('>空间', delay=160); pg.wait_for_timeout(900)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
    pg.hover('#x-groups [data-id="dsm"]'); pg.wait_for_timeout(900)
    cast.stop(pg); ctx.close()

def recmob(b, env):
    ctx, pg = page(b, env, 390, 844, mobile=True); cast = Cast(ctx, pg, 'rec-mobile-switch-edit-delete', 780, 1688)
    pg.wait_for_timeout(800)
    for sid in ['s-daily', 's-fun', 's-nas', 's-fun']:
        pg.tap('.x-dock .x-sp[data-space="%s"]' % sid); pg.wait_for_timeout(1400)
    cdp = ctx.new_cdp_session(pg); bb = pg.locator('#x-groups [data-id="plex"]').bounding_box(); x, y = bb['x'] + 30, bb['y'] + 30
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]}); pg.wait_for_timeout(750)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(1000)
    pg.tap('#x-groups [data-id="emby"] .x-ebadge', force=True); pg.wait_for_timeout(1300)
    pg.tap('.x-sheet .x-row'); pg.wait_for_timeout(1500)
    pg.tap('#x-toast-act'); pg.wait_for_timeout(1200)
    pg.tap('.x-ebar [data-e="done"]'); pg.wait_for_timeout(1000)
    cast.stop(pg); ctx.close()

def static(b, env):
    for w, h, m in [(1440, 900, 0), (390, 844, 1)]:
        ctx, pg = page(b, env, w, h, mobile=bool(m), static=True, space='s-nas'); pg.wait_for_timeout(3500)
        shot(pg, 'static-%d-nas' % w)
        res['checks']['static_%d' % w] = pg.evaluate("""() => ({ nocturne: !!window.NOCTURNE, cnt: document.querySelector('.x-side .x-cnt').textContent, line: document.querySelector('.x-side .x-sline').textContent,
          rows: [...document.querySelectorAll('#x-groups .x-st')].slice(0, 6).map(e => e.textContent), anyMs: /\\d+ ms/.test(document.querySelector('#x-groups').textContent + document.querySelector('.x-side').textContent) })""")
        ctx.close()

KBD_SIM_INIT = KBD_SIM
CMDS = {'look': look, 'desktop': desktop, 'mobile': mobile, 'checks': checks, 'perf': perf, 'rec-desktop': recdesk, 'rec-mobile': recmob, 'static': static}
if __name__ == '__main__':
    run(CMDS[CMD])
