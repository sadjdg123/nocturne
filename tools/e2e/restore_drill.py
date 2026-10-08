#!/usr/bin/env python3
"""V2.0 RC · 演练 1：升级前独立备份 → 恢复到新目录 → V2 服务器在恢复的数据上运行。

  1. V1.1 服务器（main@3e6da3c 代码）+ 临时 data：Chromium 里真实创建管理员 / 登录；HTTP 上传自定义图标、壁纸（2560×1440 JPEG）、
     写入真实结构的配置（5 个分组 / 24 个项目），第二个账户 bob 有自己的配置；Chromium 截图确认 V1.1 页面显示正常。
  2. 停止 V1.1（SIGTERM）→ tools/backup.sh → tools/verify-backup.sh → tools/restore.sh 到一个新目录（并实测：非空目录被拒绝）。
  3. V2 服务器在恢复出的目录上启动：固定的升级前快照、HTTP 核对（登录、配置逐字节、图标、壁纸、快照环、bob 隔离），
     Chromium：在 V2 登录页真实登录，项目数量、自定义图标真的解码出来、壁纸真的加载；再建 3 个空间，切换后各自的项目数。
用法：python3 tools/e2e/restore_drill.py [输出目录]
"""
import json, os, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rc_common import *
from stage3_env import demo_config
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rc-restore'
os.makedirs(OUT, exist_ok=True)
res = Results('restore-drill')
work = tempfile.mkdtemp(prefix='nc-rc-restore-')
A, B, BK = os.path.join(work, 'nas-data'), os.path.join(work, 'restored-data'), os.path.join(work, 'backups')
os.makedirs(A)
v11 = v11_root()
ICON, WP = png(), wallpaper_jpg()


def tsh(script, *args):
    p = subprocess.run(['sh', os.path.join(ROOT, 'tools', script), *args], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


with sync_playwright() as p:
    b = launch(p)
    # ---- 1. V1.1 data
    s = Server(A, root=v11, name='v11')
    res.ok('V1.1 /api/health', json.loads(urllib.request.urlopen(s.base + '/api/health').read())['version'] == '1.0.0')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN', timezone_id='Asia/Shanghai'); pg = ctx.new_page()
    pg.goto(s.base + '/'); pg.wait_for_selector('.nc-auth form')
    pg.fill('.nc-auth input[name=name]', 'admin'); pg.fill('.nc-auth input[name=password]', PW['admin']); pg.fill('.nc-auth input[name=password2]', PW['admin'])
    with pg.expect_navigation(): pg.click('.nc-auth .nc-btn')
    pg.wait_for_function('window.App && App.state', timeout=8000)
    c = Client(s.base).login('admin')
    st, up = c.j('POST', '/api/icons', ICON, ctype='image/png'); res.ok('V1.1 icon upload', st == 200)
    st, wp = c.j('PUT', '/api/wallpaper', WP, ctype='image/jpeg'); res.ok('V1.1 wallpaper upload', st == 200)
    cfg = demo_config(up['url']); cfg.pop('spaces'); cfg.pop('spacesVersion'); cfg.pop('recent')
    cfg['settings']['wallpaper'] = {'id': 'custom', 'file': True, 'v': wp['v'], 'url': ''}
    _, cur = c.j('GET', '/api/config')
    st, r = c.j('PUT', '/api/config', {'baseVersion': cur.get('version', 0), 'data': cfg}); res.ok('V1.1 config saved', st == 200, 'v%s' % r.get('version'))
    st, _ = c.j('POST', '/api/users', {'name': 'bob', 'password': PW['bob']}); res.ok('V1.1 second account', st == 200)
    cb = Client(s.base).login('bob')
    cb.j('PUT', '/api/config', {'baseVersion': 0, 'data': {'settings': {'title': 'Bob 的夜曲'}, 'groups': [{'id': 'bg', 'name': 'Bob', 'style': 'icon', 'items': [{'id': 'b1', 'title': 'Bob 专属', 'lan': '', 'wan': 'https://bob.example'}]}]}})
    pg.reload(); pg.wait_for_function('window.App && App.state && App.state.groups.length > 3', timeout=8000); pg.wait_for_timeout(1200)
    n11 = pg.evaluate('document.querySelectorAll("#x-groups .x-tile, #x-groups .x-chip").length')
    NIT = sum(len(g['items']) for g in cfg['groups'])
    res.ok('V1.1 page renders the data', n11 == NIT, '%d / %d tiles' % (n11, NIT))
    pg.screenshot(path=os.path.join(OUT, 'v11-before-backup.png'))
    ctx.close()
    src_cfg = json.load(open(os.path.join(A, 'config', 'admin.json')))
    s.stop()

    # ---- 2. backup / verify / restore
    rc, out = tsh('backup.sh', '-o', BK, A); res.ok('backup.sh', rc == 0, out.strip().splitlines()[0] if out else '')
    arc = [os.path.join(BK, f) for f in os.listdir(BK) if f.endswith('.tar.gz')][0]
    rc, out = tsh('verify-backup.sh', arc); res.ok('verify-backup.sh', rc == 0, out.strip().splitlines()[-1])
    os.makedirs(B); open(os.path.join(B, 'something'), 'w').write('x')
    rc, out = tsh('restore.sh', arc, B); res.ok('restore.sh refuses non-empty target (exit 3)', rc == 3)
    os.remove(os.path.join(B, 'something'))
    rc, out = tsh('restore.sh', arc, B); res.ok('restore.sh into empty dir', rc == 0, out.strip().splitlines()[-3] if rc == 0 else out)

    def tree(d):
        o = {}
        for r_, ds, fs in os.walk(d):
            for f in fs:
                if not f.endswith('.tmp'): q = os.path.join(r_, f); o[os.path.relpath(q, d)] = sha(open(q, 'rb').read())
        return o
    ta, tb = tree(A), tree(B)
    res.ok('restored tree == original (every file sha256)', ta == tb, '%d files' % len(ta))

    # ---- 3. V2 on the restored data
    s2 = Server(B, name='v2')
    h = json.loads(urllib.request.urlopen(s2.base + '/api/health').read())
    res.ok('V2 /api/health', h['version'].startswith('2.0.0'), h['version'])
    snaps = [f for f in os.listdir(B) if f.startswith('pre-v2-snapshot-')]
    res.ok('pinned pre-v2 snapshot written on first V2 start', len(snaps) == 1, snaps[0] if snaps else '')
    if snaps:
        man = json.load(open(os.path.join(B, snaps[0], 'MANIFEST.json')))
        res.ok('snapshot MANIFEST sha256 all match', all(sha(open(os.path.join(B, snaps[0], f['path']), 'rb').read()) == f['sha256'] for f in man['files']), '%d files' % len(man['files']))
    c2 = Client(s2.base).login('admin')
    _, g = c2.j('GET', '/api/config')
    res.ok('config data identical after restore + V2', g['data'] == src_cfg['data'] and g['version'] == src_cfg['version'], 'v%d' % g['version'])
    st, _, raw = c2.req('GET', '/' + up['url']); res.ok('custom icon bytes identical', st == 200 and sha(raw) == sha(ICON))
    st, _, raw = c2.req('GET', '/api/wallpaper'); res.ok('wallpaper bytes identical', st == 200 and sha(raw) == sha(WP), '%d bytes' % len(raw))
    cb2 = Client(s2.base).login('bob'); _, gb = cb2.j('GET', '/api/config')
    res.ok('second account restored + isolated', gb['data']['settings']['title'] == 'Bob 的夜曲' and len(gb['data']['groups']) == 1)
    st, _ = Client(s2.base).j('POST', '/api/login', {'name': 'admin', 'password': 'wrong-password'}); res.ok('wrong password still rejected', st == 401)

    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN', timezone_id='Asia/Shanghai'); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    form_login(pg, s2.base, 'admin')
    pg.wait_for_timeout(1200)
    info = pg.evaluate('''() => { const im = document.querySelector('#x-groups [data-id="mp"] img');
      const wp = getComputedStyle(document.querySelector('.x-wp') || document.body).backgroundImage;
      return { tiles: document.querySelectorAll('#x-groups .x-tile, #x-groups .x-chip').length, icon: im ? [im.complete, im.naturalWidth] : null, wp,
        wpLoaded: performance.getEntriesByType('resource').some(r => r.name.includes('api/wallpaper')), ui: document.documentElement.dataset.ui,
        spaces: App.spaces.list().length }; }''')
    res.ok('V2 page: real form login + all %d items' % NIT, info['tiles'] == NIT, info)
    res.ok('V2 page: uploaded icon decoded', bool(info['icon']) and info['icon'][1] > 0)
    res.ok('V2 page: custom wallpaper requested + applied', info['wpLoaded'] and 'api/wallpaper' in info['wp'], info['wp'][:80])
    res.ok('V2 page: no spaces yet (V1.1 data) → only 全部', info['spaces'] == 0)
    pg.screenshot(path=os.path.join(OUT, 'v2-after-restore-1440.png'))
    # spaces on restored data (V2 page API → commit → sync)
    pg.evaluate('''() => App.commit(st => { st.spaces = [{ id: "s-daily", name: "日常", groupIds: ["g-chips", "g-home"], itemIds: ["immich"] },
        { id: "s-fun", name: "娱乐", groupIds: ["g-media", "g-dl"] }, { id: "s-nas", name: "NAS", groupIds: ["g-nas"] }]; st.spacesVersion = 2; })''')
    pg.wait_for_timeout(2000)
    _, g = c2.j('GET', '/api/config')
    res.ok('spaces created in V2 synced to server', len(g['data'].get('spaces') or []) == 3)
    counts = {}
    for sid in ['s-daily', 's-fun', 's-nas', 'all']:
        pg.evaluate('id => App.spaces.select(id)', sid); pg.wait_for_timeout(900)
        counts[sid] = pg.evaluate('id => [document.querySelectorAll("#x-groups .x-tile, #x-groups .x-chip").length, App.spaces.view(id).reduce((n, e) => n + e.items.length, 0)]', sid)
    res.ok('space switching shows each space\'s items (DOM == model)', all(a == b_ for a, b_ in counts.values()) and counts['all'][0] == NIT and counts['s-fun'][0] < NIT, counts)
    pg.evaluate('id => App.spaces.select(id)', 's-fun'); pg.wait_for_timeout(900)
    pg.screenshot(path=os.path.join(OUT, 'v2-after-restore-spaces-1440.png'))
    res.ok('no page errors', not errs, errs[:2])
    guard = json.load(open(os.path.join(B, 'spaces-guard', 'admin.json')))
    res.ok('spaces guard sidecar follows the V2 write', len(guard['spaces']) == 3 and guard['version'] == g['version'])
    ctx.close(); s2.stop(); b.close()

res.dump(os.path.join(OUT, 'restore-drill.json'))
shutil.rmtree(work, ignore_errors=True); shutil.rmtree(v11, ignore_errors=True)
sys.exit(0 if all(c['ok'] for c in res.checks) else 1)
