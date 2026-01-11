// playlist-ui.js
// RNBO Playlist UI — stable core behavior + styled UI
//
// Version: v1.0.1
//
// Updates in this version:
// - Uses "jumpto" as milliseconds with fixed param range: min=0, max=600000
// - Removes any normalized (0..1) fallback logic (no longer needed)
// - Clamps jumpto to track duration (durationMs - 1) when known
// - Resets jumpto to 0 on Stop / Selection / EOF to keep Play deterministic
//
// Keeps existing functionality: preload, waveform thumbnails, playhead drawing, EOF stop logic,
// drag reorder + persistence, keyboard shortcuts, touch interactions, volume via outGain.
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Optional RNBO parameter (by id):
//   jumpto  (milliseconds, min 0, max 600000)
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
  const ORDER_KEY = "rnbo_playlist_order_v4";

  const WAVE_W = 520;
  const WAVE_H = 80;

  const DEFAULT_OUTGAIN = 120;

  const PLAYHEAD_THROTTLE_MS = 16;

  // jumpto param range (as you set in the patch)
  const JUMPTO_MIN_MS = 0;
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
    param.value = 1;
    setTimeout(() => {
      param.value = 0;
    }, ms);
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
  // Premium header effects
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
      const vel = Math.abs(dy) / (dt / 1000); // px/s
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
  // Icons
  // ----------------------------
  function playIconSVG() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M8 5v14l11-7z");
    svg.appendChild(path);
    return svg;
  }

  function stopIconSVG() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "7");
    rect.setAttribute("y", "7");
    rect.setAttribute("width", "10");
    rect.setAttribute("height", "10");
    svg.appendChild(rect);
    return svg;
  }

  // ----------------------------
  // UI Build
  // ----------------------------
  function buildUI() {
    const root = document.getElementById("playlist-ui");
    if (!root) throw new Error('Missing #playlist-ui container in playlist.html');

    const top = createEl("div", { className: "rnbo-top" });
    const scroll = createEl("div", { className: "rnbo-scroll" });

    const title = createEl("div", { className: "rnbo-title", innerText: "Playlist" });

    const progressLabel = createEl("div", { className: "rnbo-readout", innerText: "Preload: 0%" });
    const progress = createEl("progress", { className: "rnbo-progress", value: 0, max: 1 });

    const btnPlay = createEl(
      "button",
      {
        className: "icon-button rnbo-iconbtn rnbo-play",
        type: "button",
        title: "Play",
        ariaLabel: "Play",
      },
      [playIconSVG()]
    );

    const btnStop = createEl(
      "button",
      {
        className: "icon-button rnbo-iconbtn rnbo-stop",
        type: "button",
        title: "Stop",
        ariaLabel: "Stop",
      },
      [stopIconSVG()]
    );

    const loopToggle = createEl("input", { type: "checkbox" });
    const loopLabel = createEl("label", { className: "rnbo-label" }, [
      loopToggle,
      createEl("span", { innerText: "Loop" }),
    ]);

    const rate = createEl("input", {
      className: "rnbo-slider",
      type: "range",
      min: -1,
      max: 2,
      step: 0.01,
      value: 1,
    });
    const rateVal = createEl("span", { className: "rnbo-readout", innerText: "1.00x" });
    const rateLabel = createEl("label", { className: "rnbo-label" }, [
      createEl("span", { innerText: "Speed" }),
      rate,
      rateVal,
    ]);

    const vol = createEl("input", {
      className: "rnbo-slider",
      type: "range",
      min: 0,
      max: 158,
      step: 1,
      value: DEFAULT_OUTGAIN,
    });
    const volVal = createEl("span", { className: "rnbo-readout", innerText: String(DEFAULT_OUTGAIN) });
    const volLabel = createEl("label", { className: "rnbo-label" }, [
      createEl("span", { innerText: "Volume" }),
      vol,
      volVal,
    ]);

    const controls = createEl("div", { className: "rnbo-controls" }, [
      btnPlay,
      btnStop,
      loopLabel,
      rateLabel,
      volLabel,
    ]);

    const playheadReadout = createEl("div", { className: "rnbo-readout", innerText: "Playhead: 0 ms" });

    const hint = createEl("div", {
      className: "rnbo-hint rnbo-readout",
      innerText:
        "Shortcuts: Space play/stop · Arrows prev/next · Enter play · Esc stop · L loop · Drag ☰ to reorder",
    });

    const list = createEl("div", { className: "rnbo-list" });

    root.innerHTML = "";
    top.appendChild(title);
    top.appendChild(progressLabel);
    top.appendChild(progress);
    top.appendChild(controls);
    top.appendChild(playheadReadout);
    top.appendChild(hint);

    scroll.appendChild(list);

    root.appendChild(top);
    root.appendChild(scroll);

    installPremiumHeaderEffects(top, scroll);

    return {
      root,
      top,
      scroll,
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
      list,
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
      (device.parametersById?.get("jumpto") || (device.parameters || []).find((p) => p.id === "jumpto")) || null;
    const pLoop = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");
    const pOutGain = ensureParam(device, "outGain");

    // Prime audio (browser autoplay policies)
    async function primeAudio() {
      try {
        if (context && context.state !== "running") await context.resume();
      } catch (_) {}
    }

    // Optional jump-to parameter (milliseconds, range defined in patch)
    function supportsJumpTo() {
      return !!pJumpTo && typeof pJumpTo.value === "number";
    }

    function clampJumpToMs(ms, durationMsOrNull) {
      let v = Number(ms);
      if (!Number.isFinite(v)) v = 0;

      // clamp to param range first
      v = Math.max(JUMPTO_MIN_MS, Math.min(JUMPTO_MAX_MS, v));

      // clamp to track duration if provided; avoid exactly "end" by using duration-1
      const dur = Number(durationMsOrNull);
      if (Number.isFinite(dur) && dur > 1) {
        v = Math.max(0, Math.min(v, Math.floor(dur - 1)));
      }
      return v;
    }

    function setJumpToMs(targetMs, itemDurationMs) {
      if (!supportsJumpTo()) return false;

      const v = clampJumpToMs(targetMs, itemDurationMs);
      try {
        pJumpTo.value = v;
        return true;
      } catch (e) {
        console.warn("Failed to set jumpto:", e);
        return false;
      }
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
      items.push({ name, audioBuffer, peaks, durationMs, canvas: null, rowEl: null, handleEl: null });

      const frac = (i + 1) / Math.max(1, ordered.length);
      ui.progress.value = frac;
      ui.progressLabel.innerText = `Preload: ${Math.round(frac * 100)}% (${i + 1}/${ordered.length})`;
    }

    ui.progress.value = 1;
    ui.progressLabel.innerText = `Preload complete: ${ordered.length} files`;

    // State
    let selectedName = items[0]?.name || null;
    let lastPlayheadMs = 0;
    let endedAndStopped = true;
    let isPlaying = false;

    // Selection helpers
    function getSelectedIndex() {
      const idx = items.findIndex((x) => x.name === selectedName);
      return idx >= 0 ? idx : 0;
    }

    async function selectByIndex(idx) {
      idx = Math.max(0, Math.min(items.length - 1, idx));
      selectedName = items[idx].name;

      // Set clipIndex (if patch uses it)
      try {
        pClipIndex.value = idx;
      } catch (_) {}

      endedAndStopped = true;
      isPlaying = false;
      lastPlayheadMs = 0;

      // Reset position for determinism (if jumpto exists)
      const it = items[idx];
      if (it && supportsJumpTo()) {
        setJumpToMs(0, it.durationMs);
      }

      ui.playheadReadout.innerText = "Playhead: 0 ms";
      renderList();
    }

    function redrawSelected(ms) {
      const idx = getSelectedIndex();
      const it = items[idx];
      if (!it || !it.canvas) return;
      drawWaveform(it.canvas, it.peaks, ms, it.durationMs);
    }

    // ----------------------------
    // Drag reorder
    // ----------------------------
    const dragState = {
      active: false,
      draggingName: null,
    };

    function moveItem(fromIdx, toIdx) {
      const it = items.splice(fromIdx, 1)[0];
      items.splice(toIdx, 0, it);
      saveOrder(items.map((x) => x.name));
      renderList();
    }

    function attachDragHandlers() {
      items.forEach((it) => {
        const handle = it.handleEl;
        if (!handle) return;

        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          handle.setPointerCapture(e.pointerId);

          dragState.active = true;
          dragState.draggingName = it.name;
          it.rowEl?.classList.add("dragging");
        });

        handle.addEventListener("pointermove", (e) => {
          if (!dragState.active) return;

          const overRow = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".rnbo-row");
          if (!overRow) return;

          const draggingIdx = items.findIndex((x) => x.name === dragState.draggingName);
          const overName = overRow.dataset.name;
          const overIdx = items.findIndex((x) => x.name === overName);

          if (draggingIdx < 0 || overIdx < 0 || draggingIdx === overIdx) return;
          moveItem(draggingIdx, overIdx);
        });

        function endDrag() {
          if (!dragState.active) return;
          dragState.active = false;

          const draggingIdx = items.findIndex((x) => x.name === dragState.draggingName);
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

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null, it.durationMs);

        const row = createEl(
          "div",
          {
            className: "rnbo-row" + (idx === selectedIdx ? " selected" : ""),
            dataset: { name: it.name },
          },
          [header, canvas]
        );

        row.addEventListener("click", async () => {
          if (dragState.active) return;
          await selectByIndex(idx);
        });

        it.rowEl = row;
        ui.list.appendChild(row);
      });

      attachDragHandlers();
    }

    renderList();

    // ----------------------------
    // Controls
    // ----------------------------
    async function doPlay() {
      await primeAudio();

      const it = items[getSelectedIndex()];
      const dur = it ? it.durationMs : 0;

      const rateNow = parseFloat(pRate.value);
      const isReverse = Number.isFinite(rateNow) && rateNow < 0;
      const loopOn = (pLoop.value ?? 0) >= 0.5;

      // If we ended previously, make sure we’re re-armed.
      // This avoids “must press Stop after EOF” behavior.
      if (endedAndStopped) {
        pulseParam(pStopTrig);
        lastPlayheadMs = 0;
        ui.playheadReadout.innerText = "Playhead: 0 ms";
        redrawSelected(0);

        // reset position for determinism
        if (supportsJumpTo() && dur > 0) setJumpToMs(0, dur);
      }

      // If we have jumpto, use it as the authoritative "start position".
      // Your patch behavior: jumpto jumps to ms and starts playback if necessary.
      if (supportsJumpTo() && dur > 0) {
        if (isReverse && !loopOn) {
          // key reverse fix: start from near end so reverse can move immediately
          setJumpToMs(dur - 1, dur);
        } else {
          // normal: deterministic from beginning
          setJumpToMs(0, dur);
        }

        endedAndStopped = false;
        isPlaying = true;

        // Some patches still require playTrig even if jumpto starts playback.
        // Keeping it for safety.
        pulseParam(pPlayTrig);
        return;
      }

      // Fallback (no jumpto)
      endedAndStopped = false;
      isPlaying = true;
      pulseParam(pPlayTrig);

      // Reverse + loop OFF without jumpto can be unreliable by design.
      if (isReverse && !loopOn) {
        console.warn("Reverse playback with loop OFF is limited without 'jumpto'.");
      }
    }

    function doStop() {
      pulseParam(pStopTrig);
      isPlaying = false;
      endedAndStopped = true;
      lastPlayheadMs = 0;

      const it = items[getSelectedIndex()];
      const dur = it ? it.durationMs : 0;

      // If jumpto exists, force position back to 0 so next Play is deterministic.
      if (supportsJumpTo() && dur > 0) {
        setJumpToMs(0, dur);
      }

      ui.playheadReadout.innerText = "Playhead: 0 ms";
      redrawSelected(0);
    }

    ui.btnPlay.addEventListener("click", () => {
      doPlay().catch(console.error);
    });
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

    // Default gain
    pOutGain.value = DEFAULT_OUTGAIN;
    ui.vol.value = String(DEFAULT_OUTGAIN);
    ui.volVal.innerText = String(DEFAULT_OUTGAIN);

    // Sync initial UI from RNBO params for rate/loop
    ui.rate.value = String(pRate.value ?? 1);
    ui.rateVal.innerText = `${(pRate.value ?? 1).toFixed(2)}x`;
    ui.loopToggle.checked = (pLoop.value ?? 0) >= 0.5;

    // ----------------------------
    // Playhead subscriber
    // ----------------------------
    let lastPaint = 0;

    device.messageEvent.subscribe((ev) => {
      if (!ev || ev.tag !== "playhead") return;

      const ms = Array.isArray(ev.payload) ? (ev.payload[0] ?? 0) : ev.payload;
      const now = performance.now();

      // If playhead is moving, we consider playback active.
      if (ms > lastPlayheadMs + 1) {
        isPlaying = true;
        endedAndStopped = false;
      }

      const loopOn = (pLoop.value ?? 0) >= 0.5;

      // EOF detection: if loop is OFF and playhead drops to 0 after being >0.
      if (!loopOn && !endedAndStopped && ms <= 0 && lastPlayheadMs > 0) {
        pulseParam(pStopTrig);
        isPlaying = false;
        endedAndStopped = true;

        // Reset jumpto to 0 (helps deterministic next Play)
        const it = items[getSelectedIndex()];
        if (it && supportsJumpTo() && it.durationMs > 0) {
          setJumpToMs(0, it.durationMs);
        }

        ui.playheadReadout.innerText = "Playhead: 0 ms";
        redrawSelected(0);
        lastPlayheadMs = 0;
        return;
      }

      lastPlayheadMs = ms;

      if (!isPlaying) return;

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

      const key = e.key.toLowerCase();

      if (key === " " || e.code === "Space" || key === "enter") {
        e.preventDefault();
        if (!isPlaying) doPlay().catch(console.error);
        else doStop();
      } else if (key === "escape" || key === "esc") {
        e.preventDefault();
        doStop();
      } else if (key === "l") {
        e.preventDefault();
        ui.loopToggle.checked = !ui.loopToggle.checked;
        pLoop.value = ui.loopToggle.checked ? 1 : 0;
      } else if (key === "arrowdown") {
        e.preventDefault();
        selectByIndex(getSelectedIndex() + 1).catch(console.error);
      } else if (key === "arrowup") {
        e.preventDefault();
        selectByIndex(getSelectedIndex() - 1).catch(console.error);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    // Set initial selection
    await selectByIndex(0);
  }

  window.initPlaylistUI = initPlaylistUI;
})();