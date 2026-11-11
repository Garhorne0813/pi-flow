import {readFileSync} from 'node:fs';
const lock=JSON.parse(readFileSync(new URL('../web/package-lock.json',import.meta.url),'utf8'));
for(const name of Object.keys(lock.packages))if(/node_modules\/(?:@deepseek-ai\/(?:dsh-agent|cordis)|@zcode\/rpc)(?:\/|$)/.test(name))throw new Error('Forbidden chat protocol dependency: '+name);
console.log('Chat dependency boundary verified');
