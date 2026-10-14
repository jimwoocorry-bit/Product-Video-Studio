# 即梦 CLI 连接

系统诊断中的 Dreamina / Seedance 卡片现在提供“连接即梦 CLI”，入口 `/settings/dreamina`。

1. 点击“连接 / 登录即梦 CLI”。
2. 打开返回的即梦官方授权页，按需输入页面显示的授权码。
3. 完成官方授权后，返回点击“我已授权，确认连接”。只有 CLI 账号检查成功才显示已连接。

只读取状态不会发起授权；重复点击会复用当前未过期授权；不会主动退出或强制替换登录。设备引用仅暂存在服务端内存，不返回浏览器，不写入审计输出。授权过期后可以重新连接。

当前生成适配器使用官方 legacy Dreamina CLI 的 `login --headless` / `login checklogin --poll=0`；不将 Canvas CLI 的另一套认证混入已有生成协议。Linux 发行包通过官方安装器 https://jimeng.jianying.com/cli 指向的 HTTPS 源下载，本次核验版本 1.4.19 / 1d0bd17-dirty，SHA256 `18fb0c699a72e9a6a8b550ea93438c05a5ed5bd7a94374a8e6e647fb1462ef28`。二进制单独安装，不纳入源代码归档。

管理员可使用 `deploy/dreamina.compose.example.yaml` 挂载已安装的官方运行时，并将已核验配置置于 `/data/config/dreamina-runtime.verified.json`。`PVS_DREAMINA_HOME=/data/dreamina-home` 使图像、视频和连接操作使用同一实例的 CLI 凭据目录。两个飞牛实例共享只读程序，各自持有独立凭据目录；不复制 Windows 的注册表或登录凭据。

Windows 客户端复用当前用户现有的已核验 CLI。授权链接通过已有 Wails 浏览器接口交给系统浏览器打开；更新后重开客户端加载新版后端。

定向验证：`node --test --test-concurrency=1 dist/tests/dreamina-connection.test.js`。未提交任何生成任务；完成账号授权需要用户在官方页面确认。


## 视频模型列表验收
官方 CLI 程序、版本元数据、官方安装器匹配的 SKILL.md 必须一起安装。设置 `DREAMINA_SKILL_PATH=/opt/pvs-dreamina/SKILL.md`；本次官方文档 MD5 为 `fc22c32619bc9e248e7bf8b320462b37`。执行 `node scripts/verify-dreamina-catalog.mjs` 验证 CLI 实际帮助中的模型、画幅、分辨率，不能只凭账号已登录判定安装完整。

局域网 HTTP 可能没有 crypto.randomUUID，页面使用 getRandomValues 生成兼容的 v4 请求 ID，并推迟到用户提交时生成；模型目录加载不再依赖该方法。加载失败会显示错误和重新检测按钮，不静默显示空下拉框。
