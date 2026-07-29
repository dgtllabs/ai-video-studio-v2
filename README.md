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

## Troubleshooting

The app now shows the *actual* error text from the provider in the toast
message (not just "something went wrong"), so you can usually tell what's
wrong straight from the screen. A few things you might see:

- **"Gemini rejected that key (HTTP 401/403): API_KEY_SERVICE_BLOCKED"** —
  this is a known, currently-widespread Google-side issue affecting keys
  created under AI Studio's auto-generated **"Default Gemini Project"**,
  unrelated to anything you did wrong. Two things that often fix it:
  1. In [Google AI Studio](https://aistudio.google.com/app/apikey), create
     the key under a different (or newly created) Google Cloud project
     instead of "Default Gemini Project".
  2. If that project doesn't have the **Generative Language API** enabled,
     enable it in the Google Cloud Console for that project, then create
     the key again.
  If neither helps immediately, it's worth waiting — this class of error
  has come and gone in bursts as Google rolls out backend changes.
- **"Rate limited by Gemini/OpenAI"** — you've hit the free/plan quota
  temporarily. Wait a minute and try again.
- **"Could not reach Gemini: Failed to fetch"** — usually a real network
  problem (no connection, a VPN/firewall blocking Google's API domain, or
  the browser blocking the request). Try switching networks or disabling a
  VPN and retry.
- **"The model replied but not in the expected format"** — occasionally the
  model's output isn't valid JSON. This is usually a one-off; press
  **Run AI Analysis** again.

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
