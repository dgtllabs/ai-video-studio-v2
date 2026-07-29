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
      const onErr = () => { cleanup(); reject(new Error('Could not read this video file.')); };
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
    "imageGridStoryboardPrompt": "", "omniFlashPrompt": "", "klingPrompt": "",
    "veoPrompt": "", "hailuoPrompt": "", "voiceOverScript": "", "caption": "", "cta": "",
    "alternativeHooks": ["", "", ""], "alternativeConcepts": ["", ""]
  }
}

Every "scenes" entry must correspond, in order, to the scene frames provided below. All string fields must be filled with real, specific analysis — never leave a field empty or generic.`;

  const SYSTEM_ANALYSIS = 'You are an expert AI video analyst. You always respond with valid, complete JSON matching the exact schema you are given.';
  const SYSTEM_IMPROVE = 'You are an expert AI creative director specializing in high-performing short-form commerce video. You always respond with valid, complete JSON matching the exact schema you are given.';

  function analysisIntroText(ingestData) {
    return `You are a world-class short-form video creative director, performance-marketing strategist, and cinematographer. Analyze the following video, reconstructed as ${ingestData.scenes.length} representative scene frames sampled across ${Utils.fmtTime(ingestData.duration)} of footage (${ingestData.width}x${ingestData.height}).`;
  }

  function improveText(analysisResult, ingestData) {
    const compact = {
      signals: analysisResult.signals,
      scores: Object.fromEntries(Object.entries(analysisResult.scores || {}).map(([k, v]) => [k, v.score])),
      reverseEngineering: analysisResult.reverseEngineering,
      assets: { winningConcept: analysisResult.assets?.winningConcept },
    };
    return `You previously analyzed a ${Utils.fmtTime(ingestData.duration)} short-form video. Here is a compact summary of that analysis:

${JSON.stringify(compact, null, 2)}

Now create a STRONGER, ORIGINAL alternative concept that fixes this video's weaknesses. Do not copy the original video's script or visuals — improve the underlying hook, storytelling, retention, emotion, selling, and checkout mechanics instead.

Respond with ONLY a raw JSON object, no markdown fences, in exactly this shape:
{
  "scores": {"stopScroll":0,"entertainment":0,"curiosity":0,"watchTime":0,"emotionalImpact":0,"trust":0,"sellingEffectiveness":0,"checkoutPotential":0,"overall":0},
  "whatChanged": "",
  "winningConcept": "", "creativeBlueprint": "", "tiktokStoryboard": "",
  "voiceOverScript": "", "caption": "", "cta": "",
  "alternativeHooks": ["", "", ""], "alternativeConcepts": ["", ""]
}
Every score must be higher than or equal to the original where realistically justified, and "whatChanged" must explain the improvement in 2-3 sentences.`;
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
  async function callOpenAI(messages) {
    const key = Storage.getKey('openai');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: Storage.getModel('openai'), messages, temperature: 0.7, max_tokens: 4000 }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API_ERROR:${res.status}:${body.slice(0, 200)}`);
    }
    const data = await res.json();
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
  async function callGemini(systemText, parts) {
    const key = Storage.getKey('gemini');
    const model = Storage.getModel('gemini');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4000 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API_ERROR:${res.status}:${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    return (cand?.content?.parts || []).map(p => p.text || '').join('');
  }

  /* ---- Provider-agnostic entry points ---- */
  async function analyze(ingestData) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const raw = provider === 'gemini'
      ? await callGemini(SYSTEM_ANALYSIS, buildGeminiAnalysisContents(ingestData))
      : await callOpenAI(buildOpenAIAnalysisMessages(ingestData));
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  async function makeItBetter(analysisResult, ingestData) {
    if (!Storage.hasKey()) throw new Error('NO_KEY');
    const provider = Storage.getProvider();
    const raw = provider === 'gemini'
      ? await callGemini(SYSTEM_IMPROVE, [{ text: improveText(analysisResult, ingestData) }])
      : await callOpenAI(buildOpenAIImproveMessages(analysisResult, ingestData));
    const parsed = Utils.parseJsonLoose(raw);
    if (!parsed) throw new Error('PARSE_ERROR');
    return parsed;
  }

  return { analyze, makeItBetter };
})();

/* ============================= UI ============================= */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const els = {};

  const SCORE_LABELS = {
    stopScroll: 'Stop Scroll', entertainment: 'Entertainment', curiosity: 'Curiosity',
    watchTime: 'Watch Time', emotionalImpact: 'Emotional Impact', trust: 'Trust',
    sellingEffectiveness: 'Selling Effectiveness', checkoutPotential: 'Checkout Potential', overall: 'Overall Viral Potential',
  };
  const SIGNAL_LABELS = {
    hook: 'Hook', storytelling: 'Storytelling', emotionalFlow: 'Emotional Flow', audiencePsychology: 'Audience Psychology',
    sellingStrategy: 'Selling Strategy', entertainmentStrategy: 'Entertainment Strategy', productIntegration: 'Product Integration',
    character: 'Character', cameraAngle: 'Camera Angle', cameraMovement: 'Camera Movement', shotType: 'Shot Type',
    lighting: 'Lighting', colorGrading: 'Color Grading', motion: 'Motion', environment: 'Environment',
    productVisibility: 'Product Visibility', facialExpression: 'Facial Expression', subtitleStyle: 'Subtitle Style',
    voiceOverStyle: 'Voice Over Style', cta: 'CTA', musicMood: 'Music Mood', sceneTiming: 'Scene Timing', sceneChanges: 'Scene Changes',
  };
  const ASSET_LABELS = {
    winningConcept: 'Winning Content Concept', creativeBlueprint: 'Creative Blueprint', tiktokStoryboard: 'TikTok Storyboard',
    imageGridStoryboardPrompt: 'Image Grid Storyboard', omniFlashPrompt: 'OmniFlash JSON Prompt', klingPrompt: 'Kling Prompt',
    veoPrompt: 'Veo Prompt', hailuoPrompt: 'Hailuo Prompt', voiceOverScript: 'Voice Over Script', caption: 'Caption',
    cta: 'CTA', alternativeHooks: 'Alternative Hooks', alternativeConcepts: 'Alternative Concepts',
  };

  function cacheEls() {
    ['dropZone','fileInput','browseBtn','previewWrap','previewVideo','metaGrid','uploadActions','analyzeBtn',
     'changeFileBtn','progressWrap','progressSteps','progressFill','progressLabel','resultsRoot','dashTabs',
     'overallRing','overallScoreNum','scoreList','signalCardGrid','reverseGrid','strengthsWeaknesses',
     'sceneTableBody','assetTabs','assetOutput','copyAssetBtn','improveBtn','improveIntro','improveResult',
     'scoreCompare','improveTabs','improveOutput','copyImproveBtn','exportTxt','exportMd','exportJson',
     'startOverBtn','apiKeyBtn','apiKeyBtnLabel','heroKeyBtn','heroUploadBtn','modalOverlay','apiKeyModal',
     'closeApiModal','providerSelect','providerHint','getKeyHint','apiKeyInput','modelSelect','keyStatus',
     'removeKeyBtn','saveKeyBtn','toast']
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
      hint: 'Free tier — no credit card required. Rate-limited (fine for personal use). Google retires/renames free models often — if a model errors as unavailable, switch to another one in this list.',
      getKeyHint: 'Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com/app/apikey</a>.',
      models: [
        { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (recommended — free, vision)' },
        { value: 'gemini-3.6-flash', label: 'gemini-3.6-flash (newest, may have tighter free quota)' },
        { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (legacy — may be unavailable on new accounts)' },
        { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro (higher quality, lower free quota)' },
      ],
    },
    openai: {
      label: 'OpenAI',
      keyPlaceholder: 'sk-...',
      hint: 'Paid — requires a card on file and a small minimum top-up (around $5).',
      getKeyHint: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>.',
      models: [
        { value: 'gpt-4o', label: 'gpt-4o (recommended — vision + text)' },
        { value: 'gpt-4o-mini', label: 'gpt-4o-mini (faster, lower cost)' },
        { value: 'gpt-4.1', label: 'gpt-4.1' },
      ],
    },
  };

  function populateProviderFields(provider) {
    const info = PROVIDER_INFO[provider];
    els.providerHint.innerHTML = info.hint;
    els.getKeyHint.innerHTML = info.getKeyHint;
    els.apiKeyInput.placeholder = Storage.hasKey(provider) ? 'Enter a new key to replace the saved one' : info.keyPlaceholder;
    els.modelSelect.innerHTML = info.models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
    els.modelSelect.value = Storage.getModel(provider);
  }

  function refreshKeyStatus() {
    const provider = Storage.getProvider();
    els.providerSelect.value = provider;
    populateProviderFields(provider);
    const has = Storage.hasKey(provider);
    els.keyStatus.textContent = has ? `Connected — ${PROVIDER_INFO[provider].label} ${Storage.maskedKey(provider)}` : 'No key saved yet.';
    els.keyStatus.classList.toggle('connected', has);
    els.apiKeyBtnLabel.textContent = has ? `${PROVIDER_INFO[provider].label} connected` : 'Connect a free AI key';
  }

  /* ---- Progress ---- */
  const STEP_LABELS = ['metadata', 'scenes', 'ai-analysis'];
  function initProgress() {
    els.progressSteps.innerHTML = STEP_LABELS.map(s => `<span data-step="${s}">${s}</span>`).join('');
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
      { label: 'Duration', value: Utils.fmtTime(ingestData.duration) },
      { label: 'Resolution', value: `${ingestData.width}×${ingestData.height}` },
      { label: 'Frame rate', value: ingestData.fps ? `${ingestData.fps} fps` : 'Not available' },
      { label: 'File size', value: Utils.fmtBytes(ingestData.fileSize) },
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
    const keys = ['winningConcept','creativeBlueprint','tiktokStoryboard','imageGridStoryboardPrompt','omniFlashPrompt','klingPrompt','veoPrompt','hailuoPrompt','voiceOverScript','caption','cta','alternativeHooks','alternativeConcepts'];
    return renderAssetTabs(els.assetTabs, els.assetOutput, assets, keys);
  }

  function renderImproveAssets(improveResult) {
    const keys = ['winningConcept','creativeBlueprint','tiktokStoryboard','voiceOverScript','caption','cta','alternativeHooks','alternativeConcepts'];
    return renderAssetTabs(els.improveTabs, els.improveOutput, improveResult, keys);
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
      `Duration: ${Utils.fmtTime(ingestData.duration)}  Resolution: ${ingestData.width}x${ingestData.height}`, ''];
    lines.push('-- SCORES --');
    Object.entries(result.scores).forEach(([k, v]) => lines.push(`${UI.SCORE_LABELS[k] || k}: ${v.score} — ${v.explanation}`));
    lines.push('', '-- SIGNALS --');
    Object.entries(result.signals).forEach(([k, v]) => lines.push(`${UI.SIGNAL_LABELS[k] || k}: ${v}`));
    lines.push('', '-- REVERSE ENGINEERING --');
    Object.entries(result.reverseEngineering).forEach(([k, v]) => {
      if (Array.isArray(v)) lines.push(`${k}: ${v.join(' | ')}`); else lines.push(`${k}: ${v}`);
    });
    lines.push('', '-- SCENE BREAKDOWN --');
    result.scenes.forEach(s => lines.push(`Scene ${s.index}: ${s.purpose} | ${s.visual} | Camera: ${s.camera} | Motion: ${s.motion} | Emotion: ${s.emotion} | VO: ${s.voiceOver} | Subtitle: ${s.subtitle} | Transition: ${s.transition}`));
    lines.push('', '-- PRODUCTION ASSETS --');
    Object.entries(result.assets).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k} ###`);
      lines.push(Array.isArray(v) ? v.join('\n') : v);
      lines.push('');
    });
    if (improveResult) {
      lines.push('-- MAKE IT BETTER --');
      lines.push(`What changed: ${improveResult.whatChanged}`);
      Object.entries(improveResult.scores).forEach(([k, v]) => lines.push(`${UI.SCORE_LABELS[k] || k} (new): ${v}`));
    }
    return lines.join('\n');
  }

  function toMarkdown(ingestData, result, improveResult) {
    const lines = [`# AI Video Intelligence Studio — Teardown`, `**File:** ${ingestData.fileName}  \n**Duration:** ${Utils.fmtTime(ingestData.duration)}  \n**Resolution:** ${ingestData.width}x${ingestData.height}`];
    lines.push('\n## Scores\n');
    Object.entries(result.scores).forEach(([k, v]) => lines.push(`- **${UI.SCORE_LABELS[k] || k}:** ${v.score}/100 — ${v.explanation}`));
    lines.push('\n## Signals\n');
    Object.entries(result.signals).forEach(([k, v]) => lines.push(`- **${UI.SIGNAL_LABELS[k] || k}:** ${v}`));
    lines.push('\n## Scene Breakdown\n');
    lines.push('| Scene | Purpose | Visual | Camera | Motion | Emotion | Voice Over | Subtitle | Transition |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    result.scenes.forEach(s => lines.push(`| ${s.index} | ${s.purpose} | ${s.visual} | ${s.camera} | ${s.motion} | ${s.emotion} | ${s.voiceOver} | ${s.subtitle} | ${s.transition} |`));
    lines.push('\n## Production Assets\n');
    Object.entries(result.assets).forEach(([k, v]) => {
      lines.push(`### ${UI.ASSET_LABELS[k] || k}\n`);
      lines.push('```\n' + (Array.isArray(v) ? v.join('\n') : v) + '\n```\n');
    });
    if (improveResult) {
      lines.push('\n## 🔥 Make It Better\n');
      lines.push(`**What changed:** ${improveResult.whatChanged}\n`);
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

  return { exportTxt, exportMd, exportJson };
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
    UI.refreshKeyStatus();
    wireModal();
    wireUpload();
    wireAnalyze();
    wireAssetCopy();
    wireImprove();
    wireExport();
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
      if (!val) { UI.toast('Enter a key before saving.'); return; }
      Storage.setProvider(provider);
      Storage.setKey(val, provider);
      Storage.setModel(modelSelect.value, provider);
      apiKeyInput.value = '';
      UI.refreshKeyStatus();
      UI.closeModal();
      UI.toast(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} key saved to this browser.`);
    });
    removeKeyBtn.addEventListener('click', () => {
      const provider = providerSelect.value;
      Storage.removeKey(provider);
      UI.refreshKeyStatus();
      UI.toast(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} key removed.`);
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
    if (!isVideoLike) { UI.toast('Please upload an MP4, MOV, or WEBM file.'); return; }
    state.file = file;
    UI.els.previewVideo.src = URL.createObjectURL(file);
    UI.els.previewWrap.classList.remove('hidden');
    UI.els.uploadActions.classList.remove('hidden');
    UI.els.metaGrid.innerHTML = `<div class="meta-card"><div class="meta-value">${Utils.fmtBytes(file.size)}</div><div class="meta-label">File size</div></div>`;
    UI.els.previewWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---- Analyze ---- */
  function wireAnalyze() {
    UI.els.analyzeBtn.addEventListener('click', async () => {
      if (!state.file) { UI.toast('Choose a video first.'); return; }
      if (!Storage.hasKey()) { UI.toast('Connect an AI key first.'); UI.openModal(); return; }

      UI.els.progressWrap.classList.remove('hidden');
      UI.setProgress(2, 'metadata', 'Reading file…');

      try {
        const ingestData = await VideoIngest.ingest(state.file, hiddenVideo, (pct, stage) => {
          const label = stage === 'metadata' ? 'Reading duration, resolution & frame rate…' : 'Sampling frames & detecting scenes…';
          UI.setProgress(Utils.clamp(pct, 0, 70), stage, label);
        });
        state.ingestData = ingestData;
        UI.renderMeta(ingestData);

        UI.setProgress(75, 'ai-analysis', `Sending ${ingestData.scenes.length} scenes to OpenAI for creative analysis…`);
        const result = await AIClient.analyze(ingestData);
        state.result = result;

        UI.setProgress(100, 'ai-analysis', 'Analysis complete.');
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
    if (msg === 'NO_KEY') { UI.toast('Connect an AI key first.'); UI.openModal(); return; }
    if (msg === 'PARSE_ERROR') { UI.toast('The model replied but not in the expected format. Try again — this is usually a one-off.', 4000); return; }

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

      if (status === '429') { UI.toast(`Rate limited by ${providerLabel} — wait a moment and try again.`, 4000); return; }
      if (status === '401' || status === '403') { UI.toast(`${providerLabel} rejected that key (HTTP ${status}): ${detail}`, 6000); UI.openModal(); return; }
      UI.toast(`${providerLabel} error (HTTP ${status}): ${detail}`, 6000);
      return;
    }

    // No API_ERROR prefix at all — the request never got a response (network/CORS/offline).
    UI.toast(`Could not reach ${providerLabel}: ${msg.slice(0, 200)}`, 6000);
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
    UI.els.resultsRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function wireAssetCopy() {
    UI.els.copyAssetBtn.addEventListener('click', () => copyText(UI.els.assetOutput.textContent));
    UI.els.copyImproveBtn.addEventListener('click', () => copyText(UI.els.improveOutput.textContent));
  }
  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => UI.toast('Copied to clipboard.'), () => UI.toast('Could not copy — select the text manually.'));
  }

  /* ---- Make It Better ---- */
  function wireImprove() {
    UI.els.improveBtn.addEventListener('click', async () => {
      if (!state.result) return;
      if (!Storage.hasKey()) { UI.toast('Connect an AI key first.'); UI.openModal(); return; }
      UI.els.improveBtn.disabled = true;
      UI.els.improveBtn.textContent = 'Generating a stronger concept…';
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
        UI.els.improveBtn.textContent = '🔥 Make It Better';
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
      UI.els.improveResult.classList.add('hidden');
      UI.els.previewWrap.classList.add('hidden');
      UI.els.uploadActions.classList.add('hidden');
      UI.els.fileInput.value = '';
      document.getElementById('uploadSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
