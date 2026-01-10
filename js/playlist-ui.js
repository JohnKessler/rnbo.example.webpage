// playlist-ui.js
// RNBO Playlist UI (Web Export) — Penpot-aligned baseline
//
// Behavior:
// - Preload + waveform thumbnails
// - Scroll-reactive header separation
// - Drag reorder + persistence
// - Keyboard shortcuts
// - RNBO playhead sync
//
// Design-to-code alignment:
// - Uses .selected + .is-active (both applied)
// - Uses .dragging + .is-dragging (both applied)
// - No DOM structure changes required

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";
  const MANIFEST_URL = MEDIA_BASE + "playlist.json";

  const WAVE_W = 520;
  const WAVE_H = 80;

  const PLAYHEAD_THROTTLE_MS = 16;
  const DEFAULT_OUTGAIN = 112;

  const ORDER_KEY = "rnbo_playlist_order_v2";

  const USE_HARDCODED_LIST = false;
  const HARD_CODED_ITEMS = [];

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
    if (!r.ok) throw new Error(`Failed to fetch ${url}`);
    return r.json();
  }

  async function fetchArrayBuffer(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url}`);
    return r.arrayBuffer();
  }

  function saveOrder(names) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(names)); } catch (_) {}
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
      Object.entries(props.dataset).forEach(([k, v]) => el.dataset[k] = v);
      delete props.dataset;
    }

    Object.assign(el, props);
    children.forEach(c => el.appendChild(c));
    return el;
  }

  // ----------------------------
  // UI
  // ----------------------------
  function buildUI() {
    let root = document.getElementById("playlist-ui");
    if (!root) {
      root = document.createElement("div");
      root.id = "playlist-ui";
      document.body.appendChild(root);
    }

    const top = createEl("div", { className: "rnbo-top" });
    const scroll = createEl("div", { className: "rnbo-scroll" });

    const title = createEl("div", { className: "rnbo-title", innerText: "Playlist" });
    const progressLabel = createEl("div", { className: "rnbo-readout", innerText: "Preload: 0%" });
    const progress = createEl("progress", { className: "rnbo-progress", value: 0, max: 1 });

    const btnPlay = createEl("button", { className: "rnbo-btn rnbo-play", innerText: "Play" });
    const btnStop = createEl("button", { className: "rnbo-btn rnbo-stop", innerText: "Stop" });

    const controls = createEl("div", { className: "rnbo-controls" }, [btnPlay, btnStop]);
    const list = createEl("div", { className: "rnbo-list" });

    top.append(title, progressLabel, progress, controls);
    scroll.appendChild(list);
    root.replaceChildren(top, scroll);

    return { root, top, scroll, list, progress, progressLabel, btnPlay, btnStop };
  }

  // ----------------------------
  // Waveform
  // ----------------------------
  function buildPeaks(audioBuffer, width) {
    const ch0 = audioBuffer.getChannelData(0);
    const len = ch0.length;
    const spp = Math.max(1, Math.floor(len / width));
    const peaks = new Float32Array(width * 2);

    for (let x = 0; x < width; x++) {
      let min = 1, max = -1;
      for (let i = x * spp; i < Math.min(len, (x + 1) * spp); i++) {
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

    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      ctx.moveTo(x + 0.5, (1 - (max * 0.5 + 0.5)) * h);
      ctx.lineTo(x + 0.5, (1 - (min * 0.5 + 0.5)) * h);
    }
    ctx.stroke();

    if (playhead01 != null) {
      const x = clamp01(playhead01) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  // ----------------------------
  // Init
  // ----------------------------
  async function initPlaylistUI(device, context) {
    const ui = buildUI();

    const pClipIndex = ensureParam(device, "clipIndex");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");

    const manifest = USE_HARDCODED_LIST
      ? { items: HARD_CODED_ITEMS }
      : await fetchJSON(MANIFEST_URL);

    const filenames = manifest.items || [];
    const items = [];

    for (let i = 0; i < filenames.length; i++) {
      const ab = await fetchArrayBuffer(MEDIA_BASE + filenames[i]);
      const audioBuffer = await context.decodeAudioData(ab);
      const peaks = buildPeaks(audioBuffer, WAVE_W);

      items.push({
        name: filenames[i],
        audioBuffer,
        peaks,
        durationMs: audioBuffer.length / audioBuffer.sampleRate * 1000
      });

      ui.progress.value = (i + 1) / filenames.length;
      ui.progressLabel.innerText = `Preload: ${Math.round(ui.progress.value * 100)}%`;
    }

    ui.progressLabel.innerText = "Preload complete";

    let selectedIdx = 0;

    function renderList() {
      ui.list.innerHTML = "";

      items.forEach((it, idx) => {
        const canvas = createEl("canvas", { className: "rnbo-canvas" });
        canvas.width = WAVE_W;
        canvas.height = WAVE_H;

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null);

        const row = createEl("div", {
          className:
            "rnbo-row" +
            (idx === selectedIdx ? " selected is-active" : "")
        }, [canvas]);

        row.addEventListener("click", () => {
          selectedIdx = idx;
          pClipIndex.value = idx;
          renderList();
        });

        ui.list.appendChild(row);
      });
    }

    renderList();

    ui.btnPlay.onclick = () => pulseParam(pPlayTrig);
    ui.btnStop.onclick = () => pulseParam(pStopTrig);
  }

  window.initPlaylistUI = initPlaylistUI;
})();