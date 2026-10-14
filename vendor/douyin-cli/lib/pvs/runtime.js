// lib/pvs/runtime.js — Read-only PVS integration runtime for douyin-cli.

const fs = require("fs");
const path = require("path");
const { BridgeClient } = require("../client/bridge-client");
const {
  normalizeIdentity,
  normalizeWork,
  normalizeMyPosts,
  normalizeSearch,
  normalizeCommentPage,
  extractMedia,
} = require("./normalize");

const SITE = "douyin.com";
const CONTRACT_VERSION = 1;

class PvsBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PvsBridgeError";
    this.code = code;
  }
}

function loadConfig(root = path.resolve(__dirname, "..", "..")) {
  try {
    return JSON.parse(fs.readFileSync((process.env.PVS_DOUYIN_CONFIG_PATH || path.join(root, "config.json")), "utf8"));
  } catch {
    return {};
  }
}

function classifyMessage(message) {
  const value = String(message || "");
  if (/Bridge Server 未启动|ECONNREFUSED|connect.*refused/i.test(value)) {
    return "BRIDGE_OFFLINE";
  }
  if (/Unauthorized|认证失败|access token/i.test(value)) {
    return "BRIDGE_AUTH_FAILED";
  }
  if (/identity.*not a function|CLIENT_SCRIPT_OUTDATED/i.test(value)) {
    return "CLIENT_SCRIPT_OUTDATED";
  }
  if (/验证码|风控|captcha|risk[_\s-]?control|verify[_\s-]?check/i.test(value)) {
    return "RISK_CONTROL";
  }
  if (/登录|未登录|login required|HTML 页面/i.test(value)) {
    return "AUTH_REQUIRED";
  }
  if (/timeout|no polling client connected/i.test(value)) {
    return "SITE_OFFLINE";
  }
  if (/未获取到视频详情|not found|已删除|无权限/i.test(value)) {
    return "NOT_FOUND";
  }
  return "PROVIDER_ERROR";
}

function asBridgeError(error, fallbackCode = "PROVIDER_ERROR") {
  if (error instanceof PvsBridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PvsBridgeError(classifyMessage(message) || fallbackCode, message);
}

function isMainDouyinUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return host === "www.douyin.com" || host === "douyin.com";
  } catch {
    return false;
  }
}

function selectMainConnection(status) {
  const list = Array.isArray(status?.connections?.[SITE])
    ? status.connections[SITE]
    : [];
  const candidates = list
    .map((connection, index) => ({ connection, index }))
    .filter(
      ({ connection }) =>
        connection &&
        connection.alive !== false &&
        isMainDouyinUrl(connection.url)
    )
    .sort((a, b) => {
      const at = Date.parse(a.connection.lastActivity || a.connection.connectedAt || "") || 0;
      const bt = Date.parse(b.connection.lastActivity || b.connection.connectedAt || "") || 0;
      return bt - at;
    });
  return candidates[0] || null;
}

function countValue(value, fallback, min = 1, max = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function nonNegativeValue(value, fallback = 0, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

function requireId(value, label, min = 8, max = 40) {
  const text = String(value || "").trim();
  const pattern = new RegExp("^\\d{" + min + "," + max + "}$");
  if (!pattern.test(text)) {
    throw new PvsBridgeError("INVALID_ARGUMENT", label + " 格式无效");
  }
  return text;
}

function requireQuery(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new PvsBridgeError("INVALID_ARGUMENT", "query 不能为空");
  }
  if (text.length > 120) {
    throw new PvsBridgeError("INVALID_ARGUMENT", "query 过长");
  }
  return text;
}

class PvsDouyinRuntime {
  constructor(options = {}) {
    const config = options.config || loadConfig(options.root);
    this.bridge =
      options.bridge ||
      new BridgeClient({
        host: config.bridge?.host || "127.0.0.1",
        port: config.bridge?.port || 19422,
        token: config.bridge?.token || "",
      });
  }

  async _mainConnection() {
    let status;
    try {
      status = await this.bridge.status();
    } catch (error) {
      throw asBridgeError(error);
    }
    const selected = selectMainConnection(status);
    if (!selected) {
      throw new PvsBridgeError(
        "SITE_OFFLINE",
        "未检测到 douyin.com 主页面连接"
      );
    }
    return selected;
  }

  async _call(expression, timeout = 30000) {
    const selected = await this._mainConnection();
    let response;
    try {
      response = await this.bridge.call({
        site: SITE,
        expression,
        awaitPromise: true,
        connIndex: selected.index,
        timeout,
      });
    } catch (error) {
      throw asBridgeError(error);
    }
    if (!response?.ok) {
      throw asBridgeError(
        new Error(response?.error || "Bridge Server 返回未知错误")
      );
    }
    return response.value;
  }

  async probe() {
    try {
      const [health, status] = await Promise.all([
        this.bridge.health(),
        this.bridge.status(),
      ]);
      if (!health?.ok || !status?.ok) {
        return {
          ready: false,
          status: "BRIDGE_OFFLINE",
          message: "Bridge Server 健康检查失败",
        };
      }

      const selected = selectMainConnection(status);
      if (!selected) {
        return {
          ready: false,
          status: "SITE_OFFLINE",
          bridgeVersion: health.version || "",
          uptimeSeconds: Number(health.uptime || 0),
          message: "Bridge 已运行，但未检测到 douyin.com 主页面连接",
        };
      }

      const capabilities = await this._call(
        "(function(){var b=window.__bridge||{};return {" +
          "bridge:typeof window.__bridge==='object'," +
          "identity:typeof b.identity==='function'," +
          "my:typeof b.myPosts==='function'," +
          "search:typeof b.search==='function'," +
          "video:typeof b.getDetail==='function'," +
          "comments:typeof b.getComments==='function'," +
          "replies:typeof b.replies==='function'" +
        "};})()",
        3_000
      );

      const required = ["bridge", "identity", "my", "search", "video", "comments", "replies"];
      const missing = required.filter((name) => capabilities?.[name] !== true);
      if (missing.length) {
        return {
          ready: false,
          status: "CLIENT_SCRIPT_OUTDATED",
          bridgeVersion: health.version || "",
          uptimeSeconds: Number(health.uptime || 0),
          connection: {
            id: String(selected.connection.id || ""),
            url: String(selected.connection.url || ""),
          },
          missingCapabilities: missing,
          message: "抖音 Bridge 用户脚本版本过旧",
        };
      }

      return {
        ready: true,
        status: "READY",
        bridgeVersion: health.version || "",
        uptimeSeconds: Number(health.uptime || 0),
        connection: {
          id: String(selected.connection.id || ""),
          url: String(selected.connection.url || ""),
          connectedAt: String(selected.connection.connectedAt || ""),
          lastActivity: String(selected.connection.lastActivity || ""),
        },
        capabilities,
      };
    } catch (error) {
      const mapped = asBridgeError(error);
      return {
        ready: false,
        status: mapped.code,
        message: mapped.message,
      };
    }
  }

  async identity() {
    // douyin.com 当前个人主页使用 profile/self；旧 query/user 可能返回
    // status_code=0 但不含 user，不能据此断定账号未登录。
    const selfProfileExpression =
      "(async function(){" +
        "var b=window.__bridge||{};" +
        "var q=typeof b._q==='function'?b._q():{device_platform:'webapp',aid:'6383',channel:'channel_pc_web'};" +
        "var r=await fetch('/aweme/v1/web/user/profile/self/?'+new URLSearchParams(q),{credentials:'include'});" +
        "if(!r.ok)throw new Error('profile/self HTTP '+r.status);" +
        "var d=await r.json();" +
        "if(d.status_code!==0)throw new Error('profile/self status '+d.status_code);" +
        "return d.user||{};" +
      "})()";
    let value = normalizeIdentity(await this._call(selfProfileExpression));
    if (
      !value.uid &&
      !value.secUid &&
      !value.uniqueId &&
      !value.shortId &&
      !value.nickname
    ) {
      // 为仍返回账号对象的旧版抖音接口保留兼容。
      value = normalizeIdentity(
        await this._call("window.__bridge.identity()")
      );
    }
    if (
      !value.uid &&
      !value.secUid &&
      !value.uniqueId &&
      !value.shortId &&
      !value.nickname
    ) {
      throw new PvsBridgeError(
        "AUTH_REQUIRED",
        "未取得当前抖音登录账号身份"
      );
    }
    return value;
  }

  async my(options = {}) {
    // 先验证当前账号，再按该账号 sec_uid 查询，避免读取其他账号作品。
    const identity = await this.identity();
    const count = countValue(options.count, 20);
    const expression = identity.secUid
      ? "window.__bridge.userPosts(" +
          JSON.stringify(identity.secUid) +
          ",0," + count + ")"
      : "window.__bridge.myPosts(0," + count + ")";
    const data = await this._call(expression);
    return normalizeMyPosts(data);
  }

  async search(options = {}) {
    const query = requireQuery(options.query);
    const count = countValue(options.count, 10);
    const offset = nonNegativeValue(options.offset, 0, 10000);
    const data = await this._call(
      "window.__bridge.search(" +
        JSON.stringify(query) +
        "," +
        offset +
        "," +
        count +
      ")"
    );
    return normalizeSearch(data);
  }

  async video(options = {}) {
    const awemeId = requireId(options.awemeId, "aweme-id");
    const data = await this._call(
      "window.__bridge.getDetail(" + JSON.stringify(awemeId) + ")"
    );
    if (!data?.aweme_detail) {
      throw new PvsBridgeError(
        "NOT_FOUND",
        "未获取到视频详情"
      );
    }
    return normalizeWork(data.aweme_detail);
  }

  async comments(options = {}) {
    const awemeId = requireId(options.awemeId, "aweme-id");
    const cursor = String(options.cursor ?? "0").trim() || "0";
    if (!/^\d{1,40}$/.test(cursor)) {
      throw new PvsBridgeError("INVALID_ARGUMENT", "cursor 格式无效");
    }
    const count = countValue(options.count, 20);
    const data = await this._call(
      "window.__bridge.getComments(" +
        JSON.stringify(awemeId) +
        "," +
        JSON.stringify(cursor) +
        "," +
        count +
      ")"
    );
    const page = normalizeCommentPage(data);
    for (const item of page.comments) {
      if (!item.awemeId) item.awemeId = awemeId;
    }
    return page;
  }

  async replies(options = {}) {
    const awemeId = requireId(options.awemeId, "aweme-id");
    const cid = requireId(options.cid, "cid", 1, 40);
    const cursor = String(options.cursor ?? "0").trim() || "0";
    if (!/^\d{1,40}$/.test(cursor)) {
      throw new PvsBridgeError("INVALID_ARGUMENT", "cursor 格式无效");
    }
    const count = countValue(options.count, 20);
    const data = await this._call(
      "window.__bridge.replies(" +
        JSON.stringify(cid) +
        "," +
        JSON.stringify(awemeId) +
        "," +
        JSON.stringify(cursor) +
        "," +
        count +
      ")"
    );
    const page = normalizeCommentPage(data, cid);
    for (const item of page.comments) {
      if (!item.awemeId) item.awemeId = awemeId;
    }
    return page;
  }

  async download(options = {}) {
    const awemeId = requireId(options.awemeId, "aweme-id");
    const data = await this._call(
      "window.__bridge.getDetail(" + JSON.stringify(awemeId) + ")"
    );
    if (!data?.aweme_detail) {
      throw new PvsBridgeError(
        "NOT_FOUND",
        "未获取到视频详情"
      );
    }
    return extractMedia(data.aweme_detail);
  }

  async postReply(options = {}) {
    const awemeId = requireId(options.awemeId, "aweme-id");
    const cid = requireId(options.cid, "cid", 1, 40);
    const replyText = String(options.text || "").trim();
    if (!replyText || replyText.length > 280) {
      throw new PvsBridgeError(
        "INVALID_ARGUMENT",
        "回复内容必须为 1–280 个字符"
      );
    }

    const selected = await this._mainConnection();
    const expression =
      "window.__bridge.publish(" +
      JSON.stringify(awemeId) + "," +
      JSON.stringify(replyText) + "," +
      JSON.stringify(cid) +
      ",null,null,null)";

    let response;
    try {
      response = await this.bridge.call({
        site: SITE,
        expression,
        awaitPromise: true,
        connIndex: selected.index,
        timeout: 30000,
      });
    } catch (error) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        message:
          "Bridge 调用中断，无法确认抖音是否已收到回复；禁止自动重试。",
      };
    }

    if (!response?.ok) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        message:
          "Bridge 未返回可确认结果；禁止自动重试。",
      };
    }

    const data = response.value || {};
    if (
      data.status_code !== undefined &&
      Number(data.status_code) !== 0
    ) {
      return {
        status: "REJECTED",
        confirmed: false,
        platformStatusCode: Number(data.status_code),
        message: "抖音明确拒绝了本次回复。",
      };
    }

    const replyCid = String(data.comment?.cid || "").trim();
    if (!/^\d{1,40}$/.test(replyCid)) {
      return {
        status: "SUBMISSION_UNKNOWN",
        confirmed: false,
        message:
          "平台未返回可信回复 CID，无法确认发布结果；禁止自动重试。",
      };
    }

    return {
      status: "REPLY_POSTED_CONFIRMED",
      confirmed: true,
      replyCid,
      text: String(data.comment?.text || replyText),
      createdAt: Number(data.comment?.create_time || 0),
    };
  }
}

module.exports = {
  CONTRACT_VERSION,
  PvsBridgeError,
  PvsDouyinRuntime,
  classifyMessage,
  selectMainConnection,
  isMainDouyinUrl,
  countValue,
  nonNegativeValue,
  requireId,
  requireQuery,
};
