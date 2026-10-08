#!/usr/bin/env python3
"""V2.0 RC · 演练 2：升级 → 建空间 → 回滚到 V1.1 → 旧前端编辑 / 「用本机版覆盖」→ 再升级 → 不丢数据。

同一个临时 data 目录、同一个端口（模拟容器原地换镜像），真实进程 + Chromium：
  1. V1.1（main@3e6da3c）：建管理员、上传图标、壁纸、配置；第二台「设备」B 打开页面后离线（保留 V2 之前的本机缓存）
  2. 升级 V2：固定快照；在「管理空间」界面里真实点按新建 3 个空间并勾选分组
  3. 回滚 V1.1：设备 A 在旧前端里改标题、新增项目（普通保存，空间保留）；设备 B 带着离线修改回来 → 409 冲突面板 →「用本机版覆盖」→ 空间丢失（实测风险）
  4. 再升级 V2：自动找回空间 + 页面提示一次；回滚期间的修改、项目、图标、壁纸、两个账户全部还在；「较早的版本」里有找回前的版本
用法：python3 tools/e2e/rollback_drill.py [输出目录]
Docker 本身（docker stop / 换镜像 / docker start）沙盒里没有 docker 守护进程，用同端口重启 node 进程等价代替，真实容器重启见手动验收清单。
"""
import json, os, shutil, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rc_common import *
from stage3_env import demo_config
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rc-rollback'
os.makedirs(OUT, exist_ok=True)
res = Results('upgrade-rollback-reupgrade-drill')
work = tempfile.mkdtemp(prefix='nc-rc-rb-'); D = os.path.join(work, 'data'); os.makedirs(D)
v11 = v11_root(); PORT = free_port()
ICON, WP = png((120, 60, 160)), wallpaper_jpg(1920, 1080)
disk = lambda f: json.load(open(os.path.join(D, f)))


def ctx_for(b, client, w=1440, h=900):
    ctx = b.new_context(viewport={'width': w, 'height': h}, locale='zh-CN', timezone_id='Asia/Shanghai')
    ctx.add_cookies(client.cookies()); return ctx


def open_app(ctx, base):
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(base + '/'); pg.wait_for_function('window.App && App.state && !document.documentElement.classList.contains("nc-loading")', timeout=10000)
    pg.wait_for_timeout(900); pg.errs = errs; return pg


with sync_playwright() as p:
    b = launch(p)
    # ---- 1. V1.1
    s = Server(D, root=v11, port=PORT, name='v11')
    ca = Client(s.base).login('admin', first=True)
    _, up = ca.j('POST', '/api/icons', ICON, ctype='image/png'); _, wp = ca.j('PUT', '/api/wallpaper', WP, ctype='image/jpeg')
    cfg = demo_config(up['url']); [cfg.pop(k) for k in ('spaces', 'spacesVersion', 'recent')]
    cfg['settings']['wallpaper'] = {'id': 'custom', 'file': True, 'v': wp['v'], 'url': ''}
    ca.j('PUT', '/api/config', {'baseVersion': 0, 'data': cfg})
    ca.j('POST', '/api/users', {'name': 'bob', 'password': PW['bob']})
    cbob = Client(s.base).login('bob'); cbob.j('PUT', '/api/config', {'baseVersion': 0, 'data': {'settings': {'title': 'Bob'}, 'groups': [{'id': 'bg', 'name': 'B', 'style': 'icon', 'items': [{'id': 'b1', 'title': 'Bob 专属', 'lan': '', 'wan': 'https://bob.example'}]}]}})
    # device B: a V1.1 tab that loaded the V1.1 data (its localStorage = pre-V2 cache)
    cB = Client(s.base).login('admin'); ctxB = ctx_for(b, cB, 390, 844); pgB = open_app(ctxB, s.base)
    storeB = pgB.evaluate('JSON.stringify(Object.assign({}, localStorage))'); pgB.close()
    NIT = sum(len(g['items']) for g in cfg['groups'])
    s.stop()

    # ---- 2. upgrade to V2, create spaces in the real 管理空间 UI
    s = Server(D, port=PORT, name='v2-a')
    res.ok('upgrade: pinned pre-v2 snapshot', len([f for f in os.listdir(D) if f.startswith('pre-v2-snapshot-')]) == 1)
    ctxA = ctx_for(b, ca); pg = open_app(ctxA, s.base)
    pg.evaluate('App.spaces.manage()'); pg.wait_for_selector('.x-spm [data-spm-new] input[name=name]')
    for name, groups in (('日常', ['g-chips', 'g-home']), ('娱乐', ['g-media', 'g-dl']), ('NAS', ['g-nas'])):
        pg.fill('.x-spm [data-spm-new] input[name=name]', name); pg.click('.x-spm [data-spm-new] button[type=submit]'); pg.wait_for_timeout(400)
        sid = pg.evaluate('n => App.spaces.list().find(s => s.name === n).id', name)
        if not pg.evaluate('id => !!document.querySelector(`.x-spm [data-ed="${id}"]`)', sid):
            pg.click('.x-spm [data-spm="open"][data-sid="%s"]' % sid); pg.wait_for_timeout(300)
        for gid in groups:
            pg.check('.x-spm [data-ed="%s"] input[data-sp-group="%s"]' % (sid, gid)); pg.wait_for_timeout(200)
    pg.click('.x-spm-done'); pg.wait_for_timeout(2000)
    v2cfg = ca.j('GET', '/api/config')[1]
    SP = [(x['name'], sorted(x.get('groupIds', []))) for x in v2cfg['data'].get('spaces', [])]
    res.ok('V2 UI created 3 spaces, synced', SP == [('日常', ['g-chips', 'g-home']), ('娱乐', ['g-dl', 'g-media']), ('NAS', ['g-nas'])], SP)
    res.ok('V2 writer marker + guard sidecar on disk', disk('config/admin.json').get('writer', {}).get('gen') == 2 and len(disk('spaces-guard/admin.json')['spaces']) == 3)
    pg.evaluate('App.spaces.select(App.spaces.list()[1].id)'); pg.wait_for_timeout(900)
    pg.screenshot(path=os.path.join(OUT, '1-v2-spaces-created.png')); pg.close(); s.stop()

    # ---- 3. rollback to V1.1
    s = Server(D, root=v11, port=PORT, name='v11-rb')
    res.ok('rollback: V1.1 serves again', json.loads(urllib.request.urlopen(s.base + '/api/health').read())['version'] == '1.0.0')
    pg = open_app(ctxA, s.base)
    pg.evaluate('''() => App.commit(st => { st.settings.title = "回滚期间改的标题"; st.groups[0].items.push({ id: "rbadd0001", title: "回滚期间新增", desc: "", lan: "", wan: "https://rb.example", icon: { type: "", value: "", bg: "" } }); })''')
    pg.wait_for_timeout(2000)
    g = ca.j('GET', '/api/config')[1]
    res.ok('V1.1 frontend ordinary edit saved, spaces still there', g['data']['settings']['title'] == '回滚期间改的标题' and len(g['data'].get('spaces', [])) == 3)
    pg.close()
    # device B comes back with an offline edit made on its pre-V2 cache → conflict → 用本机版覆盖
    st = json.loads(storeB); loc = json.loads(st['yeqv.v1']); loc['groups'][1]['items'][0]['title'] = '设备 B 离线改的'
    st['yeqv.v1'] = json.dumps(loc); st['nocturne.dirty'] = '1'
    ctxB = ctx_for(b, cB, 390, 844); ctxB.add_init_script('(s => { if (!sessionStorage.getItem("x")) { localStorage.clear(); for (const k in s) localStorage.setItem(k, s[k]); sessionStorage.setItem("x", 1); } })(%s)' % json.dumps(st))
    pgB = ctxB.new_page(); pgB.goto(s.base + '/')
    pgB.wait_for_selector('.nc-cfs [data-cf="local"]', timeout=10000)
    pgB.screenshot(path=os.path.join(OUT, '2-v11-conflict-panel.png'))
    pgB.click('.nc-cfs [data-cf="local"]'); pgB.wait_for_timeout(2500); pgB.close()
    lost = disk('config/admin.json')
    res.ok('MEASURED RISK: V1.1 用本机版覆盖 dropped spaces + V2 marker', 'spaces' not in lost['data'] and 'writer' not in lost, 'v%d' % lost['version'])
    s.stop()

    # ---- 4. re-upgrade
    s = Server(D, port=PORT, name='v2-b')
    g = ca.j('GET', '/api/config')[1]
    g = ca.j('GET', '/api/config')[1]
    res.ok('server log: spaces guard restored', 'spaces guard: restored admin 3 spaces' in s.log())
    res.ok('spaces recovered (names + groups)', [(x['name'], sorted(x.get('groupIds', []))) for x in g['data'].get('spaces', [])] == SP)
    res.ok('device B overwrite kept (no rollback of user edits)', g['data']['groups'][1]['items'][0]['title'] == '设备 B 离线改的')
    items = sum(len(x['items']) for x in g['data']['groups'])
    res.ok('items: none lost', items >= NIT, '%d items (V1.1 had %d)' % (items, NIT))
    st_, _, raw = ca.req('GET', '/' + up['url']); res.ok('uploaded icon intact', st_ == 200 and sha(raw) == sha(ICON))
    st_, _, raw = ca.req('GET', '/api/wallpaper'); res.ok('wallpaper intact', st_ == 200 and sha(raw) == sha(WP))
    gb = Client(s.base).login('bob').j('GET', '/api/config')[1]; res.ok('accounts intact (bob login + own config)', gb['data']['settings']['title'] == 'Bob')
    bks = ca.j('GET', '/api/config/backups')[1]
    res.ok('backup ring has the pre-recovery version (-guard) + the replaced V2 version', any(x['kind'] == 'guard' for x in bks) and any(x['kind'] == 'replaced' and x['spaces'] == 3 for x in bks), [x['kind'] for x in bks])
    pg = open_app(ctxA, s.base)
    toast = pg.evaluate('({ on: document.getElementById("x-toast").classList.contains("is-on"), msg: document.getElementById("x-toast-msg").textContent })')
    res.ok('V2 page shows the recovery notice', toast['on'] and '3 个空间已自动找回' in toast['msg'], toast['msg'])
    pg.screenshot(path=os.path.join(OUT, '3-v2-reupgrade-notice.png'))
    pg.evaluate('App.spaces.select(App.spaces.list()[1].id)'); pg.wait_for_timeout(900)
    res.ok('space switch works after recovery', pg.evaluate('document.querySelectorAll("#x-groups .x-tile, #x-groups .x-chip").length') > 0)
    # 设置 → 账户 → 恢复较早的版本：guard 标签
    res.ok('no page errors', not pg.errs, pg.errs[:2]); pg.close()
    pg = open_app(ctxA, s.base)
    res.ok('notice shown only once per device', '自动找回' not in pg.evaluate('document.getElementById("x-toast-msg").textContent'))
    pg.close(); s.stop()
    s = Server(D, port=PORT, name='v2-c')
    res.ok('restart again: idempotent (no 2nd recovery, same version)', 'spaces guard: restored' not in s.log() and ca.j('GET', '/api/config')[1]['version'] == g['version'])
    s.stop(); b.close()

res.dump(os.path.join(OUT, 'rollback-drill.json'))
shutil.rmtree(work, ignore_errors=True); shutil.rmtree(v11, ignore_errors=True)
sys.exit(0 if all(c['ok'] for c in res.checks) else 1)
