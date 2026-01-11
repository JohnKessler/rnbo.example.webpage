// playlist-ui.js
// RNBO Playlist UI — stable core behavior + styled UI
//
// Guarantees:
// - Play ALWAYS starts from 0:00 (forward) or "reverse-assist" if rate < 0.
// - EOF (loop OFF): forward stops at end and resets UI to 0:00.
// - Reverse (loop OFF): stops at 0 and resets UI to 0:00.
// - Loop toggle while playing does NOT stop and does NOT jump.
// - Handles monotonic RNBO playhead by rebasing.
// - Supports header progress seeking when "jumpto" param exists.
//
// Expected RNBO parameters (by id):
//   clipIndex, rate, loop, playTrig, stopTrig, outGain
// Optional RNBO parameter (by id):
//   jumpto  (either ms or normalized 0..1; auto-detected)
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

  // When playhead port is stale, estimate from AudioContext time
  const PORT_FRESH_MS = 120;

  // Reverse-start assist fallback:
  // briefly enable loop when rate < 0 so RNBO can wrap to end and run backwards.
  const REVERSE_LOOP_ASSIST_MS = 90;

  // Grace window after Play where we do NOT treat "rawMs <= 0" as reverse EOF
  // (prevents instant stop at t=0 before RNBO has time to wrap/advance).
  const REVERSE_EOF_GRACE_MS = 250;

  // ----------------------------
  // Helpers
  // ----------------------------
  function clamp01(x) {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
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
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (_) {
      return null;
    }
  }

  function isTextInputTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || t.isContentEditable;
  }

  // Safe element creator (dataset handling)
  function createEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "className") el.className = v;
      else if (k === "innerText") el.innerText = v;
      else if (k === "ariaLabel") el.setAttribute("aria-label", v);
      else if (k.startsWith("data-")) el.setAttribute(k, v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) el.appendChild(c);
    return el;
  }

  function attachHeaderSeparation(scrollEl, topEl) {
    let lastTop = scrollEl.scrollTop || 0;
    let lastT = performance.now();
    let rafPending = false;

    function setSep(intensity01, vel01) {
      const sep = clamp01(intensity01);
      const shadowA = sep * (0.22 + 0.12 * vel01);
      const shadowB = sep * (0.16 + 0.08 * vel01);
      const fadeStart = sep * (0.75 + 0.2 * vel01);

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

      // px/s
      const vel = Math.abs(dy) / (dt / 1000);

      // Map velocity to 0..1 (0–1800px/s is the useful range)
      const vel01 = clamp01(vel / 1800);

      // Presence: only after you’re not at the very top
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

    // Initialize state
    setSep((scrollEl.scrollTop || 0) > 2 ? 1 : 0, 0);
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
      const start = x * spp;
      const end = Math.min(len, start + spp);

      let min = 1;
      let max = -1;
      for (let i = start; i < end; i++) {
        const s = ch0[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      peaks[x * 2 + 0] = min;
      peaks[x * 2 + 1] = max;
    }

    return peaks;
  }

  function drawWaveform(canvas, peaks, playFracOrNull) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Wave
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    ctx.beginPath();
    const mid = h * 0.5;
    const amp = h * 0.42;
    const N = Math.min(peaks.length / 2, w);

    for (let x = 0; x < N; x++) {
      const min = peaks[x * 2 + 0];
      const max = peaks[x * 2 + 1];

      const y1 = mid + min * amp;
      const y2 = mid + max * amp;

      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    // Playhead overlay
    if (playFracOrNull != null) {
      const frac = clamp01(playFracOrNull);
      const px = Math.round(frac * (w - 1));

      // cursor line
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, 0);
      ctx.lineTo(px + 0.5, h);
      ctx.stroke();

      // light fill to left
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, 0, px, h);
      ctx.globalAlpha = 1;
    }
  }

  // ----------------------------
  // UI Build
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

    const statusBadge = createEl("div", { className: "status-badge" }, [
      createEl("span", { className: "status-text", innerText: "Loading" }),
    ]);

    headerRowTitle.append(titleStack, statusBadge);

    const headerRowTransport = createEl("div", { className: "header-row-transport" });

    const btnPlay = createEl("button", { className: "rnbo-btn rnbo-play", innerText: "▶", ariaLabel: "Play" });
    const btnStop = createEl("button", { className: "rnbo-btn rnbo-stop", innerText: "■", ariaLabel: "Stop" });
    const btnLoop = createEl("button", { className: "rnbo-btn rnbo-loop", innerText: "↻", ariaLabel: "Loop" });

    const transportLeft = createEl("div", { className: "transport-left" }, [btnPlay, btnStop, btnLoop]);

    const rate = createEl("input", {
      className: "rnbo-slider rnbo-rate-slider",
      type: "range",
      min: -1,
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

    const vol = createEl("input", {
      className: "rnbo-slider rnbo-volume-slider",
      type: "range",
      min: 0,
      max: 128,
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
      rateGroup,
      volumeGroup
    );

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

    const scroll = createEl("div", { className: "rnbo-scroll" });
    const list = createEl("div", { className: "rnbo-list" });
    scroll.appendChild(list);

    root.append(top, scroll);

    attachHeaderSeparation(scroll, top);

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
    const pJumpTo =
      device.parametersById?.get("jumpto") ||
      (device.parameters || []).find((pp) => pp.id === "jumpto");
    const pLoop = ensureParam(device, "loop");
    const pPlayTrig = ensureParam(device, "playTrig");
    const pStopTrig = ensureParam(device, "stopTrig");
    const pOutGain = ensureParam(device, "outGain");

    async function primeAudio() {
      try {
        if (context && context.state !== "running") {
          await context.resume();
        }
      } catch (_) {}
    }

    function setProgress(frac) {
      const f = clamp01(frac);
      ui.progressFill.style.width = `${(f * 100).toFixed(4)}%`;
      ui.progressHandle.style.left = `${(f * 100).toFixed(4)}%`;
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

    // RNBO playhead raw (monotonic)
    let portPlayheadMs = 0;
    let lastPortAt = 0;

    // Rebase offset applied to port playhead
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
      const r = Number(pRate.value);
      return Number.isFinite(r) ? r : 1;
    }

    function setJumpToMs(targetMs, { startIfNeeded = true } = {}) {
      if (!pJumpTo) return false;
      const it = items[selectedIdx];
      const dur = it?.durationMs || 0;
      const ms = Math.max(0, Math.min(dur > 0 ? dur : targetMs, targetMs));

      // Some RNBO exports leave jumpto at 0..1 even if the patch expects ms.
      // Heuristic: if declared max is ~1, treat jumpto as normalized 0..1.
      const declaredMax = Number(pJumpTo.maximum);
      const useNormalized = Number.isFinite(declaredMax) && declaredMax <= 1.0001;

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
          active && it.durationMs > 0 ? clamp01(displayMs / it.durationMs) : null;
        drawWaveform(canvas, it.peaks, frac);
      });
    }

    function resetUIToStart() {
      displayMs = 0;
      setProgress(0);
      setTime(0, items[selectedIdx]?.durationMs || 0);
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
      const raw =
        now - lastPortAt <= PORT_FRESH_MS
          ? portPlayheadMs
          : anchorRawMs + (context.currentTime - anchorCtxTime) * 1000;

      return raw - portOffsetMs;
    }

    function renderList() {
      ui.list.innerHTML = "";
      rowEls.length = 0;

      items.forEach((it, idx) => {
        const row = createEl("div", { className: "rnbo-row", "data-index": String(idx) });

        const leftStack = createEl("div", { className: "rnbo-left-stack" }, [
          createEl("div", { className: "rnbo-index", innerText: String(idx + 1) }),
          createEl("button", { className: "rnbo-handle", ariaLabel: "Drag" }, [
            createEl("span", { innerText: "DRAG" }),
          ]),
        ]);

        const info = createEl("div", { className: "rnbo-item-info" }, [
          createEl("div", { className: "rnbo-item-title", innerText: it.name }),
          createEl("div", { className: "rnbo-item-meta", innerText: `${msToTime(it.durationMs)} • ${Math.round(it.audioBuffer.sampleRate)} Hz` }),
        ]);

        const header = createEl("div", { className: "rnbo-row-header" }, [leftStack, info]);

        const canvas = createEl("canvas", {
          className: "rnbo-canvas",
          width: WAVE_W,
          height: WAVE_H,
        });

        const waveform = createEl("div", { className: "rnbo-waveform" }, [canvas]);

        row.append(header, waveform);

        // selection
        row.addEventListener("click", (ev) => {
          const t = ev.target;
          if (t && (t.closest?.(".rnbo-handle") || t.classList?.contains("rnbo-handle"))) return;
          setSelected(idx).catch(console.error);
        });

        // drag reorder
        const handle = row.querySelector(".rnbo-handle");
        if (handle) {
          handle.addEventListener("pointerdown", (ev) => {
            ev.preventDefault();
            const from = idx;

            row.classList.add("is-dragging");
            let overIdx = from;

            function findOverIndex(clientY) {
              const rects = rowEls.map((r) => r.getBoundingClientRect());
              let best = from;
              let bestDist = Infinity;
              for (let i = 0; i < rects.length; i++) {
                const mid = (rects[i].top + rects[i].bottom) / 2;
                const d = Math.abs(clientY - mid);
                if (d < bestDist) {
                  bestDist = d;
                  best = i;
                }
              }
              return best;
            }

            function onMove(e) {
              overIdx = findOverIndex(e.clientY);
            }

            function onUp() {
              window.removeEventListener("pointermove", onMove);
              row.classList.remove("is-dragging");

              const to = overIdx;
              if (to !== from) {
                const selectedName = items[selectedIdx]?.name;

                const moved = items.splice(from, 1)[0];
                items.splice(to, 0, moved);

                saveOrder(items.map((x) => x.name));

                const newSel = items.findIndex((x) => x.name === selectedName);
                selectedIdx = newSel >= 0 ? newSel : 0;

                renderList();
                applyRowActiveClasses();
                loadSelectedIntoRNBO().catch(console.error);
                resetUIToStart();
              }
            }

            window.addEventListener("pointermove", onMove, { passive: true });
            window.addEventListener("pointerup", onUp, { passive: true, once: true });
          });
        }

        ui.list.appendChild(row);
        rowEls.push(row);
      });

      // initial draw
      rowEls.forEach((row, idx) => {
        const canvas = row.querySelector("canvas.rnbo-canvas");
        if (!canvas) return;
        drawWaveform(canvas, items[idx].peaks, null);
      });

      applyRowActiveClasses();
    }

    async function loadSelectedIntoRNBO() {
      const it = items[selectedIdx];
      if (!it) return;

      try {
        pClipIndex.value = selectedIdx;
      } catch (_) {}

      // prime UI readouts
      ui.rate.value = String(pRate.value);
      ui.rateVal.innerText = `${Number(pRate.value).toFixed(2)}×`;

      ui.vol.value = String(pOutGain.value);
      ui.volVal.innerText = String(Math.round(Number(pOutGain.value)));

      ui.statusText.innerText = "Ready";
    }

    async function setSelected(idx) {
      selectedIdx = Math.max(0, Math.min(items.length - 1, idx));
      applyRowActiveClasses();

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
      reverseEOFIgnoreUntil =
        getRateNow() < 0 ? performance.now() + REVERSE_EOF_GRACE_MS : 0;

      resetUIToStart();

      isPlayingUI = true;
      ui.btnPlay.classList.add("is-on");
      ui.statusText.innerText = "Playing";

      // Reverse-start assist for negative rate:
      // If rate < 0 and loop is OFF, jump near the end, then play.
      // This avoids the "can’t start unless loop is enabled" behavior on some RNBO patches.
      const rateNow = getRateNow();
      if (rateNow < 0 && !isLoop) {
        const it = items[selectedIdx];
        const dur = it?.durationMs || 0;

        // Prefer jumpto if available
        if (pJumpTo && dur > 0) {
          setJumpToMs(Math.max(0, dur - 1), { startIfNeeded: false });
          pulseParam(pPlayTrig);
          return;
        }

        // Fallback: briefly enable loop internally so RNBO can wrap and run backwards
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

    // ----------------------------
    // Seek via header progress bar (requires jumpto param)
    // ----------------------------
    (function bindSeek() {
      if (!ui.progressTrack) return;

      function seekFromEvent(ev) {
        const it = items[selectedIdx];
        if (!it || it.durationMs <= 0) return;
        const r = ui.progressTrack.getBoundingClientRect();
        const x =
          "clientX" in ev
            ? ev.clientX
            : ev.touches && ev.touches[0]
              ? ev.touches[0].clientX
              : 0;

        const frac = clamp01((x - r.left) / Math.max(1, r.width));
        const ms = frac * it.durationMs;

        // If jumpto exists, use it; otherwise we can only "fake" UI (won't affect audio).
        const ok = setJumpToMs(ms, { startIfNeeded: true });
        if (!ok) {
          didAutoResetAfterEOF = false;
          displayMs = ms;
          paintFromRaw(ms);
        }
      }

      let dragging = false;

      function onDown(ev) {
        dragging = true;
        ev.preventDefault();
        seekFromEvent(ev);
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp, { passive: true, once: true });
      }
      function onMove(ev) {
        if (!dragging) return;
        ev.preventDefault();
        seekFromEvent(ev);
      }
      function onUp() {
        dragging = false;
        window.removeEventListener("pointermove", onMove);
      }

      ui.progressTrack.addEventListener("pointerdown", onDown, { passive: false });
      ui.progressTrack.style.touchAction = "none";
    })();

    // Sliders -> RNBO params
    ui.rate.addEventListener("input", () => {
      const v = Number(ui.rate.value);
      if (!Number.isFinite(v)) return;
      try {
        pRate.value = v;
      } catch (_) {}
      ui.rateVal.innerText = `${v.toFixed(2)}×`;
    });

    ui.vol.addEventListener("input", () => {
      const v = Number(ui.vol.value);
      if (!Number.isFinite(v)) return;
      try {
        pOutGain.value = v;
      } catch (_) {}
      ui.volVal.innerText = String(Math.round(v));
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

        // Update anchor for fallback estimation
        anchorCtxTime = context.currentTime;
        anchorRawMs = v - portOffsetMs;
      });
    }

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
      if (!it) return;

      const dur = it.durationMs || 0;
      if (dur <= 0) return;

      const effective = getEffectiveRaw();

      // EOF handling
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
            const ignore = reverseEOFIgnoreUntil && performance.now() < reverseEOFIgnoreUntil;
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

    // Keyboard shortcuts
    window.addEventListener(
      "keydown",
      (ev) => {
        if (isTextInputTarget(ev.target)) return;
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

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
      },
      { passive: false }
    );

    // Initial render/load
    renderList();
    await loadSelectedIntoRNBO();
    resetUIToStart();
    requestAnimationFrame(tick);
  }

  // Expose global initializer for app.js
  window.initPlaylistUI = initPlaylistUI;
})();