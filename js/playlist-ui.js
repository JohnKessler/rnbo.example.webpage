// playlist-ui.js
// RNBO Playlist UI — external buffer–driven (sample) + reliable reverse loop
// 2026-01-11 — authoritative RNBO Web Audio version

(function () {
  "use strict";

  const MEDIA_BASE = "export/media/";
  const PLAYLIST_JSON = MEDIA_BASE + "playlist.json";
  const BUFFER_ID = "sample";

  let device, context;

  let items = []; // { filename, audioBuffer, durationMs }
  let currentIndex = -1;

  let isPlaying = false;
  let isLoop = false;

  let rate = 1;

  let animationFrameId = null;
  let uiRefs = null; // Store UI references for polling

  // ----------------------------
  // Utilities
  // ----------------------------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const msToTime = (ms) => {
    ms = Math.max(0, Math.floor(ms));
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch ${url}`);
    return r.json();
  }

  async function fetchAndDecode(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to fetch audio ${url}`);
    const ab = await r.arrayBuffer();
    return context.decodeAudioData(ab);
  }

  // ----------------------------
  // Waveform rendering
  // ----------------------------
  function drawWaveform(canvas, audioBuffer) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Get audio data (mono mix if stereo)
    const channelData = audioBuffer.getChannelData(0);
    const samples = channelData.length;
    const samplesPerPixel = Math.floor(samples / width);

    // Draw waveform
    ctx.fillStyle = "#d8d0ee"; // ui-accent color
    const centerY = height / 2;

    for (let x = 0; x < width; x++) {
      const start = x * samplesPerPixel;
      const end = start + samplesPerPixel;

      // Find min/max in this slice
      let min = 0, max = 0;
      for (let i = start; i < end && i < samples; i++) {
        const val = channelData[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      // Draw vertical bar from min to max
      const barTop = centerY + min * centerY;
      const barBottom = centerY + max * centerY;
      const barHeight = Math.max(1, barBottom - barTop);

      ctx.fillRect(x, barTop, 1, barHeight);
    }
  }

  // ----------------------------
  // RNBO helpers
  // ----------------------------
  function param(id) {
    const p =
      device.parametersById?.get(id) ||
      device.parameters?.find((pp) => pp.id === id);
    if (!p) throw new Error(`Missing RNBO param "${id}"`);
    return p;
  }

  function pulse(p) {
    p.value = 1;
    setTimeout(() => (p.value = 0), 20);
  }

  async function loadIntoRNBO(audioBuffer) {
    // RNBO uses setDataBuffer to load audio into external buffers
    // Pass the Float32Array data, number of channels, and sample rate
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;

    // For mono, just use channel 0; for stereo, RNBO expects interleaved or we use channel 0
    const channelData = audioBuffer.getChannelData(0);

    await device.setDataBuffer(BUFFER_ID, channelData, channels, sampleRate);
  }

  // ----------------------------
  // Playhead polling
  // ----------------------------
  function startPlayheadPolling() {
    if (animationFrameId) return; // Already running

    function poll() {
      if (!isPlaying || currentIndex < 0 || !uiRefs) {
        animationFrameId = null;
        return;
      }

      try {
        const playheadMs = param("playhead").value;
        const durationMs = items[currentIndex]?.durationMs || 0;

        // Update elapsed time
        uiRefs.elapsed.textContent = msToTime(playheadMs);

        // Update remaining time
        const remaining = Math.max(0, durationMs - playheadMs);
        uiRefs.remaining.textContent = "-" + msToTime(remaining);

        // Update progress bar
        if (uiRefs.progressFill && durationMs > 0) {
          const percent = clamp((playheadMs / durationMs) * 100, 0, 100);
          uiRefs.progressFill.style.width = percent + "%";
        }

        // Update status
        if (uiRefs.status) {
          uiRefs.status.textContent = "Playing";
        }
      } catch (e) {
        // Silently ignore if param not available
      }

      animationFrameId = requestAnimationFrame(poll);
    }

    animationFrameId = requestAnimationFrame(poll);
  }

  function stopPlayheadPolling() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  // ----------------------------
  // UI build (Penpot component structure)
  // ----------------------------
  function buildUI() {
    const root = document.getElementById("playlist-ui");
    if (!root) throw new Error("Missing #playlist-ui");

    root.innerHTML = `
      <!-- HeaderTransport -->
      <div class="frame header-tran-5d451590b627" id="header">
        <!-- header-row-title -->
        <div class="frame headerrow-5d45f1f235c2">
          <div class="frame titlestac-5d4660f1986f">
            <div class="shape text headertit-5d4698f8b419">
              <span class="text-content">Playlist</span>
            </div>
            <div class="shape text headersub-5d47f17108c6">
              <span class="text-content">RNBO Web Export</span>
            </div>
          </div>
          <div class="frame statusbad-5d4ceb33085c">
            <div class="shape text statustex-5d4e6a28b511">
              <span class="text-content" id="status">Ready</span>
            </div>
          </div>
        </div>

        <!-- header-row-transport -->
        <div class="frame headerrow-5d4f68010508">
          <div class="frame btnplay-5d54f720b486" id="play">
            <div class="shape text icon-5d54f720b487">
              <span class="text-content">▶︎</span>
            </div>
          </div>
          <div class="frame btnstop-5d55fd4d7f07" id="stop">
            <div class="shape text icon-64ca45339d00">
              <span class="text-content">◻️</span>
            </div>
          </div>
          <div class="frame btnloop-5d4fbcbdc95b" id="loop">
            <div class="shape text icon-5d50183b8677">
              <span class="text-content">⥁</span>
            </div>
          </div>
          <div class="shape frame spacer-5d5725171fa6"></div>
          <div class="frame volrategr-674724106f14">
            <div class="frame volumegro-6745cc1efa78">
              <div class="shape text vollabel-6745cc1efa7a">
                <span class="text-content">VOL</span>
              </div>
              <input type="range" class="volslider-6745cc1efa79" id="volume" min="0" max="1" step="0.01" value="0.8">
            </div>
            <div class="frame rategroup-5d578ccde31c">
              <div class="shape text ratelabel-5d57a7a08f21">
                <span class="text-content">Rate</span>
              </div>
              <input type="range" class="rateslide-5d58ab92a121" id="rate" min="-1" max="2" step="0.01" value="1">
            </div>
          </div>
        </div>

        <!-- header-row-progress -->
        <div class="frame headerrow-5d594be7749d">
          <div class="frame progresst-5d597bfabacb" id="progress-track">
            <div class="shape frame progressf-5d5a0fbfc2aa" id="progress-fill"></div>
          </div>
          <div class="frame timerow-5d5b2679cb48">
            <div class="shape text timeelaps-5d5c7e2530fa">
              <span class="text-content" id="elapsed">0:00</span>
            </div>
            <div class="shape frame timespace-5d5c1a16b26f"></div>
            <div class="shape text timeremai-5d5b574c9622">
              <span class="text-content" id="remaining">-0:00</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Playlist container -->
      <div id="list" class="playlist-scroll"></div>
    `;

    return {
      play: root.querySelector("#play"),
      stop: root.querySelector("#stop"),
      loop: root.querySelector("#loop"),
      rate: root.querySelector("#rate"),
      volume: root.querySelector("#volume"),
      elapsed: root.querySelector("#elapsed"),
      remaining: root.querySelector("#remaining"),
      status: root.querySelector("#status"),
      progressTrack: root.querySelector("#progress-track"),
      progressFill: root.querySelector("#progress-fill"),
      list: root.querySelector("#list"),
    };
  }

  // ----------------------------
  // Playback control
  // ----------------------------
  async function selectIndex(i) {
    if (!items[i]) return;

    currentIndex = i;
    const it = items[i];

    await loadIntoRNBO(it.audioBuffer);

    // Always reset playhead on load
    const jump = param("jumpto");
    jump.value = rate < 0 ? it.durationMs - 1 : 0;

    // Update time display for selected track
    if (uiRefs) {
      uiRefs.elapsed.textContent = "0:00";
      uiRefs.remaining.textContent = "-" + msToTime(it.durationMs);

      // Reset progress bar
      if (uiRefs.progressFill) {
        uiRefs.progressFill.style.width = "0%";
      }

      // Update status
      if (uiRefs.status) {
        uiRefs.status.textContent = "Ready";
      }
    }

    // Update active item highlighting
    updateActiveItem(i);
  }

  function play() {
    if (currentIndex < 0) return;

    const it = items[currentIndex];
    const jump = param("jumpto");

    // CRITICAL: reverse must start at END
    // Set jump position first
    if (rate < 0) {
      jump.value = it.durationMs - 10; // Slightly before end to ensure playback starts
    } else {
      jump.value = 0;
    }

    // Small delay to ensure jump is processed before play trigger
    setTimeout(() => {
      pulse(param("playTrig"));
      isPlaying = true;
      startPlayheadPolling();
    }, 10);
  }

  function stop() {
    pulse(param("stopTrig"));
    isPlaying = false;
    stopPlayheadPolling();

    // Reset time display and progress
    if (uiRefs) {
      uiRefs.elapsed.textContent = "0:00";
      const durationMs = items[currentIndex]?.durationMs || 0;
      uiRefs.remaining.textContent = "-" + msToTime(durationMs);

      // Reset progress bar
      if (uiRefs.progressFill) {
        uiRefs.progressFill.style.width = "0%";
      }

      // Update status
      if (uiRefs.status) {
        uiRefs.status.textContent = "Stopped";
      }
    }
  }

  // Update active item highlighting
  function updateActiveItem(index) {
    if (!uiRefs || !uiRefs.list) return;

    // Remove active class from all items
    uiRefs.list.querySelectorAll(".playlist-it-5d3648fdeb2a").forEach((el) => {
      el.classList.remove("is-active");
    });

    // Add active class to selected item
    const activeEl = uiRefs.list.querySelector(`[data-i="${index}"]`);
    if (activeEl) {
      activeEl.classList.add("is-active");
    }
  }

  // ----------------------------
  // Init
  // ----------------------------
  window.initPlaylistUI = async function (rnboDevice, rnboContext) {
    device = rnboDevice;
    context = rnboContext;

    const ui = buildUI();
    uiRefs = ui; // Store for playhead polling

    // Bind params
    const pRate = param("rate");
    const pLoop = param("loop");
    const pOut = param("outGain");

    ui.rate.addEventListener("input", () => {
      const prevRate = rate;
      rate = Number(ui.rate.value);
      pRate.value = rate;

      // If switching direction while playing, jump to appropriate end
      if (isPlaying && currentIndex >= 0) {
        const it = items[currentIndex];
        // Switching from forward to reverse
        if (prevRate >= 0 && rate < 0) {
          param("jumpto").value = it.durationMs - 10;
        }
        // Switching from reverse to forward
        else if (prevRate < 0 && rate >= 0) {
          param("jumpto").value = 10;
        }
      }
    });

    ui.play.onclick = () => {
      // Dispatch gesture event to resume audio context
      window.dispatchEvent(new Event("rnbo:gesture"));
      play();
    };
    ui.stop.onclick = () => {
      window.dispatchEvent(new Event("rnbo:gesture"));
      stop();
    };
    ui.loop.onclick = () => {
      window.dispatchEvent(new Event("rnbo:gesture"));
      isLoop = !isLoop;
      pLoop.value = isLoop ? 1 : 0;
      ui.loop.classList.toggle("is-on", isLoop);
    };

    // Volume slider
    if (ui.volume) {
      ui.volume.addEventListener("input", () => {
        const vol = Number(ui.volume.value);
        // Map 0-1 to outGain range (assuming 0-158 based on earlier info)
        pOut.value = vol * 158;
      });
      // Set initial volume
      pOut.value = Number(ui.volume.value) * 158;
    }

    // Load playlist
    const playlist = await fetchJSON(PLAYLIST_JSON);

    for (const filename of playlist.items) {
      const audioBuffer = await fetchAndDecode(MEDIA_BASE + filename);
      items.push({
        filename,
        audioBuffer,
        durationMs:
          (audioBuffer.length / audioBuffer.sampleRate) * 1000,
      });
    }

    // Render list with Penpot structure
    ui.list.innerHTML = items
      .map((it, i) => {
        const indexStr = String(i + 1).padStart(2, "0");
        const sampleRate = (it.audioBuffer.sampleRate / 1000).toFixed(1) + "kHz";
        return `
        <div class="frame playlist-it-5d3648fdeb2a" data-i="${i}">
          <div class="frame rnboleft-610067288a8f">
            <div class="shape text rnbodrag-5d392d0942d4">
              <span class="text-content">≡</span>
            </div>
            <div class="frame rnboindex-68bf9c1cef83">
              <div class="shape text c-01-5d3745f8a4a4">
                <span class="text-content">${indexStr}</span>
              </div>
              <div class="shape rect rectangle-5d370bd3a750"></div>
            </div>
          </div>
          <div class="frame rnboitem-5d382f157a40">
            <div class="shape text rnboitem-5d387d641a23">
              <span class="text-content">${it.filename.replace(/\.[^/.]+$/, "")}</span>
            </div>
            <div class="shape text rnboitem-5d38e411bd37">
              <span class="text-content">${msToTime(it.durationMs)} • ${sampleRate}</span>
            </div>
            <div class="frame rnbowavef-60fd0a1350ed">
              <canvas class="waveform-canvas waveformp-60fe06159afb" data-waveform="${i}" width="400" height="30"></canvas>
            </div>
          </div>
        </div>`;
      })
      .join("");

    // Draw waveforms after rendering
    items.forEach((it, i) => {
      const canvas = ui.list.querySelector(`canvas[data-waveform="${i}"]`);
      if (canvas) {
        drawWaveform(canvas, it.audioBuffer);
      }
    });

    ui.list.querySelectorAll("[data-i]").forEach((el) => {
      el.onclick = async () => {
        window.dispatchEvent(new Event("rnbo:gesture"));
        await selectIndex(Number(el.dataset.i));
        play();
      };
    });

    // Auto-select first item
    await selectIndex(0);
  };
})();