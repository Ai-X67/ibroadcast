const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 250 * 1024 * 1024;
const ALLOWED = new Set([
 'audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/flac',
 'video/mp4','video/webm','video/quicktime','application/ogg',
 'image/jpeg','image/png','image/webp','application/pdf','application/zip',
 'application/octet-stream'
]);
function isPrivate(ip) {
 const v=net.isIP(ip);
 if(v===4){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168);}
 if(v===6){const s=ip.toLowerCase();return s==='::1'||s==='::'||s.startsWith('fc')||s.startsWith('fd')||s.startsWith('fe8')||s.startsWith('fe9')||s.startsWith('fea')||s.startsWith('feb')||s.startsWith('::ffff:127.');}
 return true;
}
async function checkedUrl(raw){
 let u;try{u=new URL(raw)}catch{throw Error('Enter a valid URL.')}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Only public HTTP/HTTPS URLs are supported.');
 if(!u.hostname||u.hostname==='localhost'||u.hostname.endsWith('.localhost'))throw Error('Private network addresses are not supported.');
 const ips=net.isIP(u.hostname)?[u.hostname]:(await dns.lookup(u.hostname,{all:true,verbatim:true})).map(x=>x.address);
 if(!ips.length||ips.some(isPrivate))throw Error('This host is not a permitted public address.');
 return {url:u,ip:ips[0]};
}
function requestOnce(u, ip, method='HEAD'){
 return new Promise((resolve,reject)=>{
  const lib=u.protocol==='https:'?https:http;
  const req=lib.request(u,{method,headers:{'User-Agent':'iBroadcast/1.0','Accept':'*/*'},lookup:(host,opts,cb)=>cb(null,ip,net.isIP(ip)),timeout:15000},res=>resolve({res,req}));
  req.on('timeout',()=>req.destroy(Error('Source server timed out.')));req.on('error',reject);req.end();
 });
}
async function inspect(raw, redirects=0){
 const {url,ip}=await checkedUrl(raw);const {res}=await requestOnce(url,ip,'HEAD');
 if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects<3){const next=new URL(res.headers.location,url).href;res.resume();return inspect(next,redirects+1)}
 const type=String(res.headers['content-type']||'application/octet-stream').split(';')[0].toLowerCase();
 const length=Number(res.headers['content-length']||0);res.resume();
 if(res.statusCode<200||res.statusCode>=300)throw Error(`Source returned HTTP ${res.statusCode}.`);
 if(!ALLOWED.has(type))throw Error(`Unsupported content type: ${type}.`);
 if(length>MAX_BYTES)throw Error('File exceeds the 250 MB limit for this starter server.');
 let filename=decodeURIComponent(url.pathname.split('/').pop()||'download').replace(/[\\r\\n"]/g,'_').slice(0,120);
 if(!path.extname(filename))filename += type.startsWith('audio/')?'.audio':type.startsWith('video/')?'.video':'.file';
 return {url:url.href,filename,contentType:type,size:length||null};
}
function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'same-origin'});res.end(JSON.stringify(obj))}
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin||'null','Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end()}
 const base=`http://${req.headers.host||'localhost'}`;const u=new URL(req.url,base);
 if(req.method==='GET'&&u.pathname==='/api/health')return sendJson(res,200,{ok:true,service:'iBroadcast direct-file backend'});
 if(req.method==='GET'&&u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return fs.createReadStream(path.join(__dirname,'public','index.html')).pipe(res)}
 if(req.method==='POST'&&u.pathname==='/api/analyze'){
  let body='';req.on('data',c=>{body+=c;if(body.length>12000)req.destroy()});req.on('end',async()=>{try{const data=JSON.parse(body||'{}');const info=await inspect(data.url);sendJson(res,200,info)}catch(e){sendJson(res,400,{error:e.message||'Analysis failed.'})}});return;
 }
 if(req.method==='GET'&&u.pathname==='/api/download'){
  const raw=u.searchParams.get('url');if(!raw)return sendJson(res,400,{error:'Missing URL.'});
  try{
   let info=await inspect(raw);let {url,ip}=await checkedUrl(info.url);
   // Stream the verified file from the source; revalidate every redirect.
   for(let n=0;n<4;n++){
    const {res:up}=await requestOnce(url,ip,'GET');
    if([301,302,303,307,308].includes(up.statusCode)&&up.headers.location&&n<3){const next=new URL(up.headers.location,url).href;up.resume();({url,ip}=await checkedUrl(next));continue}
    if(up.statusCode<200||up.statusCode>=300){up.resume();throw Error(`Source returned HTTP ${up.statusCode}.`)}
    const type=String(up.headers['content-type']||'application/octet-stream').split(';')[0].toLowerCase();
    if(!ALLOWED.has(type)){up.resume();throw Error('Unsupported file type.')}
    const size=Number(up.headers['content-length']||0);if(size>MAX_BYTES){up.resume();throw Error('File exceeds 250 MB limit.')}
    res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
    up.on('error',()=>res.destroy());up.pipe(res);return;
   }
   throw Error('Too many redirects.');
  }catch(e){if(!res.headersSent)sendJson(res,400,{error:e.message||'Download failed.'});else res.destroy()}return;
 }
 sendJson(res,404,{error:'Not found.'});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`iBroadcast running on port ${PORT}`));
