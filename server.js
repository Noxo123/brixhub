const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const rawPort = process.env.SERVER_PORT || process.env.PORT || '3000';
const PORT = Number.parseInt(String(rawPort), 10);
if (!Number.isInteger(PORT) || PORT < 0 || PORT >= 65536) {
  console.error(`[BrixHub] Invalid port: ${rawPort}`);
  console.error('[BrixHub] Set Pterodactyl PORT/ SERVER_PORT to the server allocation port.');
  process.exit(1);
}

const BRIXHUB_API_URL = (process.env.BRIXHUB_API_URL || 'https://brixhub.net/api/v1').replace(/\/$/, '');
const BRIXHUB_API_KEY = process.env.BRIXHUB_API_KEY || '';
const MAX_BODY = 64 * 1024;
const RATE_WINDOW = 60_000;
const parsedRate = Number.parseInt(process.env.RATE_LIMIT || '30', 10);
const RATE_MAX = Number.isInteger(parsedRate) && parsedRate > 0 ? parsedRate : 30;
const buckets = new Map();
const PUBLIC_DIR = path.join(__dirname, 'public');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim(); }
function allowed(req) {
  const now = Date.now(), ip = clientIp(req);
  const current = buckets.get(ip) || {start:now,count:0};
  if (now-current.start >= RATE_WINDOW) { current.start=now; current.count=0; }
  current.count++; buckets.set(ip,current);
  return current.count <= RATE_MAX;
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let size=0; const chunks=[];
    req.on('data',chunk=>{ size+=chunk.length; if(size>MAX_BODY){reject(Object.assign(new Error('Request too large'),{status:413})); req.destroy(); return;} chunks.push(chunk); });
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}));}});
    req.on('error',reject);
  });
}
async function brixhub(apiPath, options={}) {
  if(!BRIXHUB_API_KEY) throw Object.assign(new Error('BRIXHUB_API_KEY is not configured'),{status:500});
  const response=await fetch(`${BRIXHUB_API_URL}${apiPath}`,{...options,headers:{Accept:'application/json','Content-Type':'application/json','X-API-Key':BRIXHUB_API_KEY,...(options.headers||{})},signal:AbortSignal.timeout(15000)});
  const text=await response.text(); let data; try{data=JSON.parse(text);}catch{data={message:text||'Invalid upstream response'};}
  if(!response.ok){const error=new Error(data?.message||`BrixHub returned ${response.status}`); error.status=response.status>=500?502:response.status; throw error;}
  return data;
}
function serveFile(res, filePath) {
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
  try { const stat=fs.statSync(filePath); if(!stat.isFile()) return false; const ext=path.extname(filePath); res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'}); fs.createReadStream(filePath).pipe(res); return true; } catch { return false; }
}
function serveFrontend(req,res) {
  let requested=decodeURIComponent(new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname);
  if(requested==='/' || !path.extname(requested)) requested='/index.html';
  const file=path.resolve(PUBLIC_DIR,'.'+requested);
  if(!file.startsWith(PUBLIC_DIR+path.sep)) return false;
  return serveFile(res,file);
}
async function route(req,res) {
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,service:'brixhub',port:PORT,time:new Date().toISOString()});
  if(req.method==='GET' && url.pathname==='/api/config') return json(res,200,{ok:true,configured:Boolean(BRIXHUB_API_KEY),api:'/api/search'});
  if(req.method==='POST' && url.pathname==='/api/search') {
    if(!allowed(req)) return json(res,429,{ok:false,error:'Rate limit exceeded'});
    const payload=await readBody(req);
    if(!payload||typeof payload!=='object'||Array.isArray(payload)) return json(res,400,{ok:false,error:'JSON object expected'});
    const allowedFields=['NomFamille','Prenom','Email','Telephone','Ville','Profession','SIREN','SIRET','DiscordID','SteamID','page','limit'];
    const query={};
    for(const key of allowedFields) if(payload[key]!==undefined&&payload[key]!==null&&String(payload[key]).trim()!=='') query[key]=payload[key];
    if(!Object.keys(query).some(k=>!['page','limit'].includes(k))) return json(res,400,{ok:false,error:'Provide at least one search field'});
    return json(res,200,{ok:true,data:await brixhub('/search',{method:'POST',body:JSON.stringify(query)})});
  }
  if(req.method==='GET' && serveFrontend(req,res)) return;
  return json(res,404,{ok:false,error:'Not found'});
}
const server=http.createServer(async(req,res)=>{try{await route(req,res);}catch(error){console.error(`[${new Date().toISOString()}]`,error);if(!res.headersSent)json(res,error.status||500,{ok:false,error:error.message||'Internal server error'});}});
server.listen(PORT,'0.0.0.0',()=>console.log(`[BrixHub] Listening on 0.0.0.0:${PORT}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
