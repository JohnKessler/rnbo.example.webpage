// playlist-ui.js
// RNBO Playlist UI (Web Export) — Refactored for direct reference CSS + robust reverse playback

(function () {
    "use strict";

    // ----------------------------
    // Config & Utility
    // ----------------------------
    const LOOP = 1, NO_LOOP = 0;
    let device, context;
    let clips = []; // Assume playlist gets loaded elsewhere

    // Helper to clamp a value
    function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

    // ----------------------------
    // Reference Classes (from your CSS)
    // ----------------------------
    const HEADER_CLASS = "header-tran-5d451590b627";
    const HEADER_BTN_GROUP = "header-tran-btnrow-5d451590b627";
    const BTN_ICON = "header-tran-iconbtn-5d451590b627";
    const BTN_ICON_CIRCLE = "header-tran-iconbtncirc-5d451590b627";
    const TRANSPORT_BTN = "header-tran-btn-5d451590b627";
    const TIME_ROW = "header-tran-timerow-5d451590b627";
    const PROGRESS_ROW = "header-tran-progressrow-5d451590b627";
    const PROGRESS = "header-tran-progress-5d451590b627";

    const PLAYLIST_CONTAINER = "playlist-it-5d3648fdeb2a";
    const PLAYLIST_ROW = "playlist-it-row-5d3648fdeb2a";
    const PLAYLIST_INDEX = "playlist-it-index-5d3648fdeb2a";
    const PLAYLIST_WAVEFORM = "playlist-it-waveform-5d3648fdeb2a";
    const PLAYLIST_META = "playlist-it-meta-5d3648fdeb2a";
    const PLAYLIST_TITLE = "playlist-it-title-5d3648fdeb2a";

    // ----------------------------
    // Main UI Initialization
    // ----------------------------
    window.initPlaylistUI = function (rnboDevice, rnboContext) {
        device = rnboDevice;
        context = rnboContext;

        // Render Header/Transport UI
        renderHeaderTransport();

        // Render Playlist Items
        renderPlaylist();

        // Bind control events (rate, play, stop, loop, volume, etc.)
        setupTransportEvents();
    };

    // ----------------------------
    // Header Transport (Reference CSS)
    // ----------------------------
    function renderHeaderTransport() {
        const content = document.getElementById('rnbo-content');
        if (!content) return;

        // Build header/transport bar with reference CSS classes
        content.innerHTML = `
        <div class="${HEADER_CLASS}">
            <div class="${HEADER_BTN_GROUP}">
                <button id="play-btn" class="${BTN_ICON} ${BTN_ICON_CIRCLE}">
                    <span class="material-icons">play_arrow</span>
                </button>
                <button id="stop-btn" class="${BTN_ICON} ${BTN_ICON_CIRCLE}">
                    <span class="material-icons">stop</span>
                </button>
                <button id="loop-btn" class="${BTN_ICON} ${BTN_ICON_CIRCLE}">
                    <span class="material-icons">repeat</span>
                </button>
            </div>
            <div class="${TIME_ROW}">
                <span id="transport-current">00:00.0</span>
                <span>/</span>
                <span id="transport-total">00:00.0</span>
            </div>
            <div class="${PROGRESS_ROW}">
                <input id="transport-progress" class="${PROGRESS}" type="range" min="0" max="100" value="0" step="0.1">
            </div>
            <div class="header-tran-paramrow-5d451590b627">
                <label>Rate
                    <input id="rate-slider" type="range" min="-1" max="2" value="1" step="0.01">
                </label>
                <label>Gain
                    <input id="gain-slider" type="range" min="0" max="158" value="120" step="1">
                </label>
            </div>
        </div>
        <div class="${PLAYLIST_CONTAINER}" id="playlist-container"></div>
        `;
    }

    // ----------------------------
    // Playlist Items (Reference CSS)
    // ----------------------------
    function renderPlaylist() {
        const container = document.getElementById('playlist-container');
        if (!container) return;

        // For demo, make 4 fake clips
        if (!clips.length) {
            clips = [
                { title: "Clip 1", duration: 30000 },
                { title: "Clip 2", duration: 25000 },
                { title: "Clip 3", duration: 37000 },
                { title: "Clip 4", duration: 18000 }
            ];
        }

        // Render all clips
        container.innerHTML = clips.map((clip, i) => `
            <div class="${PLAYLIST_ROW}" data-index="${i}">
                <div class="${PLAYLIST_INDEX}">${i + 1}</div>
                <div class="${PLAYLIST_WAVEFORM}">[Waveform]</div>
                <div class="${PLAYLIST_META}">
                    <span class="${PLAYLIST_TITLE}">${clip.title}</span>
                    <span>${msToTime(clip.duration)}</span>
                </div>
            </div>
        `).join('');
    }

    // ----------------------------
    // Transport Control/Playback Logic
    // ----------------------------
    let isPlaying = false;
    let currentClip = 0;
    let loopMode = NO_LOOP;
    let rate = 1;
    let playbackTimer = null;

    function setupTransportEvents() {
        // Play button
        document.getElementById('play-btn').onclick = () => playClip();
        // Stop button
        document.getElementById('stop-btn').onclick = () => stopClip();
        // Loop button
        document.getElementById('loop-btn').onclick = () => {
            loopMode = (loopMode === NO_LOOP) ? LOOP : NO_LOOP;
            device.parametersById.loop.value = loopMode;
        };
        // Rate slider
        document.getElementById('rate-slider').oninput = e => {
            rate = parseFloat(e.target.value);
            device.parametersById.rate.value = rate;
            // If negative rate and playing, instantly jump playhead to end of loop/clip
            if (isPlaying && rate < 0) {
                seekPlayheadToClipEdge('end');
            }
        };
        // Gain slider
        document.getElementById('gain-slider').oninput = e => {
            device.parametersById.outGain.value = parseFloat(e.target.value);
        };

        // Click playlist row to select and play
        document.querySelectorAll(`.${PLAYLIST_ROW}`).forEach(row => {
            row.onclick = () => {
                currentClip = parseInt(row.dataset.index, 10);
                playClip();
            };
        });
    }

    function playClip() {
        const clip = clips[currentClip];
        if (!clip) return;

        // Always jump playhead to start for fwd, end for reverse before play
        if (rate >= 0) {
            seekPlayheadToClipEdge('start');
        } else {
            seekPlayheadToClipEdge('end');
        }

        // Actually trigger play
        device.parametersById.clipIndex.value = currentClip;
        device.parametersById.playTrig.value = 1;
        isPlaying = true;

        // Start UI/playhead timer
        startPlaybackTimer();
    }

    function stopClip() {
        device.parametersById.stopTrig.value = 1;
        isPlaying = false;
        stopPlaybackTimer();
    }

    function seekPlayheadToClipEdge(edge) {
        const clip = clips[currentClip];
        if (!clip) return;
        let ms = (edge === 'start') ? 0 : clip.duration;
        device.parametersById.jumpto.value = clamp(ms, 0, 600000);
    }

    // Simulated playback timer for UI (substitute for RNBO playhead callback)
    function startPlaybackTimer() {
        stopPlaybackTimer();
        let position = (rate >= 0) ? 0 : clips[currentClip].duration;
        updateTransportUI(position);

        playbackTimer = setInterval(() => {
            if (!isPlaying) { stopPlaybackTimer(); return; }
            position += rate * 40;
            if (rate >= 0 && position >= clips[currentClip].duration) {
                if (loopMode === LOOP) {
                    position = 0;
                    seekPlayheadToClipEdge('start');
                } else {
                    stopClip();
                }
            } else if (rate < 0 && position <= 0) {
                if (loopMode === LOOP) {
                    position = clips[currentClip].duration;
                    seekPlayheadToClipEdge('end');
                } else {
                    stopClip();
                }
            }
            updateTransportUI(position);
        }, 40);
    }

    function stopPlaybackTimer() {
        if (playbackTimer) clearInterval(playbackTimer);
        playbackTimer = null;
    }

    function updateTransportUI(position) {
        document.getElementById('transport-current').innerText = msToTime(position);
        document.getElementById('transport-total').innerText = msToTime(clips[currentClip].duration);
        document.getElementById('transport-progress').value =
            (clips[currentClip].duration ? 100 * position / clips[currentClip].duration : 0);
    }

    function msToTime(ms) {
        ms = Math.max(0, ms | 0);
        const min = Math.floor(ms / 60000);
        const sec = ((ms % 60000) / 1000).toFixed(1);
        return `${min}:${sec.padStart(4, '0')}`;
    }

    // Expose for debug
    window._playlistUI = {
        playClip,
        stopClip,
        seekPlayheadToClipEdge
    };

})();