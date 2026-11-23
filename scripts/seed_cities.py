#!/usr/bin/env python3
import argparse,csv,io,json,os,urllib.request,zipfile
URL="https://download.geonames.org/export/dump/cities500.zip"
COLS=["geonameid","name","asciiname","alternatenames","latitude","longitude","feature_class","feature_code","country_code","cc2","admin1","admin2","admin3","admin4","population","elevation","dem","timezone","modification_date"]
def get(url):
 req=urllib.request.Request(url,headers={"User-Agent":"IndiaTourismCitySeeder/1.0"})
 with urllib.request.urlopen(req,timeout=180) as r:return r.read()
def main():
 ap=argparse.ArgumentParser()
 ap.add_argument("--supabase-url",default=os.environ.get("SUPABASE_URL"))
 ap.add_argument("--supabase-secret-key","--service-role-key",dest="supabase_secret_key",default=os.environ.get("SUPABASE_SECRET_KEY"))
 ap.add_argument("--limit",type=int,default=500);ap.add_argument("--csv")
 a=ap.parse_args()
 if not a.supabase_url or not a.supabase_secret_key:
  ap.error("Set SUPABASE_URL and SUPABASE_SECRET_KEY, or pass --supabase-url and --supabase-secret-key")
 if not 1<=a.limit<=500:
  ap.error("--limit must be between 1 and 500")
 if a.csv:
  with open(a.csv,encoding="utf-8-sig",newline="") as f: raw=list(csv.DictReader(f))
  cities=[{"name":x["name"],"state_name":x.get("state_name"),"latitude":float(x["latitude"]),"longitude":float(x["longitude"]),"population":int(x["population"]) if x.get("population") else None,"city_source":"curated","country_code":"IN","radius_km":40} for x in raw[:a.limit]]
 else:
  z=zipfile.ZipFile(io.BytesIO(get(URL)));records=[]
  for line in io.TextIOWrapper(z.open(z.namelist()[0]),encoding="utf-8"):
   v=line.rstrip("\n").split("\t")
   if len(v)<19 or v[8]!="IN" or v[6]!="P":continue
   try:lat,lon=float(v[4]),float(v[5])
   except ValueError:continue
   records.append({"geonames_id":int(v[0]),"name":v[1],"latitude":lat,"longitude":lon,"population":int(v[14] or 0),"city_source":"GeoNames","country_code":"IN","radius_km":40,"state_name":v[10] or None})
  records.sort(key=lambda x:x["population"],reverse=True);seen=set();cities=[]
  for x in records:
   k=(x["name"].lower(),round(x["latitude"],2),round(x["longitude"],2))
   if k in seen:continue
   seen.add(k);cities.append(x)
   if len(cities)>=a.limit:break
 if not cities:raise SystemExit("No city records found")
 url=a.supabase_url.rstrip("/")+"/rest/v1/tourism_cities?on_conflict=geonames_id"
 headers={"apikey":a.supabase_secret_key,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"}
 if not a.supabase_secret_key.startswith("sb_secret_"):
  headers["Authorization"]="Bearer "+a.supabase_secret_key
 for i in range(0,len(cities),100):
  req=urllib.request.Request(url,data=json.dumps(cities[i:i+100]).encode(),headers=headers,method="POST")
  with urllib.request.urlopen(req,timeout=90) as r:print("Uploaded",len(cities[i:i+100]),"HTTP",r.status)
 print("Imported",len(cities),"cities. Review city list before running collection.")
if __name__=="__main__":main()
