import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DomesticJimengCliProvider,ProviderNotReadyError,type CommandExecution,type VerifiedDreaminaRuntime} from '../src/adapters/video/domestic-jimeng-cli-provider.js';
const result=(stdout='',exitCode=0,stderr='',timedOut=false):CommandExecution=>({stdout,stderr,exitCode,timedOut});
async function setup(t:{after(fn:()=>Promise<void>):void},run:(args:readonly string[])=>Promise<CommandExecution>,badHash=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pvs-probe-reliability-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'dreamina');const bytes=Buffer.from('fixture official binary');await fs.writeFile(file,bytes);
 const runtime:VerifiedDreaminaRuntime={identity:{id:'test-runtime',provider:'domestic-jimeng-cli',executablePath:file,
  executableSha256:badHash?'a'.repeat(64):createHash('sha256').update(bytes).digest('hex'),cliVersion:'reviewed-build',
  officialSourceUrl:'https://example.invalid',officialLoginOrigins:[],verificationStatus:'VERIFIED'},
  versionArgs:['version'],helpArgs:['multimodal2video','--help'],parseProbe(version,help){
   if(!/"version"\s*:\s*"reviewed-build"/.test(version.stdout+version.stderr))throw new ProviderNotReadyError('version mismatch');
   if(!help.stdout.includes('seedance2.0mini'))throw new ProviderNotReadyError('capability mismatch');
   return{cliVersion:'reviewed-build',supportedOperations:['accountStatus'],supportedModels:['seedance2.0mini']};}};
 return new DomesticJimengCliProvider(async()=>file,runtime,async(_exe,args)=>run(args));
}
test('empty successful version output and transient startup failure recover with ordered read-only commands',async t=>{
 const calls:string[]=[];let versionCalls=0;let running=0;
 const provider=await setup(t,async args=>{calls.push(args.join(' '));assert.equal(++running,1);
  await new Promise(r=>setTimeout(r,2));running--;
  if(args[0]==='version')return ++versionCalls===1?result():versionCalls===2?result('',1,'write /dev/null: file already closed'):result('{"version":"reviewed-build"}');
  assert.deepEqual(args,['multimodal2video','--help']);return result('seedance2.0mini');});
 assert.equal((await provider.probe()).code,'READY');
 assert.deepEqual(calls,['version','version','version','multimodal2video --help']);
 assert.equal(provider.drainCommandEvidence().length,4);
});
test('persistent empty output stops after three reads with a useful error',async t=>{
 let calls=0;const p=await setup(t,async()=>{calls++;return result();});
 await assert.rejects(p.probe(),/连续未返回有效内容/);assert.equal(calls,3);
});
test('a real version mismatch is rejected without retrying or accepting an alternate version',async t=>{
 const calls:string[]=[];const p=await setup(t,async args=>{calls.push(args[0]!);return args[0]==='version'?result('{"version":"unreviewed-build"}'):result('seedance2.0mini');});
 await assert.rejects(p.probe(),/version mismatch/);assert.deepEqual(calls,['version','multimodal2video']);
});
test('a hash mismatch executes no CLI commands',async t=>{
 let calls=0;const p=await setup(t,async()=>{calls++;return result();},true);
 assert.equal((await p.probe()).code,'PROVIDER_IDENTITY_UNVERIFIED');assert.equal(calls,0);
});
test('transient help failure retries help only and still requires the reviewed capability',async t=>{
 const calls:string[]=[];let help=0;const p=await setup(t,async args=>{calls.push(args[0]!);return args[0]==='version'?result('{"version":"reviewed-build"}'):++help===1?result('',1,'startup error'):result('seedance2.0mini');});
 assert.equal((await p.probe()).code,'READY');assert.deepEqual(calls,['version','multimodal2video','multimodal2video']);
});
test('parallel capability lookups serialize CLI startup and a failed read does not poison later reads',async t=>{
 let running=0,maxRunning=0;let fail=true;
 const p=await setup(t,async args=>{running++;maxRunning=Math.max(maxRunning,running);
  await new Promise(r=>setTimeout(r,3));running--;
  return args[0]==='version'?result('{"version":"reviewed-build"}'):args[0]==='broken'&&fail?result():result('seedance2.0mini');});
 const results=await Promise.all([p.probe(),p.inspectCommandHelp('text2video'),p.inspectCommandHelp('image2video')]);
 assert.equal(results[0]!.code,'READY');assert.equal(maxRunning,1);
 await assert.rejects(p.inspectCommandHelp('broken'),/连续未返回有效内容/);
 fail=false;assert.match((await p.inspectCommandHelp('broken')).stdout,/seedance2.0mini/);
});
