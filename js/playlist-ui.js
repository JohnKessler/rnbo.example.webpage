// playlist-ui.js
// RNBO Playlist UI — restore stable core behavior + keep styled UI
//
// Behavior guarantees (what you asked for):
// - Play ALWAYS starts from beginning (0:00), even after EOF or Stop.
// - At EOF (loop OFF) UI auto-resets to 0:00 (does not hang at end).
// - Loop toggle while playing does NOT stop, does NOT jump to end.
// - If RNBO playhead is monotonic (keeps counting through loops), UI rebases it.
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Expected RNBO external buffer name:
//   "sample"
// Expected outport message tag (optional):
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

  const UI_THROTTLE_MS = 16;

  // Preload fade timing
  const PRELOAD_FADE_DELAY_MS = 900;
  const PRELOAD_FADE_DURATION_MS = 600;

  // End detection slack (ms)
  const END_EPS_MS = 15;

  // When playhead port is stale, we can optionally estimate from AudioContext time
  const PORT_FRESH_MS = 120;

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

  // Minimal inline SVG icons
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
  const ICON_LOOP =
    "M17 1l4 4-4 4V6H7a4 4 0 000 8h1v2H7a6 6 0 010-12h10V1zm-6 14v3l-4-4 4-4v3h6a4 4 0 000-8h-1V3h1a6 6 0 010 12h-6z";

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

    // Title + status + preload
    const headerRowTitle = createEl("div", { className: "header-row-title" });
    const titleStack = createEl("div", { className: "title-stack" }, [
      createEl("div", { className: "rnbo-title", innerText: "Playlist" }),
      createEl("div", { className: "rnbo-meta", innerText: "RNBO Web Export" }),
      createEl("div", { className: "rnbo-preload", innerText: "Preload: 0%" }),
    ]);
    const statusBadge = createEl("div", { className: "status-badge" }, [
      createEl("span", { className: "status-text", innerText: "Ready" }),
    ]);
    headerRowTitle.append(titleStack, statusBadge);

    // Transport row
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

    // Rate group
    const rate = createEl("input", {
      className: "rnbo-slider rnbo-rate-slider",
      type: "range",
      min: 0.25,
      max: 2,
      step: 0.01,
      value: 1,
      ariaLabel: "Rate",
    });
    const rateVal = createEl("span", { className: "rnbo-readout rnbo-ratereadout", innerText: "1.00×" });
    const rateGroup = createEl("div", { className: "rate-group" }, [
      createEl("span", { className: "rnbo-meta rnbo-ratetag", innerText: "RATE" }),
      rate,
      rateVal,
    ]);

    // Volume group
    const vol = createEl("input", {
      className: "rnbo-slider rnbo-volume-slider",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      value: 1,
      ariaLabel: "Volume",
    });
    const volVal = createEl("span", { className: "rnbo-readout rnbo-volreadout", innerText: "—" });
    const volumeGroup = createEl("div", { className: "volume-group" }, [
      createEl("span", { className: "rnbo-meta rnbo-voltag", innerText: "VOL" }),
      vol,
      volVal,
    ]);

    headerRowTransport.append(
      transportLeft,
      createEl("div", { className: "transport-spacer" }),
      rateGroup,
      volumeGroup
    );

    // Progress + time row
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
      rate,
      rateVal,
      vol,
      volVal,
      preloadText: titleStack.querySelector(".rnbo-preload"),
      statusText: statusBadge.querySelector(".status-text"),
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

    // Prime audio on gesture
    async function primeAudio() {
      try {
        if (context && context.state !== "running") await context.resume();
      } catch (_) {}
    }

    ["pointerdown", "click"].forEach((evt) => {
      ui.btnPlay.addEventListener(evt, primeAudio, { passive: true });
      ui.btnStop.addEventListener(evt, primeAudio, { passive: true });
      ui.btnLoop.addEventListener(evt, primeAudio, { passive: true });
      ui.rate.addEventListener(evt, primeAudio, { passive: true });
      ui.vol.addEventListener(evt, primeAudio, { passive: true });
    });

    // Bind RATE (auto range)
    {
      const rateMin = Number.isFinite(pRate.min) ? pRate.min : 0.25;
      const rateMax = Number.isFinite(pRate.max) ? pRate.max : 2.0;
      const rateSteps = Number.isFinite(pRate.steps) ? pRate.steps : 0;

      ui.rate.min = String(rateMin);
      ui.rate.max = String(rateMax);
      ui.rate.step =
        rateSteps && rateSteps > 1
          ? String((rateMax - rateMin) / (rateSteps - 1))
          : String((rateMax - rateMin) / 1000);

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
        outSteps && outSteps > 1
          ? String((outMax - outMin) / (outSteps - 1))
          : String((outMax - outMin) / 1000);

      const initialOut = Number.isFinite(pOutGain.value)
        ? pOutGain.value
        : (outMin + outMax) * 0.75;

      ui.vol.value = String(initialOut);
      ui.volVal.innerText = String(Math.round(initialOut * 1000) / 1000);

      ui.vol.addEventListener("input", () => {
        const v = Number(ui.vol.value);
        pOutGain.value = v;
        ui.volVal.innerText = String(Math.round(v * 1000) / 1000);
      });
    }

    // UI helpers
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

    // Decode + peaks (with preload %)
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
    // State (this is where the old “good behavior” lives)
    // ----------------------------
    let selectedIdx = 0;
    let isLoop = false;

    // “UI playing” flag (used for play semantics + fallback ticking)
    let isPlayingUI = false;

    // RNBO playhead raw (monotonic in your patch)
    let portPlayheadMs = 0;
    let lastPortAt = 0;

    // A rebase offset applied to port playhead so UI behaves on loop toggles
    // effectiveRaw = portPlayheadMs - portOffsetMs
    let portOffsetMs = 0;

    // Fallback anchor (if port stalls)
    let anchorCtxTime = 0;
    let anchorRawMs = 0;

    // Displayed playhead (after loop wrap / clamp)
    let displayMs = 0;

    // Finish/EOF bookkeeping
    let didAutoResetAfterEOF = false;

    // ----------------------------
    // Playlist rows
    // ----------------------------
    const rowEls = [];

    function applyRowActiveClasses() {
      rowEls.forEach((r, idx) => {
        const on = idx === selectedIdx;
        r.classList.toggle("selected", on);
        r.classList.toggle("is-active", on);
      });
    }

    function redrawWaveforms() {
      rowEls.forEach((row, idx) => {
        const canvas = row.querySelector("canvas.rnbo-canvas");
        if (!canvas) return;
        const it = items[idx];
        const active = idx === selectedIdx;
        const frac =
          active && it.durationMs > 0
            ? clamp01(displayMs / it.durationMs)
            : null;
        drawWaveform(canvas, it.peaks, frac);
      });
    }

    async function loadSelectedIntoRNBO() {
      const it = items[selectedIdx];
      if (!it) return;
      await device.setDataBuffer("sample", it.audioBuffer);
      pClipIndex.value = selectedIdx;
    }

    function resetUIToStart() {
      displayMs = 0;
      setProgress(0);
      setTime(0, items[selectedIdx]?.durationMs || 0);
      redrawWaveforms();
      didAutoResetAfterEOF = true;
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

      if (rawMs >= totalMs - END_EPS_MS) {
        return { display: totalMs, eof: true };
      }

      return { display: rawMs, eof: false };
    }

    function paintFromRaw(rawMs) {
      const it = items[selectedIdx];
      if (!it) return;

      const norm = normalizeForDisplay(rawMs, it.durationMs);
      displayMs = norm.display;

      // EOF handling (loop OFF):
      // Instead of hanging at the end, auto-reset to 0:00.
      if (norm.eof && !isLoop) {
        if (isPlayingUI) {
          isPlayingUI = false;
          ui.btnPlay.classList.remove("is-on");
          ui.statusText.innerText = "Ready";
        }

        // Send stop once to keep device sane, then reset UI to 0
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
    // Render list
    // ----------------------------
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

        drawWaveform(canvas, it.peaks, idx === selectedIdx ? 0 : null);

        row.addEventListener("click", () => setSelected(idx));

        // Drag reorder (arm drag only from handle)
        let dragArmed = false;

        handle.addEventListener("pointerdown", (ev) => {
          dragArmed = true;
          handle.setPointerCapture?.(ev.pointerId);
        });

        handle.addEventListener("pointerup", (ev) => {
          dragArmed = false;
          handle.releasePointerCapture?.(ev.pointerId);
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

          const selectedName = items[selectedIdx]?.name;

          const moved = items.splice(from, 1)[0];
          items.splice(to, 0, moved);

          saveOrder(items.map((x) => x.name));

          const newSel = items.findIndex((x) => x.name === selectedName);
          selectedIdx = newSel >= 0 ? newSel : 0;

          renderList();
          applyRowActiveClasses();
          loadSelectedIntoRNBO().catch(console.error);

          // Re-sync UI after reorder
          resetUIToStart();
        });

        ui.list.appendChild(row);
        rowEls.push(row);
      });

      applyRowActiveClasses();
    }

    async function setSelected(idx) {
      selectedIdx = Math.max(0, Math.min(items.length - 1, idx));
      applyRowActiveClasses();

      // Selection should not require stop to be playable again.
      isPlayingUI = false;
      ui.btnPlay.classList.remove("is-on");
      ui.statusText.innerText = "Ready";

      // Reset all timing/bookkeeping
      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;
      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;
      didAutoResetAfterEOF = false;

      await loadSelectedIntoRNBO();
      resetUIToStart();
    }

    // ----------------------------
    // Transport semantics (the important part)
    // ----------------------------
    async function playFromBeginning() {
      await primeAudio();

      // Always start from 0:00 no matter what happened before.
      // Stop first (cheap + reliable) then play.
      pulseParam(pStopTrig);

      // Reset our timeline right now
      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;
      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;
      didAutoResetAfterEOF = false;

      // UI immediately shows 0:00
      resetUIToStart();

      // Trigger play
      isPlayingUI = true;
      ui.btnPlay.classList.add("is-on");
      ui.statusText.innerText = "Playing";

      pulseParam(pPlayTrig);
    }

    function stopNow() {
      pulseParam(pStopTrig);

      isPlayingUI = false;
      ui.btnPlay.classList.remove("is-on");
      ui.statusText.innerText = "Ready";

      // Reset UI/timing to start
      portPlayheadMs = 0;
      lastPortAt = 0;
      portOffsetMs = 0;
      anchorCtxTime = context.currentTime;
      anchorRawMs = 0;
      didAutoResetAfterEOF = false;

      resetUIToStart();
    }

    ui.btnPlay.addEventListener("click", () => {
      playFromBeginning().catch(console.error);
    });

    ui.btnStop.addEventListener("click", () => {
      stopNow();
    });

    ui.btnLoop.addEventListener("click", () => {
      // Toggle loop without stopping playback or jumping.
      const wasLoop = isLoop;
      isLoop = !isLoop;

      try { pLoop.value = isLoop ? 1 : 0; } catch (_) {}
      ui.btnLoop.classList.toggle("is-on", isLoop);

      // If we are turning LOOP OFF while RNBO playhead is monotonic,
      // we must "rebase" the effective raw time so UI doesn't instantly jump to EOF.
      if (wasLoop && !isLoop) {
        // current displayMs is the modulo position; keep continuity by making that the new raw origin.
        const nowPortRaw = portPlayheadMs;
        const desiredEffective = displayMs; // keep where we are
        portOffsetMs = nowPortRaw - desiredEffective;

        // also reset fallback anchor from "now"
        anchorCtxTime = context.currentTime;
        anchorRawMs = desiredEffective;

        // And repaint immediately
        paintFromRaw(desiredEffective);
        return;
      }

      // Turning LOOP ON can use modulo display; just repaint
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
    // Playhead input (RNBO outport) + fallback
    // ----------------------------
    function getEffectiveRaw() {
      // effective raw is monotonic port time minus our offset
      const effective = portPlayheadMs - portOffsetMs;
      return Number.isFinite(effective) ? effective : 0;
    }

    // RNBO playhead messages (optional)
    if (device.messageEvent?.subscribe) {
      device.messageEvent.subscribe((ev) => {
        if (ev.tag !== "playhead") return;
        const payload = ev.payload || [];
        const v = Number(payload[0]);
        if (!Number.isFinite(v)) return;

        portPlayheadMs = v;
        lastPortAt = performance.now();

        // Keep fallback anchor synced to effective time so it can take over smoothly if port stalls
        anchorCtxTime = context.currentTime;
        anchorRawMs = getEffectiveRaw();
      });
    }

    // UI tick loop
    let lastPaintAt = 0;

    function tick() {
      const now = performance.now();

      // If playing and port is stale, estimate raw time from AudioContext.
      if (isPlayingUI) {
        const portFresh = (now - lastPortAt) < PORT_FRESH_MS;

        if (!portFresh) {
          const elapsedSec = Math.max(0, context.currentTime - anchorCtxTime);
          const rateNow = Number(pRate.value) || 1;
          const estRaw = anchorRawMs + elapsedSec * 1000 * rateNow;

          // When estimating, we pretend it’s the “effective raw”
          // (so it continues smoothly after a loop toggle rebase)
          paintFromRaw(estRaw);
        } else {
          paintFromRaw(getEffectiveRaw());
        }
      } else {
        // Not playing: keep UI at start (especially after EOF auto-reset)
        if (!didAutoResetAfterEOF) {
          paintFromRaw(0);
        }
      }

      if (now - lastPaintAt >= UI_THROTTLE_MS) {
        lastPaintAt = now;
      }

      requestAnimationFrame(tick);
    }

    // ----------------------------
    // Init render
    // ----------------------------
    renderList();
    await setSelected(0);
    requestAnimationFrame(tick);
  }

  window.initPlaylistUI = initPlaylistUI;
})();