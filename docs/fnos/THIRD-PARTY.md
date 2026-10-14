# 新增 Linux 部署依赖

- `vendor/douyin-cli`：来自本机现有 Yht20927/douyin-cli 源码，MIT，保留上游 LICENSE。仅调整配置文件路径以支持持久化 secrets；不复制 config.json、storage、日志或登录信息。
- `deploy/chromium-seccomp.json`：基于 Docker/Moby 官方新版 seccomp 配置，Apache-2.0，按 Playwright 官方 Docker 指南增加非 root Chromium 所需的 clone/setns/unshare 规则。新版基线兼容现代 runc 的 openat2 及 glibc 的 clone3 回退；保留默认拒绝策略。来源、上游和部署 SHA-256 记录在同目录 `.source.json`，上游许可证一并保留。
- Docker 从 Debian 官方软件源安装 Chromium、Xvfb、Openbox、x11vnc、noVNC、websockify、eSpeak NG、FFmpeg 和 Noto 字体。各软件包的版权、许可和上游来源由发行版保留在镜像 `/usr/share/doc/<package>/copyright`。不将不同许可证的程序误标为 PVS 自身许可证。
- 原 npm 锁文件、原许可证档案和原 THIRD_PARTY_NOTICES.md 保留。抖音运行时有自己的 package-lock.json；源代码变更和依赖变化可用独立 Git 历史审查。
- 不重新分发本机 Windows、浏览器 Profile、系统语音、Dreamina 专有二进制或任何用户凭据。

实现参考：

- https://playwright.dev/docs/docker
- https://novnc.com/noVNC/docs/EMBEDDING.html
