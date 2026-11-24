"""Prueba de extremo a extremo del modo nube con dos navegadores y Apps Script simulado."""
import asyncio, json, time, urllib.request, sys
from playwright.async_api import async_playwright

ADMIN = 'http://127.0.0.1:8787/__admin'
PAGE = 'http://localhost:8080/'
SHOTS = './shots/'
ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-proxy-server',
        '--autoplay-policy=no-user-gesture-required']
UA_FF = 'Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0'
UA_IOS = ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 '
          '(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1')

def admin(**k):
    r = urllib.request.Request(ADMIN, data=json.dumps(k).encode(), method='POST')
    return json.load(urllib.request.urlopen(r))

def ok(c, m):
    print(('✔ ' if c else '✖ FALLA ') + m, flush=True)
    if not c: raise SystemExit(1)

HIDE = """() => {
  window.__vis = 'hidden';
  Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  // Con la pantalla bloqueada los temporizadores quedan congelados: se detiene la consulta al servidor
  setTimeout(() => { clearTimeout(S.pollTimer); S.active_bak = S.active; }, 300);
}"""
SHOW = """() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }"""

async def st(p):
    return await p.evaluate("""async () => {
      const pc = S.pc; let rx = 0, tx = 0;
      if (pc) { const r = await pc.getStats(); r.forEach(x => {
        if (x.type === 'inbound-rtp' && x.kind === 'audio') rx = x.packetsReceived;
        if (x.type === 'outbound-rtp' && x.kind === 'audio') tx = x.packetsSent; }); }
      const q = s => document.querySelector(s);
      return { conn: pc && pc.connectionState, rx, tx, status: q('#status').textContent,
        sub: q('#substatus').hidden ? '' : q('#substatus').textContent,
        report: q('#bgReport').hidden ? '' : q('#bgText').textContent,
        tokenBox: !q('#tokenBox').hidden, tokenErr: q('#tokenErr').hidden ? '' : q('#tokenErr').textContent };
    }""")

async def wait_conn(p, name, t=30):
    t0 = time.time()
    while time.time() - t0 < t:
        s = await st(p)
        if s['conn'] == 'connected': return s
        await asyncio.sleep(0.5)
    raise SystemExit(f'✖ {name} no conectó: {await st(p)}\n' + await p.inner_text('#log'))

async def flowing(a, b, label, secs=3):
    s1a, s1b = await st(a), await st(b)
    await asyncio.sleep(secs)
    s2a, s2b = await st(a), await st(b)
    ra, rb = s2a['rx'] - s1a['rx'], s2b['rx'] - s1b['rx']
    ok(ra > 25 * secs and rb > 25 * secs, f'{label}: audio en ambos sentidos ({ra} y {rb} paquetes en {secs} s)')

async def main():
    admin(run='configurar')
    admin(setProp=['PAGE_URL', PAGE])
    admin(setProp=['CF_TURN_KEY_ID', 'TESTKEY']); admin(setProp=['CF_TURN_API_TOKEN', 'TESTTOKEN'])
    logs = admin(run='crearTokensViaje')['logs']
    links = [l.split('Enlace: ')[1] for l in logs if 'Enlace:' in l]
    tok_bad = links[0].split('#t=')[1][:-4] + 'XXXX'

    async with async_playwright() as pw:
        br = await pw.chromium.launch(args=ARGS)
        ctxA = await br.new_context(viewport={'width': 400, 'height': 860}, device_scale_factor=2, user_agent=UA_FF, is_mobile=True, has_touch=True)
        ctxB = await br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, user_agent=UA_IOS, is_mobile=True, has_touch=True)
        A, B = await ctxA.new_page(), await ctxB.new_page()
        for p, n in ((A, 'A'), (B, 'B')):
            p.on('pageerror', lambda e, n=n: print(n, 'pageerror', e))

        # 1) Enlace con token: se guarda y desaparece de la barra de direcciones
        await A.goto(links[0]); await B.goto(links[1])
        saved = await A.evaluate("localStorage.getItem('intercomToken') || ''")
        ok(await A.evaluate('location.hash') == '' and len(saved) > 20,
           'el token se guarda y se borra de la URL')
        await A.screenshot(path=SHOTS + 'n01-android-listo.png')
        await A.click('#btnConnect'); await asyncio.sleep(2)
        await B.click('#btnConnect')
        await wait_conn(A, 'A'); await wait_conn(B, 'B')
        ok(True, 'conexión establecida usando solo Apps Script como señalización')
        cfg = await A.evaluate('JSON.stringify(S.pc.getConfiguration().iceServers)')
        ok('turn:' in cfg and 'TESTTOKEN' not in cfg, 'la página recibió credenciales TURN (sin la llave de Cloudflare)')
        await flowing(A, B, 'inicial')
        await asyncio.sleep(2)
        await A.screenshot(path=SHOTS + 'n02-android-conectado.png')
        await B.evaluate("document.querySelectorAll('details')[0].open = true"); await asyncio.sleep(1.5)
        await B.screenshot(path=SHOTS + 'n03-iphone-conectado.png', full_page=True)
        await B.evaluate("document.querySelectorAll('details')[0].open = false")

        # 2) Servidor caído 12 s (zona sin señal hacia Google): el audio P2P no depende de él
        admin(down=True); await asyncio.sleep(2)
        await flowing(A, B, 'Apps Script sin responder', 6)
        admin(down=False)
        await asyncio.sleep(7)
        ok((await st(A))['conn'] == 'connected', 'al volver el servidor la conexión sigue')

        # 3) Google vacía la caché (se pierde la sala): el audio sigue y la sala se rehace sola
        admin(clearCache=True)
        await asyncio.sleep(14)
        await flowing(A, B, 'tras perder la sala en caché')
        room = admin(room=admin()['props']['SALA'])['result']
        ok(room and len(room['peers']) == 2, 'la sala se reconstruyó con los dos participantes')

        # 4) Pantalla bloqueada en el iPhone 15 s (sin consultas al servidor)
        await B.evaluate(HIDE); await asyncio.sleep(15)
        sA = await st(A)
        if 'sigue llegando' not in sA['sub']:
            print(sA); print(await A.evaluate("document.querySelector('#log').textContent.slice(0,1800)")); print('B:', await B.evaluate("document.querySelector('#log').textContent.slice(0,900)"))
        ok('sigue llegando' in sA['sub'], 'el Android ve que el iPhone está bloqueado y su audio sigue llegando')
        await A.screenshot(path=SHOTS + 'n04-android-ve-iphone-bloqueado.png')
        await B.evaluate(SHOW); await asyncio.sleep(3)
        sB = await st(B)
        ok('siguió enviando' in sB['report'], 'al desbloquear, el iPhone confirma que su micrófono siguió enviando')

        # 5) El iPhone recarga la página: vuelve a entrar con el mismo token
        await B.reload(); await asyncio.sleep(1); await B.click('#btnConnect')
        await wait_conn(A, 'A'); await wait_conn(B, 'B')
        await flowing(A, B, 'tras recargar el iPhone')

        # 6) Un tercero con token válido no puede entrar (sala de 2)
        tC = admin(run='crearToken', args=['Intruso', 1])['result']
        C = await (await br.new_context(user_agent=UA_FF, is_mobile=True)).new_page()
        await C.goto(PAGE + '#t=' + tC); await C.click('#btnConnect'); await asyncio.sleep(4)
        ok('dos celulares' in (await st(C))['status'], 'tercer token válido -> "Ya hay dos celulares en la sala"')
        await C.close()

        # 7) Token falso: se rechaza y se pide otro
        D = await (await br.new_context(user_agent=UA_FF, is_mobile=True, viewport={'width': 400, 'height': 860}, device_scale_factor=2)).new_page()
        await D.goto(PAGE + '#t=' + tok_bad); await D.click('#btnConnect'); await asyncio.sleep(4)
        sD = await st(D)
        ok(sD['tokenBox'] and 'no es válido' in sD['tokenErr'], 'token falso -> rechazado y se muestra la pantalla de token')
        await D.screenshot(path=SHOTS + 'n05-token-invalido.png')

        # 8) Sin token: se pide el token antes de todo
        E = await (await br.new_context(user_agent=UA_IOS, is_mobile=True)).new_page()
        await E.goto(PAGE); ok((await st(E))['tokenBox'], 'sin token -> se pide el token')

        # 9) Revocar el token del iPhone lo saca en la siguiente consulta
        tokB = links[1].split('#t=')[1]
        import base64
        idB = json.loads(base64.urlsafe_b64decode(tokB.split('.')[1] + '=='))['i']
        admin(run='revocarToken', args=[idB])
        await asyncio.sleep(8)
        sB = await st(B)
        ok('revocado' in sB['status'] and sB['tokenBox'], 'token revocado -> el iPhone queda fuera y se le pide otro token')

        st_ = admin()['stats']
        ok(st_['options'] == 0, f"cero peticiones OPTIONS en {st_['posts']} POST (compatible con Apps Script)")
        ok(st_['maxInflight'] <= 10, f"máximo {st_['maxInflight']} ejecuciones simultáneas (límite de Apps Script: 30)")
        print('LOG A:\n' + (await A.inner_text('#log'))[:1800])
        await br.close()
    print('E2E MODO NUBE: TODO OK')

asyncio.run(main())
