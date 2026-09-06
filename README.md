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

## Note on the old three-tool toolbox

The previous "Merge / Trim / Cinematic Transition" toolbox is preserved, unmodified, under `legacy-toolbox/`. It is no longer the primary interface and is not part of this build. The full source is also retained in this repository's git history and in the local backup folder.