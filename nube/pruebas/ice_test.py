import json, urllib.request
def admin(**k):
    r=urllib.request.Request('http://127.0.0.1:8787/__admin',data=json.dumps(k).encode(),method='POST'); return json.load(urllib.request.urlopen(r))
def api(**k):
    r=urllib.request.Request('http://127.0.0.1:8787/exec',data=json.dumps(k).encode(),method='POST',headers={'Content-Type':'text/plain'}); return json.load(urllib.request.urlopen(r))
def ok(c,m): print(('✔ ' if c else '✖ FALLA ')+m) or (c or exit(1))
admin(run='configurar')
def ice():
    admin(run='probarTurn'); t=admin(run='crearToken',args=['X',1])['result']
    import random; sess='s%06d'%random.randint(0,999999)
    j=api(action='join',token=t,session=sess); api(action='leave',token=t,session=sess); return j['iceServers'], admin()['logs']
s,_=ice(); ok('turn' not in json.dumps(s) and 'stun' in json.dumps(s),'sin configurar nada -> solo STUN')
admin(setProp=['ICE_SERVERS_URL','https://intercom.metered.live/api/v1/turn/credentials?apiKey=GOODKEY'])
s,_=ice(); ok('global.relay.metered.ca' in json.dumps(s) and all(isinstance(x['urls'],list) for x in s),'ICE_SERVERS_URL (Metered) -> TURN entregado')
admin(setProp=['ICE_SERVERS_URL','https://intercom.metered.live/api/v1/turn/credentials?apiKey=BAD'])
s,_=ice(); ok('turn' not in json.dumps(s),'API key de Metered inválida -> cae a STUN sin romper')
admin(setProp=['ICE_SERVERS_JSON','[{"urls":"turn:free.expressturn.com:3478","username":"efU","credential":"pw"},{"urls":"turn:x:53"}]'])
s,_=ice(); ok('expressturn' in json.dumps(s) and ':53' not in json.dumps(s),'ICE_SERVERS_JSON (ExpressTURN) -> TURN entregado, puerto 53 filtrado')
admin(setProp=['ICE_SERVERS_JSON','esto no es json'])
s,_=ice(); ok('metered' in json.dumps(s) or 'stun' in json.dumps(s),'JSON mal escrito -> no rompe el servicio')
print('ICE OK')
