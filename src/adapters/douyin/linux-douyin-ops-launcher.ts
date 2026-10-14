import type { DouyinOpsLauncher, DouyinOpsLaunchResult } from "../../application/ports/douyin-ops-launcher.js";
import type { DouyinResearchAuthLauncher, DouyinResearchAuthLaunchResult, DouyinResearchAuthSyncResult } from "../research/douyin-research-auth-launcher.js";
import { DomainValidationError } from "../../domain/validation.js";

/** Fixed loopback management channel; it never accepts arbitrary commands/URLs. */
export class LinuxDouyinOpsLauncher implements DouyinOpsLauncher {
  constructor(private readonly request: typeof fetch = fetch,
    private readonly endpoint = "http://127.0.0.1:19424") {}
  async launch(): Promise<DouyinOpsLaunchResult> {
    try {
      const response = await this.request(this.endpoint + "/launch", {
        method: "POST", signal: AbortSignal.timeout(20_000)
      });
      const result = await response.json() as { ok?: boolean; alreadyRunning?: boolean };
      if (!response.ok || !result.ok) return { ok: false, status: "FAILED", message: "服务器浏览器启动失败，请查看浏览器服务日志。" };
      return { ok: true, status: "STARTED", message: result.alreadyRunning
        ? "已复用服务器上的专用浏览器。请打开远程浏览器，检查登录和连接状态。"
        : "服务器专用浏览器已启动。请打开远程浏览器完成抖音登录，再重新检查连接。" };
    } catch {
      return { ok: false, status: "UNAVAILABLE", message: "服务器浏览器服务不可用，请检查 Linux 容器运行状态。" };
    }
  }
}

export class LinuxDouyinResearchAuthLauncher implements DouyinResearchAuthLauncher {
  constructor(private readonly launcher = new LinuxDouyinOpsLauncher(), private readonly request: typeof fetch = fetch) {}
  async launch(_query?: string): Promise<DouyinResearchAuthLaunchResult> {
    const result = await this.launcher.launch();
    if (!result.ok) throw new DomainValidationError(result.message);
    return { started: true, alreadyRunning: result.message.startsWith("已复用"), executable: "server-chromium" };
  }
  async syncCookies(): Promise<DouyinResearchAuthSyncResult> {
    try {
      const response = await this.request("http://127.0.0.1:19423/health", { signal: AbortSignal.timeout(3000) });
      const status = await response.json() as { ready?: boolean };
      if (!response.ok || !status.ready) throw Error("not-ready");
      // Browser cookies remain in its profile; PVS never exports them here.
      return { cookieCount: 0, hasSession: true };
    } catch { throw new DomainValidationError("服务器抖音浏览器尚未连接，请打开远程浏览器完成登录后重试。"); }
  }
}
