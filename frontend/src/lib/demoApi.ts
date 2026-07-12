import type { ClipMark, ClipPayload, ClipRenderOptions, ClipRenderResult, DailyReport, Job, MediaAsset, Topic, TopicInput, Transcript, Video } from "../types";

const DEMO_VIDEO_ID = 1002;
const timestamp = "2026-07-11T08:00:00+00:00";

let demoTopics: Topic[] = [
  {
    id: 1,
    name: "AI 科技采访（示例）",
    description: "体验如何按主题组织抓取、筛选和剪辑。",
    keywords: ["AI interview", "AI 访谈", "人工智能 访谈", "大模型 访谈"],
    excluded_keywords: ["shorts", "招聘"],
    focus_people: ["Sam Altman", "Jensen Huang"],
    channel_terms: ["OpenAI", "NVIDIA"],
    bilibili_channel_uids: [],
    sources: ["youtube", "bilibili"],
    ranking_mode: "balanced",
    video_count: 3,
    clip_count: 3,
    created_at: timestamp,
    updated_at: timestamp,
  },
];

const videos: Video[] = [
  buildVideo({
    id: 1001,
    platform: "youtube",
    external_id: "demo-agent-infrastructure",
    url: "https://www.youtube.com/",
    title: "AI Agent 进入企业：从 Demo 到可靠生产系统",
    channel_title: "Frontier Systems",
    duration_seconds: 1284,
    view_count: 186000,
    like_count: 7300,
    thumbnail_url: "https://i.ytimg.com/vi/0F2-LzowI1s/hqdefault.jpg",
    candidate_people: "Alex Chen",
    people_match_reason: "体验数据：从标题和简介识别到采访嘉宾",
    interview_confidence: 0.91,
    priority_score: 92,
    status: "ready",
    summary: "值得看：企业 Agent 的记忆、权限、评估和可靠性实践。可围绕“为什么 Demo 容易、生产难”制作观点短切。",
  }),
  buildVideo({
    id: DEMO_VIDEO_ID,
    platform: "youtube",
    external_id: "demo-local-ai-workflow",
    url: "https://www.youtube.com/",
    title: "本地 AI 工作流如何改变内容团队",
    channel_title: "Studio Signals",
    duration_seconds: 154,
    view_count: 48200,
    like_count: 2100,
    thumbnail_url: "https://i.ytimg.com/vi/73RZkEgC3AE/hqdefault.jpg",
    matched_people: "Maya Lin",
    people_match_reason: "体验数据：命中重点人物池",
    interview_confidence: 0.96,
    priority_score: 97,
    status: "clipped",
    summary: "值得看：本地优先的 AI 工具如何兼顾隐私、速度和人工复核。已有双语字幕与三个粗剪片段。",
  }),
  buildVideo({
    id: 1003,
    platform: "bilibili",
    external_id: "demo-physical-ai",
    url: "https://www.bilibili.com/",
    title: "Physical AI 的下一阶段：模型、芯片与真实世界数据",
    channel_title: "科技前线访谈",
    duration_seconds: 1865,
    view_count: 93000,
    like_count: 4600,
    thumbnail_url: "https://i.ytimg.com/vi/vsKeTVziZCs/hqdefault.jpg",
    candidate_people: "周宁",
    people_match_reason: "体验数据：从简介识别到候选嘉宾",
    interview_confidence: 0.87,
    priority_score: 88,
    status: "shortlisted",
    summary: "值得看：Physical AI 的数据闭环、端侧推理和商业落地。适合制作产业趋势摘要。",
    source_tier: "experimental",
  }),
];

let clipMarks: ClipMark[] = [
  buildClip(301, 28, 46, "本地优先的价值", "从隐私与速度切入，适合作为开场。", "真正的变化不是模型更大，而是团队可以在本地完成闭环。", "approved", 0),
  buildClip(302, 61, 83, "人工复核仍然关键", "保留完整论证，适合作为主体段落。", "自动化负责缩短路径，人仍然负责判断什么值得发布。", "ready", 1),
  buildClip(303, 108, 132, "从工具走向工作流", "结尾观点，连接组织方法。", "当工具进入每天的流程，它才真正成为生产力。", "draft", 2),
];

let mediaAssets: MediaAsset[] = [];
let nextClipId = 304;
let nextJobId = 204;
const pollCounts = new Map<number, number>();

let demoJobs: Job[] = [
  buildJob(203, "render_clips", "completed", "体验导出已完成：横版 16:9、标准字幕。", DEMO_VIDEO_ID, 100, 1),
  buildJob(202, "subtitle_reprocess", "completed", "双语字幕已整理：24 条中文，24 条英文。", DEMO_VIDEO_ID, 100, 1),
  buildJob(201, "daily_discovery", "completed", "体验抓取完成，得到 3 条采访候选。", null, 100, 1),
];

export const demoApi = {
  topics: async () => clone(demoTopics),

  createTopic: async (payload: TopicInput) => {
    const topic: Topic = { ...payload, id: Math.max(...demoTopics.map((item) => item.id), 0) + 1, video_count: 0, clip_count: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    demoTopics = [topic, ...demoTopics];
    return clone(topic);
  },

  updateTopic: async (id: number, payload: Partial<TopicInput>) => {
    const index = demoTopics.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("主题不存在。");
    demoTopics[index] = { ...demoTopics[index], ...payload, updated_at: new Date().toISOString() };
    return clone(demoTopics[index]);
  },

  daily: async (params: { topic_id?: number; date?: string; start_date?: string; end_date?: string } = {}) => {
    await delay(120);
    return buildReport(params.start_date || params.date, params.end_date, params.topic_id);
  },

  runDaily: async (payload: { topic_id?: number; date?: string; start_date?: string; end_date?: string } = {}) => {
    await delay(700);
    const job = buildJob(nextJobId++, "daily_discovery", "completed", "体验抓取完成，得到 3 条采访候选。", null, 100, 1);
    demoJobs = [job, ...demoJobs];
    return { ...buildReport(payload.start_date || payload.date, payload.end_date, payload.topic_id), latest_job: job, job_id: job.id };
  },

  jobs: async () => clone(demoJobs),

  job: async (id: number) => {
    const index = demoJobs.findIndex((job) => job.id === id);
    if (index < 0) throw new Error("体验任务不存在。");
    const current = demoJobs[index];
    if (current.status !== "queued" && current.status !== "running") return clone(current);
    const polls = (pollCounts.get(id) || 0) + 1;
    pollCounts.set(id, polls);
    const completed = polls >= 2;
    const updated = {
      ...current,
      status: completed ? "completed" : "running",
      message: completed ? completionMessage(current.type) : progressMessage(current.type),
      progress: completed ? 100 : 58,
      attempts: 1,
      updated_at: new Date().toISOString(),
      result: completed && current.type === "render_clips" ? JSON.stringify(demoRenderResult()) : current.result,
    };
    demoJobs[index] = updated;
    if (completed && current.video_id) setVideoStatus(current.video_id, current.type === "render_clips" ? "exported" : "clip_ready");
    return clone(updated);
  },

  retryJob: async (id: number) => {
    const index = demoJobs.findIndex((job) => job.id === id);
    if (index < 0) throw new Error("体验任务不存在。");
    const retried = { ...demoJobs[index], status: "queued", progress: 0, message: "体验任务已重新排队。", updated_at: new Date().toISOString() };
    demoJobs[index] = retried;
    pollCounts.set(id, 0);
    return clone(retried);
  },

  downloadTranslate: async (id: number) => queueJob("download_translate", id, "体验下载与翻译已加入队列。"),

  reprocessSubtitles: async (id: number) => queueJob("subtitle_reprocess", id, "体验字幕重处理已加入队列。"),

  clipPayload: async (id: number): Promise<ClipPayload> => {
    const video = findVideo(id);
    return {
      video: clone(video),
      transcripts: id === DEMO_VIDEO_ID || video.status === "clip_ready" || video.status === "clipped" || video.status === "exported" ? buildTranscripts(id) : [],
      clip_marks: id === DEMO_VIDEO_ID ? clone(clipMarks) : [],
      media_assets: id === DEMO_VIDEO_ID ? clone(mediaAssets) : [],
      media_url: "",
    };
  },

  createClip: async (payload: Omit<ClipMark, "id" | "position" | "created_at" | "updated_at">) => {
    const clip: ClipMark = {
      ...payload,
      id: nextClipId++,
      position: clipMarks.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    clipMarks = [...clipMarks, clip];
    setVideoStatus(payload.video_id, "clipped");
    return clone(clip);
  },

  updateClip: async (id: number, payload: Pick<ClipMark, "start_seconds" | "end_seconds" | "label" | "note" | "quote" | "status">) => {
    const index = clipMarks.findIndex((clip) => clip.id === id);
    if (index < 0) throw new Error("体验片段不存在。");
    clipMarks[index] = { ...clipMarks[index], ...payload, updated_at: new Date().toISOString() };
    return clone(clipMarks[index]);
  },

  deleteClip: async (id: number) => {
    clipMarks = clipMarks.filter((clip) => clip.id !== id).map((clip, position) => ({ ...clip, position }));
    return { message: "体验片段已移除。" };
  },

  reorderClips: async (_videoId: number, clipMarkIds: number[]) => {
    const byId = new Map(clipMarks.map((clip) => [clip.id, clip]));
    clipMarks = clipMarkIds.map((id, position) => ({ ...byId.get(id)!, position })).filter(Boolean);
    return { message: "体验序列顺序已更新。", clip_marks: clone(clipMarks) };
  },

  renderClips: async (id: number, _payload: ClipRenderOptions) => queueJob("render_clips", id, "体验导出已加入队列。"),

  uploadBrandLogo: async (_id: number, file: File) => {
    const asset: MediaAsset = {
      id: 900 + mediaAssets.length,
      kind: "brand_logo",
      original_filename: file.name,
      stored_path: "demo-memory",
      authorization_note: "GitHub Pages 体验上传，不会离开当前浏览器。",
      delete_after_processing: 1,
      processing_status: "imported",
      created_at: new Date().toISOString(),
      url: URL.createObjectURL(file),
    };
    mediaAssets = [asset, ...mediaAssets];
    return clone(asset);
  },
};

function buildVideo(overrides: Partial<Video> & Pick<Video, "id" | "title">): Video {
  const { id, title, ...rest } = overrides;
  return {
    id,
    topic_id: 1,
    platform: "youtube",
    external_id: `demo-${overrides.id}`,
    url: "https://github.com/judefluen-coder/topic-workbench",
    title,
    description: "GitHub Pages 工作流体验数据，不对应真实采访。",
    channel_title: "Demo Studio",
    published_at: "2026-07-11T10:00:00+08:00",
    duration_seconds: 600,
    view_count: 0,
    like_count: 0,
    thumbnail_url: "",
    matched_people: "",
    candidate_people: "",
    people_match_reason: "体验数据",
    interview_confidence: 0.8,
    priority_score: 80,
    status: "ready",
    compliance_note: "demo_metadata_only",
    summary: "GitHub Pages 工作流体验数据。",
    source_tier: "stable",
    last_error: "",
    created_at: timestamp,
    updated_at: timestamp,
    ...rest,
  };
}

function buildClip(id: number, start: number, end: number, label: string, note: string, quote: string, status: string, position: number): ClipMark {
  return { id, video_id: DEMO_VIDEO_ID, start_seconds: start, end_seconds: end, label, note, quote, status, position, created_at: timestamp, updated_at: timestamp };
}

function buildJob(id: number, type: string, status: string, message: string, videoId: number | null, progress: number, attempts: number): Job {
  const video = videoId ? videos.find((item) => item.id === videoId) : null;
  return {
    id,
    type,
    status,
    message,
    payload: JSON.stringify(videoId ? { video_id: videoId } : {}),
    result: type === "render_clips" && status === "completed" ? JSON.stringify(demoRenderResult()) : "{}",
    progress,
    attempts,
    created_at: timestamp,
    updated_at: timestamp,
    video_id: videoId,
    video_title: video?.title || "",
    video_url: video?.url || "",
  };
}

function buildReport(start?: string, end?: string, topicId = 1): DailyReport {
  const date = validDate(start) || today();
  const endDate = validDate(end) || date;
  const topic = demoTopics.find((item) => item.id === topicId) || demoTopics[0];
  return {
    date,
    start_date: date,
    end_date: endDate,
    topic: clone(topic),
    timezone: "Asia/Shanghai",
    window_start: `${date}T00:00:00+08:00`,
    window_end: `${endDate}T23:59:59+08:00`,
    items: clone(videos.map((video, index) => ({ ...video, topic_id: topic.id, published_at: `${date}T${String(10 + index * 3).padStart(2, "0")}:00:00+08:00` }))),
    source_runs: [
      { name: "YouTube", tier: "stable", status: "completed", message: "体验模式：已加载 2 条 YouTube 样例。" },
      { name: "Podcast RSS", tier: "stable", status: "skipped", message: "体验模式：保留为后续来源。" },
      { name: "B站", tier: "experimental", status: "completed", message: "体验模式：已加载 1 条 B站样例。" },
      { name: "X / LinkedIn", tier: "experimental", status: "skipped", message: "体验模式不连接外部平台。" },
    ],
    latest_job: clone(demoJobs[0] || null),
  };
}

function buildTranscripts(videoId: number): Transcript[] {
  const pairs = [
    ["本地优先不是拒绝云端，而是先把控制权留在团队手里。", "Local-first does not reject the cloud; it keeps control with the team."],
    ["内容工作最贵的部分，往往不是生成，而是反复确认。", "The expensive part of content work is often review, not generation."],
    ["如果每一步都能被看见，自动化才会真正让人放心。", "Automation becomes trustworthy when every step remains visible."],
    ["我们先发现值得看的采访，再决定哪些素材值得下载。", "We discover worthwhile interviews before deciding what to download."],
    ["字幕让长视频第一次变成可以搜索和比较的数据。", "Transcripts turn long video into searchable and comparable data."],
    ["粗剪的目的不是替代编辑，而是尽快找到观点结构。", "A rough cut finds the argument structure; it does not replace an editor."],
    ["真正的变化不是模型更大，而是团队可以在本地完成闭环。", "The real shift is a local loop the team can actually complete."],
    ["一个好的工作流应该允许失败，也应该允许重新开始。", "A good workflow must allow failure and a clean retry."],
    ["后台任务不能因为浏览器刷新就消失。", "Background jobs should not disappear when the browser refreshes."],
    ["每个片段都需要标题、备注和原话，才能顺利交给下一个人。", "Each clip needs a title, note, and quote for a clean handoff."],
    ["横版和竖版不是最后一刻的尺寸选择，而是构图选择。", "Landscape and portrait are composition choices, not last-minute sizes."],
    ["字幕安全区和品牌标识都应该在导出前被检查。", "Subtitle safety and branding should be checked before export."],
    ["自动化负责缩短路径，人仍然负责判断什么值得发布。", "Automation shortens the path; people still decide what deserves publishing."],
    ["所以我们保留审片状态，而不是直接自动发布。", "That is why we keep review states instead of auto-publishing."],
    ["当任务失败时，用户首先需要看到具体原因。", "When a task fails, the user first needs the concrete reason."],
    ["然后修复环境，再从同一个任务继续。", "Then fix the environment and continue from the same task."],
    ["本地数据库让素材、字幕和片段保持在一起。", "A local database keeps media, captions, and clips together."],
    ["网页只是操作面，真正的媒体工作仍然由后台完成。", "The browser is the control surface; media work stays in the worker."],
    ["这和很多本地 AI 工具的方向是一致的。", "This follows the direction of many local AI tools."],
    ["用户只需要打开一个地址，就能看到完整进度。", "The user opens one address and sees the whole process."],
    ["当工具进入每天的流程，它才真正成为生产力。", "A tool becomes productive when it enters the daily workflow."],
    ["体验版展示交互，本地版负责真实抓取和成片。", "The demo shows interaction; the local edition performs real processing."],
    ["两者使用同一套界面，因此不会形成两个产品。", "Both use the same interface, so they do not become separate products."],
    ["最后，所有发布动作都应该由人确认。", "Finally, every publishing action should be confirmed by a person."],
  ];
  return pairs.flatMap(([zh, en], index) => {
    const start = 4 + index * 6.1;
    const end = start + 5.2;
    return [
      { id: 500 + index * 2, video_id: videoId, language: "zh" as const, start_seconds: start, end_seconds: end, text: zh, source: "demo", created_at: timestamp },
      { id: 501 + index * 2, video_id: videoId, language: "en" as const, start_seconds: start, end_seconds: end, text: en, source: "demo", created_at: timestamp },
    ];
  });
}

function queueJob(type: string, videoId: number, message: string) {
  const job = buildJob(nextJobId++, type, "queued", message, videoId, 0, 0);
  demoJobs = [job, ...demoJobs];
  pollCounts.set(job.id, 0);
  return Promise.resolve(clone(job) as Job & { job_id: number; video_id: number });
}

function demoRenderResult(): ClipRenderResult {
  const duration = clipMarks.reduce((total, clip) => total + Math.max(0, clip.end_seconds - clip.start_seconds), 0);
  return {
    message: "体验导出已完成；GitHub Pages 不会生成真实 MP4。",
    export_dir: "demo-memory",
    sequence_path: "demo-memory/sequence.mp4",
    sequence_url: "",
    saved_path: "demo-memory/sequence.mp4",
    target_duration_seconds: 0,
    clip_status_filter: "all",
    rendered_duration_seconds: duration,
    output_profile: "landscape",
    output_width: 1920,
    output_height: 1080,
    fit_mode: "crop",
    focus_x: 50,
    subtitle_style: "standard",
    subtitle_position: "bottom",
    logo_asset_id: null,
    logo_position: "top_right",
    clips: clipMarks.map((clip) => ({ id: clip.id, label: clip.label, start_seconds: clip.start_seconds, end_seconds: clip.end_seconds, path: "demo-memory", url: "" })),
  };
}

function findVideo(id: number): Video {
  const video = videos.find((item) => item.id === id);
  if (!video) throw new Error("体验视频不存在。");
  return video;
}

function setVideoStatus(id: number, status: Video["status"]) {
  const video = videos.find((item) => item.id === id);
  if (video) video.status = status;
}

function completionMessage(type: string) {
  if (type === "render_clips") return "体验导出完成；本地完整版会生成真实 MP4。";
  if (type === "subtitle_reprocess") return "体验字幕已重新整理。";
  return "体验下载与翻译完成，可以进入剪辑工作台。";
}

function progressMessage(type: string) {
  if (type === "render_clips") return "正在模拟拼接片段和烧录字幕。";
  if (type === "subtitle_reprocess") return "正在模拟清理和对齐双语字幕。";
  return "正在模拟下载素材和生成中文字幕。";
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function validDate(value?: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
