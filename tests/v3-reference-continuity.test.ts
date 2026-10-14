import test from "node:test";
import assert from "node:assert/strict";
import { compiledPromptSchema, type GenerationRequest } from "../src/domain/schemas.js";
import { buildAssetImageBindings, assertAssetImageBindings } from "../src/application/services/asset-image-bindings.js";
import { appendV3ImageReferences, compileV3TailReference, planV3ContinuityWave, v3ClipContinuityPackages } from "../src/application/services/v3-reference-continuity.js";
import { buildAgentSubmitArgs } from "../src/adapters/video/verified-dreamina-runtime-loader.js";
import { renderClipAssetBindingPreview } from "../src/web/clip-reference-bindings-ui.js";
import { makeRequest, makeValidClip } from "./fixtures.js";

const H=(v:string)=>v.repeat(64);
const images=[
  {assetId:"actor-magistrate",artifactHash:H("a"),priority:0,required:true,role:"CHARACTER" as const,inputType:"image" as const},
  {assetId:"actor-advisor",artifactHash:H("b"),priority:1,required:true,role:"CHARACTER" as const,inputType:"image" as const}
];
const source={
  version:"v3-tail-reference-1" as const,sourceClipId:"clip-prior",sourceAttemptId:"attempt-prior",
  sourceVideoArtifactId:"video-prior",sourceVideoSha256:H("c"),
  tailFrameArtifactId:"tail-real-png",tailFrameSha256:H("d"),
  tailEvidenceArtifactId:"tail-proof",tailEvidenceSha256:H("e"),
  mode:"SOFT_MULTIMODAL_REFERENCE" as const
};
const base="【参考素材】县令身穿红官服，师爷身穿蓝色长袍。\n【本段视频目标】公堂递卷宗。";

test("B: new V3 generates exact image-name-to-file bindings in official --image order",()=>{
  const promptText=appendV3ImageReferences({
    promptText:base,assets:[images[1]!,images[0]!],
    namesByAssetId:{"actor-magistrate":"县令","actor-advisor":"师爷"}
  });
  assert.match(promptText,/县令@图片1/);
  assert.match(promptText,/师爷@图片2/);
  const imageBindings=buildAssetImageBindings({promptText,assetManifest:images,dreaminaOperation:"multimodal2video"});
  assert.deepEqual(imageBindings.map(b=>[b.assetName,b.assetId,b.imageIndex,b.providerSlot,b.referencedByPrompt]),[
    ["县令","actor-magistrate",1,"REFERENCE_IMAGE",true],
    ["师爷","actor-advisor",2,"REFERENCE_IMAGE",true]
  ]);
  const request:GenerationRequest={...makeRequest(),promptText,assetManifest:images,
    dreaminaOperation:"multimodal2video",imageBindings,v3Binding:{version:"V3_B_C1",runId:"v3-run"}};
  const resolved=images.map((im,i)=>({...im,absolutePath:"C:/test-"+(i+1)+".png"}));
  const args=buildAgentSubmitArgs(request,[...resolved].reverse(),"seedance2.0_vip");
  assert.deepEqual(args.flatMap((v,i)=>v==="--image"?[args[i+1]]:[]),resolved.map(r=>r.absolutePath));
  assert.deepEqual(args.slice(args.indexOf("--ratio"),args.indexOf("--ratio")+2),["--ratio","9:16"]);
  assert.throws(()=>assertAssetImageBindings({...request,
    assetManifest:[{...images[0]!,priority:3},images[1]!]}),/素材已变化/);
  assert.throws(()=>appendV3ImageReferences({promptText:"县令@图片1",assets:images}),/手写编号/);
});

test("V3 only sequences adjacent same-scene clips; independent scenes can proceed",()=>{
  const clip=makeValidClip();
  const plan={scenes:[
    {id:"scene-1",clips:[{...clip,id:"c1"},{...clip,id:"c2"},{...clip,id:"c3"}]},
    {id:"scene-2",clips:[{...clip,id:"d1"}]}
  ]};
  const packages=v3ClipContinuityPackages(plan);
  assert.deepEqual(packages,[
    {clipId:"c1"},{clipId:"c2",sourceClipId:"c1"},
    {clipId:"c3",sourceClipId:"c2"},{clipId:"d1"}
  ]);
  const first=planV3ContinuityWave({packages,attemptedClipIds:new Set(),readyClipIds:new Set()});
  assert.deepEqual(first,{status:"READY",clipIds:["c1","d1"],sourceClipIds:[]});
  const waiting=planV3ContinuityWave({packages,attemptedClipIds:new Set(["c1","d1"]),readyClipIds:new Set()});
  assert.equal(waiting.status,"WAIT_SOURCE");
  const next=planV3ContinuityWave({packages,attemptedClipIds:new Set(["c1","d1"]),readyClipIds:new Set(["c1","d1"])});
  assert.deepEqual(next,{status:"READY",clipIds:["c2"],sourceClipIds:["c1"]});
  const last=planV3ContinuityWave({packages,attemptedClipIds:new Set(["c1","c2","d1"]),readyClipIds:new Set(["c1","c2","d1"])});
  assert.deepEqual(last,{status:"READY",clipIds:["c3"],sourceClipIds:["c2"]});
  assert.throws(()=>planV3ContinuityWave({packages:[{clipId:"a",sourceClipId:"b"},{clipId:"b"}],attemptedClipIds:new Set(),readyClipIds:new Set()}),/更早/);
});

test("C1: confirmed actual MP4 tail is first ordinary reference, followed by correctly renumbered actors",()=>{
  const promptText=appendV3ImageReferences({promptText:base,assets:images,
    namesByAssetId:{"actor-magistrate":"县令","actor-advisor":"师爷"}});
  const imageBindings=buildAssetImageBindings({promptText,assetManifest:images,dreaminaOperation:"multimodal2video"});
  const ref={entityType:"x",entityId:"ref-1",version:1,hash:H("f")};
  const original=compiledPromptSchema.parse({
    id:"p1",projectId:"project-1",clipId:"clip-next",version:1,status:"CURRENT",
    provider:"domestic-jimeng-cli",model:"seedance2.0_vip",
    productTruthRef:ref,creativeBatchRef:ref,selectedCreativeId:"selected-1",
    scriptRef:ref,productionPlanRef:ref,clipHash:H("a"),segmentHashes:{},
    compilerTemplateVersion:"seedance-prompt-v3-1",v3Binding:{version:"V3_B_C1",runId:"run-1"},
    promptText,imageBindings,inputAssetManifest:images,
    factMapping:[],segmentMapping:[],constraintMapping:[],
    generationParams:{durationMs:10000,aspectRatio:"9:16",generateAudio:true,videoResolution:"720p"},
    compiledPromptHash:H("b"),createdAt:new Date().toISOString()
  });
  const compiled=compileV3TailReference({compiled:original,source});
  assert.deepEqual(compiled.inputAssetManifest.map(a=>a.assetId),["tail-real-png","actor-magistrate","actor-advisor"]);
  assert.match(compiled.promptText,/上一段真实尾帧@图片1/);
  assert.match(compiled.promptText,/县令@图片2/);
  assert.match(compiled.promptText,/师爷@图片3/);
  assert.deepEqual(compiled.imageBindings?.map(b=>b.providerSlot),["REFERENCE_IMAGE","REFERENCE_IMAGE","REFERENCE_IMAGE"]);
  assert.equal(compiled.v3TailSource?.tailFrameSha256,source.tailFrameSha256);
  assert.notEqual(compiled.compiledPromptHash,original.compiledPromptHash);
  const request={...makeRequest(),assetManifest:compiled.inputAssetManifest,promptText:compiled.promptText,
    imageBindings:compiled.imageBindings,v3Binding:compiled.v3Binding,v3TailSource:compiled.v3TailSource,
    dreaminaOperation:"multimodal2video" as const};
  const resolved=compiled.inputAssetManifest.map((im,i)=>({...im,absolutePath:"C:/slot"+(i+1)+".png"}));
  const args=buildAgentSubmitArgs(request,[...resolved].reverse(),"seedance2.0_vip");
  assert.deepEqual(args.flatMap((v,i)=>v==="--image"?[args[i+1]]:[]),[
    "C:/slot1.png","C:/slot2.png","C:/slot3.png"
  ]);
  assert.ok(!args.includes("--first"),"C1 multimodal reference cannot masquerade as a hard first frame");
  assert.throws(()=>buildAgentSubmitArgs(request,[{...resolved[0]!,artifactHash:H("f")},...resolved.slice(1)],"seedance2.0_vip"),/实际读取的图片文件/);
  assert.throws(()=>compileV3TailReference({compiled:{...original,v3Binding:undefined},source}),/新版本 V3/);
});

test("C1 UI shows the real tail as image1 and does not mislabel actors",()=>{
  const bindingNames=["上一段真实尾帧","县令","师爷"];
  const manifest=[
    {assetId:"tail-real-png",artifactHash:H("d"),priority:0,required:true,role:"SCENE_REFERENCE" as const,inputType:"image" as const},
    {...images[0]!,priority:1},{...images[1]!,priority:2}
  ];
  const promptText=bindingNames.map((n,i)=>n+"@图片"+(i+1)).join("；");
  const imageBindings=buildAssetImageBindings({promptText,assetManifest:manifest,dreaminaOperation:"multimodal2video"});
  const html=renderClipAssetBindingPreview({
    clip:{id:"clip-next",referenceAssets:images.map(i=>({assetId:i.assetId,priority:i.priority,role:i.role,required:true}))},
    imageBindings
  });
  assert.match(html,/查看本段图片引用（3张）/);
  assert.ok(html.indexOf("上一段真实尾帧@图片1")<html.indexOf("县令@图片2"));
  assert.ok(html.indexOf("县令@图片2")<html.indexOf("师爷@图片3"));
  assert.match(html,/\/api\/artifacts\/tail-real-png\/content/);
  assert.doesNotMatch(html,/绑定记录已失配/);
});
