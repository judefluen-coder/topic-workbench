import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function importTypescriptModule(path) {
  const source = readFileSync(resolve(root, path), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const workspace = await importTypescriptModule("frontend/src/lib/workspaceState.ts");
const transcript = await importTypescriptModule("frontend/src/lib/transcriptWindow.ts");

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const exportDefaults = {
  destination: "downloads",
  output_dir: "",
  filename: "clip.mp4",
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

const editorDefaults = {
  currentTime: 0,
  exportOptions: exportDefaults,
  form: { start_seconds: "0", end_seconds: "15", label: "片段", note: "", quote: "" },
  transcriptSearch: "",
};

test("workspace state restores the selected view, date range, and video", () => {
  const storage = fakeStorage();
  workspace.saveWorkspaceState({ topicId: 8, startDate: "2026-07-01", endDate: "2026-07-03", selectedVideoId: 74, view: "editor" }, storage);
  assert.deepEqual(workspace.loadWorkspaceState(storage), {
    topicId: 8,
    startDate: "2026-07-01",
    endDate: "2026-07-03",
    selectedVideoId: 74,
    view: "editor",
  });
});

test("workspace state ignores malformed persisted data", () => {
  const storage = fakeStorage();
  storage.setItem("topic-workbench:workspace:v1", '{"startDate":"bad","view":"unknown"}');
  assert.equal(workspace.loadWorkspaceState(storage), null);
});

test("clip editor state restores drafts and sanitizes render options", () => {
  const storage = fakeStorage();
  workspace.saveClipEditorState(74, {
    ...editorDefaults,
    currentTime: 83.4,
    exportOptions: { ...exportDefaults, output_profile: "portrait", focus_x: 73 },
    form: { start_seconds: "80", end_seconds: "95", label: "观点", note: "备注", quote: "原话" },
    transcriptSearch: "agent",
  }, storage);
  const restored = workspace.loadClipEditorState(74, editorDefaults, storage);
  assert.equal(restored.currentTime, 83.4);
  assert.equal(restored.exportOptions.output_profile, "portrait");
  assert.equal(restored.exportOptions.focus_x, 73);
  assert.equal(restored.form.label, "观点");
  assert.equal(restored.transcriptSearch, "agent");

  storage.setItem("topic-workbench:editor:v1:75", '{"currentTime":-1,"exportOptions":{"output_profile":"square","focus_x":900}}');
  assert.deepEqual(workspace.loadClipEditorState(75, editorDefaults, storage), editorDefaults);
});

test("transcript window grows to keep the active caption rendered", () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({ index, text: String(index) }));
  assert.equal(transcript.buildTranscriptWindow(rows, 120, -1).length, 120);
  assert.equal(transcript.buildTranscriptWindow(rows, 120, 260).length, 280);
  assert.equal(transcript.buildTranscriptWindow(rows, 240, 10).length, 240);
});
