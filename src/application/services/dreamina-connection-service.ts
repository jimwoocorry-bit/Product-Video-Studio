import { execFile } from "node:child_process";
import type { DomesticJimengCliProvider, CommandExecution, CommandRunner } from "../../adapters/video/domestic-jimeng-cli-provider.js";

export type DreaminaConnectionState = {
  status: "NOT_INSTALLED" | "UNVERIFIED" | "NOT_AUTHENTICATED" | "AUTHENTICATED" | "WAITING" | "FAILED";
  message: string;
  executablePath?: string;
  cliVersion?: string;
  availableCredits?: number;
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: string;
};

type Pending = { deviceCode: string; authorizationUrl: string; userCode: string; expiresAt: string };
type ConnectionProvider = Pick<DomesticJimengCliProvider, "probe" | "accountStatus" | "getVerifiedIdentityContract">;

const runner: CommandRunner = (file, args, timeout) => new Promise(resolve => {
  execFile(file, [...args], {
    timeout, windowsHide: true, maxBuffer: 256 * 1024,
    env: process.env.PVS_DREAMINA_HOME ? { ...process.env, HOME: process.env.PVS_DREAMINA_HOME } : process.env
  }, (error, stdout, stderr) => resolve({
    stdout: String(stdout), stderr: String(stderr), exitCode: error ? 1 : 0,
    timedOut: Boolean((error as { killed?: boolean } | null)?.killed)
  }));
});

/** Only documented device-login commands are permitted; credentials stay in the CLI's own store. */
export class DreaminaConnectionService {
  private pending?: Pending;
  private inFlight?: Promise<DreaminaConnectionState>;
  constructor(private readonly provider: ConnectionProvider, private readonly run: CommandRunner = runner,
    private readonly now: () => number = Date.now) {}

  private currentPending(): Pending | undefined {
    if (this.pending && Date.parse(this.pending.expiresAt) <= this.now()) this.pending = undefined;
    return this.pending;
  }

  private waiting(base: DreaminaConnectionState): DreaminaConnectionState {
    const p = this.currentPending();
    return p ? { ...base, status: "WAITING", message: "请打开官方授权页完成登录，再点击“我已授权，确认连接”。",
      authorizationUrl: p.authorizationUrl, userCode: p.userCode, expiresAt: p.expiresAt } : base;
  }

  async status(): Promise<DreaminaConnectionState> {
    try {
      const probe = await this.provider.probe();
      const base = { executablePath: "executablePath" in probe ? probe.executablePath : undefined,
        cliVersion: "cliVersion" in probe ? probe.cliVersion : undefined };
      if (probe.code !== "READY") return { ...base,
        status: probe.code === "DREAMINA_NOT_FOUND" ? "NOT_INSTALLED" : "UNVERIFIED",
        message: probe.code === "DREAMINA_NOT_FOUND" ? "本实例尚未安装即梦 CLI，请先在运行 PVS 的电脑或服务器安装。" : "CLI 尚未通过身份和版本核验，请配置受支持的官方运行时。" };
      const account = await this.provider.accountStatus();
      if (account.status === "AUTHENTICATED") {
        this.pending = undefined;
        return { ...base, status: "AUTHENTICATED", message: "即梦 CLI 已连接并登录。", availableCredits: account.availableCredits };
      }
      return this.waiting({ ...base, status: "NOT_AUTHENTICATED", message: account.status === "UNKNOWN" ? "CLI 已就绪，登录状态尚未确认；可重新检测或点击连接完成授权。" : "即梦 CLI 已就绪，请点击连接并完成官方授权。" });
    } catch {
      return { status: "FAILED", message: "暂时无法检查即梦连接，请重试并检查本实例的网络和凭据存储权限。" };
    }
  }

  private serialize(action: () => Promise<DreaminaConnectionState>): Promise<DreaminaConnectionState> {
    if (this.inFlight) return this.inFlight;
    const promise = action().finally(() => { if (this.inFlight === promise) this.inFlight = undefined; });
    this.inFlight = promise;
    return promise;
  }

  begin(): Promise<DreaminaConnectionState> {
    return this.serialize(async () => {
      const state = await this.status();
      if (state.status !== "NOT_AUTHENTICATED") return state;
      const file = state.executablePath!;
      try {
        const help = await this.run(file, ["login", "--help"], 10_000);
        if (help.exitCode || !/--headless/.test(help.stdout) || !/checklogin/.test(help.stdout)) {
          return { ...state, status: "FAILED", message: "当前 CLI 不支持已核实的设备授权流程，请更新官方 CLI。" };
        }
        const result = await this.run(file, ["login", "--headless"], 20_000);
        if (result.exitCode || result.timedOut) return { ...state, status: "FAILED", message: "获取官方授权失败，请检查网络后重试。" };
        const values = parseLoginFields(result);
        if (!values.device_code) return await this.status();
        const url = new URL(values.verification_uri ?? "");
        const allowed = this.provider.getVerifiedIdentityContract()?.officialLoginOrigins ?? [];
        if (url.protocol !== "https:" || url.username || url.password || !allowed.some(origin => new URL(origin).origin === url.origin)) {
          return { ...state, status: "FAILED", message: "CLI 返回的授权地址未通过官方来源检查。" };
        }
        const expiry = Date.parse(values.expires_at ?? "");
        if (!values.user_code || !Number.isFinite(expiry) || expiry <= this.now() || values.device_code.length > 4096) {
          return { ...state, status: "FAILED", message: "CLI 返回的授权信息不完整或已过期，请重试。" };
        }
        this.pending = { deviceCode: values.device_code, userCode: values.user_code,
          authorizationUrl: url.href, expiresAt: new Date(expiry).toISOString() };
        return this.waiting(state);
      } catch {
        return { ...state, status: "FAILED", message: "无法发起即梦授权，请检查网络和 CLI 执行权限。" };
      }
    });
  }

  confirm(): Promise<DreaminaConnectionState> {
    return this.serialize(async () => {
      const state = await this.status();
      const p = this.currentPending();
      if (!p || state.status !== "WAITING") return state;
      try {
        // The private device reference is never accepted from a client or returned to it.
        const result = await this.run(state.executablePath!, ["login", "checklogin", "--device_code=" + p.deviceCode, "--poll=0"], 20_000);
        const checked = await this.status();
        if (checked.status === "AUTHENTICATED") return checked;
        if (result.timedOut) return { ...checked, message: "确认登录超时，请稍后再次确认。" };
        if (/expired|access_denied|authorization_declined|授权.*拒绝|已过期/i.test(result.stdout + result.stderr)) {
          this.pending = undefined;
          return { ...await this.status(), message: "本次授权已过期或被拒绝，请重新连接。" };
        }
        return checked;
      } catch {
        return { ...this.waiting(state), message: "暂时无法确认授权，请稍后重试。" };
      }
    });
  }
}

function parseLoginFields(result: CommandExecution): Record<string, string> {
  // Verified legacy Dreamina CLI 1.4.18/1.4.19 emits named text fields, not Canvas JSON.
  const fields: Record<string, string> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(verification_uri|user_code|device_code|expires_at):\s*(.+)$/);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return fields;
}
