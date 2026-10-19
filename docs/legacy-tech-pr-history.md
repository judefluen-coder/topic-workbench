# Tech PR Workbench 历史记录

Tech PR Workbench 的 Git 历史已合并到 Topic Workbench。原主分支保存在 `legacy/tech-pr-workbench`，另一个开发分支保存在 `legacy/tech-pr-opencli-ytdlp-reliability`。本页保存原仓库删除前的版本和 Pull Request 摘要；这些历史版本的在线演示地址不再保证可访问。

| 版本标签 | 原发布日期（UTC） | 发布内容摘要 |
| --- | --- | --- |
| `v0.1.0` | 2026-06-16 | 首个公开版本：采访发现、本地字幕翻译、片段时间线与视频导出。 |
| `v0.1.1` | 2026-06-16 | 云端 OpenAI 能力改为可选，默认安装不再依赖 OpenAI SDK。 |
| `v0.1.2` | 2026-06-16 | 扩充产品介绍、截图、使用流程、设置、成本与常见问题。 |
| `v0.1.3` | 2026-06-16 | 增加 `npm run doctor` 环境检查，核对全新克隆后的安装与测试。 |
| `v0.1.4` | 2026-06-16 | 增加给编码助手使用的安装指南与依赖边界。 |
| `v0.1.5` | 2026-10-15 | 改进 OpenCLI 和 yt-dlp 的发现与下载路径，补充测试、诊断、说明和截图。 |

原仓库有三个 Pull Request：

| 编号 | 标题 | 结果 |
| --- | --- | --- |
| #1 | Improve OpenCLI and yt-dlp discovery reliability | 已合并 |
| #2 | Harden setup checks and video downloads | 已关闭，未合并 |
| #3 | Release the Local Studio three-step workflow | 已合并 |

以上六个历史 Release 没有单独上传的二进制附件。版本代码由 Git 标签定位；原仓库的网页讨论与 Actions 记录不属于 Git 提交历史。
