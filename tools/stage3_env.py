#!/usr/bin/env python3
"""V2.0 阶段 3 实测环境（真实 Node 服务 NAS 模式 / 纯静态模式），供 tools/stage3_verify.py 使用。

  - 真实 server.js：临时 DATA_DIR、测试管理员 admin / admin-pass-1、PROBE_TIMEOUT=2；
  - 本地「Iconify 上游」：ICON_UPSTREAM 指向一个本地 http 服务，提供事先下载好的 selfh.st SVG（沙盒里 Node 走不了代理；
    这是服务器自己的图标缓存路径 /api/icon/…，前端行为与线上一致）；
  - 本地模拟服务：127.0.1.x 上的小 HTTP 服务（200 / 401 / 延迟 / 关闭的端口），让服务器的真实探测得到真实的 state + ms + checkedAt；
  - 演示配置：真实结构的分组 / 项目 / 3 个空间；一个项目的图标是通过 /api/icons 上传的自定义 PNG，一个用文字图标，一个没有图标（字母徽记兜底）。
用法：with Env() as e: e.base / e.cookie / e.static_url
"""
import json, os, socket, subprocess, sys, tempfile, threading, time, urllib.request, http.server, shutil, io, struct, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # 本机请求不走沙盒代理
ICONS = os.environ.get('NC_ICON_DIR', '/workspace/work/nc-tools/icons')

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

class _Svc(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        mode = self.server.mode
        if mode.startswith('delay'): time.sleep(int(mode[5:]) / 1000)
        code = 401 if mode == 'auth' else 200
        self.send_response(code); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(b'ok')
    do_HEAD = do_GET

def _serve(host, port, mode):
    srv = http.server.ThreadingHTTPServer((host, port), _Svc); srv.mode = mode
    threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

class _Icons(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def __init__(self, *a, **k): super().__init__(*a, directory=ICONS, **k)

def png_icon():
    """一张 128×128 的自定义图标（罗盘：深底 + 琥珀指针），模拟用户上传"""
    try:
        from PIL import Image, ImageDraw
        im = Image.new('RGBA', (128, 128), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, 127, 127], 30, fill=(28, 92, 140, 255))
        d.ellipse([22, 22, 106, 106], outline=(236, 230, 218, 255), width=6)
        d.polygon([(64, 30), (76, 64), (64, 98), (52, 64)], fill=(231, 180, 103, 255))
        d.polygon([(64, 30), (76, 64), (52, 64)], fill=(244, 212, 160, 255))
        b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
    except Exception:
        raw = b''.join(b'\x00' + bytes([40, 90, 140, 255]) * 64 for _ in range(64))
        def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
        return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')

SVC = [  # (key, host, port, mode)
    ('emby', '127.0.1.20', 8096, 'ok'), ('jellyfin', '127.0.1.20', 8920, 'delay40'), ('plex', '127.0.1.20', 32400, 'ok'),
    ('navidrome', '127.0.1.20', 4533, 'ok'), ('immich', '127.0.1.22', 2283, 'delay90'),
    ('qb', '127.0.1.21', 8080, 'ok'), ('mp', '127.0.1.21', 3000, 'ok'), ('tr', '127.0.1.21', 9091, 'closed'),
    ('dsm', '127.0.1.10', 5000, 'delay25'), ('dsm2', '127.0.1.11', 5000, 'closed'), ('kuma', '127.0.1.30', 3001, 'ok'),
    ('portainer', '127.0.1.30', 9000, 'auth'), ('ha', '127.0.1.40', 8123, 'delay60'), ('wrt', '127.0.1.1', 8081, 'ok'),
    ('alist', '127.0.1.30', 5244, 'ok'), ('vw', '127.0.1.30', 8222, 'ok'),
]

def demo_config(icon_ref=None):
    U = {k: 'http://%s:%d' % (h, p) for k, h, p, m in SVC}
    def I(id, title, desc, icon, key=None, wan=''):
        return {'id': id, 'title': title, 'desc': desc, 'lan': U[key] if key else '', 'wan': wan, 'icon': icon}
    S = lambda v: {'type': 'iconify', 'value': 'selfhst:' + v, 'bg': ''}
    groups = [
        {'id': 'g-media', 'name': '影音', 'style': 'icon', 'items': [
            I('emby', 'Emby', '家庭影院', S('emby'), 'emby', 'https://emby.nocturne.example'),
            I('jellyfin', 'Jellyfin', '开源影音', S('jellyfin'), 'jellyfin'),
            I('plex', 'Plex', '媒体库', S('plex'), 'plex'),
            I('navidrome', 'Navidrome', '音乐', S('navidrome'), 'navidrome'),
            I('immich', 'Immich 家庭相册（全家共享）', '照片备份', S('immich'), 'immich')]},
        {'id': 'g-dl', 'name': '下载', 'style': 'icon', 'items': [
            I('qb', 'qBittorrent', '下载器', S('qbittorrent'), 'qb'),
            I('mp', 'MoviePilot', '影视订阅', {'type': 'image', 'value': icon_ref, 'bg': ''} if icon_ref else {'type': 'emoji', 'value': '🧭', 'bg': ''}, 'mp'),
            I('tr', 'Transmission', 'PT 做种', S('transmission'), 'tr'),
            I('pt', 'PT 站签到', '每日签到', {'type': 'text', 'value': 'PT', 'bg': '#4A3A6B'}, None, 'https://pt.nocturne.example')]},
        {'id': 'g-nas', 'name': '存储与监控', 'style': 'icon', 'items': [
            I('dsm', '白群晖', 'DS920+ 主存储', S('synology'), 'dsm'),
            I('dsm2', '黑群晖', '备份存储', S('synology'), 'dsm2'),
            I('kuma', 'Uptime Kuma', '服务监控', S('uptime-kuma'), 'kuma'),
            I('portainer', 'Portainer', '容器管理', S('portainer'), 'portainer'),
            I('alist', 'AList', '网盘挂载', S('alist'), 'alist'),
            I('vw', 'Vaultwarden', '密码库', S('vaultwarden'), 'vw'),
            I('restic', 'Restic 异地备份', '每周日 03:00', {'type': '', 'value': '', 'bg': ''}, None, 'https://backup.nocturne.example')]},
        {'id': 'g-home', 'name': '家居与网络', 'style': 'icon', 'items': [
            I('ha', 'Home Assistant', '全屋智能', S('home-assistant'), 'ha'),
            I('wrt', 'OpenWrt', '主路由', S('openwrt'), 'wrt')]},
        {'id': 'g-chips', 'name': '常用', 'style': 'chip', 'items': [
            {'id': 'gh', 'title': 'GitHub', 'lan': '', 'wan': 'https://github.com', 'icon': S('github-light')},
            {'id': 'cf', 'title': 'Cloudflare', 'lan': '', 'wan': 'https://dash.cloudflare.com', 'icon': S('cloudflare')},
            {'id': 'nt', 'title': 'Notion', 'lan': '', 'wan': 'https://www.notion.so', 'icon': S('notion-light')},
            {'id': 'ai', 'title': 'ChatGPT', 'lan': '', 'wan': 'https://chatgpt.com', 'icon': {'type': 'text', 'value': 'AI', 'bg': '#0B6E55'}},
            {'id': 'db', 'title': '豆瓣', 'lan': '', 'wan': 'https://www.douban.com', 'icon': {'type': 'text', 'value': '豆', 'bg': '#2E7D4A'}}]},
    ]
    return {
        'settings': {'title': '夜曲', 'subtitle': 'Nocturne', 'user': 'jingbo', 'cols': 4, 'engine': 'google',
                     'engines': [{'id': 'google', 'name': 'Google', 'url': 'https://www.google.com/search?q=%s', 'on': True},
                                 {'id': 'bing', 'name': 'Bing', 'url': 'https://www.bing.com/search?q=%s', 'on': True},
                                 {'id': 'baidu', 'name': '百度', 'url': 'https://www.baidu.com/s?wd=%s', 'on': True},
                                 {'id': 'github', 'name': 'GitHub', 'url': 'https://github.com/search?q=%s', 'on': True}]},
        'groups': groups,
        'spacesVersion': 2,
        'spaces': [
            {'id': 's-daily', 'name': '日常', 'groupIds': ['g-chips', 'g-home'], 'itemIds': ['immich', 'vw']},
            {'id': 's-fun', 'name': '娱乐', 'groupIds': ['g-media', 'g-dl'], 'excludeItemIds': ['pt']},
            {'id': 's-nas', 'name': 'NAS', 'groupIds': ['g-nas', 'g-home'], 'itemIds': ['qb']},
        ],
        'recent': ['emby', 'mp', 'dsm', 'ha'],
    }

class Env:
    def __init__(self, static=False):
        self.static = static
    def __enter__(self):
        self.procs, self.srvs = [], []
        self.data = tempfile.mkdtemp(prefix='nc-stage3-')
        # mock services
        for k, h, p, m in SVC:
            if m == 'closed': continue
            try: self.srvs.append(_serve(h, p, m))
            except OSError as e: print('svc', k, e, file=sys.stderr)
        ip = free_port(); isrv = http.server.ThreadingHTTPServer(('127.0.0.1', ip), _Icons)
        threading.Thread(target=isrv.serve_forever, daemon=True).start(); self.srvs.append(isrv)
        self.port = free_port()
        env = dict(os.environ, PORT=str(self.port), HOST='127.0.0.1', DATA_DIR=self.data, STATUS_INTERVAL='3600', PROBE_TIMEOUT='2',
                   ICON_UPSTREAM='http://127.0.0.1:%d/' % ip, DOCKER_SOCK=os.path.join(self.data, 'no.sock'), TZ='Asia/Shanghai')
        for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'): env.pop(k, None)
        self.log = open(os.path.join(self.data, 'server.log'), 'w')
        self.procs.append(subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=env, stdout=self.log, stderr=subprocess.STDOUT))
        self.base = 'http://localhost:%d' % self.port
        for _ in range(100):
            try: urllib.request.urlopen('http://127.0.0.1:%d/api/health' % self.port, timeout=1); break
            except Exception: time.sleep(.05)
        self.cookie = self._setup()
        # static mode: python http.server on public/
        sp = free_port()
        self.procs.append(subprocess.Popen([sys.executable, '-m', 'http.server', str(sp), '--bind', '127.0.0.1'], cwd=os.path.join(ROOT, 'public'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        self.static_url = 'http://127.0.0.1:%d/index.html' % sp
        time.sleep(.3)
        return self
    def _req(self, method, path, body=None, ctype='application/json', cookie=None):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        r = urllib.request.Request('http://127.0.0.1:%d/api/%s' % (self.port, path), data=data, method=method)
        if body is not None: r.add_header('Content-Type', ctype)
        if cookie: r.add_header('Cookie', cookie)
        with urllib.request.urlopen(r, timeout=10) as res:
            return res.headers, json.loads(res.read() or b'{}')
    def _setup(self):
        h, _ = self._req('POST', 'setup', {'name': 'admin', 'password': 'admin-pass-1'})
        ck = '; '.join(c.split(';')[0] for c in h.get_all('Set-Cookie') or [])
        _, up = self._req('POST', 'icons', png_icon(), 'image/png', ck)
        self.icon_ref = up.get('url')
        _, cur = self._req('GET', 'config', cookie=ck)
        self.config = demo_config(self.icon_ref)
        self._req('PUT', 'config', {'baseVersion': cur.get('version', 0), 'data': self.config, 'caps': ['spaces', 'spaces:2']}, cookie=ck)
        for _ in range(60):  # wait until the server has really probed the mock services
            _, st = self._req('GET', 'status', cookie=ck)
            if all(k in st for k in ('emby', 'portainer', 'dsm2', 'ha')): self.status = st; break
            time.sleep(.2)
        return ck
    def cookies_for(self, ctx_url=None):
        out = []
        for part in self.cookie.split('; '):
            if '=' in part:
                n, v = part.split('=', 1)
                out.append({'name': n, 'value': v, 'domain': 'localhost', 'path': '/'})
        return out
    def __exit__(self, *a):
        for p in self.procs:
            p.kill()
            try: p.wait(3)
            except Exception: pass
        for s in self.srvs:
            try: s.shutdown()
            except Exception: pass
        self.log.close()
        shutil.rmtree(self.data, ignore_errors=True)

if __name__ == '__main__':
    with Env() as e:
        print(e.base, e.icon_ref)
        print(json.dumps({k: (v.get('status'), v.get('ms')) for k, v in e.status.items()}, ensure_ascii=False))
