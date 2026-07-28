# AI Video Intelligence Studio

A premium, 100%-client-side SaaS-style app that reverse-engineers a short-form
video: viral scoring (9 metrics, each explained), full creative reverse
engineering, a scene-by-scene breakdown, ready-to-use production assets
(storyboards, prompts, scripts), and a "🔥 Make It Better" mode that generates
a stronger, original concept.

Three files. No build step, no backend, no database.

```
index.html
style.css
script.js
```

## How it works

1. **Local ingest (no AI, no network):** the video is read directly in your
   browser — duration, resolution, frame rate, file size — and sampled onto
   an offscreen canvas to detect scene cuts from frame-to-frame differences.
   A small thumbnail is captured for each detected scene.
2. **AI analysis (your choice of provider, your own key):** those scene
   thumbnails + timestamps are sent straight from your browser to whichever
   provider you connect, which returns the full creative teardown: signals,
   9 viral scores with explanations, reverse-engineering insights, the scene
   table, and every production asset.
3. **🔥 Make It Better:** a second AI call takes a compact summary of the
   analysis and returns a stronger, original alternative concept — never a
   copy of the source video.

## Choosing a provider

Click **Connect a free AI key** in the header — you get a choice of two:

- **Google Gemini — free, no credit card.** Recommended for getting started.
  Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
  Uses `gemini-2.5-flash` by default (vision-capable, generous free daily
  quota). No billing setup, no card required.
- **OpenAI — paid.** Needs a card on file and a small minimum top-up
  (~$5). Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
  Uses `gpt-4o` by default.

Both keys, if you save both, are kept separately in this browser's
`localStorage` (never hardcoded anywhere in the code, never sent anywhere but
straight to the provider you chose) — switching providers in the dropdown
doesn't erase the other one's saved key. Remove either key anytime from the
same panel.

## Deploying to GitHub Pages

1. Push `index.html`, `style.css`, and `script.js` to the root of a GitHub
   repository.
2. In the repo, go to **Settings → Pages**, set **Source** to your default
   branch / `(root)`, and save.
3. Your Studio is live at `https://<username>.github.io/<repo-name>/` within
   a minute or two. No `npm install`, no build command, no server config.

## Cost & limits to know

- Scene sampling is capped at 12 representative scenes per video (adaptive
  scene-cut threshold) to keep each analysis call fast; thumbnails are sent
  at a low-detail/inline-data setting to minimize tokens either way.
- Gemini's free tier is rate-limited (a handful of requests per minute, plus
  a daily cap that varies by model) — plenty for personal use, but you may
  need to wait a moment between analyses if you hit a limit.
- Frame-rate detection relies on `requestVideoFrameCallback`, supported in
  Chromium-based browsers; where it isn't available the app shows "Not
  available" rather than guessing.
- Nothing about your video is ever uploaded anywhere — only small JPEG scene
  thumbnails go to the provider you connected, and only once you've saved a
  key and pressed **Run AI Analysis**.
