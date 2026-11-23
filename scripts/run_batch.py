#!/usr/bin/env python3
import argparse,json,time,urllib.request,urllib.error
def main():
 p=argparse.ArgumentParser();p.add_argument("--worker-url",required=True);p.add_argument("--admin-token",required=True)
 p.add_argument("--calls",type=int,default=100);p.add_argument("--cities-per-call",type=int,default=1,help="Compatibility option; each Worker request processes one five-item chunk")
 p.add_argument("--delay",type=int,default=30)
 p.add_argument("--radius-km",type=int,choices=[30,40,50]);a=p.parse_args()
 for i in range(a.calls):
  url=a.worker_url.rstrip("/")+"/admin/collect"
  if a.radius_km:url+=f"?radiusKm={a.radius_km}"
  req=urllib.request.Request(url,data=b"{}",headers={"Authorization":"Bearer "+a.admin_token,"Content-Type":"application/json"},method="POST")
  try:
   with urllib.request.urlopen(req,timeout=180) as r:
    body=r.read().decode();result=json.loads(body);print(f"{i+1}/{a.calls} HTTP {r.status}: {body}")
    if result.get("status")=="idle":print("No pending cities.");break
    if result.get("processed",0)==0 and result.get("remaining",0)>0:
     time.sleep(max(a.delay,300))
  except urllib.error.HTTPError as e:
   print("HTTP",e.code,e.read().decode()[:500])
   if e.code not in (429,500,502,503,504):raise
   time.sleep(max(a.delay,90))
  time.sleep(a.delay)
if __name__=="__main__":main()
