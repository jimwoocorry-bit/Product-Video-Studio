import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaArtifactRepository } from "../src/adapters/db/prisma-artifact-repository.js";
import { PrismaFinalOutputRepository } from "../src/adapters/db/prisma-final-output-repository.js";
import { PrismaGenerationRepository } from "../src/adapters/db/prisma-generation-repository.js";
import { PrismaProductFlowRepository } from "../src/adapters/db/prisma-product-flow-repository.js";
import { PrismaProviderAuditRepository } from "../src/adapters/db/prisma-provider-audit-repository.js";
import { PrismaPublishRepository } from "../src/adapters/db/prisma-publish-repository.js";
import { PrismaReferenceVideoRepository } from "../src/adapters/db/prisma-reference-video-repository.js";
import { PrismaResearchRepository } from "../src/adapters/db/prisma-research-repository.js";
import { PrismaReviewRepository } from "../src/adapters/db/prisma-review-repository.js";
import { PrismaTimelineRepository } from "../src/adapters/db/prisma-timeline-repository.js";
import { PrismaWorkflowRepository } from "../src/adapters/db/prisma-workflow-repository.js";
import { LocalArtifactStore } from "../src/adapters/store/local-artifact-store.js";
import { LocalProductInputStore } from "../src/adapters/store/local-product-input-store.js";
import type {
  PublishDirectInput,
  PublishDirectResult,
  PublishHandoffInput,
  PublishHandoffResult,
  PublishProvider,
  PublishProviderProbe
} from "../src/application/ports/publish-provider.js";
import { PublishSubmissionUnknownError } from "../src/application/ports/publish-provider.js";
import { ProductFlowService } from "../src/application/services/product-flow.js";
import { PublishProviderRegistry } from "../src/application/services/publish-provider-registry.js";
import { PublishBridgeService } from "../src/application/services/publish-bridge-service.js";
import { ProjectSnapshotService } from "../src/application/services/project-snapshot.js";
import { DouyinSdkHandoffProvider } from "../src/adapters/publish/douyin-sdk-handoff-provider.js";
import { DouyinH5HandoffProvider } from "../src/adapters/publish/douyin-h5-handoff-provider.js";
import { DouyinOpenApiDirectProviderAdapter } from "../src/adapters/publish/douyin-openapi-direct-provider.js";
import { ManualExportProvider } from "../src/adapters/publish/manual-export-provider.js";
import { OfficialDouyinOpenApiProvider } from "../src/adapters/publish/official-douyin-openapi-provider.js";
import { sha256Text } from "../src/domain/hashing.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { H } from "./fixtures.js";
import { renderPublishCenter } from "../src/web/publish-ui.js";
import vm from "node:vm";
import { DouyinBrowserAutomationProvider } from "../src/adapters/publish/douyin-browser-automation-provider.js";
import type { DouyinBrowserPublishResult } from "../src/application/ports/douyin-browser-publisher-runtime.js";

process.env.DATABASE_URL ??= "file:./dev.db";

class FakeHandoffProvider implements PublishProvider {
  readonly type = "DOUYIN_SDK_HANDOFF" as const;
  readonly displayName = "Fake SDK";
  readonly mode = "HANDOFF" as const;
  lastInput?: PublishHandoffInput;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: true
    };
  }

  async prepareHandoff(input: PublishHandoffInput): Promise<PublishHandoffResult> {
    this.lastInput = input;
    return {
      launchUrl:
        "pvscompanion://publish?package_id=" +
        encodeURIComponent(input.packageId),
      handoffReference: "handoff-" + input.packageId,
      instruction: "Open fake SDK",
      awaitingUserAction: true
    };
  }
}

class FakeUnknownDirectProvider implements PublishProvider {
  readonly type = "DOUYIN_BROWSER_AUTOMATION" as const;
  readonly displayName = "Fake Browser";
  readonly mode = "DIRECT" as const;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      accountDisplayName: "WC",
      platformUserId: "50805615998",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    };
  }

  async directPublish(_input: PublishDirectInput): Promise<PublishDirectResult> {
    throw new PublishSubmissionUnknownError(
      "抖音已接收发布动作，但管理页暂未确认",
      "https://creator.douyin.com/creator-micro/content/manage"
    );
  }
}

class FakeDirectProvider implements PublishProvider {
  readonly type = "DOUYIN_OPENAPI_DIRECT" as const;
  readonly displayName = "Fake Direct";
  readonly mode = "DIRECT" as const;
  publishCalls = 0;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false
    };
  }

  async directPublish(_input: PublishDirectInput): Promise<PublishDirectResult> {
    this.publishCalls += 1;
    return {
      trusted: true,
      externalReference: "item-trusted-1",
      videoId: "video-trusted-1",
      itemId: "item-trusted-1"
    };
  }
}

async function cleanup(db: PrismaClient, projectId: string): Promise<void> {
  await db.publishReceiptRecord.deleteMany({ where: { projectId } });
  await db.publishPackageRecord.deleteMany({ where: { projectId } });
  await db.publishPreferenceRecord.deleteMany({ where: { projectId } });
  await db.publishAttemptRecord.deleteMany({ where: { projectId } });
  await db.finalAssemblyRecord.deleteMany({ where: { projectId } });
  await db.renderJobRecord.deleteMany({ where: { projectId } });
  await db.timelineRecord.deleteMany({ where: { projectId } });
  await db.reviewDecisionRecord.deleteMany({ where: { projectId } });
  await db.commandAttemptRecord.deleteMany({ where: { projectId } });
  await db.generationAttemptRecord.deleteMany({ where: { projectId } });
  await db.userApprovalRecord.deleteMany({ where: { projectId } });
  await db.preflightReportRecord.deleteMany({ where: { projectId } });
  await db.generationRequestRecord.deleteMany({ where: { projectId } });
  await db.workflowBlockerRecord.deleteMany({ where: { projectId } });
  await db.providerCapabilityRecord.deleteMany({ where: { projectId } });
  await db.providerIdentityRecord.deleteMany({ where: { projectId } });
  await db.referenceVideoProfileRecord.deleteMany({ where: { projectId } });
  await db.researchEvidenceRecord.deleteMany({ where: { projectId } });
  await db.researchBriefRecord.deleteMany({ where: { projectId } });
  await db.researchRunRecord.deleteMany({ where: { projectId } });
  await db.artifactRecord.deleteMany({ where: { projectId } });
  await db.versionedEntity.deleteMany({ where: { projectId } });
  await db.project.deleteMany({ where: { id: projectId } });
}

async function fixture(providers: PublishProvider[]) {
  const db = new PrismaClient();
  const projectId = "publish-bridge-" + crypto.randomUUID();
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-publish-bridge-")
  );
  const productFlow = new ProductFlowService(
    new PrismaProductFlowRepository(db)
  );
  const artifacts = new PrismaArtifactRepository(db);
  const finalOutput = new PrismaFinalOutputRepository(db);
  const publishRepo = new PrismaPublishRepository(db);
  const now = new Date().toISOString();
  await productFlow.createProject({
    id: projectId,
    name: "Publish Bridge",
    status: "READY_TO_PUBLISH",
    targetPlatform: "douyin",
    targetDurationMs: 60000,
    aspectRatio: "9:16",
    createdAt: now,
    updatedAt: now
  });
  const store = new LocalArtifactStore(
    path.join(projectsRoot, projectId),
    artifacts
  );
  const finalArtifact = await store.writeImmutable({
    id: "final-" + crypto.randomUUID(),
    projectId,
    kind: "FINAL_VIDEO",
    relativePath: "final/final.mp4",
    immutable: true,
    bytes: Buffer.from("fake-final-video-" + projectId, "utf8"),
    mimeType: "video/mp4"
  });
  assert.ok(finalArtifact.sha256);
  const assembly = await finalOutput.createAssembly({
    id: "assembly-" + crypto.randomUUID(),
    projectId,
    productionPlanHash: H.a,
    selectedClipIds: ["clip-a"],
    inputArtifactIds: ["source-a"],
    inputArtifactHashes: [H.b],
    outputArtifactId: finalArtifact.id,
    outputArtifactHash: finalArtifact.sha256!,
    status: "ACCEPTED",
    createdAt: now,
    acceptedAt: now
  });
  const registry = new PublishProviderRegistry(providers);
  const bridge = new PublishBridgeService(
    productFlow,
    artifacts,
    finalOutput,
    publishRepo,
    registry,
    projectsRoot
  );
  return {
    db,
    projectId,
    projectsRoot,
    productFlow,
    artifacts,
    finalOutput,
    publishRepo,
    bridge,
    finalArtifact,
    assembly,
    async dispose() {
      await cleanup(db, projectId).catch(() => undefined);
      await db.$disconnect();
      await fs.rm(projectsRoot, { recursive: true, force: true });
    }
  };
}

test("PublishProvider defaults are capability-gated and Manual Export is always READY", async () => {
  const keys = [
    "PVS_DOUYIN_SDK_HANDOFF_ENABLED",
    "DOUYIN_MOBILE_CLIENT_KEY",
    "PVS_MOBILE_COMPANION_SCHEME",
    "PVS_DOUYIN_H5_HANDOFF_ENABLED",
    "PVS_DOUYIN_H5_CAPABILITY_APPROVED",
    "DOUYIN_H5_CLIENT_KEY",
    "DOUYIN_H5_CLIENT_SECRET",
    "PVS_DOUYIN_OPENAPI_DIRECT_ENABLED"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(
      (await new DouyinSdkHandoffProvider().probe("p")).code,
      "DISABLED"
    );
    assert.equal(
      (await new DouyinH5HandoffProvider().probe("p")).code,
      "DISABLED"
    );
    assert.equal(
      (
        await new DouyinOpenApiDirectProviderAdapter(
          new OfficialDouyinOpenApiProvider()
        ).probe("p")
      ).code,
      "DISABLED"
    );
    assert.equal((await new ManualExportProvider().probe("p")).code, "READY");
  } finally {
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("SDK handoff becomes READY only with explicit admin enablement and valid companion scheme", async () => {
  const keys = [
    "PVS_DOUYIN_SDK_HANDOFF_ENABLED",
    "DOUYIN_MOBILE_CLIENT_KEY",
    "PVS_MOBILE_COMPANION_SCHEME"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.PVS_DOUYIN_SDK_HANDOFF_ENABLED = "1";
    process.env.DOUYIN_MOBILE_CLIENT_KEY = "mobile-client-key";
    process.env.PVS_MOBILE_COMPANION_SCHEME = "pvscompanion";
    const provider = new DouyinSdkHandoffProvider();
    assert.equal((await provider.probe("project-sdk")).code, "READY");
    const result = await provider.prepareHandoff({
      projectId: "project-sdk",
      packageId: "package-sdk",
      title: "SDK",
      bridgeUrl: "https://studio.example.test/publish/mobile/package-sdk",
      videoUrl:
        "https://studio.example.test/api/publish/packages/package-sdk/media?media_token=x"
    });
    assert.match(result.launchUrl ?? "", /^pvscompanion:\/\/publish\?/);
    const launch = new URL(result.launchUrl!);
    assert.equal(launch.searchParams.get("package_id"), "package-sdk");
    assert.equal(
      launch.searchParams.get("bridge_url"),
      "https://studio.example.test/publish/mobile/package-sdk"
    );
    assert.equal(result.awaitingUserAction, true);
  } finally {
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("H5 handoff uses official ticket signature inputs and requires public HTTPS media", async () => {
  const keys = [
    "PVS_DOUYIN_H5_HANDOFF_ENABLED",
    "PVS_DOUYIN_H5_CAPABILITY_APPROVED",
    "DOUYIN_H5_CLIENT_KEY",
    "DOUYIN_H5_CLIENT_SECRET",
    "PVS_DOUYIN_H5_ALLOW_HTTP"
  ] as const;
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  try {
    process.env.PVS_DOUYIN_H5_HANDOFF_ENABLED = "1";
    process.env.PVS_DOUYIN_H5_CAPABILITY_APPROVED = "1";
    process.env.DOUYIN_H5_CLIENT_KEY = "h5-client-key";
    process.env.DOUYIN_H5_CLIENT_SECRET = "h5-secret";
    delete process.env.PVS_DOUYIN_H5_ALLOW_HTTP;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (target.includes("/oauth/client_token/")) {
        return new Response(
          JSON.stringify({
            data: {
              access_token: "client-token",
              expires_in: 7200,
              error_code: 0
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (target.includes("/open/getticket/")) {
        return new Response(
          JSON.stringify({
            data: {
              ticket: "ticket-fixed",
              expires_in: 7200,
              error_code: 0
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      throw new Error("unexpected H5 test URL: " + target);
    }) as typeof fetch;

    const provider = new DouyinH5HandoffProvider();
    assert.equal((await provider.probe("project-h5")).code, "READY");
    const result = await provider.prepareHandoff({
      projectId: "project-h5",
      packageId: "package-h5",
      title: "H5 publish",
      bridgeUrl: "https://studio.example.test/publish/mobile/package-h5",
      videoUrl:
        "https://cdn.example.test/final.mp4?media_token=short-lived"
    });
    const launch = new URL(result.launchUrl!);
    assert.equal(launch.protocol, "snssdk1128:");
    assert.equal(launch.searchParams.get("share_type"), "h5");
    assert.equal(launch.searchParams.get("client_key"), "h5-client-key");
    assert.equal(launch.searchParams.get("state"), "package-h5");
    assert.equal(launch.searchParams.get("share_to_publish"), "1");
    assert.equal(
      launch.searchParams.get("video_path"),
      "https://cdn.example.test/final.mp4?media_token=short-lived"
    );
    const nonce = launch.searchParams.get("nonce_str")!;
    const timestamp = launch.searchParams.get("timestamp")!;
    const signParams: Array<[string, string]> = [
      ["nonce_str", nonce],
      ["ticket", "ticket-fixed"],
      ["timestamp", timestamp]
    ];
    const expected = createHash("md5")
      .update(
        signParams
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => key + "=" + value)
          .join("&"),
        "utf8"
      )
      .digest("hex");
    assert.equal(launch.searchParams.get("signature"), expected);

    await assert.rejects(
      provider.prepareHandoff({
        projectId: "project-h5",
        packageId: "package-local",
        title: "H5 local",
        bridgeUrl: "http://127.0.0.1/publish/mobile/package-local",
        videoUrl: "http://127.0.0.1/final.mp4"
      }),
      /publicly reachable HTTPS/
    );
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("one-time PublishPackage token is hashed, replay-safe, and handoff completion never means PUBLISHED", async () => {
  const handoff = new FakeHandoffProvider();
  const f = await fixture([handoff, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, handoff.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Publish once",
      description: "draft",
      publicBaseUrl: "https://studio.example.test"
    });

    assert.match(created.claimUrl, /#token=/);
    assert.doesNotMatch(created.claimUrl, /\?token=/);
    const row = await f.db.publishPackageRecord.findUnique({
      where: { id: created.package.id }
    });
    assert.ok(row);
    assert.equal(row!.singleUseTokenHash, sha256Text(created.claimToken));
    assert.notEqual(row!.singleUseTokenHash, created.claimToken);
    assert.equal(
      JSON.stringify(created.package).includes("singleUseTokenHash"),
      false
    );

    const claimed = await f.bridge.claimPackage({
      packageId: created.package.id,
      token: created.claimToken
    });
    assert.ok(claimed.sessionToken);
    await assert.rejects(
      f.bridge.claimPackage({
        packageId: created.package.id,
        token: created.claimToken
      }),
      (error: unknown) =>
        error instanceof DomainValidationError &&
        /already used/.test(error.message)
    );

    const handoffResult = await f.bridge.startHandoff({
      packageId: created.package.id,
      sessionToken: claimed.sessionToken,
      publicBaseUrl: "https://studio.example.test"
    });
    assert.equal(handoffResult.package.status, "AWAITING_USER_ACTION");
    assert.ok(handoff.lastInput?.videoUrl.includes("media_token="));
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "PUBLISHING"
    );

    const mediaUrl = new URL(handoff.lastInput!.videoUrl);
    const mediaToken = mediaUrl.searchParams.get("media_token");
    assert.ok(mediaToken);
    const media = await f.bridge.mediaByToken({
      packageId: created.package.id,
      mediaToken: mediaToken!
    });
    assert.equal(media.artifact.id, f.finalArtifact.id);

    const completed = await f.bridge.completeHandoff({
      packageId: created.package.id,
      sessionToken: claimed.sessionToken,
      note: "handoff only"
    });
    assert.equal(completed.status, "HANDOFF_COMPLETED");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );
    const receipts = await f.publishRepo.listReceipts(f.projectId);
    assert.equal(
      receipts.some(
        (receipt) =>
          receipt.kind === "HANDOFF_COMPLETED" && receipt.trusted === false
      ),
      true
    );
    assert.equal(
      receipts.some((receipt) => receipt.kind === "PUBLISHED_CONFIRMED"),
      false
    );

    const snapshot = new ProjectSnapshotService(
      f.projectsRoot,
      f.productFlow,
      new LocalProductInputStore(f.projectsRoot, f.artifacts),
      f.artifacts,
      new PrismaGenerationRepository(f.db),
      new PrismaWorkflowRepository(f.db),
      new PrismaReviewRepository(f.db),
      new PrismaProviderAuditRepository(f.db),
      new PrismaReferenceVideoRepository(f.db),
      new PrismaResearchRepository(f.db),
      new PrismaTimelineRepository(f.db),
      f.bridge
    );
    const snapshotPath = await snapshot.refresh(f.projectId);
    const snapshotText = await fs.readFile(snapshotPath, "utf8");
    assert.equal(snapshotText.includes(created.claimToken), false);
    assert.equal(snapshotText.includes(claimed.sessionToken), false);
    assert.equal(snapshotText.includes("singleUseTokenHash"), false);
    assert.equal(snapshotText.includes("sessionTokenHash"), false);
    assert.equal(snapshotText.includes("mediaTokenHash"), false);
    const snapshotJson = JSON.parse(snapshotText) as {
      publish?: { packages?: Array<{ status?: string }> };
    };
    assert.equal(
      snapshotJson.publish?.packages?.[0]?.status,
      "HANDOFF_COMPLETED"
    );
  } finally {
    await f.dispose();
  }
});

test("expired or invalid PublishPackage claim is rejected", async () => {
  const f = await fixture([
    new FakeHandoffProvider(),
    new ManualExportProvider()
  ]);
  try {
    await f.bridge.setPreference(f.projectId, "DOUYIN_SDK_HANDOFF");
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Expire",
      publicBaseUrl: "https://studio.example.test"
    });
    await f.db.publishPackageRecord.update({
      where: { id: created.package.id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    await assert.rejects(
      f.bridge.claimPackage({
        packageId: created.package.id,
        token: created.claimToken
      }),
      /invalid, expired, or already used/
    );
    const after = await f.publishRepo.findPackageById(created.package.id);
    assert.equal(after?.status, "EXPIRED");
  } finally {
    await f.dispose();
  }
});

test("only explicit trusted direct-publish receipt can move project to PUBLISHED", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Direct",
      publicBaseUrl: "https://studio.example.test"
    });
    await assert.rejects(
      f.bridge.directPublish({
        projectId: f.projectId,
        packageId: created.package.id,
        confirmed: false
      }),
      /explicit user confirmation/
    );
    assert.equal(direct.publishCalls, 0);
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );

    const result = await f.bridge.directPublish({
      projectId: f.projectId,
      packageId: created.package.id,
      confirmed: true
    });
    assert.equal(direct.publishCalls, 1);
    assert.equal(result.package.status, "PUBLISHED_CONFIRMED");
    assert.equal(result.receipt.trusted, true);
    assert.equal(result.receipt.kind, "PUBLISHED_CONFIRMED");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "PUBLISHED"
    );
  } finally {
    await f.dispose();
  }
});




test("browser submission unknown is recorded without marking project published or auto-retrying", async () => {
  const browser = new FakeUnknownDirectProvider();
  const f = await fixture([browser, new ManualExportProvider()]);
  try {
    await f.bridge.setPreference(f.projectId, browser.type);
    const created = await f.bridge.createPackage({
      projectId: f.projectId,
      title: "Browser unknown",
      publicBaseUrl: "https://studio.example.test"
    });

    await assert.rejects(
      f.bridge.directPublish({
        projectId: f.projectId,
        packageId: created.package.id,
        confirmed: true
      }),
      /管理页暂未确认|禁止自动重试/
    );

    const stored = await f.publishRepo.findPackageById(created.package.id);
    assert.equal(stored?.status, "SUBMISSION_UNKNOWN");
    assert.equal(stored?.errorCode, "SUBMISSION_UNKNOWN");
    assert.equal(
      (await f.productFlow.getProject(f.projectId))?.status,
      "READY_TO_PUBLISH"
    );

    const receipts = await f.publishRepo.listReceiptsForPackage(
      created.package.id
    );
    assert.equal(
      receipts.some(
        (receipt) =>
          receipt.kind === "SUBMISSION_UNKNOWN" &&
          receipt.trusted === false
      ),
      true
    );
    assert.equal(
      receipts.some((receipt) => receipt.kind === "PUBLISHED_CONFIRMED"),
      false
    );
  } finally {
    await f.dispose();
  }
});

test("background acceptance is durable before slow probes; concurrent packages and request replay publish once", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct, new ManualExportProvider()]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const make = () => f.bridge.createPackage({ projectId: f.projectId, title: "Concurrent", publicBaseUrl: "https://studio.example.test" });
    const a = await make(), b = await make();
    const probe = direct.probe.bind(direct);
    direct.probe = async (id) => { await gate; return probe(id); };
    const request = (id: string) => ({ projectId: f.projectId, packageId: id, confirmed: true });
    const results = await Promise.allSettled([f.bridge.startDirectPublish(request(a.package.id)), f.bridge.startDirectPublish(request(b.package.id)), f.bridge.startDirectPublish(request(a.package.id))]);
    const accepted = results.filter((r) => r.status === "fulfilled");
    assert.equal(accepted.length, 1);
    const started = (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.bridge.startDirectPublish>>>).value;
    assert.equal(started.package.status, "DIRECT_PUBLISHING");
    assert.equal((await f.publishRepo.findPackageById(started.package.id))?.status, "DIRECT_PUBLISHING");
    assert.equal(direct.publishCalls, 0);
    await f.bridge.audit(f.projectId);
    await assert.rejects(make(), /不要重复创建/);
    release();
    assert.equal((await started.completion).package.status, "PUBLISHED_CONFIRMED");
    assert.equal(direct.publishCalls, 1);
    await assert.rejects(f.bridge.directPublish(request(started.package.id)), /不要重复提交/);
    assert.equal(direct.publishCalls, 1);
  } finally { release(); await f.dispose(); }
});

test("expired direct confirmations and preflight failure never invoke publishing", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const make = () => f.bridge.createPackage({ projectId: f.projectId, title: "Preflight", publicBaseUrl: "https://studio.example.test" });
    const expired = await make();
    await f.db.publishPackageRecord.update({ where: { id: expired.package.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: expired.package.id, confirmed: true }), /已过期/);
    const active = await make();
    direct.probe = async () => { throw Error("Preflight offline"); };
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: active.package.id, confirmed: true }), /Preflight offline/);
    assert.equal((await f.publishRepo.findPackageById(active.package.id))?.status, "FAILED");
    assert.equal(direct.publishCalls, 0);
  } finally { await f.dispose(); }
});

test("an execution error is uncertain, blocks new packages, and is never retried", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const make = () => f.bridge.createPackage({ projectId: f.projectId, title: "Unknown", publicBaseUrl: "https://studio.example.test" });
    const pkg = await make();
    direct.directPublish = async () => { direct.publishCalls++; throw Error("Connection lost after starting uploader"); };
    await assert.rejects(f.bridge.directPublish({ projectId: f.projectId, packageId: pkg.package.id, confirmed: true }), /Connection lost/);
    assert.equal((await f.publishRepo.findPackageById(pkg.package.id))?.status, "SUBMISSION_UNKNOWN");
    await assert.rejects(make(), /不要重复创建/);
    assert.equal(direct.publishCalls, 1);
  } finally { await f.dispose(); }
});

test("startup recovery preserves interrupted evidence and never resumes publication", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "Interrupted", publicBaseUrl: "https://studio.example.test" });
    await f.publishRepo.beginDirectPublish(created.package.id, new Date().toISOString());
    assert.equal(await f.bridge.recoverInterruptedDirectPublishes(), 1);
    assert.equal(await f.bridge.recoverInterruptedDirectPublishes(), 0);
    assert.equal((await f.publishRepo.findPackageById(created.package.id))?.errorCode, "PUBLISH_INTERRUPTED");
    const receipts = await f.publishRepo.listReceiptsForPackage(created.package.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.trusted, false);
    assert.equal(direct.publishCalls, 0);
  } finally { await f.dispose(); }
});

test("same-title management page evidence is not a trusted video receipt", async () => {
  const make = (result: DouyinBrowserPublishResult) => new DouyinBrowserAutomationProvider({
    probe: async () => ({ ok: true, status: "READY" }),
    resolveAccountName: async () => "default",
    check: async () => ({ ok: true, account: "default", valid: true, status: "VALID" }),
    login: async () => ({ ok: false, account: "default", status: "AUTH_REQUIRED" }),
    publish: async () => result
  });
  const result = { ok: true, account: "default", verified: true, status: "PUBLISHED_CONFIRMED", externalReference: "https://creator.douyin.com/creator-micro/content/manage?enter_from=publish" };
  const input = { projectId: "p", packageId: "pkg", videoPath: "not-opened.mp4", title: "Same title" };
  await assert.rejects(make(result).directPublish(input), /作品链接/);
  const valid = { ...result, videoId: "7696433689672027401", externalReference: "https://www.douyin.com/video/7696433689672027401" };
  assert.equal((await make(valid).directPublish(input)).trusted, true);
  await assert.rejects(make({ ...valid, videoId: "7696433689672027402" }).directPublish(input), /作品链接/);
  await assert.rejects(make({ ...valid, externalReference: "https://example.test/video/7696433689672027401" }).directPublish(input), /作品链接/);
});

test("publish UI distinguishes prepared/direct evidence, scopes duplicate guard to current final, and polls durable status", async () => {
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "UI", publicBaseUrl: "https://studio.example.test" });
    const args = { projectId: f.projectId, projectName: "UI", acceptedFinal: true, finalArtifactHash: f.finalArtifact.sha256!, preference: await f.bridge.getPreference(f.projectId), probes: [await direct.probe(f.projectId)], packages: [created.package], receipts: [] };
    const prepared = renderPublishCenter(args);
    assert.match(prepared, /已准备，待确认发布/);
    assert.doesNotMatch(prepared, /等待手机领取/);
    assert.match(prepared, /publish\/status/);
    assert.match(prepared, /r.status===202/);
    for (const script of prepared.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]!);
    const unknown = { ...created.package, status: "SUBMISSION_UNKNOWN" as const };
    assert.match(renderPublishCenter({ ...args, packages: [unknown] }), /id="p1-create" disabled/);
    assert.doesNotMatch(renderPublishCenter({ ...args, packages: [{ ...unknown, finalArtifactHash: H.d }] }), /id="p1-create" disabled/);
    const historical = renderPublishCenter({ ...args, preference: { ...args.preference, providerType: "DOUYIN_BROWSER_AUTOMATION" }, packages: [{ ...created.package, providerType: "DOUYIN_BROWSER_AUTOMATION", status: "PUBLISHED_CONFIRMED", publishedConfirmedAt: new Date().toISOString(), handoffReference: "https://creator.douyin.com/creator-micro/content/manage" }] });
    assert.match(historical, /公开状态待核对/);
    const linked = renderPublishCenter({ ...args, packages: [{ ...created.package, providerType: "DOUYIN_BROWSER_AUTOMATION", status: "PUBLISHED_CONFIRMED", publishedConfirmedAt: new Date().toISOString(), handoffReference: "https://www.douyin.com/video/7696433689672027401" }] });
    assert.match(linked, /打开抖音作品/);
    const activeHtml = renderPublishCenter({ ...args, packages: [{ ...created.package, status: "DIRECT_PUBLISHING" }] });
    const state = { textContent: "" };
    const directError = { textContent: "" };
    const timers: Array<() => Promise<void>> = [];
    const reads: string[] = [];
    let stage = "DIRECT_PUBLISHING", reloads = 0;
    const context = {
      document: { querySelector: (selector: string) => selector === '#publish-task-state' ? state : selector === '#p1-direct-error' ? directError : null },
      fetch: async (url: string) => { reads.push(url); return { ok: true, json: async () => ({ packages: [{ ...created.package, status: stage }] }) }; },
      setTimeout: (callback: () => Promise<void>) => timers.push(callback),
      location: { reload: () => { reloads++; } }, Date
    };
    const script = [...activeHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    vm.runInNewContext(script, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(state.textContent, /服务器正在检查账号/);
    assert.equal(directError.textContent, "");
    assert.equal(timers.length, 1);
    stage = "SUBMISSION_UNKNOWN";
    await timers.shift()!();
    assert.equal(reloads, 1);
    assert.equal(reads.length, 2);
    assert.ok(reads.every((url) => url.endsWith('/publish/status')));
  } finally { await f.dispose(); }
});

test("HTTP confirmation acknowledges 202 before a slow publisher and status polling never restarts it", async () => {
  const oldMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const { createAppServer } = await import("../src/web/server.js");
  const direct = new FakeDirectProvider();
  const f = await fixture([direct]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let snapshots = 0;
  const server = createAppServer({ publishBridge: f.bridge, snapshots: { refresh: async () => { snapshots++; } } } as unknown as NonNullable<Parameters<typeof createAppServer>[0]>);
  try {
    await f.bridge.setPreference(f.projectId, direct.type);
    const created = await f.bridge.createPackage({ projectId: f.projectId, title: "HTTP", publicBaseUrl: "https://studio.example.test" });
    const ready = direct.probe.bind(direct);
    direct.probe = async (id) => { await gate; return ready(id); };
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/projects/${f.projectId}/publish`;
    const confirm = () => fetch(base + '/packages/' + created.package.id + '/direct', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true })
    });
    const response = await confirm();
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { package: { status: string } }).package.status, "DIRECT_PUBLISHING");
    assert.equal(direct.publishCalls, 0);
    const status = await fetch(base + '/status');
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { packages: Array<{ status: string }> }).packages[0]?.status, "DIRECT_PUBLISHING");
    const duplicate = await confirm();
    assert.equal(duplicate.status, 400);
    await duplicate.arrayBuffer();
    release();
    for (let i = 0; i < 40 && snapshots === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(snapshots, 1);
    assert.equal(direct.publishCalls, 1);
  } finally {
    release(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.dispose();
    if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
  }
});
