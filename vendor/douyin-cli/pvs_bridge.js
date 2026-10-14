#!/usr/bin/env node
// pvs_bridge.js — Stable, read-only machine interface for Product Video Studio.

const {
  CONTRACT_VERSION,
  PvsBridgeError,
  PvsDouyinRuntime,
} = require("./lib/pvs/runtime");

const RESULT_PREFIX = "PVS_DOUYIN_JSON:";

const ALLOWED_OPERATIONS = new Set([
  "probe",
  "identity",
  "my",
  "search",
  "video",
  "comments",
  "replies",
  "download",
  "post-reply",
]);

const WRITE_OPERATIONS = new Set([
  "post",
  "like",
  "suggest",
  "getReply",
  "draft",
  "campaign",
  "dm",
  "delete-comment",
  "upload-image",
  "browse",
  "note",
]);

const OPERATION_FLAGS = {
  probe: new Set(),
  identity: new Set(),
  my: new Set(["count"]),
  search: new Set(["query", "count", "offset"]),
  video: new Set(["aweme-id"]),
  comments: new Set(["aweme-id", "cursor", "count"]),
  replies: new Set(["aweme-id", "cid", "cursor", "count"]),
  download: new Set(["aweme-id"]),
  "post-reply": new Set([
    "aweme-id",
    "cid",
    "text",
    "write-intent-id",
    "confirmed",
  ]),
};

function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const operation = String(args.shift() || "").trim();
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new PvsBridgeError(
        "INVALID_ARGUMENT",
        "只接受 --flag value 形式的参数"
      );
    }
    const key = token.slice(2);
    if (!key) {
      throw new PvsBridgeError("INVALID_ARGUMENT", "参数名不能为空");
    }
    const value = args[i + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new PvsBridgeError(
        "INVALID_ARGUMENT",
        "参数 " + token + " 缺少值"
      );
    }
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new PvsBridgeError(
        "INVALID_ARGUMENT",
        "参数 " + token + " 重复"
      );
    }
    flags[key] = value;
    i += 1;
  }

  return { operation, flags };
}

function envelope(operation, ok, status, data, error) {
  const value = {
    contractVersion: CONTRACT_VERSION,
    readonly: operation !== "post-reply",
    operation,
    ok: Boolean(ok),
    status,
    checkedAt: new Date().toISOString(),
  };
  if (data !== undefined) value.data = data;
  if (error) {
    value.error = {
      code: String(error.code || status || "PROVIDER_ERROR"),
      message: String(error.message || error),
    };
  }
  return value;
}

function writeResult(value, out = console.log) {
  out(RESULT_PREFIX + JSON.stringify(value));
}

function bridgeError(error) {
  if (error instanceof PvsBridgeError) return error;
  return new PvsBridgeError(
    "PROVIDER_ERROR",
    error instanceof Error ? error.message : String(error)
  );
}

async function dispatch(runtime, operation, flags = {}) {
  if (!operation) {
    throw new PvsBridgeError(
      "INVALID_ARGUMENT",
      "缺少操作名"
    );
  }

  if (WRITE_OPERATIONS.has(operation)) {
    throw new PvsBridgeError(
      "WRITE_OPERATION_DISABLED",
      "PVS P0 Bridge 禁止抖音写操作：" + operation
    );
  }

  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new PvsBridgeError(
      "UNSUPPORTED_COMMAND",
      "PVS Bridge 不支持该操作：" + operation
    );
  }

  const allowedFlags = OPERATION_FLAGS[operation] || new Set();
  const unknownFlags = Object.keys(flags).filter(
    (key) => !allowedFlags.has(key)
  );
  if (unknownFlags.length) {
    throw new PvsBridgeError(
      "INVALID_ARGUMENT",
      operation + " 不支持参数：" + unknownFlags.map((key) => "--" + key).join(", ")
    );
  }

  if (operation === "probe") {
    const result = await runtime.probe();
    return envelope(
      operation,
      result.ready === true,
      result.status || (result.ready ? "READY" : "FAILED"),
      result
    );
  }

  if (operation === "identity") {
    return envelope(
      operation,
      true,
      "READY",
      await runtime.identity()
    );
  }

  if (operation === "my") {
    return envelope(
      operation,
      true,
      "READY",
      {
        items: await runtime.my({
          count: flags.count,
        }),
      }
    );
  }

  if (operation === "search") {
    return envelope(
      operation,
      true,
      "READY",
      {
        items: await runtime.search({
          query: flags.query,
          count: flags.count,
          offset: flags.offset,
        }),
      }
    );
  }

  if (operation === "video") {
    return envelope(
      operation,
      true,
      "READY",
      {
        work: await runtime.video({
          awemeId: flags["aweme-id"],
        }),
      }
    );
  }

  if (operation === "comments") {
    return envelope(
      operation,
      true,
      "READY",
      await runtime.comments({
        awemeId: flags["aweme-id"],
        cursor: flags.cursor,
        count: flags.count,
      })
    );
  }

  if (operation === "replies") {
    return envelope(
      operation,
      true,
      "READY",
      await runtime.replies({
        awemeId: flags["aweme-id"],
        cid: flags.cid,
        cursor: flags.cursor,
        count: flags.count,
      })
    );
  }

  if (operation === "download") {
    return envelope(
      operation,
      true,
      "READY",
      await runtime.download({
        awemeId: flags["aweme-id"],
      })
    );
  }

  if (operation === "post-reply") {
    if (flags.confirmed !== "yes") {
      throw new PvsBridgeError(
        "WRITE_CONFIRMATION_REQUIRED",
        "post-reply 必须显式 confirmed=yes"
      );
    }
    const writeIntentId =
      String(flags["write-intent-id"] || "").trim();
    if (
      !/^[0-9a-fA-F-]{16,64}$/.test(
        writeIntentId
      )
    ) {
      throw new PvsBridgeError(
        "INVALID_ARGUMENT",
        "write-intent-id 格式无效"
      );
    }
    const result = await runtime.postReply({
      awemeId: flags["aweme-id"],
      cid: flags.cid,
      text: flags.text,
    });
    return envelope(
      operation,
      result.confirmed === true,
      result.status,
      {
        ...result,
        writeIntentId,
      }
    );
  }

  throw new PvsBridgeError(
    "UNSUPPORTED_COMMAND",
    "PVS Bridge 不支持该操作：" + operation
  );
}

async function run(argv, options = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    const runtime = options.runtime || new PvsDouyinRuntime();
    return await dispatch(runtime, parsed.operation, parsed.flags);
  } catch (error) {
    const mapped = bridgeError(error);
    return envelope(
      parsed?.operation || "",
      false,
      mapped.code,
      undefined,
      mapped
    );
  }
}

async function main() {
  const result = await run(process.argv.slice(2));
  writeResult(result);
  if (
    !result.ok &&
    ["INVALID_ARGUMENT", "UNSUPPORTED_COMMAND", "WRITE_OPERATION_DISABLED"].includes(
      result.status
    )
  ) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const mapped = bridgeError(error);
    writeResult(
      envelope("", false, mapped.code, undefined, mapped)
    );
    process.exitCode = 1;
  });
}

module.exports = {
  RESULT_PREFIX,
  ALLOWED_OPERATIONS,
  WRITE_OPERATIONS,
  OPERATION_FLAGS,
  parseArgs,
  envelope,
  writeResult,
  dispatch,
  run,
};
