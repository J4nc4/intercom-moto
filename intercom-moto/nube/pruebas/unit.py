import json, urllib.request, time, re
B='http://127.0.0.1:8787'
def admin(**k):
    r=urllib.request.Request(B+'/__admin',data=json.dumps(k).encode(),method='POST'); return json.load(urllib.request.urlopen(r))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    pass
def api(**k):
    r=urllib.request.Request(B+'/exec',data=json.dumps(k).encode(),method='POST',headers={'Content-Type':'text/plain;charset=utf-8'})
    return json.load(urllib.request.urlopen(r))  # sigue el 302 como el navegador
ok=lambda c,m: print(('✔ ' if c else '✖ FALLA ')+m) or (c or exit(1))

print(admin(run='doGet',args=[{}])['result']['content'])
ok(api(action='join',token='v1.a.b',session='sess1')['detail']=='servidor-sin-configurar','sin configurar -> rechaza')
admin(run='configurar'); admin(setProp=['PAGE_URL','https://usuario.github.io/intercom-moto/'])
admin(setProp=['CF_TURN_KEY_ID','TESTKEY']); admin(setProp=['CF_TURN_API_TOKEN','TESTTOKEN'])
r=admin(run='probarTurn'); print('  probarTurn:', r['logs'][-1])
r=admin(run='crearTokensViaje'); logs=r['logs']; print('  '+'\n  '.join(logs))
links=[l for l in logs if 'Enlace:' in l]; ok(len(links)==2 and '#t=v1.' in links[0],'crearTokensViaje genera 2 enlaces con #t=')
tA=links[0].split('#t=')[1]; tB=links[1].split('#t=')[1]
room=admin(props=1)['props']['SALA']

j=api(action='join',token=tA,session='sesA'); ok(j['ok'] and j['peers']==1 and j['me']=='Piloto','Piloto entra')
urls=json.dumps(j['iceServers']); ok('turn:' in urls and not re.search(r':53[?"]',urls),'TURN entregado y puerto 53 filtrado')
ok('TESTTOKEN' not in json.dumps(j),'la llave de Cloudflare no llega al cliente')
jb=api(action='join',token=tB,session='sesB'); ok(jb['ok'] and jb['peerPresent']=='Piloto','Pasajero entra y ve al Piloto')
p=api(action='poll',token=tA,session='sesA',ack=0); ok(p['msgs'][0]['type']=='start','Piloto recibe start')
api(action='send',token=tA,session='sesA',data={'sdp':{'type':'offer','sdp':'v=0...'}})
pb=api(action='poll',token=tB,session='sesB',ack=0); ok(pb['msgs'][-1]['data']['sdp']['type']=='offer','Pasajero recibe la oferta')
pb2=api(action='poll',token=tB,session='sesB',ack=0); ok(len(pb2['msgs'])==1,'sin ack el mensaje se reenvía (no se pierde)')
pb3=api(action='poll',token=tB,session='sesB',ack=pb['msgs'][-1]['s']); ok(len(pb3['msgs'])==0,'con ack se borra')
# seguridad
bad=tA[:-3]+('AAA' if not tA.endswith('AAA') else 'BBB')
ok(api(action='poll',token=bad,session='sesA')['detail']=='firma','firma alterada -> rechazo')
forged=tA.split('.'); 
import base64
claims=json.loads(base64.urlsafe_b64decode(forged[1]+'==')); claims['n']='Intruso'; claims['i']='otro'
forged[1]=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
ok(api(action='join',token='.'.join(forged),session='x1234')['detail']=='firma','datos modificados con firma vieja -> rechazo')
ok(api(action='join',token='',session='x1234')['detail']=='formato','token vacío -> rechazo')
ok(api(action='join',session='x1234')['error']=='token','sin token -> rechazo')
tC=admin(run='crearToken',args=['Intruso',30])['result']
ok(api(action='join',token=tC,session='sesC')['error']=='full','tercer token válido -> sala llena')
ok(api(action='send',token=tC,session='sesC',data={'x':1})['error']=='not-joined','tercero no puede enviar mensajes')
# vencimiento
tE=admin(run='crearToken',args=['Corto',1])['result']; admin(advanceMs=2*24*3600*1000)
ok(api(action='join',token=tE,session='sesE')['detail']=='vencido','token vencido -> rechazo')
admin(advanceMs=-2*24*3600*1000)
# revocar
idA=json.loads(base64.urlsafe_b64decode(tA.split('.')[1]+'=='))['i']
admin(run='revocarToken',args=[idA])
ok(api(action='poll',token=tA,session='sesA',ack=0)['detail']=='revocado','token revocado -> rechazo')
# timeout por inactividad (10 min) libera el puesto y avisa al otro
admin(advanceMs=6*60*1000); api(action='poll',token=tB,session='sesB',ack=0)
admin(advanceMs=5*60*1000)
pb=api(action='poll',token=tB,session='sesB',ack=0)
ok(any(m['type']=='peer-left' for m in pb['msgs']) and pb['peers']==1,'10 min sin consultar -> sale y se avisa al otro')
# 9 min bloqueado NO saca a nadie
tA2=admin(run='crearToken',args=['Piloto2',30])['result']
jj=api(action='join',token=tA2,session='ses2'); print('  join A2:',jj.get('ok'),jj.get('error'),jj.get('peers')); admin(advanceMs=9*60*1000)
pp=api(action='poll',token=tB,session='sesB',ack=999); print('  poll:',{k:pp[k] for k in pp if k!='msgs'}); ok(pp.get('peers')==2,'9 min sin consultar (pantalla bloqueada) -> conserva el puesto')
# revocarTodos
admin(run='revocarTodos')
ok(api(action='poll',token=tB,session='sesB',ack=0)['detail']=='firma','revocarTodos invalida los tokens existentes')
st=admin()['stats']; ok(st['options']==0,'ninguna petición OPTIONS (sin CORS preflight)'); print('  stats',st)
# tamaño: muchos candidatos no rompen el límite de 100 KB
admin(run='configurar'); t1=admin(run='crearToken',args=['P1',1])['result']; t2=admin(run='crearToken',args=['P2',1])['result']
admin(advanceMs=11*60*1000)
ok(api(action='join',token=t1,session='qq11')['ok'] and api(action='join',token=t2,session='qq22')['ok'],'sala vacía tras 11 min; entran dos nuevos')
for i in range(150): api(action='send',token=t1,session='qq11',data={'candidate':{'candidate':'candidate:'+'x'*900,'sdpMid':'0'}})
room=admin(room=admin()['props']['SALA'])['result']; size=len(json.dumps(room))
ok(size<100*1024,f'sala bajo el límite de CacheService ({size} bytes)')
print('TODAS LAS PRUEBAS DEL SCRIPT PASARON')
