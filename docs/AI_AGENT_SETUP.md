# Setup With A Coding Agent

This guide is for users who want to give the GitHub link to Codex, Claude Code, Cursor, Cline, or another local coding agent and ask it to install the project.

The short answer: a coding agent can install most local dependencies if it has terminal access and the user approves system-level installs. It cannot create API keys, log in to accounts, bypass platform permissions, or grant media rights on behalf of the user.

## Prompt To Give Your Agent

```text
Please install and run this local project:
https://github.com/judefluen-coder/topic-workbench

Goal:
- Make the app available at http://127.0.0.1:5173
- Run the dependency check first
- Install missing required dependencies
- Run setup and tests
- Explain any optional dependencies that are missing

Important:
- Do not add paid cloud APIs by default.
- Do not create or guess API keys.
- Do not commit .env, downloaded videos, subtitles, databases, or exported clips.
- Ask me before installing global tools or large model files.
```

## What The Agent Can Usually Install

After cloning the repo:

```bash
npm run doctor
npm run setup
npm run test
npm run dev
```

`npm run setup` installs:

- Backend Python packages, including FastAPI, yt-dlp, and Argos Translate.
- Frontend npm packages.
- `.env` copied from `.env.example` when missing.

## Required System Dependencies

These must exist on the user's computer before the app can fully run:

- Node.js / npm: Node must be >=20.19.0 or >=22.12.0
- uv

Media features also need FFmpeg for reliable YouTube audio/video merging, audio extraction, and clip export. `npm run setup` can continue without FFmpeg so the app can start, but real video processing will be degraded until FFmpeg is installed.

On macOS, a coding agent can usually install them with Homebrew:

```bash
brew install node uv ffmpeg
```

On Linux or Windows/WSL2, ask the agent to use the package manager appropriate for that system.

## Optional Enhancements

These are useful, but not required for the basic app to run.

### opencli

Used as a fallback YouTube search source when no YouTube Data API key is configured.

```bash
npm install -g @jackwener/opencli
opencli --version
```

### Ollama

Used as a local LLM translation fallback.

```bash
brew install ollama
ollama pull qwen2.5:7b
```

Ollama model files can be large, so the agent should ask the user before pulling a model.

### faster-whisper

Used for local speech-to-text when a video has no usable subtitles.

```bash
uv sync --project backend --extra local-asr
```

Then set this in `.env`:

```env
LOCAL_ASR_ENABLED=true
```

### OpenAI Cloud Fallback

Not used by default. Install only if the user explicitly wants paid cloud transcription or translation.

```bash
uv sync --project backend --extra cloud-ai
```

Then set this in `.env`:

```env
CLOUD_AI_ENABLED=true
OPENAI_API_KEY=your_key_here
```

### XiaDown

XiaDown is not an embedded dependency and is not the app's built-in download engine. It can be used as a separate companion downloader for complex pages or logged-in browser sessions. Downloaded, authorized media can then be imported into Tech PR Workbench.

Ask the agent to follow the upstream XiaDown project instructions:

```text
https://github.com/arnoldhao/xiadown
```

## Things The Agent Cannot Do Automatically

- Create a YouTube Data API key without the user's Google Cloud access.
- Create an OpenAI API key without the user's OpenAI account.
- Log in to YouTube, Bilibili, XiaDown, or other services without user permission.
- Decide whether the user has legal rights to download or republish a video.
- Install Homebrew, system packages, global npm packages, or large model files without user approval on many machines.

## Recommended First-Run Checklist

1. Clone the repo.
2. Run `npm run doctor`.
3. Install missing required dependencies, and install FFmpeg before real video processing.
4. Run `npm run setup`.
5. Run `npm run test`.
6. Run `npm run dev`.
7. Open `http://127.0.0.1:5173`.
8. Optionally configure `YOUTUBE_API_KEY` for more reliable discovery.
