export type VideoStatus =
  | "new"
  | "shortlisted"
  | "imported"
  | "translated"
  | "clipped"
  | "exported"
  | "archived"
  | "discovered"
  | "summarizing"
  | "ready"
  | "downloading"
  | "subtitle_fetching"
  | "transcribing"
  | "translating"
  | "clip_ready"
  | "failed";

export interface DashboardData {
  date: string;
  status_counts: Record<string, number>;
  top_videos: Video[];
  latest_job: Job | null;
  clip_count: number;
  people_count: number;
  compliance_note: string;
}

export interface Job {
  id: number;
  type: string;
  status: string;
  message: string;
  payload: string;
  result: string;
  progress: number;
  attempts: number;
  created_at: string;
  updated_at: string;
  video_id?: number | null;
  video_title?: string;
  video_url?: string;
  topic_id?: number;
}

export type TopicRankingMode = "balanced" | "people" | "popular" | "latest";

export interface Topic {
  id: number;
  name: string;
  description: string;
  keywords: string[];
  excluded_keywords: string[];
  focus_people: string[];
  channel_terms: string[];
  bilibili_channel_uids: string[];
  sources: Array<"youtube" | "bilibili">;
  ranking_mode: TopicRankingMode;
  video_count: number;
  clip_count: number;
  created_at: string;
  updated_at: string;
}

export type TopicInput = Omit<Topic, "id" | "video_count" | "clip_count" | "created_at" | "updated_at">;

export interface SourceRun {
  name: string;
  tier: "stable" | "experimental" | string;
  status: string;
  message: string;
}

export interface DailyReport {
  date: string;
  start_date: string;
  end_date: string;
  topic: Topic;
  timezone: string;
  window_start: string;
  window_end: string;
  items: Video[];
  source_runs: SourceRun[];
  latest_job: Job | null;
  job_id?: number;
  run_result?: Record<string, unknown>;
}

export interface Person {
  id: number;
  name: string;
  english_name: string;
  aliases: string;
  priority: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: number;
  topic_id: number;
  platform: string;
  external_id: string;
  url: string;
  title: string;
  description: string;
  channel_title: string;
  published_at: string;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  thumbnail_url: string;
  matched_people: string;
  candidate_people: string;
  people_match_reason: string;
  interview_confidence: number;
  priority_score: number;
  status: VideoStatus;
  compliance_note: string;
  summary: string;
  source_tier: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface Transcript {
  id: number;
  video_id: number;
  language: "en" | "zh";
  start_seconds: number;
  end_seconds: number;
  text: string;
  source: string;
  created_at: string;
}

export interface ClipMark {
  id: number;
  video_id: number;
  start_seconds: number;
  end_seconds: number;
  label: string;
  note: string;
  quote: string;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MediaAsset {
  id: number;
  kind: string;
  original_filename: string;
  stored_path: string;
  authorization_note: string;
  delete_after_processing: number;
  processing_status: string;
  created_at: string;
  url: string;
}

export interface VideoDetail {
  video: Video;
  transcripts: Transcript[];
  clip_marks: ClipMark[];
  media_assets: MediaAsset[];
}

export interface ClipPayload extends VideoDetail {
  media_url: string;
}

export interface RenderedClip {
  id: number;
  label: string;
  start_seconds: number;
  end_seconds: number;
  path: string;
  url: string;
}

export interface ClipRenderOptions {
  destination: string;
  output_dir: string;
  filename: string;
  target_duration_seconds: number;
  clip_status_filter: string;
  output_profile: "source" | "landscape" | "portrait";
  fit_mode: "crop" | "contain";
  focus_x: number;
  subtitle_style: "standard" | "bold" | "minimal" | "none";
  subtitle_position: "bottom" | "lower_third";
  logo_asset_id: number | null;
  logo_position: "top_left" | "top_right" | "bottom_left" | "bottom_right";
}

export interface ClipRenderResult {
  message: string;
  export_dir: string;
  sequence_path: string;
  sequence_url: string;
  saved_path: string;
  target_duration_seconds: number;
  clip_status_filter: string;
  rendered_duration_seconds: number;
  output_profile?: ClipRenderOptions["output_profile"];
  output_width?: number;
  output_height?: number;
  fit_mode?: ClipRenderOptions["fit_mode"];
  focus_x?: number;
  subtitle_style?: ClipRenderOptions["subtitle_style"];
  subtitle_position?: ClipRenderOptions["subtitle_position"];
  logo_asset_id?: number | null;
  logo_position?: ClipRenderOptions["logo_position"];
  clips: RenderedClip[];
}

export interface SystemCheck {
  ok: boolean;
  label: string;
  message: string;
}

export type SystemStatus = Record<string, SystemCheck>;

export interface AutomationResult {
  ok: boolean;
  actions: Array<{ step: string; status: string; video_id?: number; message: string }>;
}
