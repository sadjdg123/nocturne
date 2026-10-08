#!/usr/bin/env python3
"""V2.0 RC 实测公共部分：真实 server.js 进程（V2 = 本仓库；V1.1 = main@3e6da3c 的代码，按 blob 校验）、HTTP 客户端、Chromium。

不连接、不修改任何 NAS；所有数据目录都是临时目录。测试密码只用于本地临时账户，不写进报告 / 日志。
"""
import json, os, signal, socket, subprocess, sys, tarfile, io, tempfile, time, urllib.request, http.cookiejar, hashlib, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
R = '/workspace/work/.tools/root'
sys.path.insert(0, '/workspace/work/.tools/py')
sys.path.insert(0, os.path.join(ROOT, 'tools'))
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

V11_REF = '9ab11b7'  # 本地 main：与远程 main@3e6da3c（镜像 sha-3e6da3c）这些文件逐个 blob 相同（下面校验）
V11_BLOBS = {'server.js': '4e6921ec084473c9a6441c9d6009061afba9801b', 'public/index.html': 'cbc42170a30b33c6a4f20c3afb0dc2ab0160ddbe',
             'public/nocturne.js': '7944742de2ee6a1c856b334c6231abd5bd22c691', 'package.json': '0bf8f0833ad6a916c30ead64c9090f4184511243'}
PW = {'admin': 'admin-pass-1', 'bob': 'bob-pass-123'}  # 仅本地临时账户


def sha(b): return hashlib.sha256(b).hexdigest()


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def v11_root():
    d = tempfile.mkdtemp(prefix='nc-v11-code-')
    raw = subprocess.check_output(['git', '-C', ROOT, 'archive', V11_REF, 'server.js', 'package.json', 'public'])
    tarfile.open(fileobj=io.BytesIO(raw)).extractall(d)
    for f, b in V11_BLOBS.items():
        got = subprocess.check_output(['git', 'hash-object', os.path.join(d, f)]).decode().strip()
        assert got == b, 'V1.1 baseline mismatch ' + f
    return d


class Server:
    """node server.js；root = 代码目录；public = 另一份前端（V1.1 前端 + V2 服务器）"""
    def __init__(self, data, root=ROOT, public=None, port=None, env=None, name='v2'):
        self.data, self.root, self.name = data, root, name
        self.port = port or free_port()
        e = dict(os.environ, PORT=str(self.port), HOST='127.0.0.1', DATA_DIR=data, STATUS_INTERVAL='3600', PROBE_TIMEOUT='2',
                 DOCKER_SOCK=os.path.join(data, 'no.sock'), TZ='Asia/Shanghai', ICON_UPSTREAM='http://127.0.0.1:9/')
        for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'TRUSTED_PROXY_CIDRS', 'NOCTURNE_NO_AUTH'): e.pop(k, None)
        if public: e['PUBLIC_DIR'] = public
        e.update(env or {})
        self.logf = tempfile.NamedTemporaryFile('w+', prefix='nc-%s-log-' % name, delete=False)
        self.p = subprocess.Popen(['node', os.path.join(root, 'server.js')], env=e, stdout=self.logf, stderr=subprocess.STDOUT)
        self.base = 'http://127.0.0.1:%d' % self.port
        for _ in range(200):
            try: urllib.request.urlopen(self.base + '/api/health', timeout=1); break
            except Exception:
                if self.p.poll() is not None: raise RuntimeError('server exited: ' + self.log())
                time.sleep(.05)

    def log(self):
        self.logf.flush(); return open(self.logf.name).read()

    def stop(self, sig=signal.SIGTERM):
        if self.p.poll() is None:
            self.p.send_signal(sig)
            try: self.p.wait(6)
            except Exception: self.p.kill(); self.p.wait()


class Client:
    def __init__(self, base):
        self.base = base; self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, ctype='application/json', headers=None):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if body is not None: r.add_header('Content-Type', ctype)
        for k, v in (headers or {}).items(): r.add_header(k, v)
        try:
            with self.op.open(r, timeout=15) as res:
                raw = res.read(); return res.status, res.headers, raw
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def j(self, method, path, body=None, **k):
        s, h, raw = self.req(method, path, body, **k)
        try: return s, json.loads(raw or b'null')
        except Exception: return s, None

    def login(self, name, first=False):
        s, _ = self.j('POST', '/api/setup' if first else '/api/login', {'name': name, 'password': PW[name]})
        assert s == 200, 'login %s -> %s' % (name, s)
        return self

    def cookies(self, domain='127.0.0.1'):
        return [{'name': c.name, 'value': c.value, 'domain': domain, 'path': '/'} for c in self.jar]


def png(color=(28, 92, 140)):
    from PIL import Image, ImageDraw
    im = Image.new('RGBA', (128, 128), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, 127, 127], 30, fill=color + (255,)); d.ellipse([34, 34, 94, 94], fill=(231, 180, 103, 255))
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()


def wallpaper_jpg(w=2560, h=1440):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (w, h)); d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / h; d.line([(0, y), (w, y)], fill=(int(10 + 40 * t), int(14 + 30 * t), int(40 + 80 * (1 - t))))
    for i in range(60): d.ellipse([(i * 97) % w, (i * 53) % (h // 2), (i * 97) % w + 4, (i * 53) % (h // 2) + 4], fill=(240, 230, 200))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=88); return b.getvalue()


def launch(p):
    return p.chromium.launch(executable_path=f'{R}/usr/lib/chromium/chromium', args=['--no-sandbox', '--disable-gpu', '--font-render-hinting=none', '--ignore-certificate-errors'],
                             env=dict(os.environ, LD_LIBRARY_PATH=f'{R}/usr/lib/aarch64-linux-gnu:{R}/usr/lib/chromium'))


def form_login(pg, base, name):
    """真实登录：在登录页里输入用户名 / 密码，点「登录」（V1.1 与 V2 共用同一套表单结构）"""
    pg.goto(base + '/')
    pg.wait_for_selector('.nc-auth form', timeout=8000)
    pg.fill('.nc-auth input[name=name]', name)
    pg.fill('.nc-auth input[name=password]', PW[name])
    with pg.expect_navigation(timeout=10000):
        pg.click('.nc-auth .nc-btn')
    pg.wait_for_function('window.App && App.state && !document.documentElement.classList.contains("nc-loading")', timeout=10000)
    pg.wait_for_timeout(600)


class Results:
    def __init__(self, name):
        self.name = name; self.checks = []
    def ok(self, label, cond, detail=''):
        self.checks.append({'check': label, 'ok': bool(cond), 'detail': detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)})
        print(('PASS ' if cond else 'FAIL ') + label + ((' · ' + self.checks[-1]['detail']) if detail not in ('', None) else ''), flush=True)
        return cond
    def dump(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        json.dump({'name': self.name, 'pass': sum(c['ok'] for c in self.checks), 'fail': sum(not c['ok'] for c in self.checks), 'checks': self.checks}, open(path, 'w'), ensure_ascii=False, indent=1)
        print('%s: %d pass / %d fail' % (self.name, sum(c['ok'] for c in self.checks), sum(not c['ok'] for c in self.checks)))
