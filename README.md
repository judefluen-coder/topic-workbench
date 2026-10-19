# Topic Workbench

Topic Workbench 是一个本地多主题视频素材工作台。用户可以为不同内容项目配置关键词、排除词、重点人物、频道线索和抓取来源，从 YouTube 与B站发现素材，再沿用统一的字幕处理、粗剪、排序和 MP4 导出流程。

项目从 Tech PR Workbench 的科技采访工作流发展而来，现在统一在 Topic Workbench 继续维护。科技采访是默认示例主题，多主题配置覆盖其他内容项目。原 Tech PR Workbench 的提交历史已合并进本仓库；旧版本仍可从 `legacy/tech-pr-workbench` 分支查看。本地数据库和 `storage/` 不会因为 Git 仓库合并而自动迁移。

> 只下载、编辑和发布你有权处理的素材。发现阶段默认只保存公开元数据和原始链接。

## 当前能力

- 在同一个本地实例中创建和切换多个主题。
- 每个主题独立保存素材、抓取记录、剪辑片段和任务状态。
- 配置主题关键词、排除词、重点人物、频道或机构线索。
- 为主题单独选择 YouTube、B站或两者同时抓取。
- 为B站主题配置重点 UP 主 UID。
- 提供综合、人物优先、热度优先、最新优先四种排序方式。
- 从日期区间抓取素材，并按真实发布时间过滤。
- 下载授权视频、获取或生成字幕、生成中文翻译。
- 按“选片段 → 排顺序 → 导出成片”完成粗剪。
- 导出 SRT/VTT、剪辑表 CSV、横版或竖版 MP4。
- 后台 worker 持久处理下载、字幕和视频导出任务。

## 快速启动

```bash
cd topic-workbench
npm run doctor
npm run setup
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。后端默认运行在 `http://127.0.0.1:8000`。

首次启动会建立一个“AI 科技采访（示例）”主题，用于确认原工作流仍然可用。可以直接编辑它，也可以点击“新建主题”创建完全不同的内容项目。

## 在线体验

[打开 GitHub Pages 体验版](https://judefluen-coder.github.io/topic-workbench/)。它使用浏览器内存中的示例主题、视频和剪辑数据，可体验主题切换、筛选和工作台流程；不连接本地后端，也不会下载或导出真实媒体。真实素材处理仍需按上面的步骤在本地运行。

## 主题配置

每个主题包含：

| 配置 | 作用 |
| --- | --- |
| 主题名称与说明 | 标识内容项目和关注范围 |
| 关键词 | 生成平台搜索词，也是素材相关性判断的基础 |
| 排除词 | 命中后阻止无关素材进入列表 |
| 重点人物 | 增强搜索，并用于“人物优先”排序 |
| 频道线索 | 搜索频道、机构或品牌，并增强来源匹配 |
| B站 UP 主 UID | 直接扫描指定账号的最新投稿 |
| 抓取来源 | 选择 YouTube、B站或两者 |
| 排序方式 | 综合、人物优先、热度优先、最新优先 |

关键词、排除词和人物支持每行一个，也可以使用中英文逗号或分号分隔。第一版只接入 YouTube 和B站，RSS、播客和普通网页仍保留为后续来源适配器。

## 使用流程

1. 在顶部选择主题，或新建一个主题。
2. 填写至少一个关键词，并选择抓取来源。
3. 选择日期区间，点击“抓取当前主题”。
4. 查看标题、来源、摘要、重点对象和原始链接。
5. 对值得处理的视频点击“剪辑”。
6. 在工作台准备授权素材和字幕。
7. 选择字幕片段、调整顺序并导出成片。

## 抓取方式

YouTube 按以下优先级发现素材：

1. 配置了 `YOUTUBE_API_KEY` 时使用 YouTube Data API。
2. 没有 API key 时，优先尝试 OpenCLI 浏览器搜索。
3. OpenCLI 不可用时，使用本地 `yt-dlp` 补充搜索。

B站发现使用 OpenCLI，按主题关键词搜索，并可扫描主题中配置的 UP 主 UID。

OpenCLI 默认使用后台窗口：

```env
OPENCLI_WINDOW_MODE=background
OPENCLI_PREFLIGHT_ENABLED=false
```

排查浏览器插件连接时，可以临时改为：

```env
OPENCLI_WINDOW_MODE=foreground
OPENCLI_PREFLIGHT_ENABLED=true
```

## 本机依赖

基础依赖：

- Node.js >=20.19.0 或 >=22.12.0
- uv

建议安装：

- FFmpeg：下载合并、抽音频和 MP4 导出。
- OpenCLI：无 YouTube API key 时补充 YouTube 与B站搜索。

可选增强：

- YouTube Data API key：提高 YouTube 发现稳定性。
- Ollama：本地模型处理备用。
- faster-whisper：没有字幕时进行本地转写。
- OpenAI API：仅在显式开启云端回退时使用。

macOS 可以使用 Homebrew 安装基础工具：

```bash
brew install node uv ffmpeg
```

## 配置

`npm run setup` 会在缺少 `.env` 时复制 `.env.example`。常用配置如下：

```env
YOUTUBE_API_KEY=
DOWNLOAD_ENGINE=yt-dlp
LOCAL_YTDLP_DISCOVERY=true
OPENCLI_DISCOVERY_ENABLED=true
OPENCLI_WINDOW_MODE=background
OPENCLI_PREFLIGHT_ENABLED=false
BILIBILI_DISCOVERY_ENABLED=true

TOPIC_WORKBENCH_DB_PATH=storage/app.db
TOPIC_WORKBENCH_UPLOAD_DIR=storage/uploads
TOPIC_WORKBENCH_EXPORT_DIR=storage/exports
TOPIC_WORKBENCH_TMP_DIR=storage/tmp
```

为了兼容从旧版本复制的本地配置，后端仍识别 `TECH_PR_*` 环境变量；新项目建议统一使用 `TOPIC_WORKBENCH_*`。

## Docker

```bash
docker compose up --build
```

然后打开 `http://127.0.0.1:5173`。数据库、下载和导出文件保存在当前项目自己的 `storage/` 中。

Docker 容器不能直接控制宿主机的 OpenCLI 浏览器窗口，因此需要可视浏览器抓取时建议使用原生 `npm run dev`。

## 测试

运行完整测试和正式构建：

```bash
npm test
```

分别运行：

```bash
npm run test:setup
npm run test:backend
npm run build:frontend
```

当前测试覆盖主题配置与隔离、抓取与元数据处理、下载器、字幕、任务恢复、剪辑片段和视频导出。

## 数据与合规

- 每个主题的数据通过 `topic_id` 隔离，同一个平台视频可以分别进入多个主题。
- `.env`、数据库、下载视频、字幕和导出文件都不应提交到 Git。
- `storage/` 只属于当前 Topic Workbench 项目，不会读取 Tech PR Workbench 的本地数据。
- 如果平台条款或素材授权不允许下载，请只保留原始链接，或导入已经获得授权的本地素材。

发现问题或希望贡献？请先阅读[贡献说明](CONTRIBUTING.md)。
