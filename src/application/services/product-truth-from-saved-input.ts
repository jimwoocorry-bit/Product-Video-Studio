import type { ProductInputStore } from "../ports/product-input-store.js";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { AiGenerationService } from "./ai-generation.js";
import type { ProductFlowService } from "./product-flow.js";
import type { ProductTruth } from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";

/**
 * Prepare an uncommitted draft from saved user input for research->truth.
 * Chosen research candidates are merged AFTER this preparation and remain
 * UNVERIFIED until the user reviews them on the product-truth page.
 */
export async function prepareTruthDraftFromSavedInput(input: {
  projectId: string;
  productInput: Pick<ProductInputStore, "latest">;
  artifacts: Pick<ArtifactRepository, "findById">;
  productFlow: Pick<ProductFlowService, "nextVersion">;
  aiGeneration: Pick<AiGenerationService, "generateProductTruthDraft">;
}): Promise<ProductTruth> {
  const snapshot = await input.productInput.latest(input.projectId);
  if (!snapshot) throw new DomainValidationError("请先保存产品资料，再进入产品事实审核。");
  const imageAssets = snapshot.assets.filter(asset => asset.type === "image");
  if (!imageAssets.length) {
    throw new DomainValidationError("产品资料缺少图片参考，无法创建待审核产品事实。");
  }
  const referenceImageArtifacts = [];
  for (const asset of imageAssets) {
    const artifact = await input.artifacts.findById(asset.artifactId);
    if (!artifact || artifact.projectId !== input.projectId ||
        artifact.integrityStatus !== "READY" || !artifact.sha256 ||
        artifact.sha256 !== asset.sha256) {
      throw new DomainValidationError("已保存产品图片缺失或校验失败："+asset.artifactId);
    }
    referenceImageArtifacts.push({
      id: artifact.id,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      ...(artifact.mimeType ? {mimeType:artifact.mimeType} : {})
    });
  }
  const logoAsset = snapshot.assets.find(asset => asset.type === "logo");
  const version = await input.productFlow.nextVersion(
    input.projectId, "ProductTruth", "product-truth"
  );
  return input.aiGeneration.generateProductTruthDraft({
    projectId: input.projectId,
    productName: snapshot.productName,
    featureDescription: snapshot.featureDescription,
    ...(snapshot.brand ? {brand:snapshot.brand} : {}),
    ...(snapshot.category ? {category:snapshot.category} : {}),
    referenceImageIds: imageAssets.map(asset => asset.id),
    referenceImageArtifacts,
    ...(logoAsset ? {logoAssetId:logoAsset.id} : {}),
    forbiddenChanges: snapshot.forbiddenChanges
  }, version);
}
