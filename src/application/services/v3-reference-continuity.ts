import { compiledPromptSchema, type CompiledPrompt, type GenerationRequest } from "../../domain/schemas.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import { DomainValidationError } from "../../domain/validation.js";
import { hashValue } from "../../domain/hashing.js";
import { buildAssetImageBindings, orderedImageAssets, parseNamedImageMentions } from "./asset-image-bindings.js";

type Image = Pick<GenerationRequest["assetManifest"][number], "assetId" | "artifactHash" | "priority" | "inputType" | "role">;
const MARKER = "\n【当前片段图片编号与资产】";

/** Only the CLI image order is authoritative. @图片N is a named textual reference,
 * not an assertion of Dreamina's undocumented native-@ protocol. */
export function appendV3ImageReferences(input: {
  promptText: string;
  assets: readonly Image[];
  assetSet?: ProductionAssetSet;
  productName?: string;
  namesByAssetId?: Readonly<Record<string, string>>;
}): string {
  const ordered = orderedImageAssets(input.assets);
  if (!ordered.length) return input.promptText;
  const promptText = input.promptText.split(MARKER)[0]!;
  if (/@图片\d+/.test(promptText)) {
    throw new DomainValidationError("V3 原始提示词已包含未经过资产排序验证的 @图片编号，请先移除手写编号再编译。");
  }
  const used = new Set<string>();
  const refs = ordered.map((asset, index) => {
    const entry = input.assetSet?.entries.find(item => item.referenceAssetId === asset.assetId);
    const raw = input.namesByAssetId?.[asset.assetId] ??
      entry?.label ??
      (asset.role === "PRIMARY_PRODUCT" ? input.productName : undefined) ??
      ({ CHARACTER: "角色", ENVIRONMENT: "场景", SCENE_REFERENCE: "场景", STYLE: "视觉风格", PRIMARY_PRODUCT: "产品" } as Record<string, string>)[asset.role] ??
      "参考素材";
    // Never let whitespace/punctuation inject another token or change the parser's label.
    const base = raw.replace(/[^\p{L}\p{N}_·-]/gu, "").replace(/^-+/, "").slice(0, 30) || "参考素材";
    let label = base, seq = 2;
    while (used.has(label)) label = base.slice(0, 26) + seq++;
    used.add(label);
    return label + "@图片" + (index + 1);
  });
  const result = promptText + MARKER + "\n" + refs.join("\n") +
    "\n图片序号严格对应本片段实际提交的参考图顺序；人物、场景和产品以对应图片为依据。";
  if (parseNamedImageMentions(result).size !== ordered.length) {
    throw new DomainValidationError("V3 图片引用数量不等于当前实际图片文件数量。");
  }
  return result;
}

export function v3ClipContinuityPackages(plan: {scenes:readonly {clips:readonly {id:string}[]}[]}) {
  return plan.scenes.flatMap(scene => scene.clips.map((clip,index) => ({
    clipId: clip.id,
    ...(index > 0 ? { sourceClipId: scene.clips[index - 1]!.id } : {})
  })));
}

/** Only adjacent clips inside one Director scene inherit a tail; scene changes are independent.
 * AUTO may inherit an actual downloaded clip without claiming a human review.
 * Manual mode can require an explicit accepted predecessor. */
export function planV3ContinuityWave(input: {
  packages: readonly {clipId:string; sourceClipId?:string}[];
  attemptedClipIds: ReadonlySet<string>;
  readyClipIds: ReadonlySet<string>;
}): {status:"READY"|"WAIT_SOURCE"|"COMPLETE";clipIds:string[];sourceClipIds:string[]} {
  const all = new Set<string>();
  for (const p of input.packages) {
    if (all.has(p.clipId) || (p.sourceClipId && !all.has(p.sourceClipId))) {
      throw new DomainValidationError("V3 连续镜头依赖必须指向同项目更早且唯一的片段。");
    }
    all.add(p.clipId);
  }
  if ([...input.attemptedClipIds].some(id => !all.has(id))) {
    throw new DomainValidationError("V3 不能继承不属于本次导演方案的生成记录。");
  }
  const remaining = input.packages.filter(p => !input.attemptedClipIds.has(p.clipId));
  if (!remaining.length) return {status:"COMPLETE",clipIds:[],sourceClipIds:[]};
  const selected = remaining.filter(p => !p.sourceClipId || input.readyClipIds.has(p.sourceClipId));
  return {
    status:selected.length ? "READY" : "WAIT_SOURCE",
    clipIds:selected.map(p=>p.clipId),
    sourceClipIds:[...new Set(selected.flatMap(p=>p.sourceClipId?[p.sourceClipId]:[]))]
  };
}

export type V3TailReference = NonNullable<GenerationRequest["v3TailSource"]>;

/** C1 mode: real tail + character/scene images in one multimodal input list.
 * Its slot is REFERENCE_IMAGE, never falsely labeled FIRST_FRAME. */
export function compileV3TailReference(input: {
  compiled: CompiledPrompt;
  source: V3TailReference;
}): CompiledPrompt {
  const {compiled, source} = input;
  if (!compiled.v3Binding || compiled.continuitySource || compiled.v3TailSource) {
    throw new DomainValidationError("只有新版本 V3 提示词可接入一次真实尾帧；禁止覆盖旧请求。");
  }
  const manifest = [
    {assetId:source.tailFrameArtifactId,artifactHash:source.tailFrameSha256,
      role:"SCENE_REFERENCE" as const,priority:0,required:true,inputType:"image" as const},
    ...compiled.inputAssetManifest.map(asset => ({...asset,priority:asset.priority+1}))
  ];
  const namesByAssetId: Record<string,string> = {
    [source.tailFrameArtifactId]:"上一段真实尾帧",
    ...Object.fromEntries((compiled.imageBindings??[]).map(b=>[b.assetId,b.assetName]))
  };
  const promptText=appendV3ImageReferences({
    promptText: compiled.promptText.split(MARKER)[0]! +
      "\n【真实尾帧连续性参考】上一段视频实际最后画面作为本段第一张普通参考图，尽可能保持角色站位、服饰、光照、道具状态和构图；普通多模态参考并不等于模型专用硬首帧。",
    assets:manifest,namesByAssetId
  });
  const imageBindings=buildAssetImageBindings({
    promptText,assetManifest:manifest,dreaminaOperation:"multimodal2video"
  });
  if (imageBindings[0]?.providerSlot!=="REFERENCE_IMAGE" ||
      imageBindings[0].assetId!==source.tailFrameArtifactId) {
    throw new DomainValidationError("C1 模式上一段尾帧必须是第一张真实普通参考图片。");
  }
  return compiledPromptSchema.parse({
    ...compiled,
    compilerTemplateVersion:compiled.compilerTemplateVersion+"+v3-real-tail-c1",
    v3TailSource:source,promptText,imageBindings,inputAssetManifest:manifest,
    compiledPromptHash:hashValue({
      previous:compiled.compiledPromptHash,
      source,promptText,manifest,imageBindings,operation:"multimodal2video"
    })
  });
}
