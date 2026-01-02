// playlist-ui.js
// RNBO Playlist UI (Web Export) — Reframe-integrated baseline
//
// Updates in this version:
// - INJECT_DEFAULT_STYLES = false (site/theme CSS controls look)
// - Play/Stop are round icon buttons (Reframe .icon-button style hook)
// - Keeps all known-good functionality: preload, waveform thumbnails, playhead drawing, EOF stop logic,
//   drag reorder + persistence, keyboard shortcuts, touch-friendly interactions, volume via outGain.
// - NEW: "Prime audio" on first Play so AudioContext resumes + RNBO node is connected (fixes silent playback
//        when using a minimal playlist.html instead of the export's default index.html).
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Expected RNBO external buffer name:
//   "sample"
// Expected port message tag (outport) for playhead:
//   "playhead" with ms as payload[0]

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";
  const MANIFEST_URL = MEDIA_BASE + "playlist.json"; // { "items": ["a.wav","b.wav"] }

  const WAVE_W = 520;
  const WAVE_H = 80;

  const PLAYHEAD_THROTTLE_MS = 16; // ~60fps
  const DEFAULT_OUTGAIN = 112;

  // Drag reorder persistence
  const ORDER_KEY = "rnbo_playlist_order_v2";

  // Use manifest by default
  const USE_HARDCODED_LIST = false;
  const HARD_CODED_ITEMS = [];

  // Let the website/theme CSS control appearance
  const INJECT_DEFAULT_STYLES = false;

  // ----------------------------
  // Helpers
  // ----------------------------
  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function ensureParam(device, id) {
    const p = device.parametersById?.get(id) || device.parameters.find(pp => pp.id === id);
    if (!p) throw new Error(`Missing RNBO parameter id="${id}"`);
    return p;
  }

  function pulseParam(param, ms = 20) {
    param.value = 1;
    setTimeout(() => { param.value = 0; }, ms);
  }

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url} (${r.status})`);
    return r.json();
  }

  async function fetchArrayBuffer(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url} (${r.status})`);
    return r.arrayBuffer();
  }

  function saveOrder(names) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(names)); } catch (_) {}
  }

  function loadOrder() {
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (_) {
      return null;
    }
  }

  function applySavedOrder(original, saved) {
    const oSet = new Set(original);
    const sSet = new Set(saved);
    if (oSet.size !== sSet.size) return original;
    for (const f of oSet) if (!sSet.has(f)) return original;
    return saved.slice();
  }

  function isTextInputTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || t.isContentEditable;
  }

  // Safe element creator (dataset handling)
  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);

    if (props.dataset && typeof props.dataset === "object") {
      for (const [k, v] of Object.entries(props.dataset)) {
        el.dataset[k] = String(v);
      }
      delete props.dataset;
    }

    if (props.style && typeof props.style === "object") {
      Object.assign(el.style, props.style);
      delete props.style;
    }

    Object.assign(el, props);
    for (const c of children) el.appendChild(c);
    return el;
  }

  // ----------------------------
  // Waveform
  // ----------------------------
  function buildPeaks(audioBuffer, width) {
    const ch0 = audioBuffer.getChannelData(0); // mono sources
    const len = ch0.length;
    const spp = Math.max(1, Math.floor(len / width));
    const peaks = new Float32Array(width * 2);

    for (let x = 0; x < width; x++) {
      let min = 1.0, max = -1.0;
      const start = x * spp;
      const end = Math.min(len, start + spp);
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

  // playhead01 is intentionally normalized 0..1 for drawing
  function drawWaveform(canvas, peaks, playhead01) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // center line
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

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
    if (playhead01 != null) {
      const x = Math.round(clamp01(playhead01) * (w - 1)) + 0.5;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ----------------------------
  // Styles (disabled by default)
  // ----------------------------
  function injectStyleOnce() {
    if (!INJECT_DEFAULT_STYLES) return;
    if (document.getElementById("rnbo-playlist-style")) return;

    const style = document.createElement("style");
    style.id = "rnbo-playlist-style";
    style.textContent = `
      #playlist-ui { max-width: 920px; margin: 14px auto; padding: 12px; border: 1px solid rgba(0,0,0,0.15); border-radius: 14px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      .rnbo-title { font-weight: 800; font-size: 16px; margin-bottom: 10px; }
      .rnbo-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .rnbo-btn { padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.2); background: transparent; cursor: pointer; min-height: 44px; }
      .rnbo-label { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; }
      .rnbo-slider { width: 220px; height: 26px; }
      .rnbo-readout { font-variant-numeric: tabular-nums; opacity: 0.85; }
      .rnbo-progress { width: 100%; }
      .rnbo-list { margin-top: 12px; display: grid; grid-template-columns: 1fr; gap: 10px; }
      .rnbo-row { padding: 12px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.12); cursor: pointer; user-select: none; }
      .rnbo-row.selected { border: 2px solid rgba(0,0,0,0.45); }
      .rnbo-row.dragging { opacity: 0.85; border-style: dashed; }
      .rnbo-row-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
      .rnbo-row-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .rnbo-handle { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 1px solid rgba(0,0,0,0.14); cursor: grab; touch-action: none; flex: 0 0 auto; }
      .rnbo-filename { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
      .rnbo-meta { font-size: 12px; opacity: 0.7; white-space: nowrap; }
      .rnbo-canvas { display: block; width: 100%; border-radius: 10px; border: 1px solid rgba(0,0,0,0.12); }
      .rnbo-iconbtn { width: 56px; height: 56px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(0,0,0,0.2); background: transparent; cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  // ----------------------------
  // UI creation
  // ----------------------------
  function buildUI() {
    injectStyleOnce();

    let root = document.getElementById("playlist-ui");
    if (!root) {
      root = document.createElement("div");
      root.id = "playlist-ui";
      document.body.appendChild(root);
    }

    const title = createEl("div", { className: "rnbo-title", innerText: "Playlist" });

    const progressLabel = createEl("div", { className: "rnbo-readout", innerText: "Preload: 0%" });
    const progress = createEl("progress", { className: "rnbo-progress", value: 0, max: 1 });

    // Reframe-style icon buttons:
    // - We add both classes: "icon-button" (theme) + "rnbo-iconbtn" (scoped hook)
    // - Use simple inline SVG icons (no external icon fonts needed)
    const btnPlay = createEl("button", {
      className: "icon-button rnbo-iconbtn rnbo-play",
      type: "button",
      title: "Play",
      ariaLabel: "Play"
    }, [playIconSVG()]);

    const btnStop = createEl("button", {
      className: "icon-button rnbo-iconbtn rnbo-stop",
      type: "button",
      title: "Stop",
      ariaLabel: "Stop"
    }, [stopIconSVG()]);

    const loopToggle = createEl("input", { type: "checkbox" });
    const loopLabel = createEl("label", { className: "rnbo-label" }, [
      loopToggle,
      createEl("span", { innerText: "Loop" })
    ]);

    const rate = createEl("input", { className: "rnbo-slider", type: "range", min: -1, max: 2, step: 0.01, value: 1 });
    const rateVal = createEl("span", { className: "rnbo-readout", innerText: "1.00x" });
    const rateLabel = createEl("label", { className: "rnbo-label" }, [
      createEl("span", { innerText: "Speed" }),
      rate,
      rateVal
    ]);

    const vol = createEl("input", { className: "rnbo-slider", type: "range", min: 0, max: 158, step: 1, value: DEFAULT_OUTGAIN });
    const volVal = createEl("span", { className: "rnbo-readout", innerText: String(DEFAULT_OUTGAIN) });
    const volLabel = createEl("label", { className: "rnbo-label" }, [
      createEl("span", { innerText: "Volume" }),
      vol,
      volVal
    ]);

    const controls = createEl("div", { className: "rnbo-controls" }, [
      btnPlay, btnStop, loopLabel, rateLabel, volLabel
    ]);

    const playheadReadout = createEl("div", { className: "rnbo-readout", innerText: "Playhead: 0 ms" });

    const hint = createEl("div", {
      className: "rnbo-hint rnbo-readout",
      innerText: "Shortcuts: Space play/stop · Arrows prev/next · Enter play · Esc stop · L loop · Drag ☰ to reorder"
    });

    const list = createEl("div", { className: "rnbo-list" });

    root.innerHTML = "";
    root.appendChild(title);
    root.appendChild(progressLabel);
    root.appendChild(progress);
    root.appendChild(controls);
    root.appendChild(playheadReadout);
    root.appendChild(hint);
    root.appendChild(list);

    return {
      root,
      progress,
      progressLabel,
      btnPlay,
      btnStop,
      loopToggle,
      rate,
      rateVal,
      vol,
      volVal,
      playheadReadout,
      list
    };
  }

  // Simple inline SVG icons (inherit currentColor)
  function playIconSVG() {
    return createEl("span", { className: "rnbo-icon" }, [
      svgEl("svg", { viewBox: "0 0 24 24", width: "20", height: "20", ariaHidden: "true" }, [
        svgEl("path", { d: "M8 5v14l11-7z", fill: "currentColor" })
      ])
    ]);
  }

  function stopIconSVG() {
    return createEl("span", { className: "rnbo-icon" }, [
      svgEl("svg", { viewBox: "0 0 24 24", width: "18", height: "18", ariaHidden: "true" }, [
        svgEl("rect", { x: "7", y: "7", width: "10", height: "10", fill: "currentColor" })
      ])
    ]);
  }

  function svgEl(tag, attrs, children = []) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      // HTML ariaHidden maps to aria-hidden
      if (k === "ariaHidden") el.setAttribute("aria-hidden", String(v));
      else el.setAttribute(k, String(v));
    }
    for (const c of children) el.appendChild(c);
    return el;
  }

  // ----------------------------
  // Main init (called by app.js)
  // ----------------------------
  async function initPlaylistUI(device, context) {
    const ui = buildUI();

    // RNBO param bindings
    const pClipIndex = ensureParam(device, "clipIndex");
    const pRate = ensureParam(device, "rate");
    const pLoop = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");
    const pOutGain = ensureParam(device, "outGain");

    // ----------------------------
    // PRIME AUDIO (new)
    // ----------------------------
    let audioPrimed = false;
    async function primeAudio() {
      if (audioPrimed) return;

      // Resume WebAudio context (autoplay policy safe because called from a user gesture)
      if (context && context.state !== "running") {
        await context.resume();
      }

      // Ensure RNBO node is connected (some minimal pages omit the default UI wiring)
      try {
        if (device?.node && context?.destination) {
          device.node.connect(context.destination);
        }
      } catch (_) {
        // ignore errors like "already connected"
      }

      audioPrimed = true;
    }

    // Playback / playhead state
    let isPlaying = false;
    let endedAndStopped = false;
    let lastPlayheadMs = 0;

    // Load manifest
    let filenames = [];
    if (USE_HARDCODED_LIST) {
      filenames = HARD_CODED_ITEMS.slice();
    } else {
      const manifest = await fetchJSON(MANIFEST_URL);
      filenames = Array.isArray(manifest.items) ? manifest.items : [];
    }

    if (!filenames.length) {
      ui.progressLabel.innerText = "No playlist items found.";
      return;
    }

    // Apply saved order if compatible
    const saved = loadOrder();
    if (saved) filenames = applySavedOrder(filenames, saved);

    // Preload
    ui.progress.value = 0;
    ui.progressLabel.innerText = `Preload: 0% (0/${filenames.length})`;

    const items = [];
    for (let i = 0; i < filenames.length; i++) {
      const name = filenames[i];
      const url = MEDIA_BASE + name;

      const ab = await fetchArrayBuffer(url);
      const audioBuffer = await context.decodeAudioData(ab);
      const peaks = buildPeaks(audioBuffer, WAVE_W);

      items.push({
        name,
        url,
        audioBuffer,
        peaks,
        durationMs: (audioBuffer.length / audioBuffer.sampleRate) * 1000,
        rowEl: null,
        canvas: null,
        handleEl: null
      });

      const frac = (i + 1) / filenames.length;
      ui.progress.value = frac;
      ui.progressLabel.innerText = `Preload: ${Math.round(frac * 100)}% (${i + 1}/${filenames.length})`;
    }

    ui.progressLabel.innerText = `Preload complete: ${filenames.length} files`;

    // Default selection
    let selectedName = items[0]?.name || null;

    // ----------------------------
    // Selection helpers
    // ----------------------------
    function getSelectedIndex() {
      const idx = items.findIndex(it => it.name === selectedName);
      return idx >= 0 ? idx : 0;
    }

    function getSelectedItem() {
      return items[getSelectedIndex()];
    }

    function redrawSelected(playheadMsOrNull) {
      const it = getSelectedItem();
      if (!it || !it.canvas) return;

      const frac = (playheadMsOrNull == null)
        ? 0
        : (it.durationMs > 0 ? (playheadMsOrNull / it.durationMs) : 0);

      drawWaveform(it.canvas, it.peaks, clamp01(frac));
    }

    async function loadSelectedIntoRNBO() {
      const idx = getSelectedIndex();
      const it = items[idx];
      if (!it) return;

      await device.setDataBuffer("sample", it.audioBuffer);
      pClipIndex.value = idx;

      ui.playheadReadout.innerText = "Playhead: 0 ms";
      lastPlayheadMs = 0;
      endedAndStopped = false;

      items.forEach((x, i2) => {
        if (x.canvas) drawWaveform(x.canvas, x.peaks, (i2 === idx) ? 0 : null);
      });
    }

    async function selectByIndex(idx) {
      idx = Math.max(0, Math.min(items.length - 1, idx));

      // Stop before switching to keep state sane
      if (isPlaying) {
        pulseParam(pStopTrig);
        isPlaying = false;
        endedAndStopped = true;
      }

      selectedName = items[idx].name;
      renderList();
      await loadSelectedIntoRNBO();
    }

    // ----------------------------
    // Render + drag reorder
    // ----------------------------
    const dragState = { active: false, draggingName: null };

    function moveItem(fromIdx, toIdx) {
      if (fromIdx === toIdx) return;
      const [moved] = items.splice(fromIdx, 1);
      items.splice(toIdx, 0, moved);

      renderList();
      saveOrder(items.map(it => it.name));
      pClipIndex.value = getSelectedIndex(); // keep RNBO param consistent
    }

    function attachDragHandlers() {
      items.forEach((it) => {
        const handle = it.handleEl;
        const row = it.rowEl;
        if (!handle || !row) return;
        if (handle._rnboDragAttached) return;
        handle._rnboDragAttached = true;

        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handle.setPointerCapture?.(e.pointerId);

          dragState.active = true;
          dragState.draggingName = row.dataset.name;
          row.classList.add("dragging");
        });

        handle.addEventListener("pointermove", (e) => {
          if (!dragState.active) return;

          const el = document.elementFromPoint(e.clientX, e.clientY);
          const overRow = el?.closest?.(".rnbo-row");
          if (!overRow) return;

          const draggingIdx = items.findIndex(x => x.name === dragState.draggingName);
          const overName = overRow.dataset.name;
          const overIdx = items.findIndex(x => x.name === overName);

          if (draggingIdx < 0 || overIdx < 0 || draggingIdx === overIdx) return;
          moveItem(draggingIdx, overIdx);
        });

        function endDrag() {
          if (!dragState.active) return;
          dragState.active = false;

          const draggingIdx = items.findIndex(x => x.name === dragState.draggingName);
          if (draggingIdx >= 0) items[draggingIdx].rowEl?.classList.remove("dragging");

          dragState.draggingName = null;
        }

        handle.addEventListener("pointerup", endDrag);
        handle.addEventListener("pointercancel", endDrag);
        handle.addEventListener("lostpointercapture", endDrag);
      });
    }

    function renderList() {
      ui.list.innerHTML = "";

      const selectedIdx = getSelectedIndex();

      items.forEach((it, idx) => {
        const handle = createEl("div", { className: "rnbo-handle", innerText: "☰" });

        const filenameEl = createEl("div", { className: "rnbo-filename", innerText: it.name });
        const metaEl = createEl("div", { className: "rnbo-meta", innerText: `${Math.round(it.durationMs)} ms` });

        const left = createEl("div", { className: "rnbo-row-left" }, [handle, filenameEl]);
        const header = createEl("div", { className: "rnbo-row-header" }, [left, metaEl]);

        const canvas = createEl("canvas", { className: "rnbo-canvas" });
        canvas.width = WAVE_W;
        canvas.height = WAVE_H;

        it.canvas = canvas;
        it.handleEl = handle;

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null);

        const row = createEl("div", {
          className: "rnbo-row" + (idx === selectedIdx ? " selected" : ""),
          dataset: { name: it.name }
        }, [header, canvas]);

        row.addEventListener("click", async () => {
          if (dragState.active) return;
          await selectByIndex(idx);
        });

        it.rowEl = row;
        ui.list.appendChild(row);
      });

      attachDragHandlers();
    }

    // ----------------------------
    // Controls
    // ----------------------------
    async function doPlay() {
      endedAndStopped = false;

      // NEW: ensure audio context is running and RNBO is connected
      await primeAudio();

      isPlaying = true;
      pulseParam(pPlayTrig);
    }

    function doStop() {
      pulseParam(pStopTrig);
      isPlaying = false;
      endedAndStopped = true;
      lastPlayheadMs = 0;
      ui.playheadReadout.innerText = "Playhead: 0 ms";
      redrawSelected(0);
    }

    ui.btnPlay.addEventListener("click", () => { doPlay().catch(console.error); });
    ui.btnStop.addEventListener("click", doStop);

    ui.loopToggle.addEventListener("change", () => {
      pLoop.value = ui.loopToggle.checked ? 1 : 0;
      if (ui.loopToggle.checked) endedAndStopped = false;
    });

    ui.rate.addEventListener("input", () => {
      const v = parseFloat(ui.rate.value);
      pRate.value = v;
      ui.rateVal.innerText = `${v.toFixed(2)}x`;
    });

    ui.vol.addEventListener("input", () => {
      const v = Math.round(parseFloat(ui.vol.value));
      pOutGain.value = v;
      ui.volVal.innerText = String(v);
    });

    // Default gain as requested
    pOutGain.value = DEFAULT_OUTGAIN;
    ui.vol.value = String(DEFAULT_OUTGAIN);
    ui.volVal.innerText = String(DEFAULT_OUTGAIN);

    // Sync initial UI from RNBO params for rate/loop
    ui.rate.value = String(pRate.value ?? 1);
    ui.rateVal.innerText = `${(pRate.value ?? 1).toFixed(2)}x`;
    ui.loopToggle.checked = (pLoop.value ?? 0) >= 0.5;

    // ----------------------------
    // Playhead subscriber (baseline-correct)
    // ----------------------------
    let lastPaint = 0;
    device.messageEvent.subscribe((ev) => {
      if (!ev || ev.tag !== "playhead") return;

      const ms = Array.isArray(ev.payload) ? (ev.payload[0] ?? 0) : ev.payload;
      const now = performance.now();

      // Infer playing on forward motion
      if (ms > lastPlayheadMs + 1) {
        isPlaying = true;
        endedAndStopped = false;
      }

      const loopOn = (pLoop.value ?? 0) >= 0.5;

      // EOF detection: ms returns to 0 after advancing, loop OFF
      if (!loopOn && !endedAndStopped && ms <= 0 && lastPlayheadMs > 0) {
        pulseParam(pStopTrig);
        isPlaying = false;
        endedAndStopped = true;

        ui.playheadReadout.innerText = "Playhead: 0 ms";
        redrawSelected(0);
        lastPlayheadMs = 0;
        return;
      }

      lastPlayheadMs = ms;

      // If we're not playing, ignore paint/readout updates
      if (!isPlaying) return;

      // Throttle drawing
      if (now - lastPaint < PLAYHEAD_THROTTLE_MS) return;
      lastPaint = now;

      ui.playheadReadout.innerText = `Playhead: ${Math.round(ms)} ms`;
      redrawSelected(ms);
    });

    // ----------------------------
    // Keyboard shortcuts
    // ----------------------------
    function handleKeyDown(e) {
      if (isTextInputTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;

      if (key === " " || key === "Spacebar") {
        e.preventDefault();
        if (isPlaying) doStop();
        else doPlay().catch(() => {});
        return;
      }

      if (key === "Enter") {
        e.preventDefault();
        doPlay().catch(() => {});
        return;
      }

      if (key === "Escape") {
        e.preventDefault();
        doStop();
        return;
      }

      if (key === "ArrowUp" || key === "ArrowLeft") {
        e.preventDefault();
        selectByIndex(getSelectedIndex() - 1).catch(() => {});
        return;
      }

      if (key === "ArrowDown" || key === "ArrowRight") {
        e.preventDefault();
        selectByIndex(getSelectedIndex() + 1).catch(() => {});
        return;
      }

      if (key === "Home") {
        e.preventDefault();
        selectByIndex(0).catch(() => {});
        return;
      }

      if (key === "End") {
        e.preventDefault();
        selectByIndex(items.length - 1).catch(() => {});
        return;
      }

      if (key.toLowerCase() === "l") {
        e.preventDefault();
        ui.loopToggle.checked = !ui.loopToggle.checked;
        pLoop.value = ui.loopToggle.checked ? 1 : 0;
        if (ui.loopToggle.checked) endedAndStopped = false;
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown, { passive: false });

    // ----------------------------
    // Initial render/load
    // ----------------------------
    renderList();
    await loadSelectedIntoRNBO();
  }

  // Expose global initializer for app.js
  window.initPlaylistUI = initPlaylistUI;

})();