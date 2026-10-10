import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {resolve} from 'node:path';
const root=resolve('apps/web/dist');const manifest=JSON.parse(await readFile(resolve(root,'.vite/manifest.json'),'utf8'));
const entries=Object.keys(manifest).filter(k=>manifest[k].isEntry);const seen=new Set();
function visit(key){if(seen.has(key))return;seen.add(key);for(const child of manifest[key].imports??[])visit(child);}
entries.forEach(visit);const files=[...new Set([...seen].map(k=>manifest[k].file))];
let bytes=0,gzipBytes=0;for(const file of files){const data=await readFile(resolve(root,file));bytes+=data.length;gzipBytes+=gzipSync(data).length;}
console.log(JSON.stringify({initialJavaScript:{files,bytes,gzipBytes},dynamicEntries:Object.values(manifest).filter(c=>c.isDynamicEntry).map(c=>c.file)},null,2));
