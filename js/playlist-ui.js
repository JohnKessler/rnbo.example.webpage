// playlist-ui.js
// RNBO Playlist UI: preload -> waveform thumbnails -> select/play/stop/rate/loop -> playhead (ms)
//
// Requires:
// - RNBO device has externalDataRefs id "sample" (buffer~)  ✅ per your patch.export.json
// - RNBO device has outport tag "playhead"                  ✅ per your patch.export.json
// - Parameters: clipIndex, rate, loop, playTrig, stopTrig   ✅ per your patch.export.json

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";          // where your bundled assets live
  const MANIFEST_URL = MEDIA_BASE + "playlist.json"; // { "items": ["a.wav","b.wav"] }
  const WAVE_W = 520;
  const WAVE_H = 70;
  const PLAYHEAD_THROTTLE_MS = 16; // ~60fps

  // If you don't want a playlist.json manifest, set this to true and fill HARD_CODED_ITEMS
  const USE_HARDCODED_LIST = false;
  const HARD_CODED_ITEMS = [
    // "kick.wav",
    // "snare.wav"
  ];

  // ----------------------------
  // Small helpers
  // ----------------------------
  function $(id) { return document.getElementById(id); }

  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function ensureParam(device, id) {
    const p = device.parametersById?.get(id) || device.parameters.find(pp => pp.id === id);
    if (!p) throw new Error(`Missing RNBO parameter id="${id}" (check patch.export.json)`);
    return p;
  }

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url} (${r.status})`);
    return r.json();
  }

  async function fetchArrayBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch ${url} (${r.status})`);
    return r.arrayBuffer();
  }

  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.assign(el, props);
    for (const c of children) el.appendChild(c);
    return el;
  }

  // Build quick min/max “peaks” to draw a waveform thumbnail
  function buildPeaks(audioBuffer, width) {
    const ch0 = audioBuffer.getChannelData(0); // files are mono per your spec
    const len = ch0.length;
    const samplesPerPixel = Math.max(1, Math.floor(len / width));
    const peaks = new Float32Array(width * 2); // [min,max,min,max...]
    for (let x = 0; x < width; x++) {
      const start = x * samplesPerPixel;
      const end = Math.min(len, start + samplesPerPixel);
      let min = 1.0, max = -1.0;
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

  function drawWaveform(canvas, peaks, playhead01) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    // background
    ctx.clearRect(0, 0, w, h);

    // center line
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.globalAlpha = 1.0;

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
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }

  // Trigger-style param pulse (1 then back to 0)
  function pulseParam(param, ms = 20) {
    param.value = 1;
    setTimeout(() => { param.value = 0; }, ms);
  }

  // ----------------------------
  // UI creation
  // ----------------------------
  function ensureUIRoot() {
    let root = $("playlist-ui");
    if (root) return root;

    root = createEl("div", { id: "playlist-ui" });
    root.style.maxWidth = "820px";
    root.style.margin = "16px auto";
    root.style.padding = "12px";
    root.style.border = "1px solid rgba(0,0,0,0.15)";
    root.style.borderRadius = "10px";
    root.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    document.body.appendChild(root);
    return root;
  }

  function buildUI() {
    const root = ensureUIRoot();

    // Header
    const title = createEl("div", { innerText: "Playlist" });
    title.style.fontWeight = "700";
    title.style.marginBottom = "10px";

    // Progress row
    const progressLabel = createEl("div", { innerText: "Preload: 0%" });
    progressLabel.style.margin = "8px 0 6px 0";
    const progress = createEl("progress", { value: 0, max: 1 });
    progress.style.width = "100%";

    // Controls row
    const btnPlay = createEl("button", { innerText: "Play" });
    const btnStop = createEl("button", { innerText: "Stop" });
    const loopLabel = createEl("label", { innerText: " Loop" });
    const loopToggle = createEl("input", { type: "checkbox" });
    loopLabel.prepend(loopToggle);

    const rateLabel = createEl("label", { innerText: " Speed" });
    rateLabel.style.marginLeft = "12px";
    const rate = createEl("input", { type: "range", min: -4, max: 4, step: 0.01, value: 1 });
    rate.style.width = "220px";
    const rateVal = createEl("span", { innerText: " 1.00x" });
    rateLabel.appendChild(rate);
    rateLabel.appendChild(rateVal);

    const playheadReadout = createEl("div", { innerText: "Playhead: 0 ms" });
    playheadReadout.style.marginTop = "10px";
    playheadReadout.style.fontVariantNumeric = "tabular-nums";

    const controls = createEl("div", {}, [btnPlay, btnStop, loopLabel, rateLabel]);
    controls.style.display = "flex";
    controls.style.alignItems = "center";
    controls.style.gap = "10px";
    controls.style.flexWrap = "wrap";

    // List container
    const list = createEl("div");
    list.style.marginTop = "12px";
    list.style.display = "grid";
    list.style.gridTemplateColumns = "1fr";
    list.style.gap = "10px";

    root.appendChild(title);
    root.appendChild(progressLabel);
    root.appendChild(progress);
    root.appendChild(controls);
    root.appendChild(playheadReadout);
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
      playheadReadout,
      list
    };
  }

  // ----------------------------
  // Main init
  // ----------------------------
  async function initPlaylistUI(device, context) {
    const ui = buildUI();

    // RNBO bindings (these IDs come from your patch.export.json)
    const pClipIndex = ensureParam(device, "clipIndex");
    const pRate     = ensureParam(device, "rate");
    const pLoop     = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");

    // Cache of decoded AudioBuffers + waveform peaks
    const items = [];
    let selectedIndex = 0;

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

    // Preload (Option A with progress bar)
    ui.progress.value = 0;
    ui.progressLabel.innerText = `Preload: 0% (0/${filenames.length})`;

    for (let i = 0; i < filenames.length; i++) {
      const name = filenames[i];
      const url = MEDIA_BASE + name;

      const ab = await fetchArrayBuffer(url);
      const audioBuffer = await context.decodeAudioData(ab);

      const peaks = buildPeaks(audioBuffer, WAVE_W);

      items.push({
        index: i,
        name,
        url,
        audioBuffer,
        peaks,
        durationMs: (audioBuffer.length / audioBuffer.sampleRate) * 1000,
        rowEl: null,
        canvas: null,
        isSelected: false
      });

      const frac = (i + 1) / filenames.length;
      ui.progress.value = frac;
      ui.progressLabel.innerText = `Preload: ${Math.round(frac * 100)}% (${i + 1}/${filenames.length})`;
    }

    ui.progressLabel.innerText = `Preload complete: ${filenames.length} files`;

    // Build list UI
    function renderList() {
      ui.list.innerHTML = "";

      items.forEach((it) => {
        const filenameEl = createEl("div", { innerText: it.name });
        filenameEl.style.fontWeight = it.index === selectedIndex ? "700" : "500";

        const metaEl = createEl("div", { innerText: `${Math.round(it.durationMs)} ms` });
        metaEl.style.opacity = "0.7";
        metaEl.style.fontSize = "12px";

        const header = createEl("div", {}, [filenameEl, metaEl]);
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.gap = "12px";

        const canvas = createEl("canvas");
        canvas.width = WAVE_W;
        canvas.height = WAVE_H;
        canvas.style.width = "100%";
        canvas.style.height = `${WAVE_H}px`;
        canvas.style.borderRadius = "8px";
        canvas.style.border = "1px solid rgba(0,0,0,0.12)";

        it.canvas = canvas;

        // initial draw
        drawWaveform(canvas, it.peaks, it.index === selectedIndex ? 0 : null);

        const row = createEl("div", {}, [header, canvas]);
        row.style.padding = "10px";
        row.style.borderRadius = "10px";
        row.style.border = it.index === selectedIndex ? "2px solid rgba(0,0,0,0.45)" : "1px solid rgba(0,0,0,0.12)";
        row.style.cursor = "pointer";

        row.addEventListener("click", async () => {
          await selectIndex(it.index);
        });

        it.rowEl = row;
        ui.list.appendChild(row);
      });
    }

    async function loadSelectedIntoRNBO() {
      const it = items[selectedIndex];

      // Push audio into RNBO buffer~ external data ref:
      // externalDataRefs id "sample" per patch.export.json
      await device.setDataBuffer("sample", it.audioBuffer);

      // Inform RNBO which playlist index is selected (your param exists in export)
      pClipIndex.value = selectedIndex;

      // Reset playhead visuals for the selected item
      items.forEach((x, idx) => {
        if (x.canvas) drawWaveform(x.canvas, x.peaks, idx === selectedIndex ? 0 : null);
      });
      ui.playheadReadout.innerText = "Playhead: 0 ms";
    }

    async function selectIndex(i) {
      selectedIndex = i;
      renderList();
      await loadSelectedIntoRNBO();
    }

    // Controls -> RNBO params
    ui.btnPlay.addEventListener("click", () => pulseParam(pPlayTrig));
    ui.btnStop.addEventListener("click", () => pulseParam(pStopTrig));

    ui.loopToggle.addEventListener("change", () => {
      pLoop.value = ui.loopToggle.checked ? 1 : 0;
    });

    ui.rate.addEventListener("input", () => {
      const v = parseFloat(ui.rate.value);
      pRate.value = v;
      ui.rateVal.innerText = ` ${v.toFixed(2)}x`;
    });

    // Playhead listener (ms)
    let lastPlayheadPaint = 0;
    device.messageEvent.subscribe((ev) => {
      if (ev.tag !== "playhead") return;

      // RNBO message payloads are numeric arrays.
      // We'll treat payload[0] as ms (your preference).
      const now = performance.now();
      if (now - lastPlayheadPaint < PLAYHEAD_THROTTLE_MS) return;
      lastPlayheadPaint = now;

      const ms = Array.isArray(ev.payload) ? (ev.payload[0] ?? 0) : 0;
      ui.playheadReadout.innerText = `Playhead: ${Math.round(ms)} ms`;

      const it = items[selectedIndex];
      const frac = it.durationMs > 0 ? (ms / it.durationMs) : 0;
      if (it.canvas) drawWaveform(it.canvas, it.peaks, frac);
    });

    // Initial state
    ui.rate.value = String(pRate.value ?? 1);
    ui.rateVal.innerText = ` ${(pRate.value ?? 1).toFixed(2)}x`;
    ui.loopToggle.checked = (pLoop.value ?? 0) >= 0.5;

    renderList();
    await loadSelectedIntoRNBO();
  }

  // Expose global initializer for app.js to call
  window.initPlaylistUI = initPlaylistUI;
})();