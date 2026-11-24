import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const [runDir, worktreeRoot, portValue] = process.argv.slice(2);
if (!runDir || !worktreeRoot || !portValue) throw new Error('Expected run directory, worktree root, and port.');
if (path.parse(runDir).root.slice(0,2).toUpperCase() !== 'C:' || path.parse(worktreeRoot).root.slice(0,2).toUpperCase() !== 'C:') {
  throw new Error('Dashboard paths must be on C:.');
}
const port = Number(portValue);
const agentDefs = [
  ['backend','backend'],['tourism-data','tourism-data'],['frontend','frontend'],
  ['itinerary','itinerary'],['qa','qa'],['integration','integration']
];
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'mission_control.html'));
const statusPath = path.join(runDir,'run-status.json');
const stopPath = path.join(runDir,'dashboard-stop');
let previousCpu = null;
let shuttingDown = false;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } }
function safeText(value) { return String(value||'').replace(/Bearer\s+[^\s,;]+/gi,'Bearer [REDACTED]').replace(/sb_secret_[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]').replace(/:\/\/[^/@\s]+:[^/@\s]+@/g,'://[REDACTED]@'); }
function readJsonLines(file, limit=12) {
  try { return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).slice(-limit).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}); } catch { return []; }
}
function existsEvidence(workspace, evidence) {
  if (typeof evidence !== 'string' || !evidence || path.isAbsolute(evidence)) return false;
  const root = path.resolve(workspace);
  const candidate = path.resolve(root,evidence);
  return candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
}
function duration(started) {
  if (!started) return null;
  const ms = Date.now()-Date.parse(started);
  if (!Number.isFinite(ms) || ms<0) return null;
  const seconds=Math.floor(ms/1000), h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=seconds%60;
  return [h,m,s].map(x=>String(x).padStart(2,'0')).join(':');
}
function systemResources() {
  const cpus=os.cpus();
  let cpuPercent=null;
  if(previousCpu){
    let total=0,idle=0;
    cpus.forEach((c,i)=>{const p=previousCpu[i];if(!p)return;for(const k of Object.keys(c.times)){const d=c.times[k]-p.times[k];total+=d;if(k==='idle')idle+=d}});
    if(total>0)cpuPercent=Math.round((1-idle/total)*100);
  }
  previousCpu=cpus.map(c=>({times:{...c.times}}));
  return {cpu_percent:cpuPercent,memory_used_gb:Number(((os.totalmem()-os.freemem())/1073741824).toFixed(2)),memory_total_gb:Number((os.totalmem()/1073741824).toFixed(2))};
}
function cleanCheckpoint(workspace) {
  const c=readJson(path.join(workspace,'.overnight','progress.json'));
  if(!c || typeof c!=='object') return null;
  const milestones=Array.isArray(c.milestones)?c.milestones:[];
  const completed=milestones.filter(m=>m && m.status==='completed' && existsEvidence(workspace,m.evidence));
    const tests=checkpoint?checkpoint.tests:[];
  const metrics={};
  const allowed=['attractions_collected','hotels_collected','restaurants_collected','cities_completed','itineraries_generated','itineraries_validated'];
  for(const key of allowed){
    const v=c.metrics&&c.metrics[key];
    if(v && v.verified===true && v.mock!==true && Number.isFinite(Number(v.value)) && Number(v.value)>=0 && existsEvidence(workspace,v.evidence)) metrics[key]=Number(v.value);
  }
  return {
    current_task:typeof c.current==='string'?safeText(c.current):null,
    completed_milestones:completed.map(m=>safeText(m.name||'Milestone')),
    progress_percent:milestones.length?Math.round(completed.length/milestones.length*100):null,
    tests,
    metrics,
    blockers:Array.isArray(c.blockers)?c.blockers.map(safeText).slice(0,10):[],
    errors:Array.isArray(c.errors)?c.errors.map(safeText).slice(0,10):[],
    checkpoint_status:typeof c.status==='string'?c.status:null
  };
}
function buildStatus() {
  const run=readJson(statusPath)||{};
  const storage=readJson(path.join(runDir,'storage-state.json'));
  const agents=[];
  const totals={};
  for(const [name,dir] of agentDefs){
    const workspace=path.join(worktreeRoot,dir);
    const state=readJson(path.join(runDir,'agents',name+'.json'));
    const checkpoint=cleanCheckpoint(workspace);
    const runnerPid=state&&Number(state.runner_pid||state.process_id);
    const cliPids=state&&Array.isArray(state.codex_process_ids)?state.codex_process_ids.map(Number).filter(p=>{try{process.kill(p,0);return true}catch{return false}}):[];
    const pid=cliPids[0]||runnerPid;
    let alive=false,resource='unavailable';
    if(pid){try{process.kill(pid,0);alive=true}catch{}}
    let status=state&&state.status||'not_started';
    if(status==='running'&&!alive)status='stopped';
    const tests=checkpoint?checkpoint.tests:[];
    for(const t of tests){if(t.result==='passed')totals.tests_passed=(totals.tests_passed||0)+1;if(t.result==='failed')totals.tests_failed=(totals.tests_failed||0)+1}
    if(checkpoint) for(const [k,v] of Object.entries(checkpoint.metrics)) totals[k]=(totals[k]||0)+v;
    const events=readJsonLines(path.join(runDir,'logs',name+'.jsonl'),8);
    const eventErrors=readJsonLines(path.join(runDir,'logs',name+'.jsonl'),40).filter(e=>/error|failed/i.test(String(e.event||''))).map(e=>String(e.event));
    agents.push({
      agent:name,status,process_id:pid||null,runner_pid:runnerPid||null,codex_process_ids:cliPids,attempt:state&&state.attempt||0,
      elapsed:duration(state&&(state.first_started_at_utc||state.started_at_utc)||run.started_at_utc),
      current_task:checkpoint&&checkpoint.current_task,
      progress_percent:checkpoint&&checkpoint.progress_percent,
      completed_milestones:checkpoint?checkpoint.completed_milestones:[],
      tests,blockers:checkpoint?checkpoint.blockers:[],errors:[...(checkpoint?checkpoint.errors:[]),...eventErrors],
      resource_usage:resource,recent_activity:events.map(e=>({at:e.timestamp_utc,event:e.event,attempt:e.attempt}))
    });
  }
  const recent=agentDefs.flatMap(([name])=>readJsonLines(path.join(runDir,'logs',name+'.jsonl'),8).map(e=>({agent:name,at:e.timestamp_utc,event:e.event,attempt:e.attempt})))
    .concat(readJsonLines(path.join(runDir,'logs','storage.jsonl'),8).map(e=>({agent:'storage',at:e.timestamp_utc,event:e.event,free_gb:e.free_gb,status:e.status})))
    .sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))).slice(0,24);
  return {
    run_id:run.run_id||path.basename(runDir),run_status:run.status||'unknown',
    started_at_utc:run.started_at_utc||null,agents,
    metrics:totals,storage:storage?{free_gb:storage.free_gb,status:storage.status,checked_at_utc:storage.checked_at_utc}:null,
    resources:systemResources(),recent_activity:recent
  };
}
const server=http.createServer((req,res)=>{
  const remote=req.socket.remoteAddress||'';
  const expectedHost='127.0.0.1:'+port;
  if(String(req.headers.host||'').toLowerCase()!==expectedHost.toLowerCase()){res.writeHead(403);res.end();return}
  if(remote!=='127.0.0.1' && remote!=='::ffff:127.0.0.1' && remote!=='::1'){res.writeHead(403);res.end();return}
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
  const url=new URL(req.url||'/', 'http://127.0.0.1:'+port);
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
  if(req.method==='GET'&&url.pathname==='/api/status'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(buildStatus()));return}
  if(req.method==='POST'&&url.pathname==='/api/shutdown'&&(!req.headers.origin||req.headers.origin==='http://127.0.0.1:'+port)){res.writeHead(202,{'Content-Type':'application/json'});res.end('{"status":"stopping"}');shuttingDown=true;server.close(()=>process.exit(0));return}
  res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not found"}');
});
server.listen(port,'127.0.0.1',()=>{
  fs.writeFileSync(path.join(runDir,'dashboard-status.json'),JSON.stringify({status:'ready',pid:process.pid,url:'http://127.0.0.1:'+port+'/',started_at_utc:new Date().toISOString()},null,2));
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
