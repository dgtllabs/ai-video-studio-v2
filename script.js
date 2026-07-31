'use strict';
/* =========================================================================
   AI VIDEO INTELLIGENCE STUDIO
   Single-file, modular vanilla JS. Organized into namespaced sections:

     Utils        — small pure helpers
     Storage      — OpenAI key/model persistence (localStorage only)
     VideoIngest  — local, in-browser video metadata + scene sampling
     AIClient     — all calls to the AI provider (Gemini free tier, or OpenAI)
     UI           — DOM caching + rendering
     Exporter     — TXT / Markdown / JSON export
     App          — wires everything together

   No backend. No build step. Every network call goes straight from this
   browser to OpenAI's API using the user's own key.
   ========================================================================= */

/* ============================= UTILS ============================= */
const Utils = (() => {
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function fmtTime(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function fmtBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function scoreColor(score) {
    if (score >= 70) return 'var(--score-high)';
    if (score >= 45) return 'var(--score-mid)';
    return 'var(--score-low)';
  }

  /** Strip markdown code fences and pull the first {...} block out of a model reply. */
  function parseJsonLoose(text) {
    if (!text) return null;
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); }
    catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) { try { return JSON.parse(match[0]); } catch { return null; } }
      return null;
    }
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  return { clamp, fmtTime, fmtBytes, scoreColor, parseJsonLoose, escapeHtml };
})();

/* ============================= STORAGE ============================= */
// Handles the user's own API key(s). Local storage only — never hardcoded,
// never transmitted anywhere but directly to the chosen provider's API.
// Two providers are supported, each with its own saved key + model, so
// switching providers never wipes out the other one's saved key:
//   'gemini' — Google Gemini API, free tier, no credit card required.
//   'openai' — OpenAI API, paid (small minimum top-up required).
const Storage = (() => {
  const PROVIDER = 'avis_provider';
  const DEFAULTS = {
    gemini: { keyName: 'avis_gemini_key', modelName: 'avis_gemini_model', defaultModel: 'gemini-3.5-flash' },
    openai: { keyName: 'avis_openai_key', modelName: 'avis_openai_model', defaultModel: 'gpt-4o' },
  };

  function getProvider() { return localStorage.getItem(PROVIDER) || 'gemini'; }
  function setProvider(p) { localStorage.setItem(PROVIDER, p); }

  function getKey(provider = getProvider()) { return localStorage.getItem(DEFAULTS[provider].keyName) || ''; }
  function setKey(k, provider = getProvider()) { localStorage.setItem(DEFAULTS[provider].keyName, k); }
  function removeKey(provider = getProvider()) { localStorage.removeItem(DEFAULTS[provider].keyName); }
  function getModel(provider = getProvider()) { return localStorage.getItem(DEFAULTS[provider].modelName) || DEFAULTS[provider].defaultModel; }
  function setModel(m, provider = getProvider()) { localStorage.setItem(DEFAULTS[provider].modelName, m); }
  function hasKey(provider = getProvider()) { return getKey(provider).trim().length > 0; }
  function maskedKey(provider = getProvider()) {
    const k = getKey(provider);
    if (!k) return '';
    return `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
  }

  return { getProvider, setProvider, getKey, setKey, removeKey, getModel, setModel, hasKey, maskedKey };
})();

/* ============================= VIDEO INGEST ============================= */
// Everything here runs entirely on-device: metadata reading, frame sampling
// on an offscreen canvas, and scene-cut detection from frame-to-frame
// difference. No AI is used or needed for this stage.
const VideoIngest = (() => {
  const SAMPLE_W = 48, SAMPLE_H = 27;
  const MAX_RAW_SAMPLES = 70;
  const MAX_SCENES_FOR_AI = 12; // keep the AI payload (and cost) bounded

  function waitFor(el, evt) {
    return new Promise((resolve, reject) => {
      const onErr = () => { cleanup(); reject(new Error('FILE_READ_ERROR')); };
      const onOk = () => { cleanup(); resolve(); };
      function cleanup() { el.removeEventListener(evt, onOk); el.removeEventListener('error', onErr); }
      el.addEventListener(evt, onOk, { once: true });
      el.addEventListener('error', onErr, { once: true });
    });
  }

  function seekTo(el, t) {
    return new Promise((resolve) => {
      const onSeeked = () => { el.removeEventListener('seeked', onSeeked); resolve(); };
      el.addEventListener('seeked', onSeeked, { once: true });
      el.currentTime = t;
    });
  }

  /** Best-effort frame-rate probe using requestVideoFrameCallback where available. */
  function probeFrameRate(videoEl) {
    return new Promise((resolve) => {
      if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
        resolve(null);
        return;
      }
      let count = 0;
      let start = null;
      const startTime = videoEl.currentTime;
      const finish = (fps) => {
        videoEl.pause();
        videoEl.currentTime = startTime;
        resolve(fps);
      };
      const tick = (now, meta) => {
        if (start === null) start = meta.mediaTime;
        count++;
        const elapsed = meta.mediaTime - start;
        if (elapsed >= 0.9 && count > 3) {
          finish(Math.round(count / elapsed));
          return;
        }
        if (elapsed > 2.5) { finish(null); return; }
        videoEl.requestVideoFrameCallback(tick);
      };
      videoEl.muted = true;
      videoEl.play().then(() => videoEl.requestVideoFrameCallback(tick)).catch(() => resolve(null));
      setTimeout(() => resolve(null), 3000); // hard safety timeout
    });
  }

  function computeFrameMetrics(data) {
    let r = 0, g = 0, b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    r /= n; g /= n; b /= n;
    return { r, g, b, brightness: (r + g + b) / 3, warmth: r - b, saturation: Math.max(r, g, b) - Math.min(r, g, b) };
  }

  function meanAbsDiff(a, b) {
    let sum = 0;
    const n = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      const lumaA = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      const lumaB = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
      sum += Math.abs(lumaA - lumaB);
    }
    return sum / n;
  }

  /** Sample the video and collapse frames into a bounded list of scenes with thumbnails. */
  async function extractScenes(videoEl, duration, onProgress) {
    const sampleCount = Math.min(MAX_RAW_SAMPLES, Math.max(10, Math.floor(duration / 0.4)));
    const interval = duration / sampleCount;

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W; canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 220;
    thumbCanvas.height = Math.round(220 * ((videoEl.videoHeight / videoEl.videoWidth) || 0.56));
    const thumbCtx = thumbCanvas.getContext('2d');

    const frames = [];
    let prevData = null;

    for (let i = 0; i < sampleCount; i++) {
      const t = Math.min(duration - 0.05, i * interval);
      await seekTo(videoEl, t);
      ctx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
      const imgData = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const metrics = computeFrameMetrics(imgData);
      const diff = prevData ? meanAbsDiff(prevData, imgData) : 0;
      prevData = imgData;

      thumbCtx.drawImage(videoEl, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.6);

      frames.push({ t, ...metrics, diff, thumbUrl });
      onProgress(Math.round(((i + 1) / sampleCount) * 100));
    }

    // Adaptive threshold so we always land near/under MAX_SCENES_FOR_AI scenes.
    let threshold = 22;
    let cutIndices = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      cutIndices = [0];
      for (let i = 1; i < frames.length; i++) if (frames[i].diff >= threshold) cutIndices.push(i);
      const merged = [cutIndices[0]];
      for (let i = 1; i < cutIndices.length; i++) {
        if (frames[cutIndices[i]].t - frames[merged[merged.length - 1]].t >= 0.5) merged.push(cutIndices[i]);
      }
      cutIndices = merged;
      if (cutIndices.length <= MAX_SCENES_FOR_AI) break;
      threshold += 8;
    }

    const scenes = cutIndices.map((startIdx, i) => {
      const endIdx = i + 1 < cutIndices.length ? cutIndices[i + 1] : frames.length - 1;
      const startT = frames[startIdx].t;
      const endT = i + 1 < cutIndices.length ? frames[cutIndices[i + 1]].t : duration;
      const slice = frames.slice(startIdx, Math.max(endIdx, startIdx + 1));
      const avg = (key) => slice.reduce((s, f) => s + f[key], 0) / slice.length;
      return {
        index: i + 1,
        startTime: startT,
        endTime: endT,
        thumbUrl: frames[startIdx].thumbUrl,
        brightness: avg('brightness'),
        warmth: avg('warmth'),
        saturation: avg('saturation'),
        motionScore: avg('diff'),
      };
    });

    return scenes;
  }

  /** Full local ingest pipeline: metadata + scenes. */
  async function ingest(file, videoEl, onProgress) {
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    videoEl.muted = true;
    onProgress(2, 'metadata');
    await waitFor(videoEl, 'loadedmetadata');

    const duration = videoEl.duration;
    const width = videoEl.videoWidth;
    const height = videoEl.videoHeight;

    onProgress(8, 'metadata');
    const fps = await probeFrameRate(videoEl).catch(() => null);

    onProgress(15, 'scenes');
    const scenes = await extractScenes(videoEl, duration, (p) => onProgress(15 + Math.round(p * 0.55), 'scenes'));

    return {
      fileName: file.name,
      fileType: file.type || 'video/*',
      fileSize: file.size,
      duration, width, height,
      fps: fps || null,
      scenes,
      objectUrl: url,
    };
  }

  return { ingest };
})();

/* ============================= AI CLIENT ============================= */
// Talks to whichever provider is currently selected in Storage. Both
// providers get the same analysis schema and the same scene thumbnails —
// only the request/response shape differs, handled by callGemini/callOpenAI
// near the bottom of this module.
const AIClient = (() => {

  const ANALYSIS_SCHEMA = `Respond with ONLY a single raw JSON object — no markdown fences, no commentary before or after. Use exactly this shape:

{
  "signals": {
    "hook": "", "storytelling": "", "emotionalFlow": "", "audiencePsychology": "",
    "sellingStrategy": "", "entertainmentStrategy": "", "productIntegration": "",
    "character": "", "cameraAngle": "", "cameraMovement": "", "shotType": "",
    "lighting": "", "colorGrading": "", "motion": "", "environment": "",
    "productVisibility": "", "facialExpression": "", "subtitleStyle": "",
    "voiceOverStyle": "", "cta": "", "musicMood": "", "sceneTiming": "", "sceneChanges": ""
  },
  "scores": {
    "stopScroll": {"score": 0, "explanation": ""},
    "entertainment": {"score": 0, "explanation": ""},
    "curiosity": {"score": 0, "explanation": ""},
    "watchTime": {"score": 0, "explanation": ""},
    "emotionalImpact": {"score": 0, "explanation": ""},
    "trust": {"score": 0, "explanation": ""},
    "sellingEffectiveness": {"score": 0, "explanation": ""},
    "checkoutPotential": {"score": 0, "explanation": ""},
    "overall": {"score": 0, "explanation": ""}
  },
  "reverseEngineering": {
    "whyHookWorks": "", "whyViewersContinue": "", "emotionsTriggered": "",
    "howProductIntroduced": "", "whyProductFeelsNatural": "", "whyViewersTrust": "",
    "whyLikelyToCheckout": "", "howToImprove": "",
    "strengths": ["", ""], "weaknesses": ["", ""]
  },
  "scenes": [
    {"index": 1, "purpose": "", "visual": "", "camera": "", "motion": "", "emotion": "", "voiceOver": "", "subtitle": "", "transition": ""}
  ],
  "assets": {
    "winningConcept": "", "creativeBlueprint": "", "tiktokStoryboard": "",
    "masterPrompt": "", "videoGenPrompt": "",
    "voiceOverScript": "", "caption": "", "cta": "",
    "alternativeHooks": ["", "", ""], "alternativeConcepts": ["", ""]
  }
}

Every "scenes" entry must correspond, in order, to the scene frames provided below. All string fields must be filled with real, specific analysis — never leave a field empty or generic.

ATURAN WAJIB UNTUK "assets.masterPrompt" (PROMPT PERTAMA — HANYA UNTUK IMAGE GRID STORYBOARD):
- Prompt ini HANYA bertugas menghasilkan gambar Image Grid Storyboard. JANGAN membuat JSON prompt video generator di sini — itu tugas "assets.videoGenPrompt" yang terpisah (dipakai belakangan, setelah storyboard final).
- Gabungkan SELURUH hasil analisis video menjadi SATU prompt utuh: hook, storytelling, scene breakdown, voice over, subtitle, character, environment, camera angle, camera movement, shot type, motion, lighting, color grading, timing, transition, emotional flow, audience psychology, entertainment strategy, selling strategy (jika ada), CTA (jika ada), dan seluruh instruksi visual lainnya. Jangan tampilkan elemen-elemen ini terpisah — gabung jadi satu narasi prompt yang mengalir.
- Ini HARUS rekonstruksi SETIA dari video asli yang dianalisis — reproduksi ulang isi, visual, aksi, dan urutannya SEPERSIS mungkin. JANGAN membuat konsep alternatif atau versi kreatif baru (itu tugas mode "Make It Better" yang terpisah).
- WAJIB secara eksplisit mencantumkan target durasi yang sudah disebutkan di instruksi sebelumnya (10–30 detik) — sebutkan angkanya secara eksplisit di dalam teksnya.
- WAJIB DIAWALI PERSIS dengan blok instruksi serah-terima berikut ini (salin verbatim sebagai baris pertama "assets.masterPrompt", sebelum detail prompt storyboard-nya):

"CATATAN UNTUK CHATGPT: Setelah kamu memahami MASTER PROMPT ini, JANGAN langsung membuat gambar. Tampilkan dulu pesan ini ke saya dan TUNGGU balasan saya:
'MASTER PROMPT berhasil dipahami. Silakan pilih langkah berikut:
1. Langsung buat Image Grid Storyboard sesuai prompt ini.
2. Revisi/optimalkan dulu promptnya sebelum dibuat gambarnya.'
Jika saya pilih 1, langsung buat gambar Image Grid Storyboard sesuai instruksi di bawah ini. Jika saya pilih 2, bantu saya merevisi prompt ini dulu berdasarkan masukan saya, baru buat gambarnya setelah saya setuju."

- Setelah blok di atas, lanjutkan dengan detail lengkap prompt Image Grid Storyboard-nya (tata letak grid, jumlah panel, detail visual tiap panel: komposisi, kamera, pencahayaan, wardrobe, ekspresi, aksi, urutan sesuai scene breakdown).

ATURAN WAJIB UNTUK "assets.videoGenPrompt" (PROMPT KEDUA — TERPISAH, DIPAKAI SETELAH STORYBOARD FINAL):
- Prompt ini adalah template TERPISAH yang baru dipakai user NANTI, setelah Image Grid Storyboard dari ChatGPT sudah jadi dan disetujui. Prompt ini BUKAN untuk dipakai bersamaan dengan masterPrompt.
- WAJIB DIAWALI dengan instruksi eksplisit seperti: "Input untuk prompt ini adalah gambar Image Grid Storyboard final yang sudah disetujui (lampirkan gambarnya di sini). JANGAN membuat ulang storyboard atau menganalisis ulang video apa pun — fokus HANYA mengubah storyboard yang dilampirkan menjadi prompt JSON video generator di bawah ini."
- Isinya berupa beberapa prompt JSON terstruktur (ditulis sebagai teks dalam satu field ini, masing-masing diberi heading jelas) untuk: OmniFlash, Veo, Kling, dan Hailuo — masing-masing merujuk ke storyboard yang akan dilampirkan, dan tetap mencantumkan target durasi 10-30 detik yang sama dengan masterPrompt.

ATURAN BAHASA (WAJIB, TANPA KECUALI):
- Semua isi teks di dalam JSON (nilai/value setiap field) HARUS ditulis dalam Bahasa Indonesia yang natural, mengalir, dan manusiawi — seperti tulisan seorang kreator/strategist Indonesia asli.
- JANGAN pakai gaya terjemahan mesin yang kaku, JANGAN campur-campur dengan Bahasa Inggris kecuali istilah teknis yang memang umum dipakai (misalnya: hook, CTA, voice over, storyboard, frame, shot).
- Nama key JSON (seperti "hook", "stopScroll", "masterPrompt", "videoGenPrompt") tetap dalam Bahasa Inggris persis seperti skema di atas — hanya isinya yang harus Bahasa Indonesia.`;

  const SYSTEM_ANALYSIS = 'Kamu adalah analis video AI ahli. Kamu selalu membalas dengan JSON valid dan lengkap sesuai skema yang diberikan, dan seluruh isi teksnya ditulis dalam Bahasa Indonesia yang natural dan manusiawi, bukan terjemahan kaku ala mesin.';
  const SYSTEM_IMPROVE = 'Kamu adalah creative director AI ahli, spesialis video jualan/promosi short-form berkinerja tinggi. Kamu selalu membalas dengan JSON valid dan lengkap sesuai skema yang diberikan, dan seluruh isi teksnya ditulis dalam Bahasa Indonesia yang natural dan manusiawi, bukan terjemahan kaku ala mesin.';

  function analysisIntroText(ingestData) {
    const targetDuration = Utils.clamp(Math.round(ingestData.duration), 10, 30);
    return `Kamu adalah creative director video short-form, performance-marketing strategist, dan cinematographer kelas dunia. Analisis video berikut, direkonstruksi sebagai ${ingestData.scenes.length} frame scene representatif yang diambil sepanjang ${Utils.fmtTime(ingestData.duration)} durasi asli (${ingestData.width}x${ingestData.height}).

Durasi video ASLI adalah ${Utils.fmtTime(ingestData.duration)}. Namun, untuk "assets.masterPrompt" dan "assets.videoGenPrompt", target durasi video HASIL GENERATE WAJIB dikunci ke ${targetDuration} detik (minimal 10 detik, maksimal 30 detik) — bukan durasi asli. Sesuaikan proporsi tiap beat/scene supaya pas di ${targetDuration} detik, tanpa mengubah urutan atau isi cerita aslinya.`;
  }

  function improveText(analysisResult, ingestData) {
    const compact = {
      signals: analysisResult.signals,
      scores: Object.fromEntries(Object.entries(analysisResult.scores || {}).map(([k, v]) => [k, v.score])),
      reverseEngineering: analysisResult.reverseEngineering,
      assets: { winningConcept: analysisResult.assets?.winningConcept },
    };
    const targetDuration = Utils.clamp(Math.round(ingestData.duration), 10, 30);
    return `Kamu sebelumnya sudah menganalisis sebuah video short-form berdurasi ${Utils.fmtTime(ingestData.duration)}. Berikut ringkasan analisisnya:

${JSON.stringify(compact, null, 2)}

Sekarang buat konsep alternatif yang LEBIH KUAT dan ORISINAL, yang memperbaiki titik lemah video ini. JANGAN menyalin skrip atau visual video aslinya — perbaiki mekanisme dasarnya: hook, storytelling, retensi, emosi, jualan, dan potensi checkout.

Balas HANYA dengan objek JSON mentah, tanpa markdown fences, persis dalam bentuk ini:
{
  "scores": {"stopScroll":0,"entertainment":0,"curiosity":0,"watchTime":0,"emotionalImpact":0,"trust":0,"sellingEffectiveness":0,"checkoutPotential":0,"overall":0},
  "whatChanged": "",
  "winningConcept": "", "creativeBlueprint": "", "tiktokStoryboard": "",
  "voiceOverScript": "", "caption": "", "cta": "",
  "alternativeHooks": ["", "", ""], "alternativeConcepts": ["", ""]
}
Setiap skor harus lebih tinggi atau sama dengan skor aslinya jika memang wajar, dan "whatChanged" harus menjelaskan perbaikannya dalam 2-3 kalimat. Sebutkan juga target durasi ${targetDuration} detik di dalam "tiktokStoryboard". Tulis SEMUA isi teks dalam Bahasa Indonesia yang natural dan manusiawi, bukan terjemahan kaku ala mesin.`;
  }

  /* ---- OpenAI request shape ---- */
  function buildOpenAIAnalysisMessages(ingestData) {
    const content = [{ type: 'text', text: analysisIntroText(ingestData) }];
    ingestData.scenes.forEach((s) => {
      content.push({ type: 'text', text: `Scene ${s.index} — timestamp ${Utils.fmtTime(s.startTime)} to ${Utils.fmtTime(s.endTime)}:` });
      content.push({ type: 'image_url', image_url: { url: s.thumbUrl, detail: 'low' } });
    });
    content.push({ type: 'text', text: ANALYSIS_SCHEMA });
    return [{ role: 'system', content: SYSTEM_ANALYSIS }, { role: 'user', content }];
  }
  function buildOpenAIImproveMessages(analysisResult, ingestData) {
    return [{ role: 'system', content: SYSTEM_IMPROVE }, { role: 'user', content: improveText(analysisResult, ingestData) }];
  }
  async function callOpenAI(messages, maxTokens = 4000) {
    const key = Storage.getKey('openai');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: Storage.getModel('openai'), messages, temperature: 0.7, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API_ERROR:${res.status}:${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('TRUNCATED');
    return data.choices?.[0]?.message?.content || '';
  }

  /* ---- Gemini request shape ---- */
  function buildGeminiAnalysisContents(ingestData) {
    const parts = [{ text: analysisIntroText(ingestData) }];
    ingestData.scenes.forEach((s) => {
      parts.push({ text: `Scene ${s.index} — timestamp ${Utils.fmtTime(s.startTime)} to ${Utils.fmtTime(s.endTime)}:` });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: (s.thumbUrl || '').split(',')[1] || '' } });
    });
    parts.push({ text: ANALYSIS_SCHEMA });
    return parts;
  }
  async function callGemini(systemText, parts, maxTokens = 4000) {
    const key = Storage.getKey('gemini');
    const model = Storage.getModel('gemini');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API_ERROR:${res.status}:${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    // finishReason "MAX_TOKENS" means Gemini cut the reply short before finishing the JSON.
    if (cand?.finishReason === 'MAX_TOKENS') throw new Error('TRUNCATED');
    return (cand?.content?.parts || []).map(p => p.text || '').join('');
  }

  // Bigger token budget for the full analysis — the schema now asks for very
  // detailed, faithful-recreation prompts across up to 12 scenes and 5
  // different generation-prompt formats, which needs far more room than the
  // lighter "make it better" or promo-mode replies.
  const ANALYSIS_MAX_TOKENS = 16000;
  const IMPROVE_MAX_TOKENS = 4000;
  const PROMO_MAX_TOKENS = 8000;

  /* ---- Provider-agnostic entry points ---- */
  async function analyze(ingestData) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const raw = provider === 'gemini'
      ? await callGemini(SYSTEM_ANALYSIS, buildGeminiAnalysisContents(ingestData), ANALYSIS_MAX_TOKENS)
      : await callOpenAI(buildOpenAIAnalysisMessages(ingestData), ANALYSIS_MAX_TOKENS);
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  async function makeItBetter(analysisResult, ingestData) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const raw = provider === 'gemini'
      ? await callGemini(SYSTEM_IMPROVE, [{ text: improveText(analysisResult, ingestData) }], IMPROVE_MAX_TOKENS)
      : await callOpenAI(buildOpenAIImproveMessages(analysisResult, ingestData), IMPROVE_MAX_TOKENS);
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  return { analyze, makeItBetter, callOpenAI, callGemini, ANALYSIS_MAX_TOKENS, PROMO_MAX_TOKENS };
})();

/* ============================= PROMO CLIENT ============================= */
// Builds a prompt for the "Promosi Usaha / Jualan" mode. The input here is a
// REFERENCE video (an example the user likes the promotional style of) plus
// a short business-info form — NOT the user's actual business photos. The AI
// studies how the reference video promotes things (hook, pacing, selling
// technique) and writes ONE consolidated prompt for the user's own business,
// which explicitly instructs to attach the user's real photos directly in
// ChatGPT alongside this prompt (since this app never sees those photos).
const PromoClient = (() => {

  const PROMO_SCHEMA = `Balas HANYA dengan satu objek JSON mentah — tanpa markdown fences, tanpa komentar apa pun sebelum atau sesudahnya. Gunakan persis bentuk ini:

{
  "concept": "",
  "assets": {
    "masterPrompt": "", "videoGenPrompt": "", "caption": "", "cta": "", "hashtag": ""
  }
}

ATURAN WAJIB:
- "concept" adalah ringkasan singkat (3-5 kalimat): teknik promosi apa yang dipelajari dari video referensi, dan bagaimana itu akan diterapkan ke usaha yang dijelaskan di form.

- "assets.masterPrompt" (PROMPT PERTAMA — HANYA UNTUK IMAGE GRID STORYBOARD, jangan buat JSON video generator di sini):
  Gabungkan teknik promosi dari video referensi (hook, pacing, gaya kamera, cara jualan) dengan info usaha di form menjadi SATU prompt utuh untuk membuat gambar Image Grid Storyboard.
  WAJIB secara eksplisit tulis instruksi seperti: "Gunakan foto/video ASLI milik [nama usaha] yang saya lampirkan bersama prompt ini sebagai referensi visual utama — JANGAN mengarang visual usaha yang tidak dilampirkan." Jangan mendeskripsikan visual usaha secara detail seolah-olah kamu sudah melihatnya.
  WAJIB DIAWALI PERSIS dengan blok instruksi serah-terima berikut ini (salin verbatim sebagai baris pertama, sebelum detail prompt storyboard-nya):

  "CATATAN UNTUK CHATGPT: Setelah kamu memahami MASTER PROMPT ini, JANGAN langsung membuat gambar. Tampilkan dulu pesan ini ke saya dan TUNGGU balasan saya:
  'MASTER PROMPT berhasil dipahami. Silakan pilih langkah berikut:
  1. Langsung buat Image Grid Storyboard sesuai prompt ini.
  2. Revisi/optimalkan dulu promptnya sebelum dibuat gambarnya.'
  Jika saya pilih 1, langsung buat gambar Image Grid Storyboard sesuai instruksi di bawah ini (termasuk melampirkan foto/video asli usaha saya). Jika saya pilih 2, bantu saya merevisi prompt ini dulu, baru buat gambarnya setelah saya setuju."

  Setelah blok di atas, lanjutkan dengan detail lengkap prompt Image Grid Storyboard-nya. WAJIB mencantumkan target durasi eksplisit (10–30 detik sesuai instruksi).

- "assets.videoGenPrompt" (PROMPT KEDUA — TERPISAH, dipakai NANTI setelah storyboard final):
  WAJIB DIAWALI dengan instruksi eksplisit: "Input untuk prompt ini adalah gambar Image Grid Storyboard final yang sudah disetujui (lampirkan gambarnya di sini). JANGAN membuat ulang storyboard atau menganalisis ulang apa pun — fokus HANYA mengubah storyboard yang dilampirkan menjadi prompt JSON video generator di bawah ini."
  Isinya beberapa prompt JSON terstruktur (masing-masing diberi heading jelas) untuk: OmniFlash, Veo, Kling, dan Hailuo — merujuk ke storyboard yang akan dilampirkan nanti, tetap mencantumkan target durasi 10-30 detik yang sama dengan masterPrompt.

- "caption" adalah caption media sosial siap posting untuk usaha ini. "cta" adalah satu kalimat call-to-action. "hashtag" adalah 5-8 hashtag relevan dipisah spasi.
- Semua isi teks WAJIB Bahasa Indonesia yang natural, mengalir, dan manusiawi — bukan terjemahan kaku ala mesin. Nama key JSON tetap Bahasa Inggris seperti skema di atas.`;

  const SYSTEM_PROMO = 'Kamu adalah creative director iklan & video promosi UMKM yang berpengalaman. Kamu selalu membalas dengan JSON valid dan lengkap sesuai skema yang diberikan, seluruh isi teksnya dalam Bahasa Indonesia yang natural dan manusiawi.';

  function introText(ingestData, form) {
    const targetDuration = Utils.clamp(Math.round(ingestData.duration), 10, 30);
    const parts = [
      `Berikut ${ingestData.scenes.length} frame scene representatif dari sebuah VIDEO REFERENSI sepanjang ${Utils.fmtTime(ingestData.duration)} (${ingestData.width}x${ingestData.height}) — pelajari TEKNIK PROMOSINYA (hook, pacing, gaya kamera, cara jualan), BUKAN untuk ditiru visualnya mentah-mentah.`,
      `Terapkan teknik itu untuk membuat prompt promosi bagi usaha bernama "${form.name || '(tidak disebutkan)'}" (jenis usaha: ${form.type || '(tidak disebutkan)'}).`,
    ];
    if (form.location) parts.push(`Lokasi: ${form.location}.`);
    if (form.highlight) parts.push(`Keunggulan/promo yang ingin ditonjolkan: ${form.highlight}.`);
    parts.push(`Gaya video yang diinginkan: ${form.styleLabel}.`);
    if (form.cta) parts.push(`CTA yang diinginkan: ${form.cta}.`);
    parts.push(`Target durasi video hasil generate dikunci antara 10-30 detik (gunakan sekitar ${targetDuration} detik kecuali ada alasan kuat untuk berbeda) — sebutkan angka durasinya secara eksplisit di dalam masterPrompt.`);
    parts.push(`PENTING: kamu TIDAK memiliki foto asli usaha ini — foto aslinya akan dilampirkan user sendiri langsung di ChatGPT bersamaan dengan prompt yang kamu buat. Jangan mengarang deskripsi visual usaha seolah-olah kamu sudah melihatnya.`);
    return parts.join(' ');
  }

  function buildOpenAIMessages(ingestData, form) {
    const content = [{ type: 'text', text: introText(ingestData, form) }];
    ingestData.scenes.forEach((s) => {
      content.push({ type: 'text', text: `Scene referensi ${s.index} — timestamp ${Utils.fmtTime(s.startTime)} sampai ${Utils.fmtTime(s.endTime)}:` });
      content.push({ type: 'image_url', image_url: { url: s.thumbUrl, detail: 'low' } });
    });
    content.push({ type: 'text', text: PROMO_SCHEMA });
    return [{ role: 'system', content: SYSTEM_PROMO }, { role: 'user', content }];
  }

  function buildGeminiParts(ingestData, form) {
    const parts = [{ text: introText(ingestData, form) }];
    ingestData.scenes.forEach((s) => {
      parts.push({ text: `Scene referensi ${s.index} — timestamp ${Utils.fmtTime(s.startTime)} sampai ${Utils.fmtTime(s.endTime)}:` });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: (s.thumbUrl || '').split(',')[1] || '' } });
    });
    parts.push({ text: PROMO_SCHEMA });
    return parts;
  }

  async function analyze(ingestData, form) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const raw = provider === 'gemini'
      ? await AIClient.callGemini(SYSTEM_PROMO, buildGeminiParts(ingestData, form), AIClient.PROMO_MAX_TOKENS)
      : await AIClient.callOpenAI(buildOpenAIMessages(ingestData, form), AIClient.PROMO_MAX_TOKENS);
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  return { analyze };
})();

/* ============================= FREE MODE CLIENT ============================= */
// "Video Bebas": no reference video or photos at all — just an idea (title +
// theme), with optional duration, visual style, and content points. The AI
// fills in whatever wasn't specified (duration, style, and/or the full
// script) before producing the same two-stage prompt pair as the other modes.
// Unlike the other two modes, duration here is NOT locked to 10-30s — the
// user (or the AI's recommendation) can pick anything from a few seconds to
// several minutes, since this mode isn't reconstructing a short-form clip.
const FreeModeClient = (() => {

  const FREE_SCHEMA = `Balas HANYA dengan satu objek JSON mentah — tanpa markdown fences, tanpa komentar apa pun sebelum atau sesudahnya. Gunakan persis bentuk ini:

{
  "concept": "",
  "recommendedDuration": "",
  "recommendedStyle": "",
  "script": "",
  "assets": {
    "masterPrompt": "", "videoGenPrompt": "", "voiceOverScript": "", "caption": "", "cta": "", "hashtag": ""
  }
}

ATURAN WAJIB:
- "recommendedDuration": jika user TIDAK menentukan durasi, isi field ini dengan durasi terbaik menurutmu untuk judul/tema ini (contoh: "45 detik" atau "3 menit"), lengkap dengan alasan singkat. Jika user SUDAH menentukan durasi, isi field ini dengan durasi yang sama itu (konfirmasi ulang saja).
- "recommendedStyle": sama logikanya untuk gaya visual — rekomendasikan jika belum ditentukan, atau konfirmasi ulang jika sudah ditentukan user.
- "script": jika user TIDAK memberi isi materi, tulis SATU naskah/skrip lengkap dari nol yang sesuai judul dan tema. Jika user SUDAH memberi poin-poin materi, susun ulang & lengkapi poin-poin itu jadi naskah yang mengalir (jangan mengarang topik baru yang tidak diminta).
- "concept" adalah ringkasan singkat (3-5 kalimat) konsep video yang direkomendasikan, mencakup hook, alur cerita, dan gaya penyampaian.

- "assets.masterPrompt" (PROMPT PERTAMA — HANYA UNTUK IMAGE GRID STORYBOARD, jangan buat JSON video generator di sini):
  Gabungkan SELURUH elemen berikut menjadi SATU prompt utuh: hook, storytelling, scene breakdown (pecah "script" jadi beberapa scene/beat wajar sesuai durasi), voice over, subtitle, character, environment, camera angle, camera movement, shot type, motion, lighting, color grading, timing, transition, emotional flow, audience psychology, entertainment strategy, selling strategy (jika relevan), CTA (jika relevan). Jangan tampilkan elemen ini terpisah — gabung jadi satu narasi prompt yang mengalir.
  WAJIB mencantumkan durasi eksplisit sesuai "recommendedDuration" dan gaya visual sesuai "recommendedStyle".
  WAJIB DIAWALI PERSIS dengan blok instruksi serah-terima berikut ini (salin verbatim sebagai baris pertama, sebelum detail prompt storyboard-nya):

  "CATATAN UNTUK CHATGPT: Setelah kamu memahami MASTER PROMPT ini, JANGAN langsung membuat gambar. Tampilkan dulu pesan ini ke saya dan TUNGGU balasan saya:
  'MASTER PROMPT berhasil dipahami. Silakan pilih langkah berikut:
  1. Langsung buat Image Grid Storyboard sesuai prompt ini.
  2. Revisi/optimalkan dulu promptnya sebelum dibuat gambarnya.'
  Jika saya pilih 1, langsung buat gambar Image Grid Storyboard sesuai instruksi di bawah ini. Jika saya pilih 2, bantu saya merevisi prompt ini dulu, baru buat gambarnya setelah saya setuju."

  Setelah blok di atas, lanjutkan dengan detail lengkap prompt Image Grid Storyboard-nya (tata letak grid, jumlah panel, detail visual tiap panel).

- "assets.videoGenPrompt" (PROMPT KEDUA — TERPISAH, dipakai NANTI setelah storyboard final):
  WAJIB DIAWALI dengan instruksi eksplisit: "Input untuk prompt ini adalah gambar Image Grid Storyboard final yang sudah disetujui (lampirkan gambarnya di sini). JANGAN membuat ulang storyboard atau menyusun ulang naskah — fokus HANYA mengubah storyboard yang dilampirkan menjadi prompt JSON video generator di bawah ini."
  Isinya beberapa prompt JSON terstruktur (masing-masing diberi heading jelas) untuk: OmniFlash, Veo, Kling, dan Hailuo — tetap mencantumkan durasi yang sama dengan masterPrompt.

- "voiceOverScript" adalah naskah voice over final siap dibaca (boleh sama dengan bagian voice over di masterPrompt, ditulis ulang di sini agar mudah diambil terpisah). "caption" adalah caption media sosial siap posting. "cta" adalah satu kalimat call-to-action. "hashtag" adalah 5-8 hashtag relevan dipisah spasi.
- Semua isi teks WAJIB Bahasa Indonesia yang natural, mengalir, dan manusiawi — bukan terjemahan kaku ala mesin. Nama key JSON tetap Bahasa Inggris seperti skema di atas.`;

  const SYSTEM_FREE = 'Kamu adalah creative director & scriptwriter video short-form yang ahli. Kamu selalu membalas dengan JSON valid dan lengkap sesuai skema yang diberikan, seluruh isi teksnya dalam Bahasa Indonesia yang natural dan manusiawi.';

  function introText(form) {
    const parts = [
      `Buatkan konsep video berdasarkan ide berikut — Judul: "${form.title}". Tema/topik utama: "${form.theme}".`,
    ];
    parts.push(form.duration ? `Durasi yang diinginkan: ${form.duration}.` : 'Durasi belum ditentukan — berikan rekomendasi durasi terbaik untuk ide ini.');
    parts.push(form.style ? `Gaya visual yang diinginkan: ${form.style}.` : 'Gaya visual belum ditentukan — berikan rekomendasi gaya visual terbaik untuk ide ini.');
    parts.push(form.materi ? `Poin-poin materi dari user: ${form.materi}` : 'User belum memberi materi apa pun — susun naskah/skrip lengkap dari nol yang sesuai judul dan tema.');
    return parts.join(' ');
  }

  async function analyze(form) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const messages = [{ role: 'system', content: SYSTEM_FREE }, { role: 'user', content: `${introText(form)}\n\n${FREE_SCHEMA}` }];
    const raw = provider === 'gemini'
      ? await AIClient.callGemini(SYSTEM_FREE, [{ text: `${introText(form)}\n\n${FREE_SCHEMA}` }], AIClient.PROMO_MAX_TOKENS)
      : await AIClient.callOpenAI(messages, AIClient.PROMO_MAX_TOKENS);
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  return { analyze };
})();

/* ============================= UI ============================= */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const els = {};

  const SCORE_LABELS = {
    stopScroll: 'Stop Scroll', entertainment: 'Hiburan', curiosity: 'Rasa Penasaran',
    watchTime: 'Durasi Tonton', emotionalImpact: 'Dampak Emosional', trust: 'Kepercayaan',
    sellingEffectiveness: 'Efektivitas Jualan', checkoutPotential: 'Potensi Checkout', overall: 'Total Potensi Viral',
  };
  const SIGNAL_LABELS = {
    hook: 'Hook', storytelling: 'Storytelling', emotionalFlow: 'Alur Emosi', audiencePsychology: 'Psikologi Penonton',
    sellingStrategy: 'Strategi Jualan', entertainmentStrategy: 'Strategi Hiburan', productIntegration: 'Integrasi Produk',
    character: 'Karakter', cameraAngle: 'Sudut Kamera', cameraMovement: 'Gerakan Kamera', shotType: 'Jenis Shot',
    lighting: 'Pencahayaan', colorGrading: 'Color Grading', motion: 'Motion', environment: 'Lingkungan',
    productVisibility: 'Visibilitas Produk', facialExpression: 'Ekspresi Wajah', subtitleStyle: 'Gaya Subtitle',
    voiceOverStyle: 'Gaya Voice Over', cta: 'CTA', musicMood: 'Mood Musik', sceneTiming: 'Timing Scene', sceneChanges: 'Perubahan Scene',
  };
  const ASSET_LABELS = {
    winningConcept: 'Konsep Konten Unggulan', creativeBlueprint: 'Blueprint Kreatif', tiktokStoryboard: 'Storyboard TikTok',
    masterPrompt: 'Prompt 1 — Master Prompt (Storyboard)', videoGenPrompt: 'Prompt 2 — Video Generator (setelah storyboard final)', voiceOverScript: 'Skrip Voice Over', caption: 'Caption',
    cta: 'CTA', alternativeHooks: 'Alternatif Hook', alternativeConcepts: 'Alternatif Konsep', hashtag: 'Hashtag',
  };

  function cacheEls() {
    ['dropZone','fileInput','browseBtn','previewWrap','previewVideo','metaGrid','uploadActions','analyzeBtn',
     'changeFileBtn','progressWrap','progressSteps','progressFill','progressLabel','resultsRoot','dashTabs',
     'overallRing','overallScoreNum','scoreList','signalCardGrid','reverseGrid','strengthsWeaknesses',
     'sceneTableBody','assetTabs','assetOutput','copyAssetBtn','improveBtn','improveIntro','improveResult',
     'scoreCompare','improveTabs','improveOutput','copyImproveBtn','exportTxt','exportMd','exportJson',
     'startOverBtn','apiKeyBtn','apiKeyBtnLabel','heroKeyBtn','heroUploadBtn','modalOverlay','apiKeyModal',
     'closeApiModal','providerSelect','providerHint','getKeyHint','apiKeyInput','modelSelect','keyStatus',
     'removeKeyBtn','saveKeyBtn','toast','modeSwitcher',
     'promoDropZone','promoFileInput','promoBrowseBtn','promoPreviewWrap','promoPreviewVideo','promoMetaGrid',
     'promoForm','promoBizName','promoBizType',
     'promoBizLocation','promoHighlight','promoStyle','promoCta','promoAnalyzeBtn','promoChangeBtn',
     'promoProgressWrap','promoProgressFill','promoProgressLabel','promoResultsRoot','promoConceptCard',
     'promoAssetTabs','promoAssetOutput','copyPromoAssetBtn','promoExportTxt','promoExportMd','promoExportJson',
     'promoStartOverBtn',
     'freeTitle','freeTheme','freeDuration','freeStyle','freeMateri','freeAnalyzeBtn',
     'freeProgressWrap','freeProgressFill','freeProgressLabel','freeResultsRoot','freeConceptCard',
     'freeAssetTabs','freeAssetOutput','copyFreeAssetBtn','freeExportTxt','freeExportMd','freeExportJson',
     'freeStartOverBtn']
      .forEach(id => { els[id] = document.getElementById(id); });
  }

  function toast(msg, durationMs = 2400) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), durationMs);
  }

  /* ---- Modal ---- */
  function openModal() { els.modalOverlay.classList.remove('hidden'); els.apiKeyModal.classList.remove('hidden'); }
  function closeModal() { els.modalOverlay.classList.add('hidden'); els.apiKeyModal.classList.add('hidden'); }

  const PROVIDER_INFO = {
    gemini: {
      label: 'Gemini',
      keyPlaceholder: 'AIza...',
      hint: 'Gratis — tanpa kartu kredit. Ada limit pemakaian (cukup untuk pemakaian pribadi). Google sering ganti/pensiunkan model gratisnya — kalau ada model error "tidak tersedia", coba pilih model lain di daftar ini.',
      getKeyHint: 'Ambil key gratis di <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>.',
      models: [
        { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (disarankan — gratis, vision)' },
        { value: 'gemini-3.6-flash', label: 'gemini-3.6-flash (terbaru, kuota gratis mungkin lebih ketat)' },
        { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (lama — mungkin tak tersedia di akun baru)' },
        { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro (kualitas lebih tinggi, kuota gratis lebih kecil)' },
      ],
    },
    openai: {
      label: 'OpenAI',
      keyPlaceholder: 'sk-...',
      hint: 'Berbayar — perlu kartu di akun dan minimal top-up kecil (sekitar $5).',
      getKeyHint: 'Ambil key di <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>.',
      models: [
        { value: 'gpt-4o', label: 'gpt-4o (disarankan — vision + teks)' },
        { value: 'gpt-4o-mini', label: 'gpt-4o-mini (lebih cepat, lebih murah)' },
        { value: 'gpt-4.1', label: 'gpt-4.1' },
      ],
    },
  };

  function populateProviderFields(provider) {
    const info = PROVIDER_INFO[provider];
    els.providerHint.innerHTML = info.hint;
    els.getKeyHint.innerHTML = info.getKeyHint;
    els.apiKeyInput.placeholder = Storage.hasKey(provider) ? 'Masukkan key baru untuk timpa yang lama' : info.keyPlaceholder;
    els.modelSelect.innerHTML = info.models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
    els.modelSelect.value = Storage.getModel(provider);
  }

  function refreshKeyStatus() {
    const provider = Storage.getProvider();
    els.providerSelect.value = provider;
    populateProviderFields(provider);
    const has = Storage.hasKey(provider);
    els.keyStatus.textContent = has ? `Terhubung — ${PROVIDER_INFO[provider].label} ${Storage.maskedKey(provider)}` : 'Belum ada key tersimpan.';
    els.keyStatus.classList.toggle('connected', has);
    els.apiKeyBtnLabel.textContent = has ? `${PROVIDER_INFO[provider].label} terhubung` : 'Hubungkan API key gratis';
  }

  /* ---- Progress ---- */
  const STEP_LABELS = ['metadata', 'scenes', 'ai-analysis'];
  const STEP_LABELS_ID = { metadata: 'metadata', scenes: 'scene', 'ai-analysis': 'analisis AI' };
  function initProgress() {
    els.progressSteps.innerHTML = STEP_LABELS.map(s => `<span data-step="${s}">${STEP_LABELS_ID[s]}</span>`).join('');
  }
  function setProgress(pct, stage, label) {
    els.progressFill.style.width = `${pct}%`;
    els.progressLabel.textContent = label || '';
    [...els.progressSteps.children].forEach(el => {
      el.classList.toggle('active', el.dataset.step === stage);
      el.classList.toggle('done', STEP_LABELS.indexOf(el.dataset.step) < STEP_LABELS.indexOf(stage));
    });
  }

  /* ---- Meta grid ---- */
  function renderMeta(ingestData) {
    const items = [
      { label: 'Durasi', value: Utils.fmtTime(ingestData.duration) },
      { label: 'Resolusi', value: `${ingestData.width}×${ingestData.height}` },
      { label: 'Frame Rate', value: ingestData.fps ? `${ingestData.fps} fps` : 'Tidak tersedia' },
      { label: 'Ukuran File', value: Utils.fmtBytes(ingestData.fileSize) },
    ];
    els.metaGrid.innerHTML = items.map(i => `
      <div class="meta-card"><div class="meta-value">${i.value}</div><div class="meta-label">${i.label}</div></div>`).join('');
  }

  /* ---- Scores ---- */
  function renderScores(scores) {
    const overall = scores.overall?.score ?? 0;
    els.overallScoreNum.textContent = overall;
    els.overallRing.style.setProperty('--pct', overall);
    els.overallRing.style.setProperty('--ring-color', Utils.scoreColor(overall));

    const order = ['stopScroll','entertainment','curiosity','watchTime','emotionalImpact','trust','sellingEffectiveness','checkoutPotential'];
    els.scoreList.innerHTML = order.map(key => {
      const s = scores[key] || { score: 0, explanation: '' };
      const color = Utils.scoreColor(s.score);
      return `
        <div class="score-row">
          <div class="score-row-label">${SCORE_LABELS[key]}</div>
          <div class="score-row-track"><div class="score-row-fill" style="width:${s.score}%; background:${color};"></div></div>
          <div class="score-row-num">${s.score}</div>
          <div class="score-explain">${Utils.escapeHtml(s.explanation)}</div>
        </div>`;
    }).join('');
  }

  /* ---- Signal cards ---- */
  function renderSignals(signals) {
    els.signalCardGrid.innerHTML = Object.entries(SIGNAL_LABELS).map(([key, label]) => `
      <div class="a-card"><h3>${label}</h3><p>${Utils.escapeHtml(signals[key] || '—')}</p></div>`).join('');
  }

  /* ---- Reverse engineering ---- */
  function renderReverse(re) {
    const fields = [
      ['whyHookWorks', 'Why the hook works'], ['whyViewersContinue', 'Why viewers keep watching'],
      ['emotionsTriggered', 'Emotions triggered'], ['howProductIntroduced', 'How the product is introduced'],
      ['whyProductFeelsNatural', 'Why the product feels natural'], ['whyViewersTrust', 'Why viewers trust it'],
      ['whyLikelyToCheckout', 'Why viewers are likely to check out'], ['howToImprove', 'How it can be improved'],
    ];
    els.reverseGrid.innerHTML = fields.map(([key, label]) => `
      <div class="reverse-card"><h3>${label}</h3><p>${Utils.escapeHtml(re[key] || '—')}</p></div>`).join('');

    const strengths = re.strengths || [];
    const weaknesses = re.weaknesses || [];
    els.strengthsWeaknesses.innerHTML = `
      <div class="sw-col strengths"><h3>Strengths</h3><ul>${strengths.map(s => `<li>${Utils.escapeHtml(s)}</li>`).join('') || '<li>—</li>'}</ul></div>
      <div class="sw-col weaknesses"><h3>Weaknesses</h3><ul>${weaknesses.map(s => `<li>${Utils.escapeHtml(s)}</li>`).join('') || '<li>—</li>'}</ul></div>`;
  }

  /* ---- Scene table ---- */
  function renderSceneTable(aiScenes, ingestScenes) {
    els.sceneTableBody.innerHTML = aiScenes.map((s, i) => {
      const local = ingestScenes[i] || {};
      const timeLabel = local.startTime !== undefined ? `${Utils.fmtTime(local.startTime)}–${Utils.fmtTime(local.endTime)}` : '—';
      return `
      <tr>
        <td class="scene-num">#${String(s.index).padStart(2, '0')}</td>
        <td class="scene-time">${timeLabel}</td>
        <td>${local.thumbUrl ? `<img class="scene-thumb" src="${local.thumbUrl}" alt="Scene ${s.index}" loading="lazy" />` : '—'}</td>
        <td>${Utils.escapeHtml(s.purpose)}</td>
        <td>${Utils.escapeHtml(s.visual)}</td>
        <td>${Utils.escapeHtml(s.camera)}</td>
        <td>${Utils.escapeHtml(s.motion)}</td>
        <td>${Utils.escapeHtml(s.emotion)}</td>
        <td>${Utils.escapeHtml(s.voiceOver)}</td>
        <td>${Utils.escapeHtml(s.subtitle)}</td>
        <td>${Utils.escapeHtml(s.transition)}</td>
      </tr>`;
    }).join('');
  }

  /* ---- Asset tabs (shared renderer for both Production Assets and Make It Better) ---- */
  function renderAssetTabs(tabsEl, outputEl, assets, keys, onChangeExtra) {
    let active = keys[0];
    function paint() {
      const val = assets[active];
      outputEl.textContent = Array.isArray(val) ? val.map((v, i) => `${i + 1}. ${v}`).join('\n\n') : (val || '—');
    }
    tabsEl.innerHTML = '';
    keys.forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (key === active ? ' active' : '');
      btn.type = 'button';
      btn.textContent = ASSET_LABELS[key] || key;
      btn.addEventListener('click', () => {
        active = key;
        [...tabsEl.children].forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        paint();
        if (onChangeExtra) onChangeExtra(key);
      });
      tabsEl.appendChild(btn);
    });
    paint();
    return { repaint: paint, getActive: () => active };
  }

  function renderAssets(assets) {
    const keys = ['masterPrompt','videoGenPrompt','winningConcept','creativeBlueprint','tiktokStoryboard','voiceOverScript','caption','cta','alternativeHooks','alternativeConcepts'];
    return renderAssetTabs(els.assetTabs, els.assetOutput, assets, keys);
  }

  function renderImproveAssets(improveResult) {
    const keys = ['winningConcept','creativeBlueprint','tiktokStoryboard','voiceOverScript','caption','cta','alternativeHooks','alternativeConcepts'];
    return renderAssetTabs(els.improveTabs, els.improveOutput, improveResult, keys);
  }

  function renderPromoAssets(promoResult) {
    const keys = ['masterPrompt','videoGenPrompt','caption','cta','hashtag'];
    return renderAssetTabs(els.promoAssetTabs, els.promoAssetOutput, promoResult.assets || {}, keys);
  }

  function renderPromoConcept(promoResult) {
    els.promoConceptCard.innerHTML = `
      <div class="a-card" style="grid-column: 1 / -1;">
        <h3>Konsep Video Promosi</h3>
        <p>${Utils.escapeHtml(promoResult.concept || '—')}</p>
      </div>`;
  }

  function renderFreeConcept(freeResult) {
    els.freeConceptCard.innerHTML = `
      <div class="a-card" style="grid-column: 1 / -1;">
        <h3>Konsep Video</h3>
        <p>${Utils.escapeHtml(freeResult.concept || '—')}</p>
      </div>
      <div class="a-card">
        <h3>Durasi</h3>
        <p>${Utils.escapeHtml(freeResult.recommendedDuration || '—')}</p>
      </div>
      <div class="a-card">
        <h3>Gaya Visual</h3>
        <p>${Utils.escapeHtml(freeResult.recommendedStyle || '—')}</p>
      </div>
      <div class="a-card" style="grid-column: 1 / -1;">
        <h3>Naskah / Skrip</h3>
        <p style="white-space: pre-wrap;">${Utils.escapeHtml(freeResult.script || '—')}</p>
      </div>`;
  }

  function renderFreeAssets(freeResult) {
    const keys = ['masterPrompt','videoGenPrompt','voiceOverScript','caption','cta','hashtag'];
    return renderAssetTabs(els.freeAssetTabs, els.freeAssetOutput, freeResult.assets || {}, keys);
  }

  /* ---- Mode switcher ---- */
  function setMode(mode) {
    document.querySelectorAll('.mode-panel').forEach(el => {
      const isResultsPanel = el.id === 'resultsRoot' || el.id === 'promoResultsRoot' || el.id === 'freeResultsRoot';
      if (el.dataset.modePanel !== mode) {
        el.classList.add('hidden'); // hide anything belonging to the inactive mode
      } else if (!isResultsPanel) {
        el.classList.remove('hidden'); // show the upload section for the active mode
      } else {
        // Results panel for the active mode: restore visibility only if it
        // actually has results ready (marked by renderResults()/promo render),
        // so switching modes and back doesn't lose or fake-show a dashboard.
        el.classList.toggle('hidden', !el.classList.contains('has-results'));
      }
    });
    els.modeSwitcher.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  }

  function wireModeSwitcher() {
    els.modeSwitcher.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
  }

  function renderScoreCompare(oldScores, newScores) {
    const order = ['stopScroll','entertainment','curiosity','watchTime','emotionalImpact','trust','sellingEffectiveness','checkoutPotential','overall'];
    els.scoreCompare.innerHTML = order.map(key => {
      const oldV = oldScores[key]?.score ?? 0;
      const newV = newScores[key] ?? 0;
      return `
        <div class="compare-card">
          <div class="compare-label">${SCORE_LABELS[key]}</div>
          <div class="compare-values"><span class="old">${oldV}</span><span class="new">${newV}</span></div>
        </div>`;
    }).join('');
  }

  /* ---- Tabs (dashboard-level) ---- */
  function wireDashTabs() {
    els.dashTabs.querySelectorAll('.dash-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        els.dashTabs.querySelectorAll('.dash-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      });
    });
  }

  return {
    els, cacheEls, toast, openModal, closeModal, refreshKeyStatus, initProgress, setProgress,
    renderMeta, renderScores, renderSignals, renderReverse, renderSceneTable,
    renderAssets, renderImproveAssets, renderScoreCompare, wireDashTabs,
    renderPromoAssets, renderPromoConcept, renderFreeConcept, renderFreeAssets, setMode, wireModeSwitcher,
    SCORE_LABELS, SIGNAL_LABELS, ASSET_LABELS,
  };
})();

/* ============================= EXPORTER ============================= */
const Exporter = (() => {
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function baseName(ingestData) { return (ingestData.fileName || 'video').replace(/\.[^/.]+$/, ''); }

  function toTxt(ingestData, result, improveResult) {
    const lines = ['AI VIDEO INTELLIGENCE STUDIO — FULL TEARDOWN', '='.repeat(48), `File: ${ingestData.fileName}`,
      `Durasi: ${Utils.fmtTime(ingestData.duration)}  Resolusi: ${ingestData.width}x${ingestData.height}`, ''];
    lines.push('-- SKOR --');
    Object.entries(result.scores).forEach(([k, v]) => lines.push(`${UI.SCORE_LABELS[k] || k}: ${v.score} — ${v.explanation}`));
    lines.push('', '-- SINYAL --');
    Object.entries(result.signals).forEach(([k, v]) => lines.push(`${UI.SIGNAL_LABELS[k] || k}: ${v}`));
    lines.push('', '-- BEDAH KREATIF --');
    Object.entries(result.reverseEngineering).forEach(([k, v]) => {
      if (Array.isArray(v)) lines.push(`${k}: ${v.join(' | ')}`); else lines.push(`${k}: ${v}`);
    });
    lines.push('', '-- BREAKDOWN SCENE --');
    result.scenes.forEach(s => lines.push(`Scene ${s.index}: ${s.purpose} | ${s.visual} | Camera: ${s.camera} | Motion: ${s.motion} | Emotion: ${s.emotion} | VO: ${s.voiceOver} | Subtitle: ${s.subtitle} | Transition: ${s.transition}`));
    lines.push('', '-- PROMPT PRODUKSI --');
    Object.entries(result.assets).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k} ###`);
      lines.push(Array.isArray(v) ? v.join('\n') : v);
      lines.push('');
    });
    if (improveResult) {
      lines.push('-- BUAT LEBIH BAIK --');
      lines.push(`Yang diperbaiki: ${improveResult.whatChanged}`);
      Object.entries(improveResult.scores).forEach(([k, v]) => lines.push(`${UI.SCORE_LABELS[k] || k} (new): ${v}`));
    }
    return lines.join('\n');
  }

  function toMarkdown(ingestData, result, improveResult) {
    const lines = [`# AI Video Intelligence Studio — Teardown`, `**File:** ${ingestData.fileName}  \n**Durasi:** ${Utils.fmtTime(ingestData.duration)}  \n**Resolusi:** ${ingestData.width}x${ingestData.height}`];
    lines.push('\n## Skor\n');
    Object.entries(result.scores).forEach(([k, v]) => lines.push(`- **${UI.SCORE_LABELS[k] || k}:** ${v.score}/100 — ${v.explanation}`));
    lines.push('\n## Sinyal\n');
    Object.entries(result.signals).forEach(([k, v]) => lines.push(`- **${UI.SIGNAL_LABELS[k] || k}:** ${v}`));
    lines.push('\n## Breakdown Scene\n');
    lines.push('| Scene | Purpose | Visual | Camera | Motion | Emotion | Voice Over | Subtitle | Transition |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    result.scenes.forEach(s => lines.push(`| ${s.index} | ${s.purpose} | ${s.visual} | ${s.camera} | ${s.motion} | ${s.emotion} | ${s.voiceOver} | ${s.subtitle} | ${s.transition} |`));
    lines.push('\n## Prompt Produksi\n');
    Object.entries(result.assets).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k}\n`);
      lines.push('```\n' + (Array.isArray(v) ? v.join('\n') : v) + '\n```\n');
    });
    if (improveResult) {
      lines.push('\n## 🔥 Buat Lebih Baik\n');
      lines.push(`**Yang diperbaiki:** ${improveResult.whatChanged}\n`);
      Object.entries(improveResult.scores).forEach(([k, v]) => lines.push(`- **${UI.SCORE_LABELS[k] || k} (new):** ${v}`));
    }
    return lines.join('\n');
  }

  function toJson(ingestData, result, improveResult) {
    // Note: ingestData.scenes (with base64 thumbnails) is intentionally omitted below to keep the export light.
    return JSON.stringify({
      file: { name: ingestData.fileName, type: ingestData.fileType, sizeBytes: ingestData.fileSize },
      duration: ingestData.duration, width: ingestData.width, height: ingestData.height, fps: ingestData.fps,
      analysis: result,
      makeItBetter: improveResult || null,
    }, null, 2);
  }

  function exportTxt(ingestData, result, improveResult) { download(`${baseName(ingestData)}-teardown.txt`, toTxt(ingestData, result, improveResult), 'text/plain'); }
  function exportMd(ingestData, result, improveResult) { download(`${baseName(ingestData)}-teardown.md`, toMarkdown(ingestData, result, improveResult), 'text/markdown'); }
  function exportJson(ingestData, result, improveResult) { download(`${baseName(ingestData)}-teardown.json`, toJson(ingestData, result, improveResult), 'application/json'); }

  /* ---- Promo mode export ---- */
  function promoBaseName(form) { return (form.name || 'promosi').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'promosi'; }

  function toPromoTxt(form, promoResult) {
    const lines = ['AI VIDEO INTELLIGENCE STUDIO — PROMPT PROMOSI', '='.repeat(48),
      `Usaha: ${form.name || '-'}  |  Jenis: ${form.type || '-'}  |  Gaya: ${form.styleLabel}`, '', 'Konsep:', promoResult.concept, ''];
    lines.push('-- PROMPT PRODUKSI --');
    Object.entries(promoResult.assets || {}).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k} ###`);
      lines.push(v);
      lines.push('');
    });
    return lines.join('\n');
  }

  function toPromoMarkdown(form, promoResult) {
    const lines = [`# Prompt Promosi — ${form.name || 'Usaha'}`, `**Jenis usaha:** ${form.type || '-'}  \n**Gaya video:** ${form.styleLabel}`,
      '\n## Konsep\n', promoResult.concept, '\n## Prompt Produksi\n'];
    Object.entries(promoResult.assets || {}).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k}\n`);
      lines.push('```\n' + v + '\n```\n');
    });
    return lines.join('\n');
  }

  function toPromoJson(form, promoResult) {
    return JSON.stringify({ businessInfo: form, result: promoResult }, null, 2);
  }

  function exportPromoTxt(form, promoResult) { download(`${promoBaseName(form)}-promosi.txt`, toPromoTxt(form, promoResult), 'text/plain'); }
  function exportPromoMd(form, promoResult) { download(`${promoBaseName(form)}-promosi.md`, toPromoMarkdown(form, promoResult), 'text/markdown'); }
  function exportPromoJson(form, promoResult) { download(`${promoBaseName(form)}-promosi.json`, toPromoJson(form, promoResult), 'application/json'); }

  return { exportTxt, exportMd, exportJson, exportPromoTxt, exportPromoMd, exportPromoJson };
})();

/* ============================= APP ============================= */
(() => {
  const state = { file: null, ingestData: null, result: null, improveResult: null };

  const hiddenVideo = document.createElement('video');
  hiddenVideo.preload = 'metadata';
  hiddenVideo.playsInline = true;
  hiddenVideo.style.position = 'fixed';
  hiddenVideo.style.opacity = '0';
  hiddenVideo.style.pointerEvents = 'none';
  hiddenVideo.style.width = '1px';
  hiddenVideo.style.height = '1px';
  document.body.appendChild(hiddenVideo);

  function init() {
    UI.cacheEls();
    UI.initProgress();
    UI.wireDashTabs();
    UI.wireModeSwitcher();
    UI.setMode('video');
    UI.refreshKeyStatus();
    wireModal();
    wireUpload();
    wireAnalyze();
    wireAssetCopy();
    wireImprove();
    wireExport();
    wirePromoUpload();
    wirePromoAnalyze();
    wirePromoExport();
    wireFreeAnalyze();
    wireFreeExport();
  }

  /* ---- API key modal ---- */
  function wireModal() {
    const { apiKeyBtn, heroKeyBtn, closeApiModal, modalOverlay, saveKeyBtn, removeKeyBtn, apiKeyInput, modelSelect, providerSelect } = UI.els;
    [apiKeyBtn, heroKeyBtn].forEach(btn => btn.addEventListener('click', () => {
      apiKeyInput.value = '';
      UI.refreshKeyStatus(); // repopulates provider/model fields + placeholder for the currently-selected provider
      UI.openModal();
    }));
    closeApiModal.addEventListener('click', UI.closeModal);
    modalOverlay.addEventListener('click', UI.closeModal);

    providerSelect.addEventListener('change', () => {
      Storage.setProvider(providerSelect.value);
      apiKeyInput.value = '';
      UI.refreshKeyStatus();
    });

    saveKeyBtn.addEventListener('click', () => {
      const provider = providerSelect.value;
      const val = apiKeyInput.value.trim();
      if (!val) { UI.toast('Masukkan key dulu sebelum disimpan.'); return; }
      Storage.setProvider(provider);
      Storage.setKey(val, provider);
      Storage.setModel(modelSelect.value, provider);
      apiKeyInput.value = '';
      UI.refreshKeyStatus();
      UI.closeModal();
      UI.toast(`Key ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} disimpan di browser ini.`);
    });
    removeKeyBtn.addEventListener('click', () => {
      const provider = providerSelect.value;
      Storage.removeKey(provider);
      UI.refreshKeyStatus();
      UI.toast(`Key ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} dihapus.`);
    });
    modelSelect.addEventListener('change', () => Storage.setModel(modelSelect.value, providerSelect.value));
  }

  /* ---- Upload ---- */
  function wireUpload() {
    const { dropZone, fileInput, browseBtn, changeFileBtn, heroUploadBtn } = UI.els;
    browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    heroUploadBtn.addEventListener('click', () => UI.els.dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' }));

    ['dragenter', 'dragover'].forEach(evt => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); }));
    dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); });
    fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) loadFile(f); });

    changeFileBtn.addEventListener('click', () => {
      UI.els.previewWrap.classList.add('hidden');
      UI.els.uploadActions.classList.add('hidden');
      UI.els.fileInput.value = '';
      state.file = null;
    });
  }

  function loadFile(file) {
    const isVideoLike = file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
    if (!isVideoLike) { UI.toast('Unggah file MP4, MOV, atau WEBM ya.'); return; }
    state.file = file;
    UI.els.previewVideo.src = URL.createObjectURL(file);
    UI.els.previewWrap.classList.remove('hidden');
    UI.els.uploadActions.classList.remove('hidden');
    UI.els.metaGrid.innerHTML = `<div class="meta-card"><div class="meta-value">${Utils.fmtBytes(file.size)}</div><div class="meta-label">Ukuran File</div></div>`;
    UI.els.previewWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---- Analyze ---- */
  function wireAnalyze() {
    UI.els.analyzeBtn.addEventListener('click', async () => {
      if (!state.file) { UI.toast('Pilih video dulu ya.'); return; }
      if (!Storage.hasKey()) { UI.toast('Hubungkan API key dulu.'); UI.openModal(); return; }

      UI.els.progressWrap.classList.remove('hidden');
      UI.setProgress(2, 'metadata', 'Membaca file…');

      try {
        const ingestData = await VideoIngest.ingest(state.file, hiddenVideo, (pct, stage) => {
          const label = stage === 'metadata' ? 'Membaca durasi, resolusi & frame rate…' : 'Mengambil sampel frame & mendeteksi scene…';
          UI.setProgress(Utils.clamp(pct, 0, 70), stage, label);
        });
        state.ingestData = ingestData;
        UI.renderMeta(ingestData);

        const providerLabel = Storage.getProvider() === 'gemini' ? 'Gemini' : 'OpenAI';
        UI.setProgress(75, 'ai-analysis', `Mengirim ${ingestData.scenes.length} scene ke ${providerLabel} untuk analisis kreatif…`);
        const result = await AIClient.analyze(ingestData);
        state.result = result;

        UI.setProgress(100, 'ai-analysis', 'Analisis selesai.');
        setTimeout(() => UI.els.progressWrap.classList.add('hidden'), 400);

        renderResults();
      } catch (err) {
        console.error(err);
        UI.els.progressWrap.classList.add('hidden');
        handleApiError(err);
      }
    });
  }

  function handleApiError(err) {
    const msg = String(err?.message || err);
    const providerLabel = Storage.getProvider() === 'gemini' ? 'Gemini' : 'OpenAI';
    if (msg === 'NO_KEY') { UI.toast('Hubungkan API key dulu.'); UI.openModal(); return; }
    if (msg === 'FILE_READ_ERROR') { UI.toast('Video ini tidak bisa dibaca browser — coba format MP4/MOV/WEBM lain.', 4000); return; }
    if (msg === 'PARSE_ERROR') { UI.toast('Model membalas tapi formatnya tidak sesuai. Coba lagi — biasanya cuma sekali gagal.', 4000); return; }
    if (msg === 'TRUNCATED') { UI.toast('Jawaban AI terpotong karena kepanjangan. Coba lagi, atau pakai video/foto yang lebih pendek/sedikit.', 5000); return; }

    const apiMatch = msg.match(/^API_ERROR:(\d+):([\s\S]*)$/);
    if (apiMatch) {
      const status = apiMatch[1];
      let detail = apiMatch[2];
      // Try to pull just the human-readable message out of the provider's JSON error body.
      try {
        const parsed = JSON.parse(detail);
        detail = parsed.error?.message || parsed.error?.status || detail;
      } catch { /* not JSON, use as-is */ }
      detail = detail.replace(/\s+/g, ' ').trim().slice(0, 220);

      if (status === '429') { UI.toast(`Kena limit dari ${providerLabel} — tunggu sebentar lalu coba lagi.`, 4000); return; }
      if (status === '401' || status === '403') { UI.toast(`${providerLabel} menolak key ini (HTTP ${status}): ${detail}`, 6000); UI.openModal(); return; }
      UI.toast(`Error dari ${providerLabel} (HTTP ${status}): ${detail}`, 6000);
      return;
    }

    // No API_ERROR prefix at all — the request never got a response (network/CORS/offline).
    UI.toast(`Gagal menghubungi ${providerLabel}: ${msg.slice(0, 200)}`, 6000);
  }

  let assetTabController = null;
  function renderResults() {
    const r = state.result;
    UI.renderScores(r.scores);
    UI.renderSignals(r.signals);
    UI.renderReverse(r.reverseEngineering);
    UI.renderSceneTable(r.scenes, state.ingestData.scenes);
    assetTabController = UI.renderAssets(r.assets);
    UI.els.resultsRoot.classList.remove('hidden');
    UI.els.resultsRoot.classList.add('has-results');
    UI.els.resultsRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function wireAssetCopy() {
    UI.els.copyAssetBtn.addEventListener('click', () => copyText(UI.els.assetOutput.textContent));
    UI.els.copyImproveBtn.addEventListener('click', () => copyText(UI.els.improveOutput.textContent));
  }
  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => UI.toast('Disalin ke clipboard.'), () => UI.toast('Gagal menyalin — pilih teksnya manual ya.'));
  }

  /* ---- Make It Better ---- */
  function wireImprove() {
    UI.els.improveBtn.addEventListener('click', async () => {
      if (!state.result) return;
      if (!Storage.hasKey()) { UI.toast('Hubungkan API key dulu.'); UI.openModal(); return; }
      UI.els.improveBtn.disabled = true;
      UI.els.improveBtn.textContent = 'Membuat konsep yang lebih kuat…';
      try {
        const improveResult = await AIClient.makeItBetter(state.result, state.ingestData);
        state.improveResult = improveResult;
        UI.renderScoreCompare(state.result.scores, improveResult.scores);
        UI.renderImproveAssets(improveResult);
        UI.els.improveResult.classList.remove('hidden');
      } catch (err) {
        console.error(err);
        handleApiError(err);
      } finally {
        UI.els.improveBtn.disabled = false;
        UI.els.improveBtn.textContent = '🔥 Buat Lebih Baik';
      }
    });
  }

  /* ---- Export ---- */
  function wireExport() {
    UI.els.exportTxt.addEventListener('click', () => { if (state.result) Exporter.exportTxt(state.ingestData, state.result, state.improveResult); });
    UI.els.exportMd.addEventListener('click', () => { if (state.result) Exporter.exportMd(state.ingestData, state.result, state.improveResult); });
    UI.els.exportJson.addEventListener('click', () => { if (state.result) Exporter.exportJson(state.ingestData, state.result, state.improveResult); });
    UI.els.startOverBtn.addEventListener('click', () => {
      state.file = null; state.ingestData = null; state.result = null; state.improveResult = null;
      UI.els.resultsRoot.classList.add('hidden');
      UI.els.resultsRoot.classList.remove('has-results');
      UI.els.improveResult.classList.add('hidden');
      UI.els.previewWrap.classList.add('hidden');
      UI.els.uploadActions.classList.add('hidden');
      UI.els.fileInput.value = '';
      document.getElementById('uploadSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ---- Promo mode: reference video ingest ---- */
  const PROMO_STYLE_LABELS = {
    'santai-ceria': 'Santai & ceria', 'elegan-premium': 'Elegan & premium',
    'cepat-energik': 'Cepat & energik (gaya TikTok)', 'hangat-personal': 'Hangat & personal',
  };
  const promoState = { file: null, ingestData: null, result: null, form: null };

  const hiddenPromoVideo = document.createElement('video');
  hiddenPromoVideo.preload = 'metadata';
  hiddenPromoVideo.playsInline = true;
  hiddenPromoVideo.style.position = 'fixed';
  hiddenPromoVideo.style.opacity = '0';
  hiddenPromoVideo.style.pointerEvents = 'none';
  hiddenPromoVideo.style.width = '1px';
  hiddenPromoVideo.style.height = '1px';
  document.body.appendChild(hiddenPromoVideo);

  function loadPromoFile(file) {
    const isVideoLike = file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
    if (!isVideoLike) { UI.toast('Unggah file MP4, MOV, atau WEBM ya.'); return; }
    promoState.file = file;
    UI.els.promoPreviewVideo.src = URL.createObjectURL(file);
    UI.els.promoPreviewWrap.classList.remove('hidden');
    UI.els.promoForm.classList.remove('hidden');
    UI.els.promoMetaGrid.innerHTML = `<div class="meta-card"><div class="meta-value">${Utils.fmtBytes(file.size)}</div><div class="meta-label">Ukuran File</div></div>`;
    UI.els.promoPreviewWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function wirePromoUpload() {
    const { promoDropZone, promoFileInput, promoBrowseBtn, promoChangeBtn } = UI.els;
    promoBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); promoFileInput.click(); });
    promoDropZone.addEventListener('click', () => promoFileInput.click());
    promoDropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') promoFileInput.click(); });

    ['dragenter', 'dragover'].forEach(evt => promoDropZone.addEventListener(evt, (e) => { e.preventDefault(); promoDropZone.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach(evt => promoDropZone.addEventListener(evt, (e) => { e.preventDefault(); promoDropZone.classList.remove('drag-over'); }));
    promoDropZone.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) loadPromoFile(f); });
    promoFileInput.addEventListener('change', () => { const f = promoFileInput.files?.[0]; if (f) loadPromoFile(f); });

    promoChangeBtn.addEventListener('click', () => {
      promoState.file = null; promoState.ingestData = null;
      UI.els.promoPreviewWrap.classList.add('hidden');
      UI.els.promoForm.classList.add('hidden');
      promoFileInput.value = '';
    });
  }

  /* ---- Promo mode: analyze ---- */
  function wirePromoAnalyze() {
    UI.els.promoAnalyzeBtn.addEventListener('click', async () => {
      if (!promoState.file) { UI.toast('Unggah video referensi dulu ya.'); return; }
      if (!Storage.hasKey()) { UI.toast('Hubungkan API key dulu.'); UI.openModal(); return; }

      const form = {
        name: UI.els.promoBizName.value.trim(),
        type: UI.els.promoBizType.value.trim(),
        location: UI.els.promoBizLocation.value.trim(),
        highlight: UI.els.promoHighlight.value.trim(),
        style: UI.els.promoStyle.value,
        styleLabel: PROMO_STYLE_LABELS[UI.els.promoStyle.value] || UI.els.promoStyle.value,
        cta: UI.els.promoCta.value.trim(),
      };
      promoState.form = form;

      UI.els.promoProgressWrap.classList.remove('hidden');
      UI.els.promoProgressFill.style.width = '15%';
      UI.els.promoProgressLabel.textContent = 'Membaca video referensi & mendeteksi scene…';

      try {
        const ingestData = await VideoIngest.ingest(promoState.file, hiddenPromoVideo, (pct) => {
          UI.els.promoProgressFill.style.width = `${Utils.clamp(Math.round(pct * 0.5), 10, 50)}%`;
        });
        promoState.ingestData = ingestData;

        const providerLabel = Storage.getProvider() === 'gemini' ? 'Gemini' : 'OpenAI';
        UI.els.promoProgressFill.style.width = '65%';
        UI.els.promoProgressLabel.textContent = `Mengirim ${ingestData.scenes.length} scene referensi ke ${providerLabel}…`;

        const result = await PromoClient.analyze(ingestData, form);
        promoState.result = result;
        UI.els.promoProgressFill.style.width = '100%';
        UI.els.promoProgressLabel.textContent = 'Selesai.';
        setTimeout(() => UI.els.promoProgressWrap.classList.add('hidden'), 400);

        UI.renderPromoConcept(result);
        UI.renderPromoAssets(result);
        UI.els.promoResultsRoot.classList.remove('hidden');
        UI.els.promoResultsRoot.classList.add('has-results');
        UI.els.promoResultsRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        console.error(err);
        UI.els.promoProgressWrap.classList.add('hidden');
        handleApiError(err);
      }
    });

    UI.els.copyPromoAssetBtn.addEventListener('click', () => copyText(UI.els.promoAssetOutput.textContent));
  }

  /* ---- Promo mode: export ---- */
  function wirePromoExport() {
    UI.els.promoExportTxt.addEventListener('click', () => { if (promoState.result) Exporter.exportPromoTxt(promoState.form, promoState.result); });
    UI.els.promoExportMd.addEventListener('click', () => { if (promoState.result) Exporter.exportPromoMd(promoState.form, promoState.result); });
    UI.els.promoExportJson.addEventListener('click', () => { if (promoState.result) Exporter.exportPromoJson(promoState.form, promoState.result); });
    UI.els.promoStartOverBtn.addEventListener('click', () => {
      promoState.file = null; promoState.ingestData = null; promoState.result = null; promoState.form = null;
      UI.els.promoFileInput.value = '';
      UI.els.promoPreviewWrap.classList.add('hidden');
      UI.els.promoForm.classList.add('hidden');
      UI.els.promoResultsRoot.classList.add('hidden');
      UI.els.promoResultsRoot.classList.remove('has-results');
      document.getElementById('promoUploadSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ---- Free mode ("Video Bebas"): analyze ---- */
  const freeState = { result: null, form: null };

  function wireFreeAnalyze() {
    UI.els.freeAnalyzeBtn.addEventListener('click', async () => {
      const title = UI.els.freeTitle.value.trim();
      const theme = UI.els.freeTheme.value.trim();
      if (!title || !theme) { UI.toast('Judul dan tema wajib diisi ya.'); return; }
      if (!Storage.hasKey()) { UI.toast('Hubungkan API key dulu.'); UI.openModal(); return; }

      const form = {
        title, theme,
        duration: UI.els.freeDuration.value,
        style: UI.els.freeStyle.value,
        materi: UI.els.freeMateri.value.trim(),
      };
      freeState.form = form;

      UI.els.freeProgressWrap.classList.remove('hidden');
      UI.els.freeProgressFill.style.width = '25%';
      const providerLabel = Storage.getProvider() === 'gemini' ? 'Gemini' : 'OpenAI';
      UI.els.freeProgressLabel.textContent = `Menyusun ide & mengirim ke ${providerLabel}…`;

      try {
        const result = await FreeModeClient.analyze(form);
        freeState.result = result;
        UI.els.freeProgressFill.style.width = '100%';
        UI.els.freeProgressLabel.textContent = 'Selesai.';
        setTimeout(() => UI.els.freeProgressWrap.classList.add('hidden'), 400);

        UI.renderFreeConcept(result);
        UI.renderFreeAssets(result);
        UI.els.freeResultsRoot.classList.remove('hidden');
        UI.els.freeResultsRoot.classList.add('has-results');
        UI.els.freeResultsRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        console.error(err);
        UI.els.freeProgressWrap.classList.add('hidden');
        handleApiError(err);
      }
    });

    UI.els.copyFreeAssetBtn.addEventListener('click', () => copyText(UI.els.freeAssetOutput.textContent));
  }

  /* ---- Free mode: export ---- */
  function wireFreeExport() {
    // Reuses the promo exporter functions — a "form" with name/type/styleLabel
    // and a "result" with concept/assets is exactly what those expect.
    const asPromoForm = () => ({
      name: freeState.form?.title, type: `Video Bebas — ${freeState.form?.theme || ''}`,
      styleLabel: freeState.result?.recommendedStyle || freeState.form?.style || '-',
    });
    UI.els.freeExportTxt.addEventListener('click', () => { if (freeState.result) Exporter.exportPromoTxt(asPromoForm(), freeState.result); });
    UI.els.freeExportMd.addEventListener('click', () => { if (freeState.result) Exporter.exportPromoMd(asPromoForm(), freeState.result); });
    UI.els.freeExportJson.addEventListener('click', () => { if (freeState.result) Exporter.exportPromoJson(asPromoForm(), freeState.result); });
    UI.els.freeStartOverBtn.addEventListener('click', () => {
      freeState.result = null; freeState.form = null;
      UI.els.freeTitle.value = ''; UI.els.freeTheme.value = ''; UI.els.freeDuration.value = '';
      UI.els.freeStyle.value = ''; UI.els.freeMateri.value = '';
      UI.els.freeResultsRoot.classList.add('hidden');
      UI.els.freeResultsRoot.classList.remove('has-results');
      document.getElementById('freeUploadSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
