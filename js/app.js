// app.js (patched for null-safe DOM access + DOM-ready init + promise error handling)
//
// What changed vs your original:
// - Adds helper functions: $(id), setText(id, text), removeIf(parentId, childId), safeRemoveChild(parent, child)
// - Makes "patcher-title" write null-safe (fixes your Firefox console error)
// - Wraps setup() call so async errors don't become "Uncaught (in promise)"
// - Runs setup after DOMContentLoaded (more reliable timing across browsers)
// - Adds a few extra null checks in optional UI sections

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
    outputNode.connect(context.destination);

    // Fetch the exported patcher
    let response, patcher;
    try {
        response = await fetch(patchExportURL);
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
                `Check app.js to see what file it's trying to load. Currently it's` +
                ` trying to load "${patchExportURL}". If that doesn't` +
                ` match the name of the file you exported from RNBO, modify` +
                ` patchExportURL in app.js.`;
        }
        if (typeof guardrails === "function") {
            guardrails(errorContext);
        } else {
            throw err;
        }
        return;
    }

    // (Optional) Fetch the dependencies
    let dependencies = [];
    try {
        const dependenciesResponse = await fetch("export/dependencies.json");
        dependencies = await dependenciesResponse.json();

        // Prepend "export" to any file dependencies
        dependencies = dependencies.map(d => (d.file ? Object.assign({}, d, { file: "export/" + d.file }) : d));
    } catch (e) {
        // Optional; ignore
    }

    // Create the device
    let device;
    try {
        device = await RNBO.createDevice({ context, patcher });
    } catch (err) {
        if (typeof guardrails === "function") {
            guardrails({ error: err });
        } else {
            throw err;
        }
        return;
    }

    // (Optional) Load the samples
    if (dependencies.length) {
        await device.loadDataBufferDependencies(dependencies);
    }

    // Connect the device to the web audio graph
    device.node.connect(outputNode);

    // Initialize your playlist UI if present
    if (window.initPlaylistUI) {
        await window.initPlaylistUI(device, context);
    }

    // (Optional) Extract the name and rnbo version of the patcher from the description
    // FIX: null-safe (this is the source of your Firefox error if #patcher-title doesn't exist)
    setText(
        "patcher-title",
        (patcher?.desc?.meta?.filename || "Unnamed Patcher") + " (v" + (patcher?.desc?.meta?.rnboversion || "?") + ")"
    );

    // (Optional) Automatically create sliders for the device parameters
    makeSliders(device);

    // (Optional) Create a form to send messages to RNBO inputs
    makeInportForm(device);

    // (Optional) Attach listeners to outports so you can log messages from the RNBO patcher
    attachOutports(device);

    // (Optional) Load presets, if any
    loadPresets(device, patcher);

    // (Optional) Connect MIDI inputs
    makeMIDIKeyboard(device);

    // Resume audio on any click/tap (kept as-is)
    document.body.onclick = () => {
        context.resume();
    };

    // Skip if you're not using guardrails.js
    if (typeof guardrails === "function") guardrails();
}

function loadRNBOScript(version) {
    return new Promise((resolve, reject) => {
        if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
            throw new Error(
                "Patcher exported with a Debug Version!\nPlease specify the correct RNBO version to use in the code."
            );
        }
        const el = document.createElement("script");
        el.src =
            "https://c74-public.nyc3.digitaloceanspaces.com/rnbo/" +
            encodeURIComponent(version) +
            "/rnbo.min.js";
        el.onload = resolve;
        el.onerror = function (err) {
            console.log(err);
            reject(new Error("Failed to load rnbo.js v" + version));
        };
        document.body.append(el);
    });
}

function makeSliders(device) {
    const pdiv = document.getElementById("rnbo-parameter-sliders");
    if (!pdiv) return; // Null-safe: page might not have the slider container

    const noParamLabel = document.getElementById("no-param-label");
    if (noParamLabel && device.numParameters > 0 && noParamLabel.parentNode === pdiv) {
        pdiv.removeChild(noParamLabel);
    }

    // This will allow us to ignore parameter update events while dragging the slider.
    let isDraggingSlider = false;
    let uiElements = {};

    device.parameters.forEach(param => {
        // Create a label, an input slider and a value display
        let label = document.createElement("label");
        let slider = document.createElement("input");
        let text = document.createElement("input");
        let sliderContainer = document.createElement("div");
        sliderContainer.appendChild(label);
        sliderContainer.appendChild(slider);
        sliderContainer.appendChild(text);

        // Add a name for the label
        label.setAttribute("name", param.name);
        label.setAttribute("for", param.name);
        label.setAttribute("class", "param-label");
        label.textContent = `${param.name}: `;

        // Make each slider reflect its parameter
        slider.setAttribute("type", "range");
        slider.setAttribute("class", "param-slider");
        slider.setAttribute("id", param.id);
        slider.setAttribute("name", param.name);
        slider.setAttribute("min", param.min);
        slider.setAttribute("max", param.max);
        if (param.steps > 1) {
            slider.setAttribute("step", (param.max - param.min) / (param.steps - 1));
        } else {
            slider.setAttribute("step", (param.max - param.min) / 1000.0);
        }
        slider.setAttribute("value", param.value);

        // Make a settable text input display for the value
        text.setAttribute("value", param.value.toFixed(1));
        text.setAttribute("type", "text");

        // Make each slider control its parameter
        slider.addEventListener("pointerdown", () => {
            isDraggingSlider = true;
        });
        slider.addEventListener("pointerup", () => {
            isDraggingSlider = false;
            slider.value = param.value;
            text.value = param.value.toFixed(1);
        });
        slider.addEventListener("input", () => {
            let value = Number.parseFloat(slider.value);
            param.value = value;
        });

        // Make the text box input control the parameter value as well
        text.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                let newValue = Number.parseFloat(text.value);
                if (isNaN(newValue)) {
                    text.value = param.value;
                } else {
                    newValue = Math.min(newValue, param.max);
                    newValue = Math.max(newValue, param.min);
                    text.value = newValue;
                    param.value = newValue;
                }
            }
        });

        // Store the slider and text by id so we can access them later
        uiElements[param.id] = { slider, text };

        // Add the slider element
        pdiv.appendChild(sliderContainer);
    });

    // Listen to parameter changes from the device
    device.parameterChangeEvent.subscribe(param => {
        const ui = uiElements[param.id];
        if (!ui) return;
        if (!isDraggingSlider) ui.slider.value = param.value;
        ui.text.value = param.value.toFixed(1);
    });
}

function makeInportForm(device) {
    const idiv = document.getElementById("rnbo-inports");
    const inportSelect = document.getElementById("inport-select");
    const inportText = document.getElementById("inport-text");
    const inportForm = document.getElementById("inport-form");
    if (!idiv || !inportSelect || !inportText || !inportForm) return; // Null-safe

    let inportTag = null;

    // Device messages correspond to inlets/outlets or inports/outports
    const messages = device.messages;
    const inports = messages.filter(message => message.type === RNBO.MessagePortType.Inport);

    if (inports.length === 0) {
        const formEl = document.getElementById("inport-form");
        if (formEl && formEl.parentNode === idiv) idiv.removeChild(formEl);
        return;
    } else {
        const noLabel = document.getElementById("no-inports-label");
        if (noLabel && noLabel.parentNode === idiv) idiv.removeChild(noLabel);

        inports.forEach(inport => {
            const option = document.createElement("option");
            option.innerText = inport.tag;
            inportSelect.appendChild(option);
        });

        inportSelect.onchange = () => (inportTag = inportSelect.value);
        inportTag = inportSelect.value;

        inportForm.onsubmit = (ev) => {
            // Do this or else the page will reload
            ev.preventDefault();

            // Turn the text into a list of numbers (RNBO messages must be numbers, not text)
            const values = inportText.value.split(/\s+/).map(s => parseFloat(s));

            // Send the message event to the RNBO device
            let messageEvent = new RNBO.MessageEvent(RNBO.TimeNow, inportTag, values);
            device.scheduleEvent(messageEvent);
        };
    }
}

function attachOutports(device) {
    const outports = device.outports;

    const consoleRoot = document.getElementById("rnbo-console");
    if (!consoleRoot) return; // Null-safe if your page doesn't include the console UI

    if (outports.length < 1) {
        const div = document.getElementById("rnbo-console-div");
        if (div && div.parentNode === consoleRoot) consoleRoot.removeChild(div);
        return;
    }

    const noOutLabel = document.getElementById("no-outports-label");
    if (noOutLabel && noOutLabel.parentNode === consoleRoot) consoleRoot.removeChild(noOutLabel);

    device.messageEvent.subscribe((ev) => {
        // Ignore message events that don't belong to an outport
        if (outports.findIndex(elt => elt.tag === ev.tag) < 0) return;

        console.log(`${ev.tag}: ${ev.payload}`);

        // Null-safe readout update
        const readout = document.getElementById("rnbo-console-readout");
        if (readout) readout.innerText = `${ev.tag}: ${ev.payload}`;
    });
}

function loadPresets(device, patcher) {
    const presetRoot = document.getElementById("rnbo-presets");
    if (!presetRoot) return; // Null-safe

    let presets = patcher.presets || [];
    if (presets.length < 1) {
        const presetSelect = document.getElementById("preset-select");
        if (presetSelect && presetSelect.parentNode === presetRoot) presetRoot.removeChild(presetSelect);
        return;
    }

    const noPresetsLabel = document.getElementById("no-presets-label");
    if (noPresetsLabel && noPresetsLabel.parentNode === presetRoot) presetRoot.removeChild(noPresetsLabel);

    let presetSelect = document.getElementById("preset-select");
    if (!presetSelect) return;

    presets.forEach((preset, index) => {
        const option = document.createElement("option");
        option.innerText = preset.name;
        option.value = index;
        presetSelect.appendChild(option);
    });
    presetSelect.onchange = () => device.setPreset(presets[presetSelect.value].preset);
}

function makeMIDIKeyboard(device) {
    let mdiv = document.getElementById("rnbo-clickable-keyboard");
    if (!mdiv) return; // Null-safe
    if (device.numMIDIInputPorts === 0) return;

    const noMidi = document.getElementById("no-midi-label");
    if (noMidi && noMidi.parentNode === mdiv) mdiv.removeChild(noMidi);

    const midiNotes = [49, 52, 56, 63];
    midiNotes.forEach(note => {
        const key = document.createElement("div");
        const label = document.createElement("p");
        label.textContent = note;
        key.appendChild(label);

        key.addEventListener("pointerdown", () => {
            let midiChannel = 0;

            // Format a MIDI message payload, this constructs a MIDI on event
            let noteOnMessage = [
                144 + midiChannel, // Note on
                note,              // MIDI Note
                100                // Velocity
            ];

            let noteOffMessage = [
                128 + midiChannel, // Note off
                note,              // MIDI Note
                0                  // Velocity
            ];

            let midiPort = 0;
            let noteDurationMs = 250;

            let noteOnEvent = new RNBO.MIDIEvent(device.context.currentTime * 1000, midiPort, noteOnMessage);
            let noteOffEvent = new RNBO.MIDIEvent(device.context.currentTime * 1000 + noteDurationMs, midiPort, noteOffMessage);

            device.scheduleEvent(noteOnEvent);
            device.scheduleEvent(noteOffEvent);

            key.classList.add("clicked");
        });

        key.addEventListener("pointerup", () => key.classList.remove("clicked"));
        mdiv.appendChild(key);
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