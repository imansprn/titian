"""Exercise project OAuth PKCE, MCP routing, filesystem roots and terminal cwd.
No project files are modified; credentials are kept in memory.
"""
from pathlib import Path
import urllib.request, urllib.error, urllib.parse, json, secrets, hashlib, base64, re, sys, os, socket
root=Path(__file__).resolve().parent
base=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8300'
if os.environ.get('MCP_TEST_RELAY_IP'):
 original_getaddrinfo=socket.getaddrinfo
 def public_dns(host,port,*args,**kwargs):
  if host==urllib.parse.urlsplit(base).hostname: host=os.environ['MCP_TEST_RELAY_IP']
  return original_getaddrinfo(host,port,*args,**kwargs)
 socket.getaddrinfo=public_dns
projects=json.loads((root/'projects.json').read_text())
if os.environ.get('MCP_TEST_PROJECT'):
 projects=[p for p in projects if p['slug']==os.environ['MCP_TEST_PROJECT']]
 assert projects, 'Requested project not found'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect)
def request(path, data=None, headers=None, method=None):
 headers=headers or {}
 if isinstance(data,dict):
  data=json.dumps(data).encode();headers={'Content-Type':'application/json',**headers}
 req=urllib.request.Request(base+path,data=data,headers=headers,method=method)
 try: response=opener.open(req,timeout=30)
 except urllib.error.HTTPError as e: response=e
 body=response.read().decode()
 return response.status,response.headers,body
def js(body):
 if body.startswith('event:') or body.startswith('data:'):
  body=next(line[6:] for line in body.splitlines() if line.startswith('data: '))
 return json.loads(body)
previous=None
for project in projects:
 slug=project['slug'];prefix='/projects/'+slug;endpoint=prefix+'/mcp'
 status,h,b=request(endpoint)
 assert status==401,(slug,status,b)
 metadata_path=urllib.parse.urlsplit(re.search('resource_metadata="([^"]+)"',h['WWW-Authenticate'])[1]).path
 status,h,b=request(metadata_path);assert status==200
 metadata=js(b);assert metadata['resource']==project['url']
 status,h,b=request('/.well-known/oauth-authorization-server'+prefix);assert status==200
 assert js(b)['issuer']==project['url'][:-4]
 status,h,b=request(prefix+'/register',{'client_name':'Project MCP verification','redirect_uris':['http://127.0.0.1:9876/callback']})
 assert status==201;client=js(b)['client_id']
 verifier=secrets.token_urlsafe(48);challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
 auth={'client_id':client,'redirect_uri':'http://127.0.0.1:9876/callback','response_type':'code','code_challenge_method':'S256','code_challenge':challenge,'state':secrets.token_hex(12),'resource':project['url']}
 status,h,b=request(prefix+'/authorize?'+urllib.parse.urlencode(auth));assert status==200
 assert 'action="'+project['url'][:-4]+'/authorize"' in b
 authid=re.search('name="auth_id" value="([^"]+)"',b)[1]
 data=urllib.parse.urlencode({'auth_id':authid,'decision':'approve','pin':(root/'instances'/slug/'.oauth-consent-pin').read_text().strip()}).encode()
 status,h,b=request(prefix+'/authorize',data,{'Content-Type':'application/x-www-form-urlencoded'});assert status==302
 query=urllib.parse.parse_qs(urllib.parse.urlsplit(h['Location']).query);assert query['state'][0]==auth['state']
 status,h,b=request(prefix+'/token',{'grant_type':'authorization_code','code':query['code'][0],'client_id':client,'redirect_uri':auth['redirect_uri'],'code_verifier':verifier,'resource':project['url']});assert status==200
 token=js(b)['access_token']; refresh=js(b)['refresh_token']
 status,h,b=request(prefix+'/token',{'grant_type':'refresh_token','client_id':client,'refresh_token':refresh});assert status==200
 token=js(b)['access_token']
 status,h,b=request(prefix+'/token',{'grant_type':'client_credentials','client_id':client});assert status==400
 if previous:
  status,h,b=request(endpoint,headers={'Authorization':'Bearer '+previous});assert status==401
 previous=token
 headers={'Authorization':'Bearer '+token,'Accept':'application/json, text/event-stream'}
 seq=0
 def rpc(method,params=None,notify=False):
  global seq
  seq+=1;body={'jsonrpc':'2.0','method':method}
  if not notify:body['id']=seq
  if params is not None:body['params']=params
  status,h,b=request(endpoint,body,headers)
  assert status in (200,202),(slug,method,status,b)
  if h.get('Mcp-Session-Id'):headers['Mcp-Session-Id']=h['Mcp-Session-Id']
  if notify:return None
  result=js(b);assert 'error' not in result,(slug,method,result)
  return result['result']
 init=rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'project-verification','version':'1'}})
 assert init['serverInfo']['name']==slug
 rpc('notifications/initialized',notify=True)
 catalog=rpc('tools/list');assert all(t['name']!='set_config_value' for t in catalog['tools'])
 config=rpc('tools/call',{'name':'get_config','arguments':{}})
 configtext='\n'.join(c.get('text','') for c in config['content'])
 for directory in project['roots']:assert directory in configtext
 for directory in project['roots']:
  result=rpc('tools/call',{'name':'list_directory','arguments':{'path':directory,'depth':1}})
  assert not result.get('isError'),(slug,result)
 denied=rpc('tools/call',{'name':'list_directory','arguments':{'path':str(root.parent),'depth':1}})
 assert denied.get('isError') or 'denied' in str(denied).lower() or 'not allowed' in str(denied).lower(),(slug,denied)
 cwd=rpc('tools/call',{'name':'start_process','arguments':{'command':'pwd','timeout_ms':1000}})
 assert project['roots'][0] in str(cwd),(slug,cwd)
 request(endpoint,headers=headers,method='DELETE')
 print(slug+': PASS OAuth PKCE/refresh, metadata, project token, tools, roots, outside-root rejection, cwd',flush=True)
