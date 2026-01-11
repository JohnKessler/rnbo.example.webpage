// playlist-ui.js
// RNBO Playlist UI — stable core behavior + Penpot-driven styling
// Version: v1.9 (2026-01-11)
//
// Changes in v1.9:
// - Adds optional RNBO 'jumpto' parameter support (ms) with auto-detection for normalized 0..1 exports.
// - Uses jumpto for deterministic Play-from-start and reverse-start, and for header progress-bar seeking when available.
// - Ensures outGain is initialized (prevents silent output when patch initial value isn't applied).
// - Keeps all existing UI class names / structure so your CSS stays intact.
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Optional RNBO parameter (by id):
//   jumpto (ms; if exported with max<=1, treated as normalized 0..1)
//
// Expected RNBO external buffer name:
//   "sample"
// Expected port message tag (outport):
//   "playhead" with ms as payload[0]

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";
  const MANIFEST_URL = MEDIA_BASE + "playlist.json";
  const ORDER_KEY = "rnbo_playlist_order_v5";

  const WAVE_W = 520;
  const WAVE_H = 80;

  // UI tick / playhead handling
  const UI_THROTTLE_MS = 16;
  const PORT_FRESH_MS = 300; // if port is stale, estimate from AudioContext time
  const END_EPS_MS = 3; // ms epsilon for EOF detection

  // Reverse EOF handling
  const REVERSE_EOF_GRACE_MS = 140; // grace window right after hitting play in reverse
  const REVERSE_LOOP_ASSIST_MS = 140; // legacy assist when no jumpto exists (kept)

  // Preload complete fade behavior
  const PRELOAD_FADE_DELAY_MS = 350;
  const PRELOAD_FADE_DURATION_MS = 900;

  // ----------------------------
  // Helpers
  // ----------------------------
  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function ensureParam(device, id) {
    const p =
      device.parametersById?.get(id) ||
      (device.parameters || []).find((pp) => pp.id === id);
    if (!p) throw new Error(`Missing RNBO parameter id="${id}"`);
    return p;
  }

  function pulseParam(param, ms = 20) {
    try {
      param.value = 1;
      setTimeout(() => {
        try {
          param.value = 0;
        } catch (_) {}
      }, ms);
    } catch (_) {}
  }

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url}`);
    return r.json();
  }

  async function fetchArrayBuffer(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url}`);
    return r.arrayBuffer();
  }

  function saveOrder(names) {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(names));
    } catch (_) {}
  }

  function loadOrder() {
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function isTextInputTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || t.isContentEditable;
  }

  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);

    if (props.dataset) {
      Object.entries(props.dataset).forEach(([k, v]) => (el.dataset[k] = v));
      delete props.dataset;
    }

    if (props.ariaLabel) {
      el.setAttribute("aria-label", props.ariaLabel);
      delete props.ariaLabel;
    }

    Object.assign(el, props);
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function msToTime(ms) {
    const t = Math.max(0, Math.floor(ms));
    const sec = Math.floor(t / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // ----------------------------
  // Premium header effects (kept)
  // ----------------------------
  function installPremiumHeaderEffects(topEl, scrollEl) {
    if (!topEl || !scrollEl) return;

    let lastTop = scrollEl.scrollTop || 0;
    let lastT = performance.now();
    let rafPending = false;

    function setSep(intensity01, vel01) {
      const sep = clamp01(intensity01);
      const v = clamp01(vel01);

      const shadowA = sep * (0.22 + 0.12 * v);
      const shadowB = sep * (0.16 + 0.08 * v);
      const fadeStart = sep * (0.75 + 0.2 * v);

      topEl.style.setProperty("--sep", String(sep));
      topEl.style.setProperty("--shadowA", shadowA.toFixed(3));
      topEl.style.setProperty("--shadowB", shadowB.toFixed(3));
      topEl.style.setProperty("--fadeStart", fadeStart.toFixed(3));
    }

    function update() {
      rafPending = false;

      const now = performance.now();
      const st = scrollEl.scrollTop || 0;

      const dt = Math.max(8, now - lastT);
      const dy = st - lastTop;
      const vel = Math.abs(dy) / (dt / 1000);
      const vel01 = clamp01(vel / 1800);

      const intensity01 = st > 2 ? 1 : st > 0 ? 0.35 : 0;
      setSep(intensity01, vel01);

      lastTop = st;
      lastT = now;
    }

    function onScroll() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(update);
    }

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    setSep((scrollEl.scrollTop || 0) > 2 ? 1 : 0, 0);
  }

  // ----------------------------
  // Waveform drawing
  // ----------------------------
  function buildPeaks(audioBuffer, width) {
    const ch0 = audioBuffer.getChannelData(0);
    const len = ch0.length;
    const spp = Math.max(1, Math.floor(len / width));
    const peaks = new Float32Array(width * 2);

    for (let x = 0; x < width; x++) {
      let min = 1,
        max = -1;
      const start = x * spp;
      const end = Math.min(len, (x + 1) * spp);
      for (let i = start; i < end; i++) {
        const v = ch0[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[x * 2] = min;
      peaks[x * 2 + 1] = max;
    }
    return peaks;
  }

  function drawWaveform(canvas, peaks, playheadFracOrNull) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // waveform
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      const y1 = (1 - (max * 0.5 + 0.5)) * h;
      const y2 = (1 - (min * 0.5 + 0.5)) * h;
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    if (playheadFracOrNull != null) {
      const frac = clamp01(playheadFracOrNull);
      const x = frac * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  // ----------------------------
  // Icons (kept)
  // ----------------------------
  const ICON_PLAY =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_STOP =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="7" y="7" width="10" height="10"/></svg>';
  const ICON_LOOP =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M17 1l4 4-4 4V6H7a4 4 0 0 0 0 8h1v2H7a6 6 0 0 1 0-12h10V1zM7 23l-4-4 4-4v3h10a4 4 0 0 0 0-8h-1V8h1a6 6 0 0 1 0 12H7v3z"/></svg>';

  function iconSVG(svgStr) {
    const wrap = document.createElement("span");
    wrap.className = "rnbo-icon";
    wrap.innerHTML = svgStr;
    return wrap;
  }

  // ----------------------------
  // UI Build (kept structure / class names)
  // ----------------------------
  function buildUI() {
    const root = document.getElementById("playlist-ui");
    if (!root) throw new Error('Missing #playlist-ui container in playlist.html');

    const top = createEl("div", { className: "rnbo-top" });
    const scroll = createEl("div", { className: "rnbo-scroll" });
    const list = createEl("div", { className: "rnbo-list" });

    // Title + preload line
    const title = createEl("div", { className: "rnbo-title", innerText: "Playlist" });
    const preload = createEl("div", { className: "rnbo-preload", innerText: "Preload: 0%" });
    const titleStack = createEl("div", { className: "rnbo-title-stack" }, [title, preload]);

    // Transport row
    const btnPlay = createEl(
      "button",
      { className: "rnbo-btn rnbo-iconbtn rnbo-play", type: "button", title: "Play", ariaLabel: "Play" },
      [iconSVG(ICON_PLAY)]
    );
    const btnStop = createEl(
      "button",
      { className: "rnbo-btn rnbo-iconbtn rnbo-stop", type: "button", title: "Stop", ariaLabel: "Stop" },
      [iconSVG(ICON_STOP)]
    );
    const btnLoop = createEl(
      "button",
      { className: "rnbo-btn rnbo-iconbtn rnbo-loop", type: "button", title: "Loop", ariaLabel: "Loop" },
      [iconSVG(ICON_LOOP)]
    );
    const transportLeft = createEl("div", { className: "transport-left" }, [btnPlay, btnStop, btnLoop]);

    const rate = createEl("input", {
      className: "rnbo-slider rnbo-rate-slider",
      type: "range",
      min: -2,
      max: 2,
      step: 0.01,
      value: 1,
      ariaLabel: "Rate",
    });
    const rateVal = createEl("span", { className: "rnbo-readout rnbo-rate-val", innerText: "1.00×" });
    const rateWrap = createEl("div", { className: "transport-rate" }, [rate, rateVal]);

    const vol = createEl("input", {
      className: "rnbo-slider rnbo-vol-slider",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      value: 0.75,
      ariaLabel: "Volume",
    });
    const volVal = createEl("span", { className: "rnbo-readout rnbo-vol-val", innerText: "0.750" });
    const volLabel = createEl("span", { className: "rnbo-vol-label", innerText: "VOL" });
    const volWrap = createEl("div", { className: "transport-vol" }, [volLabel, vol, volVal]);

    const transport = createEl("div", { className: "header-row-transport" }, [transportLeft, rateWrap, volWrap]);

    // Progress row
    const progressFill = createEl("div", { className: "progress-fill" });
    const progressHandle = createEl("div", { className: "progress-handle" });
    const progressTrack = createEl("div", { className: "progress-track" }, [progressFill, progressHandle]);

    const timeElapsed = createEl("div", { className: "time-elapsed", innerText: "0:00" });
    const timeRemaining = createEl("div", { className: "time-remaining", innerText: "-0:00" });
    const timeRow = createEl("div", { className: "time-row" }, [timeElapsed, timeRemaining]);

    const progressRow = createEl("div", { className: "header-row-progress" }, [progressTrack, timeRow]);

    // Status badge
    const statusText = createEl("div", { className: "status-text", innerText: "Ready" });
    const statusBadge = createEl("div", { className: "rnbo-status" }, [statusText]);

    top.appendChild(titleStack);
    top.appendChild(statusBadge);
    top.appendChild(transport);
    top.appendChild(progressRow);

    scroll.appendChild(list);
    root.replaceChildren(top, scroll);

    installPremiumHeaderEffects(top, scroll);

    return {
      root,
      top,
      scroll,
      list,
      btnPlay,
      btnStop,
      btnLoop,
      rate,
      rateVal,
      vol,
      volVal,
      preloadText: titleStack.querySelector(".rnbo-preload"),
      statusText: statusBadge.querySelector(".status-text"),
      progressTrack,
      progressFill: progressTrack.querySelector(".progress-fill"),
      progressHandle: progressTrack.querySelector(".progress-handle"),
      timeElapsed: timeRow.querySelector(".time-elapsed"),
      timeRemaining: timeRow.querySelector(".time-remaining"),
    };
  }

  // ----------------------------
  // Init
  // ----------------------------
  async function initPlaylistUI(device, context) {
    const ui = buildUI();

    // RNBO params
    const pClipIndex = ensureParam(device, "clipIndex");
    const pRate = ensureParam(device, "rate");
    const pLoop = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");
    const pOutGain = ensureParam(device, "outGain");
    const pJumpTo =
      (device.parametersById?.get("jumpto") || (device.parameters || []).find((p) => p.id === "jumpto")) || null;

    async function primeAudio() {
      try {
        if (context && context.state !== "running") await context.resume();
      } catch (_) {}
    }

    // Optional jumpto support (ms). Some RNBO exports default to 0..1 if min/max aren't set in the patch.
    function supportsJumpTo() {
      return !!pJumpTo && typeof pJumpTo.value === "number";
    }

    function setJumpToMs(targetMs, itemDurationMs) {
      if (!supportsJumpTo()) return false;

      const dur = Math.max(0, Number(itemDurationMs) || 0);
      const ms = Math.max(0, dur > 0 ? Math.min(Number(targetMs) || 0, dur) : Number(targetMs) || 0);

      const declaredMax = Number(pJumpTo.maximum ?? pJumpTo.max ?? pJumpTo.maximumValue ?? pJumpTo.maximum_value);
      const useNormalized = Number.isFinite(declaredMax) && declaredMax <= 1.0001;

      try {
        pJumpTo.value = useNormalized && dur > 0 ? clamp01(ms / dur) : ms;
        return true;
      } catch (e) {
        console.warn("Failed to set jumpto:", e);
        return false;
      }
    }

    // Bind RATE (auto range)
    {
      const rateMin = Number.isFinite(pRate.min) ? pRate.min : -2;
      const rateMax = Number.isFinite(pRate.max) ? pRate.max : 2;
      const rateSteps = Number.isFinite(pRate.steps) ? pRate.steps : 0;

      ui.rate.min = String(rateMin);
      ui.rate.max = String(rateMax);
      ui.rate.step =
        rateSteps && rateSteps > 1 ? String((rateMax - rateMin) / (rateSteps - 1)) : String((rateMax - rateMin) / 1000);

      ui.rate.value = String(pRate.value ?? 1);
      ui.rateVal.innerText = `${Number(ui.rate.value).toFixed(2)}×`;

      ui.rate.addEventListener("input", () => {
        const v = Number(ui.rate.value);
        pRate.value = v;
        ui.rateVal.innerText = `${v.toFixed(2)}×`;
      });
    }

    // Bind VOL (auto range)
    {
      const outMin = Number.isFinite(pOutGain.min) ? pOutGain.min : 0;
      const outMax = Number.isFinite(pOutGain.max) ? pOutGain.max : 1;
      const outSteps = Number.isFinite(pOutGain.steps) ? pOutGain.steps : 0;

      ui.vol.min = String(outMin);
      ui.vol.max = String(outMax);
      ui.vol.step =
        outSteps && outSteps > 1 ? String((outMax - outMin) / (outSteps - 1)) : String((outMax - outMin) / 1000);

      const initialOut = Number.isFinite(pOutGain.value) ? pOutGain.value : (outMin + outMax) * 0.75;

      const volIsInt = outMax - outMin > 2;

      ui.vol.value = String(initialOut);
      try {
        // IMPORTANT: ensure RNBO isn't stuck at 0 (silent) until user touches the slider.
        pOutGain.value = Number(initialOut);
      } catch (_) {}
      ui.volVal.innerText = volIsInt ? String(Math.round(initialOut)) : String(Math.round(initialOut * 1000) / 1000);

      ui.vol.addEventListener("input", () => {
        const v = Number(ui.vol.value);
        pOutGain.value = v;
        ui.volVal.innerText = volIsInt ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
      });
    }

    function setProgress(frac01) {
      const f = clamp01(frac01);
      ui.progressFill.style.width = `${f * 100}%`;
      ui.progressHandle.style.left = `${f * 100}%`;
    }

    function setTime(elapsedMs, totalMs) {
      ui.timeElapsed.innerText = msToTime(elapsedMs);
      const remaining = Math.max(0, totalMs - elapsedMs);
      ui.timeRemaining.innerText = `-${msToTime(remaining)}`;
    }

    // Load manifest + order
    const manifest = await fetchJSON(MANIFEST_URL);
    const filenames = manifest.items || [];

    const saved = loadOrder();
    let ordered = filenames.slice();
    if (Array.isArray(saved) && saved.length) {
      const set = new Set(saved);
      const kept = saved.filter((n) => filenames.includes(n));
      const missing = filenames.filter((n) => !set.has(n));
      ordered = kept.concat(missing);
    }

    // Decode + peaks
    const items = [];
    for (let i = 0; i < ordered.length; i++) {
      const name = ordered[i];
      const ab = await fetchArrayBuffer(MEDIA_BASE + name);
      const audioBuffer = await context.decodeAudioData(ab);
      const peaks = buildPeaks(audioBuffer, WAVE_W);
      const durationMs = (audioBuffer.length / audioBuffer.sampleRate) * 1000;
      items.push({ name, audioBuffer, peaks, durationMs });

      const frac = (i + 1) / Math.max(1, ordered.length);
      ui.preloadText.innerText = `Preload: ${Math.round(frac * 100)}% (${i + 1}/${ordered.length})`;
    }

    ui.preloadText.innerText = `Preload complete: ${ordered.length} files`;
    ui.preloadText.style.setProperty("--fade-ms", `${PRELOAD_FADE_DURATION_MS}ms`);
    setTimeout(() => ui.preloadText.classList.add("is-fading"), PRELOAD_FADE_DELAY_MS);

    // ----------------------------
    // State
    // ----------------------------
    let selectedIdx = 0;
    let isLoop = false;
    let isPlayingUI = false;

    // RNBO port playhead
    let portPlayheadMs = 0;
    let lastPortAt = 0;

    // Offset so we can rebase effective time when needed
    let portOffsetMs = 0;

    // Fallback anchor (if port stalls)
    let anchorCtxTime = 0;
    let anchorRawMs = 0;

    // Displayed playhead
    let displayMs = 0;

    // Prevent resetting repeatedly while idle
    let didAutoResetAfterEOF = false;

    // Reverse EOF grace after pressing play (prevents instant reverse-EOF at t=0)
    let reverseEOFIgnoreUntil = 0;

    function getRateNow() {
      const v = Number(pRate.value);
      return Number.isFinite(v) ? v : 1;
    }

    // ----------------------------
    // RNBO loading (selected clip)
    // ----------------------------
    async function loadSelectedIntoRNBO() {
      // RNBO patch expects clipIndex
      try {
        pClipIndex.value = selectedIdx;
      } catch (_) {}
    }

    function resetUIToStart() {
      displayMs = 0;
      setProgress(0);
      setTime(0, items[selectedIdx]?.durationMs || 0);
      redrawWaveforms();
      didAutoResetAfterEOF = true;
    }

    function getEffectiveRaw() {
      const effective = portPlayheadMs - portOffsetMs;
      return Number.isFinite(effective) ? effective : 0;
    }

    function normalizeForDisplay(rawMs, totalMs) {
      if (!Number.isFinite(rawMs) || !Number.isFinite(totalMs) || totalMs <= 0) {
        return { display: 0, eof: false };
      }

      if (isLoop) {
        const mod = rawMs % totalMs;
        const d = mod < 0 ? mod + totalMs : mod;
        return { display: d, eof: false };
      }

      const rateNow = getRateNow();
      const now = performance.now();

      // Reverse EOF: treat <= 0 as end, but NOT during grace window immediately after Play.
      if (rateNow < 0) {
        if (now >= reverseEOFIgnoreUntil && rawMs <= END_EPS_MS) {
          return { display: 0, eof: true };
        }
      } else {
        if (rawMs >= totalMs - END_EPS_MS) {
          return { display: totalMs, eof: true };
        }
      }

      // Clamp
      if (rawMs < 0) rawMs = 0;
      if (rawMs > totalMs) rawMs = totalMs;

      return { display: rawMs, eof: false };
    }

    function paintFromRaw(rawMs) {
      const it = items[selectedIdx];
      if (!it) return;

      const norm = normalizeForDisplay(rawMs, it.durationMs);
      displayMs = norm.display;

      if (norm.eof && !isLoop) {
        if (isPlayingUI) {
          isPlayingUI = false;
          ui.btnPlay.classList.remove("is-on");
          ui.statusText.innerText = "Ready";
        }

        pulseParam(pStopTrig);
        resetUIToStart();
        return;
      }

      const frac = it.durationMs > 0 ? clamp01(displayMs / it.durationMs) : 0;
      setProgress(frac);
      setTime(displayMs, it.durationMs);
      redrawWaveforms();
    }

    // ----------------------------
    // Progress-bar seek (requires jumpto).
    // - If playing: seek and keep playing.
    // - If stopped: seek updates the UI position but does NOT start playback.
    // ----------------------------
    if (ui.progressTrack) {
      let seeking = false;

      function seekToFrac(frac01, startIfPlaying) {
        const it = items[selectedIdx];
        if (!it || !supportsJumpTo()) return;
        const targetMs = clamp01(frac01) * it.durationMs;

        setJumpToMs(targetMs, it.durationMs);

        // Rebase effective time so UI updates instantly, even before port catches up.
        portOffsetMs = portPlayheadMs - targetMs;
        anchorCtxTime = context.currentTime;
        anchorRawMs = targetMs;
        didAutoResetAfterEOF = false;

        paintFromRaw(targetMs);

        if (startIfPlaying) {
          isPlayingUI = true;
          ui.btnPlay.classList.add("is-on");
          ui.statusText.innerText = "Playing";
        }
      }

      ui.progressTrack.addEventListener("pointerdown", (ev) => {
        if (!supportsJumpTo()) return;
        seeking = true;
        ui.progressTrack.setPointerCapture?.(ev.pointerId);
        const rect = ui.progressTrack.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const frac = rect.width > 0 ? x / rect.width : 0;
        seekToFrac(frac, isPlayingUI);
      });

      ui.progressTrack.addEventListener("pointermove", (ev) => {
        if (!seeking) return;
        const rect = ui.progressTrack.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const frac = rect.width > 0 ? x / rect.width : 0;
        seekToFrac(frac, isPlayingUI);
      });

      function endSeek() {
        seeking = false;
      }

      ui.progressTrack.addEventListener("pointerup", endSeek);
      ui.progressTrack.addEventListener("pointercancel", endSeek);
      ui.progressTrack.addEventListener("lostpointercapture", endSeek);
    }

    // ----------------------------
    // Render list
    // ----------------------------
    const rowEls = [];

    function applyRowActiveClasses() {
      rowEls.forEach((row, idx) => {
        row.classList.toggle("selected", idx === selectedIdx);
        row.classList.toggle("is-active", idx === selectedIdx);
      });
    }

    function redrawWaveforms() {
      const it = items[selectedIdx];
      const total = it?.durationMs || 0;
      const frac = total > 0 ? clamp01(displayMs / total) : 0;

      rowEls.forEach((row, idx) => {
        const canvas = row.querySelector("canvas");
        if (!canvas) return;
        const item = items[idx];
        if (!item) return;

        if (idx === selectedIdx) drawWaveform(canvas, item.peaks, frac);
        else drawWaveform(canvas, item.peaks, null);
      });
    }

    function renderList() {
      ui.list.innerHTML = "";
      rowEls.length = 0;

      items.forEach((it, idx) => {
        const indexBadge = createEl("div", { className: "rnbo-index", innerText: pad2(idx + 1) });

        const handle = createEl(
          "button",
          { className: "rnbo-handle", type: "button", ariaLabel: "Reorder", title: "Drag to reorder" },
          [createEl("span", { innerText: "≡≡" })]
        );

        const leftStack = createEl("div", { className: "rnbo-left-stack" }, [indexBadge, handle]);

        const title = createEl("div", { className: "rnbo-item-title", innerText: it.name });
        const meta = createEl("div", { className: "rnbo-item-meta", innerText: msToTime(it.durationMs) });
        const info = createEl("div", { className: "rnbo-item-info" }, [title, meta]);

        const header = createEl("div", { className: "rnbo-item-header" }, [leftStack, info]);

        const canvas = createEl("canvas", { className: "rnbo-canvas" });
        canvas.width = WAVE_W;
        canvas.height = WAVE_H;

        const waveformWrap = createEl("div", { className: "rnbo-waveform" }, [canvas]);

        const row = createEl(
          "div",
          {
            className: "rnbo-row" + (idx === selectedIdx ? " selected is-active" : ""),
            draggable: true,
            dataset: { idx: String(idx) },
          },
          [header, waveformWrap]
        );

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null);
        row.addEventListener("click", () => setSelected(idx));

        // Drag reorder (arm drag only from handle)
        let dragArmed = false;

        handle.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          dragArmed = true;
        });

        row.addEventListener("dragstart", (ev) => {
          if (!dragArmed) {
            ev.preventDefault();
            return;
          }
          row.classList.add("dragging", "is-dragging");
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", String(idx));
        });

        row.addEventListener("dragend", () => {
          dragArmed = false;
          row.classList.remove("dragging", "is-dragging");
        });

        row.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
        });

        row.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const from = Number(ev.dataTransfer.getData("text/plain"));
          const to = idx;
          if (!Number.isFinite(from) || from === to) return;

          const moved = items.splice(from, 1)[0];
          items.splice(to, 0, moved);

          // keep selection pointing to same item
          const currentName = items[selectedIdx]?.name;
          const newSel = items.findIndex((x) => x.name === currentName);
          selectedIdx = newSel >= 0 ? newSel : 0;

          saveOrder(items.map((x) => x.name));

          renderList();
          applyRowActiveClasses();
          loadSelectedIntoRNBO().catch(console.error);
          resetUIToStart();
        });

        ui.list.appendChild(row);
        rowEls.push(row);
      });

      applyRowActiveClasses();
    }

    async function setSelected(idx) {
      selectedIdx = Math.max(0, Math.min(items.length - 1, idx));

      // stop + rearm UI state
      isPlayingUI = false;
      ui.btnPlay.classList.remove("is-on");
      ui.statusText.innerText = "Ready";

      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;

      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;

      didAutoResetAfterEOF = false;
      reverseEOFIgnoreUntil = 0;

      await loadSelectedIntoRNBO();
      resetUIToStart();
      applyRowActiveClasses();
    }

    // ----------------------------
    // Transport
    // ----------------------------
    async function playFromBeginning() {
      await primeAudio();

      // Always re-arm: stop first, reset our timebase, then play.
      pulseParam(pStopTrig);

      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;

      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;

      didAutoResetAfterEOF = false;

      // Reverse grace window: don't instantly treat raw=0 as EOF
      reverseEOFIgnoreUntil = getRateNow() < 0 ? performance.now() + REVERSE_EOF_GRACE_MS : 0;

      resetUIToStart();

      // If jumpto exists, explicitly set the starting playhead position so Play is deterministic.
      // This is especially important for reverse playback (rate < 0).
      const it = items[selectedIdx];
      if (it && supportsJumpTo() && it.durationMs > 0) {
        const rateNow2 = getRateNow();
        const startMs = rateNow2 < 0 ? Math.max(0, it.durationMs - 1) : 0;
        setJumpToMs(startMs, it.durationMs);

        portOffsetMs = portPlayheadMs - startMs;
        anchorCtxTime = context.currentTime;
        anchorRawMs = startMs;
      }

      isPlayingUI = true;
      ui.btnPlay.classList.add("is-on");
      ui.statusText.innerText = "Playing";

      // Reverse-start assist (legacy): if no jumpto and rate < 0 while loop is OFF, briefly enable loop for start.
      const rateNow = getRateNow();
      if (rateNow < 0 && !isLoop && !supportsJumpTo()) {
        try {
          pLoop.value = 1; // do NOT change UI button state
          pulseParam(pPlayTrig);

          setTimeout(() => {
            try {
              pLoop.value = 0;
            } catch (_) {}
          }, REVERSE_LOOP_ASSIST_MS);

          return;
        } catch (err) {
          console.warn("Reverse loop-assist failed; falling back to normal play.", err);
        }
      }

      pulseParam(pPlayTrig);
    }

    function stopNow() {
      pulseParam(pStopTrig);

      isPlayingUI = false;
      ui.btnPlay.classList.remove("is-on");
      ui.statusText.innerText = "Ready";

      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;

      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;

      didAutoResetAfterEOF = false;
      reverseEOFIgnoreUntil = 0;

      // If available, force jumpto back to 0 so the next Play is always from the beginning.
      const it = items[selectedIdx];
      if (it && supportsJumpTo() && it.durationMs > 0) {
        setJumpToMs(0, it.durationMs);
        portOffsetMs = portPlayheadMs - 0;
        anchorCtxTime = context.currentTime;
        anchorRawMs = 0;
      }

      resetUIToStart();
    }

    ui.btnPlay.addEventListener("click", () => {
      playFromBeginning().catch(console.error);
    });

    ui.btnStop.addEventListener("click", () => {
      stopNow();
    });

    ui.btnLoop.addEventListener("click", () => {
      const wasLoop = isLoop;
      isLoop = !isLoop;

      try {
        pLoop.value = isLoop ? 1 : 0;
      } catch (_) {}
      ui.btnLoop.classList.toggle("is-on", isLoop);

      // If turning LOOP OFF mid-play, rebase effective time to prevent jump-to-EOF.
      if (wasLoop && !isLoop) {
        const nowPortRaw = portPlayheadMs;
        const desiredEffective = displayMs;
        portOffsetMs = nowPortRaw - desiredEffective;

        anchorCtxTime = context.currentTime;
        anchorRawMs = desiredEffective;

        paintFromRaw(desiredEffective);
        return;
      }

      paintFromRaw(getEffectiveRaw());
    });

    // Keyboard shortcuts
    window.addEventListener("keydown", (ev) => {
      if (isTextInputTarget(ev.target)) return;

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setSelected(selectedIdx + 1).catch(console.error);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setSelected(selectedIdx - 1).catch(console.error);
      } else if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        playFromBeginning().catch(console.error);
      } else if (ev.key.toLowerCase() === "s" || ev.key === "Escape") {
        ev.preventDefault();
        stopNow();
      } else if (ev.key.toLowerCase() === "l") {
        ev.preventDefault();
        ui.btnLoop.click();
      }
    });

    // ----------------------------
    // RNBO playhead outport + fallback
    // ----------------------------
    if (device.messageEvent?.subscribe) {
      device.messageEvent.subscribe((ev) => {
        if (ev.tag !== "playhead") return;
        const payload = ev.payload || [];
        const v = Number(payload[0]);
        if (!Number.isFinite(v)) return;

        portPlayheadMs = v;
        lastPortAt = performance.now();

        // Sync fallback anchor to effective time
        anchorCtxTime = context.currentTime;
        anchorRawMs = getEffectiveRaw();
      });
    }

    // UI tick loop
    let lastPaintAt = 0;

    function tick() {
      const now = performance.now();

      if (isPlayingUI) {
        const portFresh = now - lastPortAt < PORT_FRESH_MS;

        if (!portFresh) {
          const elapsedSec = Math.max(0, context.currentTime - anchorCtxTime);
          const rateNow = getRateNow() || 1;
          const estRaw = anchorRawMs + elapsedSec * 1000 * rateNow;
          paintFromRaw(estRaw);
        } else {
          paintFromRaw(getEffectiveRaw());
        }
      } else {
        if (!didAutoResetAfterEOF) paintFromRaw(0);
      }

      if (now - lastPaintAt >= UI_THROTTLE_MS) lastPaintAt = now;
      requestAnimationFrame(tick);
    }

    // Init render
    renderList();
    await setSelected(0);
    requestAnimationFrame(tick);
  }

  window.initPlaylistUI = initPlaylistUI;
})();