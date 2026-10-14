import type {
  DouyinBrowserAccountStatus,
  DouyinBrowserPublisherRuntime
} from "../ports/douyin-browser-publisher-runtime.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsIdentity,
  type DouyinOpsProbe,
  type DouyinOpsRuntime
} from "../ports/douyin-ops-runtime.js";

export type DouyinAccountMatchStatus =
  | "MATCHED"
  | "MISMATCHED"
  | "UNKNOWN";

export type DouyinAccountMatchReason =
  | "STRONG_ID_MATCH"
  | "STRONG_ID_MISMATCH"
  | "PUBLISH_AUTH_REQUIRED"
  | "PUBLISH_RUNTIME_ERROR"
  | "PUBLISH_ID_MISSING"
  | "OPS_AUTH_REQUIRED"
  | "OPS_RUNTIME_UNAVAILABLE"
  | "OPS_RUNTIME_ERROR"
  | "OPS_ID_MISSING";

export type DouyinAccountMatchResult = {
  status: DouyinAccountMatchStatus;
  reason: DouyinAccountMatchReason;
  publish: {
    valid: boolean;
    displayName: string;
    platformUserId: string;
    runtimeStatus: string;
  };
  ops: {
    available: boolean;
    nickname: string;
    uid: string;
    secUid: string;
    uniqueId: string;
    shortId: string;
    runtimeStatus: string;
  };
  nicknameMatched: boolean;
  canAutoBindPublishedWork: boolean;
  checkedAt: string;
  message: string;
};

type MatchInput = {
  publish: DouyinBrowserAccountStatus;
  ops: DouyinOpsIdentity;
  checkedAt?: string;
};

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizedNickname(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function publicPublishIdentity(
  publish: DouyinBrowserAccountStatus
): DouyinAccountMatchResult["publish"] {
  return {
    valid: publish.valid === true,
    displayName: trimmed(publish.displayName),
    platformUserId: trimmed(publish.platformUserId),
    runtimeStatus: trimmed(publish.status)
  };
}

function publicOpsIdentity(
  ops: Partial<DouyinOpsIdentity>,
  runtimeStatus = "READY",
  available = true
): DouyinAccountMatchResult["ops"] {
  return {
    available,
    nickname: trimmed(ops.nickname),
    uid: trimmed(ops.uid),
    secUid: trimmed(ops.secUid),
    uniqueId: trimmed(ops.uniqueId),
    shortId: trimmed(ops.shortId),
    runtimeStatus
  };
}

function nicknameMatches(
  publishName: string,
  opsName: string
): boolean {
  if (!publishName || !opsName) return false;
  return (
    normalizedNickname(publishName) ===
    normalizedNickname(opsName)
  );
}

export function matchDouyinAccounts(
  input: MatchInput
): DouyinAccountMatchResult {
  const publish = publicPublishIdentity(input.publish);
  const ops = publicOpsIdentity(input.ops);
  const nicknameMatched = nicknameMatches(
    publish.displayName,
    ops.nickname
  );
  const checkedAt =
    input.checkedAt ?? new Date().toISOString();

  if (!publish.valid) {
    return {
      status: "UNKNOWN",
      reason: "PUBLISH_AUTH_REQUIRED",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "抖音发布账号尚未处于有效登录状态，无法确认账号一致性。"
    };
  }

  if (!publish.platformUserId) {
    return {
      status: "UNKNOWN",
      reason: "PUBLISH_ID_MISSING",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "发布运行时没有返回可靠的抖音号，不能仅凭昵称判定为同一账号。"
    };
  }

  if (!ops.uniqueId) {
    return {
      status: "UNKNOWN",
      reason: "OPS_ID_MISSING",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "抖音运营运行时没有返回可靠的抖音号，不能仅凭昵称判定为同一账号。"
    };
  }

  if (publish.platformUserId === ops.uniqueId) {
    return {
      status: "MATCHED",
      reason: "STRONG_ID_MATCH",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: true,
      checkedAt,
      message: "发布账号与运营账号的抖音号一致。"
    };
  }

  return {
    status: "MISMATCHED",
    reason: "STRONG_ID_MISMATCH",
    publish,
    ops,
    nicknameMatched,
    canAutoBindPublishedWork: false,
    checkedAt,
    message:
      "发布账号与运营账号的抖音号不一致，已禁止自动关联发布作品。"
  };
}

function unknownResult(input: {
  reason: DouyinAccountMatchReason;
  publish?: DouyinBrowserAccountStatus;
  ops?: Partial<DouyinOpsIdentity>;
  opsAvailable?: boolean;
  opsRuntimeStatus?: string;
  message: string;
  checkedAt?: string;
}): DouyinAccountMatchResult {
  const publish = input.publish
    ? publicPublishIdentity(input.publish)
    : {
        valid: false,
        displayName: "",
        platformUserId: "",
        runtimeStatus: "FAILED"
      };
  const ops = publicOpsIdentity(
    input.ops ?? {},
    input.opsRuntimeStatus ?? "FAILED",
    input.opsAvailable ?? false
  );
  return {
    status: "UNKNOWN",
    reason: input.reason,
    publish,
    ops,
    nicknameMatched: nicknameMatches(
      publish.displayName,
      ops.nickname
    ),
    canAutoBindPublishedWork: false,
    checkedAt:
      input.checkedAt ?? new Date().toISOString(),
    message: input.message
  };
}

export class DouyinAccountBindingService {
  constructor(
    private readonly publisherRuntime: DouyinBrowserPublisherRuntime,
    private readonly opsRuntime: DouyinOpsRuntime
  ) {}

  async inspect(opsProbe?: DouyinOpsProbe): Promise<DouyinAccountMatchResult> {
    const checkedAt = new Date().toISOString();

    // Publishing readiness must not prevent read-only operations identity detection.
    let publish: DouyinBrowserAccountStatus = {
      ok: false, account: "", valid: false, status: "FAILED"
    };
    let publishIssue: DouyinAccountMatchResult | undefined;
    try {
      const account = await this.publisherRuntime.resolveAccountName();
      publish = await this.publisherRuntime.check(account);
      if (!publish.valid) {
        const failed = publish.status !== "AUTH_REQUIRED";
        publishIssue = unknownResult({
          reason: failed ? "PUBLISH_RUNTIME_ERROR" : "PUBLISH_AUTH_REQUIRED",
          publish,
          message: failed
            ? "发布功能尚未就绪，暂不能核验发布账号；运营账号可以独立识别和读取。"
            : "发布账号需要登录，暂不能核验与运营账号是否一致。",
          checkedAt
        });
      }
    } catch {
      publishIssue = unknownResult({
        reason: "PUBLISH_RUNTIME_ERROR", publish,
        message: "发布功能尚未就绪，暂不能核验发布账号；运营账号可以独立识别和读取。",
        checkedAt
      });
    }

    let probe;
    try {
      probe = opsProbe ?? await this.opsRuntime.probe();
    } catch (error) {
      return unknownResult({
        reason: "OPS_RUNTIME_ERROR",
        publish,
        opsAvailable: false,
        opsRuntimeStatus: "PROVIDER_ERROR",
        message:
          "抖音运营连接检查失败：" +
          (error instanceof Error
            ? error.message
            : String(error)),
        checkedAt
      });
    }

    if (!probe.ready) {
      const reason: DouyinAccountMatchReason =
        probe.status === "AUTH_REQUIRED"
          ? "OPS_AUTH_REQUIRED"
          : "OPS_RUNTIME_UNAVAILABLE";
      return unknownResult({
        reason,
        publish,
        opsAvailable: false,
        opsRuntimeStatus: probe.status,
        message:
          probe.message?.trim() ||
          (reason === "OPS_AUTH_REQUIRED"
            ? "抖音运营账号需要重新登录。"
            : "抖音运营连接当前不可用。"),
        checkedAt
      });
    }

    let ops: DouyinOpsIdentity;
    try {
      ops = await this.opsRuntime.identity();
    } catch (error) {
      if (
        error instanceof DouyinOpsRuntimeError &&
        error.code === "AUTH_REQUIRED"
      ) {
        return unknownResult({
          reason: "OPS_AUTH_REQUIRED",
          publish,
          opsAvailable: true,
          opsRuntimeStatus: "AUTH_REQUIRED",
          message: error.message,
          checkedAt
        });
      }
      return unknownResult({
        reason: "OPS_RUNTIME_ERROR",
        publish,
        opsAvailable: true,
        opsRuntimeStatus:
          error instanceof DouyinOpsRuntimeError
            ? error.code
            : "PROVIDER_ERROR",
        message:
          "抖音运营账号身份检查失败：" +
          (error instanceof Error
            ? error.message
            : String(error)),
        checkedAt
      });
    }

    if (publishIssue) {
      return {
        ...publishIssue,
        ops: publicOpsIdentity(ops),
        nicknameMatched: nicknameMatches(publish.displayName ?? "", ops.nickname)
      };
    }

    return matchDouyinAccounts({
      publish,
      ops,
      checkedAt
    });
  }
}
