#!/usr/bin/env python3
"""V2.0 阶段 3 · 手机底栏（Dock）真实浏览器验证（Chromium headless，Linux arm64，无 GPU）。
每个子命令自己起停环境（真实 server.js NAS 模式 + 临时 DATA_DIR，或纯静态），单次 < 120 秒。
用法：dock_verify.py <命令> <输出目录> [前缀]
  shots       320 / 375 / 390 / 430 竖屏 × 全部 / 日常 / 娱乐 / NAS + 横屏 844×390、667×375（NAS 模式）
  bottom      滚到底部（正文、服务卡、状态卡在底栏下面经过）+ 亮色壁纸（深浅两种壁纸）
  many        12 个空间 + 24 字长名称：载入 / 切换 / 改变宽度后当前空间都在可见区；省略号 + title / aria-label
  modes       软键盘模拟 + 命令面板、编辑模式、经典外观、纯静态模式
  measure     每个底栏按钮 / 空间分段的命中区（≥44×44）、彼此不重叠、elementFromPoint 落在自己身上；
              左右按钮不压住滚动区；当前分段完全在滚动区可见范围内；指示条与当前分段对齐
  perf        手机 390 CPU 4× 切换空间的长任务 / 帧间隔
  rec         约 12 秒录屏（切换 + 滚动 + 多空间）→ mp4
结果写到 <输出目录>/results-<前缀><命令>.json；任何断言失败时退出码 1。
"""
import sys, os, json, io, base64, subprocess, shutil
sys.path.insert(0, '/workspace/work/.tools/py')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from stage3_env import Env

R = '/workspace/work/.tools/root'
CMD = sys.argv[1]; OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/dock'; PFX = sys.argv[3] if len(sys.argv) > 3 else ''
os.makedirs(OUT, exist_ok=True)
res = {'cmd': CMD, 'errors': [], 'console': [], 'checks': {}, 'fails': [], 'shots': []}
SPACES = [('all', '全部'), ('s-daily', '日常'), ('s-fun', '娱乐'), ('s-nas', 'NAS')]
BRIGHT = 'https://bright-wallpaper.test/w.jpg'

def bright_jpg():
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (900, 1600), (250, 246, 236)); d = ImageDraw.Draw(im)
    for y in range(0, 1600, 8): d.line([(0, y), (900, y)], fill=(255, 250 - y // 40, 225 + y // 60))
    for i in range(14): d.ellipse([i * 70 - 60, 1100 + (i % 3) * 90, i * 70 + 140, 1300 + (i % 3) * 90], fill=(255, 255, 255))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=88); return b.getvalue()

def launch(p):
    return p.chromium.launch(executable_path=f'{R}/usr/lib/chromium/chromium', args=['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
                             env=dict(os.environ, LD_LIBRARY_PATH=f'{R}/usr/lib/aarch64-linux-gnu:{R}/usr/lib/chromium'))

KBD_SIM = """(function(){ var vv = window.visualViewport; if (!vv) return; window.__vvh = 0;
  Object.defineProperty(vv, 'height', { configurable: true, get: function(){ return window.__vvh || window.innerHeight; } });
  window.__kb = function(h){ window.__vvh = h ? window.innerHeight - h : 0; vv.dispatchEvent(new Event('resize'));
    var k = document.getElementById('__kbd'); if (!h) { if (k) k.remove(); return; }
    if (!k) { k = document.createElement('div'); k.id = '__kbd'; document.documentElement.appendChild(k); }
    k.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:' + h + 'px;z-index:2147483647;background:linear-gradient(#2b2d33,#1d1f24);color:#8b8f99;font:13px/1 sans-serif;display:grid;place-items:center;pointer-events:none';
    k.textContent = '（模拟软键盘区域：visualViewport 缩小 ' + h + 'px）'; }; })();"""

def page(b, env, w, h, space=None, mobile=True, ui=None, static=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile,
                        locale='zh-CN', timezone_id='Asia/Shanghai')
    ctx.route(BRIGHT, lambda r: r.fulfill(status=200, content_type='image/jpeg', body=bright_jpg()))
    if not static: ctx.add_cookies(env.cookies_for())
    st = {}
    if space: st['nocturne.space:admin' if not static else 'nocturne.space:~local'] = space
    if ui: st['nocturne.ui'] = ui
    if static:
        cfg = json.loads(json.dumps(env.config))
        for g in cfg['groups']:
            for i in g['items']:
                if i['icon'].get('type') == 'image': i['icon'] = {'type': 'emoji', 'value': '🧭', 'bg': ''}
        st['yeqv.v1'] = json.dumps(cfg)
    ctx.add_init_script(KBD_SIM)
    ctx.add_init_script("(function(s){ if (!sessionStorage.getItem('nc-seeded')) { for (var k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem('nc-seeded','1'); } })(%s);" % json.dumps(st))
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: res['errors'].append(f'{w}x{h}: {e}'))
    pg.on('console', lambda m: res['console'].append(f'{w}x{h} {m.type}: {m.text}') if m.type in ('error', 'warning') and 'Failed to load resource' not in m.text else None)
    pg.goto(env.static_url if static else env.base + '/')
    pg.wait_for_function('document.documentElement.classList.contains("mn-done")', timeout=8000)
    pg.wait_for_timeout(450)
    return ctx, pg

def shot(pg, name):
    path = os.path.join(OUT, PFX + name + '.png'); pg.screenshot(path=path); res['shots'].append(path); return path

def select(pg, sid, tap=False):
    if tap: pg.locator('.x-sp[data-space="%s"]:visible' % sid).first.tap()
    else: pg.evaluate('id => App.spaces.select(id)', sid)
    pg.wait_for_timeout(800)

def put_config(env, mutate):
    _, cur = env._req('GET', 'config', cookie=env.cookie)
    data = json.loads(json.dumps(cur.get('data') or env.config)); mutate(data)
    env._req('PUT', 'config', {'baseVersion': cur.get('version', 0), 'data': data, 'caps': ['spaces', 'spaces:2']}, cookie=env.cookie)

LONG = ['影音娱乐中心', '家庭相册与备份', '工作', '学习资料', '下载管理器', '智能家居全屋控制面板', '监控', '网络',
        '一个特别特别长的空间名称用来测试省略号显示', '开发', '游戏']  # + 全部 = 12

def many_mutate(data):
    gids = [g['id'] for g in data['groups']]
    data['spaces'] = [{'id': 's-m%d' % i, 'name': n, 'groupIds': [gids[i % len(gids)]]} for i, n in enumerate(LONG)]

def fail(msg):
    res['fails'].append(msg)

# ---------------------------------------------------------------- 测量（所有断言都在这里）
MEASURE_JS = r"""() => {
  const dock = document.querySelector('.x-dock'); if (!dock || getComputedStyle(dock).display === 'none') return { dock: false };
  const vis = e => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const R = e => { const r = e.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) }; };
  const region = dock.querySelector('.x-spaces'), track = dock.querySelector('.x-sp-track');
  const btns = [...dock.children].filter(e => e.tagName === 'BUTTON' && vis(e));
  const out = { dock: true, dockBox: R(dock), buttons: [], chips: [], problems: [] };
  btns.forEach(b => { const r = R(b); const cx = r.x + r.w / 2, cy = r.y + r.h / 2; const hit = document.elementFromPoint(cx, cy);
    out.buttons.push({ label: b.getAttribute('aria-label') || b.textContent.trim(), ...r, hitOk: !!hit && (hit === b || b.contains(hit)) }); });
  if (region && vis(region) && track) {
    const rr = R(region), tr = R(track); out.region = rr; out.track = tr;
    out.scroll = { left: Math.round(track.scrollLeft), max: track.scrollWidth - track.clientWidth };
    const cs = getComputedStyle(track); out.mask = cs.webkitMaskImage || cs.maskImage; out.trackClass = track.className;
    btns.forEach(b => { const r = R(b); if (r.r > rr.x + 0.5 && r.x < rr.r - 0.5) out.problems.push('按钮「' + (b.getAttribute('aria-label') || b.textContent.trim()) + '」与空间滚动区重叠'); });
    track.querySelectorAll('.x-sp').forEach(c => { const r = R(c); const cur = c.getAttribute('aria-current') === 'true';
      const inView = r.x >= tr.x - 0.5 && r.r <= tr.r + 0.5; const cx = Math.min(Math.max(r.x + r.w / 2, tr.x + 2), tr.r - 2), cy = r.y + r.h / 2;
      const hit = inView || (r.r > tr.x && r.x < tr.r) ? document.elementFromPoint(cx, cy) : null;
      const span = c.querySelector('span');
      out.chips.push({ id: c.dataset.space, name: span && span.textContent, cur, ...r, inView, hitOk: hit ? (hit === c || c.contains(hit)) : null,
        aria: c.getAttribute('aria-label'), title: c.getAttribute('title'), truncated: span ? span.scrollWidth > span.clientWidth + 1 : false }); });
    const cur = out.chips.find(c => c.cur);
    if (!cur) out.problems.push('没有当前分段'); else if (!cur.inView) out.problems.push('当前分段不在滚动区可见范围内');
    if (out.chips.length <= 4 && innerWidth >= 375 && innerWidth < 768 && out.chips.some(c => !c.inView)) out.problems.push('≥375 宽 4 个空间却有分段被藏住：' + out.chips.filter(c => !c.inView).map(c => c.name).join('、'));
    const ind = track.querySelector('.mn-ind');
    if (ind && cur) { const ir = R(ind); out.ind = ir; if (Math.abs(ir.x - cur.x) > 1.5 || Math.abs(ir.w - cur.w) > 1.5) out.problems.push('指示条没有对齐当前分段 ' + JSON.stringify([ir.x, ir.w, cur.x, cur.w])); }
  }
  const all = out.buttons.map(b => ({ n: b.label, ...b })).concat(out.chips.filter(c => c.inView).map(c => ({ n: c.name, ...c })));
  all.forEach(t => { if (t.w < 43.5 || t.h < 43.5) out.problems.push('命中区小于 44×44：' + t.n + ' ' + t.w + '×' + t.h); if (t.hitOk === false) out.problems.push('elementFromPoint 没落在「' + t.n + '」上'); });
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const a = all[i], b = all[j];
    const ox = Math.min(a.r, b.r) - Math.max(a.x, b.x), oy = Math.min(a.b, b.b) - Math.max(a.y, b.y); if (ox > 0.5 && oy > 0.5) out.problems.push('重叠：' + a.n + ' / ' + b.n); }
  out.pageScroll = Math.round(scrollY);
  return out; }"""

def measure(pg, tag):
    m = pg.evaluate(MEASURE_JS); res['checks'].setdefault('measure', {})[tag] = m
    for p in m.get('problems', []): fail(tag + ': ' + p)
    return m

def run(fn, static_cfg=None):
    with Env() as env, sync_playwright() as p:
        b = launch(p)
        try: fn(b, env)
        finally: b.close()
    res['ok'] = not res['fails'] and not res['errors']
    json.dump(res, open(os.path.join(OUT, f'results-{PFX}{CMD}.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({'ok': res['ok'], 'fails': res['fails'][:40], 'errors': res['errors'][:10], 'console': res['console'][:10], 'shots': len(res['shots'])}, ensure_ascii=False, indent=1))
    sys.exit(0 if res['ok'] else 1)

# ---------------------------------------------------------------- 子命令
def shots(b, env):
    for w, h in [(320, 640), (375, 812), (390, 844), (430, 932)]:
        ctx, pg = page(b, env, w, h)
        for sid, n in SPACES:
            select(pg, sid, tap=True); measure(pg, 'p%d-%s' % (w, sid)); shot(pg, 'm%d-%s' % (w, sid))
        ctx.close()
    for w, h in [(844, 390), (667, 375)]:
        ctx, pg = page(b, env, w, h)
        for sid, n in SPACES:
            select(pg, sid, tap=True); measure(pg, 'l%d-%s' % (w, sid))
        shot(pg, 'l%dx%d-nas' % (w, h)); select(pg, 'all', tap=True); shot(pg, 'l%dx%d-all' % (w, h)); ctx.close()

def bottom(b, env):
    for wp in ('star', 'bright'):
        if wp == 'bright': put_config(env, lambda d: d['settings'].__setitem__('wallpaper', {'id': 'custom', 'url': BRIGHT, 'dim': 0, 'blur': 0}))
        for w, h in [(390, 844), (320, 640)]:
            ctx, pg = page(b, env, w, h)
            for sid in ('s-nas', 'all', 's-fun'):
                select(pg, sid, tap=True)
                for frac, nm in ((0.45, 'mid'), (1.0, 'bottom')):
                    pg.evaluate('f => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f)', frac); pg.wait_for_timeout(350)
                    measure(pg, '%s-%d-%s-%s' % (wp, w, sid, nm))
                    if w == 390 or nm == 'bottom': shot(pg, 'scroll-%s-m%d-%s-%s' % (wp, w, sid, nm))
            # 最后一张卡不被底栏挡住
            res['checks']['last_clear_%s_%d' % (wp, w)] = pg.evaluate("""() => { const d = document.querySelector('.x-dock').getBoundingClientRect(); const els = [...document.querySelectorAll('#x-groups .x-tile, #x-groups .x-chip, .x-side .x-card')].filter(e => e.offsetParent);
              const last = Math.max(...els.map(e => e.getBoundingClientRect().bottom)); return { lastBottom: Math.round(last), dockTop: Math.round(d.top) }; }""")
            c = res['checks']['last_clear_%s_%d' % (wp, w)]
            if c['lastBottom'] > c['dockTop']: fail('滚到底部后最后的内容被底栏挡住 %s %d' % (wp, w))
            ctx.close()

def many(b, env):
    put_config(env, many_mutate)
    for w, h in [(390, 844), (320, 640), (430, 932)]:
        ctx, pg = page(b, env, w, h, space='s-m8')
        measure(pg, 'many-%d-load-long' % w); shot(pg, 'many-m%d-load-long' % w)
        for sid in ('s-m10', 'all', 's-m5'):
            pg.evaluate('id => App.spaces.select(id)', sid); pg.wait_for_timeout(800); measure(pg, 'many-%d-%s' % (w, sid))
        shot(pg, 'many-m%d-s-m5' % w)
        # 用户手动把滚动区滑到最左，再切到最后一个：自动滚到可见
        pg.evaluate("document.querySelector('.x-dock .x-sp-track').scrollLeft = 0"); pg.wait_for_timeout(200)
        pg.evaluate('App.spaces.select("s-m10")'); pg.wait_for_timeout(800); measure(pg, 'many-%d-after-manual-scroll' % w)
        y0 = pg.evaluate('scrollY')
        pg.evaluate('scrollTo(0, 600)'); pg.wait_for_timeout(200); y1 = pg.evaluate('scrollY')
        pg.evaluate('App.spaces.select("s-m2")'); pg.wait_for_timeout(800)
        m = measure(pg, 'many-%d-switch-while-scrolled' % w)
        res['checks']['many_%d_page_scroll' % w] = {'before': y1, 'after': m.get('pageScroll')}
        ctx.close()
    # 改变宽度（旋转）：当前空间仍在可见区
    ctx, pg = page(b, env, 430, 932, space='s-m9')
    pg.set_viewport_size({'width': 320, 'height': 640}); pg.wait_for_timeout(600); measure(pg, 'many-resize-430-320'); shot(pg, 'many-resize-320')
    pg.set_viewport_size({'width': 667, 'height': 375}); pg.wait_for_timeout(600); measure(pg, 'many-resize-667x375'); shot(pg, 'many-resize-667x375')
    m = pg.evaluate("""() => { const c = document.querySelector('.x-dock .x-sp[data-space="s-m8"]'); const s = c.querySelector('span'); return { title: c.title, aria: c.getAttribute('aria-label'), truncated: s.scrollWidth > s.clientWidth + 1, w: Math.round(c.getBoundingClientRect().width) }; }""")
    res['checks']['long_name'] = m
    if LONG[8] not in (m['title'] or '') or LONG[8] not in (m['aria'] or '') or not m['truncated']: fail('长名称没有省略号或缺少完整名称 ' + json.dumps(m, ensure_ascii=False))
    ctx.close()

def modes(b, env):
    ctx, pg = page(b, env, 390, 844, space='s-nas')
    pg.tap('.x-dock .x-dk-pal'); pg.wait_for_timeout(300); pg.evaluate('__kb(336)'); pg.wait_for_timeout(500)
    res['checks']['kb'] = pg.evaluate("""() => ({ kb: document.documentElement.classList.contains('mn-kb'), dockOpacity: getComputedStyle(document.querySelector('.x-dock')).opacity,
      scrim: (() => { const s = document.querySelector('.mn-dockscrim'); return s ? getComputedStyle(s).opacity : null; })(), focus: document.activeElement && document.activeElement.tagName })""")
    k = res['checks']['kb']
    if not k['kb'] or float(k['dockOpacity']) > 0.05 or (k['scrim'] is not None and float(k['scrim']) > 0.05): fail('软键盘弹出时底栏 / 底部遮罩没有收起 ' + json.dumps(k))
    shot(pg, 'kb-palette'); pg.evaluate('__kb(0)'); pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
    measure(pg, 'after-kb')
    pg.evaluate('App.emit("edit", {})'); pg.wait_for_timeout(600); shot(pg, 'edit-mode')
    res['checks']['edit'] = pg.evaluate("""() => ({ ebar: !!document.querySelector('.x-ebar') && getComputedStyle(document.querySelector('.x-ebar')).display !== 'none', dock: getComputedStyle(document.querySelector('.x-dock')).display })""")
    e = res['checks']['edit']
    if not e['ebar'] or e['dock'] != 'none': fail('编辑模式下底栏没有被编辑栏替换 ' + json.dumps(e))
    pg.evaluate('App.emit("done", {})'); ctx.close()
    for w in (390, 320):
        ctx, pg = page(b, env, w, 844 if w == 390 else 640, space='s-nas', ui='classic'); shot(pg, 'classic-m%d-nas' % w)
        res['checks']['classic_%d' % w] = pg.evaluate("""() => ({ ui: document.documentElement.dataset.ui, scrim: (() => { const s = document.querySelector('.mn-dockscrim'); return s ? getComputedStyle(s).display : 'absent'; })(),
          merged: document.body.classList.contains('mn-merged'), navInDock: !!document.querySelector('.x-dock .x-spaces'), spacesFixed: getComputedStyle(document.querySelector('.x-spaces')).position })""")
        c = res['checks']['classic_%d' % w]
        if c['merged'] or c['navInDock'] or c['scrim'] not in ('none', 'absent'): fail('经典外观受到新版底栏影响 ' + json.dumps(c))
        ctx.close()
    ctx, pg = page(b, env, 1440, 900, mobile=False); res['checks']['desktop_scrim'] = pg.evaluate("(() => { const s = document.querySelector('.mn-dockscrim'); return s ? getComputedStyle(s).display : 'absent'; })()")
    if res['checks']['desktop_scrim'] not in ('none', 'absent'): fail('桌面出现底部遮罩')
    shot(pg, 'desktop-1440-all'); ctx.close()
    ctx, pg = page(b, env, 390, 844, static=True)
    for sid, n in SPACES: select(pg, sid, tap=True); measure(pg, 'static-' + sid)
    shot(pg, 'static-m390-nas'); ctx.close()

def measure_cmd(b, env):
    for w, h in [(320, 640), (375, 812), (390, 844), (430, 932), (844, 390), (667, 375)]:
        ctx, pg = page(b, env, w, h)
        for sid, n in SPACES: select(pg, sid, tap=True); measure(pg, 'm-%dx%d-%s' % (w, h, sid))
        ctx.close()
    put_config(env, many_mutate)
    for w, h in [(320, 640), (390, 844)]:
        ctx, pg = page(b, env, w, h, space='s-m10')
        for sid in ('s-m10', 'all', 's-m8', 's-m4'): select(pg, sid); measure(pg, 'm-many-%d-%s' % (w, sid))
        ctx.close()
    # 汇总
    mins = {}
    for tag, m in res['checks']['measure'].items():
        for t in m.get('buttons', []) + [c for c in m.get('chips', []) if c['inView']]:
            k = t.get('label') or t.get('name'); mn = mins.setdefault(k, [999, 999]); mn[0] = min(mn[0], t['w']); mn[1] = min(mn[1], t['h'])
    res['checks']['min_target_by_label'] = mins

def perf(b, env):
    ctx, pg = page(b, env, 390, 844)
    cdp = ctx.new_cdp_session(pg); cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    out = []
    for sid in ['s-daily', 's-fun', 's-nas', 'all', 's-fun', 's-nas']:
        pg.evaluate("""() => { window.__lt = []; window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))); window.__po.observe({ type: 'longtask' });
          window.__fr = []; let last = performance.now(), n = 0; const step = (t) => { window.__fr.push(t - last); last = t; if (++n < 60) requestAnimationFrame(step); }; requestAnimationFrame(step); }""")
        t = pg.evaluate('id => { const t0 = performance.now(); App.spaces.select(id); return performance.now() - t0; }', sid)
        pg.wait_for_timeout(1600)
        r = pg.evaluate("""() => { const f = window.__fr.slice(1).sort((a, b) => a - b); return { p50: Math.round(f[Math.floor(f.length * .5)]), p95: Math.round(f[Math.floor(f.length * .95)]), max: Math.round(f[f.length - 1]), longtasks: window.__lt }; }""")
        r['sync_ms'] = round(t, 1); r['to'] = sid; out.append(r)
    res['checks']['switch_mobile_cpu4x'] = out
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1}); ctx.close()

class Cast:
    def __init__(self, ctx, pg, name, w, h):
        self.dir = os.path.join(OUT, '.cast-' + name); shutil.rmtree(self.dir, ignore_errors=True); os.makedirs(self.dir)
        self.frames, self.name, self.cdp = [], name, ctx.new_cdp_session(pg)
        self.cdp.on('Page.screencastFrame', self.on)
        self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 88, 'maxWidth': w, 'maxHeight': h, 'everyNthFrame': 1})
    def on(self, e):
        path = os.path.join(self.dir, '%05d.jpg' % len(self.frames)); open(path, 'wb').write(base64.b64decode(e['data'])); self.frames.append((path, e['metadata']['timestamp']))
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
        out = os.path.join(OUT, PFX + self.name + '.mp4')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', out], check=True)
        res['checks'][self.name] = {'frames': len(self.frames), 'seconds': round(self.frames[-1][1] - self.frames[0][1], 2), 'file': out}
        shutil.rmtree(self.dir, ignore_errors=True)

def rec(b, env):
    ctx, pg = page(b, env, 390, 844); cast = Cast(ctx, pg, 'dock-mobile', 780, 1688)
    pg.wait_for_timeout(500)
    for sid in ['s-daily', 's-fun', 's-nas', 'all', 's-nas']:
        pg.tap('.x-dock .x-sp[data-space="%s"]' % sid); pg.wait_for_timeout(900)
    for y in range(0, 1400, 70): pg.mouse.wheel(0, 70); pg.wait_for_timeout(45)
    pg.wait_for_timeout(500)
    put_config(env, many_mutate); pg.reload(); pg.wait_for_function('document.documentElement.classList.contains("mn-done")', timeout=8000)
    pg.evaluate('App.spaces.select("s-m8")'); pg.wait_for_timeout(1000)
    for sid in ['s-m10', 'all', 's-m5', 's-m2']:
        pg.evaluate('id => App.spaces.select(id)', sid); pg.wait_for_timeout(900)
    tr = pg.locator('.x-dock .x-sp-track').bounding_box()
    for i in range(10): pg.evaluate("document.querySelector('.x-dock .x-sp-track').scrollBy(28, 0)"); pg.wait_for_timeout(40)
    pg.wait_for_timeout(600)
    cast.stop(pg); ctx.close()

CMDS = {'shots': shots, 'bottom': bottom, 'many': many, 'modes': modes, 'measure': measure_cmd, 'perf': perf, 'rec': rec}
if __name__ == '__main__':
    run(CMDS[CMD])
