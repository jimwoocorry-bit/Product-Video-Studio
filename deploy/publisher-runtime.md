# 飞牛发布引擎

抖音运营 Bridge 与视频发布引擎是两个独立组件。发布依赖单独安装的 MIT 许可 PVS 集成分支 `social-auto-upload`，入口为 `sau-pvs`；PVS 程序包不附带其 Python 源码、浏览器二进制或登录信息。

1. 将已审查的集成分支源代码放在服务器独立目录；仅复制程序和 `conf.example.py`（重命名为 `conf.py`），不复制 `.venv`、cookies、数据库、日志或媒体。
2. 使用本版 Dockerfile 构建 PVS 镜像（包含 Python 3.11 / venv）。把独立目录挂载到 `/opt/pvs-publisher`，以 UID/GID 1000 运行 `deploy/install-publisher-runtime.sh`。此步骤在独立目录创建 Linux venv 并安装项目声明的依赖和匹配的 Patchright Chromium；安装失败应检查退出码，不重用半完成的环境。
3. 参考 `publisher.compose.example.yaml`，将环境变量和挂载合并进现有 override，保留即梦等原有配置。重建容器。独立目录必须能由 UID 1000 写入（上游有文件日志），无需开放额外端口。
4. 引擎检查应返回 `READY`。尚未登录时账号检查应返回 `AUTH_REQUIRED`，而非引擎缺失。点击发布页“登录抖音”，打开同页的服务器浏览器入口，由用户扫码登录创作者中心；运营页登录不会替代此检查。

安装脚本对外部集成分支应用小范围 Linux 显示适配：登录浏览器最大化并跟随窗口尺寸，使用适合远程桌面的显示比例，扫码等待延长至八分钟。源文件和安装文件均留有适配前备份；不会修改 Windows 分支。

发布 Cookie 只保存在 `/data/.runtime-secrets/publishing/social-auto-upload`，容器重建后保留。检查、登录不会上传成片；实际发布仍需用户在发布任务中明确确认。
