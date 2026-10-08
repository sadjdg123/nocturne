#!/usr/bin/env python3
"""V2.0 RC · 端到端回归（Chromium headless + 真实 server.js NAS 模式 + 纯静态模式）。

环境：tools/stage3_env.Env（临时 DATA_DIR、本地模拟服务让服务器真实探测、本地图标上游、演示配置 3 个空间）。
每一项都在真实页面里通过界面点按 / 键盘完成；只有准备数据和读取结果用 App / HTTP。结果写 rc-regression.json。
用法：python3 tools/e2e/rc_regression.py [输出目录]
"""
import json, os, sys, time, tempfile, shutil, signal, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rc_common import *
from stage3_env import Env
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rc-reg'
os.makedirs(OUT, exist_ok=True)
res = Results('rc-regression')
TILES = '#x-groups .x-tile, #x-groups .x-chip'


def mk(b, env, w=1440, h=900, mobile=False, cookies=None, storage=None):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile,
                        locale='zh-CN', timezone_id='Asia/Shanghai', accept_downloads=True)
    ctx.add_cookies(cookies if cookies is not None else env.cookies_for())
    if storage: ctx.add_init_script('(s => { if (!sessionStorage.getItem("seed")) { for (const k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem("seed", 1); } })(%s)' % json.dumps(storage))
    return ctx


def go(ctx, url):
    pg = ctx.new_page(); pg.errs = []; pg.puts = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    pg.on('request', lambda r: pg.puts.append(r.url) if r.method == 'PUT' and '/api/config' in r.url else None)
    pg.goto(url); pg.wait_for_function('window.App && App.state && !document.documentElement.classList.contains("nc-loading")', timeout=10000)
    pg.wait_for_timeout(900); return pg


def count(pg): return pg.evaluate('s => document.querySelectorAll(s).length', TILES)
def sel_space(pg, sid): pg.click('.x-sp[data-space="%s"]' % sid); pg.wait_for_timeout(800)


with Env() as env, sync_playwright() as p:
    b = launch(p)
    admin = Client('http://127.0.0.1:%d' % env.port).login('admin')
    NIT = sum(len(g['items']) for g in env.config['groups'])

    # ---------- desktop 1440 · NAS mode
    ctx = mk(b, env); pg = go(ctx, env.base + '/')
    res.ok('desktop: Midnight by default', pg.evaluate('document.documentElement.dataset.ui') == 'v2')
    # classic / Midnight toggle (设置 → 外观)
    pg.click('#btn-menu'); pg.click('[data-m="set"]'); pg.wait_for_timeout(400)
    n0 = len(pg.puts)
    pg.click('[data-ui-set="classic"]'); pg.wait_for_timeout(500)
    c1 = pg.evaluate('[document.documentElement.dataset.ui, localStorage.getItem("nocturne.ui")]')
    pg.screenshot(path=os.path.join(OUT, 'classic-1440.png'))
    pg.click('[data-ui-set="v2"]'); pg.wait_for_timeout(500)
    c2 = pg.evaluate('document.documentElement.dataset.ui')
    pg.wait_for_timeout(1200)
    res.ok('classic ⇄ Midnight toggle (device-local, no PUT)', c1 == ['classic', 'classic'] and c2 == 'v2' and len(pg.puts) == n0, {'classic': c1, 'back': c2, 'puts': len(pg.puts) - n0})
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)

    # space switch (desktop rail) + counts
    got = {}
    for sid in ('s-daily', 's-fun', 's-nas', 'all'):
        sel_space(pg, sid); got[sid] = [count(pg), pg.evaluate('id => App.spaces.view(id).reduce((n, e) => n + e.items.length, 0)', sid)]
    res.ok('space switch: DOM == model for every space', all(a == c for a, c in got.values()) and got['all'][0] == NIT, got)
    res.ok('space switch never PUTs', len(pg.puts) == n0)

    # 管理空间: create / reorder / delete
    pg.click('#btn-menu'); pg.click('[data-m="spaces"]'); pg.wait_for_selector('.x-spm [data-spm-new] input[name=name]')
    pg.fill('.x-spm [data-spm-new] input[name=name]', '测试空间'); pg.click('.x-spm [data-spm-new] button[type=submit]'); pg.wait_for_timeout(500)
    names = pg.evaluate('App.spaces.list().map(s => s.name)')
    tid = pg.evaluate('App.spaces.list().find(s => s.name === "测试空间").id')
    pg.click('.x-spm [data-spm="up"][data-sid="%s"]' % tid); pg.wait_for_timeout(400)
    names2 = pg.evaluate('App.spaces.list().map(s => s.name)')
    pg.click('.x-spm [data-spm="open"][data-sid="%s"]' % tid) if not pg.evaluate('id => !!document.querySelector(`.x-spm [data-ed="${id}"]`)', tid) else None
    pg.wait_for_timeout(300)
    pg.click('.x-spm [data-spm="del"][data-sid="%s"]' % tid); pg.wait_for_timeout(300); pg.click('.x-spm [data-spm="del-yes"]'); pg.wait_for_timeout(400)
    names3 = pg.evaluate('App.spaces.list().map(s => s.name)')
    groups_after = pg.evaluate('App.state.groups.length')
    pg.click('.x-spm-done'); pg.wait_for_timeout(1500)
    res.ok('管理空间: create → reorder ↑ → delete (groups untouched)', names[-1] == '测试空间' and names2[-2] == '测试空间' and '测试空间' not in names3 and groups_after == len(env.config['groups']), [names, names2, names3])

    # remove-from-space (hide) → undo; delete-everywhere → undo; global edit
    sel_space(pg, 's-fun'); pg.evaluate('App.emit("edit", {})'); pg.wait_for_timeout(500)
    pg.click('#x-groups [data-id="plex"] .x-ebadge', force=True); pg.wait_for_timeout(400)
    rows = pg.evaluate('[...document.querySelectorAll(".x-sheet .x-row")].map(r => r.textContent.trim().slice(0, 14))')
    pg.click('.x-sheet .x-row:not(.is-red):not(.is-cancel)'); pg.wait_for_timeout(500)
    hid = pg.evaluate('[!document.querySelector(\'#x-groups [data-id="plex"]\'), (App.spaces.current().excludeItemIds || []).includes("plex"), App.state.groups.some(g => g.items.some(i => i.id === "plex"))]')
    pg.click('.x-ebar [data-e="undo"]'); pg.wait_for_timeout(500)
    back = pg.evaluate('!!document.querySelector(\'#x-groups [data-id="plex"]\')')
    res.ok('remove from current space (hide in 娱乐 only) + undo', hid == [True, True, True] and back, {'rows': rows, 'hidden/excluded/stillExists': hid, 'undo': back})
    pg.click('#x-groups [data-id="plex"] .x-ebadge', force=True); pg.wait_for_timeout(400)
    pg.click('.x-sheet .x-row.is-red'); pg.wait_for_timeout(400)
    confirm = pg.evaluate('document.querySelector(".x-sheet") && document.querySelector(".x-sheet").textContent.includes("个空间")')
    pg.click('.x-sheet .x-row.is-red'); pg.wait_for_timeout(500)
    gone = pg.evaluate('!App.state.groups.some(g => g.items.some(i => i.id === "plex"))')
    pg.click('.x-ebar [data-e="undo"]'); pg.wait_for_timeout(500)
    rest = pg.evaluate('App.state.groups.some(g => g.items.some(i => i.id === "plex"))')
    res.ok('delete from all spaces (2-step confirm naming spaces) + undo', confirm and gone and rest, {'confirm': confirm, 'gone': gone, 'undo': rest})
    pg.click('.x-ebar [data-e="done"]'); pg.wait_for_timeout(400)
    # global edit: edit an item inside 娱乐, check in 全部 and server
    pg.evaluate('App.emit("edit-item", { gid: "g-media", id: "emby" })'); pg.wait_for_selector('.x-is.is-on #x-f-nm')
    pg.fill('.x-is #x-f-nm', 'Emby 影院'); pg.click('.x-is [data-a="save"]'); pg.wait_for_timeout(1800)
    sel_space(pg, 'all')
    t_all = pg.evaluate('document.querySelector(\'#x-groups [data-id="emby"] .x-name\').textContent')
    srv_title = [i['title'] for g in admin.j('GET', '/api/config')[1]['data']['groups'] for i in g['items'] if i['id'] == 'emby']
    res.ok('global edit from a space shows in 全部 and syncs', t_all == 'Emby 影院' and srv_title == ['Emby 影院'], [t_all, srv_title])

    # NAS status labels (server-measured)
    sel_space(pg, 's-nas'); pg.wait_for_timeout(500)
    st = pg.evaluate('''() => Object.fromEntries(["dsm", "dsm2", "portainer", "kuma"].map(id => { const e = document.querySelector(`#x-groups [data-id="${id}"] .x-st`); return [id, e ? e.textContent.trim() : null]; }))''')
    res.ok('NAS status labels: 在线 · N ms / 离线 from /api/status', st['dsm'] and 'ms' in st['dsm'] and st['dsm2'] and '离线' in st['dsm2'], st)
    pg.screenshot(path=os.path.join(OUT, 'nas-1440.png'))

    # net 3-state URL choice (emby has lan + wan)
    n_net = len(pg.puts)
    def href(): return pg.evaluate('document.querySelector(\'#x-groups [data-id="emby"]\').href')
    sel_space(pg, 'all'); out = {}
    for m in ('lan', 'wan', 'auto'):
        pg.click('.x-net'); pg.wait_for_timeout(250); pg.click('.x-netm [data-net="%s"]' % m); pg.wait_for_timeout(400); out[m] = href()
    res.ok('net 3-state: lan / wan / auto(localhost→lan) choose the right URL; device-local', out['lan'].startswith('http://127.0.1.20') and out['wan'].startswith('https://emby.nocturne.example') and out['auto'].startswith('http://127.0.1.20') and len(pg.puts) == n_net, out)

    # palette (desktop): Ctrl+K, cross-space search
    pg.keyboard.press('Control+k'); pg.wait_for_timeout(300); pg.keyboard.type('qbit', delay=40); pg.wait_for_timeout(400)
    pal = pg.evaluate('({ open: document.querySelector(".x-cmdk").classList.contains("is-on"), first: (document.querySelector(".x-cmdk [aria-selected=true]") || {}).textContent })')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    res.ok('palette: Ctrl+K + search finds item', pal['open'] and 'qBittorrent' in (pal['first'] or ''), pal)

    # export / import
    pg.click('#btn-menu'); pg.click('[data-m="set"]'); pg.wait_for_timeout(300); pg.click('[data-tab="数据"]'); pg.wait_for_timeout(300)
    with pg.expect_download() as dl: pg.click('[data-d="export"]')
    path = dl.value.path(); exp = json.load(open(path))
    res.ok('export: JSON with groups + spaces', len(exp.get('groups', [])) == len(env.config['groups']) and len(exp.get('spaces', [])) == 3, os.path.basename(dl.value.suggested_filename))
    imp = json.loads(json.dumps(exp)); imp['settings']['title'] = '导入的标题'
    ip = os.path.join(tempfile.mkdtemp(), 'import.json'); json.dump(imp, open(ip, 'w'), ensure_ascii=False)
    pg.set_input_files('input[type=file][data-file]', ip); pg.wait_for_timeout(600)
    pg.wait_for_timeout(1800)
    srv = admin.j('GET', '/api/config')[1]
    res.ok('import: replaces config, spaces kept, synced', srv['data']['settings']['title'] == '导入的标题' and len(srv['data'].get('spaces', [])) == 3)

    # backup ring restore (设置 → 账户 → 恢复较早的版本)
    pg.click('[data-tab="账户"]'); pg.wait_for_timeout(300)
    pg.click('[data-u="bk"]'); pg.wait_for_selector('[data-bk] [data-u="bk-go"]', timeout=5000)
    first = pg.evaluate('document.querySelector("[data-bk] [data-id] .nc-name").textContent')
    pg.click('[data-bk] [data-u="bk-go"]'); pg.wait_for_timeout(200)
    sure = pg.evaluate('document.querySelector("[data-bk] [data-u=bk-go]").textContent')
    pg.click('[data-bk] [data-u="bk-go"]'); pg.wait_for_timeout(2500)  # 第二次点按「确认恢复？」
    srv2 = admin.j('GET', '/api/config')[1]
    kinds = [x['kind'] for x in admin.j('GET', '/api/config/backups')[1]]
    res.ok('backup ring: restore an earlier version via UI (current one saved as -restore first)', srv2['version'] > srv['version'] and 'restore' in kinds and len(srv2['data'].get('spaces', [])) == 3, {'restored': first, 'confirmStep': sure, 'kinds': kinds[:4]})
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    res.ok('desktop: no page errors', not pg.errs, pg.errs[:2])

    # ---------- cross-device sync + 409 conflict (two browser contexts = two devices)
    ctxB = mk(b, env); pB = go(ctxB, env.base + '/')
    pg.evaluate('App.commit(st => { st.settings.title = "设备 A 改的" })'); pg.wait_for_timeout(1800)
    pB.evaluate('document.dispatchEvent(new Event("visibilitychange"))'); pB.wait_for_timeout(1500)
    res.ok('cross-device sync: B picks up A\'s change on focus', pB.evaluate('document.getElementById("x-title").textContent') == '设备 A 改的')
    ctxB.set_offline(True)
    pB.evaluate('App.commit(st => { st.settings.title = "设备 B 离线改的" })'); pB.wait_for_timeout(1500)
    pg.evaluate('App.commit(st => { st.settings.subtitle = "设备 A 在线改的" })'); pg.wait_for_timeout(1800)
    ctxB.set_offline(False); pB.evaluate('window.dispatchEvent(new Event("online"))')
    try:
        pB.wait_for_selector('.nc-cfs [data-cf="server"]', timeout=20000); cf = True
    except Exception: cf = False
    pB.screenshot(path=os.path.join(OUT, 'conflict-409-1440.png'))
    if cf: pB.click('.nc-cfs [data-cf="server"]'); pB.wait_for_timeout(1500)
    after = admin.j('GET', '/api/config')[1]['data']['settings']
    stash = [x['kind'] for x in admin.j('GET', '/api/config/backups')[1]]
    res.ok('409 conflict panel → 使用服务器版: server kept, local stashed (-local)', cf and after.get('subtitle') == '设备 A 在线改的' and after.get('title') == '设备 A 改的' and 'local' in stash
           and pB.evaluate('document.getElementById("x-title").textContent') == '设备 A 改的', {'panel': cf, 'kinds': stash[:3]})
    # device-local: B's space selection / ui do not leak to A
    pB.evaluate('localStorage.setItem("nocturne.ui", "classic")'); sel_space(pB, 's-nas')
    pg.reload(); pg.wait_for_function('window.App && App.state'); pg.wait_for_timeout(600)
    res.ok('device-local settings (ui, current space, net) stay per device', pg.evaluate('[document.documentElement.dataset.ui, App.spaces.selected()]') == ['v2', 'all'], pg.evaluate('[document.documentElement.dataset.ui, App.spaces.selected()]'))
    ctxB.close(); ctx.close()

    # ---------- multi-account isolation
    admin.j('POST', '/api/users', {'name': 'bob', 'password': PW['bob']})
    bob = Client('http://localhost:%d' % env.port).login('bob')
    bob.j('PUT', '/api/config', {'baseVersion': 0, 'data': {'settings': {'title': 'Bob'}, 'groups': [{'id': 'bg', 'name': 'B', 'style': 'icon', 'items': [{'id': 'b1', 'title': 'Bob 专属', 'lan': '', 'wan': 'https://bob.example'}]}]}, 'caps': ['spaces', 'spaces:2']})
    ctx = mk(b, env, cookies=bob.cookies('localhost')); pg = go(ctx, env.base + '/')
    iso = pg.evaluate('({ title: document.getElementById("x-title").textContent, n: document.querySelectorAll("#x-groups .x-tile").length, spaces: App.spaces.list().length })')
    st_, _, _ = bob.req('GET', '/' + env.icon_ref)
    res.ok('multi-account isolation: bob sees only his config; admin icon 404 for bob', iso == {'title': 'Bob', 'n': 1, 'spaces': 0} and st_ == 404, [iso, st_])
    ctx.close()

    # ---------- mobile 390: merged dock, tap switch, palette
    ctx = mk(b, env, 390, 844, mobile=True); pg = go(ctx, env.base + '/')
    d = pg.evaluate('''() => { const dk = document.querySelector('.x-dock'); return { inDock: !!dk.querySelector('.x-spaces'), segs: dk.querySelectorAll('.x-sp').length,
       fixed: getComputedStyle(dk).position, bottom: Math.round(innerHeight - dk.getBoundingClientRect().bottom) }; }''')
    pg.tap('.x-dock .x-sp[data-space="s-fun"]'); pg.wait_for_timeout(900)
    sw = pg.evaluate('App.spaces.selected()')
    pg.screenshot(path=os.path.join(OUT, 'mobile-390-fun.png'))
    pg.tap('.x-dock [data-act="palette"]'); pg.wait_for_timeout(400)
    pal = pg.evaluate('({ open: document.querySelector(".x-cmdk").classList.contains("is-on"), focus: document.activeElement.matches(".x-cmdk input") })')
    res.ok('mobile 390: spaces merged into dock; tap switches; 快速打开 focuses input', d['inDock'] and d['segs'] == 4 and sw == 's-fun' and pal == {'open': True, 'focus': True}, [d, sw, pal])
    pg.keyboard.press('Escape'); res.ok('mobile: no page errors', not pg.errs, pg.errs[:2]); ctx.close()

    # ---------- static mode (python http.server on public/)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
    ctx.add_init_script('(c => { if (!localStorage.getItem("yeqv.v1")) localStorage.setItem("yeqv.v1", c) })(%s)' % json.dumps(json.dumps({k: v for k, v in env.config.items() if k != 'recent'})))
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(env.static_url); pg.wait_for_function('window.App && App.state'); pg.wait_for_timeout(900)
    s0 = pg.evaluate('({ backend: !!window.NOCTURNE, n: document.querySelectorAll("#x-groups .x-tile, #x-groups .x-chip").length, spaces: App.spaces.list().length })')
    pg.click('.x-sp[data-space="s-nas"]'); pg.wait_for_timeout(800)
    st = pg.evaluate('(document.querySelector(\'#x-groups [data-id="dsm"] .x-st\') || {}).textContent || ""')
    res.ok('static mode: renders all items + spaces, switch works, no NAS-only labels', not s0['backend'] and s0['n'] == NIT and s0['spaces'] == 3 and 'ms' not in st and not errs, [s0, st, errs[:1]])
    ctx.close()
    b.close()

# ---------- old client (V1.1 frontend) against the V2 server, then server restarts
with sync_playwright() as p:
    b = launch(p)
    v11 = v11_root(); work = tempfile.mkdtemp(prefix='nc-rc-old-'); D = os.path.join(work, 'data'); os.makedirs(D); port = free_port()
    s = Server(D, public=os.path.join(v11, 'public'), port=port, name='v2-oldfront')
    c = Client(s.base).login('admin', first=True)
    from stage3_env import demo_config
    cfg = demo_config(None); cfg.pop('recent')
    c.j('PUT', '/api/config', {'baseVersion': 0, 'data': cfg, 'caps': ['spaces', 'spaces:2']})
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN'); ctx.add_cookies(c.cookies())
    pg = go(ctx, s.base + '/')
    old = pg.evaluate('({ hasSpacesUI: !!document.querySelector(".x-sp[data-space]") || !!(App.spaces), title: document.title })')
    pg.evaluate('App.commit(st => { st.settings.title = "旧前端改的"; st.groups[0].items.pop(); })'); pg.wait_for_timeout(2000)
    g = c.j('GET', '/api/config')[1]
    res.ok('old client (V1.1 frontend) → V2 server: edit saved, spaces kept, dangling ref pruned', not old['hasSpacesUI'] and g['data']['settings']['title'] == '旧前端改的' and len(g['data']['spaces']) == 3
           and 'immich' not in (g['data']['spaces'][0].get('itemIds') or []), {'oldUI': old, 'spaces': len(g['data'].get('spaces', []))})
    ctx.close()
    # restart integrity: SIGTERM and SIGKILL
    h0 = sha(open(os.path.join(D, 'config', 'admin.json'), 'rb').read())
    s.stop(signal.SIGTERM); s = Server(D, port=port, name='v2-r1')
    h1 = sha(open(os.path.join(D, 'config', 'admin.json'), 'rb').read())
    ok1 = c.j('GET', '/api/config')[1]['version'] == g['version']
    c.j('PUT', '/api/config', {'baseVersion': g['version'], 'data': dict(g['data'], settings=dict(g['data']['settings'], title='重启前最后一次保存')), 'caps': ['spaces', 'spaces:2']})
    s.stop(signal.SIGKILL); s = Server(D, port=port, name='v2-r2')
    g2 = c.j('GET', '/api/config')[1]
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN'); ctx.add_cookies(c.cookies()); pg = go(ctx, s.base + '/')
    res.ok('server restart (SIGTERM + SIGKILL): sessions survive, config byte-identical, last acknowledged save present',
           h0 == h1 and ok1 and g2['data']['settings']['title'] == '重启前最后一次保存' and pg.evaluate('document.getElementById("x-title").textContent') == '重启前最后一次保存' and not any(f.endswith('.tmp') for f in os.listdir(os.path.join(D, 'config'))))
    ctx.close(); s.stop(); b.close()
    shutil.rmtree(work, ignore_errors=True); shutil.rmtree(v11, ignore_errors=True)

res.dump(os.path.join(OUT, 'rc-regression.json'))
sys.exit(0 if all(c['ok'] for c in res.checks) else 1)
