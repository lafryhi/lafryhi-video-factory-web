# LAFRYHI Video Factory — Web Editor

Build polished videos from images, narration, voice, music, captions and transitions, entirely in the browser. Media stays local until you export; rendering happens on the Railway render engine (FastAPI + FFmpeg).

## Stack

- **Frontend** — Vite + React + TypeScript, deployed on Vercel at <https://lafryhi-video-factory-web.vercel.app/>
- **Rendering backend** — FastAPI + FFmpeg on Railway at <https://lafryhi-video-factory-api-production.up.railway.app/>

## How the pieces connect

The browser talks to the render engine through the same origin. Vercel rewrites `/api/*` to the Railway service (see `vercel.json`), so there is no cross-origin (CORS) dependency and no browser-side configuration is required. Set `VITE_API_BASE_URL` (see `.env.example`) only if you want the browser to call Railway directly.

## Commands

```bash
npm install
npm run dev          # local dev (proxies /api to http://127.0.0.1:8000)
npm run test         # vitest
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + tests + production build to dist/
```

## Feature coverage

Project creation, storyboard scenes, timeline editing (cut/move/split/trim), image/media import, per-scene narration, voice track, background music, captions/text overlays, transitions, live preview, project save/load, portable `.lvf` project packages, landscape 16:9 and vertical 9:16 output, and video rendering/export via Railway.

## Google Flow Production Assistant

Choose **Prepare for Google Flow** in the editor toolbar (also available on the backend connection error screen). Enter an idea in English, choose an audience, aspect ratio, and target duration, then review the suggested master character and global style. The **Preschool Educational Video** preset targets ages 3–8 with cheerful 3D animation, safe behavior, and no scary content or unrequested on-screen text.

Prepare the package to create editable scene directions, exact planned editing durations, English scene prompts, a whole-video master prompt, and a recommended scene order. This is a local template-based writing assistant, not an AI model or video generator. It requires no API key, paid API, Supabase, or network request. Review the suggested actions and narration before copying them into Flow.

Copy individual scenes, all prompts, the master character, or the master prompt; export the full package as TXT, Markdown, or JSON. Character and style changes update prompts immediately; changing the production brief requires preparing again, which replaces scene edits. Drafts survive closing the panel but not a page reload, so export before leaving. Scene durations are editing targets: use available Flow clip lengths and trim or extend during assembly. The existing Railway/FFmpeg editor and export workflow remain intact.

## Note on the old three-tool toolbox

The previous "Merge / Trim / Cinematic Transition" toolbox is preserved, unmodified, under `legacy-toolbox/`. It is no longer the primary interface and is not part of this build. The full source is also retained in this repository's git history and in the local backup folder.
