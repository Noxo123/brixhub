const http=require('node:http');
const {URL}=require('node:url');
const fs=require('node:fs');
const path=require('node:path');

const APP_DIR=__dirname;
const GITHUB_API='https://api.github.com/repos/Noxo123/brixhub';
const BRANCH=process.env.BRANCH||'main';
const AUTO_UPDATE=String(process.env.AUTO_UPDATE??'true').toLowerCase()!=='false';
const UPDATE_INTERVAL=Math.max(30,Number.parseInt(process.env.UPDATE_INTERVAL||'300',10))*1000;
const rawPort=process.env.SERVER_PORT||process.env.PORT||'3000';
const PORT=Number.parseInt(String(rawPort),10);
const BRIXHUB_API_URL=(process.env.BRIXHUB_API_URL||'https://api.brixhub.to/api/v1').replace(/\/$/,'');
const BRIXHUB_API_KEY=process.env.BRIXHUB_API_KEY||'';
const MAX_BODY=64*1024,RATE_WINDOW=60000;
const n=Number.parseInt(process.env.RATE_LIMIT||'30',10),RATE_MAX=Number.isInteger(n)&&n>0?n:30;
const buckets=new Map();
let updating=false;

if(!Number.isInteger(PORT)||PORT<0||PORT>=65536){console.error(`[BrixHub] Invalid port: ${rawPort}`);process.exit(1)}

async function github(pathname,options={}){
 const r=await fetch(`${GITHUB_API}${pathname}`,{...options,headers:{Accept:'application/vnd.github+json','User-Agent':'BrixHub-Pterodactyl',...(options.headers||{})},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(`GitHub API ${r.status}`);
 return r.json();
}
async function githubFile(file){
 const data=await github(`/contents/${file}?ref=${encodeURIComponent(BRANCH)}`);
 if(data.type!=='file'||!data.download_url)throw new Error(`GitHub file unavailable: ${file}`);
 const r=await fetch(data.download_url,{headers:{'User-Agent':'BrixHub-Pterodactyl'},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error(`GitHub download ${r.status}: ${file}`);
 return Buffer.from(await r.arrayBuffer());
}
async function listTree(){
 const ref=await github(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
 const tree=await github(`/git/trees/${ref.object.sha}?recursive=1`);
 return {sha:ref.object.sha,files:tree.tree.filter(x=>x.type==='blob').map(x=>x.path)};
}
async function selfUpdate(){
 if(!AUTO_UPDATE||updating)return false;
 updating=true;
 try{
  const stateFile=path.join(APP_DIR,'.brixhub-update.json');
  let local={sha:null};
  try{local=JSON.parse(fs.readFileSync(stateFile,'utf8'))}catch{}
  const {sha,files}=await listTree();
  if(local.sha===sha)return false;
  console.log(`[BrixHub] New GitHub commit detected: ${sha.slice(0,7)}`);
  for(const file of files){
   if(file.startsWith('.git/')||file==='.env')continue;
   const target=path.resolve(APP_DIR,file);
   if(!target.startsWith(APP_DIR+path.sep))continue;
   const data=await githubFile(file);
   fs.mkdirSync(path.dirname(target),{recursive:true});
   const tmp=`${target}.brixhub-tmp`;
   fs.writeFileSync(tmp,data);
   fs.renameSync(tmp,target);
  }
  fs.writeFileSync(stateFile,JSON.stringify({sha,updated_at:new Date().toISOString()},null,2));
  console.log('[BrixHub] Files updated from GitHub. Restarting...');
  return true;
 }catch(e){console.error('[BrixHub] Self-update failed:',e.message);return false}
 finally{updating=false}
}

async function initialUpdate(){
 try{if(await selfUpdate())return true}catch(e){console.error('[BrixHub] Initial update failed:',e.message)}
 return false;
}

const PUBLIC_DIR=path.join(APP_DIR,'public');
function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body)}
function ip(req){return(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').toString().split(',')[0].trim()}
function allowed(req){const now=Date.now(),key=ip(req),b=buckets.get(key)||{start:now,count:0};if(now-b.start>=RATE_WINDOW){b.start=now;b.count=0}b.count++;buckets.set(key,b);return b.count<=RATE_MAX}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(Object.assign(new Error('Request too large'),{status:413}));req.destroy();return}chunks.push(c)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'))}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',reject)})}
async function brixhub(apiPath,options={}){if(!BRIXHUB_API_KEY)throw Object.assign(new Error('BRIXHUB_API_KEY is not configured'),{status:500});const r=await fetch(`${BRIXHUB_API_URL}${apiPath}`,{...options,headers:{Accept:'application/json','Content-Type':'application/json','X-API-Key':BRIXHUB_API_KEY,...(options.headers||{})},signal:AbortSignal.timeout(15000)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={message:text||'Invalid upstream response'}}if(!r.ok){const e=new Error(data?.message||`BrixHub returned ${r.status}`);e.status=r.status>=500?502:r.status;throw e}return data}
function serveFile(res,file){const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};try{if(!fs.statSync(file).isFile())return false;const ext=path.extname(file);res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'});fs.createReadStream(file).pipe(res);return true}catch{return false}}
function frontend(req,res){let p=decodeURIComponent(new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname);if(p==='/'||!path.extname(p))p='/index.html';const file=path.resolve(PUBLIC_DIR,'.'+p);if(!file.startsWith(PUBLIC_DIR+path.sep))return false;return serveFile(res,file)}
async function route(req,res){const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,service:'brixhub',port:PORT,time:new Date().toISOString()});if(req.method==='GET'&&u.pathname==='/api/config')return json(res,200,{ok:true,configured:Boolean(BRIXHUB_API_KEY),api:'/api/search'});if(req.method==='POST'&&u.pathname==='/api/search'){if(!allowed(req))return json(res,429,{ok:false,error:'Rate limit exceeded'});const payload=await readBody(req);if(!payload||typeof payload!=='object'||Array.isArray(payload))return json(res,400,{ok:false,error:'JSON object expected'});const fields=['nom_famille','prenom','nom_naissance','nom_affichage','nom_utilisateur','date_naissance','annee_naissance','jour_naissance','mois_naissance','genre','civilite','email','telephone','mobile','adresse_ip','adresse','complement_adresse','code_postal','ville','ville_naissance','lieu_naissance','pays','region','departement','nir','iban','bic','siret','siren','vin_plaque','immatriculation','numero_serie','marque','modele','societe','profession','fonction','steam_id','fivem_license','fivem_license2','fivem_id','xbox_live_id','live_id','discord_id','page','per_page','flexible'];const query={};for(const k of fields)if(payload[k]!==undefined&&payload[k]!==null&&String(payload[k]).trim()!=='')query[k]=payload[k];if(!Object.keys(query).some(k=>!['page','per_page','flexible'].includes(k)))return json(res,400,{ok:false,error:'Provide at least one search field'});return json(res,200,{ok:true,data:await brixhub('/search',{method:'POST',body:JSON.stringify(query)})})}if(req.method==='GET'&&frontend(req,res))return;return json(res,404,{ok:false,error:'Not found'})}
const server=http.createServer(async(req,res)=>{try{await route(req,res)}catch(e){console.error(`[${new Date().toISOString()}]`,e);if(!res.headersSent)json(res,e.status||500,{ok:false,error:e.message||'Internal server error'})}});
server.listen(PORT,'0.0.0.0',()=>console.log(`[BrixHub] Listening on 0.0.0.0:${PORT}`));

if(AUTO_UPDATE)setInterval(async()=>{if(await selfUpdate()){console.log('[BrixHub] Update downloaded. Exiting so Pterodactyl can restart the process.');process.exit(0)}},UPDATE_INTERVAL).unref();
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));

initialUpdate().then(updated=>{if(updated){console.log('[BrixHub] Initial update downloaded. Exiting for restart.');process.exit(0)}});
