# 飞牛 / Linux 独立部署

本仓库从原始 Product-Video-Studio 网页版复制，使用独立 Git 历史。原项目、Windows 桌面版和飞牛现有 3091 服务不参与构建或运行。

## 架构

```text
任意电脑浏览器 → PVS HTTP 服务（唯一对外端口）
                  ├─ SQLite / 项目文件 / 加密 API 配置
                  ├─ 已鉴权的 noVNC HTTP 与 WebSocket 转发
                  └─ Linux 抖音启动适配器
                       └─ 内部浏览器管理服务
                            ├─ 专用 Chromium + 持久 Profile
                            ├─ 现有源码校验的 CDP Bridge
                            └─ vendored douyin-cli Bridge
```

浏览器、显示服务、Bridge 和 PVS 由同一非 root 容器中的监督进程管理。内部端口 5900、6080、9223、19422、19423、19424 全部绑定 loopback，不映射到宿主机。网页仅转发 noVNC 的已知静态资源及单一 WebSocket，拒绝跨站 Origin、未登录访问和路径越界。

实例口令存放 `instance.env`，每次登录签发随机会话 Cookie；Cookie 不包含实例口令。网页会话 12 小时过期，容器重启后重新登录，实例口令保持不变。远程浏览器 WebSocket 定期检查会话有效性。

## 首次安装

需要 Linux Docker Engine 和 Docker Compose。复制整个仓库到独立目录，先生成本实例配置：

```sh
node scripts/setup-fnos.mjs
cp .env.example .env
```

在 `.env` 中设置专用测试端口和监听地址。默认只监听宿主机 `127.0.0.1:3092`；局域网需要填写宿主机的局域网 IP。`instance.env` 中的口令至少 24 字符，不要使用示例口令，不要提交配置文件。

绑定目录 `data` 必须属于容器的 UID/GID 1000，权限 700。管理员可在此独立部署目录执行：

```sh
sudo chown 1000:1000 ./data
sudo chmod 700 ./data
sudo docker compose up -d --build
```

检查容器 `healthy`，再访问指定端口。远程部署建议通过 HTTPS 反向代理进入，并设置 `PVS_COOKIE_SECURE=1`；代理需要支持 WebSocket 升级及足够的读取超时。保留 `deploy/chromium-seccomp.json`，浏览器以非 root 身份启用沙箱，不使用 `--no-sandbox` 或特权容器。

## 抖音登录与恢复

1. 登录 PVS，打开“抖音运营”。
2. 点击“启动 / 打开抖音运营连接”，由服务器启动 Chromium。
3. 点击“打开服务器浏览器 / 扫码登录”，在远程浏览器里人工登录、处理验证码。
4. 返回抖音运营“重新检查”，以实际 Bridge 和账号检测结果为准。

如抖音提示打开外部客户端，可点“取消”，继续使用服务器里的网页。

关闭远程查看页面不会关闭服务器浏览器。登录状态留在 `data/browser/douyin`。容器重启后浏览器不会自动访问抖音，下一次用户启动时复用同一配置目录。入口使用内核 flock 防止两个容器同时使用同一数据目录；持有独占锁后，仅恢复 Chromium 的临时 Singleton 符号链接，保留整个 Profile。停止时先让 Chromium 写回配置，再停止显示服务。不要复制已有 Windows 浏览器 Profile。

## 能力范围和外部运行时

- 网页、数据库迁移、项目文件、API 设置、FFmpeg/FFprobe 和离线语音均提供 Linux 运行方式。离线语音使用 eSpeak NG，音质为系统机械音，可改为上传已制作旁白。
- 抖音账号/作品/评论读取及搜索复用现有 `douyin-cli` 协议，登录和平台兼容性必须通过实际账号验收。部署测试不会替用户登录或执行发布、评论、点赞。
- 发布引擎 `social-auto-upload` 是独立接口，原适配器已支持 Linux 可执行文件路径；需要另行安装受支持的引擎并设置 `PVS_SOCIAL_AUTO_UPLOAD_ROOT` / `PVS_SOCIAL_AUTO_UPLOAD_EXECUTABLE`，完成发布账号授权。运营浏览器就绪不代表发布引擎就绪。
- 大模型 API 在“模型设置”里配置自己的服务地址、模型和密钥，不迁移原机器的密钥。
- 即梦/Dreamina 为外部授权运行时，未分发其专有二进制或授权信息。使用视频生成前，需按供应商支持的平台安装并配置经验证的运行时；若供应商未提供对应 Linux 版本，需要独立执行节点或相应受支持的 API 适配器。不得把未安装/未授权标为可用。

## 数据与维护

所有业务状态留在 `data`，不要执行删除数据目录或删除卷的更新命令。程序更新使用同一独立目录执行 `docker compose up -d --build`。正常停止使用 `docker compose stop`。

`data/logs` 包括启动迁移、浏览器、Bridge、显示服务的独立日志。控制接口只提供固定的启动/健康检查，不接受任意 shell 命令和任意打开网址。

## 验证

```sh
node node_modules/typescript/lib/tsc.js -p tsconfig.json
node --test --test-concurrency=1 dist/tests/fnos-linux.test.js
```

定向测试覆盖 Linux 启动状态、复用、研究登录、加密密钥重读/篡改、会话、跨站拒绝、远程浏览器 HTTP 与 WebSocket 鉴权。真实 Linux 构建、启动、沙箱、远程画面和持久化验证结果记录在 `docs/fnos/VALIDATION.md`。
