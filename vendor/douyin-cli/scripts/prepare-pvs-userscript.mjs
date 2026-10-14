/**
 * Generate the local installable Tampermonkey userscript from the reviewed
 * repository source and the existing local Bridge token.
 *
 * Never log the token or write it to tracked source files.
 * The output is a private, local file that Tampermonkey already references.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,"..");
const sourcePath=path.join(here,"douyin.user.js");
const outputPath=path.resolve(root,"..","douyin-bridge.user.js");
const configPath=path.join(root,"config.json");
const redacted=x=>x.replace(/\r\n/g,"\n")
  .replace(/(token\s*:\s*['"])[^'"]+(['"])/g,"$1[TOKEN]$2").trim();

const config=JSON.parse(fs.readFileSync(configPath,"utf8"));
const token=config.bridge?.token;
const source=fs.readFileSync(sourcePath,"utf8");
const marker=/(\btoken\s*:\s*['"])([^'"]+)(['"]\s*,)/g;
const matches=[...source.matchAll(marker)];
if(typeof token!=="string"||token.length<24||matches.length!==1||
    !source.includes("@name         Bridge: Douyin")||
    !source.includes("@match        *://*.douyin.com/*")){
  throw new Error("Douyin userscript source or local Bridge config is invalid");
}
const next=source.replace(marker,(_full,start,_old,end)=>start+token+end);
if(fs.existsSync(outputPath)){
  const previous=fs.readFileSync(outputPath,"utf8");
  // Do not clobber scripts with unknown code. Token rotations may replace only
  // the credential embedded in the same reviewed source content.
  if(redacted(previous)!==redacted(next)){
    throw new Error("Installed userscript file has unknown code changes; manual security review required");
  }
  if(previous===next){
    console.log("DOUYIN_USERSCRIPT_CONFIG_SYNC_OK unchanged (token redacted)");
    process.exit(0);
  }
  const backupDir=path.join(os.homedir(),".agentdock","backups","pvs-douyin-userscript-config");
  fs.mkdirSync(backupDir,{recursive:true});
  const backup=path.join(backupDir,"before-token-sync-"+Date.now()+".user.js");
  fs.writeFileSync(backup,previous,{flag:"wx",mode:0o600});
}
const temp=outputPath+".tmp-"+process.pid;
try{
  fs.writeFileSync(temp,next,{flag:"wx",mode:0o600});
  fs.renameSync(temp,outputPath);
}finally{
  if(fs.existsSync(temp))fs.unlinkSync(temp);
}
console.log("DOUYIN_USERSCRIPT_CONFIG_SYNC_OK prepared (token redacted)");
