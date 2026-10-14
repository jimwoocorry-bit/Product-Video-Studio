import type { Clip } from "../domain/schemas.js";
import type { ProductionAssetSet } from "../domain/production-strategy.js";

const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));

/**
 * Preview the exact Clip reference ordering. This is a read-only projection:
 * it never changes confirmed prompts, approval scope or uploaded images.
 */
export function renderClipAssetBindingPreview(input:{
  clip:Pick<Clip,"id"|"referenceAssets">;
  assetSet?:ProductionAssetSet;
  imageBindings?:ReadonlyArray<{imageIndex:number;assetName:string;assetId:string;providerSlot:string}>;
}):string {
  const ordered=[...input.clip.referenceAssets].sort((a,b)=>
    a.priority-b.priority || a.assetId.localeCompare(b.assetId));
  if (!ordered.length) return "";
  // V3 C1 inserts an immutable real-video tail ahead of the plan's ordinary assets.
  // The preview must reflect the REAL provider index, not relabel original asset 1 as tail.
  const tail=input.imageBindings?.[0];
  const hasExtraTail=Boolean(tail?.assetName.includes("尾帧") &&
    input.imageBindings?.length===ordered.length+1 &&
    !ordered.some(a=>a.assetId===tail?.assetId) &&
    input.imageBindings?.slice(1).every((b,i)=>b.assetId===ordered[i]?.assetId));
  const visible=hasExtraTail && tail
    ? [{assetId:tail.assetId,priority:-1,role:"SCENE_REFERENCE" as const,required:true},...ordered]
    : ordered;
  const mappings=new Map((input.imageBindings??[]).map(b=>[b.imageIndex,b]));
  const confirmed=input.imageBindings?.length===visible.length &&
    input.imageBindings.every((b,i)=>b.imageIndex===i+1 && b.assetId===visible[i]?.assetId);
  return '<details class="v3-asset-bindings" data-asset-clip="'+esc(input.clip.id)+'">'+
    '<summary>查看本段图片引用（'+visible.length+'张）</summary>'+
    '<p class="muted">'+(confirmed
      ? '图片序号已匹配当前结构化资产记录；仍需生成前核对实际文件及输入槽位。'
      : '以下仅为预计参考顺序，尚无对应的已确认实发图片绑定；请以生成前检查为准。')+
      ' 普通多图参考不等于专用硬首帧。</p>'+
    '<div style="display:flex;gap:12px;flex-wrap:wrap">'+
    visible.map((asset,index)=>{
      const number=index+1;
      const entry=input.assetSet?.entries.find(e=>e.referenceAssetId===asset.assetId);
      const stored=entry?.artifactIds?.[0]??(hasExtraTail&&index===0?asset.assetId:undefined);
      const image=(entry?.status==="READY" || (hasExtraTail&&index===0))&&stored
        ? '<a href="/api/artifacts/'+encodeURIComponent(stored)+'/content" target="_blank" rel="noopener">'+
          '<img loading="lazy" style="display:block;max-width:120px;width:120px;max-height:115px;object-fit:contain" src="/api/artifacts/'+
          encodeURIComponent(stored)+'/content" alt="'+esc(entry?.label??tail?.assetName??"参考图")+'"></a>'
        : '<div class="muted">当前素材没有已确认的预览图</div>';
      const mapping=mappings.get(number);
      const label=mapping?.assetName??entry?.label??asset.role;
      const exact=mapping?.assetId===asset.assetId;
      return '<article data-image-index="'+number+'" data-reference-id="'+esc(asset.assetId)+'" style="min-width:108px;max-width:145px">'+
        image+'<div><b>'+esc(label)+'@图片'+number+'</b></div>'+
        '<small class="muted">'+esc(mapping ? exact?mapping.providerSlot:"绑定记录已失配":asset.role)+'</small></article>';
    }).join("")+
    '</div></details>';
}
