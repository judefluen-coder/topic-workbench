import type { ClipRenderOptions } from "../types";

export type WorkspaceView = "discovery" | "tasks" | "editor";

export interface WorkspaceState {
  topicId: number | null;
  startDate: string;
  endDate: string;
  selectedVideoId: number | null;
  view: WorkspaceView;
}

export interface ClipEditorState {
  currentTime: number;
  exportOptions: ClipRenderOptions;
  form: {
    start_seconds: string;
    end_seconds: string;
    label: string;
    note: string;
    quote: string;
  };
  transcriptSearch: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKSPACE_KEY = "topic-workbench:workspace:v1";

export function loadWorkspaceState(storage: StorageLike | null = browserStorage()): WorkspaceState | null {
  const value = readJson(storage, WORKSPACE_KEY);
  if (!value || !isDate(value.startDate) || !isDate(value.endDate) || !isWorkspaceView(value.view)) return null;
  const selectedVideoId = positiveInteger(value.selectedVideoId);
  return {
    topicId: positiveInteger(value.topicId),
    startDate: value.startDate,
    endDate: value.endDate,
    selectedVideoId,
    view: value.view,
  };
}

export function saveWorkspaceState(state: WorkspaceState, storage: StorageLike | null = browserStorage()): void {
  writeJson(storage, WORKSPACE_KEY, state);
}

export function loadClipEditorState(videoId: number, defaults: ClipEditorState, storage: StorageLike | null = browserStorage()): ClipEditorState {
  const value = readJson(storage, editorKey(videoId));
  if (!value) return defaults;
  const form = value.form && typeof value.form === "object" ? value.form : {};
  return {
    currentTime: finiteNonNegative(value.currentTime, defaults.currentTime),
    exportOptions: normalizeExportOptions(value.exportOptions, defaults.exportOptions),
    form: {
      start_seconds: text(form.start_seconds, defaults.form.start_seconds),
      end_seconds: text(form.end_seconds, defaults.form.end_seconds),
      label: text(form.label, defaults.form.label),
      note: text(form.note, defaults.form.note),
      quote: text(form.quote, defaults.form.quote),
    },
    transcriptSearch: text(value.transcriptSearch, defaults.transcriptSearch),
  };
}

export function saveClipEditorState(videoId: number, state: ClipEditorState, storage: StorageLike | null = browserStorage()): void {
  if (!Number.isInteger(videoId) || videoId <= 0) return;
  writeJson(storage, editorKey(videoId), state);
}

function normalizeExportOptions(value: unknown, defaults: ClipRenderOptions): ClipRenderOptions {
  const raw = value && typeof value === "object" ? (value as Partial<ClipRenderOptions>) : {};
  return {
    destination: text(raw.destination, defaults.destination),
    output_dir: text(raw.output_dir, defaults.output_dir),
    filename: text(raw.filename, defaults.filename),
    target_duration_seconds: finiteRange(raw.target_duration_seconds, defaults.target_duration_seconds, 0, 600),
    clip_status_filter: choice(raw.clip_status_filter, ["all", "approved"], defaults.clip_status_filter),
    output_profile: choice(raw.output_profile, ["source", "landscape", "portrait"], defaults.output_profile),
    fit_mode: choice(raw.fit_mode, ["crop", "contain"], defaults.fit_mode),
    focus_x: finiteRange(raw.focus_x, defaults.focus_x, 0, 100),
    subtitle_style: choice(raw.subtitle_style, ["standard", "bold", "minimal", "none"], defaults.subtitle_style),
    subtitle_position: choice(raw.subtitle_position, ["bottom", "lower_third"], defaults.subtitle_position),
    logo_asset_id: positiveInteger(raw.logo_asset_id),
    logo_position: choice(raw.logo_position, ["top_left", "top_right", "bottom_left", "bottom_right"], defaults.logo_position),
  };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function editorKey(videoId: number): string {
  return `topic-workbench:editor:v1:${videoId}`;
}

function readJson(storage: StorageLike | null, key: string): Record<string, any> | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage can be unavailable or full; editing must continue in memory.
  }
}

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return value === "discovery" || value === "tasks" || value === "editor";
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function finiteRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : fallback;
}
