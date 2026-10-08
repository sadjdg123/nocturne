#!/usr/bin/env python3
"""V2.0 RC · 本地 HTTPS 反向代理实测（Caddy 静态二进制 + 自签名证书，不需要 root）。

  Caddy :<随机端口> TLS（自签名，SAN localhost / 127.0.0.1）→ 夜曲 V2（TRUSTED_PROXY_CIDRS=127.0.0.1）
  另起一个不信任代理的夜曲作对照（默认配置：不信任任何转发头）。
检查：登录 Cookie 的 Secure / HttpOnly / SameSite；X-Forwarded-For 伪造被忽略、真实客户端 IP；/api/health 的 https 判定；
缓存头（index no-store、脚本 ETag / 304、字体 immutable、gzip）经代理不变；Chromium 经 HTTPS 真实登录；
模拟一次部署（改 nocturne.js 并把 ?v= 加一）后刷新，新脚本立刻生效，而浏览器缓存里的旧文件不会被用。
用法：python3 tools/e2e/https_proxy.py [输出目录]
"""
import json, os, ssl, subprocess, sys, tempfile, time, shutil, urllib.request, http.cookiejar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rc_common import *
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rc-https'
os.makedirs(OUT, exist_ok=True)
CADDY = os.environ.get('CADDY', '/workspace/work/.tools/caddy/caddy')
res = Results('https-reverse-proxy')
work = tempfile.mkdtemp(prefix='nc-rc-tls-')
cert, key = os.path.join(work, 'c.pem'), os.path.join(work, 'k.pem')
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=nocturne.test',
                '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], check=True, capture_output=True)
pub = os.path.join(work, 'public'); shutil.copytree(os.path.join(ROOT, 'public'), pub)
D1, D2 = os.path.join(work, 'd1'), os.path.join(work, 'd2'); os.makedirs(D1); os.makedirs(D2)
s1 = Server(D1, public=pub, env={'TRUSTED_PROXY_CIDRS': '127.0.0.1'}, name='trusted')
s2 = Server(D2, name='untrusted')
P1, P2 = free_port(), free_port()
caddyfile = os.path.join(work, 'Caddyfile')
open(caddyfile, 'w').write('''{
  admin off
  auto_https off
  storage file_system %s
}
https://localhost:%d, https://127.0.0.1:%d {
  tls %s %s
  reverse_proxy 127.0.0.1:%d
}
https://localhost:%d, https://127.0.0.1:%d {
  tls %s %s
  reverse_proxy 127.0.0.1:%d
}
''' % (os.path.join(work, 'cs'), P1, P1, cert, key, s1.port, P2, P2, cert, key, s2.port))
cad = subprocess.Popen([CADDY, 'run', '--config', caddyfile, '--adapter', 'caddyfile'], stdout=open(os.path.join(work, 'caddy.log'), 'w'), stderr=subprocess.STDOUT,
                       env=dict(os.environ, HOME=work, XDG_DATA_HOME=work, XDG_CONFIG_HOME=work))
CTX = ssl.create_default_context(cafile=cert)
for _ in range(100):
    try: urllib.request.urlopen('https://127.0.0.1:%d/api/health' % P1, context=CTX, timeout=1); break
    except Exception: time.sleep(.1)


class TLSClient(Client):
    def __init__(self, base):
        super().__init__(base)
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=CTX), urllib.request.HTTPCookieProcessor(self.jar))


try:
    caddy_ver = subprocess.run([CADDY, 'version'], capture_output=True, text=True).stdout.split()[0]
    B1, B2 = 'https://localhost:%d' % P1, 'https://localhost:%d' % P2
    c = TLSClient(B1)
    st, hdr, raw = c.req('POST', '/api/setup', {'name': 'admin', 'password': PW['admin']})
    ck = hdr.get_all('Set-Cookie') or []
    sid = [x for x in ck if x.startswith('nocturne_sid=')]
    res.ok('setup over HTTPS', st == 200, 'caddy ' + caddy_ver)
    res.ok('session cookie: Secure + HttpOnly + SameSite=Lax (trusted proxy, X-Forwarded-Proto https)', sid and all(f in sid[0] for f in ('Secure', 'HttpOnly', 'SameSite=Lax')), [x.split(';', 1)[1].strip() for x in ck])
    st, h = c.j('GET', '/api/health', headers={'X-Forwarded-For': '6.6.6.6', 'X-Real-IP': '6.6.6.6'})
    cl = h.get('client', {})
    res.ok('health via proxy: https=true, trustedPeer, real client IP (spoofed X-Forwarded-For ignored by Caddy + server)', cl.get('https') is True and cl.get('trustedPeer') is True and cl.get('ip') in ('127.0.0.1', '::1') and '6.6.6.6' not in (cl.get('ip') or '') + (cl.get('xForwardedFor') or ''),
           {k: cl.get(k) for k in ('ip', 'https', 'trustedPeer', 'xForwardedFor')})
    # untrusted control (default config)
    c2 = TLSClient(B2)
    st, hdr, _ = c2.req('POST', '/api/setup', {'name': 'admin', 'password': PW['admin']})
    sid2 = [x for x in (hdr.get_all('Set-Cookie') or []) if x.startswith('nocturne_sid=')]
    st, h2 = c2.j('GET', '/api/health')
    res.ok('control (no TRUSTED_PROXY_CIDRS): forwarded headers ignored → https=false, no Secure flag (documented default)', h2['client']['https'] is False and 'Secure' not in sid2[0], h2['client'].get('forwardedHeaders'))
    # direct spoof against the trusted backend from a non-proxy path is impossible here (same 127.0.0.1); the unit tests cover header spoofing (test/proxy.test.js)
    # caching through the proxy
    st, hi, _ = c.req('GET', '/', headers={'Accept-Encoding': 'gzip'})
    st, hj, _ = c.req('GET', '/nocturne.js?v=8', headers={'Accept-Encoding': 'gzip'})
    et = hj.get('ETag'); st304, _, _ = c.req('GET', '/nocturne.js?v=8', headers={'If-None-Match': et})
    font = [f for f in os.listdir(os.path.join(pub, 'fonts')) if f.endswith('.woff2')][0]
    st, hf, _ = c.req('GET', '/fonts/' + font)
    st, hc, _ = c.req('GET', '/fonts/fonts.css')
    cache = {'index': hi.get('Cache-Control'), 'js': hj.get('Cache-Control'), 'js_gzip': hj.get('Content-Encoding'), 'etag304': st304, 'font': hf.get('Cache-Control'), 'fonts.css': hc.get('Cache-Control')}
    res.ok('cache headers survive the proxy (index no-store, js revalidate + ETag 304 + gzip, woff2 immutable, fonts.css revalidate)',
           cache['index'] == 'no-store' and 'must-revalidate' in cache['js'] and cache['etag304'] == 304 and cache['js_gzip'] == 'gzip' and 'immutable' in cache['font'] and 'immutable' not in cache['fonts.css'], cache)

    with sync_playwright() as p:
        b = launch(p)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN', ignore_https_errors=True)
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        form_login(pg, B1, 'admin')
        cks = {x['name']: x for x in ctx.cookies()}
        res.ok('Chromium: real form login over HTTPS; cookies Secure + HttpOnly in the browser', cks['nocturne_sid']['secure'] and cks['nocturne_sid']['httpOnly'] and cks['nocturne_dev']['secure'], {k: [v['secure'], v['httpOnly'], v['sameSite']] for k, v in cks.items()})
        pg.evaluate('App.commit(st => { st.settings.title = "HTTPS 下保存" })'); pg.wait_for_timeout(1800)
        res.ok('Chromium: save over HTTPS synced', c.j('GET', '/api/config')[1]['data']['settings']['title'] == 'HTTPS 下保存')
        pg.screenshot(path=os.path.join(OUT, 'https-1440.png'))
        # simulated deploy without ?v= bump: browser keeps its cached copy (why the bump matters)
        js = os.path.join(pub, 'nocturne.js'); orig = open(js).read()
        open(js, 'w').write(orig + '\nwindow.__rcDeploy = "nobump";\n'); os.utime(js, (time.time() + 5, time.time() + 5))
        pg.reload(); pg.wait_for_timeout(2500)
        nobump = pg.evaluate('window.__rcDeploy || null')
        # proper deploy: content + ?v= bump → new script immediately
        open(js, 'w').write(orig + '\nwindow.__rcDeploy = "bumped";\n'); os.utime(js, (time.time() + 10, time.time() + 10))
        ix = os.path.join(pub, 'index.html'); html = open(ix).read(); open(ix, 'w').write(html.replace('nocturne.js?v=8', 'nocturne.js?v=9'))
        pg.reload(); pg.wait_for_timeout(2500)
        bumped = pg.evaluate('window.__rcDeploy || null')
        res.ok('deploy: with ?v= bump the new script runs on the next reload (index is no-store)', bumped == 'bumped', {'without bump': nobump, 'with bump': bumped})
        res.ok('no page errors over HTTPS', not errs, errs[:2])
        b.close()
finally:
    cad.terminate(); s1.stop(); s2.stop()
    res.dump(os.path.join(OUT, 'https-proxy.json'))
    shutil.rmtree(work, ignore_errors=True)
sys.exit(0 if all(c['ok'] for c in res.checks) else 1)
