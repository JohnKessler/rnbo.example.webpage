// app.js
// This file is based on your uploaded version, with only a safe debug addition:
// - console.table() of RNBO parameters after device creation (IDs are stable even if indices shift)

async function setup() {
  const patchExportURL = "export/patch.export.json";
  const dependenciesURL = "export/dependencies.json";

  // Create AudioContext
  const WAContext = window.AudioContext || window.webkitAudioContext;
  const context = new WAContext();

  // Load the exported patcher JSON
  let response, patcher;
  try {
    response = await fetch(patchExportURL);
    if (!response.ok) throw new Error(`Failed to fetch patch export: ${response.status}`);
    patcher = await response.json();
  } catch (err) {
    console.error("Failed to load patch export:", err);
    return;
  }

  // Load RNBO script if needed
  if (!window.RNBO) {
    const version = patcher?.desc?.meta?.rnboversion;
    if (!version) {
      console.error("RNBO version missing from patch export meta.");
      return;
    }
    await loadRNBOScript(version);
  }

  // Fetch dependencies (optional)
  let dependencies = [];
  try {
    const dependenciesResponse = await fetch(dependenciesURL);
    if (dependenciesResponse.ok) {
      dependencies = await dependenciesResponse.json();
      dependencies = dependencies.map(d => (d.file ? Object.assign({}, d, { file: "export/" + d.file }) : d));
    }
  } catch (e) {
    // Optional; ignore
  }

  // Create the device
  let device;
  try {
    device = await RNBO.createDevice({ context, patcher });

    // Debug: parameter map (ids remain stable even if indices shift when you add params like "jumpto")
    try {
      console.table((device.parameters || []).map(p => ({
        id: p.id,
        name: p.name,
        index: p.index,
        min: p.min,
        max: p.max,
        value: p.value
      })));
    } catch (_) {}

  } catch (err) {
    console.error("Failed to create RNBO device:", err);
    return;
  }

  // Load data buffer dependencies if any
  if (dependencies.length) {
    try {
      await device.loadDataBufferDependencies(dependencies);
    } catch (e) {
      console.warn("Failed to load data buffer dependencies:", e);
    }
  }

  // Connect audio output
  device.node.connect(context.destination);

  // Initialize Playlist UI (your custom UI)
  if (window.initPlaylistUI) {
    try {
      await window.initPlaylistUI(device, context);
    } catch (e) {
      console.error("initPlaylistUI failed:", e);
    }
  }

  // Resume audio on any click/tap (browser policy)
  document.body.addEventListener("pointerdown", () => {
    if (context.state !== "running") context.resume().catch(() => {});
  }, { passive: true });
}

function loadRNBOScript(version) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://c74-public.nyc3.digitaloceanspaces.com/rnbo/" + encodeURIComponent(version) + "/rnbo.min.js";
    el.onload = resolve;
    el.onerror = () => reject(new Error("Failed to load rnbo.js v" + version));
    document.body.appendChild(el);
  });
}

// Run after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setup, { once: true });
} else {
  setup();
}