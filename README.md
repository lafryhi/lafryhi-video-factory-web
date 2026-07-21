# LAFRYHI Video Factory Web

A privacy-first collection of free browser-based video tools.

## Included in this first implementation

- Premium responsive landing page
- Dedicated SEO route for each of 10 tools
- No-account upload workflow
- Browser-local processing architecture using FFmpeg WebAssembly
- Working **Remove Audio** tool
- Working **Extract Audio** tool
- Google Analytics 4 integration
- Microsoft Clarity integration
- Vercel-ready configuration

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

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

Live processing:
- Remove Audio
- Extract Audio

Prepared routes, UI, analytics events and file workflow:
- Merge Videos
- Trim Video
- Compress Video
- Resize Video
- Convert to MP4
- Image to Video
- Video Speed
- Reverse Video

These remaining engines should be activated in focused batches to keep exports reliable across mobile browsers.
