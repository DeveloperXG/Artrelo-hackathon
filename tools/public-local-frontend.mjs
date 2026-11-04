// Explicit local offline helper; no auth, model, dotenv file or public exposure.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),frontend=path.join(root,'frontend');
if(Number(process.versions.node.split('.')[0])!==22)throw Error('Node22 required');
const allowed=new Set(['SystemRoot','WINDIR','PATH','TEMP','TMP','HOME','USERPROFILE']);
for(const name of Object.keys(process.env))if(!allowed.has(name))delete process.env[name];
process.env.API_PROXY_TARGET='http://127.0.0.1:8126';process.env.VITE_API_URL='/api/v1';
const empty=path.join(root,'.public-local-cache/empty-env');fs.mkdirSync(empty,{recursive:true});if(fs.readdirSync(empty).length)throw Error('Require empty env directory');
const require=createRequire(path.join(frontend,'package.json')),{createServer}=await import(pathToFileURL(require.resolve('vite'))),{default:config}=await import(pathToFileURL(path.join(frontend,'vite.config.js')));
const server=await createServer({...config,configFile:false,root:frontend,envDir:empty,cacheDir:path.join(root,'.public-local-cache/vite'),server:{host:'127.0.0.1',port:3126,strictPort:true,allowedHosts:['127.0.0.1'],proxy:{'/api':{target:'http://127.0.0.1:8126',changeOrigin:false}},hmr:false}});
await server.listen();server.printUrls();
const close=async()=>{await server.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);
