import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent, FormEvent, KeyboardEvent, SyntheticEvent } from "react";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  CalendarBlank,
  CaretDown,
  CaretUp,
  CheckCircle,
  Clock,
  Copy,
  DownloadSimple,
  DotsSixVertical,
  FileArrowDown,
  FilmSlate,
  FloppyDisk,
  GlobeHemisphereEast,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  PlayCircle,
  PlusCircle,
  Scissors,
  SpinnerGap,
  Subtitles,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { api, isDemoMode } from "./lib/api";
import { buildTranscriptClipCopy, buildTranscriptSnapForRange, clipCopyGapLabels, isClipCopyIncomplete, mergeMissingClipCopyFields } from "./lib/clipCopy";
import { buildClipDeliveryBrief, buildClipDeliveryHandoffPrompt, buildClipDeliveryNextStep, buildClipDeliverySummary, type ClipDeliveryNextStep, type ClipDeliverySummary } from "./lib/clipDelivery";
import { buildExportVersionPreflightCheck } from "./lib/clipPreflight";
import { buildSequenceIssueDetails, buildSequenceQualitySummary, type SequenceMarkIssue } from "./lib/clipQuality";
import { clipSequenceFocusSelectors } from "./lib/clipSequenceFocus";
import { resolveClipEditShortcut } from "./lib/clipShortcuts";
import { buildManualClipValidation, type ManualClipValidation } from "./lib/clipValidation";
import { formatDate, formatDuration, formatNumber, formatTimecode, statusLabel } from "./lib/format";
import { buildJobState, isActiveJobStatus, jobResult, jobVideoId } from "./lib/jobState";
import { buildTranscriptWindow } from "./lib/transcriptWindow";
import { loadClipEditorState, loadWorkspaceState, saveClipEditorState, saveWorkspaceState, type WorkspaceView } from "./lib/workspaceState";
import type { ClipMark, ClipPayload, ClipRenderOptions, ClipRenderResult, DailyReport, Job, MediaAsset, SourceRun, Topic, TopicInput, Transcript, Video } from "./types";

const VIDEO_PROCESSING_STATUSES = new Set(["downloading", "subtitle_fetching", "transcribing", "translating"]);
const EXPORT_VERSION_PRESETS = [
  { label: "完整序列", detail: "导出全部片段", target: 0 },
  { label: "30 秒", detail: "适合社媒短切", target: 30 },
  { label: "60 秒", detail: "适合观点串联", target: 60 },
  { label: "90 秒", detail: "适合长版摘要", target: 90 },
];
const EXPORT_SCOPE_PRESETS = [
  { label: "全部序列", value: "all" },
  { label: "仅已确认", value: "approved" },
];
const OUTPUT_PROFILE_PRESETS = [
  { label: "横版 16:9", detail: "1920 × 1080", value: "landscape" },
  { label: "竖版 9:16", detail: "1080 × 1920", value: "portrait" },
  { label: "保持原尺寸", detail: "不改变画幅", value: "source" },
] as const;
const FIT_MODE_PRESETS = [
  { label: "裁切填满", detail: "铺满画面", value: "crop" },
  { label: "完整画面", detail: "留黑边适配", value: "contain" },
] as const;
const SUBTITLE_STYLE_PRESETS = [
  { label: "标准", detail: "深色底", value: "standard" },
  { label: "醒目", detail: "加粗强调", value: "bold" },
  { label: "极简", detail: "描边无底", value: "minimal" },
  { label: "关闭", detail: "不烧录", value: "none" },
] as const;
const CLIP_REVIEW_STATUSES = [
  { value: "draft", label: "待审", detail: "需要复核" },
  { value: "ready", label: "可用", detail: "可导出" },
  { value: "approved", label: "已确认", detail: "可交付" },
];
const MIN_CLIP_SECONDS = 3;
const SEQUENCE_FILTERS = [
  { value: "all", label: "全部" },
  { value: "draft", label: "待审" },
  { value: "ready", label: "可用" },
  { value: "approved", label: "已确认" },
  { value: "copy", label: "缺文案" },
  { value: "issues", label: "有问题" },
] as const;

type SequenceFilter = (typeof SEQUENCE_FILTERS)[number]["value"];

type TranscriptRow = ReturnType<typeof buildTranscriptRows>[number];

interface SequenceFocusRequest {
  filter: SequenceFilter;
  token: number;
}

interface TranscriptSelection {
  anchorIndex: number;
  focusIndex: number;
}

interface TranscriptSelectionSummary {
  count: number;
  end: number;
  endIndex: number;
  label: string;
  note: string;
  quote: string;
  start: number;
  startIndex: number;
}

interface RecentlyDeletedClip {
  mark: ClipMark;
  orderIds: number[];
}

interface ClipPreviewRange {
  end: number;
}

interface HighlightSuggestion {
  id: string;
  start: number;
  end: number;
  label: string;
  reason: string;
  quote: string;
  score: number;
}

type PreflightSeverity = "ready" | "warn" | "block";

interface ExportPreflightCheck {
  id: string;
  label: string;
  message: string;
  severity: PreflightSeverity;
}

interface DeliveryChecklistItem {
  actionLabel?: string;
  disabled?: boolean;
  id: string;
  label: string;
  message: string;
  onAction?: () => void | Promise<void>;
  status: "done" | "todo" | "warn";
}

interface ExportPreflightAction {
  disabled?: boolean;
  label: string;
  onAction: () => void | Promise<void>;
}

type ExportPreflightActions = Partial<Record<string, ExportPreflightAction>>;

function App() {
  const defaultRange = useMemo(() => defaultBeijingRange(), []);
  const restoredWorkspace = useMemo(() => loadWorkspaceState(), []);
  const dailyRequestIdRef = useRef(0);
  const [startDate, setStartDate] = useState(restoredWorkspace?.startDate ?? defaultRange.start);
  const [endDate, setEndDate] = useState(restoredWorkspace?.endDate ?? defaultRange.end);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [activeTopicId, setActiveTopicId] = useState(restoredWorkspace?.topicId ?? 1);
  const [topicEditor, setTopicEditor] = useState<"create" | "edit" | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(restoredWorkspace?.selectedVideoId ?? null);
  const [activeView, setActiveView] = useState<WorkspaceView>(restoredWorkspace?.view ?? "discovery");
  const [clip, setClip] = useState<ClipPayload | null>(null);
  const [jobs, setJobs] = useState<Record<number, Job>>({});
  const [jobIdsByVideo, setJobIdsByVideo] = useState<Record<number, number>>({});
  const [latestJobIdsByVideo, setLatestJobIdsByVideo] = useState<Record<number, number>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [runningDaily, setRunningDaily] = useState(false);
  const [toast, setToast] = useState("");

  const loadDaily = async (range = { start: startDate, end: endDate }) => {
    const requestId = ++dailyRequestIdRef.current;
    setLoading(true);
    try {
      const next = await api.daily({ topic_id: activeTopicId, start_date: range.start, end_date: range.end });
      if (requestId !== dailyRequestIdRef.current) return;
      setReport(next);
      const selectedStillVisible = next.items.some((item) => item.id === selectedId);
      if (!selectedStillVisible && activeView === "discovery") setSelectedId(next.items[0]?.id ?? null);
    } catch (error) {
      if (requestId !== dailyRequestIdRef.current) return;
      setToast(readError(error, "日报加载失败"));
    } finally {
      if (requestId === dailyRequestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadDaily({ start: startDate, end: endDate });
  }, [activeTopicId, startDate, endDate]);

  useEffect(() => {
    api.topics().then((records) => {
      setTopics(records);
      if (records.length && !records.some((topic) => topic.id === activeTopicId)) setActiveTopicId(records[0].id);
    }).catch((error) => setToast(readError(error, "主题加载失败")));
  }, []);

  useEffect(() => {
    saveWorkspaceState({ topicId: activeTopicId, startDate, endDate, selectedVideoId: selectedId, view: activeView });
  }, [activeTopicId, activeView, endDate, selectedId, startDate]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeView]);

  useEffect(() => {
    if (activeView !== "discovery" || !report) return;
    if (!report.items.some((item) => item.id === selectedId)) setSelectedId(report.items[0]?.id ?? null);
  }, [activeView, report, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setJobs({});
    setJobIdsByVideo({});
    setLatestJobIdsByVideo({});
    api.jobs(activeTopicId).then((records) => {
      if (cancelled) return;
      const state = buildJobState(records);
      setJobs(state.jobs);
      setJobIdsByVideo(state.activeJobIdsByVideo);
      setLatestJobIdsByVideo(state.latestJobIdsByVideo);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTopicId]);

  useEffect(() => {
    if (!selectedId) {
      setClip(null);
      return;
    }
    api.clipPayload(selectedId).then(setClip).catch(() => setClip(null));
  }, [selectedId]);

  useEffect(() => {
    const entries = Object.entries(jobIdsByVideo);
    if (!entries.length) return;
    const timer = window.setInterval(async () => {
      const completedVideos: number[] = [];
      const completedMessages: string[] = [];
      const nextJobs: Record<number, Job> = {};
      await Promise.all(
        entries.map(async ([videoIdRaw, jobId]) => {
          const videoId = Number(videoIdRaw);
          try {
            const job = await api.job(jobId);
            nextJobs[job.id] = job;
            setLatestJobIdsByVideo((current) => ({ ...current, [videoId]: job.id }));
            if (!isActiveJobStatus(job.status)) {
              completedVideos.push(videoId);
              completedMessages.push(job.message || (job.status === "failed" ? "处理失败。" : "处理完成。"));
            }
          } catch {
            return;
          }
        }),
      );
      if (Object.keys(nextJobs).length) setJobs((current) => ({ ...current, ...nextJobs }));
      if (completedMessages.length) setToast(completedMessages[completedMessages.length - 1]);
      if (completedVideos.length) {
        setJobIdsByVideo((current) => {
          const next = { ...current };
          completedVideos.forEach((videoId) => delete next[videoId]);
          return next;
        });
        await loadDaily({ start: startDate, end: endDate });
        if (selectedId) {
          api.clipPayload(selectedId).then(setClip).catch(() => undefined);
        }
      }
    }, 2200);
    return () => window.clearInterval(timer);
  }, [jobIdsByVideo, startDate, endDate, selectedId]);

  const filteredItems = useMemo(() => {
    const items = report?.items ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) => {
      const haystack = `${item.title} ${item.summary} ${item.channel_title} ${item.matched_people} ${item.candidate_people}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [report, search]);

  const stats = useMemo(() => buildStats(report?.items ?? []), [report]);

  const trackJob = (videoId: number, job: Job) => {
    setJobs((current) => ({ ...current, [job.id]: job }));
    setLatestJobIdsByVideo((current) => ({ ...current, [videoId]: job.id }));
    if (isActiveJobStatus(job.status)) {
      setJobIdsByVideo((current) => ({ ...current, [videoId]: job.id }));
    }
  };

  const runDaily = async () => {
    if (endDate < startDate) {
      setToast("结束日期不能早于开始日期。");
      return;
    }
    setRunningDaily(true);
    try {
      const next = await api.runDaily({ topic_id: activeTopicId, start_date: startDate, end_date: endDate, limit_per_query: 3 });
      dailyRequestIdRef.current += 1;
      setReport(next);
      setToast("当前主题素材抓取完成。");
      if (next.items[0]) setSelectedId(next.items[0].id);
    } catch (error) {
      setToast(readError(error, "抓取失败"));
    } finally {
      setRunningDaily(false);
    }
  };

  const startDownloadTranslate = async (video: Video) => {
    setSelectedId(video.id);
    setToast("正在下载视频并准备字幕，完成后会出现在剪辑工作台。");
    try {
      const job = await api.downloadTranslate(video.id, { quality: "1080p" });
      trackJob(video.id, job);
      setActiveView("tasks");
      setToast(job.message);
    } catch (error) {
      setToast(readError(error, "下载翻译失败"));
    }
  };

  const startSubtitleReprocess = async (video: Video) => {
    setSelectedId(video.id);
    setToast("正在重新处理已有字幕，不会重新下载视频。");
    try {
      const job = await api.reprocessSubtitles(video.id);
      trackJob(video.id, job);
      setToast(job.message);
    } catch (error) {
      setToast(readError(error, "字幕重新处理失败"));
    }
  };

  const retryTrackedJob = async (job: Job) => {
    const videoId = jobVideoId(job);
    if (!videoId) return;
    try {
      const retried = await api.retryJob(job.id);
      trackJob(videoId, retried);
      setToast("失败任务已重新加入队列。");
    } catch (error) {
      setToast(readError(error, "任务重试失败"));
    }
  };

  const selectedVideo = (report?.items ?? []).find((item) => item.id === selectedId) ?? clip?.video ?? null;
  const activeJobId = selectedId ? jobIdsByVideo[selectedId] : undefined;
  const latestJobId = selectedId ? latestJobIdsByVideo[selectedId] : undefined;
  const selectedJob = latestJobId ? jobs[latestJobId] ?? null : null;
  const selectedProcessing = Boolean(activeJobId) || Boolean(selectedVideo && VIDEO_PROCESSING_STATUSES.has(selectedVideo.status));
  const activeJobsCount = Object.keys(jobIdsByVideo).length;
  const activeTopic = topics.find((topic) => topic.id === activeTopicId) ?? report?.topic ?? null;

  const selectTopic = (topicId: number) => {
    setActiveTopicId(topicId);
    setSelectedId(null);
    setClip(null);
    setReport(null);
    setActiveView("discovery");
  };

  const saveTopic = async (payload: TopicInput) => {
    try {
      const saved = topicEditor === "edit" && activeTopic ? await api.updateTopic(activeTopic.id, payload) : await api.createTopic(payload);
      setTopics((current) => topicEditor === "edit" ? current.map((topic) => topic.id === saved.id ? saved : topic) : [saved, ...current]);
      setTopicEditor(null);
      selectTopic(saved.id);
      setToast(topicEditor === "edit" ? "主题配置已更新。" : "新主题已创建。现在可以选择日期开始抓取。");
    } catch (error) {
      setToast(readError(error, "主题保存失败"));
    }
  };

  const selectVideo = (id: number, view?: WorkspaceView) => {
    setSelectedId(id);
    if (view) setActiveView(view);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <GlobeHemisphereEast size={24} weight="duotone" />
          </div>
          <div>
            <h1>Topic Workbench</h1>
            <p>本地多主题素材发现、字幕处理与粗剪工作室</p>
          </div>
        </div>
        <nav className="workspace-tabs" role="tablist" aria-label="工作视图">
          <button className={activeView === "discovery" ? "active" : ""} role="tab" aria-selected={activeView === "discovery"} onClick={() => setActiveView("discovery")}>
            <GlobeHemisphereEast size={16} />
            主题素材
          </button>
          <button className={activeView === "tasks" ? "active" : ""} role="tab" aria-selected={activeView === "tasks"} onClick={() => setActiveView("tasks")}>
            <Clock size={16} />
            处理任务
            {activeJobsCount > 0 && <span>{activeJobsCount}</span>}
          </button>
          <button className={activeView === "editor" ? "active" : ""} role="tab" aria-selected={activeView === "editor"} onClick={() => setActiveView("editor")}>
            <Scissors size={16} />
            剪辑工作台
          </button>
        </nav>
      </header>

      <section className="topic-switcher" aria-label="当前主题">
        <div className="topic-switcher-main">
          <span>当前主题</span>
          <select value={activeTopicId} onChange={(event) => selectTopic(Number(event.target.value))}>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
          <p>{activeTopic?.description || "用关键词、重点人物和频道线索定义需要抓取的内容。"}</p>
        </div>
        <div className="topic-switcher-meta">
          <span>{activeTopic?.keywords.length || 0} 个关键词</span>
          <span>{activeTopic?.sources.map(platformLabel).join(" + ") || "未配置来源"}</span>
          <button type="button" title="编辑当前主题" onClick={() => setTopicEditor("edit")} disabled={!activeTopic}>
            <PencilSimple size={16} />
            编辑
          </button>
          <button className="primary" type="button" onClick={() => setTopicEditor("create")}>
            <PlusCircle size={16} />
            新建主题
          </button>
        </div>
      </section>

      {topicEditor && (
        <TopicEditor
          topic={topicEditor === "edit" ? activeTopic : null}
          onClose={() => setTopicEditor(null)}
          onSave={saveTopic}
        />
      )}

      {isDemoMode && (
        <section className="demo-mode-bar" aria-label="GitHub Pages 体验版">
          <div>
            <strong>GitHub Pages 体验版</strong>
            <span>当前使用样例数据；抓取、下载与 MP4 导出仅作流程模拟，不会连接平台或上传文件。</span>
          </div>
          <a href="https://github.com/judefluen-coder/topic-workbench" target="_blank" rel="noreferrer">
            <ArrowSquareOut size={15} />
            本地完整版
          </a>
        </section>
      )}

      {activeView === "discovery" && (
        <div className="view-panel" role="tabpanel" aria-label="主题素材">
          <section className="view-command-bar">
            <div className="date-range-actions">
              <label className="date-control">
                <CalendarBlank size={17} />
                <span>开始</span>
                <input value={startDate} type="date" onInput={(event) => setStartDate(event.currentTarget.value)} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <label className="date-control">
                <CalendarBlank size={17} />
                <span>结束</span>
                <input value={endDate} type="date" onInput={(event) => setEndDate(event.currentTarget.value)} onChange={(event) => setEndDate(event.target.value)} />
              </label>
            </div>
            <button className="primary" onClick={runDaily} disabled={runningDaily}>
              {runningDaily ? <SpinnerGap size={17} className="spin" /> : <DownloadSimple size={17} />}
              {runningDaily ? "抓取中" : "抓取当前主题"}
            </button>
          </section>

          <section className="summary-strip">
            <Metric label="候选素材" value={stats.total} detail="按北京时间区间" />
            <Metric label="可处理" value={stats.ready} detail="可下载翻译" />
            <Metric label="处理中" value={stats.processing} detail="下载/字幕/转写" />
            <Metric label="可剪辑" value={stats.clipReady} detail="已带中文字幕" />
          </section>

          <section className="source-strip">
            {(report?.source_runs ?? []).map((source) => (
              <SourcePill key={`${source.name}-${source.status}`} source={source} />
            ))}
          </section>

          <section className="workbench-grid discovery-grid">
            <div className="daily-panel">
              <div className="panel-toolbar">
                <div>
                  <h2>{activeTopic?.name || "当前主题"} · {startDate === endDate ? startDate : `${startDate} 至 ${endDate}`}</h2>
                  <p>{report ? `北京时间窗口：${formatDate(report.window_start)} - ${formatDate(report.window_end)}` : "正在准备日报"}</p>
                </div>
                <label className="search-control">
                  <MagnifyingGlass size={17} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜标题、频道或重点对象" />
                </label>
              </div>
              {loading ? (
                <LoadingRows />
              ) : filteredItems.length ? (
                <InterviewList
                  items={filteredItems}
                  selectedId={selectedId}
                  jobs={jobs}
                  jobIdsByVideo={jobIdsByVideo}
                  onSelect={(id) => selectVideo(id)}
                  onOpenClip={(video) => selectVideo(video.id, "editor")}
                />
              ) : (
                <EmptyState onRun={runDaily} running={runningDaily} />
              )}
            </div>
          </section>
        </div>
      )}

      {activeView === "tasks" && (
        <TaskCenter
          activeJobId={activeJobId}
          jobs={jobs}
          selectedId={selectedId}
          selectedJob={selectedJob}
          selectedVideo={selectedVideo}
          onOpenEditor={(id) => selectVideo(id, "editor")}
          onRetry={retryTrackedJob}
          onSelect={(id) => selectVideo(id)}
        />
      )}

      {activeView === "editor" && (
        <ClipWorkspace
          key={selectedId ?? "empty-editor"}
          clip={clip}
          job={selectedJob}
          selectedVideo={selectedVideo}
          processing={selectedProcessing}
          onDownloadTranslate={startDownloadTranslate}
          onReprocessSubtitles={startSubtitleReprocess}
          onJobQueued={trackJob}
          onRefresh={() => selectedId && api.clipPayload(selectedId).then(setClip)}
          onToast={setToast}
        />
      )}

      {toast && (
        <button className="toast" onClick={() => setToast("")}>
          {toast}
        </button>
      )}
    </main>
  );
}

function TopicEditor({ topic, onClose, onSave }: { topic: Topic | null; onClose: () => void; onSave: (payload: TopicInput) => void | Promise<void> }) {
  const [name, setName] = useState(topic?.name ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const [keywords, setKeywords] = useState(joinTerms(topic?.keywords));
  const [excludedKeywords, setExcludedKeywords] = useState(joinTerms(topic?.excluded_keywords));
  const [focusPeople, setFocusPeople] = useState(joinTerms(topic?.focus_people));
  const [channelTerms, setChannelTerms] = useState(joinTerms(topic?.channel_terms));
  const [bilibiliUids, setBilibiliUids] = useState(joinTerms(topic?.bilibili_channel_uids));
  const [sources, setSources] = useState<Array<"youtube" | "bilibili">>(topic?.sources ?? ["youtube", "bilibili"]);
  const [rankingMode, setRankingMode] = useState<TopicInput["ranking_mode"]>(topic?.ranking_mode ?? "balanced");
  const [saving, setSaving] = useState(false);

  const toggleSource = (source: "youtube" | "bilibili") => {
    setSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedKeywords = splitTerms(keywords);
    if (!name.trim() || !parsedKeywords.length || !sources.length) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        keywords: parsedKeywords,
        excluded_keywords: splitTerms(excludedKeywords),
        focus_people: splitTerms(focusPeople),
        channel_terms: splitTerms(channelTerms),
        bilibili_channel_uids: splitTerms(bilibiliUids),
        sources,
        ranking_mode: rankingMode,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="topic-editor-modal" aria-label={topic ? "编辑主题" : "新建主题"} onSubmit={submit}>
        <header>
          <div>
            <span>主题配置</span>
            <h2>{topic ? "编辑当前主题" : "新建抓取主题"}</h2>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="topic-editor-grid">
          <label className="topic-field full">
            <span>主题名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：新能源汽车出海" required />
          </label>
          <label className="topic-field full">
            <span>主题说明</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个主题需要持续关注什么" />
          </label>
          <label className="topic-field">
            <span>关键词 *</span>
            <textarea value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={"新能源汽车 出海\nEV global expansion"} required />
            <small>每行一个，也可以用逗号分隔。</small>
          </label>
          <label className="topic-field">
            <span>排除词</span>
            <textarea value={excludedKeywords} onChange={(event) => setExcludedKeywords(event.target.value)} placeholder={"招聘\n广告\nshorts"} />
            <small>命中后不会进入素材列表。</small>
          </label>
          <label className="topic-field">
            <span>重点人物</span>
            <textarea value={focusPeople} onChange={(event) => setFocusPeople(event.target.value)} placeholder={"人物中文名\nEnglish Name"} />
            <small>用于增强搜索和“人物优先”排序。</small>
          </label>
          <label className="topic-field">
            <span>频道线索</span>
            <textarea value={channelTerms} onChange={(event) => setChannelTerms(event.target.value)} placeholder={"频道名\n机构名\n品牌名"} />
            <small>既可作为搜索词，也会增强频道匹配。</small>
          </label>
          <label className="topic-field full">
            <span>B站重点 UP 主 UID</span>
            <input value={bilibiliUids} onChange={(event) => setBilibiliUids(event.target.value)} placeholder="多个 UID 用逗号分隔" />
          </label>
        </div>

        <fieldset className="topic-options">
          <legend>抓取来源</legend>
          <label><input type="checkbox" checked={sources.includes("youtube")} onChange={() => toggleSource("youtube")} /> YouTube</label>
          <label><input type="checkbox" checked={sources.includes("bilibili")} onChange={() => toggleSource("bilibili")} /> B站</label>
        </fieldset>

        <label className="topic-field full">
          <span>排序方式</span>
          <select value={rankingMode} onChange={(event) => setRankingMode(event.target.value as TopicInput["ranking_mode"])}>
            <option value="balanced">综合排序</option>
            <option value="people">人物优先</option>
            <option value="popular">热度优先</option>
            <option value="latest">最新优先</option>
          </select>
        </label>

        <footer>
          <span>{!sources.length ? "至少选择一个抓取来源" : !splitTerms(keywords).length ? "至少填写一个关键词" : "保存后即可按当前配置抓取"}</span>
          <button type="button" onClick={onClose}>取消</button>
          <button className="primary" type="submit" disabled={saving || !name.trim() || !splitTerms(keywords).length || !sources.length}>
            {saving ? <SpinnerGap className="spin" size={16} /> : <FloppyDisk size={16} />}
            {saving ? "保存中" : "保存主题"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TaskCenter({
  activeJobId,
  jobs,
  selectedId,
  selectedJob,
  selectedVideo,
  onOpenEditor,
  onRetry,
  onSelect,
}: {
  activeJobId?: number;
  jobs: Record<number, Job>;
  selectedId: number | null;
  selectedJob: Job | null;
  selectedVideo: Video | null;
  onOpenEditor: (videoId: number) => void;
  onRetry: (job: Job) => void | Promise<void>;
  onSelect: (videoId: number) => void;
}) {
  const records = Object.values(jobs).sort((left, right) => right.id - left.id).slice(0, 60);
  return (
    <section className="workbench-grid tasks-grid view-panel" role="tabpanel" aria-label="处理任务">
      <div className="daily-panel task-list-panel">
        <div className="panel-toolbar">
          <div>
            <h2>处理任务</h2>
            <p>{records.length ? `最近 ${records.length} 条本地任务` : "下载、字幕和导出任务会显示在这里"}</p>
          </div>
        </div>
        {records.length ? (
          <div className="job-list">
            {records.map((job) => {
              const videoId = jobVideoId(job);
              const active = isActiveJobStatus(job.status);
              return (
                <article
                  className={`job-row ${videoId && selectedId === videoId ? "selected" : ""} ${videoId ? "selectable" : ""}`}
                  key={job.id}
                  onClick={() => videoId && onSelect(videoId)}
                >
                  <div className="job-row-main">
                    <div className="job-row-head">
                      <StatusBadge status={job.status} />
                      <span>{jobTypeLabel(job.type)}</span>
                      <time>{formatJobTime(job.created_at)}</time>
                    </div>
                    <h3>{job.video_title || (videoId ? `视频 #${videoId}` : jobTypeLabel(job.type))}</h3>
                    <p>{job.message || "等待后台处理器更新状态。"}</p>
                    {active && <JobProgress job={job} />}
                    <div className="job-row-meta">
                      <span>任务 #{job.id}</span>
                      <span>执行 {job.attempts || 0} 次</span>
                    </div>
                  </div>
                  <div className="job-row-actions" onClick={(event) => event.stopPropagation()}>
                    {job.status === "failed" && (
                      <button type="button" onClick={() => void onRetry(job)}>
                        <ArrowCounterClockwise size={15} />
                        重试
                      </button>
                    )}
                    {videoId && (
                      <button className="ghost-action" type="button" onClick={() => onOpenEditor(videoId)}>
                        <Scissors size={15} />
                        打开剪辑
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="status-empty task-list-empty">
            <Clock size={22} />
            <h2>还没有处理任务</h2>
            <p>从“主题素材”进入剪辑工作台后，素材准备进度、失败原因和重试操作会集中显示在这里。</p>
          </div>
        )}
      </div>
      <aside className="status-panel">
        <TaskStatus
          selectedVideo={selectedVideo}
          job={selectedJob}
          active={Boolean(activeJobId)}
          onRetry={onRetry}
          onOpenEditor={selectedVideo ? () => onOpenEditor(selectedVideo.id) : undefined}
        />
      </aside>
    </section>
  );
}

function InterviewList(props: {
  items: Video[];
  selectedId: number | null;
  jobs: Record<number, Job>;
  jobIdsByVideo: Record<number, number>;
  onSelect: (id: number) => void;
  onOpenClip: (video: Video) => void;
}) {
  return (
    <div className="interview-list">
      {props.items.map((video) => {
        const jobId = props.jobIdsByVideo[video.id];
        const job = jobId ? props.jobs[jobId] : undefined;
        const processing = Boolean(jobId) || VIDEO_PROCESSING_STATUSES.has(video.status);
        return (
          <article key={video.id} className={`interview-row ${props.selectedId === video.id ? "selected" : ""}`} onClick={() => props.onSelect(video.id)}>
            <Thumbnail className="thumb" url={video.thumbnail_url} />
            <div className="row-main">
              <div className="row-title-line">
                <h3>{video.title}</h3>
                <StatusBadge status={processing ? "running" : video.status} />
              </div>
              <VideoSummary summary={video.summary} />
              <div className="row-meta">
                <span>{platformLabel(video.platform)}</span>
                <span>{video.channel_title || "未知来源"}</span>
                <span>{formatDate(video.published_at)}</span>
                <span>{formatDuration(video.duration_seconds)}</span>
                <span>{formatNumber(video.view_count)} 次观看</span>
                <PeopleSignal video={video} />
              </div>
              {job?.message && <div className="inline-job">{job.message}</div>}
              {video.last_error && <div className="inline-error">{video.last_error}</div>}
            </div>
            <div className="row-actions" onClick={(event) => event.stopPropagation()}>
              <button className="primary" onClick={() => props.onOpenClip(video)}>
                <Scissors size={16} />
                剪辑
              </button>
              <a href={video.url} target="_blank" rel="noreferrer">
                <ArrowSquareOut size={16} />
                原始链接
              </a>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TaskStatus({
  selectedVideo,
  job,
  active,
  onRetry,
  onOpenEditor,
}: {
  selectedVideo: Video | null;
  job: Job | null;
  active: boolean;
  onRetry: (job: Job) => void | Promise<void>;
  onOpenEditor?: () => void;
}) {
  if (!selectedVideo) {
    return (
      <div className="status-empty">
        <Clock size={22} />
        <h2>等待选择视频</h2>
        <p>选择任意素材后，这里会显示下载、字幕处理状态和下一步动作。</p>
      </div>
    );
  }
  const ready = selectedVideo.status === "clip_ready" || selectedVideo.status === "translated" || selectedVideo.status === "clipped" || selectedVideo.status === "exported";
  const visibleJob = job && (active || job.status === "failed") ? job : null;
  return (
    <div className="task-card">
      <div className="task-head">
        <StatusBadge status={visibleJob?.status ?? selectedVideo.status} />
        <span>{selectedVideo.source_tier === "experimental" ? "实验源" : "稳定源"}</span>
      </div>
      <h2>{selectedVideo.title}</h2>
      <p>{visibleJob?.message || selectedVideo.summary || "还没有任务。进入剪辑工作台后即可准备素材。"}</p>
      {visibleJob && active && <JobProgress job={visibleJob} />}
      {visibleJob?.status === "failed" && (
        <button className="job-retry" type="button" onClick={() => void onRetry(visibleJob)}>
          <ArrowCounterClockwise size={16} />
          重试失败任务
        </button>
      )}
      <div className="task-steps">
        <Step done={ready || selectedVideo.status !== "ready"} active={selectedVideo.status === "downloading"} label="下载视频" />
        <Step done={ready || selectedVideo.status === "subtitle_fetching" || selectedVideo.status === "translating"} active={selectedVideo.status === "subtitle_fetching"} label="拉取字幕" />
        <Step done={ready} active={selectedVideo.status === "transcribing" || selectedVideo.status === "translating"} label="转写翻译" />
        <Step done={ready} active={ready} label="进入剪辑" />
      </div>
      {onOpenEditor && (
        <button className="primary wide-link" type="button" onClick={onOpenEditor}>
          <Scissors size={16} />
          进入剪辑工作台
        </button>
      )}
      <a className="wide-link" href={selectedVideo.url} target="_blank" rel="noreferrer">
        <LinkSimple size={16} />
        打开原始视频
      </a>
    </div>
  );
}

function JobProgress({ job }: { job: Job }) {
  const progress = clamp(job.progress || 0, 0, 100);
  return (
    <div className="job-progress">
      <div className="job-progress-label">
        <span>后台任务进度</span>
        <strong>{progress}%</strong>
      </div>
      <div className="job-progress-track" role="progressbar" aria-label="后台任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span className="job-progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function VideoSummary({ summary }: { summary: string }) {
  const fallback = "待生成摘要。点击抓取或下载翻译后会补全内容摘要。";
  const text = summary || fallback;
  const marker = text.match(/\s(可剪辑点：|关注点：)/);
  const markerIndex = marker?.index ?? -1;
  const main = markerIndex > 0 ? text.slice(0, markerIndex).trim() : text;
  const detail = markerIndex > 0 ? text.slice(markerIndex).trim() : "";
  return (
    <div className="video-summary">
      <p>{main}</p>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function PeopleSignal({ video }: { video: Video }) {
  const tracked = video.matched_people?.trim();
  const candidate = video.candidate_people?.trim();
  const reason = video.people_match_reason || "标题、简介和已有字幕未识别到明确人物";
  if (tracked) {
    return (
      <span className="person-chip tracked" title={reason}>
        重点：{tracked}
      </span>
    );
  }
  if (candidate) {
    return (
      <span className="person-chip inferred" title={reason}>
        识别对象：{candidate}
      </span>
    );
  }
  return (
    <span className="person-chip unknown" title={reason}>
      对象待确认
    </span>
  );
}

function Thumbnail({ className, url }: { className: string; url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={className}>
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <FilmSlate size={28} />}
    </div>
  );
}

function ClipWorkspace({
  clip,
  job,
  selectedVideo,
  processing,
  onDownloadTranslate,
  onReprocessSubtitles,
  onJobQueued,
  onRefresh,
  onToast,
}: {
  clip: ClipPayload | null;
  job: Job | null;
  selectedVideo: Video | null;
  processing: boolean;
  onDownloadTranslate: (video: Video) => void;
  onReprocessSubtitles: (video: Video) => void;
  onJobQueued: (videoId: number, job: Job) => void;
  onRefresh: () => void;
  onToast: (message: string) => void;
}) {
  const video = clip?.video ?? selectedVideo;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const activeCaptionRef = useRef<HTMLButtonElement | null>(null);
  const [form, setForm] = useState({ start_seconds: "0", end_seconds: "15", label: "PR 短切片段", note: "", quote: "" });
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [draftPreviewRange, setDraftPreviewRange] = useState<ClipPreviewRange | null>(null);
  const [reviewingClipId, setReviewingClipId] = useState<number | null>(null);
  const [queueingRender, setQueueingRender] = useState(false);
  const [savingClip, setSavingClip] = useState(false);
  const [renderResult, setRenderResult] = useState<ClipRenderResult | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<ClipRenderOptions>(() => defaultClipExportOptions(""));
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadedLogo, setUploadedLogo] = useState<MediaAsset | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const deferredTranscriptSearch = useDeferredValue(transcriptSearch);
  const [transcriptRenderLimit, setTranscriptRenderLimit] = useState(120);
  const [editorStateVideoId, setEditorStateVideoId] = useState<number | null>(null);
  const [transcriptSelection, setTranscriptSelection] = useState<TranscriptSelection | null>(null);
  const [recentlyDeletedClip, setRecentlyDeletedClip] = useState<RecentlyDeletedClip | null>(null);
  const [restoringDeletedClip, setRestoringDeletedClip] = useState(false);
  const [updatingClipId, setUpdatingClipId] = useState<number | null>(null);
  const [bulkUpdatingStatus, setBulkUpdatingStatus] = useState<string | null>(null);
  const [sequenceFocusRequest, setSequenceFocusRequest] = useState<SequenceFocusRequest | null>(null);
  const [reorderingClipId, setReorderingClipId] = useState<number | null>(null);
  const renderJob = job?.type === "render_clips" ? job : null;
  const rendering = queueingRender || Boolean(renderJob && isActiveJobStatus(renderJob.status));
  const rows = useMemo(() => {
    const transcripts = clip?.transcripts ?? [];
    return buildTranscriptRows(
      transcripts.filter((item) => item.language === "zh"),
      transcripts.filter((item) => item.language === "en"),
    );
  }, [clip?.transcripts]);
  const activeTranscriptIndex = rows.findIndex((row) => currentTime >= row.start && currentTime < row.end);
  const hasChineseTranscript = rows.some((row) => Boolean(row.zh));
  const visibleTranscriptRows = useMemo(() => filterTranscriptRows(rows, deferredTranscriptSearch), [deferredTranscriptSearch, rows]);
  const renderedTranscriptRows = useMemo(
    () => buildTranscriptWindow(visibleTranscriptRows, transcriptRenderLimit, activeTranscriptIndex),
    [activeTranscriptIndex, transcriptRenderLimit, visibleTranscriptRows],
  );
  const selectedTranscriptRange = useMemo(() => buildTranscriptSelectionSummary(rows, transcriptSelection), [rows, transcriptSelection]);
  const clipMarks = clip?.clip_marks ?? [];
  const latestBrandLogo = uploadedLogo ?? (clip?.media_assets ?? []).find((asset) => asset.kind === "brand_logo") ?? null;
  const selectedBrandLogo = exportOptions.logo_asset_id
    ? uploadedLogo?.id === exportOptions.logo_asset_id
      ? uploadedLogo
      : (clip?.media_assets ?? []).find((asset) => asset.id === exportOptions.logo_asset_id && asset.kind === "brand_logo") ?? null
    : null;
  const lastTranscriptEnd = rows.length ? rows[rows.length - 1].end : 0;
  const lastClipEnd = clipMarks.length ? Math.max(...clipMarks.map((mark) => mark.end_seconds)) : 0;
  const timelineDuration = Math.max(mediaDuration, video?.duration_seconds || 0, lastTranscriptEnd, lastClipEnd, Number(form.end_seconds) || 0, 1);
  const suggestions = useMemo(() => buildHighlightSuggestions(rows, timelineDuration), [rows, timelineDuration]);
  const sequenceDuration = clipMarksDuration(clipMarks);
  const approvedClipMarks = clipMarks.filter((mark) => mark.status === "approved");
  const unapprovedClipMarks = clipMarks.filter((mark) => mark.status !== "approved");
  const exportClipMarks = exportOptions.clip_status_filter === "approved" ? approvedClipMarks : clipMarks;
  const exportSequenceDuration = clipMarksDuration(exportClipMarks);
  const exportedSequenceCount = (clip?.media_assets ?? []).filter((asset) => asset.kind === "exported_sequence" && asset.url).length + (renderResult?.sequence_url ? 1 : 0);
  const deliveryBrief = useMemo(
    () =>
      video
        ? buildClipDeliveryBrief({
            assets: clip?.media_assets ?? [],
            marks: clipMarks,
            origin: typeof window === "undefined" ? "" : window.location.origin,
            renderResult,
            video,
          })
        : "",
    [clip?.media_assets, clipMarks, renderResult, video],
  );
  const deliverySummary = useMemo(
    () =>
      video
        ? buildClipDeliverySummary({
            assets: clip?.media_assets ?? [],
            marks: clipMarks,
            origin: typeof window === "undefined" ? "" : window.location.origin,
            renderResult,
          })
        : null,
    [clip?.media_assets, clipMarks, renderResult, video],
  );

  useEffect(() => {
    const defaults = defaultClipEditorState(video?.title ?? "");
    const restored = video ? loadClipEditorState(video.id, defaults) : defaults;
    setForm(restored.form);
    setCurrentTime(restored.currentTime);
    setMediaDuration(0);
    setDraftPreviewRange(null);
    setReviewingClipId(null);
    setRenderResult(null);
    setQueueingRender(false);
    setUploadingLogo(false);
    setUploadedLogo(null);
    setSavingClip(false);
    setUpdatingClipId(null);
    setReorderingClipId(null);
    setExportDialogOpen(false);
    setTranscriptSearch(restored.transcriptSearch);
    setTranscriptRenderLimit(120);
    setTranscriptSelection(null);
    setRecentlyDeletedClip(null);
    setRestoringDeletedClip(false);
    setBulkUpdatingStatus(null);
    setSequenceFocusRequest(null);
    setExportOptions(restored.exportOptions);
    setEditorStateVideoId(video?.id ?? null);
  }, [video?.id]);

  useEffect(() => {
    if (!video || editorStateVideoId !== video.id) return;
    const timer = window.setTimeout(() => {
      saveClipEditorState(video.id, {
        currentTime,
        exportOptions,
        form,
        transcriptSearch,
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [currentTime, editorStateVideoId, exportOptions, form, transcriptSearch, video?.id]);

  useEffect(() => {
    setTranscriptRenderLimit(120);
  }, [deferredTranscriptSearch, video?.id]);

  useEffect(() => {
    if (activeTranscriptIndex < 0) return;
    const activeCaption = activeCaptionRef.current;
    const transcriptList = activeCaption?.closest<HTMLElement>(".transcript-list");
    if (!activeCaption || !transcriptList) return;
    const activeRect = activeCaption.getBoundingClientRect();
    const listRect = transcriptList.getBoundingClientRect();
    const top = transcriptList.scrollTop + activeRect.top - listRect.top - (transcriptList.clientHeight - activeRect.height) / 2;
    transcriptList.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [activeTranscriptIndex]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const tracks = videoRef.current?.textTracks;
      if (!tracks?.length) return;
      for (let index = 0; index < tracks.length; index += 1) {
        tracks[index].mode = tracks[index].language === "zh-Hans" || index === 0 ? "showing" : "disabled";
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [clip?.media_url, rows.length, video?.id]);

  useEffect(() => {
    if (!reviewingClipId) return;
    if (!clipMarks.some((mark) => mark.id === reviewingClipId)) setReviewingClipId(null);
  }, [clipMarks, reviewingClipId]);

  useEffect(() => {
    if (renderJob?.status !== "completed") return;
    const result = jobResult<ClipRenderResult>(renderJob);
    if (!result?.sequence_path || result.sequence_path === renderResult?.sequence_path) return;
    setRenderResult(result);
    onRefresh();
  }, [onRefresh, renderJob, renderResult?.sequence_path]);

  if (!video) {
    return (
      <section id="clip-workspace" className="clip-workspace empty-clip-workspace">
        <div className="status-empty">
          <Scissors size={24} />
          <h2>还没有选择剪辑视频</h2>
          <p>从上方素材列表点击任意一条，或点击列表右侧“剪辑”按钮，这里会显示当前要处理的视频。</p>
        </div>
      </section>
    );
  }

  const ready = video.status === "clip_ready" || video.status === "translated" || video.status === "clipped" || video.status === "exported";
  const hasMedia = isDemoMode || Boolean(clip?.media_url);
  const canEdit = ready && Boolean(clip);
  const transcriptSnapRows = rows.map((row) => ({ end: row.end, start: row.start, text: row.zh?.text || row.en?.text || "" }));
  const buildClipCopyPayload = (mark: ClipMark) => {
    const copy = buildTranscriptClipCopy(buildTranscriptSnapForRange(transcriptSnapRows, mark.start_seconds, mark.end_seconds));
    const mergedCopy = mergeMissingClipCopyFields(mark, copy);
    if (!mergedCopy) return null;
    return {
      start_seconds: mark.start_seconds,
      end_seconds: mark.end_seconds,
      label: mergedCopy.label,
      note: mergedCopy.note,
      quote: mergedCopy.quote,
      status: mark.status || "ready",
    };
  };
  const exportCopyableClipCount = exportClipMarks.filter((mark) => buildClipCopyPayload(mark)).length;
  const exportPreflightChecks = buildExportPreflightChecks({
    destination: exportOptions.destination,
    filename: exportOptions.filename,
    hasMedia,
    marks: exportClipMarks,
    outputDir: exportOptions.output_dir,
    rowsCount: rows.length,
    sequenceDuration: exportSequenceDuration,
    clipStatusFilter: exportOptions.clip_status_filter,
    missingCopyCount: exportCopyableClipCount,
    targetDuration: exportOptions.target_duration_seconds,
    fitMode: exportOptions.fit_mode,
    focusX: exportOptions.focus_x,
    logoAsset: selectedBrandLogo,
    logoAssetId: exportOptions.logo_asset_id,
    logoPosition: exportOptions.logo_position,
    outputProfile: exportOptions.output_profile,
    subtitlePosition: exportOptions.subtitle_position,
    subtitleStyle: exportOptions.subtitle_style,
  });
  const exportBlockers = exportPreflightChecks.filter((check) => check.severity === "block");
  const addableSuggestionCount = suggestions.filter(
    (suggestion) => !clipMarks.some((mark) => Math.abs(mark.start_seconds - suggestion.start) < 0.5 && Math.abs(mark.end_seconds - suggestion.end) < 0.5),
  ).length;
  const manualClipStart = Number(form.start_seconds);
  const manualClipEnd = Number(form.end_seconds);
  const manualClipDuplicate =
    Number.isFinite(manualClipStart) &&
    Number.isFinite(manualClipEnd) &&
    clipMarks.some((mark) => Math.abs(mark.start_seconds - manualClipStart) < 0.5 && Math.abs(mark.end_seconds - manualClipEnd) < 0.5);
  const manualClipValidation = canEdit
    ? buildManualClipValidation({
        duplicate: manualClipDuplicate,
        end: manualClipEnd,
        timelineDuration,
        start: manualClipStart,
      })
    : { ok: false, severity: "block" as const, message: "等待字幕和剪辑数据就绪。" };
  const canSubmitManualClip = canEdit && !savingClip && manualClipValidation.ok;
  const copyableClipCount = clipMarks.filter((mark) => buildClipCopyPayload(mark)).length;
  const deliveryNextStep = deliverySummary ? buildClipDeliveryNextStep(deliverySummary, { canAutofillCopy: copyableClipCount > 0 }) : null;
  const deliveryNextStepDisabled =
    deliveryNextStep?.id === "copy"
      ? Boolean(updatingClipId) || Boolean(bulkUpdatingStatus)
      : deliveryNextStep?.id === "export"
        ? rendering
        : false;

  const showChineseTextTrack = () => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks?.length) return;
    for (let index = 0; index < tracks.length; index += 1) {
      tracks[index].mode = tracks[index].language === "zh-Hans" || index === 0 ? "showing" : "disabled";
    }
  };

  const seekTo = (seconds: number) => {
    const safe = clamp(seconds, 0, timelineDuration);
    setCurrentTime(safe);
    if (videoRef.current && Number.isFinite(videoRef.current.duration)) {
      videoRef.current.currentTime = safe;
    }
  };

  const playSequenceClip = async (index: number) => {
    const mark = clipMarks[index];
    if (!mark || !videoRef.current) return;
    setDraftPreviewRange(null);
    setReviewingClipId(mark.id);
    videoRef.current.currentTime = mark.start_seconds;
    setCurrentTime(mark.start_seconds);
    try {
      await videoRef.current.play();
    } catch {
      onToast("浏览器阻止了自动播放，请手动点击播放器播放。");
    }
  };

  const previewDraftRange = async (start: number, end: number) => {
    const safeStart = clamp(Number.isFinite(start) ? start : 0, 0, timelineDuration);
    const safeEnd = clamp(Number.isFinite(end) ? end : safeStart, safeStart, timelineDuration);
    if (safeEnd <= safeStart) {
      onToast("当前草稿片段还不能预览，请先确认入点和出点。");
      return;
    }
    setReviewingClipId(null);
    if (!videoRef.current) {
      seekTo(safeStart);
      setDraftPreviewRange(null);
      onToast("缺少本地视频，已定位到草稿入点。");
      return;
    }
    setDraftPreviewRange({ end: safeEnd });
    videoRef.current.currentTime = safeStart;
    setCurrentTime(safeStart);
    try {
      await videoRef.current.play();
    } catch {
      onToast("浏览器阻止了自动播放，请手动点击播放器播放。");
    }
  };

  const firstUnapprovedClipIndex = () => {
    const index = clipMarks.findIndex((mark) => mark.status !== "approved");
    return index >= 0 ? index : 0;
  };

  const playUnapprovedReviewQueue = () => {
    void playSequenceClip(firstUnapprovedClipIndex());
  };

  const stopSequenceReview = (pause = true) => {
    setReviewingClipId(null);
    if (pause) videoRef.current?.pause();
  };

  const jumpSequenceReview = (direction: -1 | 1) => {
    if (!clipMarks.length) return;
    const activeIndex = reviewingClipId ? clipMarks.findIndex((mark) => mark.id === reviewingClipId) : clipMarks.findIndex((mark) => currentTime >= mark.start_seconds && currentTime <= mark.end_seconds);
    const baseIndex = activeIndex >= 0 ? activeIndex : direction > 0 ? -1 : clipMarks.length;
    const nextIndex = clamp(baseIndex + direction, 0, clipMarks.length - 1);
    void playSequenceClip(nextIndex);
  };

  const handleVideoTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const nextTime = event.currentTarget.currentTime || 0;
    setCurrentTime(nextTime);
    if (draftPreviewRange) {
      if (nextTime < draftPreviewRange.end - 0.08) return;
      event.currentTarget.pause();
      event.currentTarget.currentTime = draftPreviewRange.end;
      setCurrentTime(draftPreviewRange.end);
      setDraftPreviewRange(null);
      return;
    }
    if (!reviewingClipId) return;
    const activeIndex = clipMarks.findIndex((mark) => mark.id === reviewingClipId);
    const activeMark = activeIndex >= 0 ? clipMarks[activeIndex] : null;
    if (!activeMark) {
      setReviewingClipId(null);
      return;
    }
    if (nextTime < activeMark.end_seconds - 0.08) return;
    const nextMark = clipMarks[activeIndex + 1];
    if (!nextMark) {
      event.currentTarget.pause();
      setReviewingClipId(null);
      onToast("序列审片完成。");
      return;
    }
    setReviewingClipId(nextMark.id);
    event.currentTarget.currentTime = nextMark.start_seconds;
    setCurrentTime(nextMark.start_seconds);
    void event.currentTarget.play().catch(() => onToast("浏览器阻止了自动播放，请手动点击播放器播放。"));
  };

  const applyRange = (start: number, end: number, label: string, note: string, quote = "") => {
    const safeStart = clamp(start, 0, timelineDuration);
    const safeEnd = clamp(Math.max(end, safeStart + 1), safeStart + 1, timelineDuration || safeStart + 1);
    setForm({
      start_seconds: toSecondInput(safeStart),
      end_seconds: toSecondInput(safeEnd),
      label,
      note,
      quote,
    });
    seekTo(safeStart);
  };

  const applyTranscriptSummary = (summary: TranscriptSelectionSummary) => {
    applyRange(summary.start, summary.end, summary.label, summary.note, summary.quote);
  };

  const defaultTranscriptIndex = () => {
    if (!rows.length) return -1;
    if (activeTranscriptIndex >= 0) return activeTranscriptIndex;
    const nextIndex = rows.findIndex((row) => row.start >= currentTime);
    return nextIndex >= 0 ? nextIndex : rows.length - 1;
  };

  const selectTranscriptRange = (index: number, extend = false) => {
    if (!rows[index]) return;
    const nextSelection = extend && transcriptSelection ? { anchorIndex: transcriptSelection.anchorIndex, focusIndex: index } : { anchorIndex: index, focusIndex: index };
    setTranscriptSelection(nextSelection);
    const summary = buildTranscriptSelectionSummary(rows, nextSelection);
    if (summary) applyTranscriptSummary(summary);
  };

  const adjustTranscriptRange = (direction: -1 | 1) => {
    if (!rows.length) return;
    const baseIndex = transcriptSelection?.focusIndex ?? defaultTranscriptIndex();
    if (baseIndex < 0) return;
    const nextFocus = clamp(baseIndex + direction, 0, rows.length - 1);
    const nextSelection = { anchorIndex: transcriptSelection?.anchorIndex ?? baseIndex, focusIndex: nextFocus };
    setTranscriptSelection(nextSelection);
    const summary = buildTranscriptSelectionSummary(rows, nextSelection);
    if (summary) applyTranscriptSummary(summary);
  };

  const clearTranscriptRange = () => {
    setTranscriptSelection(null);
  };

  const addTranscriptRangeToSequence = async () => {
    if (!selectedTranscriptRange) {
      onToast("请先选择字幕片段。");
      return;
    }
    await saveClipRange({
      start: selectedTranscriptRange.start,
      end: selectedTranscriptRange.end,
      label: selectedTranscriptRange.label,
      note: selectedTranscriptRange.note,
      quote: selectedTranscriptRange.quote,
      successMessage: `已加入 ${selectedTranscriptRange.count} 句字幕选区。`,
    });
  };

  const setPointFromPlayhead = (field: "start_seconds" | "end_seconds") => {
    const safe = toSecondInput(currentTime);
    if (field === "start_seconds") {
      const end = Math.max(Number(form.end_seconds) || 0, currentTime + 1);
      setForm({ ...form, start_seconds: safe, end_seconds: toSecondInput(end) });
      onToast("已设置入点。移动到结束位置后，点击“设为结束并加入序列”。");
      return;
    }
    setForm({ ...form, end_seconds: safe });
  };

  const nudgePlayhead = (offset: number) => {
    seekTo(currentTime + offset);
  };

  const saveClipRange = async (payload: { start: number; end: number; label: string; note: string; quote?: string; successMessage: string; allowDuplicate?: boolean }) => {
    if (!clip || savingClip) return;
    const start = clamp(payload.start, 0, timelineDuration);
    const end = clamp(payload.end, start, timelineDuration || payload.end);
    if (end <= start) {
      onToast("出点必须晚于入点。");
      return;
    }
    const duplicate = clipMarks.some((mark) => Math.abs(mark.start_seconds - start) < 0.5 && Math.abs(mark.end_seconds - end) < 0.5);
    if (duplicate && !payload.allowDuplicate) {
      onToast("这段已经在剪辑序列里了。");
      return;
    }
    setSavingClip(true);
    try {
      await api.createClip({
        video_id: clip.video.id,
        start_seconds: start,
        end_seconds: end,
        label: payload.label,
        note: payload.note,
        quote: payload.quote ?? "",
        status: "ready",
      });
      onToast(payload.successMessage);
      onRefresh();
    } catch (error) {
      onToast(readError(error, "加入剪辑序列失败"));
    } finally {
      setSavingClip(false);
    }
  };

  const submitClip = async (event: FormEvent) => {
    event.preventDefault();
    await saveClipRange({
      start: Number(form.start_seconds),
      end: Number(form.end_seconds),
      label: form.label || "手动片段",
      note: form.note,
      quote: form.quote,
      successMessage: "已保存手动片段。",
    });
  };

  const finishSelectionAtPlayhead = async () => {
    const start = Number(form.start_seconds);
    const end = currentTime;
    if (end <= start) {
      onToast("请先移动到晚于入点的位置，再加入剪辑序列。");
      return;
    }
    setForm({ ...form, end_seconds: toSecondInput(end) });
    await saveClipRange({
      start,
      end,
      label: form.label || "手动片段",
      note: form.note || `手动选区 ${formatTimecode(start)} - ${formatTimecode(end)}`,
      quote: form.quote,
      successMessage: "已加入剪辑序列。",
    });
  };

  const applyActiveCaption = () => {
    const index = defaultTranscriptIndex();
    if (index < 0) {
      onToast("还没有可用字幕。");
      return;
    }
    selectTranscriptRange(index);
  };

  const addActiveCaptionToSequence = async () => {
    const index = defaultTranscriptIndex();
    if (index < 0) {
      onToast("还没有可用字幕。");
      return;
    }
    const summary = buildTranscriptSelectionSummary(rows, { anchorIndex: index, focusIndex: index });
    if (!summary) {
      onToast("当前字幕无法加入序列。");
      return;
    }
    setTranscriptSelection({ anchorIndex: index, focusIndex: index });
    applyTranscriptSummary(summary);
    await saveClipRange({
      start: summary.start,
      end: summary.end,
      label: summary.label,
      note: summary.note,
      quote: summary.quote,
      successMessage: "已把当前字幕加入剪辑序列。",
    });
  };

  const applyPresetFromPlayhead = (seconds: number) => {
    const start = clamp(currentTime, 0, timelineDuration);
    applyRange(start, start + seconds, `${seconds} 秒短切`, `从播放位置创建 ${seconds} 秒候选片段`);
  };

  const jumpCaption = (direction: -1 | 1) => {
    if (!rows.length) return;
    const currentIndex = activeTranscriptIndex >= 0 ? activeTranscriptIndex : rows.findIndex((row) => row.start >= currentTime);
    const fallbackIndex = direction > 0 ? 0 : rows.length - 1;
    const nextIndex = clamp((currentIndex >= 0 ? currentIndex : fallbackIndex) + direction, 0, rows.length - 1);
    seekTo(rows[nextIndex].start);
  };

  const addSuggestionToSequence = async (suggestion: HighlightSuggestion) => {
    seekTo(suggestion.start);
    await saveClipRange({
      start: suggestion.start,
      end: suggestion.end,
      label: suggestion.label,
      note: suggestion.reason,
      quote: suggestion.quote,
      successMessage: "已把推荐高光加入剪辑序列。",
    });
  };

  const addAllSuggestionsToSequence = async () => {
    if (!clip || savingClip || !suggestions.length) return;
    const additions = suggestions.filter(
      (suggestion) => !clipMarks.some((mark) => Math.abs(mark.start_seconds - suggestion.start) < 0.5 && Math.abs(mark.end_seconds - suggestion.end) < 0.5),
    );
    if (!additions.length) {
      onToast("推荐高光都已经在剪辑序列里了。");
      return;
    }
    let addedCount = 0;
    setSavingClip(true);
    try {
      for (const suggestion of additions) {
        await api.createClip({
          video_id: clip.video.id,
          start_seconds: suggestion.start,
          end_seconds: suggestion.end,
          label: suggestion.label,
          note: suggestion.reason,
          quote: suggestion.quote,
          status: "ready",
        });
        addedCount += 1;
      }
      seekTo(additions[0].start);
      const skippedCount = suggestions.length - additions.length;
      onToast(skippedCount ? `已加入 ${addedCount} 个新高光，跳过 ${skippedCount} 个已存在片段。` : `已加入 ${addedCount} 个推荐高光。`);
    } catch (error) {
      onToast(readError(error, addedCount ? `已加入 ${addedCount} 个高光，但后续保存失败` : "批量加入推荐高光失败"));
    } finally {
      if (addedCount) onRefresh();
      setSavingClip(false);
    }
  };

  const removeFromSequence = async (clipMarkId: number) => {
    const mark = clipMarks.find((item) => item.id === clipMarkId);
    const orderIds = clipMarks.map((item) => item.id);
    try {
      const result = await api.deleteClip(clipMarkId);
      if (mark) setRecentlyDeletedClip({ mark, orderIds });
      onToast(mark ? "已移除片段，可从序列里恢复。" : result.message);
      onRefresh();
    } catch (error) {
      onToast(readError(error, "移除片段失败"));
    }
  };

  const restoreDeletedClip = async () => {
    if (!clip || !recentlyDeletedClip || restoringDeletedClip) return;
    const { mark, orderIds } = recentlyDeletedClip;
    setRestoringDeletedClip(true);
    try {
      const restored = await api.createClip({
        video_id: mark.video_id,
        start_seconds: mark.start_seconds,
        end_seconds: mark.end_seconds,
        label: mark.label,
        note: mark.note,
        quote: mark.quote,
        status: mark.status || "ready",
      });
      const desiredOrderIds = orderIds.map((id) => (id === mark.id ? restored.id : id));
      const currentIds = clipMarks.map((item) => item.id).filter((id) => id !== mark.id && id !== restored.id);
      const mergedOrderIds = [...desiredOrderIds, ...currentIds.filter((id) => !desiredOrderIds.includes(id))];
      let orderRestored = true;
      try {
        await api.reorderClips(clip.video.id, mergedOrderIds);
      } catch {
        orderRestored = false;
      }
      setRecentlyDeletedClip(null);
      onToast(orderRestored ? "已恢复刚才删除的片段。" : "片段已恢复，顺序可能需要手动调整。");
      onRefresh();
    } catch (error) {
      onToast(readError(error, "恢复片段失败"));
    } finally {
      setRestoringDeletedClip(false);
    }
  };

  const updateClipInSequence = async (clipMarkId: number, payload: Pick<ClipMark, "start_seconds" | "end_seconds" | "label" | "note" | "quote" | "status">) => {
    if (!clip || updatingClipId || bulkUpdatingStatus) return false;
    const start = clamp(Number(payload.start_seconds), 0, timelineDuration);
    const end = clamp(Number(payload.end_seconds), 0, timelineDuration);
    if (end <= start) {
      onToast("出点必须晚于入点。");
      return false;
    }
    setUpdatingClipId(clipMarkId);
    try {
      await api.updateClip(clipMarkId, {
        ...payload,
        start_seconds: start,
        end_seconds: end,
        label: payload.label.trim() || "未命名片段",
      });
      onToast("剪辑片段已更新。");
      onRefresh();
      return true;
    } catch (error) {
      onToast(readError(error, "更新片段失败"));
      return false;
    } finally {
      setUpdatingClipId(null);
    }
  };

  const setClipStatusInSequence = async (mark: ClipMark, status: string) => {
    if (mark.status === status || updatingClipId === mark.id) return false;
    return updateClipInSequence(mark.id, {
      start_seconds: mark.start_seconds,
      end_seconds: mark.end_seconds,
      label: mark.label,
      note: mark.note,
      quote: mark.quote,
      status,
    });
  };

  const setAllClipStatusesInSequence = async (status: string) => {
    if (!clip || !clipMarks.length || updatingClipId || bulkUpdatingStatus) return;
    const targets = clipMarks.filter((mark) => mark.status !== status);
    if (!targets.length) {
      onToast(status === "approved" ? "所有片段已经确认。" : "所有片段已经是可用状态。");
      return;
    }
    setBulkUpdatingStatus(status);
    try {
      await Promise.all(
        targets.map((mark) =>
          api.updateClip(mark.id, {
            start_seconds: mark.start_seconds,
            end_seconds: mark.end_seconds,
            label: mark.label,
            note: mark.note,
            quote: mark.quote,
            status,
          }),
        ),
      );
      onToast(status === "approved" ? `已确认 ${targets.length} 段片段。` : `已重置 ${targets.length} 段为可用。`);
      onRefresh();
    } catch (error) {
      onToast(readError(error, "批量更新审片状态失败"));
    } finally {
      setBulkUpdatingStatus(null);
    }
  };

  const fillClipCopyInSequence = async (targetMarks = clipMarks, completeLabel = "所有片段", updatedLabel = "片段") => {
    if (!clip || !clipMarks.length || updatingClipId || bulkUpdatingStatus) return;
    const targets = targetMarks
      .map((mark) => ({ mark, payload: buildClipCopyPayload(mark) }))
      .filter((item): item is { mark: ClipMark; payload: NonNullable<ReturnType<typeof buildClipCopyPayload>> } => Boolean(item.payload));
    if (!targets.length) {
      onToast(rows.length ? `${completeLabel}文案已经补齐。` : "还没有可用字幕，无法补齐文案。");
      return;
    }
    setBulkUpdatingStatus("copy");
    try {
      await Promise.all(targets.map(({ mark, payload }) => api.updateClip(mark.id, payload)));
      onToast(`已补齐 ${targets.length} 段${updatedLabel}文案。`);
      onRefresh();
    } catch (error) {
      onToast(readError(error, "批量补齐片段文案失败"));
    } finally {
      setBulkUpdatingStatus(null);
    }
  };

  const approveClipAndContinue = async (mark: ClipMark, index: number) => {
    if (updatingClipId === mark.id) return;
    const saved = mark.status === "approved" || (await setClipStatusInSequence(mark, "approved"));
    if (!saved) return;
    const nextUnapprovedIndex = clipMarks.findIndex((item, itemIndex) => itemIndex > index && item.status !== "approved");
    if (nextUnapprovedIndex >= 0) {
      void playSequenceClip(nextUnapprovedIndex);
      return;
    }
    stopSequenceReview(false);
    onToast("所有片段都已确认。");
  };

  const duplicateClipInSequence = async (mark: ClipMark) => {
    await saveClipRange({
      start: mark.start_seconds,
      end: mark.end_seconds,
      label: `${mark.label || "片段"} 备选`,
      note: mark.note,
      quote: mark.quote,
      successMessage: "已复制为备选片段。",
      allowDuplicate: true,
    });
  };

  const reorderClipSequence = async (clipMarkIds: number[], activeClipId: number) => {
    if (!clip || reorderingClipId) return;
    const knownIds = new Set(clipMarks.map((mark) => mark.id));
    const uniqueIds = new Set(clipMarkIds);
    const unchanged = clipMarks.every((mark, index) => mark.id === clipMarkIds[index]);
    if (clipMarkIds.length !== clipMarks.length || uniqueIds.size !== clipMarks.length || clipMarkIds.some((id) => !knownIds.has(id)) || unchanged) return;
    setReorderingClipId(activeClipId);
    try {
      const result = await api.reorderClips(clip.video.id, clipMarkIds);
      onToast(result.message);
      onRefresh();
    } catch (error) {
      onToast(readError(error, "调整序列顺序失败"));
    } finally {
      setReorderingClipId(null);
    }
  };

  const moveClipInSequence = async (clipMarkId: number, direction: -1 | 1) => {
    const currentIndex = clipMarks.findIndex((mark) => mark.id === clipMarkId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= clipMarks.length) return;
    const nextMarks = [...clipMarks];
    [nextMarks[currentIndex], nextMarks[nextIndex]] = [nextMarks[nextIndex], nextMarks[currentIndex]];
    await reorderClipSequence(nextMarks.map((mark) => mark.id), clipMarkId);
  };

  const uploadBrandLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!video || !file) return;
    setUploadingLogo(true);
    try {
      const asset = await api.uploadBrandLogo(video.id, file);
      setUploadedLogo(asset);
      setExportOptions((current) => ({ ...current, logo_asset_id: asset.id }));
      onToast("品牌 Logo 已上传并加入当前导出。");
      onRefresh();
    } catch (error) {
      onToast(readError(error, "Logo 上传失败"));
    } finally {
      setUploadingLogo(false);
      input.value = "";
    }
  };

  const renderSavedClips = async () => {
    if (!video || !clipMarks.length) return;
    if (exportBlockers.length) {
      onToast(`导出前请处理：${exportBlockers[0].label}`);
      return;
    }
    if (exportOptions.destination === "custom" && !exportOptions.output_dir.trim()) {
      onToast("请填写自定义保存文件夹路径。");
      return;
    }
    setQueueingRender(true);
    try {
      const queued = await api.renderClips(video.id, exportOptions);
      onJobQueued(video.id, queued);
      onToast(queued.message);
      setExportDialogOpen(false);
    } catch (error) {
      onToast(readError(error, "导出片段视频失败"));
    } finally {
      setQueueingRender(false);
    }
  };

  const copyDeliveryBrief = async () => {
    if (!deliveryBrief) {
      onToast("还没有可复制的交付稿。");
      return;
    }
    try {
      await navigator.clipboard.writeText(deliveryBrief);
      onToast("已复制剪辑交付稿。");
    } catch {
      onToast("复制失败，可以手动选中交付稿文本复制。");
    }
  };

  const openExportDialog = (clipStatusFilter?: string) => {
    if (clipStatusFilter) {
      setExportOptions((current) => ({ ...current, clip_status_filter: clipStatusFilter }));
    }
    setExportDialogOpen(true);
  };

  const scrollToClipPanel = (selector: string) => {
    setExportDialogOpen(false);
    window.setTimeout(() => {
      document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
  };

  const focusSequenceFilter = (filter: SequenceFilter) => {
    setExportDialogOpen(false);
    setSequenceFocusRequest((current) => ({ filter, token: (current?.token ?? 0) + 1 }));
    window.setTimeout(() => {
      document.querySelector(".marks-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
  };

  const startReviewFromPreflight = () => {
    setExportDialogOpen(false);
    document.querySelector(".player-panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
    playUnapprovedReviewQueue();
  };

  const runDeliveryNextStep = () => {
    if (!deliveryNextStep) return;
    if (deliveryNextStep.id === "copy") {
      void fillClipCopyInSequence();
      return;
    }
    if (deliveryNextStep.id === "view-copy") {
      focusSequenceFilter("copy");
      return;
    }
    if (deliveryNextStep.id === "review") {
      startReviewFromPreflight();
      return;
    }
    if (deliveryNextStep.id === "export") {
      openExportDialog(approvedClipMarks.length ? "approved" : "all");
      return;
    }
    if (deliveryNextStep.id === "sequence") {
      scrollToClipPanel(".marks-panel");
      return;
    }
    void copyDeliveryBrief();
  };

  const preflightActions: ExportPreflightActions = {
    media: {
      label: processing ? "处理中" : "下载视频",
      disabled: processing || hasMedia,
      onAction: () => onDownloadTranslate(video),
    },
    sequence: {
      label: "加入当前字幕",
      disabled: !canEdit || savingClip || !rows.length || clipMarks.length > 0,
      onAction: addActiveCaptionToSequence,
    },
    boundaries: {
      label: "精修片段",
      disabled: !clipMarks.length,
      onAction: () => scrollToClipPanel(".marks-panel"),
    },
    review: {
      label: exportOptions.clip_status_filter === "approved" ? "改为全部序列" : unapprovedClipMarks.length ? "继续审片" : "复看成片",
      disabled: !clipMarks.length || (!hasMedia && exportOptions.clip_status_filter !== "approved"),
      onAction: () => {
        if (exportOptions.clip_status_filter === "approved") {
          setExportOptions((current) => ({ ...current, clip_status_filter: "all" }));
          return;
        }
        startReviewFromPreflight();
      },
    },
    copy: {
      label: exportCopyableClipCount ? "补齐文案" : "查看序列",
      disabled: !clipMarks.length || Boolean(updatingClipId) || Boolean(bulkUpdatingStatus),
      onAction: exportCopyableClipCount ? () => fillClipCopyInSequence(exportClipMarks, "当前导出范围", "导出范围片段") : () => scrollToClipPanel(".marks-panel"),
    },
    destination: {
      label: "用下载文件夹",
      disabled: exportOptions.destination !== "custom" || Boolean(exportOptions.output_dir.trim()),
      onAction: () => setExportOptions((current) => ({ ...current, destination: "downloads", output_dir: "" })),
    },
    version: {
      label: "导出完整序列",
      disabled: exportOptions.target_duration_seconds === 0,
      onAction: () => setExportOptions((current) => ({ ...current, target_duration_seconds: 0 })),
    },
    subtitles: {
      label: processing ? "处理中" : "重新下载",
      disabled: processing || rows.length > 0,
      onAction: () => onDownloadTranslate(video),
    },
    "clip-length": {
      label: "精修片段",
      disabled: !clipMarks.length,
      onAction: () => scrollToClipPanel(".marks-panel"),
    },
    "sequence-length": {
      label: "审片播放",
      disabled: !hasMedia || !clipMarks.length,
      onAction: startReviewFromPreflight,
    },
    overlap: {
      label: "查看序列",
      disabled: !clipMarks.length,
      onAction: () => scrollToClipPanel(".marks-panel"),
    },
    filename: {
      label: "使用默认名",
      disabled: Boolean(exportOptions.filename.trim()),
      onAction: () => setExportOptions((current) => ({ ...current, filename: defaultExportFilename(video.title) })),
    },
  };

  const deliveryChecklistItems: DeliveryChecklistItem[] = [
    {
      id: "material",
      label: "素材就绪",
      message: hasMedia && rows.length ? "本地视频和字幕都可用于精剪。" : !hasMedia ? "先把视频下载到本机，播放器和导出才可用。" : "视频已就绪，还需要字幕用于复核。",
      status: hasMedia && rows.length ? "done" : "todo",
      actionLabel: hasMedia && rows.length ? undefined : processing ? "处理中" : "下载视频",
      disabled: processing,
      onAction: hasMedia && rows.length ? undefined : () => onDownloadTranslate(video),
    },
    {
      id: "sequence",
      label: "搭建序列",
      message: clipMarks.length ? `${clipMarks.length} 段，当前总长 ${formatDuration(sequenceDuration)}。` : "还没有成片序列，可以先从当前字幕或高光加入第一段。",
      status: clipMarks.length ? "done" : "todo",
      actionLabel: clipMarks.length ? undefined : "加入当前字幕",
      disabled: !canEdit || savingClip || !rows.length,
      onAction: clipMarks.length ? undefined : addActiveCaptionToSequence,
    },
    {
      id: "copy",
      label: "片段文案",
      message: !clipMarks.length ? "先搭建序列，再补齐标题、备注和引用。" : copyableClipCount ? `${copyableClipCount} 段缺少标题、备注或引用。` : "标题、备注和引用都已补齐。",
      status: !clipMarks.length ? "todo" : copyableClipCount ? "warn" : "done",
      actionLabel: copyableClipCount ? "补齐文案" : undefined,
      disabled: !copyableClipCount || Boolean(updatingClipId) || Boolean(bulkUpdatingStatus),
      onAction: copyableClipCount ? fillClipCopyInSequence : undefined,
    },
    {
      id: "review",
      label: "审片确认",
      message: clipMarks.length ? `${approvedClipMarks.length}/${clipMarks.length} 段已确认，交付版建议只导出确认片段。` : "序列为空，先加入片段再进入审片。",
      status: !clipMarks.length ? "todo" : approvedClipMarks.length === clipMarks.length ? "done" : "warn",
      actionLabel: clipMarks.length ? (unapprovedClipMarks.length ? "继续审片" : "复看成片") : undefined,
      disabled: !hasMedia || !clipMarks.length,
      onAction: clipMarks.length ? playUnapprovedReviewQueue : undefined,
    },
    {
      id: "export",
      label: "导出交付",
      message: exportedSequenceCount
        ? `已有 ${exportedSequenceCount} 个成片 MP4，可复制交付稿。`
        : exportBlockers.length
          ? `${exportBlockers.length} 个阻塞项会影响导出，先看预检。`
          : "预检没有阻塞项，可以生成交付视频。",
      status: exportedSequenceCount ? "done" : exportBlockers.length ? "todo" : "warn",
      actionLabel: exportedSequenceCount ? "再导一版" : exportBlockers.length ? "查看预检" : approvedClipMarks.length ? "导出已确认" : "打开导出",
      onAction: () => openExportDialog(approvedClipMarks.length ? "approved" : "all"),
    },
  ];

  return (
    <section id="clip-workspace" className={`clip-workspace ${exportDialogOpen ? "export-open" : ""}`}>
      <div className="clip-heading">
        <div>
          <h2>剪辑工作台</h2>
          <p>{ready ? (hasMedia ? "当前视频、中文字幕和打点工具已就绪。" : "已有字幕，但还缺少本地视频文件。") : "下载翻译完成后，这里会出现播放器、字幕和剪辑打点。"}</p>
        </div>
        <div className="export-actions">
          <details className="secondary-export-menu">
            <summary>
              更多导出
              <CaretDown size={14} />
            </summary>
            <div className="secondary-export-list">
              <a className={!ready ? "disabled" : ""} href={ready ? `/api/videos/${video.id}/export?format=vtt&language=zh` : undefined}>
                <Subtitles size={16} />
                字幕 VTT
              </a>
              <a className={!ready ? "disabled" : ""} href={ready ? `/api/videos/${video.id}/export?format=srt&language=zh` : undefined}>
                <FileArrowDown size={16} />
                字幕 SRT
              </a>
              <a className={!clipMarks.length ? "disabled" : ""} href={clipMarks.length ? `/api/videos/${video.id}/export?format=csv` : undefined}>
                <Scissors size={16} />
                剪辑表 CSV
              </a>
            </div>
          </details>
        </div>
      </div>

      <div className="active-video-card">
        <Thumbnail className="active-thumb" url={video.thumbnail_url} />
        <div className="active-video-main">
          <div className="active-video-title">
            <span>当前剪辑视频</span>
            <StatusBadge status={processing ? "running" : video.status} />
          </div>
          <h3>{video.title}</h3>
          <div className="row-meta compact">
            <span>{platformLabel(video.platform)}</span>
            <span>{video.channel_title || "未知来源"}</span>
            <span>{formatDate(video.published_at)}</span>
            <span>{formatDuration(video.duration_seconds)}</span>
            <span>{rows.length ? `${rows.length} 条字幕` : "暂无字幕"}</span>
            <span>{hasMedia ? "本地视频已就绪" : "未下载本地视频"}</span>
          </div>
        </div>
        <div className="active-video-actions">
          <a href={video.url} target="_blank" rel="noreferrer">
            <ArrowSquareOut size={16} />
            原始链接
          </a>
          <button onClick={() => onReprocessSubtitles(video)} disabled={processing || !rows.length} title="使用本地已有字幕重新清理和翻译，不下载视频">
            {processing ? <SpinnerGap size={16} className="spin" /> : <ArrowCounterClockwise size={16} />}
            重新处理字幕
          </button>
          <button onClick={() => onDownloadTranslate(video)} disabled={processing}>
            {processing ? <SpinnerGap size={16} className="spin" /> : <DownloadSimple size={16} />}
            {hasMedia ? "重新下载" : "下载视频"}
          </button>
        </div>
      </div>

      {renderJob && isActiveJobStatus(renderJob.status) && (
        <div className="render-job-progress" role="status">
          <div className="render-job-message">
            <span>
              <SpinnerGap size={16} className="spin" />
              正在后台导出序列视频
            </span>
            <strong>{renderJob.message}</strong>
          </div>
          <JobProgress job={renderJob} />
        </div>
      )}

      <div className="workflow-intro">
        <div>
          <strong>按下面 3 步完成粗剪</strong>
          <span>从上往下操作：选片段、排顺序、导出成片。</span>
        </div>
        <button className="advanced-tools-toggle" type="button" aria-expanded={advancedToolsOpen} onClick={() => setAdvancedToolsOpen((open) => !open)}>
          {advancedToolsOpen ? <CaretUp size={15} /> : <CaretDown size={15} />}
          {advancedToolsOpen ? "收起工具" : "更多工具"}
        </button>
      </div>

      {advancedToolsOpen && (
        <div className="advanced-tools-panel">
          <ClipCommandCenter
            canEdit={canEdit}
            clipMarks={clipMarks}
            currentTime={currentTime}
            exportChecks={exportPreflightChecks}
            hasMedia={hasMedia}
            ready={ready}
            rowsCount={rows.length}
            saving={savingClip}
            selectionEnd={Number(form.end_seconds)}
            selectionStart={Number(form.start_seconds)}
            sequenceDuration={sequenceDuration}
            suggestionsCount={suggestions.length}
            onApplyActiveCaption={applyActiveCaption}
            onApplyPreset={applyPresetFromPlayhead}
            onJumpCaption={jumpCaption}
            onOpenExport={() => openExportDialog()}
            onSetStart={() => setPointFromPlayhead("start_seconds")}
            onFinishSelection={finishSelectionAtPlayhead}
          />
          <DeliveryChecklistPanel items={deliveryChecklistItems} />
        </div>
      )}

      <div className="clip-grid">
        <section className={`workflow-step-section ${clipMarks.length ? "complete" : "current"}`}>
          <header className="workflow-step-heading">
            <span>第一步</span>
            <div>
              <h3>选择要保留的片段</h3>
              <p>播放视频或阅读字幕，选中一句或多句后点击“加入选区”；也可以直接加入推荐高光。</p>
            </div>
            <strong>{clipMarks.length ? `已选 ${clipMarks.length} 段` : "请先选择片段"}</strong>
          </header>
          <div className="source-selection-grid">
            <div className="player-panel">
          {clip?.media_url ? (
            <>
              <video
                controls
                ref={videoRef}
                src={clip.media_url}
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration || 0;
                  const restoredTime = clamp(currentTime, 0, duration || currentTime);
                  event.currentTarget.currentTime = restoredTime;
                  setMediaDuration(duration);
                  setCurrentTime(restoredTime);
                  window.setTimeout(showChineseTextTrack, 0);
                }}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
                onSeeking={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
                onPause={() => {
                  if (reviewingClipId) setReviewingClipId(null);
                  if (draftPreviewRange) setDraftPreviewRange(null);
                }}
                onTimeUpdate={handleVideoTimeUpdate}
              >
                {ready && hasChineseTranscript && (
                  <track
                    default
                    kind="subtitles"
                    label="中文字幕"
                    src={`/api/videos/${video.id}/export?format=vtt&language=zh&disposition=inline`}
                    srcLang="zh-Hans"
                  />
                )}
              </video>
              <ClipTimeline
                currentTime={currentTime}
                duration={timelineDuration}
                marks={clipMarks}
                suggestions={suggestions}
                selectionStart={Number(form.start_seconds)}
                selectionEnd={Number(form.end_seconds)}
                onSeek={seekTo}
                onPreviewSuggestion={(suggestion) => seekTo(suggestion.start)}
              />
              {advancedToolsOpen && <SequenceReviewPanel
                currentTime={currentTime}
                marks={clipMarks}
                reviewingClipId={reviewingClipId}
                savingId={updatingClipId}
                onNext={() => jumpSequenceReview(1)}
                onExportApproved={() => openExportDialog("approved")}
                onPlayAll={() => void playSequenceClip(0)}
                onPlayPending={playUnapprovedReviewQueue}
                onPreview={(index) => void playSequenceClip(index)}
                onPrevious={() => jumpSequenceReview(-1)}
                onApproveAndNext={approveClipAndContinue}
                onSetStatus={setClipStatusInSequence}
                onStop={() => stopSequenceReview(true)}
              />}
              <div className="transport-panel">
                <div>
                  <span>当前播放</span>
                  <strong>
                    {formatTimecode(currentTime)} / {formatTimecode(timelineDuration)}
                  </strong>
                </div>
                <div className="transport-actions">
                  <button type="button" onClick={() => nudgePlayhead(-5)}>
                    -5 秒
                  </button>
                  <button type="button" onClick={() => nudgePlayhead(5)}>
                    +5 秒
                  </button>
                  <button className="wide-action" type="button" onClick={() => setPointFromPlayhead("start_seconds")}>
                    设为开始
                  </button>
                  <button className="primary wide-action" type="button" onClick={finishSelectionAtPlayhead} disabled={!canEdit || savingClip}>
                    {savingClip ? "加入中" : "设为结束并加入序列"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className={`video-placeholder ${isDemoMode ? "demo-video-placeholder" : ""}`}>
              {isDemoMode ? (
                <>
                  <Thumbnail className="demo-video-thumb" url={video.thumbnail_url} />
                  <strong>体验版样例时间线</strong>
                  <span>Pages 不加载或上传真实视频；字幕、选区、序列和导出设置仍可完整操作。</span>
                </>
              ) : (
                <>
                  <PlayCircle size={34} />
                  <strong>{ready ? "缺少本地视频文件" : "等待本地视频"}</strong>
                  <span>{ready ? "这条视频已有字幕，但还没有下载到本地，无法在工作台内预览画面。" : "点击“下载视频”后，系统会同时准备可用字幕。"}</span>
                  <div className="placeholder-actions">
                    <button className="primary" onClick={() => onDownloadTranslate(video)} disabled={processing}>
                      {processing ? <SpinnerGap size={16} className="spin" /> : <DownloadSimple size={16} />}
                      {processing ? "处理中" : "下载视频"}
                    </button>
                    <a href={video.url} target="_blank" rel="noreferrer">
                      打开原始链接
                    </a>
                  </div>
                </>
              )}
            </div>
          )}
          <HighlightPanel addableCount={addableSuggestionCount} suggestions={suggestions} onAdd={addSuggestionToSequence} onAddAll={addAllSuggestionsToSequence} onSeek={seekTo} saving={savingClip} />
          {advancedToolsOpen && <div className="manual-clip-panel">
            <div className="manual-clip-head">
              <div>
                <h3>手动片段</h3>
                <p>需要精确改秒数时使用；推荐高光可以直接加入序列。</p>
              </div>
              <strong>
                {formatTimecode(Number(form.start_seconds))} - {formatTimecode(Number(form.end_seconds))}
              </strong>
            </div>
            <form className="manual-clip-form" onSubmit={submitClip}>
              <label>
                入点
                <input value={form.start_seconds} onChange={(event) => setForm({ ...form, start_seconds: event.target.value })} inputMode="decimal" />
              </label>
              <label>
                出点
                <input value={form.end_seconds} onChange={(event) => setForm({ ...form, end_seconds: event.target.value })} inputMode="decimal" />
              </label>
              <label className="span-2">
                标签
                <input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
              </label>
              <label className="span-2">
                备注
                <textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
              </label>
              <div className={`manual-clip-validation span-2 ${manualClipValidation.severity}`} aria-live="polite">
                {manualClipValidation.message}
              </div>
              <button className="primary span-2" disabled={!canSubmitManualClip}>
                {savingClip ? <SpinnerGap size={16} className="spin" /> : <PlusCircle size={16} />}
                {canEdit ? "加入剪辑序列" : "等待字幕就绪"}
              </button>
            </form>
          </div>}
            </div>

            <div className="transcript-panel">
          <div className="transcript-head">
            <div>
              <h3>双语字幕</h3>
              <span>{rows.length ? `已显示 ${renderedTranscriptRows.length}/${visibleTranscriptRows.length} · 共 ${rows.length} 段` : "等待生成"}</span>
            </div>
            <label className="transcript-search" aria-label="筛选字幕">
              <MagnifyingGlass size={15} />
              <input value={transcriptSearch} onChange={(event) => setTranscriptSearch(event.target.value)} placeholder="筛选字幕内容" />
            </label>
          </div>
          {rows.length > 0 && (
            <div className={`transcript-selection-bar ${selectedTranscriptRange ? "active" : ""}`}>
              <div>
                <span>字幕选区</span>
                <strong>
                  {selectedTranscriptRange
                    ? `${selectedTranscriptRange.count} 句 · ${formatTimecode(selectedTranscriptRange.start)} - ${formatTimecode(selectedTranscriptRange.end)}`
                    : "未选择"}
                </strong>
              </div>
              <div className="transcript-selection-actions">
                <button type="button" onClick={() => adjustTranscriptRange(-1)} disabled={!rows.length}>
                  前一句
                </button>
                <button type="button" onClick={() => adjustTranscriptRange(1)} disabled={!rows.length}>
                  后一句
                </button>
                <button className="primary" type="button" onClick={addTranscriptRangeToSequence} disabled={!canEdit || savingClip || !selectedTranscriptRange}>
                  {savingClip ? "加入中" : "加入选区"}
                </button>
                <button type="button" onClick={clearTranscriptRange} disabled={!selectedTranscriptRange}>
                  清除
                </button>
              </div>
            </div>
          )}
          <div className="transcript-list">
            {visibleTranscriptRows.length ? (
              <>
                {renderedTranscriptRows.map(({ row, index }) => {
                  const selected = Boolean(selectedTranscriptRange && index >= selectedTranscriptRange.startIndex && index <= selectedTranscriptRange.endIndex);
                  const className = [
                    "transcript-row",
                    index === activeTranscriptIndex ? "active" : "",
                    selected ? "selected" : "",
                    selectedTranscriptRange?.startIndex === index ? "range-start" : "",
                    selectedTranscriptRange?.endIndex === index ? "range-end" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button
                      aria-pressed={selected}
                      className={className}
                      key={`${row.start}-${index}`}
                      onClick={(event) => selectTranscriptRange(index, event.shiftKey)}
                      ref={index === activeTranscriptIndex ? (node) => {
                        activeCaptionRef.current = node;
                      } : undefined}
                    >
                      <span className="timecode">{formatTimecode(row.start)}</span>
                      <span>
                        <strong>{row.zh?.text || "暂无中文字幕"}</strong>
                        {row.en?.text && <small>{row.en.text}</small>}
                      </span>
                    </button>
                  );
                })}
                {renderedTranscriptRows.length < visibleTranscriptRows.length && (
                  <button
                    className="transcript-load-more"
                    type="button"
                    onClick={() => setTranscriptRenderLimit((current) => current + 120)}
                  >
                    显示更多字幕 · 还剩 {visibleTranscriptRows.length - renderedTranscriptRows.length} 条
                  </button>
                )}
              </>
            ) : (
              <div className="transcript-empty">{rows.length ? "没有匹配的字幕段。" : "下载视频并完成字幕准备后，中文字幕会在这里逐段显示。"}</div>
            )}
          </div>
            </div>
          </div>
        </section>

        <section className={`workflow-step-section ${clipMarks.length ? "current" : "locked"}`}>
          <header className="workflow-step-heading">
            <span>第二步</span>
            <div>
              <h3>排列成片顺序</h3>
              <p>用上下移动调整播放顺序，点击预览检查内容，不需要的片段直接移除。</p>
            </div>
            <strong>{clipMarks.length ? `${clipMarks.length} 段 · ${formatDuration(sequenceDuration)}` : "等待第一步"}</strong>
          </header>
          <ClipSequence
            simple={!advancedToolsOpen}
            currentTime={currentTime}
            duration={timelineDuration}
            focusRequest={sequenceFocusRequest}
            marks={clipMarks}
            recentlyDeletedClip={recentlyDeletedClip}
            reorderingId={reorderingClipId}
            restoringDeleted={restoringDeletedClip}
            bulkStatus={bulkUpdatingStatus}
            copyableClipCount={copyableClipCount}
            savingId={updatingClipId}
            savingNew={savingClip}
            transcriptRows={rows}
            onBulkStatus={setAllClipStatusesInSequence}
            onBulkCopy={fillClipCopyInSequence}
            onDismissDeleted={() => setRecentlyDeletedClip(null)}
            onDelete={removeFromSequence}
            onDuplicate={duplicateClipInSequence}
            onMove={moveClipInSequence}
            onPreviewRange={previewDraftRange}
            onReorder={reorderClipSequence}
            onRestoreDeleted={restoreDeletedClip}
            onSeek={seekTo}
            onUpdate={updateClipInSequence}
          />
        </section>

        <section className={`workflow-step-section export-step ${exportedSequenceCount ? "complete" : clipMarks.length ? "current" : "locked"}`}>
          <header className="workflow-step-heading">
            <span>第三步</span>
            <div>
              <h3>导出成片</h3>
              <p>确认片段和顺序后生成 MP4；画幅、字幕样式等选项会在导出窗口中设置。</p>
            </div>
            <strong>{exportedSequenceCount ? `已有 ${exportedSequenceCount} 个成片` : clipMarks.length ? "可以导出" : "等待第二步"}</strong>
          </header>
          <div className="export-step-action">
            <div>
              <strong>{clipMarks.length ? `将按当前顺序导出 ${clipMarks.length} 个片段` : "序列中还没有片段"}</strong>
              <span>{clipMarks.length ? `预计成片长度 ${formatDuration(sequenceDuration)}` : "先在第一步加入至少一个片段。"}</span>
            </div>
            <button className="primary" onClick={() => setExportDialogOpen(true)} disabled={!hasMedia || !clipMarks.length || rendering}>
              {rendering ? <SpinnerGap size={16} className="spin" /> : <FileArrowDown size={16} />}
              {rendering ? "导出中" : "导出序列视频"}
            </button>
          </div>
          <ExportResult result={renderResult} summary={deliverySummary} onCopyBrief={copyDeliveryBrief} />
          {advancedToolsOpen && <ExportedAssetsPanel assets={clip?.media_assets ?? []} />}
          {advancedToolsOpen && <DeliveryBriefPanel
            brief={deliveryBrief}
            marksCount={clipMarks.length}
            nextStep={deliveryNextStep}
            nextStepDisabled={deliveryNextStepDisabled}
            summary={deliverySummary}
            onCopy={copyDeliveryBrief}
            onNextStep={runDeliveryNextStep}
          />}
        </section>
      </div>
      {exportDialogOpen && (
        <div className="export-modal-backdrop" role="presentation">
          <div className="export-modal" role="dialog" aria-modal="true" aria-label="导出序列视频">
            <div className="export-modal-head">
              <div>
                <h3>导出序列视频</h3>
                <p>选择最终 MP4 的保存位置。系统会同时保留工作台内的预览文件。</p>
              </div>
              <button className="ghost-action" type="button" onClick={() => setExportDialogOpen(false)} disabled={rendering}>
                取消
              </button>
            </div>
            <div className="export-option-section">
              <div className="export-option-head">
                <h4>成片规格</h4>
                <strong>{outputProfileLabel(exportOptions.output_profile)}</strong>
              </div>
              <div className="export-profile-grid" aria-label="成片规格">
                {OUTPUT_PROFILE_PRESETS.map((preset) => (
                  <button
                    className={`export-profile-choice ${exportOptions.output_profile === preset.value ? "active" : ""}`}
                    key={preset.value}
                    type="button"
                    onClick={() => setExportOptions({ ...exportOptions, output_profile: preset.value })}
                  >
                    {preset.label}
                    <span>{preset.detail}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="export-option-section">
              <div className="export-option-head">
                <h4>中文字幕</h4>
                <strong>{subtitlePositionLabel(exportOptions.subtitle_position)}</strong>
              </div>
              <div className="export-subtitle-grid" aria-label="字幕模板">
                {SUBTITLE_STYLE_PRESETS.map((preset) => (
                  <button
                    className={`export-subtitle-choice ${exportOptions.subtitle_style === preset.value ? "active" : ""}`}
                    key={preset.value}
                    type="button"
                    onClick={() => setExportOptions({ ...exportOptions, subtitle_style: preset.value })}
                  >
                    {preset.label}
                    <span>{preset.detail}</span>
                  </button>
                ))}
              </div>
              <label className="export-select-field">
                字幕位置
                <select
                  value={exportOptions.subtitle_position}
                  disabled={exportOptions.subtitle_style === "none"}
                  onChange={(event) => setExportOptions({ ...exportOptions, subtitle_position: event.target.value as ClipRenderOptions["subtitle_position"] })}
                >
                  <option value="bottom">底部安全区</option>
                  <option value="lower_third">中下安全区</option>
                </select>
              </label>
            </div>
            <div className="export-save-grid">
              <button
                className={`export-save-choice ${exportOptions.destination === "downloads" ? "active" : ""}`}
                type="button"
                onClick={() => setExportOptions({ ...exportOptions, destination: "downloads" })}
              >
                下载文件夹
                <span>~/Downloads/Topic Workbench Clips</span>
              </button>
              <button
                className={`export-save-choice ${exportOptions.destination === "desktop" ? "active" : ""}`}
                type="button"
                onClick={() => setExportOptions({ ...exportOptions, destination: "desktop" })}
              >
                桌面
                <span>~/Desktop/Topic Workbench Clips</span>
              </button>
              <button
                className={`export-save-choice ${exportOptions.destination === "custom" ? "active" : ""}`}
                type="button"
                onClick={() => setExportOptions({ ...exportOptions, destination: "custom" })}
              >
                自定义路径
                <span>例如 ~/Movies/PR Clips</span>
              </button>
            </div>
            {exportOptions.destination === "custom" && (
              <label className="export-field">
                保存文件夹路径
                <input
                  value={exportOptions.output_dir}
                  onChange={(event) => setExportOptions({ ...exportOptions, output_dir: event.target.value })}
                  placeholder="~/Movies/PR Clips"
                />
              </label>
            )}
            <label className="export-field">
              文件名
              <input
                value={exportOptions.filename}
                onChange={(event) => setExportOptions({ ...exportOptions, filename: event.target.value })}
                placeholder={video ? defaultExportFilename(video.title) : "clip-sequence.mp4"}
              />
            </label>
            <div className="export-ready-summary">
              <ExportPreflightSummary checks={exportPreflightChecks} />
              <span>{exportBlockers.length ? "需要先处理阻塞项。" : "设置完成，可以直接导出。"}</span>
            </div>
            <details className="export-advanced-settings">
              <summary>
                <span>
                  <strong>高级设置与导出检查</strong>
                  <small>裁切、Logo、范围、时长版本和完整预检</small>
                </span>
                <CaretDown size={16} />
              </summary>
              <div className="export-advanced-content">
                {exportOptions.output_profile !== "source" && (
                  <div className="export-option-section">
                    <div className="export-option-head">
                      <h4>画面适配</h4>
                      <strong>{exportOptions.fit_mode === "crop" ? "裁切填满" : "完整画面"}</strong>
                    </div>
                    <div className="export-fit-grid" aria-label="画面适配">
                      {FIT_MODE_PRESETS.map((preset) => (
                        <button
                          className={`export-fit-choice ${exportOptions.fit_mode === preset.value ? "active" : ""}`}
                          key={preset.value}
                          type="button"
                          onClick={() => setExportOptions({ ...exportOptions, fit_mode: preset.value })}
                        >
                          {preset.label}
                          <span>{preset.detail}</span>
                        </button>
                      ))}
                    </div>
                    {exportOptions.fit_mode === "crop" && (
                      <label className="export-focus-control">
                        <span>主体横向位置</span>
                        <input aria-label="主体横向位置" type="range" min="0" max="100" step="1" value={exportOptions.focus_x} onChange={(event) => setExportOptions({ ...exportOptions, focus_x: Number(event.target.value) })} />
                        <strong>{Math.round(exportOptions.focus_x)}%</strong>
                      </label>
                    )}
                  </div>
                )}
                <div className="export-option-section">
                  <div className="export-option-head">
                    <h4>品牌 Logo</h4>
                    <strong>{selectedBrandLogo ? "已启用" : "未启用"}</strong>
                  </div>
                  <div className="export-brand-row">
                    <div className="brand-logo-preview">{latestBrandLogo?.url ? <img src={latestBrandLogo.url} alt="品牌 Logo" /> : <span>LOGO</span>}</div>
                    <div className="export-brand-controls">
                      <button className="logo-upload-button" type="button" disabled={uploadingLogo || rendering} onClick={() => logoInputRef.current?.click()}>
                        {uploadingLogo ? <SpinnerGap size={16} className="spin" /> : <UploadSimple size={16} />}
                        {uploadingLogo ? "上传中" : latestBrandLogo ? "替换 Logo" : "上传 Logo"}
                      </button>
                      <input ref={logoInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadingLogo || rendering} onChange={uploadBrandLogo} />
                      <label className="export-toggle">
                        <input type="checkbox" checked={Boolean(exportOptions.logo_asset_id)} disabled={!latestBrandLogo || uploadingLogo} onChange={(event) => setExportOptions({ ...exportOptions, logo_asset_id: event.target.checked ? latestBrandLogo?.id ?? null : null })} />
                        叠加到成片
                      </label>
                      <label className="export-select-field compact">
                        位置
                        <select value={exportOptions.logo_position} disabled={!exportOptions.logo_asset_id} onChange={(event) => setExportOptions({ ...exportOptions, logo_position: event.target.value as ClipRenderOptions["logo_position"] })}>
                          <option value="top_right">右上</option>
                          <option value="top_left">左上</option>
                          <option value="bottom_right">右下</option>
                          <option value="bottom_left">左下</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </div>
                <div className="export-option-section">
                  <div className="export-option-head"><h4>导出范围</h4></div>
                  <div className="export-scope-grid" aria-label="导出范围">
                    {EXPORT_SCOPE_PRESETS.map((preset) => {
                      const count = preset.value === "approved" ? approvedClipMarks.length : clipMarks.length;
                      return <button className={`export-scope-choice ${exportOptions.clip_status_filter === preset.value ? "active" : ""}`} key={preset.value} type="button" onClick={() => setExportOptions({ ...exportOptions, clip_status_filter: preset.value })}>{preset.label}<span>{preset.value === "approved" ? `${count} 段已确认` : `${count} 段当前序列`}</span></button>;
                    })}
                  </div>
                  <div className="export-version-grid" aria-label="导出版本">
                    {EXPORT_VERSION_PRESETS.map((preset) => <button className={`export-version-choice ${exportOptions.target_duration_seconds === preset.target ? "active" : ""}`} key={preset.target} type="button" onClick={() => setExportOptions({ ...exportOptions, target_duration_seconds: preset.target })}>{preset.label}<span>{preset.detail}</span></button>)}
                  </div>
                </div>
                <ExportPreflightPanel actions={preflightActions} checks={exportPreflightChecks} />
              </div>
            </details>
            <div className="export-modal-actions">
              <button type="button" onClick={() => setExportDialogOpen(false)} disabled={rendering}>
                取消
              </button>
              <button className="primary" type="button" onClick={renderSavedClips} disabled={rendering || exportBlockers.length > 0}>
                {rendering ? <SpinnerGap size={16} className="spin" /> : <FileArrowDown size={16} />}
                {rendering ? "导出中" : "导出并保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ClipCommandCenter({
  canEdit,
  clipMarks,
  currentTime,
  exportChecks,
  hasMedia,
  ready,
  rowsCount,
  saving,
  selectionEnd,
  selectionStart,
  sequenceDuration,
  suggestionsCount,
  onApplyActiveCaption,
  onApplyPreset,
  onFinishSelection,
  onJumpCaption,
  onOpenExport,
  onSetStart,
}: {
  canEdit: boolean;
  clipMarks: ClipMark[];
  currentTime: number;
  exportChecks: ExportPreflightCheck[];
  hasMedia: boolean;
  ready: boolean;
  rowsCount: number;
  saving: boolean;
  selectionEnd: number;
  selectionStart: number;
  sequenceDuration: number;
  suggestionsCount: number;
  onApplyActiveCaption: () => void;
  onApplyPreset: (seconds: number) => void;
  onFinishSelection: () => void;
  onJumpCaption: (direction: -1 | 1) => void;
  onOpenExport: () => void;
  onSetStart: () => void;
}) {
  const safeStart = Math.max(selectionStart || 0, 0);
  const safeEnd = Math.max(selectionEnd || 0, safeStart);
  const selectionDuration = Math.max(safeEnd - safeStart, 0);
  const exportReady = hasMedia && clipMarks.length > 0;
  return (
    <section className="clip-command-center" aria-label="剪辑控制台">
      <div className="clip-command-meter">
        <span>当前选区</span>
        <strong>
          {formatTimecode(safeStart)} - {formatTimecode(safeEnd)}
        </strong>
        <small>{formatDuration(selectionDuration)}</small>
      </div>
      <div className="clip-command-meter">
        <span>序列总长</span>
        <strong>{formatDuration(sequenceDuration)}</strong>
        <small>{clipMarks.length} 段</small>
      </div>
      <div className="readiness-grid">
        <ReadinessCheck label="本地视频" ok={hasMedia} />
        <ReadinessCheck label="中文字幕" ok={rowsCount > 0 && ready} />
        <ReadinessCheck label="剪辑序列" ok={clipMarks.length > 0} />
        <ReadinessCheck label="可导出" ok={exportReady} />
      </div>
      <div className="clip-command-actions">
        <button type="button" onClick={() => onJumpCaption(-1)} disabled={!rowsCount}>
          上一字幕
        </button>
        <button type="button" onClick={() => onJumpCaption(1)} disabled={!rowsCount}>
          下一字幕
        </button>
        <button type="button" onClick={onApplyActiveCaption} disabled={!rowsCount}>
          当前字幕
        </button>
        <button type="button" onClick={() => onApplyPreset(15)} disabled={!hasMedia}>
          15 秒片段
        </button>
        <button type="button" onClick={() => onApplyPreset(30)} disabled={!hasMedia}>
          30 秒片段
        </button>
        <button type="button" onClick={onSetStart} disabled={!hasMedia}>
          设入点
        </button>
        <button className="primary" type="button" onClick={onFinishSelection} disabled={!canEdit || saving}>
          {saving ? "加入中" : "加入序列"}
        </button>
        <button className="export-command" type="button" onClick={onOpenExport} disabled={!exportReady || saving}>
          导出序列
        </button>
      </div>
      <div className="command-insight">
        <ExportPreflightSummary checks={exportChecks} />
        <span>{suggestionsCount ? `${suggestionsCount} 个推荐高光` : "暂无推荐高光"}</span>
        <span>{formatTimecode(currentTime)} 播放位置</span>
      </div>
    </section>
  );
}

function DeliveryChecklistPanel({ items }: { items: DeliveryChecklistItem[] }) {
  const doneCount = items.filter((item) => item.status === "done").length;
  const headline = doneCount === items.length ? "交付就绪" : `交付进度 ${doneCount}/${items.length}`;
  return (
    <section className="delivery-checklist-panel" aria-label="交付前检查清单">
      <div className="delivery-checklist-head">
        <div>
          <strong>{headline}</strong>
          <span>按顺序处理素材、序列、审片和导出</span>
        </div>
      </div>
      <div className="delivery-checklist-items">
        {items.map((item) => (
          <div className={`delivery-checklist-item ${item.status}`} key={item.id}>
            <span className="delivery-check-icon">
              {item.status === "done" ? <CheckCircle size={15} weight="fill" /> : item.status === "warn" ? <WarningCircle size={15} /> : <Clock size={15} />}
            </span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.message}</p>
            </div>
            {item.actionLabel && (
              <button type="button" onClick={() => void item.onAction?.()} disabled={item.disabled}>
                {item.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ExportPreflightSummary({ checks }: { checks: ExportPreflightCheck[] }) {
  const blockers = checks.filter((check) => check.severity === "block").length;
  const warnings = checks.filter((check) => check.severity === "warn").length;
  const ready = checks.length - blockers - warnings;
  const status = blockers ? "block" : warnings ? "warn" : "ready";
  return (
    <span className={`preflight-summary ${status}`}>
      {status === "ready" ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} />}
      导出预检 {ready}/{checks.length} 通过
      {blockers ? ` · ${blockers} 项需处理` : warnings ? ` · ${warnings} 项风险` : ""}
    </span>
  );
}

function ExportPreflightPanel({ actions = {}, checks }: { actions?: ExportPreflightActions; checks: ExportPreflightCheck[] }) {
  const blockers = checks.filter((check) => check.severity === "block").length;
  const warnings = checks.filter((check) => check.severity === "warn").length;
  return (
    <section className="export-preflight-panel" aria-label="导出前预检">
      <div className="export-preflight-head">
        <div>
          <h4>导出前预检</h4>
          <p>{blockers ? "先处理阻塞项，避免导出失败。" : warnings ? "可以导出，但建议先复核风险项。" : "序列已经满足导出条件。"}</p>
        </div>
        <strong className={blockers ? "block" : warnings ? "warn" : "ready"}>{blockers ? `${blockers} 阻塞` : warnings ? `${warnings} 风险` : "可导出"}</strong>
      </div>
      <div className="export-preflight-list">
        {checks.map((check) => {
          const action = check.severity === "ready" ? undefined : actions[check.id];
          return (
            <div className={`export-preflight-item ${check.severity}`} key={check.id}>
              <span>{check.severity === "ready" ? <CheckCircle size={15} weight="fill" /> : <WarningCircle size={15} />}</span>
              <div>
                <strong>{check.label}</strong>
                <p>{check.message}</p>
                {action && (
                  <button type="button" onClick={() => void action.onAction()} disabled={action.disabled}>
                    {action.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReadinessCheck({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={`readiness-check ${ok ? "ok" : ""}`}>
      {ok ? <CheckCircle size={14} weight="fill" /> : <Clock size={14} />}
      {label}
    </span>
  );
}

function SequenceReviewPanel({
  currentTime,
  marks,
  reviewingClipId,
  savingId,
  onNext,
  onExportApproved,
  onPlayAll,
  onPlayPending,
  onPreview,
  onPrevious,
  onApproveAndNext,
  onSetStatus,
  onStop,
}: {
  currentTime: number;
  marks: ClipMark[];
  reviewingClipId: number | null;
  savingId: number | null;
  onNext: () => void;
  onExportApproved: () => void;
  onPlayAll: () => void;
  onPlayPending: () => void;
  onPreview: (index: number) => void;
  onPrevious: () => void;
  onApproveAndNext: (mark: ClipMark, index: number) => void;
  onSetStatus: (mark: ClipMark, status: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const currentMarkIndex = reviewingClipId ? marks.findIndex((mark) => mark.id === reviewingClipId) : marks.findIndex((mark) => currentTime >= mark.start_seconds && currentTime <= mark.end_seconds);
  const activeMark = currentMarkIndex >= 0 ? marks[currentMarkIndex] : null;
  const approvedCount = marks.filter((mark) => mark.status === "approved").length;
  const pendingCount = marks.length - approvedCount;
  const allApproved = marks.length > 0 && pendingCount === 0;
  const reviewRunning = reviewingClipId !== null;
  const markDuration = activeMark ? Math.max(activeMark.end_seconds - activeMark.start_seconds, 0.1) : 1;
  const progress = activeMark ? clamp((currentTime - activeMark.start_seconds) / markDuration, 0, 1) : 0;
  const remaining = activeMark ? Math.max(activeMark.end_seconds - currentTime, 0) : 0;
  const activeSaving = activeMark ? savingId === activeMark.id : false;
  return (
    <section className={reviewRunning ? "sequence-review-panel running" : "sequence-review-panel"} aria-label="序列审片">
      <div className="sequence-review-head">
        <div>
          <span>{reviewRunning ? "正在审片" : "序列预览"} · {approvedCount}/{marks.length} 已确认</span>
          <strong>{activeMark ? `#${currentMarkIndex + 1} ${activeMark.label || "未命名片段"}` : marks.length ? "从第一段开始审片" : "还没有剪辑片段"}</strong>
          <small>{activeMark ? `${formatTimecode(activeMark.start_seconds)} - ${formatTimecode(activeMark.end_seconds)} · 剩余 ${formatDuration(remaining)}` : "加入片段后可连续预览成片节奏"}</small>
        </div>
        <div className="sequence-review-actions">
          <button type="button" onClick={onPrevious} disabled={!marks.length || currentMarkIndex <= 0}>
            上一段
          </button>
          <button type="button" onClick={onPlayPending} disabled={!pendingCount}>
            待确认
          </button>
          <button className="primary" type="button" onClick={onPlayAll} disabled={!marks.length}>
            <PlayCircle size={15} />
            {reviewRunning ? "从头审片" : "审片播放"}
          </button>
          <button type="button" onClick={onNext} disabled={!marks.length || currentMarkIndex === marks.length - 1}>
            下一段
          </button>
          <button type="button" onClick={onStop} disabled={!reviewRunning}>
            <X size={14} />
            停止
          </button>
        </div>
      </div>
      <div className="sequence-review-progress" aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      {allApproved && (
        <div className="sequence-review-complete">
          <div>
            <strong>全部片段已确认</strong>
            <span>可以直接导出只包含已确认片段的交付版。</span>
          </div>
          <button className="primary" type="button" onClick={onExportApproved}>
            <FileArrowDown size={14} />
            导出已确认
          </button>
        </div>
      )}
      {activeMark && (
        <div className="sequence-review-status">
          <div>
            <ClipStatusBadge status={activeMark.status} />
            <span>{activeSaving ? "正在保存状态" : "边看边确认，导出时可只取已确认片段"}</span>
          </div>
          <div className="sequence-review-status-actions" aria-label="当前片段审片状态">
            {CLIP_REVIEW_STATUSES.map((status) => (
              <button
                className={activeMark.status === status.value ? "active" : ""}
                disabled={activeSaving}
                key={status.value}
                type="button"
                onClick={() => void onSetStatus(activeMark, status.value)}
              >
                {activeSaving && activeMark.status !== status.value ? <SpinnerGap size={12} className="spin" /> : null}
                {status.label}
              </button>
            ))}
            <button
              className="approve-next"
              disabled={activeSaving}
              type="button"
              onClick={() => onApproveAndNext(activeMark, currentMarkIndex)}
            >
              {activeSaving ? <SpinnerGap size={12} className="spin" /> : <CheckCircle size={12} weight="fill" />}
              确认并下一段
            </button>
          </div>
        </div>
      )}
      {marks.length ? (
        <div className="sequence-review-strip" aria-label="审片片段列表">
          {marks.map((mark, index) => (
            <button
              className={[activeMark?.id === mark.id ? "active" : "", mark.status === "approved" ? "approved" : "", mark.status === "draft" ? "draft" : ""].filter(Boolean).join(" ")}
              key={mark.id}
              title={`${mark.label || `片段 ${index + 1}`} · ${clipStatusLabel(mark.status)} · ${formatTimecode(mark.start_seconds)} - ${formatTimecode(mark.end_seconds)}`}
              type="button"
              onClick={() => onPreview(index)}
            >
              <span>#{index + 1}</span>
              <strong>{formatDuration(mark.end_seconds - mark.start_seconds)}</strong>
            </button>
          ))}
        </div>
      ) : (
        <div className="sequence-review-empty">先从字幕、高光或手动选区加入片段，再预览完整节奏。</div>
      )}
    </section>
  );
}

function ClipTimeline({
  currentTime,
  duration,
  marks,
  suggestions,
  selectionStart,
  selectionEnd,
  onSeek,
  onPreviewSuggestion,
}: {
  currentTime: number;
  duration: number;
  marks: ClipMark[];
  suggestions: HighlightSuggestion[];
  selectionStart: number;
  selectionEnd: number;
  onSeek: (seconds: number) => void;
  onPreviewSuggestion: (suggestion: HighlightSuggestion) => void;
}) {
  const safeDuration = Math.max(duration, 1);
  const progress = (clamp(currentTime, 0, safeDuration) / safeDuration) * 100;
  const safeSelectionStart = clamp(Number.isFinite(selectionStart) ? selectionStart : 0, 0, safeDuration);
  const safeSelectionEnd = clamp(Number.isFinite(selectionEnd) ? selectionEnd : 0, 0, safeDuration);
  const selectionDuplicatesMark = marks.some((mark) => Math.abs(mark.start_seconds - safeSelectionStart) < 0.5 && Math.abs(mark.end_seconds - safeSelectionEnd) < 0.5);
  const hasSelection = safeSelectionEnd > safeSelectionStart && !selectionDuplicatesMark;
  const suggestionBands = buildTimelineBands(
    suggestions.map((suggestion, index) => ({
      key: suggestion.id,
      start: suggestion.start,
      end: suggestion.end,
      label: `高光${index + 1}`,
      title: `${suggestion.label} · ${formatTimecode(suggestion.start)} - ${formatTimecode(suggestion.end)}`,
      action: () => onPreviewSuggestion(suggestion),
    })),
    safeDuration,
  );
  const clipBands = buildTimelineBands(
    marks.map((mark, index) => ({
      key: String(mark.id),
      start: mark.start_seconds,
      end: mark.end_seconds,
      label: `剪辑${index + 1}`,
      title: `${mark.label || `剪辑${index + 1}`} · ${formatTimecode(mark.start_seconds)} - ${formatTimecode(mark.end_seconds)}`,
      action: () => onSeek(mark.start_seconds),
    })),
    safeDuration,
  );
  const laneHeight = 42;
  const topPadding = 24;
  const rowGap = 10;
  const suggestionTop = topPadding;
  const suggestionLaneCount = Math.max(1, suggestionBands.laneCount);
  const clipTop = suggestionTop + suggestionLaneCount * laneHeight + rowGap;
  const clipLaneCount = Math.max(1, clipBands.laneCount);
  const selectionTop = clipTop + clipLaneCount * laneHeight + rowGap;
  const stageHeight = selectionTop + (hasSelection ? laneHeight : 14) + topPadding;
  const selectionLeft = (safeSelectionStart / safeDuration) * 100;
  const selectionWidth = ((safeSelectionEnd - safeSelectionStart) / safeDuration) * 100;
  return (
    <div className="timeline-panel">
      <div className="timeline-head">
        <span>剪辑时间线</span>
        <strong>{hasSelection ? `当前选区 ${formatTimecode(safeSelectionStart)} - ${formatTimecode(safeSelectionEnd)}` : `${marks.length} 段剪辑 · ${suggestions.length} 个高光`}</strong>
      </div>
      <div className="timeline-track-wrap compact">
        <div className="timeline-stage" style={{ minHeight: `${stageHeight}px` }}>
          <span className="timeline-row-label" style={{ top: `${suggestionTop + 4}px` }}>
            高光建议
          </span>
          <span className="timeline-row-label" style={{ top: `${clipTop + 4}px` }}>
            剪辑序列
          </span>
          {suggestionBands.items.map((band) => (
            <button
              className="timeline-segment suggestion-segment"
              key={band.key}
              style={timelineBandStyle(band, suggestionTop + band.lane * laneHeight)}
              title={band.title}
              type="button"
              onClick={band.action}
            >
              <span>{band.label}</span>
            </button>
          ))}
          {clipBands.items.map((band) => (
            <button
              className="timeline-segment clip-segment"
              key={band.key}
              style={timelineBandStyle(band, clipTop + band.lane * laneHeight)}
              title={band.title}
              type="button"
              onClick={band.action}
            >
              <span>{band.label}</span>
            </button>
          ))}
          {!marks.length && <span className="timeline-empty-row" style={{ top: `${clipTop + 2}px` }}>还没有加入剪辑序列</span>}
          {hasSelection && (
            <button
              className="timeline-segment selection-segment"
              style={timelineBandStyle({ left: selectionLeft, width: selectionWidth }, selectionTop)}
              title={`当前选区 ${formatTimecode(safeSelectionStart)} - ${formatTimecode(safeSelectionEnd)}`}
              type="button"
              onClick={() => onSeek(safeSelectionStart)}
            >
              <span>当前选区</span>
            </button>
          )}
          <span className="timeline-playhead" style={{ "--left": progress / 100 } as CSSProperties} />
        </div>
        <input
          aria-label="拖动视频时间线"
          className="timeline-range"
          max={safeDuration}
          min={0}
          step={0.1}
          type="range"
          value={clamp(currentTime, 0, safeDuration)}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
        />
      </div>
      <div className="timeline-legend">
        <span>高光建议</span>
        <span>剪辑序列</span>
        <span>当前选区</span>
      </div>
    </div>
  );
}

function HighlightPanel({
  addableCount,
  suggestions,
  onAdd,
  onAddAll,
  onSeek,
  saving,
}: {
  addableCount: number;
  suggestions: HighlightSuggestion[];
  onAdd: (suggestion: HighlightSuggestion) => void;
  onAddAll: () => void;
  onSeek: (seconds: number) => void;
  saving: boolean;
}) {
  return (
    <div className="highlight-panel">
      <div className="transcript-head highlight-head">
        <div>
          <h3>推荐高光</h3>
          <span>{suggestions.length ? `${addableCount}/${suggestions.length} 可加入` : "等待字幕"}</span>
        </div>
        {suggestions.length ? (
          <button className="primary highlight-add-all" type="button" onClick={onAddAll} disabled={saving || !addableCount}>
            {saving ? <SpinnerGap size={14} className="spin" /> : <PlusCircle size={14} />}
            {saving ? "加入中" : "全部加入"}
          </button>
        ) : null}
      </div>
      {suggestions.length ? (
        <div className="highlight-list">
          {suggestions.map((suggestion) => (
            <article className="highlight-card" key={suggestion.id}>
              <div className="highlight-meta">
                <span>
                  {formatTimecode(suggestion.start)} - {formatTimecode(suggestion.end)}
                </span>
                <strong>{suggestion.label}</strong>
              </div>
              <p>{suggestion.quote || suggestion.reason}</p>
              <div className="highlight-actions">
                <button type="button" onClick={() => onSeek(suggestion.start)}>
                  预览
                </button>
                <button className="primary" type="button" onClick={() => onAdd(suggestion)} disabled={saving}>
                  {saving ? "保存中" : "加入序列"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="transcript-empty">下载翻译后，会根据字幕关键词、观点密度和时间跨度自动推荐高光。</div>
      )}
    </div>
  );
}

function ExportResult({ result, summary, onCopyBrief }: { result: ClipRenderResult | null; summary: ClipDeliverySummary | null; onCopyBrief: () => void }) {
  if (!result) return null;
  const handoffPrompt = summary ? buildClipDeliveryHandoffPrompt(summary) : null;
  return (
    <div className="export-result">
      <div>
        <div>
          <strong>序列视频已导出</strong>
          <span>{result.message}</span>
        </div>
        {handoffPrompt ? (
          <button className={`export-handoff-action ${handoffPrompt.tone}`} type="button" onClick={onCopyBrief}>
            <Copy size={14} />
            {handoffPrompt.label}
          </button>
        ) : null}
      </div>
      {handoffPrompt ? <p className={`export-handoff-note ${handoffPrompt.tone}`}>{handoffPrompt.message}</p> : null}
      <div className="export-result-stats">
        <span>范围：{result.clip_status_filter === "approved" ? "仅已确认" : "全部序列"}</span>
        <span>版本：{result.target_duration_seconds > 0 ? formatDuration(result.target_duration_seconds) : "完整序列"}</span>
        <span>实际：{formatDuration(result.rendered_duration_seconds)}</span>
      </div>
      {result.saved_path && (
        <div className="saved-path">
          <span>最终 MP4 保存到</span>
          <code>{result.saved_path}</code>
        </div>
      )}
      <div className="saved-path secondary">
        <span>工作台预览缓存</span>
        <code>{result.export_dir}</code>
      </div>
      {result.sequence_url && (
        <a className="sequence-link" href={result.sequence_url} target="_blank" rel="noreferrer">
          打开合成序列视频
        </a>
      )}
      <div className="exported-clips">
        {result.clips.map((clip) => (
          <a href={clip.url} key={clip.path} target="_blank" rel="noreferrer">
            {clip.label || "片段"} · {formatTimecode(clip.start_seconds)}
          </a>
        ))}
      </div>
    </div>
  );
}

function ExportedAssetsPanel({ assets }: { assets: MediaAsset[] }) {
  const exportedAssets = assets.filter((asset) => asset.kind === "exported_sequence" && asset.url).slice(0, 4);
  if (!exportedAssets.length) return null;
  return (
    <div className="exported-assets-panel">
      <div className="exported-assets-head">
        <div>
          <strong>最近导出</strong>
          <span>合成序列 MP4</span>
        </div>
        <span>{exportedAssets.length} 个文件</span>
      </div>
      <div className="exported-asset-list">
        {exportedAssets.map((asset) => (
          <a className="exported-asset-row" href={asset.url} key={asset.id} target="_blank" rel="noreferrer">
            <FileArrowDown size={17} />
            <div>
              <strong>{asset.original_filename || "sequence.mp4"}</strong>
              <span>
                {formatDate(asset.created_at)} · {statusLabel(asset.processing_status)}
              </span>
            </div>
            <ArrowSquareOut size={15} />
          </a>
        ))}
      </div>
    </div>
  );
}

function DeliveryBriefPanel({
  brief,
  marksCount,
  nextStep,
  nextStepDisabled,
  summary,
  onCopy,
  onNextStep,
}: {
  brief: string;
  marksCount: number;
  nextStep: ClipDeliveryNextStep | null;
  nextStepDisabled: boolean;
  summary: ClipDeliverySummary | null;
  onCopy: () => void;
  onNextStep: () => void;
}) {
  if (!marksCount || !summary) return null;
  const preview = brief.split("\n").filter(Boolean).slice(0, 5);
  return (
    <section className="delivery-brief-panel" aria-label="剪辑交付稿">
      <div className="delivery-brief-head">
        <div>
          <strong>交付稿</strong>
          <span>复制给发布、运营或客户复核</span>
        </div>
        <button className="primary" type="button" onClick={onCopy}>
          <Copy size={15} />
          复制
        </button>
      </div>
      <div className={`delivery-brief-status ${summary.isReady ? "ready" : "pending"}`}>
        <div>
          <span>{summary.isReady ? "可交付" : "待处理"}</span>
          <strong>{summary.statusLabel}</strong>
        </div>
        <div className="delivery-brief-metrics">
          <span>{summary.approvedCount}/{summary.marksCount} 已确认</span>
          <span>{summary.missingCopyCount} 段缺文案</span>
          <span>{summary.exportedUrls.length ? "成片已导出" : "待导出"}</span>
        </div>
        {nextStep ? (
          <button type="button" onClick={onNextStep} disabled={nextStepDisabled}>
            {nextStep.label}
          </button>
        ) : null}
      </div>
      <div className="delivery-brief-preview">
        {preview.map((line, index) => (
          <span key={`${line}-${index}`}>{line}</span>
        ))}
      </div>
      <textarea readOnly value={brief} aria-label="剪辑交付稿全文" />
    </section>
  );
}

function ClipStatusBadge({ status }: { status: string }) {
  const meta = clipStatusMeta(status);
  return <span className={`clip-status-badge ${meta.value}`}>{meta.label}</span>;
}

function ClipTrimEditor({
  currentTime,
  duration,
  end,
  start,
  onEndChange,
  onNudgeEnd,
  onNudgeStart,
  onShiftRange,
  onStartChange,
}: {
  currentTime: number;
  duration: number;
  end: number;
  start: number;
  onEndChange: (value: number) => void;
  onNudgeEnd: (offset: number) => void;
  onNudgeStart: (offset: number) => void;
  onShiftRange: (offset: number) => void;
  onStartChange: (value: number) => void;
}) {
  const safeDuration = Math.max(duration, 1);
  const safeStart = clamp(Number.isFinite(start) ? start : 0, 0, safeDuration);
  const safeEnd = clamp(Number.isFinite(end) ? end : safeStart + 0.1, safeStart + 0.1, safeDuration);
  const safeCurrent = clamp(Number.isFinite(currentTime) ? currentTime : 0, 0, safeDuration);
  const playheadLeft = (safeCurrent / safeDuration) * 100;
  const trimLeft = (safeStart / safeDuration) * 100;
  const trimWidth = ((safeEnd - safeStart) / safeDuration) * 100;
  return (
    <div className="clip-trim-editor">
      <div className="trim-editor-head">
        <span>可视化修剪</span>
        <strong>{formatDuration(safeEnd - safeStart)}</strong>
      </div>
      <div className="trim-rail" aria-hidden="true">
        <span className="trim-window" style={{ "--trim-left": `${trimLeft}%`, "--trim-width": `${trimWidth}%` } as CSSProperties} />
        <span className="trim-playhead" style={{ "--playhead-left": `${playheadLeft}%` } as CSSProperties} />
      </div>
      <div className="trim-sliders">
        <label>
          入点
          <input
            aria-label="调整入点"
            max={Math.max(safeEnd - 0.1, 0)}
            min={0}
            step={0.1}
            type="range"
            value={safeStart}
            onChange={(event) => onStartChange(Number(event.currentTarget.value))}
          />
          <small>{formatTimecode(safeStart)}</small>
        </label>
        <label>
          出点
          <input
            aria-label="调整出点"
            max={safeDuration}
            min={Math.min(safeStart + 0.1, safeDuration)}
            step={0.1}
            type="range"
            value={safeEnd}
            onChange={(event) => onEndChange(Number(event.currentTarget.value))}
          />
          <small>{formatTimecode(safeEnd)}</small>
        </label>
      </div>
      <div className="trim-nudges" aria-label="片段微调">
        <button type="button" onClick={() => onNudgeStart(-0.5)}>
          入点 -0.5s
        </button>
        <button type="button" onClick={() => onNudgeStart(0.5)}>
          入点 +0.5s
        </button>
        <button type="button" onClick={() => onNudgeEnd(-0.5)}>
          出点 -0.5s
        </button>
        <button type="button" onClick={() => onNudgeEnd(0.5)}>
          出点 +0.5s
        </button>
        <button type="button" onClick={() => onShiftRange(-0.5)}>
          整体 -0.5s
        </button>
        <button type="button" onClick={() => onShiftRange(0.5)}>
          整体 +0.5s
        </button>
      </div>
    </div>
  );
}

function ClipSequence({
  simple,
  bulkStatus,
  copyableClipCount,
  currentTime,
  duration,
  focusRequest,
  marks,
  recentlyDeletedClip,
  reorderingId,
  restoringDeleted,
  savingId,
  savingNew,
  transcriptRows,
  onBulkCopy,
  onBulkStatus,
  onDismissDeleted,
  onDelete,
  onDuplicate,
  onMove,
  onPreviewRange,
  onReorder,
  onRestoreDeleted,
  onSeek,
  onUpdate,
}: {
  simple: boolean;
  bulkStatus: string | null;
  copyableClipCount: number;
  currentTime: number;
  duration: number;
  focusRequest: SequenceFocusRequest | null;
  marks: ClipMark[];
  recentlyDeletedClip: RecentlyDeletedClip | null;
  reorderingId: number | null;
  restoringDeleted: boolean;
  savingId: number | null;
  savingNew: boolean;
  transcriptRows: TranscriptRow[];
  onBulkCopy: () => void;
  onBulkStatus: (status: string) => void;
  onDismissDeleted: () => void;
  onDelete: (id: number) => void;
  onDuplicate: (mark: ClipMark) => void;
  onMove: (id: number, direction: -1 | 1) => void;
  onPreviewRange: (start: number, end: number) => void;
  onReorder: (ids: number[], activeId: number) => void;
  onRestoreDeleted: () => void;
  onSeek: (seconds: number) => void;
  onUpdate: (id: number, payload: Pick<ClipMark, "start_seconds" | "end_seconds" | "label" | "note" | "quote" | "status">) => Promise<boolean>;
}) {
  const totalSeconds = marks.reduce((sum, mark) => sum + Math.max(mark.end_seconds - mark.start_seconds, 0), 0);
  const approvedCount = marks.filter((mark) => mark.status === "approved").length;
  const readyCount = marks.filter((mark) => mark.status === "ready").length;
  const pendingCount = marks.length - approvedCount;
  const chronologicalIds = [...marks]
    .sort((left, right) => left.start_seconds - right.start_seconds || left.end_seconds - right.end_seconds || left.id - right.id)
    .map((mark) => mark.id);
  const isChronological = marks.every((mark, index) => mark.id === chronologicalIds[index]);
  const sequenceQuality = buildSequenceQualitySummary(marks);
  const issueDetails = buildSequenceIssueDetails(marks);
  const issueMarkIds = new Set(issueDetails.keys());
  const firstQualityIssueMarkId = sequenceQuality.issues.find((issue) => issue.markId !== undefined)?.markId;
  const firstQualityIssueMark = firstQualityIssueMarkId ? marks.find((mark) => mark.id === firstQualityIssueMarkId) : null;
  const trimDuration = Math.max(duration, 1);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sequenceFilter, setSequenceFilter] = useState<SequenceFilter>("all");
  const [draft, setDraft] = useState({ start_seconds: "", end_seconds: "", label: "", note: "", quote: "", status: "ready" });
  const [confirmDiscardId, setConfirmDiscardId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const filterCounts: Record<SequenceFilter, number> = {
    all: marks.length,
    approved: approvedCount,
    copy: marks.filter(isClipCopyIncomplete).length,
    draft: marks.filter((mark) => mark.status === "draft").length,
    issues: issueMarkIds.size,
    ready: readyCount,
  };
  const displayedMarks = marks.filter((mark) => {
    if (sequenceFilter === "all") return true;
    if (sequenceFilter === "issues") return issueMarkIds.has(mark.id);
    if (sequenceFilter === "copy") return isClipCopyIncomplete(mark);
    return mark.status === sequenceFilter;
  });
  const activeFilter = SEQUENCE_FILTERS.find((filter) => filter.value === sequenceFilter) ?? SEQUENCE_FILTERS[0];
  const isFiltered = sequenceFilter !== "all";
  const dragEnabled = !isFiltered && marks.length > 1 && editingId === null && reorderingId === null;
  const bulkBusy = Boolean(bulkStatus);
  const transcriptSnapRows = transcriptRows.map((row) => ({ end: row.end, start: row.start, text: row.zh?.text || row.en?.text || "" }));

  const draftFromMark = (mark: ClipMark) => ({
    start_seconds: toSecondInput(mark.start_seconds),
    end_seconds: toSecondInput(mark.end_seconds),
    label: mark.label,
    note: mark.note,
    quote: mark.quote,
    status: mark.status || "draft",
  });

  const updateDraft = (nextDraft: typeof draft) => {
    setConfirmDiscardId(null);
    setDraft(nextDraft);
  };

  useEffect(() => {
    if (!editingId) return;
    const mark = marks.find((item) => item.id === editingId);
    if (!mark) {
      setConfirmDiscardId(null);
      setEditingId(null);
    }
  }, [editingId, marks]);

  useEffect(() => {
    if (!marks.length && sequenceFilter !== "all") setSequenceFilter("all");
  }, [marks.length, sequenceFilter]);

  useEffect(() => {
    if (!focusRequest || editingId) return;
    setSequenceFilter(focusRequest.filter);
  }, [editingId, focusRequest]);

  useEffect(() => {
    if (!focusRequest || editingId || sequenceFilter !== focusRequest.filter) return;
    window.setTimeout(() => {
      const target = clipSequenceFocusSelectors(focusRequest.filter)
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find(Boolean);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus();
    }, 0);
  }, [displayedMarks.length, editingId, focusRequest, sequenceFilter]);

  useEffect(() => {
    if (!reorderingId) return;
    setDraggingId(null);
    setDragOverId(null);
  }, [reorderingId]);

  useEffect(() => {
    if (!editingId) return;
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-clip-edit-form="${editingId}"]`)?.focus();
    }, 0);
  }, [editingId]);

  const ignoresPlainEditShortcuts = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
  };

  const editMark = (mark: ClipMark) => {
    setEditingId(mark.id);
    updateDraft(draftFromMark(mark));
  };

  const resetDraft = (mark: ClipMark) => {
    updateDraft(draftFromMark(mark));
  };

  const draftHasChanges = (mark: ClipMark) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    return (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      Math.abs(start - mark.start_seconds) >= 0.05 ||
      Math.abs(end - mark.end_seconds) >= 0.05 ||
      draft.label !== mark.label ||
      draft.note !== mark.note ||
      draft.quote !== mark.quote ||
      (draft.status || "ready") !== (mark.status || "draft")
    );
  };

  const openAdjacentMark = (mark: ClipMark, direction: -1 | 1) => {
    const reviewMarks = displayedMarks.length ? displayedMarks : marks;
    const index = reviewMarks.findIndex((item) => item.id === mark.id);
    const nextMark = index >= 0 ? reviewMarks[index + direction] : null;
    if (!nextMark && direction > 0) {
      setConfirmDiscardId(null);
      setEditingId(null);
      return;
    }
    if (!nextMark) return;
    editMark(nextMark);
    onSeek(nextMark.start_seconds);
    window.setTimeout(() => {
      document.querySelector(`[data-clip-mark-id="${nextMark.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  };

  const hasNextReviewMarkAfter = (mark: ClipMark) => {
    const reviewMarks = displayedMarks.length ? displayedMarks : marks;
    const index = reviewMarks.findIndex((item) => item.id === mark.id);
    return index >= 0 && index < reviewMarks.length - 1;
  };

  const saveMark = async (mark: ClipMark) => {
    const validation = buildDraftValidation(mark);
    if (!validation.ok || !draftHasChanges(mark)) return;
    const saved = await onUpdate(mark.id, {
      start_seconds: Number(draft.start_seconds),
      end_seconds: Number(draft.end_seconds),
      label: draft.label,
      note: draft.note,
      quote: draft.quote,
      status: draft.status || "ready",
    });
    if (saved) {
      setConfirmDiscardId(null);
      setEditingId(null);
    }
  };

  const saveAndApproveMark = async (mark: ClipMark, continueToNext = false) => {
    const validation = buildDraftValidation(mark);
    if (!validation.ok || (!draftHasChanges(mark) && mark.status === "approved")) return;
    const saved = await onUpdate(mark.id, {
      start_seconds: Number(draft.start_seconds),
      end_seconds: Number(draft.end_seconds),
      label: draft.label,
      note: draft.note,
      quote: draft.quote,
      status: "approved",
    });
    if (saved) {
      setConfirmDiscardId(null);
      if (continueToNext) {
        openAdjacentMark(mark, 1);
        return;
      }
      setEditingId(null);
    }
  };

  const continueEditFlow = async (mark: ClipMark, draftChanged: boolean, direction: -1 | 1) => {
    if (!draftChanged) {
      openAdjacentMark(mark, direction);
      return;
    }
    const validation = buildDraftValidation(mark);
    if (!validation.ok) return;
    const saved = await onUpdate(mark.id, {
      start_seconds: Number(draft.start_seconds),
      end_seconds: Number(draft.end_seconds),
      label: draft.label,
      note: draft.note,
      quote: draft.quote,
      status: draft.status || "ready",
    });
    if (saved) {
      setConfirmDiscardId(null);
      openAdjacentMark(mark, direction);
    }
  };

  const cancelEdit = (mark: ClipMark, draftChanged: boolean) => {
    if (!draftChanged || confirmDiscardId === mark.id) {
      setConfirmDiscardId(null);
      setEditingId(null);
      return;
    }
    setConfirmDiscardId(mark.id);
  };

  const setMarkStatus = async (mark: ClipMark, status: string) => {
    if (mark.status === status || savingId === mark.id || bulkBusy) return;
    await onUpdate(mark.id, {
      start_seconds: mark.start_seconds,
      end_seconds: mark.end_seconds,
      label: mark.label,
      note: mark.note,
      quote: mark.quote,
      status,
    });
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLFormElement>, mark: ClipMark, draftChanged: boolean, validation: ManualClipValidation | null, index: number) => {
    if (savingId === mark.id) return;
    const shortcut = resolveClipEditShortcut({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      ignorePlainKeys: ignoresPlainEditShortcuts(event.target),
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "approve" && validation?.ok) {
      void saveAndApproveMark(mark, hasNextReviewMarkAfter(mark));
      return;
    }
    if (shortcut === "save" && validation?.ok && draftChanged) {
      void saveMark(mark);
      return;
    }
    if (shortcut === "previous" && index > 0 && (!draftChanged || validation?.ok)) {
      void continueEditFlow(mark, draftChanged, -1);
      return;
    }
    if (shortcut === "next" && (!draftChanged || validation?.ok)) {
      void continueEditFlow(mark, draftChanged, 1);
      return;
    }
    if (shortcut === "cancel") {
      cancelEdit(mark, draftChanged);
      return;
    }
    if (shortcut === "mark-in") {
      setDraftPointFromPlayhead("start_seconds");
      return;
    }
    if (shortcut === "mark-out") {
      setDraftPointFromPlayhead("end_seconds");
      return;
    }
    if (shortcut === "preview" && validation?.ok) previewDraft();
  };

  const updateDraftPoint = (field: "start_seconds" | "end_seconds", value: number) => {
    const start = Number(draft.start_seconds) || 0;
    const end = Number(draft.end_seconds) || 0;
    if (field === "start_seconds") {
      const safeStart = clamp(value, 0, Math.max(end - 0.1, 0));
      updateDraft({ ...draft, start_seconds: toSecondInput(safeStart) });
      return;
    }
    const safeEnd = clamp(value, start + 0.1, trimDuration);
    updateDraft({ ...draft, end_seconds: toSecondInput(safeEnd) });
  };

  const nudgeDraftPoint = (field: "start_seconds" | "end_seconds", offset: number) => {
    const value = Number(draft[field]) || 0;
    updateDraftPoint(field, value + offset);
  };

  const shiftDraftRange = (offset: number) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const rangeDuration = end - start;
    const safeStart = clamp(start + offset, 0, Math.max(trimDuration - rangeDuration, 0));
    updateDraft({
      ...draft,
      start_seconds: toSecondInput(safeStart),
      end_seconds: toSecondInput(safeStart + rangeDuration),
    });
  };

  const setDraftPointFromPlayhead = (field: "start_seconds" | "end_seconds") => {
    updateDraftPoint(field, currentTime);
  };

  const applyDraftRange = (start: number, end: number) => {
    const safeStart = clamp(Number.isFinite(start) ? start : 0, 0, Math.max(trimDuration - 0.1, 0));
    const safeEnd = clamp(Number.isFinite(end) ? end : safeStart + 0.1, safeStart + 0.1, trimDuration);
    updateDraft({
      ...draft,
      start_seconds: toSecondInput(safeStart),
      end_seconds: toSecondInput(safeEnd),
    });
  };

  const timeNeighborsForMark = (mark: ClipMark) => {
    const sortedMarks = [...marks]
      .filter((item) => item.end_seconds > item.start_seconds)
      .sort((left, right) => left.start_seconds - right.start_seconds || left.end_seconds - right.end_seconds || left.id - right.id);
    const index = sortedMarks.findIndex((item) => item.id === mark.id);
    return {
      next: index >= 0 ? sortedMarks[index + 1] : undefined,
      previous: index > 0 ? sortedMarks[index - 1] : undefined,
    };
  };

  const issueRepairLabel = (issue: SequenceMarkIssue) => {
    if (issue.id === "invalid-boundaries") return "重设出点";
    if (issue.id === "short") return "补足 3 秒";
    if (issue.id.startsWith("overlap-prev")) return "贴齐上一段";
    if (issue.id.startsWith("overlap-next")) return "贴齐下一段";
    return "快速修正";
  };

  const applyIssueRepair = (mark: ClipMark, issue: SequenceMarkIssue) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    const draftStart = Number.isFinite(start) ? start : mark.start_seconds;
    const draftEnd = Number.isFinite(end) ? end : mark.end_seconds;
    if (issue.id === "invalid-boundaries") {
      applyDraftRange(draftStart, Math.min(draftStart + MIN_CLIP_SECONDS, trimDuration));
      onSeek(draftStart);
      return;
    }
    if (issue.id === "short") {
      if (trimDuration - draftStart >= MIN_CLIP_SECONDS) {
        applyDraftRange(draftStart, draftStart + MIN_CLIP_SECONDS);
        onSeek(draftStart);
        return;
      }
      const nextEnd = Math.min(trimDuration, Math.max(draftEnd, MIN_CLIP_SECONDS));
      applyDraftRange(Math.max(nextEnd - MIN_CLIP_SECONDS, 0), nextEnd);
      onSeek(Math.max(nextEnd - MIN_CLIP_SECONDS, 0));
      return;
    }
    const neighbors = timeNeighborsForMark(mark);
    if (issue.id.startsWith("overlap-prev") && neighbors.previous) {
      updateDraftPoint("start_seconds", neighbors.previous.end_seconds);
      onSeek(neighbors.previous.end_seconds);
      return;
    }
    if (issue.id.startsWith("overlap-next") && neighbors.next) {
      updateDraftPoint("end_seconds", neighbors.next.start_seconds);
      onSeek(neighbors.next.start_seconds);
    }
  };

  const buildPlayheadHint = () => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { kind: "warn", message: "等待有效片段" };
    }
    if (currentTime < start) {
      return { kind: "warn", message: `早于入点 ${formatDuration(start - currentTime)}` };
    }
    if (currentTime > end) {
      return { kind: "warn", message: `晚于出点 ${formatDuration(currentTime - end)}` };
    }
    return { kind: "inside", message: `片段内 ${formatDuration(currentTime - start)}` };
  };

  const previewDraft = () => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    onPreviewRange(start, end);
  };

  const buildDraftValidation = (mark: ClipMark) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    const duplicate =
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      marks.some((item) => item.id !== mark.id && Math.abs(item.start_seconds - start) < 0.5 && Math.abs(item.end_seconds - end) < 0.5);
    return buildManualClipValidation({
      duplicate,
      end,
      readyAction: "可以保存",
      start,
      timelineDuration: trimDuration,
    });
  };

  const buildDraftIssueDetailsForMark = (mark: ClipMark) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const draftMarks = marks.map((item) => (item.id === mark.id ? { ...item, start_seconds: start, end_seconds: end } : item));
    return buildSequenceIssueDetails(draftMarks).get(mark.id) ?? [];
  };

  const buildTranscriptSnap = () => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    return buildTranscriptSnapForRange(transcriptSnapRows, start, end);
  };

  const applyTranscriptSnap = (mode: "start" | "end" | "range") => {
    const snap = buildTranscriptSnap();
    if (!snap) return;
    if (mode === "start") {
      updateDraftPoint("start_seconds", snap.start);
      onSeek(snap.start);
      return;
    }
    if (mode === "end") {
      updateDraftPoint("end_seconds", snap.end);
      onSeek(snap.end);
      return;
    }
    applyDraftRange(snap.start, snap.end);
    onSeek(snap.start);
  };

  const applyTranscriptQuote = () => {
    const snap = buildTranscriptSnap();
    if (!snap?.quote) return;
    updateDraft({ ...draft, quote: snap.quote });
  };

  const applyTranscriptCopy = () => {
    const snap = buildTranscriptSnap();
    const copy = mergeMissingClipCopyFields(draft, buildTranscriptClipCopy(snap));
    if (!copy) return;
    updateDraft({ ...draft, ...copy });
  };

  const formatSignedSeconds = (seconds: number) => {
    if (!Number.isFinite(seconds) || Math.abs(seconds) < 0.05) return "0.0s";
    return `${seconds > 0 ? "+" : "-"}${Math.abs(seconds).toFixed(1)}s`;
  };

  const draftDeltaClass = (seconds: number) => {
    if (!Number.isFinite(seconds) || Math.abs(seconds) < 0.05) return "neutral";
    return seconds > 0 ? "positive" : "negative";
  };

  const buildDraftRangeSummary = (mark: ClipMark) => {
    const start = Number(draft.start_seconds);
    const end = Number(draft.end_seconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const draftDuration = end - start;
    const originalDuration = Math.max(mark.end_seconds - mark.start_seconds, 0);
    return {
      durationDelta: draftDuration - originalDuration,
      draftDuration,
      endDelta: end - mark.end_seconds,
      originalDuration,
      startDelta: start - mark.start_seconds,
    };
  };

  const clearDragState = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, mark: ClipMark) => {
    if (!dragEnabled) {
      event.preventDefault();
      return;
    }
    setDraggingId(mark.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(mark.id));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, targetId: number) => {
    if (!dragEnabled || !draggingId || draggingId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverId(targetId);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>, targetId: number) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragOverId((current) => (current === targetId ? null : current));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: number) => {
    event.preventDefault();
    const sourceId = Number(event.dataTransfer.getData("text/plain")) || draggingId;
    if (!dragEnabled || !sourceId || sourceId === targetId) {
      clearDragState();
      return;
    }
    const fromIndex = marks.findIndex((mark) => mark.id === sourceId);
    const toIndex = marks.findIndex((mark) => mark.id === targetId);
    if (fromIndex < 0 || toIndex < 0) {
      clearDragState();
      return;
    }
    const nextMarks = [...marks];
    const [moved] = nextMarks.splice(fromIndex, 1);
    nextMarks.splice(toIndex, 0, moved);
    onReorder(nextMarks.map((mark) => mark.id), sourceId);
    clearDragState();
  };

  const sortByTime = () => {
    if (isChronological || chronologicalIds.length < 2) return;
    const movedId = chronologicalIds.find((id, index) => marks[index]?.id !== id) ?? chronologicalIds[0];
    onReorder(chronologicalIds, movedId);
  };

  const focusMarkForEdit = (mark: ClipMark | null | undefined, seekSeconds?: number) => {
    if (!mark) return;
    if (editingId && editingId !== mark.id && editingDraftChanged) {
      setConfirmDiscardId(editingId);
      return;
    }
    editMark(mark);
    onSeek(Number.isFinite(seekSeconds) ? Number(seekSeconds) : mark.start_seconds);
    window.setTimeout(() => {
      document.querySelector(`[data-clip-mark-id="${mark.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  };

  const focusQualityIssue = (mark: ClipMark | null | undefined) => {
    focusMarkForEdit(mark);
  };

  const editingMark = editingId ? marks.find((mark) => mark.id === editingId) : null;
  const editingDraftChanged = editingMark ? draftHasChanges(editingMark) : false;

  return (
    <div className={`marks-panel ${simple ? "simple-sequence" : ""}`}>
      <div className="transcript-head sequence-panel-head">
        <div>
          <h3>剪辑序列</h3>
          <span>{marks.length ? `${marks.length} 段 · ${formatDuration(totalSeconds)} · ${approvedCount}/${marks.length} 已确认` : "空序列"}</span>
        </div>
        {marks.length && !simple ? (
          <div className="sequence-bulk-actions" aria-label="批量审片状态">
            <button disabled={isChronological || Boolean(reorderingId) || Boolean(savingId) || savingNew || Boolean(editingId)} type="button" onClick={sortByTime}>
              {reorderingId ? <SpinnerGap size={13} className="spin" /> : <Clock size={13} />}
              按时间排序
            </button>
            <button disabled={!copyableClipCount || bulkBusy || Boolean(savingId) || savingNew || Boolean(editingId)} type="button" onClick={onBulkCopy}>
              {bulkStatus === "copy" ? <SpinnerGap size={13} className="spin" /> : <Subtitles size={13} />}
              补齐文案
            </button>
            <button className="primary" disabled={!pendingCount || bulkBusy || Boolean(savingId) || savingNew || Boolean(editingId)} type="button" onClick={() => onBulkStatus("approved")}>
              {bulkStatus === "approved" ? <SpinnerGap size={13} className="spin" /> : <CheckCircle size={13} weight="fill" />}
              全部确认
            </button>
            <button disabled={readyCount === marks.length || bulkBusy || Boolean(savingId) || savingNew || Boolean(editingId)} type="button" onClick={() => onBulkStatus("ready")}>
              {bulkStatus === "ready" ? <SpinnerGap size={13} className="spin" /> : <ArrowCounterClockwise size={13} />}
              重置可用
            </button>
          </div>
        ) : null}
      </div>
      {marks.length && !simple ? (
        <div className={`sequence-quality-panel ${sequenceQuality.severity}`}>
          <div className="sequence-quality-head">
            <strong>{sequenceQuality.message}</strong>
            {firstQualityIssueMark && (
              <button type="button" onClick={() => focusQualityIssue(firstQualityIssueMark)}>
                <PencilSimple size={13} />
                定位问题
              </button>
            )}
          </div>
          {sequenceQuality.issues.length ? (
            <div>
              {sequenceQuality.issues.map((issue) => {
                const issueMark = issue.markId ? marks.find((mark) => mark.id === issue.markId) : null;
                const label = `${issue.label}：${issue.message}`;
                return issueMark ? (
                  <button className={issue.severity} key={issue.id} type="button" onClick={() => focusQualityIssue(issueMark)}>
                    {label}
                  </button>
                ) : (
                  <span className={issue.severity} key={issue.id}>
                    {label}
                  </span>
                );
              })}
            </div>
          ) : (
            <span>边界、重叠和片段长度都可用于导出。</span>
          )}
        </div>
      ) : null}
      {marks.length && !simple ? (
        <div className="sequence-filter-bar" aria-label="筛选剪辑序列">
          {SEQUENCE_FILTERS.map((filter) => (
            <button
              className={sequenceFilter === filter.value ? "active" : ""}
              disabled={Boolean(editingId)}
              key={filter.value}
              type="button"
              onClick={() => setSequenceFilter(filter.value)}
            >
              <span>{filter.label}</span>
              <strong>{filterCounts[filter.value]}</strong>
            </button>
          ))}
        </div>
      ) : null}
      {!simple && isFiltered && displayedMarks.length ? (
        <div className="sequence-filter-context">
          <span>
            {activeFilter.label} {displayedMarks.length} 段 · 当前队列
          </span>
          <div>
            <button className="primary" type="button" onClick={() => focusMarkForEdit(displayedMarks[0])} disabled={Boolean(editingId)}>
              <PencilSimple size={13} />
              精修首条
            </button>
            <button type="button" onClick={() => setSequenceFilter("all")} disabled={Boolean(editingId)}>
              查看全部
            </button>
          </div>
        </div>
      ) : null}
      {recentlyDeletedClip && (
        <div className="undo-delete-panel">
          <div>
            <span>刚刚移除</span>
            <strong>{recentlyDeletedClip.mark.label || "未命名片段"}</strong>
            <small>
              {formatTimecode(recentlyDeletedClip.mark.start_seconds)} - {formatTimecode(recentlyDeletedClip.mark.end_seconds)}
            </small>
          </div>
          <div className="undo-delete-actions">
            <button className="primary" type="button" onClick={onRestoreDeleted} disabled={restoringDeleted}>
              {restoringDeleted ? <SpinnerGap size={14} className="spin" /> : <ArrowCounterClockwise size={14} />}
              恢复
            </button>
            <button type="button" onClick={onDismissDeleted} disabled={restoringDeleted}>
              <X size={14} />
              忽略
            </button>
          </div>
        </div>
      )}
      {marks.length ? (
        <>
          <div className="sequence-strip" aria-label="剪辑序列缩略时间线">
            {marks.map((mark, index) => (
              <button
                className={editingId === mark.id ? "active" : ""}
                key={mark.id}
                style={{ flexGrow: Math.max(mark.end_seconds - mark.start_seconds, 2) }}
                title={`${mark.label || `片段 ${index + 1}`} · ${formatTimecode(mark.start_seconds)} - ${formatTimecode(mark.end_seconds)}`}
                type="button"
                onClick={() => onSeek(mark.start_seconds)}
              >
                #{index + 1}
              </button>
            ))}
          </div>
          {displayedMarks.length ? (
            displayedMarks.map((mark, index) => {
            const markIndex = marks.findIndex((item) => item.id === mark.id);
            const sequenceNumber = markIndex >= 0 ? markIndex + 1 : index + 1;
            const hasNextReviewMark = hasNextReviewMarkAfter(mark);
            const reviewMarks = displayedMarks.length ? displayedMarks : marks;
            const reviewIndex = reviewMarks.findIndex((item) => item.id === mark.id);
            const queuePosition = reviewIndex >= 0 ? `${reviewIndex + 1}/${reviewMarks.length}` : "";
            const queueLabel = isFiltered ? `${activeFilter.label}队列` : "全部序列";
            const canMoveUp = !isFiltered && markIndex > 0;
            const canMoveDown = !isFiltered && markIndex >= 0 && markIndex < marks.length - 1;
            const dragHandleTitle = dragEnabled ? "拖拽调整顺序" : isFiltered ? "当前筛选下暂不可拖拽" : "打开精修时暂不可拖拽";
            const moveTitle = isFiltered ? "切回全部后可以调整顺序" : undefined;
            const savedMarkIssues = issueDetails.get(mark.id) ?? [];
            const draftMarkIssues = editingId === mark.id ? buildDraftIssueDetailsForMark(mark) : savedMarkIssues;
            const markIssues = editingId === mark.id ? draftMarkIssues : savedMarkIssues;
            const draftResolvedIssues = editingId === mark.id && savedMarkIssues.length > 0 && draftMarkIssues.length === 0;
            const copyGaps = clipCopyGapLabels(mark);
            const draftValidation = editingId === mark.id ? buildDraftValidation(mark) : null;
            const draftChanged = editingId === mark.id ? draftHasChanges(mark) : false;
            const draftRangeSummary = editingId === mark.id ? buildDraftRangeSummary(mark) : null;
            const confirmDiscard = confirmDiscardId === mark.id;
            const editLocked = Boolean(editingId && editingId !== mark.id && editingDraftChanged);
            const playheadHint = editingId === mark.id ? buildPlayheadHint() : null;
            const transcriptSnap = editingId === mark.id ? buildTranscriptSnap() : null;
            const hasBlockingIssue = markIssues.some((issue) => issue.severity === "block");
            const draftStartSeconds = Number(draft.start_seconds);
            const draftEndSeconds = Number(draft.end_seconds);
            const draftRangeLabel =
              Number.isFinite(draftStartSeconds) && Number.isFinite(draftEndSeconds) && draftEndSeconds > draftStartSeconds
                ? `${formatTimecode(draftStartSeconds)} - ${formatTimecode(draftEndSeconds)}`
                : "等待有效范围";
            const issueLabels = [...new Set(markIssues.map((issue) => issue.label))].join("、");
            const readinessKind = confirmDiscard ? "discard" : !draftValidation?.ok || hasBlockingIssue ? "block" : markIssues.length ? "warn" : draftChanged ? "changed" : "ready";
            const readinessTitle = confirmDiscard
              ? "准备放弃草稿"
              : !draftValidation?.ok
                ? "还不能保存"
                : hasBlockingIssue
                  ? "先修正边界"
                  : markIssues.length
                    ? `${markIssues.length} 项需复核`
                    : draftChanged
                      ? "可以保存"
                      : "已同步";
            const readinessMessage = confirmDiscard
              ? "再次点击放弃改动会退出精修。"
              : !draftValidation?.ok
                ? draftValidation?.message ?? "请检查入点和出点。"
                : markIssues.length
                  ? `${issueLabels}会影响成片节奏，下方可快速修正。`
                  : draftChanged
                    ? "草稿有效，保存后会更新当前序列。"
                    : "草稿和已保存片段一致，可以预览或继续下一段。";
            const rowClassName = [
              "mark-row",
              editingId === mark.id ? "editing" : "",
              draggingId === mark.id ? "dragging" : "",
              dragOverId === mark.id && draggingId !== mark.id ? "drop-target" : "",
              reorderingId === mark.id ? "reordering" : "",
              markIssues.some((issue) => issue.severity === "block") ? "has-block-issue" : markIssues.length ? "has-warn-issue" : "",
            ].filter(Boolean).join(" ");
            return (
              <div
                className={rowClassName}
                draggable={dragEnabled}
                key={mark.id}
                data-clip-mark-id={mark.id}
                onDragEnd={clearDragState}
                onDragLeave={(event) => handleDragLeave(event, mark.id)}
                onDragOver={(event) => handleDragOver(event, mark.id)}
                onDragStart={(event) => handleDragStart(event, mark)}
                onDrop={(event) => handleDrop(event, mark.id)}
              >
                {editingId === mark.id ? (
                  <form
                    className="mark-edit-form"
                    data-clip-edit-form={mark.id}
                    tabIndex={-1}
                    onKeyDown={(event) => handleEditKeyDown(event, mark, draftChanged, draftValidation, index)}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveMark(mark);
                    }}
                  >
                  <div className="mark-edit-context">
                    <div>
                      <span>
                        {queueLabel}
                        {queuePosition ? ` · ${queuePosition}` : ""}
                      </span>
                      <strong>#{sequenceNumber} {mark.label || "未命名片段"}</strong>
                    </div>
                    <ClipStatusBadge status={draft.status} />
                  </div>
                  <div className={`mark-edit-readiness ${readinessKind}`} aria-live="polite">
                    <div className="mark-edit-readiness-main">
                      {!draftValidation?.ok || hasBlockingIssue || confirmDiscard ? <WarningCircle size={16} weight="fill" /> : <CheckCircle size={16} weight="fill" />}
                      <div>
                        <strong>{readinessTitle}</strong>
                        <span>{readinessMessage}</span>
                      </div>
                    </div>
                    <div className="mark-edit-readiness-meta">
                      <span>
                        <small>范围</small>
                        <strong>{draftRangeLabel}</strong>
                      </span>
                      <span>
                        <small>质量</small>
                        <strong>{markIssues.length ? `${markIssues.length} 项` : "通过"}</strong>
                      </span>
                    </div>
                  </div>
                  <ClipTrimEditor
                    currentTime={currentTime}
                    duration={trimDuration}
                    end={Number(draft.end_seconds)}
                    start={Number(draft.start_seconds)}
                    onEndChange={(value) => updateDraftPoint("end_seconds", value)}
                    onNudgeEnd={(offset) => nudgeDraftPoint("end_seconds", offset)}
                    onNudgeStart={(offset) => nudgeDraftPoint("start_seconds", offset)}
                    onShiftRange={shiftDraftRange}
                    onStartChange={(value) => updateDraftPoint("start_seconds", value)}
                  />
                  {draftRangeSummary ? (
                    <div className="mark-draft-summary" aria-label="草稿变化摘要">
                      <span>
                        <small>草稿</small>
                        <strong>{formatDuration(draftRangeSummary.draftDuration)}</strong>
                      </span>
                      <span className={draftDeltaClass(draftRangeSummary.startDelta)}>
                        <small>入点</small>
                        <strong>{formatSignedSeconds(draftRangeSummary.startDelta)}</strong>
                      </span>
                      <span className={draftDeltaClass(draftRangeSummary.endDelta)}>
                        <small>出点</small>
                        <strong>{formatSignedSeconds(draftRangeSummary.endDelta)}</strong>
                      </span>
                      <span className={draftDeltaClass(draftRangeSummary.durationDelta)}>
                        <small>时长</small>
                        <strong>{formatSignedSeconds(draftRangeSummary.durationDelta)}</strong>
                      </span>
                    </div>
                  ) : null}
                  <div className="trim-playhead-actions" aria-label="使用当前播放头精修">
                    <span className={playheadHint ? playheadHint.kind : ""}>
                      播放头 {formatTimecode(currentTime)}
                      {playheadHint ? ` · ${playheadHint.message}` : ""}
                    </span>
                    <button type="button" aria-keyshortcuts="I" onClick={() => setDraftPointFromPlayhead("start_seconds")}>
                      设为入点
                    </button>
                    <button type="button" aria-keyshortcuts="O" onClick={() => setDraftPointFromPlayhead("end_seconds")}>
                      设为出点
                    </button>
                  </div>
                  {transcriptSnap ? (
                    <div className="transcript-snap-panel" aria-label="贴合字幕边界">
                      <div>
                        <span>字幕边界 · {transcriptSnap.label}</span>
                        <strong>
                          {formatTimecode(transcriptSnap.start)} - {formatTimecode(transcriptSnap.end)}
                        </strong>
                        {transcriptSnap.quote ? <small>{transcriptSnap.quote}</small> : null}
                      </div>
                      <div>
                        <button type="button" onClick={() => applyTranscriptSnap("start")}>
                          贴入点
                        </button>
                        <button type="button" onClick={() => applyTranscriptSnap("end")}>
                          贴出点
                        </button>
                        <button type="button" onClick={() => applyTranscriptSnap("range")}>
                          贴整段
                        </button>
                        <button type="button" onClick={applyTranscriptQuote} disabled={!transcriptSnap.quote}>
                          填引用
                        </button>
                        <button type="button" onClick={applyTranscriptCopy} disabled={!transcriptSnap.quote}>
                          填文案
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {markIssues.length ? (
                    <div className="mark-repair-panel" aria-label="快速修正片段问题">
                      {markIssues.map((issue) => (
                        <button className={issue.severity} key={issue.id} type="button" onClick={() => applyIssueRepair(mark, issue)}>
                          <WarningCircle size={13} />
                          {issueRepairLabel(issue)}
                        </button>
                      ))}
                    </div>
                  ) : draftResolvedIssues ? (
                    <div className="mark-repair-panel ready" aria-live="polite">
                      <span>
                        <CheckCircle size={13} weight="fill" />
                        草稿已解决质量问题
                      </span>
                    </div>
                  ) : null}
                  <div className="mark-edit-grid">
                    <label>
                      入点
                      <input value={draft.start_seconds} onChange={(event) => updateDraft({ ...draft, start_seconds: event.target.value })} inputMode="decimal" />
                    </label>
                    <label>
                      出点
                      <input value={draft.end_seconds} onChange={(event) => updateDraft({ ...draft, end_seconds: event.target.value })} inputMode="decimal" />
                    </label>
                    <label className="span-2">
                      标签
                      <input value={draft.label} onChange={(event) => updateDraft({ ...draft, label: event.target.value })} />
                    </label>
                    <label className="span-2">
                      备注
                      <textarea value={draft.note} onChange={(event) => updateDraft({ ...draft, note: event.target.value })} />
                    </label>
                    <label className="span-2">
                      引用原文
                      <textarea value={draft.quote} onChange={(event) => updateDraft({ ...draft, quote: event.target.value })} />
                    </label>
                    <div className="clip-status-editor span-2" aria-label="审片状态">
                      {CLIP_REVIEW_STATUSES.map((status) => (
                        <button
                          className={draft.status === status.value ? "active" : ""}
                          key={status.value}
                          type="button"
                          onClick={() => updateDraft({ ...draft, status: status.value })}
                        >
                          <strong>{status.label}</strong>
                          <span>{status.detail}</span>
                        </button>
                      ))}
                    </div>
                    {draftValidation && (
                      <div className={`manual-clip-validation span-2 ${draftValidation.severity}`} aria-live="polite">
                        {draftValidation.message}
                      </div>
                    )}
                    {draftValidation && (
                      <div className={`mark-edit-state span-2 ${confirmDiscard ? "discard" : draftChanged ? "changed" : "clean"}`} aria-live="polite">
                        {confirmDiscard ? "再次点击“放弃改动”会退出精修并丢弃草稿。" : draftChanged ? "有未保存改动，保存后会更新序列。" : "当前草稿和已保存片段一致。"}
                      </div>
                    )}
                  </div>
                  <div className="sequence-actions edit-actions">
                    <button className={confirmDiscard ? "danger-action" : ""} type="button" aria-keyshortcuts="Escape" onClick={() => cancelEdit(mark, draftChanged)}>
                      <X size={14} />
                      {confirmDiscard ? "放弃改动" : "取消"}
                    </button>
                    <button type="button" onClick={() => resetDraft(mark)} disabled={!draftChanged || savingId === mark.id}>
                      <ArrowCounterClockwise size={14} />
                      还原
                    </button>
                    <button type="button" aria-keyshortcuts="P Space" onClick={previewDraft}>
                      <PlayCircle size={14} />
                      预览
                    </button>
                    <button type="button" aria-keyshortcuts="Alt+ArrowUp" onClick={() => continueEditFlow(mark, draftChanged, -1)} disabled={index === 0 || savingId === mark.id || (draftChanged && !draftValidation?.ok)}>
                      {savingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <CaretUp size={14} />}
                      {draftChanged ? "保存并上一段" : "上一段"}
                    </button>
                    <button type="button" aria-keyshortcuts="Alt+ArrowDown" onClick={() => continueEditFlow(mark, draftChanged, 1)} disabled={savingId === mark.id || (draftChanged && !draftValidation?.ok)}>
                      {savingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <CaretDown size={14} />}
                      {draftChanged ? "保存并下一段" : "下一段"}
                    </button>
                    <button className="primary" type="submit" aria-keyshortcuts="Control+Enter Meta+Enter" disabled={savingId === mark.id || !draftValidation?.ok || !draftChanged}>
                      {savingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <FloppyDisk size={14} />}
                      保存
                    </button>
                    <button className="approve-save" type="button" aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter" onClick={() => saveAndApproveMark(mark, hasNextReviewMark)} disabled={savingId === mark.id || !draftValidation?.ok || (!draftChanged && mark.status === "approved")}>
                      {savingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <CheckCircle size={14} weight="fill" />}
                      {hasNextReviewMark ? "确认并下一段" : "保存并确认"}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="mark-row-head">
                    <div className="mark-row-head-main">
                      <span className="drag-handle" title={dragHandleTitle} aria-hidden="true">
                        <DotsSixVertical size={16} weight="bold" />
                      </span>
                      {!simple && <ClipStatusBadge status={mark.status} />}
                      <span className="mark-row-time">
                        #{sequenceNumber} · {formatTimecode(mark.start_seconds)} - {formatTimecode(mark.end_seconds)}
                      </span>
                    </div>
                    <small>{formatDuration(mark.end_seconds - mark.start_seconds)}</small>
                  </div>
                  <strong>{mark.label || "未命名片段"}</strong>
                  <p>{mark.note || mark.quote || "无备注"}</p>
                  {!simple && (markIssues.length || copyGaps.length) ? (
                    <div className="mark-quality-flags" aria-label="片段质量提示">
                      {copyGaps.length ? (
                        <button className="copy" type="button" onClick={() => focusMarkForEdit(mark)}>
                          缺文案 · {copyGaps.join("、")}
                        </button>
                      ) : null}
                      {markIssues.map((issue) => (
                        <button className={issue.severity} key={issue.id} type="button" onClick={() => focusMarkForEdit(mark, issue.seekSeconds)}>
                          {issue.label} · {issue.message}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!simple && <div className="clip-status-actions" aria-label="片段审片状态">
                    {CLIP_REVIEW_STATUSES.map((status) => (
                      <button
                        className={mark.status === status.value ? "active" : ""}
                        disabled={savingId === mark.id || bulkBusy}
                        key={status.value}
                        type="button"
                        onClick={() => void setMarkStatus(mark, status.value)}
                      >
                        {savingId === mark.id && mark.status !== status.value ? <SpinnerGap size={12} className="spin" /> : null}
                        {status.label}
                      </button>
                    ))}
                  </div>}
                  <div className="sequence-actions">
                    <button type="button" title={moveTitle} onClick={() => onMove(mark.id, -1)} disabled={!canMoveUp || reorderingId === mark.id}>
                      {reorderingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <CaretUp size={14} />}
                      上移
                    </button>
                    <button type="button" title={moveTitle} onClick={() => onMove(mark.id, 1)} disabled={!canMoveDown || reorderingId === mark.id}>
                      {reorderingId === mark.id ? <SpinnerGap size={14} className="spin" /> : <CaretDown size={14} />}
                      下移
                    </button>
                    <button type="button" onClick={() => onSeek(mark.start_seconds)}>
                      <PlayCircle size={14} />
                      预览
                    </button>
                    {!simple && <button type="button" onClick={() => editMark(mark)} disabled={editLocked} title={editLocked ? "先保存、还原或放弃当前精修草稿" : "精修片段"}>
                      <PencilSimple size={14} />
                      精修
                    </button>}
                    {!simple && <button type="button" onClick={() => onDuplicate(mark)} disabled={savingNew}>
                      <Copy size={14} />
                      备选
                    </button>}
                    <button className="ghost-action" type="button" onClick={() => onDelete(mark.id)}>
                      <Trash size={14} />
                      移除
                    </button>
                  </div>
                </>
              )}
              </div>
            );
          })
          ) : (
            <div className="sequence-filter-empty">
              <strong>{activeFilter.label}里暂无片段</strong>
              <span>{sequenceFilter === "issues" ? "当前序列没有需要处理的质量问题。" : sequenceFilter === "copy" ? "当前序列的标题、备注和引用都已补齐。" : "当前序列没有这个状态的片段。"}</span>
              <button type="button" onClick={() => setSequenceFilter("all")}>
                查看全部
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="transcript-empty">还没有片段。像剪辑软件一样先设入点/出点，或从推荐高光一键加入。</div>
      )}
    </div>
  );
}

function SourcePill({ source }: { source: SourceRun }) {
  const experimental = source.tier === "experimental" || source.status === "planned" || source.status === "manual";
  return (
    <div className={`source-pill ${experimental ? "experimental" : ""}`}>
      {experimental ? <WarningCircle size={16} /> : <CheckCircle size={16} />}
      <strong>{source.name}</strong>
      <span>{source.message}</span>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const kind = status === "failed" ? "bad" : status === "clip_ready" || status === "completed" || status === "translated" ? "good" : status === "running" || status === "queued" ? "busy" : "";
  return <span className={`status-badge ${kind}`}>{status === "running" || status === "queued" ? "处理中" : statusLabel(status)}</span>;
}

function Step({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <div className={`step ${done ? "done" : ""} ${active ? "active" : ""}`}>
      <span>{done ? <CheckCircle size={14} weight="fill" /> : active ? <SpinnerGap size={14} className="spin" /> : <Clock size={14} />}</span>
      {label}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="loading-rows">
      {Array.from({ length: 5 }).map((_, index) => (
        <div className="skeleton-row" key={index}>
          <span />
          <div>
            <i />
            <i />
            <i />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onRun, running }: { onRun: () => void; running: boolean }) {
  return (
    <div className="empty-state">
      <FilmSlate size={36} />
      <h2>还没有这个区间的主题素材</h2>
      <p>点击抓取后，系统会按当前主题的关键词、重点人物、频道线索和排除词搜索，并按真实发布时间过滤。</p>
      <button className="primary" onClick={onRun} disabled={running}>
        {running ? <SpinnerGap size={17} className="spin" /> : <DownloadSimple size={17} />}
        {running ? "抓取中" : "抓取当前主题"}
      </button>
    </div>
  );
}

interface TimelineBandSource {
  key: string;
  start: number;
  end: number;
  label: string;
  title: string;
  action: () => void;
}

interface TimelineBand extends TimelineBandSource {
  lane: number;
  left: number;
  width: number;
}

function buildTimelineBands(sources: TimelineBandSource[], duration: number): { items: TimelineBand[]; laneCount: number } {
  const safeDuration = Math.max(duration, 1);
  const laneEnds: number[] = [];
  const items = sources
    .map((source, order) => {
      const start = clamp(source.start, 0, safeDuration);
      const end = clamp(Math.max(source.end, start + 0.1), start + 0.1, safeDuration);
      return { ...source, start, end, order };
    })
    .filter((source) => source.end > source.start)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
    .map((source) => {
      let lane = laneEnds.findIndex((laneEnd) => source.start >= laneEnd + 0.35);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(source.end);
      } else {
        laneEnds[lane] = source.end;
      }
      const left = (source.start / safeDuration) * 100;
      const right = (source.end / safeDuration) * 100;
      return {
        ...source,
        lane,
        left,
        width: Math.max(right - left, 0.55),
      };
    });
  return { items, laneCount: Math.max(laneEnds.length, 0) };
}

function timelineBandStyle(band: Pick<TimelineBand, "left" | "width">, top: number): CSSProperties {
  return {
    "--left": band.left / 100,
    "--width": band.width / 100,
    top: `${top}px`,
  } as CSSProperties;
}

function buildStats(items: Video[]) {
  return {
    total: items.length,
    ready: items.filter((item) => item.status === "ready" || item.status === "new" || item.status === "shortlisted").length,
    processing: items.filter((item) => VIDEO_PROCESSING_STATUSES.has(item.status)).length,
    clipReady: items.filter((item) => item.status === "clip_ready" || item.status === "translated" || item.status === "clipped" || item.status === "exported").length,
  };
}

function defaultClipExportOptions(title: string): ClipRenderOptions {
  return {
    destination: "downloads",
    output_dir: "",
    filename: title ? defaultExportFilename(title) : "",
    target_duration_seconds: 0,
    clip_status_filter: "all",
    output_profile: "landscape",
    fit_mode: "crop",
    focus_x: 50,
    subtitle_style: "standard",
    subtitle_position: "bottom",
    logo_asset_id: null,
    logo_position: "top_right",
  };
}

function defaultClipEditorState(title: string) {
  return {
    currentTime: 0,
    exportOptions: defaultClipExportOptions(title),
    form: {
      start_seconds: "0",
      end_seconds: "15",
      label: "PR 短切片段",
      note: "",
      quote: "",
    },
    transcriptSearch: "",
  };
}

function jobTypeLabel(type: string): string {
  return {
    daily_discovery: "主题抓取",
    download_translate: "下载与翻译",
    render_clips: "序列导出",
    sync_bilibili: "B站同步",
    sync_youtube: "YouTube 同步",
    subtitle_reprocess: "字幕重处理",
  }[type] ?? type;
}

function formatJobTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function outputProfileLabel(profile: ClipRenderOptions["output_profile"]): string {
  if (profile === "portrait") return "1080 × 1920";
  if (profile === "landscape") return "1920 × 1080";
  return "原尺寸";
}

function subtitlePositionLabel(position: ClipRenderOptions["subtitle_position"]): string {
  return position === "lower_third" ? "中下安全区" : "底部安全区";
}

function logoPositionLabel(position: ClipRenderOptions["logo_position"]): string {
  return {
    top_left: "左上",
    top_right: "右上",
    bottom_left: "左下",
    bottom_right: "右下",
  }[position];
}

function defaultExportFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 48) || "clip-sequence";
  return `${cleaned}-剪辑序列.mp4`;
}

function buildTranscriptRows(zh: Transcript[], en: Transcript[]) {
  const source = zh.length ? zh : en;
  return source.map((item, index) => ({
    start: item.start_seconds,
    end: item.end_seconds,
    zh: zh[index],
    en: en[index],
  }));
}

function filterTranscriptRows(rows: TranscriptRow[], search: string) {
  const term = search.trim().toLowerCase();
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (!term) return true;
      const haystack = `${row.zh?.text ?? ""} ${row.en?.text ?? ""}`.toLowerCase();
      return haystack.includes(term);
    });
}

function buildTranscriptSelectionSummary(rows: TranscriptRow[], selection: TranscriptSelection | null): TranscriptSelectionSummary | null {
  if (!selection || !rows.length) return null;
  const anchorIndex = clamp(Math.round(selection.anchorIndex), 0, rows.length - 1);
  const focusIndex = clamp(Math.round(selection.focusIndex), 0, rows.length - 1);
  const startIndex = Math.min(anchorIndex, focusIndex);
  const endIndex = Math.max(anchorIndex, focusIndex);
  const selectedRows = rows.slice(startIndex, endIndex + 1);
  const start = selectedRows[0]?.start ?? 0;
  const end = selectedRows[selectedRows.length - 1]?.end ?? start;
  const quote = selectedRows.map((row) => row.zh?.text || row.en?.text || "").filter(Boolean).join(" ");
  const count = selectedRows.length;
  const label = count === 1 ? "字幕选区" : `${count} 句字幕选区`;
  return {
    count,
    end,
    endIndex,
    label,
    note: `字幕选区 ${formatTimecode(start)} - ${formatTimecode(end)}`,
    quote,
    start,
    startIndex,
  };
}

function clipMarksDuration(marks: ClipMark[]): number {
  return marks.reduce((sum, mark) => sum + Math.max(mark.end_seconds - mark.start_seconds, 0), 0);
}

function clipStatusMeta(status: string) {
  return CLIP_REVIEW_STATUSES.find((item) => item.value === status) ?? { value: "draft", label: status || "待审", detail: "需要复核" };
}

function clipStatusLabel(status: string): string {
  return clipStatusMeta(status).label;
}

function buildExportPreflightChecks({
  clipStatusFilter,
  destination,
  filename,
  fitMode,
  focusX,
  hasMedia,
  logoAsset,
  logoAssetId,
  logoPosition,
  marks,
  missingCopyCount,
  outputDir,
  outputProfile,
  rowsCount,
  sequenceDuration,
  subtitlePosition,
  subtitleStyle,
  targetDuration,
}: {
  clipStatusFilter: string;
  destination: string;
  filename: string;
  fitMode: ClipRenderOptions["fit_mode"];
  focusX: number;
  hasMedia: boolean;
  logoAsset: MediaAsset | null;
  logoAssetId: number | null;
  logoPosition: ClipRenderOptions["logo_position"];
  marks: ClipMark[];
  missingCopyCount: number;
  outputDir: string;
  outputProfile: ClipRenderOptions["output_profile"];
  rowsCount: number;
  sequenceDuration: number;
  subtitlePosition: ClipRenderOptions["subtitle_position"];
  subtitleStyle: ClipRenderOptions["subtitle_style"];
  targetDuration: number;
}): ExportPreflightCheck[] {
  const invalidMarks = marks.filter((mark) => mark.end_seconds <= mark.start_seconds);
  const shortMarks = marks.filter((mark) => mark.end_seconds > mark.start_seconds && mark.end_seconds - mark.start_seconds < 3);
  const sortedMarks = [...marks].sort((a, b) => a.start_seconds - b.start_seconds);
  const overlaps = sortedMarks.filter((mark, index) => index > 0 && mark.start_seconds < sortedMarks[index - 1].end_seconds).length;
  const unapprovedMarks = marks.filter((mark) => mark.status !== "approved").length;
  const approvedOnly = clipStatusFilter === "approved";
  const destinationLabel = destination === "desktop" ? "桌面" : destination === "custom" ? "自定义路径" : "下载文件夹";
  const lengthWarning = marks.length > 0 && (sequenceDuration < 10 || sequenceDuration > 180);
  const profileLabel = outputProfile === "source" ? "保持原视频尺寸" : `${outputProfile === "portrait" ? "竖版 9:16" : "横版 16:9"} · ${outputProfileLabel(outputProfile)}`;
  const framingLabel = outputProfile === "source" ? "不改变画幅" : fitMode === "crop" ? `裁切填满 · 主体 ${Math.round(focusX)}%` : "完整画面 · 黑边适配";
  const logoBottomConflict = Boolean(logoAssetId) && logoPosition.startsWith("bottom") && subtitleStyle !== "none";

  return [
    {
      id: "media",
      label: "本地视频",
      message: hasMedia ? "视频文件已在本机，可生成 MP4。" : "缺少本地视频文件，无法渲染序列视频。",
      severity: hasMedia ? "ready" : "block",
    },
    {
      id: "sequence",
      label: "剪辑序列",
      message: marks.length
        ? `${approvedOnly ? "已确认范围" : "当前序列"} ${marks.length} 段，序列总长 ${formatDuration(sequenceDuration)}。`
        : approvedOnly
          ? "还没有已确认片段，先审片确认后再导出交付版。"
          : "还没有片段，先从字幕或高光加入序列。",
      severity: marks.length ? "ready" : "block",
    },
    {
      id: "output-profile",
      label: "输出规格",
      message: profileLabel,
      severity: "ready",
    },
    {
      id: "framing",
      label: "画面适配",
      message: framingLabel,
      severity: "ready",
    },
    {
      id: "boundaries",
      label: "片段边界",
      message: invalidMarks.length ? `${invalidMarks.length} 段出点不晚于入点，需要精修。` : "所有片段都有有效入点和出点。",
      severity: invalidMarks.length ? "block" : "ready",
    },
    {
      id: "review",
      label: "审片确认",
      message: approvedOnly
        ? "导出范围已限制为已确认片段。"
        : marks.length && unapprovedMarks
          ? `${unapprovedMarks} 段还未标记为已确认，建议审片后再交付。`
          : "所有片段已确认可交付。",
      severity: !approvedOnly && marks.length && unapprovedMarks ? "warn" : "ready",
    },
    {
      id: "copy",
      label: "交付文案",
      message: missingCopyCount ? `${missingCopyCount} 段缺少标题、备注或引用，建议补齐后再交付。` : "所有片段标题、备注和引用已就绪。",
      severity: missingCopyCount ? "warn" : "ready",
    },
    {
      id: "destination",
      label: "保存位置",
      message: destination === "custom" && !outputDir.trim() ? "自定义保存路径为空。" : `将保存到${destinationLabel}。`,
      severity: destination === "custom" && !outputDir.trim() ? "block" : "ready",
    },
    buildExportVersionPreflightCheck({ marks, sequenceDuration, targetDuration }),
    {
      id: "subtitles",
      label: "字幕安全区",
      message:
        subtitleStyle === "none"
          ? "当前版本不烧录字幕。"
          : rowsCount
            ? `${rowsCount} 段字幕将使用${subtitleStyle === "bold" ? "醒目" : subtitleStyle === "minimal" ? "极简" : "标准"}模板，位于${subtitlePositionLabel(subtitlePosition)}。`
            : "没有中文字幕可烧录，仍可导出无字幕版本。",
      severity: subtitleStyle === "none" || !rowsCount ? "warn" : "ready",
    },
    {
      id: "logo",
      label: "品牌 Logo",
      message: logoAssetId
        ? logoAsset
          ? `${logoAsset.original_filename || "品牌 Logo"} · ${logoPositionLabel(logoPosition)}${logoBottomConflict ? "，可能与字幕区域接近。" : "。"}`
          : "选择的 Logo 素材已不存在，请重新上传或关闭 Logo。"
        : "当前版本不叠加 Logo。",
      severity: logoAssetId && !logoAsset ? "block" : logoBottomConflict ? "warn" : "ready",
    },
    {
      id: "clip-length",
      label: "片段时长",
      message: shortMarks.length ? `${shortMarks.length} 段短于 3 秒，成片可能跳得太快。` : "单段时长看起来稳定。",
      severity: shortMarks.length ? "warn" : "ready",
    },
    {
      id: "sequence-length",
      label: "序列长度",
      message: lengthWarning ? "总时长偏离常见短视频范围，建议复核节奏。" : "总时长适合做短切输出。",
      severity: lengthWarning ? "warn" : "ready",
    },
    {
      id: "overlap",
      label: "重叠检查",
      message: overlaps ? `${overlaps} 段与前后片段重叠，导出会按时间顺序拼接。` : "没有发现明显重叠片段。",
      severity: overlaps ? "warn" : "ready",
    },
    {
      id: "filename",
      label: "文件名",
      message: filename.trim() ? "已设置导出文件名。" : "未填写文件名，将使用系统默认命名。",
      severity: filename.trim() ? "ready" : "warn",
    },
  ];
}

function buildHighlightSuggestions(rows: TranscriptRow[], duration: number): HighlightSuggestion[] {
  if (!rows.length) return [];
  const scored = rows
    .map((row, index) => {
      const text = `${row.zh?.text ?? ""} ${row.en?.text ?? ""}`.trim();
      const score = scoreHighlightText(text);
      return { row, index, text, score };
    })
    .filter((item) => item.score > 0 && item.text.length > 10)
    .sort((a, b) => b.score - a.score || a.row.start - b.row.start);

  const selected: HighlightSuggestion[] = [];
  for (const item of scored) {
    if (selected.length >= 6) break;
    const start = clamp(item.row.start - 4, 0, duration);
    const nextRows = rows.slice(item.index, item.index + 8);
    const nextEnd = nextRows.length ? nextRows[nextRows.length - 1].end : item.row.end;
    const end = clamp(Math.max(nextEnd + 5, start + 18), start + 1, Math.min(duration, start + 90));
    if (selected.some((suggestion) => Math.abs(suggestion.start - start) < 18)) continue;
    selected.push({
      id: `highlight-${item.index}-${Math.round(item.row.start)}`,
      start,
      end,
      label: highlightLabel(item.text),
      reason: "系统根据字幕中的观点词、论证表达和可传播性自动推荐。",
      quote: trimText(item.text, 120),
      score: item.score,
    });
  }

  if (selected.length) return selected.sort((a, b) => a.start - b.start);

  const fallbackRows = rows.filter((row) => row.end - row.start >= 3).slice(0, 4);
  return fallbackRows.map((row, index) => ({
    id: `fallback-${index}-${Math.round(row.start)}`,
    start: clamp(row.start, 0, duration),
    end: clamp(Math.max(row.end, row.start + 18), row.start + 1, duration),
    label: "待复核片段",
    reason: "字幕可用但缺少强关键词，先按早期内容给出候选。",
    quote: trimText(row.zh?.text || row.en?.text || "", 120),
    score: 1,
  }));
}

function scoreHighlightText(text: string): number {
  const normalized = text.toLowerCase();
  const terms = [
    "agent",
    "agi",
    "openai",
    "deepseek",
    "nvidia",
    "model",
    "startup",
    "product",
    "safety",
    "regulation",
    "future",
    "i think",
    "why",
    "because",
    "智能体",
    "大模型",
    "开源",
    "商业化",
    "监管",
    "风险",
    "创业",
    "产品",
    "算力",
    "未来",
    "我认为",
    "为什么",
    "关键",
    "机会",
    "趋势",
  ];
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += term.length > 4 ? 2 : 1;
  }
  if (/[?？]/.test(text)) score += 1;
  if (text.length >= 38 && text.length <= 180) score += 1;
  return score;
}

function highlightLabel(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes("agent") || text.includes("智能体")) return "Agent 观点";
  if (normalized.includes("agi") || text.includes("通用人工智能")) return "AGI 判断";
  if (normalized.includes("safety") || text.includes("安全") || text.includes("风险")) return "安全与风险";
  if (normalized.includes("startup") || text.includes("创业") || text.includes("商业化")) return "商业化观点";
  if (text.includes("未来") || text.includes("趋势") || normalized.includes("future")) return "趋势判断";
  return "观点高光";
}

function trimText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function splitTerms(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean)));
}

function joinTerms(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

function toSecondInput(seconds: number): string {
  return String(Math.round(Math.max(seconds, 0) * 10) / 10);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function defaultBeijingRange() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  beijing.setUTCDate(beijing.getUTCDate() - 1);
  const end = beijing.toISOString().slice(0, 10);
  return { start: end, end };
}

function readError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  return fallback;
}

function platformLabel(platform: string) {
  if (platform === "youtube") return "YouTube";
  if (platform === "bilibili") return "B站";
  return platform;
}

export default App;
