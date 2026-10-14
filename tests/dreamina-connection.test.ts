import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Script } from "node:vm";
import { DreaminaConnectionService } from "../src/application/services/dreamina-connection-service.js";
import { handleDreaminaConnectionHttp } from "../src/web/dreamina-connection-http.js";
import { renderDreaminaConnectionPage } from "../src/web/dreamina-connection-ui.js";
import type { CommandExecution, CommandRunner } from "../src/adapters/video/domestic-jimeng-cli-provider.js";
import type { ProviderProbeResult } from "../src/application/ports/video-provider.js";

const response = (stdout: string, exitCode = 0): CommandExecution => ({ stdout, stderr: "", exitCode, timedOut: false });
function fixture(options: { probe?: ProviderProbeResult; login?: string; authenticated?: boolean; help?: string } = {}) {
  let authenticated = options.authenticated ?? false;
  let clock = Date.parse("2026-10-14T04:00:00Z");
  const commands: string[][] = [];
  const probe: ProviderProbeResult = options.probe ?? {
    code: "READY", cliFound: true, identityVerified: true, executablePath: "/opt/dreamina", executableSha256: "a".repeat(64),
    cliVersion: "verified-build", providerIdentityHash: "b".repeat(64), supportedOperations: ["accountStatus"],
    supportedModels: ["seedance-2.0"], capabilityFingerprint: "c".repeat(64), rawStdout: "", rawStderr: ""
  };
  type Identity = NonNullable<ReturnType<ConstructorParameters<typeof DreaminaConnectionService>[0]["getVerifiedIdentityContract"]>>;
  const provider = {
    async probe() { return probe; },
    async accountStatus() { return { status: authenticated ? "AUTHENTICATED" as const : "NOT_AUTHENTICATED" as const }; },
    getVerifiedIdentityContract() { return { officialLoginOrigins: ["https://jimeng.jianying.com/"] } as Identity; }
  };
  const run: CommandRunner = async (_file, args) => {
    commands.push([...args]);
    if (args.includes("--help")) return response(options.help ?? "login --headless; login checklogin --device_code");
    if (args.includes("checklogin")) return response("authorization_pending", 1);
    return response(options.login ?? "请使用浏览器完成 OAuth Device Flow 登录。\nverification_uri: https://jimeng.jianying.com/ai-tool/cli-auth\nuser_code: USER-CODE\ndevice_code: private-device-reference\npoll_interval: 1s\nexpires_at: 2026-10-14T04:10:00Z\n");
  };
  return { service: new DreaminaConnectionService(provider, run, () => clock), commands,
    authenticate() { authenticated = true; }, expire() { clock += 11 * 60_000; } };
}

test("missing CLI never executes a login command", async () => {
  const f = fixture({ probe: { code: "DREAMINA_NOT_FOUND", cliFound: false, providerIdentityHash: "", capabilityFingerprint: "", rawStdout: "", rawStderr: "" } });
  assert.equal((await f.service.begin()).status, "NOT_INSTALLED");
  assert.deepEqual(f.commands, []);
});

test("unverified executable is never invoked for authorization", async () => {
  const f = fixture({ probe: { code: "PROVIDER_IDENTITY_UNVERIFIED", cliFound: true, executablePath: "/bad", executableSha256: "", providerIdentityHash: "", capabilityFingerprint: "", rawStdout: "", rawStderr: "" } });
  assert.equal((await f.service.begin()).status, "UNVERIFIED");
  assert.deepEqual(f.commands, []);
});

test("reading status never starts a device authorization", async () => {
  const f = fixture(); assert.equal((await f.service.status()).status, "NOT_AUTHENTICATED"); assert.deepEqual(f.commands, []);
});

test("parses actual legacy CLI text output and returns only public authorization fields", async () => {
  const f = fixture(); const state = await f.service.begin();
  assert.equal(state.status, "WAITING"); assert.equal(state.userCode, "USER-CODE");
  assert.equal(state.authorizationUrl, "https://jimeng.jianying.com/ai-tool/cli-auth");
  assert.ok(!JSON.stringify(state).includes("private-device-reference"));
  assert.deepEqual(f.commands, [["login", "--help"], ["login", "--headless"]]);
});

test("repeated and concurrent connect clicks reuse one pending device flow", async () => {
  const f = fixture(); const states = await Promise.all([f.service.begin(), f.service.begin()]);
  assert.deepEqual(states[0], states[1]); await f.service.begin();
  assert.equal(f.commands.filter(args => args.includes("--headless")).length, 1);
});

test("expired pending authorization is removed rather than presented as active", async () => {
  const f = fixture(); await f.service.begin(); f.expire();
  const state = await f.service.status(); assert.equal(state.status, "NOT_AUTHENTICATED"); assert.equal(state.authorizationUrl, undefined);
});

test("pending confirmation uses server-held reference and never claims login based on opening the URL", async () => {
  const f = fixture(); await f.service.begin(); const state = await f.service.confirm();
  assert.equal(state.status, "WAITING");
  assert.deepEqual(f.commands.at(-1), ["login", "checklogin", "--device_code=private-device-reference", "--poll=0"]);
  assert.ok(!JSON.stringify(state).includes("private-device-reference"));
});

test("account recheck is the source of truth and existing login does not start a fresh flow", async () => {
  const f = fixture(); await f.service.begin(); f.authenticate();
  assert.equal((await f.service.confirm()).status, "AUTHENTICATED");
  assert.equal((await f.service.begin()).authorizationUrl, undefined);
  assert.equal(f.commands.filter(args => args.includes("--headless")).length, 1);
});

test("rejects nonofficial, insecure and credential-bearing authorization URLs", async () => {
  for (const url of ["https://evil.example/login", "http://jimeng.jianying.com/login", "https://user:pass@jimeng.jianying.com/login", "javascript:alert(1)"]) {
    const f = fixture({ login: `verification_uri: ${url}\nuser_code: CODE\ndevice_code: secret\nexpires_at: 2026-10-14T04:10:00Z` });
    const state = await f.service.begin(); assert.equal(state.status, "FAILED"); assert.equal(state.authorizationUrl, undefined);
  }
});

test("unsupported login protocol cannot silently execute an invented command", async () => {
  const f = fixture({ help: "different CLI" }); assert.equal((await f.service.begin()).status, "FAILED");
  assert.deepEqual(f.commands, [["login", "--help"]]);
});

test("HTTP connection routes reject cross-site mutations and GET login", async () => {
  const f = fixture(); const server = http.createServer((req, res) => {
    void handleDreaminaConnectionHttp(req, res, new URL(req.url!, "http://pvs.invalid"), { dreaminaConnection: f.service });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + "/api/dreamina/connection/login")).status, 405);
    assert.equal((await fetch(base + "/api/dreamina/connection/login", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.deepEqual(f.commands, []);
    const result = await fetch(base + "/api/dreamina/connection/login", { method: "POST", headers: { Origin: base }, body: JSON.stringify({ command: "delete", deviceCode: "attacker" }) });
    assert.equal((await result.json() as { status: string }).status, "WAITING");
    assert.deepEqual(f.commands.at(-1), ["login", "--headless"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("connection UI contains real login/confirmation controls and escapes status content", () => {
  const page = renderDreaminaConnectionPage({ status: "FAILED", message: "<script>bad</script>" });
  assert.match(page, /连接 \/ 登录即梦 CLI/); assert.match(page, /我已授权，确认连接/);
  assert.ok(page.includes("&lt;script&gt;bad&lt;/script&gt;"));
  for (const [, source] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(source!);
});
