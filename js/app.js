// app.js (robust audio resume + RNBO graph sanity + null-safe DOM access + DOM-ready init)
//
// Key changes in this version:
// - Creates AudioContext on load (still OK), BUT resumes it robustly on user gestures:
//   * pointerdown / mousedown / touchstart / keydown (capture phase)
//   * custom event: "rnbo:gesture" (dispatched by playlist-ui Play/Stop)
// - Avoids overwriting document.body.onclick (uses addEventListener instead)
// - Explicitly sets outputNode.gain.value = 1
// - Exposes window.__rnboContext and window.__rnboOutputNode for quick debugging
// - Keeps your existing null-safe helper behavior & DOM-ready init

async function setup() {
  const patchExportURL = "export/patch.export.json";

  // ----------------------------
  // DOM helpers (null-safe)
  // ----------------------------
  const $ = (id) => document.getElementById(id);

  const setText = (id, text) => {
    const el = $(id);
    if (el) el.innerText = text;
    return !!el;
  };

  const safeRemoveChild = (parent, child) => {
    if (parent && child && child.parentNode === parent) parent.removeChild(child);
  };

  const removeIf = (parentId, childId) => {
    safeRemoveChild($(parentId), $(childId));
  };

  // ----------------------------
  // Create AudioContext
  // ----------------------------
  const WAContext = window.AudioContext || window.webkitAudioContext;
  const context = new WAContext();

  // Create gain node and connect it to audio output
  const outputNode = context.createGain();
  outputNode.gain.value = 1;
  outputNode.connect(context.destination);

  // Expose for debugging
  window.__rnboContext = context;
  window.__rnboOutputNode = outputNode;

  // Robust resume function (safe to call repeatedly)
  const resumeAudio = async (reason = "unknown") => {
    try {
      if (context.state !== "running") {
        await context.resume();
      }
      // Quick sanity: ensure graph is connected
      // (connect is idempotent if already connected in most browsers)
      if (outputNode && context.destination) {
        // no-op; just referencing ensures these exist
      }
      // Optional: uncomment if you want console proof each time
      // console.log(`[RNBO] AudioContext state="${context.state}" (resume reason: ${reason})`);
    } catch (e) {
      console.warn("[RNBO] context.resume() failed:", reason, e);
    }
  };

  // Resume on common user gestures (capture phase)
  const gestureOpts = { capture: true, passive: true };
  window.addEventListener("pointerdown", () => resumeAudio("pointerdown"), gestureOpts);
  window.addEventListener("mousedown", () => resumeAudio("mousedown"), gestureOpts);
  window.addEventListener("touchstart", () => resumeAudio("touchstart"), gestureOpts);
  window.addEventListener("keydown", () => resumeAudio("keydown"), { capture: true });

  // Resume on explicit signal from UI
  window.addEventListener("rnbo:gesture", () => resumeAudio("rnbo:gesture"), { capture: true });

  // ----------------------------
  // Fetch the exported patcher
  // ----------------------------
  let response, patcher;
  try {
    response = await fetch(patchExportURL, { cache: "no-store" });
    patcher = await response.json();

    if (!window.RNBO) {
      // Load RNBO script dynamically
      await loadRNBOScript(patcher.desc.meta.rnboversion);
    }
  } catch (err) {
    const errorContext = { error: err };
    if (response && (response.status >= 300 || response.status < 200)) {
      errorContext.header = `Couldn't load patcher export bundle`;
      errorContext.description =
        `Check app.js to see what file it's trying to load. Currently it's ` +
        `"${patchExportURL}".`;
    }
    console.error("[RNBO] Failed to load patch export:", errorContext);
    if (typeof guardrails === "function") guardrails(errorContext);
    return;
  }

  // ----------------------------
  // Create the device
  // ----------------------------
  let device;
  try {
    device = await RNBO.createDevice({ context, patcher });
  } catch (err) {
    console.error("[RNBO] createDevice failed:", err);
    if (typeof guardrails === "function") guardrails({ error: err });
    return;
  }

  // Dump params for sanity (your console.table)
  try {
    console.table(
      device.parameters.map((p) => ({
        id: p.id,
        name: p.name,
        index: p.index,
        min: p.min,
        max: p.max,
        value: p.value,
      }))
    );
  } catch (_) {}

  // ----------------------------
  // Load data buffer dependencies (if any)
  // ----------------------------
  const dependencies = patcher?.dependencies || [];
  if (dependencies.length) {
    try {
      await device.loadDataBufferDependencies(dependencies);
    } catch (e) {
      console.warn("[RNBO] loadDataBufferDependencies failed:", e);
    }
  }

  // ----------------------------
  // Connect to graph (device -> outputNode -> destination)
  // ----------------------------
  try {
    device.node.connect(outputNode);
  } catch (e) {
    console.error("[RNBO] device.node.connect(outputNode) failed:", e);
  }

  // ----------------------------
  // Null-safe optional DOM tweaks (kept)
  // ----------------------------
  // Example: patcher title write, but safe
  setText("patcher-title", patcher?.desc?.meta?.name || "RNBO Patch");

  // Skip sections if your HTML doesn't include them
  removeIf("rnbo-content", "rnbo-description");

  // ----------------------------
  // Initialize Playlist UI if present
  // ----------------------------
  if (window.initPlaylistUI) {
    try {
      await window.initPlaylistUI(device, context);
    } catch (e) {
      console.error("[RNBO] initPlaylistUI failed:", e);
    }
  }

  // ----------------------------
  // Final: don’t rely on a single body.onclick assignment
  // Resume audio on any click/tap
  // ----------------------------
  document.addEventListener(
    "click",
    () => {
      resumeAudio("click");
    },
    { capture: true }
  );

  // If you have guardrails.js
  if (typeof guardrails === "function") guardrails();
}

function loadRNBOScript(version) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://c74-public.nyc3.digitaloceanspaces.com/rnbo/${version}/rnbo.min.js`;
    s.onload = () => resolve();
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
}

// Run after DOM is ready, and catch async errors so they don't become "Uncaught (in promise)"
(function init() {
  const run = async () => {
    try {
      await setup();
    } catch (err) {
      console.error("RNBO setup failed:", err);
      if (typeof guardrails === "function") {
        guardrails({ error: err });
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();