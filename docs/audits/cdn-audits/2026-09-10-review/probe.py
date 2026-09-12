"""Read-only, serial CDN audit probes. No credentials, retries or cache busters."""
import datetime, hashlib, json, pathlib, re, subprocess, tempfile, urllib.parse
OUT=pathlib.Path(__file__).resolve().parent
BASE='https://magicbooklet.com'
rows=[]
def probe(label,url,headers=None):
 headers=headers or {}
 with tempfile.TemporaryDirectory() as td:
  h=pathlib.Path(td)/'headers'; b=pathlib.Path(td)/'body'
  cmd=['curl','--silent','--show-error','--compressed','--connect-timeout','5','--max-time','15','--max-filesize','2000000','-D',str(h),'-o',str(b),'-w','%{json}',url]
  for k,v in headers.items(): cmd.extend(['-H',k+': '+v])
  at=datetime.datetime.now(datetime.timezone.utc).isoformat(); p=subprocess.run(cmd,capture_output=True,text=True)
  try: timing=json.loads(p.stdout)
  except ValueError: timing={}
  hs={}
  for line in h.read_text().splitlines() if h.exists() else []:
   if ': ' in line:
    k,v=line.split(': ',1); hs[k.lower()]=v
  body=b.read_bytes() if b.exists() else b''
  row=dict(label=label,url=url,time_utc=at,request_headers=headers,curl_exit=p.returncode,status=timing.get('http_code'),ttfb_ms=round(timing.get('time_starttransfer',0)*1000,2),total_ms=round(timing.get('time_total',0)*1000,2),wire_bytes=timing.get('size_download'),decoded_bytes=len(body),body_sha256=hashlib.sha256(body).hexdigest(),set_cookie_present='set-cookie' in hs,headers={k:v for k,v in hs.items() if k in ['cache-control','cdn-cache-control','vercel-cdn-cache-control','x-vercel-cache','age','vary','etag','content-type','content-range','content-length','content-encoding','x-vercel-id','cf-cache-status','cf-ray','date','x-matched-path']})
  if 'text/html' in hs.get('content-type',''):
   styles=re.findall(rb'<style\b[^>]*>(.*?)</style>',body,re.S|re.I)
   row['literal_style_bytes']=sum(map(len,styles)); row['style_tags']=len(styles)
   row['stylesheet_hrefs']=[x.decode() for x in re.findall(rb'<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"',body)]
  if label.startswith('build'): row['body']=json.loads(body)
  rows.append(row); (OUT/'http-probes.json').write_text(json.dumps(rows,indent=2)+'\n')
  print(label,row['status'],hs.get('x-vercel-cache',hs.get('cf-cache-status')),row['decoded_bytes'],row.get('literal_style_bytes'),flush=True)
  return row,body
probe('build-start',BASE+'/api/app-version')
for label,path in [('home','/'),('showcase','/showcase'),('marketplace','/marketplace'),('blog','/blog'),('catalog','/api/generation-models?platform=web&schemaVersion=3'),('recent','/api/showcase/feed?sort=recent&limit=12'),('resources','/api/marketplace/resources?limit=12')]:
 for i in range(3): probe(label+'-'+str(i+1),BASE+path)
for label,path,headers in [
 ('recent-invalid-bearer','/api/showcase/feed?sort=recent&limit=12',{'Authorization':'Bearer cdn-audit-invalid'}),
 ('resources-invalid-bearer','/api/marketplace/resources?limit=12',{'Authorization':'Bearer cdn-audit-invalid'}),
 ('recent-harmless-cookie','/api/showcase/feed?sort=recent&limit=12',{'Cookie':'cdn-audit=1'}),
 ('recent-invalid-auth-cookie','/api/showcase/feed?sort=recent&limit=12',{'Cookie':'sb-ildfmhozpibwiopeavfg-auth-token=invalid'}),
 ('showcase-invalid-auth-cookie','/showcase',{'Cookie':'sb-ildfmhozpibwiopeavfg-auth-token=invalid'}),
 ('marketplace-invalid-auth-cookie','/marketplace',{'Cookie':'sb-ildfmhozpibwiopeavfg-auth-token=invalid'}),
 ('showcase-query','/showcase?sort=recent',{}),
 ('marketplace-query','/marketplace?access=free',{}),
 ('showcase-rsc','/showcase',{'RSC':'1'}),
 ('marketplace-rsc','/marketplace',{'RSC':'1'}),
 ('private-no-auth','/api/media?bucket=generated_images&path=cdn-audit-nonexistent.webp',{}),
 ('private-invalid-bearer','/api/media?bucket=generated_images&path=cdn-audit-nonexistent.webp',{'Authorization':'Bearer cdn-audit-invalid'}),
 ('for-you','/api/showcase/feed?sort=for-you&limit=1',{})]: probe(label,BASE+path,headers)
old=json.loads((OUT.parent/'2026-09-10'/'http-probes.json').read_text())
for target in ['poster-0-0','renditionUrl-0']:
 url=next(r['url'] for r in old if r['target']==target)
 for i in range(2):
  probe(target+'-range-'+str(i+1),url,{'Range':'bytes=0-1023'})
  if target=='poster-0-0': probe(target+'-full-'+str(i+1),url)
css=next((r['stylesheet_hrefs'][0] for r in rows if r.get('stylesheet_hrefs')), next(r['url'] for r in old if r['url'].endswith('.css')))
# With inlineCss enabled, an external stylesheet link may be absent; the
# fallback probes the prior audit's observed static asset, not HTML reuse.
for i in range(2): probe('css-'+str(i+1),urllib.parse.urljoin(BASE,css))
probe('build-end',BASE+'/api/app-version')
