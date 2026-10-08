#!/usr/bin/env python3
"""V2.0 阶段 2 实测：Chromium（headless，Linux arm64）打开纯静态页（python http.server），种入 V1.1 样例配置 + 3 个空间，
截图切换器 / 管理空间 / 空空间，并做 375–1920 横向溢出检查与键盘操作检查。用法：stage2_shots.py <输出目录>"""
import sys, os, json, subprocess, time, socket
sys.path.insert(0, '/workspace/work/.tools/py')
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/shots'
os.makedirs(OUT, exist_ok=True)
R = '/workspace/work/.tools/root'
fix = json.load(open(os.path.join(ROOT, 'test/fixtures/v1.1-config.json')))
fix['spacesVersion'] = 1
fix['spaces'] = [
    {"id": "s-daily", "name": "日常", "groupIds": ["chips00daily"], "itemIds": ["syn920plus"]},
    {"id": "s-fun", "name": "娱乐", "groupIds": ["mzq1a0lq8x2", "dl92kfa0q1z"]},
    {"id": "s-nas", "name": "NAS", "groupIds": ["st0rage9kq2"]},
    {"id": "s-empty", "name": "新空间", "groupIds": []},
]
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=os.path.join(ROOT, 'public'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
URL = f'http://127.0.0.1:{port}/index.html'
res = {"errors": [], "overflow": {}, "checks": {}}
def seed(page, sel):
    page.add_init_script("""(function(d,sel){ if (!sessionStorage.getItem('seeded')) { localStorage.clear(); localStorage.setItem('yeqv.v1', d); if (sel) localStorage.setItem('nocturne.space:~local', sel); sessionStorage.setItem('seeded','1'); } })(%s, %s);""" % (json.dumps(json.dumps(fix)), json.dumps(sel)))
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=f'{R}/usr/lib/chromium/chromium', args=['--no-sandbox', '--disable-gpu'], env=dict(os.environ, LD_LIBRARY_PATH=f'{R}/usr/lib/aarch64-linux-gnu:{R}/usr/lib/chromium'))
        def newpage(w, h, sel=None, mobile=False, reduce=True):
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, reduced_motion='reduce' if reduce else 'no-preference')
            pg = ctx.new_page(); seed(pg, sel)
            pg.on('pageerror', lambda e: res['errors'].append(f'{w}x{h}: {e}'))
            # console 404 (字体子集 / favicon) 与探测请求失败不算页面错误；只记未捕获异常
            pg.goto(URL); pg.wait_for_timeout(700)
            return ctx, pg
        # 1) mobile 390x844: switcher on 娱乐
        ctx, pg = newpage(390, 844, 's-fun', mobile=True)
        pg.screenshot(path=f'{OUT}/m390-switcher-fun.png')
        res['checks']['m390_current'] = pg.eval_on_selector('.x-sp[aria-current=true]', 'e => e.textContent')
        res['checks']['m390_groups'] = pg.eval_on_selector_all('#x-groups .x-group', 'els => els.map(e => e.getAttribute("aria-label"))')
        bb = pg.eval_on_selector('.x-spaces', 'e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; }')
        dock = pg.eval_on_selector('.x-dock', 'e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; }')
        res['checks']['m390_switcher_above_dock'] = bb[1] <= dock[0]
        # tap NAS
        pg.click('.x-sp[data-space="s-nas"]'); pg.wait_for_timeout(300)
        res['checks']['m390_after_tap'] = pg.eval_on_selector_all('#x-groups .x-group', 'els => els.map(e => e.getAttribute("aria-label"))')
        # manage sheet
        pg.click('.x-sp-manage'); pg.wait_for_timeout(450)
        pg.screenshot(path=f'{OUT}/m390-manage-sheet.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(350)
        # empty space
        pg.click('.x-sp[data-space="s-empty"]'); pg.wait_for_timeout(300)
        pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(100)
        pg.screenshot(path=f'{OUT}/m390-empty-space.png')
        res['checks']['m390_empty_cta'] = pg.eval_on_selector('.x-sempty-cta', 'e => e.textContent')
        pg.click('.x-sempty-cta'); pg.wait_for_timeout(450)
        res['checks']['m390_cta_opens_expanded'] = pg.eval_on_selector('.x-spm', 'e => !e.hidden && !!e.querySelector("[data-ed=s-empty]")')
        pg.screenshot(path=f'{OUT}/m390-empty-cta-sheet.png')
        ctx.close()
        # 2) desktop 1440x900
        ctx, pg = newpage(1440, 900, 's-nas')
        pg.screenshot(path=f'{OUT}/d1440-switcher-nas.png')
        res['checks']['d1440_status_title'] = pg.eval_on_selector('.x-side .x-card h2', 'e => e.textContent')
        # keyboard: focus current, ArrowLeft x3 → 全部? (roving) then Enter
        pg.focus('.x-sp[aria-current=true]'); pg.keyboard.press('Home'); pg.keyboard.press('Enter'); pg.wait_for_timeout(250)
        res['checks']['d1440_kbd_home_enter'] = pg.eval_on_selector('.x-sp[aria-current=true]', 'e => e.dataset.space')
        pg.keyboard.press('Alt+3'); pg.wait_for_timeout(250)
        res['checks']['d1440_alt3'] = pg.eval_on_selector('.x-sp[aria-current=true]', 'e => e.dataset.space')
        pg.screenshot(path=f'{OUT}/d1440-switcher-fun.png')
        pg.click('.x-sp-manage'); pg.wait_for_timeout(450)
        pg.screenshot(path=f'{OUT}/d1440-manage-sheet.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        pg.click('.x-sp[data-space="s-empty"]'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'{OUT}/d1440-empty-space.png')
        # palette cross-space search while in empty space
        pg.keyboard.press('Control+k'); pg.wait_for_timeout(250); pg.keyboard.type('emby'); pg.wait_for_timeout(200)
        res['checks']['d1440_palette_first'] = pg.eval_on_selector('.x-cmdk-row', 'e => e.textContent')
        pg.screenshot(path=f'{OUT}/d1440-palette-cross-space.png')
        pg.keyboard.press('Escape')
        ctx.close()
        # 3) overflow 375–1920 in three states (全部, 娱乐, manage open)
        for w in [375, 390, 430, 768, 820, 1024, 1280, 1440, 1920]:
            h = 844 if w < 768 else 900
            ctx, pg = newpage(w, h, 's-fun', mobile=w < 768)
            o1 = pg.evaluate('document.documentElement.scrollWidth - innerWidth')
            pg.click('.x-sp-manage'); pg.wait_for_timeout(400)
            o2 = pg.evaluate('document.documentElement.scrollWidth - innerWidth')
            o3 = pg.eval_on_selector('.x-spm', 'e => e.scrollWidth - e.clientWidth')
            res['overflow'][w] = [o1, o2, o3]
            ctx.close()
        b.close()
finally:
    srv.terminate()
print(json.dumps(res, ensure_ascii=False, indent=1))
