const express=require("express");
const fs=require("fs");
const path=require("path");
const cron=require("node-cron");
require("dotenv").config();

const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

const PORT=+process.env.PORT||3000;
const KEY=process.env.API_FOOTBALL_KEY||"";
const TZ=process.env.TIMEZONE||"Europe/Paris";
const MAX_ENRICH=+process.env.MAX_ENRICH||20;
const MAX_ODDS=+process.env.MAX_ODDS||20;
const MAX_DETAILS=+process.env.MAX_DETAILS||12;
const CACHE_HOURS=+process.env.CACHE_HOURS||6;
const DATA=path.join(__dirname,"data");
const STORE=path.join(DATA,"store.json");
fs.mkdirSync(DATA,{recursive:true});

const blank=()=>({matches:{},predictions:[],history:[],meta:{updatedAt:null,requests:0}});
function read(){try{return JSON.parse(fs.readFileSync(STORE,"utf8"))}catch{return blank()}}
function write(x){fs.writeFileSync(STORE,JSON.stringify(x,null,2))}
function today(){
  const p=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const o=Object.fromEntries(p.map(x=>[x.type,x.value])); return `${o.year}-${o.month}-${o.day}`;
}
function clamp(x,a=0,b=1){return Math.max(a,Math.min(b,x))}
function norm(a,b,c){const s=a+b+c||1;return {home:a/s,draw:b/s,away:c/s}}
function poisson(k,l){if(l<=0)return k?0:1;let p=Math.exp(-l);for(let i=1;i<=k;i++)p*=l/i;return p}
function implied(o){return o>1?1/o:null}
function blend(a,b,w){return a*w+b*(1-w)}
async function api(endpoint,params={}){
 if(!KEY)throw Error("API_FOOTBALL_KEY missing");
 const u=new URL("https://v3.football.api-sports.io/"+endpoint);
 for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
 const r=await fetch(u,{headers:{"x-apisports-key":KEY}});
 if(!r.ok)throw Error("Provider HTTP "+r.status);
 const j=await r.json(); if(j.errors&&Object.keys(j.errors).length)throw Error(JSON.stringify(j.errors));
 return j;
}
function statMap(x){
 const out={};
 for(const s of (x||[])){let k=String(s.type||"").toLowerCase().replaceAll(" ","_");let h=parseFloat(s.home),a=parseFloat(s.away);if(Number.isFinite(h)||Number.isFinite(a))out[k]={home:h,away:a}}
 return out;
}
function resultFromScore(s){
 const h=Number(s?.home),a=Number(s?.away);
 if(!Number.isFinite(h)||!Number.isFinite(a))return null;
 return h>a?"home":h<a?"away":"draw";
}
function model(m){
 const pp=m.provider;
 let provider=pp?.home!=null?norm(pp.home,pp.draw,pp.away):null;
 const odds=m.odds||{};
 const oh=implied(+odds.home),od=implied(+odds.draw),oa=implied(+odds.away);
 let market=(oh&&od&&oa)?norm(oh,od,oa):null;

 // Form/goal signal. Missing values are deliberately ignored rather than invented.
 const f=m.form||{};
 const fh=Number(f.home),fa=Number(f.away);
 const form=Number.isFinite(fh)&&Number.isFinite(fa)?norm(.42+.20*fh,.29,.42+.20*fa):null;

 let p=provider||market||form||{home:.40,draw:.29,away:.31};
 if(provider&&market)p={home:blend(provider.home,market.home,.60),draw:blend(provider.draw,market.draw,.60),away:blend(provider.away,market.away,.60)};
 if(form)p={home:blend(p.home,form.home,.72),draw:blend(p.draw,form.draw,.72),away:blend(p.away,form.away,.72)};
 p=norm(p.home,p.draw,p.away);

 const lambdaHome=clamp(1.35+(Number(m.stats?.home_xg)||0)*.10,0.55,2.7);
 const lambdaAway=clamp(1.05+(Number(m.stats?.away_xg)||0)*.10,0.45,2.5);
 let hw=0,d=0,aw=0,over25=0,btts=0;
 for(let h=0;h<=8;h++)for(let a=0;a<=8;a++){
   const q=poisson(h,lambdaHome)*poisson(a,lambdaAway);
   if(h>a)hw+=q;else if(h===a)d+=q;else aw+=q;
   if(h+a>=3)over25+=q;
   if(h>0&&a>0)btts+=q;
 }
 const score=norm(.55*hw+.45*p.home,.55*d+.45*p.draw,.55*aw+.45*p.away);
 const completeness=[provider,market,form,m.injuries?.known,m.lineups?.available,m.stats?.available].filter(Boolean).length/6;
 const confidence=Math.round(100*clamp(.50*Math.max(score.home,score.draw,score.away)+.50*completeness));
 return {
   oneXtwo:Object.fromEntries(Object.entries(score).map(([k,v])=>[k,+(+v*100).toFixed(1)])),
   doubleChance:{
     "1X":+(100*(score.home+score.draw)).toFixed(1),
     "X2":+(100*(score.draw+score.away)).toFixed(1),
     "12":+(100*(score.home+score.away)).toFixed(1)
   },
   goals:{
     over05:+(100*(1-poisson(0,lambdaHome+lambdaAway))).toFixed(1),
     over15:+(100*(1-poisson(0,lambdaHome+lambdaAway)-poisson(1,lambdaHome+lambdaAway))).toFixed(1),
     over25:+(100*over25).toFixed(1),
     under25:+(100*(1-over25)).toFixed(1),
     over35:+(100*(1-[0,1,2,3].reduce((s,k)=>s+poisson(k,lambdaHome+lambdaAway),0))).toFixed(1)
   },
   btts:{yes:+(100*btts).toFixed(1),no:+(100*(1-btts)).toFixed(1)},
   expectedGoals:{home:+lambdaHome.toFixed(2),away:+lambdaAway.toFixed(2),total:+(lambdaHome+lambdaAway).toFixed(2)},
   confidence,
   completeness:+(100*completeness).toFixed(0),
   edge:market?{
     home:+(100*(score.home-(oh||0))).toFixed(1),
     draw:+(100*(score.draw-(od||0))).toFixed(1),
     away:+(100*(score.away-(oa||0))).toFixed(1)
   }:null,
   modelVersion:"FMAP-2.0 / provider + market + form + Poisson"
 };
}
async function enrichMatch(m){
 try{
  const r=await api("predictions",{fixture:m.id});
  const x=r.response?.[0]?.predictions;
  const ph=parseFloat(String(x?.percent?.home||"").replace("%",""))/100;
  const pd=parseFloat(String(x?.percent?.draw||"").replace("%",""))/100;
  const pa=parseFloat(String(x?.percent?.away||"").replace("%",""))/100;
  if([ph,pd,pa].every(Number.isFinite))m.provider={home:ph,draw:pd,away:pa};
 }catch{}
 return m;
}
async function details(m){
 try{
  const [s,inj,lu]=await Promise.all([
    api("fixtures/statistics",{fixture:m.id}),
    api("injuries",{fixture:m.id}),
    api("fixtures/lineups",{fixture:m.id})
  ]);
  const ss=s.response||[];
  m.stats={available:true,raw:ss};
  // xG is not always supplied. Only use it if provider actually returns it.
  for(const side of ss){
    if(side.team?.id===m.home.id) for(const z of side.statistics||[]) if(String(z.type).toLowerCase()==="expected_goals")m.stats.home_xg=parseFloat(z.value);
    if(side.team?.id===m.away.id) for(const z of side.statistics||[]) if(String(z.type).toLowerCase()==="expected_goals")m.stats.away_xg=parseFloat(z.value);
  }
  m.injuries={known:(inj.response||[]).length>0,count:(inj.response||[]).length};
  m.lineups={available:(lu.response||[]).length>0};
 }catch{}
 return m;
}
async function odds(m){
 try{
  const r=await api("odds",{fixture:m.id});
  const b=r.response?.[0]?.bookmakers?.[0]?.bets||[];
  const bet=b.find(x=>x.name==="Match Winner");
  if(bet){const vals=Object.fromEntries((bet.values||[]).map(v=>[v.value,+v.odd]));
    m.odds={home:vals.Home,draw:vals.Draw,away:vals.Away};}
 }catch{}
 return m;
}
async function refresh(date=today()){
 const store=read();
 const f=await api("fixtures",{date});
 let ms=(f.response||[]).map(x=>({
  id:x.fixture.id,date:x.fixture.date,status:x.fixture.status?.short,
  league:{id:x.league.id,name:x.league.name,country:x.league.country,logo:x.league.logo},
  home:{id:x.teams.home.id,name:x.teams.home.name,logo:x.teams.home.logo},
  away:{id:x.teams.away.id,name:x.teams.away.name,logo:x.teams.away.logo},
  score:x.goals||null
 }));
 for(let i=0;i<Math.min(MAX_ENRICH,ms.length);i++)await enrichMatch(ms[i]);
 for(let i=0;i<Math.min(MAX_ODDS,ms.length);i++)await odds(ms[i]);
 for(let i=0;i<Math.min(MAX_DETAILS,ms.length);i++)await details(ms[i]);
 ms.forEach(m=>m.prediction=model(m));
 store.matches[date]=ms;
 store.meta.updatedAt=new Date().toISOString();
 store.meta.requests=(store.meta.requests||0)+1;
 write(store);
 return ms;
}
function settle(){
 const s=read(), now=Date.now();
 for(const [date,ms] of Object.entries(s.matches||{})){
  for(const m of ms){
   if(!m.score||m.status==="NS")continue;
   const actual=resultFromScore(m.score);
   if(!actual||m.settled)continue;
   const p=m.prediction?.oneXtwo||{};
   const ph=(p.home||0)/100,pd=(p.draw||0)/100,pa=(p.away||0)/100;
   const brier=(ph-(actual==="home"?1:0))**2+(pd-(actual==="draw"?1:0))**2+(pa-(actual==="away"?1:0))**2;
   s.history.push({id:m.id,date,actual,prediction:p,brier:+brier.toFixed(6),confidence:m.prediction?.confidence||0,settledAt:new Date().toISOString()});
   m.settled=true;
  }
 }
 s.history=s.history.slice(-5000); write(s);
}
app.get("/api/status",(q,res)=>{const s=read();res.json({ok:true,today:today(),apiConfigured:!!KEY,updatedAt:s.meta.updatedAt,requests:s.meta.requests||0,history:s.history.length})});
app.get("/api/matches",async(q,res)=>{
 const date=q.query.date||today(),s=read(), old=s.matches[date];
 if(old?.length && s.meta.updatedAt && (Date.now()-new Date(s.meta.updatedAt).getTime())<CACHE_HOURS*3600000)return res.json({date,source:"cache",updatedAt:s.meta.updatedAt,matches:old});
 if(!KEY)return res.status(503).json({error:"ضع API_FOOTBALL_KEY في ملف .env"});
 try{const ms=await refresh(date);res.json({date,source:"live",updatedAt:new Date().toISOString(),matches:ms})}
 catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/refresh",async(q,res)=>{if(!KEY)return res.status(503).json({error:"API key missing"});try{const ms=await refresh(q.body?.date||today());res.json({ok:true,count:ms.length})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/history",(q,res)=>{const s=read(),h=s.history||[];const n=h.length;const avg=n?h.reduce((a,x)=>a+x.brier,0)/n:null;const hits=n?h.filter(x=>x.prediction?.[x.actual]>=50).length/n:null;res.json({count:n,avgBrier:avg,highProbabilityHitRate:hits,items:h.slice(-100).reverse()})});
app.get("/api/match/:id",(q,res)=>{const s=read();for(const ms of Object.values(s.matches))for(const m of ms)if(String(m.id)===String(q.params.id))return res.json(m);res.status(404).json({error:"not found"})});
app.listen(PORT,()=>console.log(`Football Analyzer Pro on :${PORT}`));
cron.schedule(process.env.CRON_SCHEDULE||"0 6 * * *",async()=>{if(KEY)try{await refresh(today());settle();console.log("daily refresh ok")}catch(e){console.error(e.message)}},{timezone:TZ});
cron.schedule(process.env.SETTLE_SCHEDULE||"*/30 * * * *",()=>{try{settle()}catch(e){console.error(e.message)}},{timezone:TZ});
