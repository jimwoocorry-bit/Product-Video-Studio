# fnOS / Linux 独立版验收

日期：2026-10-14。分支：`codex/fnos-linux`。

## 隔离情况

- 原网页版源码复制基线共 528 个文件，原路径内容哈希检查通过。
- 原 Windows 桌面版已交付的补丁文件哈希保持一致。
- 飞牛原服务 `pvs-web` 继续使用原镜像 `d2e946f92d03db5465501e4d987ac26efa68a951d1679479e4398bb80ae12468`，启动时间保持 `2026-10-13T10:59:56.458367332Z`，健康状态正常；没有替换、重启或迁移它的数据。
- 新测试服务为 `pvs-web-fnos-test`，部署目录 `/vol1/docker/pvs-web-fnos-test`，访问 `http://192.168.1.6:3092/`。
- 新版本使用独立数据库、浏览器 Profile、Bridge token 和访问口令，没有迁入本机历史数据、抖音账号或 API 密钥。

## 已通过

1. Windows 上 TypeScript 编译通过，定向测试 6 通过 / 1 个 Linux 符号链接用例跳过。
2. 在真实 fnOS Linux 容器中从源码构建成功，定向测试 `fnos-linux.test.js` **7/7 通过，无跳过**。
3. 项目、任务、模型设置、抖音运营、远程浏览器页面及 noVNC 模块返回 200。
4. 未登录访问 API/远程资产被拒绝；无效口令、无效 Origin、伪造会话及跨站 WebSocket 被拒绝；正确 Cookie 可建立 VNC WebSocket 并收到实际 RFB 握手。
5. Chromium 155.0.8059.39 以非 root 身份在服务器启动，使用用户命名空间/沙箱；未使用 `--no-sandbox`、特权容器或对外映射 CDP。
6. 连续启动请求复用现有 Chromium；原 Bridge 源码校验通过，CDP 已在真实抖音主页面注册，运营连接显示 READY。
7. 实际 noVNC 画面可见，可操作抖音网页并显示扫码登录页。没有替用户扫码、登录或处理验证码。
8. 新 SQLite 完整性检查为 ok，0 个项目、0 个视频生成尝试。
9. 持久化目录的 Bridge 配置和浏览器校验标记，在强制重建容器后 SHA-256 检查通过；新容器重新启动浏览器、复用和注册 Bridge 均通过。
10. 互斥 flock 阻止其他进程同时占用同一实例数据；旧 Chromium Singleton 符号链接可恢复，普通文件和登录数据不会被删除。
11. 实际调用 LinuxSpeechSynthesis 生成中文 WAV，通过 FFprobe 读取到 2.690249 秒有效音频；FFmpeg / FFprobe 可执行检查通过。

## 实测中修复的问题

- 较旧 Playwright seccomp 示例不兼容新版 runc 的 openat2 和 glibc 的 clone3 回退：改用当前 Docker/Moby 默认配置，仅增加 Chromium 所需的命名空间规则，保留默认拒绝策略和沙箱。
- 旧容器留下 Chromium Profile 锁：新增内核 flock、受互斥保护的临时锁恢复，并在停止显示服务前等待 Chromium 写回配置。
- Git 默认换行转换会改变已审核 Bridge 源码摘要：对该文件禁用文本换行转换，保留原始字节和固定 SHA-256。

## 尚需用户配置和业务验收

- 抖音真实账号需用户在远程浏览器扫码。账号作品、评论和搜索效果尚未通过已登录账号验收；Bridge READY 仅表示连接正常。
- 发布引擎 social-auto-upload 和即梦/Dreamina 是独立外部运行时，需要安装受支持的平台版本并单独授权；当前测试不宣称它们可发布或可付费生成。
- 大模型 API 需在新实例自行配置。测试仅使用模拟接口和临时测试密钥。
- 未执行付费生成、发布、评论、点赞或私信。

部署与维护步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)，新增依赖及许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。


### 2026-10-14 账号识别修复
发布引擎缺失或未登录时仍独立读取运营账号，发布与运营账号强 ID 未核验前继续禁止自动绑定。页面分别显示运营账号识别结果和发布功能状态，避免将发布引擎失败误报为运营账号未登录。定向账号测试 13/13 通过，TypeScript 编译通过。


### 2026-10-14 同步 Windows 端既有业务修复
研究规则超过 30 条、剧本可选字段为空两项修复已从此前验证过的 Windows 版同步。TypeScript 编译通过；统一定向入口 fnos-ai-regressions.test.js 的 30 项研究和剧本回归全部通过。修复明细见 PATCHES.md。


### 2026-10-14 即梦连接入口
新增系统诊断“连接即梦 CLI”和 /settings/dreamina 页面；使用已核实的 legacy CLI 设备授权协议，确认登录以账号复查为准。12 项定向测试通过；原网页版、桌面版、Linux 版均编译通过。独立凭据目录及部署说明见 DREAMINA.md。
