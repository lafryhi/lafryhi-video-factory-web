# LAFRYHI Video Factory Web

A privacy-first collection of free browser-based video tool pages.

## Included in this implementation

- Premium responsive landing page
- Dedicated SEO route for each of 10 planned tools
- No-account file selection workflow
- Typed centralized tool registry for route, UI, SEO, readiness, input/output, analytics category and future option metadata
- Working client-side **Merge Videos** workflow powered by FFmpeg WebAssembly
- Coming-soon processing placeholders for the remaining tools
- Google Analytics 4 integration
- Microsoft Clarity integration
- Vercel-ready configuration
- CI validation for linting, type checking, production builds and local validation

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Validate locally

Run these checks before opening a pull request:

```bash
npm run lint
npm run typecheck
npm run build
```

Use `npm run validate` to run linting, type checking and the production build in sequence.

## Analytics setup

Create `.env.local` and add:

```env
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX
NEXT_PUBLIC_CLARITY_ID=xxxxxxxxxx
NEXT_PUBLIC_SITE_URL=https://video.lafryhi.com
```

Analytics counts visitors without requiring user accounts. GA4 is configured with IP anonymization. Clarity is optional.

## Deployment

1. Push the folder to a GitHub repository.
2. Import the repository into Vercel.
3. Add the three environment variables in Vercel Project Settings.
4. Deploy.

## Current tool status

Live client-side processing:
- Merge Videos

Coming soon:
- Trim Video
- Compress Video
- Resize Video
- Remove Audio
- Convert to MP4
- Extract Audio
- Image to Video
- Video Speed
- Reverse Video

Merge Videos runs fully in the browser. Files are not uploaded to a backend service, but FFmpeg assets are loaded by the browser and processing depends on device CPU, memory and browser WebAssembly support. Large clips, many clips, unsupported codecs or low-memory mobile browsers may fail and should be retried with smaller inputs.

## Merge strategy

The merge workflow intentionally does not use FFmpeg stream-copy concat as the default path because that approach is only reliable when every user-provided file has matching codecs, dimensions, time bases and stream layouts. User uploads are often mixed, so Merge Videos uses FFmpeg's concat demuxer with H.264/AAC re-encoding and exports an MP4 file.

Re-encoding improves compatibility for the first working browser tool, but it can change quality, increase processing time and use significant memory. This project does not claim original-quality preservation for merged exports.
