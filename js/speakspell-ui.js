// speakspell-ui.js
// Speak & Spell Sampler UI - Retro 1978 Aesthetic
// Interactive waveforms, keyboard shortcuts, mobile-first

(function () {
    "use strict";

    // ---------- Constants ----------
    const MEDIA_BASE = "export/media/";
    const PLAYLIST_JSON = MEDIA_BASE + "playlist.json";
    const BUFFER_ID = "sample";

    // ---------- State ----------
    let device, context;
    let items = []; // { filename, audioBuffer, durationMs }
    let currentIndex = -1;
    let isPlaying = false;
    let isLoop = false;
    let rate = 1;
    let animationFrameId = null;
    let playheadMs = 0; // Received from RNBO outport
    let isInitialized = false; // Prevents auto-play during load

    // Spectrum analyzer state
    let analyser = null;
    let analyserData = null;
    let spectrumAnimationId = null;

    // Drag-and-drop state
    let dragState = {
        isDragging: false,
        dragIndex: -1,
        dragElement: null,
        ghostElement: null,
        startY: 0,
        currentY: 0
    };

    // ---------- DOM References ----------
    let ui = {};

    // ---------- Utilities ----------
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

    // ---------- RNBO Helpers ----------
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
        const channels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const channelData = audioBuffer.getChannelData(0);
        await device.setDataBuffer(BUFFER_ID, channelData, channels, sampleRate);
    }

    // ---------- Waveform Rendering ----------
    function drawWaveform(canvas, audioBuffer, options = {}) {
        const ctx = canvas.getContext("2d");
        const { playedRatio = 0, isMain = false, logicalWidth = 0, logicalHeight = 0 } = options;

        // Use logical dimensions if provided (for high-DPI main waveform), otherwise use canvas dimensions
        const width = logicalWidth || canvas.width;
        const height = logicalHeight || canvas.height;

        // Clear using actual canvas dimensions
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Get audio data
        const channelData = audioBuffer.getChannelData(0);
        const samples = channelData.length;
        const samplesPerPixel = Math.floor(samples / width);

        const centerY = height / 2;

        // Colors
        const playedColor = "#00F5D4"; // VFD glow
        const unplayedColor = "#1A5C52"; // VFD dim

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

            // Determine color based on playhead position
            const ratio = x / width;
            ctx.fillStyle = ratio < playedRatio ? playedColor : unplayedColor;

            // Draw vertical bar
            const barTop = centerY + min * centerY;
            const barBottom = centerY + max * centerY;
            const barHeight = Math.max(1, barBottom - barTop);
            ctx.fillRect(x, barTop, 1, barHeight);
        }
    }

    function drawMainWaveformWithPlayhead() {
        if (currentIndex < 0 || !items[currentIndex]) return;

        const it = items[currentIndex];
        const durationMs = it.durationMs;
        const ratio = durationMs > 0 ? clamp(playheadMs / durationMs, 0, 1) : 0;

        // Get logical dimensions for high-DPI rendering
        const logicalWidth = ui.mainWaveformContainer.clientWidth;
        const logicalHeight = ui.mainWaveformContainer.clientHeight;

        // Draw waveform with played portion highlighted
        drawWaveform(ui.mainWaveform, it.audioBuffer, {
            playedRatio: ratio,
            isMain: true,
            logicalWidth,
            logicalHeight
        });

        // Update playhead line position
        ui.playheadLine.style.left = `${ratio * logicalWidth}px`;
    }

    // ---------- Playhead Polling ----------
    function startPlayheadPolling() {
        // Cancel any existing polling first
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        console.log("[SpeakSpell] Starting playhead polling");

        function poll() {
            if (!isPlaying || currentIndex < 0) {
                console.log("[SpeakSpell] Polling stopped - isPlaying:", isPlaying, "currentIndex:", currentIndex);
                animationFrameId = null;
                return;
            }

            const durationMs = items[currentIndex]?.durationMs || 0;

            // playheadMs is updated via RNBO outport subscription

            // Update time displays
            ui.elapsed.textContent = msToTime(playheadMs);
            const remaining = Math.max(0, durationMs - playheadMs);
            ui.remaining.textContent = "-" + msToTime(remaining);

            // Update progress bar
            if (durationMs > 0) {
                const percent = clamp((playheadMs / durationMs) * 100, 0, 100);
                ui.progressFill.style.width = percent + "%";
            }

            // Update main waveform with playhead
            try {
                drawMainWaveformWithPlayhead();
            } catch (e) {
                console.error("[SpeakSpell] Error drawing waveform:", e);
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

    // ---------- Spectrum Analyzer ----------
    function setupAnalyser() {
        if (!context) return;

        analyser = context.createAnalyser();
        analyser.fftSize = 64; // 32 frequency bins
        analyser.smoothingTimeConstant = 0.8;
        analyserData = new Uint8Array(analyser.frequencyBinCount);

        // Connect to the output node for visualization
        if (window.__rnboOutputNode) {
            window.__rnboOutputNode.connect(analyser);
        }
    }

    function drawSpectrum() {
        if (!analyser || !ui.spectrumCanvas) return;

        const canvas = ui.spectrumCanvas;
        const ctx = canvas.getContext("2d");
        const width = canvas.width;
        const height = canvas.height;

        // Clear with VFD background
        ctx.fillStyle = "#0A1612";
        ctx.fillRect(0, 0, width, height);

        // Get frequency data
        analyser.getByteFrequencyData(analyserData);

        const barCount = analyserData.length;
        const barWidth = width / barCount;
        const gap = 1;

        // Reset shadow for each frame
        ctx.shadowBlur = 0;

        for (let i = 0; i < barCount; i++) {
            const value = analyserData[i];
            const percent = value / 255;
            const barHeight = percent * height;

            // Color based on intensity - VFD style
            if (percent > 0.7) {
                ctx.fillStyle = "#00F5D4"; // Bright glow
                ctx.shadowColor = "#00F5D4";
                ctx.shadowBlur = 4;
            } else if (percent > 0.3) {
                ctx.fillStyle = "#1A5C52"; // Dim
                ctx.shadowBlur = 0;
            } else {
                ctx.fillStyle = "#0D2E29"; // Very dim
                ctx.shadowBlur = 0;
            }

            const x = i * barWidth + gap / 2;
            const y = height - barHeight;
            ctx.fillRect(x, y, barWidth - gap, barHeight);
        }

        ctx.shadowBlur = 0; // Reset shadow
    }

    function startSpectrumPolling() {
        if (spectrumAnimationId) return;

        function poll() {
            drawSpectrum();
            if (isPlaying) {
                spectrumAnimationId = requestAnimationFrame(poll);
            } else {
                spectrumAnimationId = null;
            }
        }
        spectrumAnimationId = requestAnimationFrame(poll);
    }

    function stopSpectrumPolling() {
        if (spectrumAnimationId) {
            cancelAnimationFrame(spectrumAnimationId);
            spectrumAnimationId = null;
        }
        // Draw empty/dark spectrum
        if (ui.spectrumCanvas) {
            const ctx = ui.spectrumCanvas.getContext("2d");
            ctx.fillStyle = "#0A1612";
            ctx.fillRect(0, 0, ui.spectrumCanvas.width, ui.spectrumCanvas.height);
        }
    }

    // ---------- Seeking ----------
    function seekToPosition(clientX, element) {
        if (currentIndex < 0) return;

        const rect = element.getBoundingClientRect();
        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        const durationMs = items[currentIndex].durationMs;
        const seekMs = ratio * durationMs;

        // Set jump position
        param("jumpto").value = seekMs;

        // Update UI immediately
        ui.elapsed.textContent = msToTime(seekMs);
        const remaining = Math.max(0, durationMs - seekMs);
        ui.remaining.textContent = "-" + msToTime(remaining);
        ui.progressFill.style.width = (ratio * 100) + "%";

        // Redraw waveform with logical dimensions
        const logicalWidth = ui.mainWaveformContainer.clientWidth;
        const logicalHeight = ui.mainWaveformContainer.clientHeight;
        drawWaveform(ui.mainWaveform, items[currentIndex].audioBuffer, {
            playedRatio: ratio,
            isMain: true,
            logicalWidth,
            logicalHeight
        });
        ui.playheadLine.style.left = `${ratio * logicalWidth}px`;
    }

    function setupWaveformInteraction() {
        let isDragging = false;

        // Mouse events
        ui.mainWaveformContainer.addEventListener("mousedown", (e) => {
            if (currentIndex < 0) return;
            isDragging = true;
            seekToPosition(e.clientX, ui.mainWaveformContainer);
            window.dispatchEvent(new Event("rnbo:gesture"));
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            seekToPosition(e.clientX, ui.mainWaveformContainer);
        });

        document.addEventListener("mouseup", () => {
            isDragging = false;
        });

        // Touch events
        ui.mainWaveformContainer.addEventListener("touchstart", (e) => {
            if (currentIndex < 0) return;
            isDragging = true;
            const touch = e.touches[0];
            seekToPosition(touch.clientX, ui.mainWaveformContainer);
            window.dispatchEvent(new Event("rnbo:gesture"));
        }, { passive: true });

        ui.mainWaveformContainer.addEventListener("touchmove", (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            seekToPosition(touch.clientX, ui.mainWaveformContainer);
        }, { passive: true });

        ui.mainWaveformContainer.addEventListener("touchend", () => {
            isDragging = false;
        });

        // Progress bar clicking
        ui.progressTrack.addEventListener("click", (e) => {
            if (currentIndex < 0) return;
            seekToPosition(e.clientX, ui.progressTrack);
            window.dispatchEvent(new Event("rnbo:gesture"));
        });
    }

    // ---------- Playback Control ----------
    async function selectIndex(i) {
        if (!items[i]) return;

        currentIndex = i;
        const it = items[i];

        await loadIntoRNBO(it.audioBuffer);

        // Note: We do NOT set jumpto here - play() will handle it when needed.
        // Setting jumpto can trigger RNBO to auto-play, which we want to avoid
        // during track selection/loading.

        // Update time display
        ui.elapsed.textContent = "0:00";
        ui.remaining.textContent = "-" + msToTime(it.durationMs);
        ui.progressFill.style.width = "0%";

        // Update track name
        ui.trackName.textContent = it.filename.replace(/\.[^/.]+$/, "");

        // Draw main waveform with logical dimensions
        const logicalWidth = ui.mainWaveformContainer.clientWidth;
        const logicalHeight = ui.mainWaveformContainer.clientHeight;
        drawWaveform(ui.mainWaveform, it.audioBuffer, {
            playedRatio: 0,
            isMain: true,
            logicalWidth,
            logicalHeight
        });
        ui.playheadLine.style.left = "0px";

        // Update playlist highlighting
        updateActiveItem(i);
    }

    function play() {
        if (currentIndex < 0 || !isInitialized) return;

        const it = items[currentIndex];
        const jump = param("jumpto");
        const pLoop = param("loop");

        // For reverse playback without loop, we need a special approach:
        // Temporarily enable loop to ensure playback starts, then disable it
        const needsTempLoop = rate < 0 && !isLoop;

        if (needsTempLoop) {
            pLoop.value = 1;
        }

        // Set jump position - use larger margin for reverse to ensure we're inside the buffer
        if (rate < 0) {
            // Start near the end, but with enough margin to be safely inside the buffer
            jump.value = Math.max(0, it.durationMs - 100);
        } else {
            jump.value = 0;
        }

        // Use longer delay to ensure jump is processed before play trigger
        setTimeout(() => {
            pulse(param("playTrig"));
            isPlaying = true;
            startPlayheadPolling();
            startSpectrumPolling();

            // If we temporarily enabled loop for reverse playback, disable it after playback starts
            if (needsTempLoop) {
                setTimeout(() => {
                    pLoop.value = 0;
                }, 100);
            }
        }, 50);
    }

    function stop() {
        pulse(param("stopTrig"));
        isPlaying = false;
        stopPlayheadPolling();
        stopSpectrumPolling();

        // Reset display
        ui.elapsed.textContent = "0:00";
        const durationMs = items[currentIndex]?.durationMs || 0;
        ui.remaining.textContent = "-" + msToTime(durationMs);
        ui.progressFill.style.width = "0%";

        // Reset waveform with logical dimensions
        if (currentIndex >= 0 && items[currentIndex]) {
            const logicalWidth = ui.mainWaveformContainer.clientWidth;
            const logicalHeight = ui.mainWaveformContainer.clientHeight;
            drawWaveform(ui.mainWaveform, items[currentIndex].audioBuffer, {
                playedRatio: 0,
                isMain: true,
                logicalWidth,
                logicalHeight
            });
            ui.playheadLine.style.left = "0px";
        }
    }

    function togglePlayPause() {
        window.dispatchEvent(new Event("rnbo:gesture"));
        if (isPlaying) {
            stop();
        } else {
            play();
        }
    }

    function toggleLoop() {
        window.dispatchEvent(new Event("rnbo:gesture"));
        isLoop = !isLoop;
        param("loop").value = isLoop ? 1 : 0;
        ui.btnLoop.classList.toggle("is-active", isLoop);
    }

    function nextTrack() {
        if (items.length === 0) return;
        const next = (currentIndex + 1) % items.length;
        selectIndex(next);
        if (isPlaying) play();
    }

    function prevTrack() {
        if (items.length === 0) return;
        const prev = (currentIndex - 1 + items.length) % items.length;
        selectIndex(prev);
        if (isPlaying) play();
    }

    function adjustVolume(delta) {
        const slider = ui.volumeSlider;
        const newVal = clamp(parseFloat(slider.value) + delta, 0, 1);
        slider.value = newVal;
        updateVolume(newVal);
    }

    function adjustRate(delta) {
        const slider = ui.rateSlider;
        const newVal = clamp(parseFloat(slider.value) + delta, -1, 2);
        slider.value = newVal;
        updateRate(newVal);
    }

    function updateVolume(val) {
        param("outGain").value = val * 158;
        ui.volumeValue.textContent = Math.round(val * 100) + "%";
    }

    function updateRate(val) {
        const prevRate = rate;
        rate = val;
        param("rate").value = rate;

        // Format rate display
        if (rate < 0) {
            ui.rateValue.textContent = rate.toFixed(1) + "x";
        } else {
            ui.rateValue.textContent = rate.toFixed(1) + "x";
        }

        // Handle direction change while playing
        if (isPlaying && currentIndex >= 0) {
            const it = items[currentIndex];
            if (prevRate >= 0 && rate < 0) {
                // Switching to reverse: jump near end with margin
                param("jumpto").value = Math.max(0, it.durationMs - 100);
            } else if (prevRate < 0 && rate >= 0) {
                // Switching to forward: jump near start
                param("jumpto").value = 100;
            }
        }
    }

    function updateActiveItem(index) {
        document.querySelectorAll(".playlist-item").forEach((el) => {
            el.classList.remove("is-active");
        });
        const activeEl = document.querySelector(`[data-index="${index}"]`);
        if (activeEl) {
            activeEl.classList.add("is-active");
            // Scroll into view if needed
            activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }

    // ---------- Keyboard Shortcuts ----------
    function setupKeyboardShortcuts() {
        document.addEventListener("keydown", (e) => {
            // Ignore if typing in an input
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

            switch (e.code) {
                case "Space":
                    e.preventDefault();
                    togglePlayPause();
                    break;
                case "KeyS":
                    window.dispatchEvent(new Event("rnbo:gesture"));
                    stop();
                    break;
                case "KeyL":
                    toggleLoop();
                    break;
                case "ArrowLeft":
                    e.preventDefault();
                    prevTrack();
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    nextTrack();
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    adjustVolume(0.1);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    adjustVolume(-0.1);
                    break;
                case "BracketLeft":
                    adjustRate(-0.1);
                    break;
                case "BracketRight":
                    adjustRate(0.1);
                    break;
                // Number keys 1-9 for quick track selection
                case "Digit1":
                case "Digit2":
                case "Digit3":
                case "Digit4":
                case "Digit5":
                case "Digit6":
                case "Digit7":
                case "Digit8":
                case "Digit9":
                    const num = parseInt(e.code.replace("Digit", ""), 10) - 1;
                    if (num < items.length) {
                        selectIndex(num);
                        window.dispatchEvent(new Event("rnbo:gesture"));
                        play();
                    }
                    break;
                case "Digit0":
                    // 0 = track 10
                    if (9 < items.length) {
                        selectIndex(9);
                        window.dispatchEvent(new Event("rnbo:gesture"));
                        play();
                    }
                    break;
            }
        });
    }

    // ---------- Build Playlist UI ----------
    function buildPlaylist() {
        ui.playlistScroll.innerHTML = items
            .map((it, i) => {
                const indexStr = String(i + 1).padStart(2, "0");
                const name = it.filename.replace(/\.[^/.]+$/, "");
                return `
                    <div class="playlist-item" data-index="${i}">
                        <div class="item-header">
                            <span class="drag-handle" aria-label="Drag to reorder">&#9776;</span>
                            <span class="item-index">${indexStr}</span>
                            <span class="item-name">${name}</span>
                            <span class="item-duration">${msToTime(it.durationMs)}</span>
                        </div>
                        <div class="item-waveform">
                            <canvas data-waveform="${i}" width="400" height="24"></canvas>
                        </div>
                    </div>
                `;
            })
            .join("");

        // Draw waveforms
        items.forEach((it, i) => {
            const canvas = document.querySelector(`canvas[data-waveform="${i}"]`);
            if (canvas) {
                drawWaveform(canvas, it.audioBuffer);
            }
        });

        // Setup event handlers
        setupPlaylistClickHandlers();
        setupDragAndDrop();
    }

    function setupPlaylistClickHandlers() {
        document.querySelectorAll(".playlist-item").forEach((el) => {
            el.addEventListener("click", async (e) => {
                // Ignore clicks on drag handle
                if (e.target.classList.contains("drag-handle")) return;
                // Ignore if dragging
                if (dragState.isDragging) return;

                window.dispatchEvent(new Event("rnbo:gesture"));
                const idx = parseInt(el.dataset.index, 10);
                await selectIndex(idx);
                play();
            });
        });
    }

    // ---------- Drag and Drop ----------
    function setupDragAndDrop() {
        const playlistItems = ui.playlistScroll.querySelectorAll(".playlist-item");

        playlistItems.forEach((item) => {
            const handle = item.querySelector(".drag-handle");
            if (!handle) return;

            // Mouse events
            handle.addEventListener("mousedown", (e) => startDrag(e, item));

            // Touch events
            handle.addEventListener("touchstart", (e) => startDrag(e, item), { passive: false });
        });

        // Document-level listeners for drag/end
        document.addEventListener("mousemove", onDragMove);
        document.addEventListener("mouseup", onDragEnd);
        document.addEventListener("touchmove", onDragMove, { passive: false });
        document.addEventListener("touchend", onDragEnd);
    }

    function startDrag(e, item) {
        e.preventDefault();
        e.stopPropagation();

        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const index = parseInt(item.dataset.index, 10);

        dragState = {
            isDragging: true,
            dragIndex: index,
            dragElement: item,
            ghostElement: null,
            startY: clientY,
            currentY: clientY
        };

        // Create ghost element
        const ghost = item.cloneNode(true);
        ghost.classList.add("drag-ghost");
        ghost.style.width = item.offsetWidth + "px";
        document.body.appendChild(ghost);
        dragState.ghostElement = ghost;

        // Position ghost at item's current position
        const rect = item.getBoundingClientRect();
        ghost.style.left = rect.left + "px";
        ghost.style.top = rect.top + "px";

        // Mark original as dragging
        item.classList.add("is-dragging");
    }

    function onDragMove(e) {
        if (!dragState.isDragging) return;

        e.preventDefault();

        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        dragState.currentY = clientY;

        // Move ghost
        if (dragState.ghostElement) {
            const deltaY = clientY - dragState.startY;
            const rect = dragState.dragElement.getBoundingClientRect();
            dragState.ghostElement.style.top = (rect.top + deltaY) + "px";
        }

        // Find drop target and show indicators
        const playlistItems = document.querySelectorAll(".playlist-item:not(.is-dragging)");
        playlistItems.forEach((item) => {
            item.classList.remove("drop-above", "drop-below");

            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;

            if (clientY >= rect.top && clientY <= rect.bottom) {
                if (clientY < midY) {
                    item.classList.add("drop-above");
                } else {
                    item.classList.add("drop-below");
                }
            }
        });
    }

    function onDragEnd() {
        if (!dragState.isDragging) return;

        // Find target position
        const playlistItems = document.querySelectorAll(".playlist-item");
        let targetIndex = dragState.dragIndex;

        playlistItems.forEach((item) => {
            if (item.classList.contains("drop-above")) {
                targetIndex = parseInt(item.dataset.index, 10);
            } else if (item.classList.contains("drop-below")) {
                targetIndex = parseInt(item.dataset.index, 10) + 1;
            }
            item.classList.remove("drop-above", "drop-below");
        });

        // Clean up
        if (dragState.ghostElement) {
            dragState.ghostElement.remove();
        }
        if (dragState.dragElement) {
            dragState.dragElement.classList.remove("is-dragging");
        }

        // Reorder if position changed
        const fromIndex = dragState.dragIndex;
        if (targetIndex !== fromIndex && targetIndex !== fromIndex + 1) {
            reorderPlaylist(fromIndex, targetIndex);
        }

        // Reset state
        dragState = {
            isDragging: false,
            dragIndex: -1,
            dragElement: null,
            ghostElement: null,
            startY: 0,
            currentY: 0
        };
    }

    function reorderPlaylist(fromIndex, toIndex) {
        // Adjust toIndex if moving down (account for removal)
        if (toIndex > fromIndex) {
            toIndex--;
        }

        // Reorder the items array
        const [movedItem] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, movedItem);

        // Update currentIndex if needed
        if (currentIndex === fromIndex) {
            // The playing item was moved
            currentIndex = toIndex;
        } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
            // Item moved from before current to after - current shifts down
            currentIndex--;
        } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
            // Item moved from after current to before - current shifts up
            currentIndex++;
        }

        // Rebuild the playlist UI
        rebuildPlaylistUI();
    }

    function rebuildPlaylistUI() {
        const playlistItems = document.querySelectorAll(".playlist-item");

        playlistItems.forEach((el, i) => {
            el.dataset.index = i;

            const indexEl = el.querySelector(".item-index");
            const nameEl = el.querySelector(".item-name");
            const durationEl = el.querySelector(".item-duration");
            const canvas = el.querySelector("canvas");

            if (indexEl) indexEl.textContent = String(i + 1).padStart(2, "0");
            if (nameEl) nameEl.textContent = items[i].filename.replace(/\.[^/.]+$/, "");
            if (durationEl) durationEl.textContent = msToTime(items[i].durationMs);
            if (canvas) {
                canvas.dataset.waveform = i;
                drawWaveform(canvas, items[i].audioBuffer);
            }
        });

        // Update active highlighting
        updateActiveItem(currentIndex);
    }

    // ---------- Initialize ----------
    window.initPlaylistUI = async function (rnboDevice, rnboContext) {
        device = rnboDevice;
        context = rnboContext;

        // Subscribe to RNBO outport messages (playhead position)
        device.messageEvent.subscribe((ev) => {
            if (ev.tag === "playhead") {
                playheadMs = ev.payload;
            }
        });

        // Cache DOM refs
        ui = {
            mainWaveformContainer: document.getElementById("main-waveform-container"),
            mainWaveform: document.getElementById("main-waveform"),
            playheadLine: document.getElementById("playhead-line"),
            elapsed: document.getElementById("elapsed"),
            remaining: document.getElementById("remaining"),
            progressTrack: document.getElementById("progress-track"),
            progressFill: document.getElementById("progress-fill"),
            trackName: document.getElementById("track-name"),
            btnPlay: document.getElementById("btn-play"),
            btnStop: document.getElementById("btn-stop"),
            btnLoop: document.getElementById("btn-loop"),
            rateSlider: document.getElementById("rate-slider"),
            rateValue: document.getElementById("rate-value"),
            volumeSlider: document.getElementById("volume-slider"),
            volumeValue: document.getElementById("volume-value"),
            playlistScroll: document.getElementById("playlist-scroll"),
            loadingOverlay: document.getElementById("loading-overlay"),
            loadingBarFill: document.getElementById("loading-bar-fill"),
            loadingStatus: document.getElementById("loading-status"),
            spectrumCanvas: document.getElementById("spectrum-canvas")
        };

        // Set canvas size based on container
        const resizeMainWaveform = () => {
            const width = ui.mainWaveformContainer.clientWidth;
            const height = ui.mainWaveformContainer.clientHeight;
            ui.mainWaveform.width = width * window.devicePixelRatio;
            ui.mainWaveform.height = height * window.devicePixelRatio;
            ui.mainWaveform.style.width = width + "px";
            ui.mainWaveform.style.height = height + "px";
            const ctx = ui.mainWaveform.getContext("2d");
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

            // Redraw if we have a track
            if (currentIndex >= 0 && items[currentIndex]) {
                drawMainWaveformWithPlayhead();
            }
        };

        // Initial resize
        setTimeout(resizeMainWaveform, 100);
        window.addEventListener("resize", resizeMainWaveform);

        // Setup spectrum canvas sizing
        const resizeSpectrumCanvas = () => {
            if (!ui.spectrumCanvas) return;
            const container = ui.spectrumCanvas.parentElement;
            if (!container) return;
            const width = container.clientWidth;
            const height = container.clientHeight;
            ui.spectrumCanvas.width = width * window.devicePixelRatio;
            ui.spectrumCanvas.height = height * window.devicePixelRatio;
            ui.spectrumCanvas.style.width = width + "px";
            ui.spectrumCanvas.style.height = height + "px";
            const ctx = ui.spectrumCanvas.getContext("2d");
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            // Draw empty spectrum initially
            ctx.fillStyle = "#0A1612";
            ctx.fillRect(0, 0, width, height);
        };

        setTimeout(resizeSpectrumCanvas, 100);
        window.addEventListener("resize", resizeSpectrumCanvas);

        // Setup spectrum analyzer
        setupAnalyser();

        // Bind transport buttons
        ui.btnPlay.addEventListener("click", () => {
            window.dispatchEvent(new Event("rnbo:gesture"));
            play();
        });

        ui.btnStop.addEventListener("click", () => {
            window.dispatchEvent(new Event("rnbo:gesture"));
            stop();
        });

        ui.btnLoop.addEventListener("click", toggleLoop);

        // Bind sliders
        ui.rateSlider.addEventListener("input", () => {
            updateRate(parseFloat(ui.rateSlider.value));
        });

        ui.volumeSlider.addEventListener("input", () => {
            updateVolume(parseFloat(ui.volumeSlider.value));
        });

        // Set initial volume
        updateVolume(parseFloat(ui.volumeSlider.value));

        // Setup waveform interaction (click/drag to seek)
        setupWaveformInteraction();

        // Setup keyboard shortcuts
        setupKeyboardShortcuts();

        // Load playlist with progress indication
        const playlist = await fetchJSON(PLAYLIST_JSON);
        const totalItems = playlist.items.length;

        // Show initial loading status
        ui.loadingStatus.textContent = `0 / ${totalItems}`;
        ui.loadingBarFill.style.width = "0%";

        for (let i = 0; i < totalItems; i++) {
            const filename = playlist.items[i];
            const audioBuffer = await fetchAndDecode(MEDIA_BASE + filename);
            items.push({
                filename,
                audioBuffer,
                durationMs: (audioBuffer.length / audioBuffer.sampleRate) * 1000
            });

            // Update loading progress
            const loaded = i + 1;
            const percent = (loaded / totalItems) * 100;
            ui.loadingStatus.textContent = `${loaded} / ${totalItems}`;
            ui.loadingBarFill.style.width = `${percent}%`;
        }

        // Hide loading overlay with fade
        ui.loadingOverlay.classList.add("hidden");

        // Build playlist UI
        buildPlaylist();

        // Auto-select first item (just prepares display, doesn't play)
        await selectIndex(0);

        // Explicitly ensure patch is stopped - pulse sends stop signal to RNBO
        // This prevents auto-play when audio context is resumed on first user gesture
        param("playTrig").value = 0;
        pulse(param("stopTrig"));

        // Now ready for user interaction
        isInitialized = true;
    };
})();
