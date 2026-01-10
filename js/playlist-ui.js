// playlist-ui.js
// RNBO Playlist UI (Web Export) — Penpot-aligned, full-feature build
//
// Requires RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Requires RNBO external buffer name:
//   "sample"
// Requires port message tag (outport) for playhead:
//   "playhead" with ms as payload[0]
//
// DOM contract (matches playlist.css):
//   #playlist-ui
//     .rnbo-top
//       .header-row-title
//       .header-row-transport
//       .header-row-progress
//     .rnbo-scroll
//       .rnbo-list
//         .rnbo-row (draggable)
//           .rnbo-row-header
//             .rnbo-left-stack
//               .rnbo-index
//               .rnbo-handle
//             .rnbo-item-info
//               .rnbo-item-title
//               .rnbo-item-meta
//           .rnbo-waveform
//             canvas.rnbo-canvas

(function () {
  "use strict";

  // ----------------------------
  // Config
  // ----------------------------
  const MEDIA_BASE = "export/media/";
  const MANIFEST_URL = MEDIA_BASE + "playlist.json";
  const ORDER_KEY = "rnbo_playlist_order_v3";

  // Waveform
  const WAVE_W = 520;
  const WAVE_H = 80;

  // UI
  const DEFAULT_OUTGAIN = 112; // maps to your rnbo outGain param scale (0..158 in your older UI)

  // Throttle playhead UI updates
  const PLAYHEAD_THROTTLE_MS = 16;

  // ----------------------------
  // Helpers
  // ----------------------------
  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function msToTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
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

    // dataset support
    if (props.dataset) {
      Object.entries(props.dataset).forEach(([k, v]) => (el.dataset[k] = v));
      delete props.dataset;
    }

    // ariaLabel convenience
    if (props.ariaLabel) {
      el.setAttribute("aria-label", props.ariaLabel);
      delete props.ariaLabel;
    }

    Object.assign(el, props);
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  // Minimal inline SVG icons (so no dependency on fonts)
  function iconSVG(pathD) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    svg.style.display = "block";
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", pathD);
    p.setAttribute("fill", "currentColor");
    svg.appendChild(p);
    return svg;
  }

  const ICON_PLAY = "M8 5v14l11-7z";
  const ICON_STOP = "M7 7h10v10H7z";
  const ICON_LOOP = "M17 1l4 4-4 4V6H7a4 4 0 000 8h1v2H7a6 6 0 010-12h10V1zm-6 14v3l-4-4 4-4v3h6a4 4 0 000-8h-1V3h1a6 6 0 010 12h-6z";

  // ----------------------------
  // Waveform
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

  function drawWaveform(canvas, peaks, playhead01) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // waveform lines (single stroke; color from CSS currentColor if desired)
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

    if (playhead01 != null) {
      const x = clamp01(playhead01) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  // ----------------------------
  // UI Build
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

    // --- Row: Title/Status
    const headerRowTitle = createEl("div", { className: "header-row-title" });
    const titleStack = createEl("div", { className: "title-stack" }, [
      createEl("div", { className: "rnbo-title", innerText: "Playlist" }),
      createEl("div", { className: "rnbo-meta", innerText: "RNBO Web Export" }),
    ]);
    const statusBadge = createEl("div", { className: "status-badge" }, [
      createEl("span", { className: "status-text", innerText: "Ready" }),
    ]);
    headerRowTitle.append(titleStack, statusBadge);

    // --- Row: Transport + Volume
    const headerRowTransport = createEl("div", { className: "header-row-transport" });

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

    const vol = createEl("input", {
      className: "rnbo-slider rnbo-volume-slider",
      type: "range",
      min: 0,
      max: 158,
      step: 1,
      value: DEFAULT_OUTGAIN,
      ariaLabel: "Volume",
    });

    const volVal = createEl("span", { className: "rnbo-readout rnbo-volreadout", innerText: String(DEFAULT_OUTGAIN) });

    const volumeGroup = createEl("div", { className: "volume-group" }, [
      createEl("span", { className: "rnbo-meta rnbo-voltag", innerText: "VOL" }),
      vol,
      volVal,
    ]);

    headerRowTransport.append(transportLeft, createEl("div", { className: "transport-spacer" }), volumeGroup);

    // --- Row: Progress + Time
    const headerRowProgress = createEl("div", { className: "header-row-progress" });

    const progressTrack = createEl("div", { className: "progress-track" }, [
      createEl("div", { className: "progress-fill" }),
      createEl("div", { className: "progress-handle" }),
    ]);

    const timeRow = createEl("div", { className: "time-row" }, [
      createEl("span", { className: "time-elapsed", innerText: "0:00" }),
      createEl("span", { className: "time-spacer", innerText: "" }),
      createEl("span", { className: "time-remaining", innerText: "-0:00" }),
    ]);

    headerRowProgress.append(progressTrack, timeRow);

    top.append(headerRowTitle, headerRowTransport, headerRowProgress);

    // List
    const list = createEl("div", { className: "rnbo-list" });
    scroll.appendChild(list);

    root.replaceChildren(top, scroll);

    return {
      root,
      top,
      scroll,
      list,
      btnPlay,
      btnStop,
      btnLoop,
      vol,
      volVal,
      statusBadge,
      statusText: statusBadge.querySelector(".status-text"),
      progressTrack,
      progressFill: progressTrack.querySelector(".progress-fill"),
      progressHandle: progressTrack.querySelector(".progress-handle"),
      timeElapsed: timeRow.querySelector(".time-elapsed"),
      timeRemaining: timeRow.querySelector(".time-remaining"),
    };
  }

  // ----------------------------
  // Main init (called by app.js)
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

    // Init params
    try {
      pOutGain.value = DEFAULT_OUTGAIN;
    } catch (_) {}

    // Load manifest
    const manifest = await fetchJSON(MANIFEST_URL);
    const filenames = manifest.items || [];

    // Apply saved order (by filename)
    const saved = loadOrder();
    let ordered = filenames.slice();
    if (Array.isArray(saved) && saved.length) {
      const set = new Set(saved);
      const kept = saved.filter((n) => filenames.includes(n));
      const missing = filenames.filter((n) => !set.has(n));
      ordered = kept.concat(missing);
    }

    // Decode audio + peaks
    const items = [];
    for (let i = 0; i < ordered.length; i++) {
      const name = ordered[i];
      const ab = await fetchArrayBuffer(MEDIA_BASE + name);
      const audioBuffer = await context.decodeAudioData(ab);
      const peaks = buildPeaks(audioBuffer, WAVE_W);

      items.push({
        name,
        audioBuffer,
        peaks,
        durationMs: (audioBuffer.length / audioBuffer.sampleRate) * 1000,
      });
    }

    // State
    let selectedIdx = 0;
    let isLoop = false;
    let playheadMs = 0;
    let lastPlayheadPaint = 0;

    // --- UI wiring
    ui.btnPlay.onclick = () => {
      // Many browsers require user gesture; this is a gesture.
      pulseParam(pPlayTrig);
      ui.statusText.innerText = "Playing";
      ui.btnPlay.classList.add("is-on");
    };

    ui.btnStop.onclick = () => {
      pulseParam(pStopTrig);
      ui.statusText.innerText = "Stopped";
      ui.btnPlay.classList.remove("is-on");
      // Reset progress visuals
      setProgress(0);
    };

    ui.btnLoop.onclick = () => {
      isLoop = !isLoop;
      try {
        pLoop.value = isLoop ? 1 : 0;
      } catch (_) {}
      ui.btnLoop.classList.toggle("is-on", isLoop);
    };

    ui.vol.oninput = () => {
      const v = Number(ui.vol.value);
      ui.volVal.innerText = String(v);
      try {
        pOutGain.value = v;
      } catch (_) {}
    };

    // Rate (optional: if you later add a slider, this is ready)
    function setRate(v) {
      try {
        pRate.value = v;
      } catch (_) {}
    }

    // Progress helpers
    function setProgress(frac01) {
      const f = clamp01(frac01);
      ui.progressFill.style.width = `${f * 100}%`;
      // handle position (visual only)
      ui.progressHandle.style.left = `${f * 100}%`;
    }

    function setTime(elapsedMs, totalMs) {
      ui.timeElapsed.innerText = msToTime(elapsedMs);
      const remaining = Math.max(0, totalMs - elapsedMs);
      ui.timeRemaining.innerText = `-${msToTime(remaining)}`;
    }

    // Seek by clicking progress track
    ui.progressTrack.addEventListener("pointerdown", (e) => {
      const rect = ui.progressTrack.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
      const frac = rect.width > 0 ? x / rect.width : 0;

      // For now: only update UI (actual seeking requires RNBO support)
      setProgress(frac);
    });

    // --- Render list
    const rowEls = []; // store refs for fast class updates

    function setSelected(newIdx) {
      selectedIdx = Math.max(0, Math.min(items.length - 1, newIdx));
      try {
        pClipIndex.value = selectedIdx;
      } catch (_) {}

      // Update row classes
      rowEls.forEach((r, idx) => {
        const on = idx === selectedIdx;
        r.classList.toggle("selected", on);
        r.classList.toggle("is-active", on);
      });

      // Update status badge text (optional)
      ui.statusText.innerText = "Ready";
      ui.btnPlay.classList.remove("is-on");
    }

    function renderList() {
      ui.list.innerHTML = "";
      rowEls.length = 0;

      items.forEach((it, idx) => {
        const indexBadge = createEl("div", { className: "rnbo-index", innerText: pad2(idx + 1) });

        const handle = createEl("button", {
          className: "rnbo-handle",
          type: "button",
          ariaLabel: "Reorder",
          title: "Drag to reorder",
        }, [createEl("span", { innerText: "≡≡" })]);

        const leftStack = createEl("div", { className: "rnbo-left-stack" }, [indexBadge, handle]);

        const title = createEl("div", { className: "rnbo-item-title", innerText: it.name });
        const meta = createEl("div", {
          className: "rnbo-item-meta",
          innerText: `${msToTime(it.durationMs)} • ${Math.round(it.audioBuffer.sampleRate / 100) / 10}kHz`,
        });

        const info = createEl("div", { className: "rnbo-item-info" }, [title, meta]);

        const header = createEl("div", { className: "rnbo-row-header" }, [leftStack, info]);

        const canvas = createEl("canvas", { className: "rnbo-canvas" });
        canvas.width = WAVE_W;
        canvas.height = WAVE_H;

        const waveformWrap = createEl("div", { className: "rnbo-waveform" }, [canvas]);

        const row = createEl("div", {
          className: "rnbo-row" + (idx === selectedIdx ? " selected is-active" : ""),
          draggable: true,
          dataset: { idx: String(idx) },
        }, [header, waveformWrap]);

        // Draw initial waveform (no playhead except active)
        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null);

        // Selection
        row.addEventListener("click", (ev) => {
          // Don’t treat clicking the handle as selection-only; still select, but don’t start accidental drag
          setSelected(idx);
          // Redraw playheads: active shows playhead at current
          redrawWaveforms();
        });

        // Drag reorder (handle-controlled)
        let dragArmed = false;

        handle.addEventListener("pointerdown", (ev) => {
          dragArmed = true;
          handle.setPointerCapture?.(ev.pointerId);
        });

        handle.addEventListener("pointerup", (ev) => {
          dragArmed = false;
          handle.releasePointerCapture?.(ev.pointerId);
        });

        // HTML5 drag events
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

          // Reorder items array
          const moved = items.splice(from, 1)[0];
          items.splice(to, 0, moved);

          // Persist order by filename
          saveOrder(items.map((x) => x.name));

          // Update selected index to follow item identity
          const selectedName = moved.name; // not perfect if moving different row; fix below
          const curName = items[selectedIdx]?.name;

          // Recompute selectedIdx by matching previous selection name
          if (curName) {
            const newSel = items.findIndex((x) => x.name === curName);
            selectedIdx = newSel >= 0 ? newSel : 0;
          } else {
            selectedIdx = 0;
          }

          renderList();
          redrawWaveforms();
        });

        ui.list.appendChild(row);
        rowEls.push(row);
      });
    }

    function redrawWaveforms() {
      const rows = ui.list.querySelectorAll(".rnbo-row");
      rows.forEach((row, idx) => {
        const canvas = row.querySelector("canvas.rnbo-canvas");
        if (!canvas) return;
        const it = items[idx];
        const isActive = idx === selectedIdx;
        const dur = it.durationMs || 1;
        const ph = isActive ? clamp01(playheadMs / dur) : null;
        drawWaveform(canvas, it.peaks, ph);
      });
    }

    // Keyboard shortcuts
    window.addEventListener("keydown", (ev) => {
      if (isTextInputTarget(ev.target)) return;

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setSelected(selectedIdx + 1);
        redrawWaveforms();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setSelected(selectedIdx - 1);
        redrawWaveforms();
      } else if (ev.key === " " || ev.code === "Space") {
        ev.preventDefault();
        pulseParam(pPlayTrig);
        ui.statusText.innerText = "Playing";
        ui.btnPlay.classList.add("is-on");
      } else if (ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        pulseParam(pStopTrig);
        ui.statusText.innerText = "Stopped";
        ui.btnPlay.classList.remove("is-on");
        setProgress(0);
      } else if (ev.key.toLowerCase() === "l") {
        ev.preventDefault();
        ui.btnLoop.click();
      }
    });

    // Playhead port listener (RNBO outport message)
    const port = device.messageEvent ? device : device.node; // safety for different exports
    if (device.messageEvent?.subscribe) {
      device.messageEvent.subscribe((ev) => {
        const tag = ev.tag;
        const payload = ev.payload || [];
        if (tag === "playhead" && payload.length) {
          playheadMs = Number(payload[0]) || 0;

          const now = performance.now();
          if (now - lastPlayheadPaint >= PLAYHEAD_THROTTLE_MS) {
            lastPlayheadPaint = now;

            const it = items[selectedIdx];
            if (it) {
              const dur = it.durationMs || 1;
              const frac = clamp01(playheadMs / dur);
              setProgress(frac);
              setTime(playheadMs, dur);
              redrawWaveforms();
            }
          }
        }
      });
    }

    // Initial render
    renderList();
    setSelected(0);
    redrawWaveforms();
  }

  // Expose for app.js
  window.initPlaylistUI = initPlaylistUI;
})();