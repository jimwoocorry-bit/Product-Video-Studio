import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
// Run once in the repository/deployment directory. Existing secrets are preserved.
await fs.mkdir('data',{recursive:true,mode:0o700});
try {await fs.writeFile('instance.env','PVS_SESSION_TOKEN='+randomBytes(32).toString('base64url')+'\nPVS_COOKIE_SECURE=0\n',{flag:'wx',mode:0o600});}
catch(error){if(error.code!=='EEXIST')throw error;}
console.log('配置已准备好；访问口令位于 instance.env，请妥善保存。');
