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
    await device.setExternalData(BUFFER_ID, audioBuffer);
  }

  // ----------------------------
  // UI build (minimal, style via reference CSS)
  // ----------------------------
  function buildUI() {
    const root = document.getElementById("playlist-ui");
    if (!root) throw new Error("Missing #playlist-ui");

    root.innerHTML = `
      <div class="header-tran-5d451590b627">
        <div class="headerrow-5d4f68010508">
          <button id="play">▶</button>
          <button id="stop">■</button>
          <button id="loop">⟲</button>
        </div>

        <div class="timerow-5d5b2679cb48">
          <span id="elapsed">0:00</span>
          <span id="remaining">-0:00</span>
        </div>

        <input id="rate" type="range" min="-1" max="2" step="0.01" value="1">
      </div>

      <div id="list"></div>
    `;

    return {
      play: root.querySelector("#play"),
      stop: root.querySelector("#stop"),
      loop: root.querySelector("#loop"),
      rate: root.querySelector("#rate"),
      elapsed: root.querySelector("#elapsed"),
      remaining: root.querySelector("#remaining"),
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
  }

  function play() {
    if (currentIndex < 0) return;

    const it = items[currentIndex];
    const jump = param("jumpto");

    // CRITICAL: reverse must start at END
    if (rate < 0) jump.value = it.durationMs - 1;
    else jump.value = 0;

    pulse(param("playTrig"));
    isPlaying = true;
  }

  function stop() {
    pulse(param("stopTrig"));
    isPlaying = false;
  }

  // ----------------------------
  // Init
  // ----------------------------
  window.initPlaylistUI = async function (rnboDevice, rnboContext) {
    device = rnboDevice;
    context = rnboContext;

    const ui = buildUI();

    // Bind params
    const pRate = param("rate");
    const pLoop = param("loop");
    const pOut = param("outGain");

    ui.rate.addEventListener("input", () => {
      rate = Number(ui.rate.value);
      pRate.value = rate;

      // If reversing while playing, jump immediately
      if (isPlaying && currentIndex >= 0 && rate < 0) {
        const it = items[currentIndex];
        param("jumpto").value = it.durationMs - 1;
      }
    });

    ui.play.onclick = play;
    ui.stop.onclick = stop;
    ui.loop.onclick = () => {
      isLoop = !isLoop;
      pLoop.value = isLoop ? 1 : 0;
    };

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

    // Render list
    ui.list.innerHTML = items
      .map(
        (it, i) => `
        <div class="playlist-it-5d3648fdeb2a" data-i="${i}">
          ${it.filename}
        </div>`
      )
      .join("");

    ui.list.querySelectorAll("[data-i]").forEach((el) => {
      el.onclick = async () => {
        await selectIndex(Number(el.dataset.i));
        play();
      };
    });

    // Auto-select first item
    await selectIndex(0);
  };
})();