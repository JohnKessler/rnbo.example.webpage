// playlist-ui.js
// RNBO Playlist UI (Web Export) — Reframe-integrated baseline
//
// Version: v1.11 (2026-01-11)
//
// Notes:
// - This file preserves the Penpot/CSS-driven DOM structure and classnames.
// - Updates focus ONLY on jumpto correctness + reverse-start reliability.
// - jumpto is treated as milliseconds when its declared max > ~1.
// - With your patch jumpto range: 0..600000 ms.
// - Reverse start: when rate < 0, we always jump near the end using jumpto (even if loop is ON),
//   because some RNBO patches won’t start reverse cleanly from 0.
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Optional RNBO parameter (by id):
//   jumpto  (ms; patch range 0..600000)
// Expected RNBO external buffer name:
//   "sample"
// Optional RNBO outport message tag:
//   "playhead" with ms as payload[0]

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";
  const MANIFEST_URL = MEDIA_BASE + "playlist.json";
  const ORDER_KEY = "rnbo_playlist_order_v4";

  const WAVE_W = 520;
  const WAVE_H = 80;

  const DEFAULT_OUTGAIN = 120;

  // UI throttles
  const UI_THROTTLE_MS = 16;
  const END_EPS_MS = 15;

  // When playhead port is stale, estimate from AudioContext time
  const PORT_FRESH_MS = 120;

  // Reverse-start assist fallback:
  // briefly enable loop when rate < 0 so RNBO can wrap to end and run backwards.
  const REVERSE_LOOP_ASSIST_MS = 90;

  // Grace window after Play where we do NOT treat "rawMs <= 0" as reverse EOF
  // (prevents instant stop at t=0 before RNBO has time to wrap/advance).
  const REVERSE_EOF_GRACE_MS = 250;

  // jumpto ms range (from patch)
  const JUMPTO_MAX_MS = 600000;

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

  // ----------------------------
  // Waveform (peaks)
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

  function drawWaveform(canvas, peaks, playheadMsOrNull, durationMsOrNull) {
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

    // playhead
    if (playheadMsOrNull != null && durationMsOrNull && durationMsOrNull > 0) {
      const frac = clamp01(playheadMsOrNull / durationMsOrNull);
      const x = frac * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  // ----------------------------
  // UI build (PRESERVED STRUCTURE)
  // ----------------------------
  function buildUI() {
    const root = document.getElementById("playlist-ui");
    if (!root) throw new Error('Missing #playlist-ui container in playlist.html');

    root.innerHTML = "";

    const top = createEl("div", { className: "rnbo-top" });

    const headerRowTitle = createEl("div", { className: "header-row-title" });

    const titleStack = createEl("div", { className: "title-stack" }, [
      createEl("h1", { className: "rnbo-title", innerText: "RNBO Playlist" }),
      createEl("div", { className: "rnbo-meta", innerText: "Web export playlist" }),
      createEl("div", { className: "rnbo-preload", innerText: "Preload: 0%" }),
    ]);

    const statusText = createEl("div", { className: "status-text", innerText: "Ready" });

    headerRowTitle.append(titleStack, statusText);

    const headerRowTransport = createEl("div", { className: "header-row-transport" });

    const transportLeft = createEl("div", { className: "transport-left" });

    const btnPlay = createEl("button", {
      className: "transport-btn play-btn",
      type: "button",
      innerText: "▶",
      ariaLabel: "Play",
    });

    const btnStop = createEl("button", {
      className: "transport-btn stop-btn",
      type: "button",
      innerText: "■",
      ariaLabel: "Stop",
    });

    const btnLoop = createEl("button", {
      className: "transport-btn loop-btn",
      type: "button",
      innerText: "Loop",
      ariaLabel: "Loop",
    });

    const rateGroup = createEl("div", { className: "rate-group" });

    const rateLabel = createEl("span", { className: "rnbo-meta rate-label", innerText: "Rate" });

    const rate = createEl("input", {
      className: "rate-slider",
      type: "range",
      min: -1,
      max: 2,
      step: 0.01,
      value: 1,
      ariaLabel: "Rate",
    });

    const rateVal = createEl("span", { className: "rnbo-readout rate-readout", innerText: "1.00x" });

    rateGroup.append(rateLabel, rate, rateVal);

    transportLeft.append(btnPlay, btnStop, btnLoop, rateGroup);

    const vol = createEl("input", {
      className: "volume-slider",
      type: "range",
      min: 0,
      max: 158,
      step: 1,
      value: 120,
      ariaLabel: "Volume",
    });
    const volVal = createEl("span", { className: "rnbo-readout rnbo-volreadout", innerText: "120" });
    const volumeGroup = createEl("div", { className: "volume-group" }, [
      createEl("span", { className: "rnbo-meta rnbo-voltag", innerText: "VOL" }),
      vol,
      volVal,
    ]);

    headerRowTransport.append(
      transportLeft,
      createEl("div", { className: "transport-spacer" }),
      volumeGroup
    );

    const headerRowProgress = createEl("div", { className: "header-row-progress" });

    const progressTrack = createEl("div", { className: "progress-track" });
    const progressFill = createEl("div", { className: "progress-fill" });
    progressTrack.appendChild(progressFill);

    const timeRow = createEl("div", { className: "time-row" });
    const timeNow = createEl("span", { className: "time-now", innerText: "0:00" });
    const timeDur = createEl("span", { className: "time-dur", innerText: "0:00" });
    timeRow.append(timeNow, timeDur);

    headerRowProgress.append(progressTrack, timeRow);

    top.append(headerRowTitle, headerRowTransport, headerRowProgress);

    const scroll = createEl("div", { className: "rnbo-scroll" });
    const list = createEl("div", { className: "rnbo-list" });

    scroll.appendChild(list);

    root.append(top, scroll);

    return {
      root,
      top,
      scroll,
      list,

      // header
      preloadText: titleStack.querySelector(".rnbo-preload"),
      statusText,

      // transport
      btnPlay,
      btnStop,
      btnLoop,
      rate,
      rateVal,
      vol,
      volVal,

      // progress
      progressTrack,
      progressFill,
      timeNow,
      timeDur,
    };
  }

  // ----------------------------
  // Main init
  // ----------------------------
  async function initPlaylistUI(device, context) {
    const ui = buildUI();

    // RNBO params
    const pClipIndex = ensureParam(device, "clipIndex");
    const pRate = ensureParam(device, "rate");
    const pJumpTo =
      device.parametersById?.get("jumpto") ||
      (device.parameters || []).find((pp) => pp.id === "jumpto") ||
      null;
    const pOutGain = ensureParam(device, "outGain");
    const pLoop = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");

    // Prime audio (browser policies)
    async function primeAudio() {
      // Also poke app.js's resume hook if present
      try {
        window.dispatchEvent(new Event("rnbo:gesture"));
      } catch (_) {}
      try {
        if (context && context.state !== "running") await context.resume();
      } catch (_) {}
    }

    // Manifest + ordering
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
      items.push({
        name,
        audioBuffer,
        peaks,
        durationMs,
        canvas: null,
        rowEl: null,
        handleEl: null,
      });

      const frac = (i + 1) / Math.max(1, ordered.length);
      if (ui.preloadText) ui.preloadText.innerText = `Preload: ${Math.round(frac * 100)}%`;
    }

    if (ui.preloadText) ui.preloadText.innerText = "Preload complete";

    // State
    let selectedIdx = 0;
    let isLoop = false;

    let isPlayingUI = false;

    // RNBO playhead raw (monotonic within track)
    let portPlayheadMs = 0;
    let lastPortAt = 0;

    // We rebase port time so our display can always be clamped into [0..dur]
    let portOffsetMs = 0;

    // Estimation anchor when port is stale
    let anchorCtxTime = context.currentTime;
    let anchorRawMs = 0;

    // Display ms (clamped)
    let displayMs = 0;

    // Prevent resetting repeatedly while idle
    let didAutoResetAfterEOF = false;

    // Reverse EOF grace after pressing play (prevents instant reverse-EOF at t=0)
    let reverseEOFIgnoreUntil = 0;

    function getRateNow() {
      const r = Number(pRate.value);
      return Number.isFinite(r) ? r : 1;
    }

    function msToTime(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${String(r).padStart(2, "0")}`;
    }

    function setProgress(frac) {
      const f = Math.max(0, Math.min(1, frac));
      ui.progressFill.style.transform = `scaleX(${f})`;
    }

    function setTime(ms, dur) {
      ui.timeNow.innerText = msToTime(ms);
      ui.timeDur.innerText = msToTime(dur);
    }

    function redrawWaveforms() {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.canvas) continue;
        const isSel = i === selectedIdx;
        drawWaveform(it.canvas, it.peaks, isSel ? displayMs : null, it.durationMs);
      }
    }

    function resetUIToStart() {
      const it = items[selectedIdx];
      const dur = it?.durationMs || 0;
      displayMs = 0;
      setProgress(0);
      setTime(0, dur);
      redrawWaveforms();
    }

    function paintFromRaw(effectiveMs) {
      const it = items[selectedIdx];
      const dur = it?.durationMs || 0;
      const ms = Math.max(0, Math.min(dur > 0 ? dur : effectiveMs, effectiveMs));

      displayMs = ms;

      const frac = dur > 0 ? ms / dur : 0;
      setProgress(frac);
      setTime(ms, dur);
      redrawWaveforms();
    }

    function getEffectiveRaw() {
      const now = performance.now();
      const age = now - lastPortAt;

      if (age <= PORT_FRESH_MS) {
        return portPlayheadMs + portOffsetMs;
      }

      // Estimate using AudioContext time + rate
      const dt = (context.currentTime - anchorCtxTime) * 1000;
      const rate = getRateNow();
      return anchorRawMs + dt * rate + portOffsetMs;
    }

    // --------- UPDATED jumpto handling (surgical, no DOM changes) ----------
    function setJumpToMs(targetMs, { startIfNeeded = true } = {}) {
      if (!pJumpTo) return false;

      const it = items[selectedIdx];
      const dur = Number(it?.durationMs || 0);

      let ms = Number(targetMs);
      if (!Number.isFinite(ms)) ms = 0;

      // Clamp to patch-declared ms range (your patch: 0..600000), if available.
      // RNBO param objects sometimes expose range as max/min OR maximum/minimum depending on build.
      const declaredMax = Number(pJumpTo.max ?? pJumpTo.maximum);
      const declaredMin = Number(pJumpTo.min ?? pJumpTo.minimum);

      // If declared max is ~1, treat jumpto as normalized 0..1; otherwise treat as milliseconds.
      const useNormalized = Number.isFinite(declaredMax) && declaredMax <= 1.0001;

      if (useNormalized) {
        // We'll convert to 0..1 later using duration
        ms = Math.max(0, ms);
      } else {
        const lo = Number.isFinite(declaredMin) ? declaredMin : 0;
        const hi = Number.isFinite(declaredMax) ? declaredMax : JUMPTO_MAX_MS;
        ms = Math.max(lo, Math.min(hi, ms));
      }

      // Also clamp to current item duration, and avoid setting exactly "dur" (use dur-1)
      if (Number.isFinite(dur) && dur > 1) {
        ms = Math.max(0, Math.min(ms, Math.floor(dur - 1)));
      } else {
        ms = Math.max(0, ms);
      }

      try {
        pJumpTo.value = useNormalized && dur > 0 ? clamp01(ms / dur) : ms;
      } catch (_) {}

      if (!startIfNeeded && !isPlayingUI) return true;

      didAutoResetAfterEOF = false;
      reverseEOFIgnoreUntil = 0;
      displayMs = ms;
      paintFromRaw(ms);
      return true;
    }

    const rowEls = [];

    function applyRowActiveClass() {
      for (let i = 0; i < rowEls.length; i++) {
        rowEls[i].classList.toggle("selected", i === selectedIdx);
      }
    }

    // ----------------------------
    // Build list
    // ----------------------------
    function renderList() {
      ui.list.innerHTML = "";
      rowEls.length = 0;

      items.forEach((it, idx) => {
        const handle = createEl("div", { className: "rnbo-handle", innerText: "☰" });
        const indexEl = createEl("div", { className: "rnbo-index", innerText: String(idx + 1) });

        const leftStack = createEl("div", { className: "rnbo-left-stack" }, [handle, indexEl]);

        const info = createEl("div", { className: "rnbo-item-info" }, [
          createEl("div", { className: "rnbo-item-title", innerText: it.name }),
          createEl("div", {
            className: "rnbo-item-meta",
            innerText: `${Math.round(it.durationMs)}ms • ${Math.round(it.audioBuffer.sampleRate)} Hz`,
          }),
        ]);

        const header = createEl("div", { className: "rnbo-row-header" }, [leftStack, info]);

        const canvas = createEl("canvas", {
          className: "rnbo-canvas",
          width: WAVE_W,
          height: WAVE_H,
        });

        it.canvas = canvas;
        it.handleEl = handle;

        const row = createEl(
          "div",
          { className: "rnbo-row", dataset: { index: String(idx) } },
          [header, canvas]
        );

        row.addEventListener("click", () => {
          if (idx === selectedIdx) return;
          selectByIndex(idx).catch(console.error);
        });

        ui.list.appendChild(row);
        rowEls.push(row);

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null, it.durationMs);
      });

      applyRowActiveClass();
      attachDragHandlers();
    }

    // ----------------------------
    // Drag reorder
    // ----------------------------
    const dragState = { active: false, draggingIndex: -1 };

    function moveItem(fromIdx, toIdx) {
      if (fromIdx === toIdx) return;
      const [moved] = items.splice(fromIdx, 1);
      items.splice(toIdx, 0, moved);

      // Update selection index
      if (selectedIdx === fromIdx) selectedIdx = toIdx;
      else if (fromIdx < selectedIdx && toIdx >= selectedIdx) selectedIdx -= 1;
      else if (fromIdx > selectedIdx && toIdx <= selectedIdx) selectedIdx += 1;

      saveOrder(items.map((x) => x.name));
      renderList();
    }

    function attachDragHandlers() {
      items.forEach((it, idx) => {
        const handle = it.handleEl;
        if (!handle) return;
        if (handle._rnboDragAttached) return;
        handle._rnboDragAttached = true;

        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handle.setPointerCapture?.(e.pointerId);

          dragState.active = true;
          dragState.draggingIndex = idx;
          rowEls[idx]?.classList.add("dragging");
        });

        handle.addEventListener("pointermove", (e) => {
          if (!dragState.active) return;

          const overRow = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".rnbo-row");
          if (!overRow) return;

          const overIdx = Number(overRow.dataset.index);
          const fromIdx = dragState.draggingIndex;

          if (!Number.isFinite(overIdx) || overIdx < 0) return;
          if (fromIdx < 0 || fromIdx >= items.length) return;
          if (overIdx === fromIdx) return;

          moveItem(fromIdx, overIdx);
          dragState.draggingIndex = overIdx;
        });

        function endDrag() {
          if (!dragState.active) return;
          dragState.active = false;
          rowEls.forEach((r) => r.classList.remove("dragging"));
          dragState.draggingIndex = -1;
        }

        handle.addEventListener("pointerup", endDrag);
        handle.addEventListener("pointercancel", endDrag);
        handle.addEventListener("lostpointercapture", endDrag);
      });
    }

    // ----------------------------
    // RNBO buffer load
    // ----------------------------
    async function loadSelectedIntoRNBO() {
      const it = items[selectedIdx];
      if (!it) return;

      await device.setDataBuffer("sample", it.audioBuffer);

      try {
        pClipIndex.value = selectedIdx;
      } catch (_) {}

      // Reset playhead state
      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;

      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;

      didAutoResetAfterEOF = false;
      reverseEOFIgnoreUntil = 0;

      resetUIToStart();
    }

    async function selectByIndex(idx) {
      idx = Math.max(0, Math.min(items.length - 1, idx));
      if (idx === selectedIdx) return;

      // Stop if playing
      if (isPlayingUI) {
        pulseParam(pStopTrig);
        isPlayingUI = false;
        ui.btnPlay.classList.remove("is-on");
        ui.statusText.innerText = "Ready";
      }

      selectedIdx = idx;

      renderList();
      await loadSelectedIntoRNBO();
    }

    renderList();
    await loadSelectedIntoRNBO();

    // ----------------------------
    // Seek via header progress click/drag
    // ----------------------------
    function seekFromEvent(ev) {
      const it = items[selectedIdx];
      if (!it) return;
      const dur = it.durationMs || 0;
      if (dur <= 0) return;

      const r = ui.progressTrack.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const frac = Math.max(0, Math.min(1, x / Math.max(1, r.width)));
      const ms = frac * dur;

      if (pJumpTo) {
        const ok = setJumpToMs(ms, { startIfNeeded: true });
        if (ok) {
          // Keep UI consistent immediately
          displayMs = ms;
          paintFromRaw(ms);
        }
      }
    }

    let isSeeking = false;

    ui.progressTrack.addEventListener("pointerdown", (ev) => {
      isSeeking = true;
      ui.progressTrack.setPointerCapture?.(ev.pointerId);
      seekFromEvent(ev);
    });

    ui.progressTrack.addEventListener("pointermove", (ev) => {
      if (!isSeeking) return;
      seekFromEvent(ev);
    });

    ui.progressTrack.addEventListener("pointerup", () => {
      isSeeking = false;
    });

    ui.progressTrack.addEventListener("pointercancel", () => {
      isSeeking = false;
    });

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
      reverseEOFIgnoreUntil =
        getRateNow() < 0 ? performance.now() + REVERSE_EOF_GRACE_MS : 0;

      resetUIToStart();

      isPlayingUI = true;
      ui.btnPlay.classList.add("is-on");
      ui.statusText.innerText = "Playing";

      const rateNow = getRateNow();

      // ✅ FIX: Reverse-start assist should trigger whenever rate < 0 (even if loop is ON).
      // Starting from ~end avoids the "can't start unless loop is enabled" behavior.
      if (rateNow < 0) {
        const it = items[selectedIdx];
        const dur = it?.durationMs || 0;

        // Prefer jumpto if available
        if (pJumpTo && dur > 0) {
          setJumpToMs(Math.max(0, dur - 1), { startIfNeeded: false });
          pulseParam(pPlayTrig);
          return;
        }

        // Fallback only when loop is OFF
        if (!isLoop) {
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
            console.warn("Reverse start assist failed; falling back to normal play.", err);
          }
        }
      }

      pulseParam(pPlayTrig);
    }

    function stopNow() {
      pulseParam(pStopTrig);

      isPlayingUI = false;
      ui.btnPlay.classList.remove("is-on");
      ui.statusText.innerText = "Ready";

      // Hard reset UI timebase
      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;
      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;

      didAutoResetAfterEOF = false;
      reverseEOFIgnoreUntil = 0;

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

      // If loop gets turned off while playing reverse, don't accidentally trigger EOF instantly.
      if (wasLoop && !isLoop && getRateNow() < 0) {
        reverseEOFIgnoreUntil = performance.now() + REVERSE_EOF_GRACE_MS;
      }
    });

    ui.rate.addEventListener("input", () => {
      const v = parseFloat(ui.rate.value);
      try {
        pRate.value = v;
      } catch (_) {}
      ui.rateVal.innerText = `${v.toFixed(2)}x`;
    });

    ui.vol.addEventListener("input", () => {
      const v = Math.round(parseFloat(ui.vol.value));
      try {
        pOutGain.value = v;
      } catch (_) {}
      ui.volVal.innerText = String(v);
    });

    // Initial values
    try {
      pOutGain.value = DEFAULT_OUTGAIN;
    } catch (_) {}
    ui.vol.value = String(DEFAULT_OUTGAIN);
    ui.volVal.innerText = String(DEFAULT_OUTGAIN);

    ui.rate.value = String(pRate.value ?? 1);
    ui.rateVal.innerText = `${Number(pRate.value ?? 1).toFixed(2)}x`;

    // ----------------------------
    // Playhead subscribe
    // ----------------------------
    device.messageEvent.subscribe((ev) => {
      if (!ev || ev.tag !== "playhead") return;

      const v = Array.isArray(ev.payload) ? ev.payload[0] : ev.payload;
      if (!Number.isFinite(v)) return;

      const now = performance.now();
      portPlayheadMs = v;
      lastPortAt = now;

      // Update estimation anchors when port is fresh
      anchorCtxTime = context.currentTime;
      anchorRawMs = v - portOffsetMs;
    });

    // ----------------------------
    // Animation/update loop
    // ----------------------------
    let lastPaintAt = 0;

    function tick() {
      requestAnimationFrame(tick);

      const now = performance.now();
      if (now - lastPaintAt < UI_THROTTLE_MS) return;
      lastPaintAt = now;

      const it = items[selectedIdx];
      const dur = it?.durationMs || 0;
      const effective = getEffectiveRaw();
      const rate = getRateNow();

      if (isPlayingUI) {
        if (!isLoop) {
          if (rate >= 0) {
            // forward EOF: stop at end
            if (effective >= dur - END_EPS_MS) {
              isPlayingUI = false;
              ui.btnPlay.classList.remove("is-on");
              ui.statusText.innerText = "Ready";
              didAutoResetAfterEOF = true;

              // hard reset UI to 0
              portPlayheadMs = 0;
              lastPortAt = 0;
              portOffsetMs = 0;
              anchorCtxTime = context.currentTime;
              anchorRawMs = 0;

              resetUIToStart();
              return;
            }
          } else {
            // reverse EOF: stop at 0
            const ignore =
              reverseEOFIgnoreUntil && performance.now() < reverseEOFIgnoreUntil;
            if (!ignore && effective <= 0 + END_EPS_MS) {
              isPlayingUI = false;
              ui.btnPlay.classList.remove("is-on");
              ui.statusText.innerText = "Ready";
              didAutoResetAfterEOF = true;

              portPlayheadMs = 0;
              lastPortAt = 0;
              portOffsetMs = 0;
              anchorCtxTime = context.currentTime;
              anchorRawMs = 0;

              resetUIToStart();
              return;
            }
          }
        }
      } else {
        if (didAutoResetAfterEOF) {
          // already reset; do nothing
        }
      }

      // Paint
      paintFromRaw(effective);
    }

    tick();

    // ----------------------------
    // Keyboard shortcuts
    // ----------------------------
    window.addEventListener("keydown", (ev) => {
      if (isTextInputTarget(ev.target)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      const key = ev.key.toLowerCase();

      if (key === " " || ev.code === "Space" || key === "enter") {
        ev.preventDefault();
        if (!isPlayingUI) playFromBeginning().catch(console.error);
        else stopNow();
      } else if (key === "escape" || key === "esc") {
        ev.preventDefault();
        stopNow();
      } else if (key === "l") {
        ev.preventDefault();
        ui.btnLoop.click();
      } else if (key === "arrowdown") {
        ev.preventDefault();
        selectByIndex(selectedIdx + 1).catch(console.error);
      } else if (key === "arrowup") {
        ev.preventDefault();
        selectByIndex(selectedIdx - 1).catch(console.error);
      }
    });
  }

  window.initPlaylistUI = initPlaylistUI;
})();