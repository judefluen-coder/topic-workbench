import type { AutomationResult, ClipMark, ClipPayload, ClipRenderOptions, DailyReport, DashboardData, Job, MediaAsset, Person, SystemStatus, Topic, TopicInput, Video, VideoDetail, VideoStatus } from "../types";
import { demoApi } from "./demoApi";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

const liveApi = {
  topics: () => request<Topic[]>("/api/topics"),
  createTopic: (payload: TopicInput) => request<Topic>("/api/topics", { method: "POST", body: JSON.stringify(payload) }),
  updateTopic: (id: number, payload: Partial<TopicInput>) => request<Topic>(`/api/topics/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  daily: (params: { topic_id?: number; date?: string; start_date?: string; end_date?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.topic_id) search.set("topic_id", String(params.topic_id));
    if (params.date) search.set("date", params.date);
    if (params.start_date) search.set("start_date", params.start_date);
    if (params.end_date) search.set("end_date", params.end_date);
    const query = search.toString();
    return request<DailyReport>(`/api/daily${query ? `?${query}` : ""}`);
  },
  runDaily: (payload: { topic_id?: number; date?: string; start_date?: string; end_date?: string; limit_per_query?: number } = {}) =>
    request<DailyReport>("/api/daily/run", { method: "POST", body: JSON.stringify(payload) }),
  jobs: (topicId?: number) => request<Job[]>(`/api/jobs?limit=200${topicId ? `&topic_id=${topicId}` : ""}`),
  job: (id: number) => request<Job>(`/api/jobs/${id}`),
  retryJob: (id: number) => request<Job>(`/api/jobs/${id}/retry`, { method: "POST" }),
  dashboard: () => request<DashboardData>("/api/dashboard"),
  systemStatus: () => request<SystemStatus>("/api/system/status"),
  runAutomation: (payload: { days_back: number; limit_per_query: number; shortlist_threshold: number; auto_download: boolean; authorization_note: string; auto_transcribe: boolean }) =>
    request<AutomationResult>("/api/automation/run", { method: "POST", body: JSON.stringify(payload) }),
  people: () => request<Person[]>("/api/people"),
  addPerson: (payload: Partial<Person>) => request<Person>("/api/people", { method: "POST", body: JSON.stringify(payload) }),
  videos: (params: { status?: VideoStatus | "all"; search?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.status && params.status !== "all") search.set("status", params.status);
    if (params.search) search.set("search", params.search);
    const query = search.toString();
    return request<Video[]>(`/api/videos${query ? `?${query}` : ""}`);
  },
  videoDetail: (id: number) => request<VideoDetail>(`/api/videos/${id}`),
  updateVideoStatus: (id: number, status: VideoStatus) =>
    request<Video>(`/api/videos/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  syncYoutube: () => request<{ message: string; inserted: number; mode: string }>("/api/sync/youtube", { method: "POST", body: JSON.stringify({}) }),
  downloadVideo: (id: number, payload: { authorization_note: string; quality: string; include_subtitles: boolean; include_thumbnail: boolean }) =>
    request<{ message: string }>(`/api/videos/${id}/download`, { method: "POST", body: JSON.stringify(payload) }),
  downloadTranslate: (id: number, payload: { authorization_note?: string; quality?: string } = {}) =>
    request<Job & { job_id: number; video_id: number }>(`/api/items/${id}/download-translate`, { method: "POST", body: JSON.stringify(payload) }),
  reprocessSubtitles: (id: number) =>
    request<Job & { job_id: number; video_id: number }>(`/api/items/${id}/reprocess-subtitles`, { method: "POST" }),
  clipPayload: (id: number) => request<ClipPayload>(`/api/items/${id}/clip`),
  renderClips: (id: number, payload: ClipRenderOptions) =>
    request<Job>(`/api/items/${id}/render-clips`, { method: "POST", body: JSON.stringify(payload) }),
  uploadBrandLogo: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<MediaAsset>(`/api/items/${id}/brand-logo`, { method: "POST", body: form });
  },
  deleteClip: (id: number) => request<{ message: string }>(`/api/clip-marks/${id}`, { method: "DELETE" }),
  updateClip: (id: number, payload: Pick<ClipMark, "start_seconds" | "end_seconds" | "label" | "note" | "quote" | "status">) =>
    request<ClipMark>(`/api/clip-marks/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  reorderClips: (videoId: number, clipMarkIds: number[]) =>
    request<{ message: string; clip_marks: ClipMark[] }>(`/api/items/${videoId}/clip-order`, { method: "POST", body: JSON.stringify({ clip_mark_ids: clipMarkIds }) }),
  importMedia: (form: FormData) => request<{ message: string }>("/api/media/import", { method: "POST", body: form }),
  transcribe: (id: number) => request<{ message: string; segments: number }>(`/api/videos/${id}/transcribe`, { method: "POST" }),
  createClip: (payload: Omit<ClipMark, "id" | "position" | "created_at" | "updated_at">) =>
    request<ClipMark>("/api/clip-marks", { method: "POST", body: JSON.stringify(payload) }),
};

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === "true";
export const api = isDemoMode ? { ...liveApi, ...demoApi } : liveApi;
