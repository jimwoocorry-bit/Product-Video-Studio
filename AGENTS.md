# AGENTS.md — Product Video Studio（PVS）AI 执行约束

本文件约束所有通过 AgentDock MCP 操作本仓库的 AI Agent。
以下规则优先级高于你本轮的自主判断。违反任一条，本轮视为「未完成」，不得宣称完成。

---

## 1. 长命令必须走后台会话，并观察到进程退出

**禁止**用同步 `exec_command` 等待可能超过 100 秒的命令。

正确流程：

1. `exec_command` 启动命令 → 立即拿到 `session_id`
2. 反复 `session_observe` 轮询该 session
3. 需要交互或终止时用 `session_act`

**硬性要求：在观察到进程退出、或拿到明确 PASS/FAIL 之前，不得结束本轮回合。**
**严禁只调用一次 `session_observe`（返回 `duration_ms=0`）就结束回合。** 只 observe 一次等于没等结果，
既不能算成功也不能算失败，本轮一律视为「未完成」。

**例外 —— 常驻服务不算「进程退出」：**
启动常驻服务（如 `node --use-system-ca dist/src/web/server.js`）时，该进程**永远不会退出**。
此时「完成」的判据是日志出现 `listening on ...`，**看到即停止轮询**，不要死等进程退出。
启动完成后按第 7 节做 GET 健康检查（期望 `200`）。

已知限制：同步 `exec_command` 的执行窗口约 120 秒，超时返回 `status: timeout` 且输出被截断。
截断 ≠ 失败，但**截断也绝不能当作结论**。

---

## 2. 一轮只跑一个定向测试套件（重要）

`npm test` **没有过滤参数**，它永远跑全量（121 个套件），必然撞穿 120 秒窗口。
命令行里写 `npm test -- --tests xxx` 或 `--runInBand` 之类是**无效的**，它仍然跑全量。

单套件的正确跑法（PowerShell，在仓库根执行）：

```powershell
$db = Join-Path $env:TEMP "pvs-unit.db"
$env:DATABASE_URL = "file:" + ($db -replace '\\','/')
node node_modules/prisma/build/index.js migrate deploy
node --test --test-concurrency=1 dist/tests/clip-continuity-engine.test.js
```

前提：`dist/tests/<name>.test.js` 已存在。源码有改动时先
`node node_modules/typescript/lib/tsc.js -p tsconfig.json`（这一步同样建议走后台会话）。
不要用 `npx`，原因见第 5 节。

---

## 3. 结果先落盘，再结束回合

每轮结束前，把结果**追加**写入 `.runtime/p3-report.md`（不覆盖历史）：

- 时间、执行的命令、目标测试文件
- 结论：`PASS` / `FAIL` / `TRUNCATED`
- FAIL 时附失败用例名与错误摘要

写盘后再调用 `task_manage` 记一条 checkpoint。
目的：下一轮只需 1 次 `read_file` 即可接续，避免重复跑。

---

## 4. 安全边界（不可越过）

- 不部署生产 3090、不重启线上服务。
- 不触发任何付费生成（即梦 / Seedance 等）。
- 不执行抖音对外写操作、不发布。
- 不删除、不覆盖历史项目、视频与未提交改动。

---

## 5. 禁止使用 npm / npx（本机已禁用脚本执行）

本机 PowerShell `ExecutionPolicy` 为默认 `Restricted`，**`.ps1` 脚本一律无法运行**。
因此 `npm`、`npx`、`npm run *` 会被直接拦下：命令可能"返回成功"，但实际什么都没执行，
唯一输出是 `running scripts is disabled on this system`。

一切改用 `node` 直连（在仓库根执行）：

```powershell
# 编译
node node_modules/typescript/lib/tsc.js -p tsconfig.json
# 单套件测试（跑法见第 2 节）
node --test --test-concurrency=1 dist/tests/<name>.test.js
# 启动本地服务
node --use-system-ca dist/src/web/server.js
```

判定规则：若某条命令的唯一输出是 `running scripts is disabled on this system`
（或同类 ExecutionPolicy 报错），**必须判定为「命令未执行」**，
不得记为 PASS，不得据此宣称完成，更不能把它当成测试失败。

---

## 6. `session_observe` 偶发 `SESSION_NOT_FOUND` 的处理

约 1% 的 `session_observe` 会瞬时返回 `SESSION_NOT_FOUND`（`duration_ms=0`）。
这是会话查表的瞬时未命中，**不是会话被回收、不是任务失败、不是长跑被中断**。

处理方式：**立即重试一次**；仍失败再用 `session_act` 查该 session 状态后再判断。
**严禁把 `SESSION_NOT_FOUND` 记录成"会话被回收"并据此放弃、重启或重跑任务。**

---

## 7. 服务健康检查必须用 GET（带 `-L`），200/302 均算通过

验证本地服务是否可用时，**必须发带 `-L` 的 GET 请求**：

```powershell
curl.exe -L -s -o NUL -w "%{http_code}" http://127.0.0.1:3090
```

已实测的真实行为（本仓库 3090 服务）：

| 请求 | 状态码 | 含义 |
|---|---|---|
| 带上表的命令（`-L`） | `200` | 正常，这是期望值 |
| 同样命令但**不带** `-L` | `302` | 根路径重定向到 `/projects`，**服务正常** |
| `curl.exe -I`（HEAD 请求） | `404` | 请求方法差异，**不是故障** |
| 连接失败 | `000` | 服务没起来或已退出，**这才是 FAIL** |

判定规则：

- `200` 或 `302` → **通过**。
- `000` → **FAIL**（服务未启动或已退出）。
- `404` → 是 HEAD 方法问题，改用带 `-L` 的 GET 复测。
- 只有复测仍为 `000` / 5xx 才记 FAIL。**不得把 `302` 判成失败。**
