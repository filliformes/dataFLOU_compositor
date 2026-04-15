# dataFLOU_compositor

**Send OSC data to many destinations as triggerable scenes.** A rotated‑Ableton‑Session‑style editor that fires multiple OSC messages at once with optional modulation, sequencing, transitions, delays, and MIDI control.

Built as a desktop app for Windows and macOS using Electron + React. Sessions are saved as plain JSON files and round‑trip cleanly between machines.

---

## What it does

You build a grid of **Messages** (rows — each row is one OSC message destination + path) and **Scenes** (columns). Each cell at the intersection (a "clip") holds the value, modulation, sequencing, and timing parameters that this Message will use whenever this Scene is triggered.

- **One scene trigger** fires every clip in that column simultaneously.
- **Per‑clip triggers** let you fire individual messages without launching the whole scene.
- **Multi‑value OSC** — space‑separated entries in a clip's Value field become multiple OSC args in a single message. Every modulator treats each entry independently.
- **Scale 0.0–1.0** — clamps each output channel to `[0, 1]`; with the Arpeggiator it proportionally normalizes the ladder instead of clipping.
- **Four modulation types** — pick per clip: **LFO**, **Envelope (ADSR)**, **Arpeggiator**, **Random Generator**.
- **Sequencer (1–16 steps)** — cycles through per‑step values at BPM (session‑locked), Tempo (per‑clip slider), or Free (ms). With Modulation also on, the modulator operates on the current step value.
- **Transitions** morph the previous clip's value into the new one over a configurable time, even while the LFO keeps running.
- **Scene auto‑advance** (Off / Next / Random) drives a 1–128‑step sequence grid drag‑laid in the Sequence view.
- **Clip Templates** — save full clip configs and apply them to empty cells via the right‑click menu or the Template dropdown. Persisted in localStorage, survive app restarts.
- **Global MIDI Learn** (Ableton‑style, one button) — enter learn mode, click a scene or clip trigger, wiggle a MIDI control. Blue overlays show learnables, green = bound.
- **Live value display** — every active clip's current output shows in real time inside its cell tile.

OSC is sent over UDP. The engine runs in the Electron main process at a configurable tick rate (10–100 Hz) so timing stays stable even if the UI is busy.

---

## Quick start

### Run from source

Requires [Node.js](https://nodejs.org) (LTS or newer).

```bash
git clone https://github.com/fillioning/dataFLOU_compositor.git
cd dataFLOU_compositor
npm install
npm run dev          # launch in dev mode with hot reload
```

### Build a Windows installer

```bash
npm run build:win
```

Produces an installer under `release/<version>/dataFLOU_compositor-<version>-win-x64.exe` plus an unpacked `win-unpacked/` directory.

### Build a macOS dmg (must run on a Mac)

```bash
npm run build:mac
```

---

## How it's organized

The window is split into three regions:

| Region | What it holds |
| --- | --- |
| **Top toolbar** | Session name, file actions (New / Open / Save / Save As), default OSC address & destination, Tick rate, Global BPM, MIDI input picker, **Edit ↔ Sequence** view toggle, **Stop All**, **Panic** |
| **Editor** (Edit view) | Left: Messages sidebar (rows). Center: Scene columns (one per scene). Right: Inspector panel for the selected clip or message |
| **Sequence view** (the other tab) | Left: scene palette + Theme picker. Center: 128‑slot drag‑drop sequence grid. Bottom: status/transport bar (Play / Pause / Stop, focused scene name, message count) |

Tab toggles Edit ↔ Sequence (suppressed inside text inputs).

---

## Concepts in detail

### Messages (rows)

A Message is a row in the editor. Each Message can hold optional defaults — a default destination (`IP:port`) and default OSC address — used by the **"Send to clips"** button on its row, which propagates those defaults to every existing clip on that Message. Empty Message defaults are skipped, so you can propagate just a port, just an address, etc.

Add a Message with the **`+`** button in the sidebar header or with **Ctrl + T**.

### Scenes (columns)

A Scene is a column. It has:

- A **name** (editable), **color** (color picker), and **notes** (italic text under the name; resize the notes height by dragging the strip at the bottom of any scene header — affects every scene at once for alignment).
- A **Duration** (0.5 – 300 s) and a **Next Mode**:
  - `Off` — duration ends → scene trigger reverts visually; clips keep modulating until you stop them or trigger another scene.
  - `Next` — at duration end, the next non‑empty slot in the Sequence advances.
  - `Random` — at duration end, a different non‑empty slot is picked at random.
- A **MIDI Learn** chip — click "MIDI Learn", play a note/CC, the binding is captured. Click the chip's ✕ to clear; click "MIDI Learn" while waiting to cancel.
- A **trigger button** (top of column) that **fills clockwise over the scene Duration** to give you a visual countdown.

Add a Scene with **+ Scene** at the right of the editor or with **Alt + S**.

### Clips (cells)

Each clip carries the full per‑scene settings for one Message. Open a clip in the Inspector by clicking its tile. Parameters:

- **Destination** — IP and port. **`~def~`** chip means it's linked to the session default; click **Default** to relink it. Editing the field unlinks.
- **OSC Address** — the path (e.g. `/patate/knobs`). Same `~def~` / Default behavior.
- **Value** — typed in raw; auto‑detected at send time:
  - `true` / `false` → OSC bool (`T` / `F`)
  - integer (no dot) → OSC int32
  - number with dot or exponent → OSC float32
  - anything else → OSC string
- **Timing** — **Delay** (0–10 000 ms before the trigger fires) and **Transition** (0–10 000 ms morph time from previous value to this one).
- **Modulation** (collapsed by default — tick the checkbox to expand; pick a **Type** from the dropdown on the title line):

  **LFO** — cycles a chosen waveform:
  - **Shape**: Sine / Triangle / Sawtooth / Square / Random Stepped / Random Smoothed
  - **Mode**: Unipolar (one‑sided sweep, 0–depth) or Bipolar (±depth around center)
  - **Depth**: 0–100%
  - **Rate**: Free (0.01–100 Hz, log‑mapped slider) **or** BPM‑synced to division ticks from `1/128` up to `128/1`, with optional Dotted / Triplet
  - Phase resets on every trigger so shapes start cleanly.

  **Envelope (ADSR)** — multiplicative VCA shape:
  - Attack, Decay, Sustain time, Release + Sustain level
  - **Sync**: Synced (each stage a % of the scene duration, 0.01–100%, auto‑normalized if they overflow) **or** Free (each stage 0–10 000 ms)
  - **Depth**: 0–100% wet/dry mix. 100% = full VCA shape (0 → center → 0); 0% = no effect.

  **Arpeggiator** — walks a ladder derived from the Value:
  - **Steps**: 1–8
  - **Mult Mode**: Division (Value is max; even fractions below), Multiplication (Value is min; doublings above), or Div/Mult (halvings below + doublings above, Value in the middle).
  - **Arp Mode**: Up / Down / Up/Down / Down/Up / Exclusion (neither end repeated) / Walk / Drunk / Random.
  - **Rate**: same Free/BPM/dotted/triplet controls as LFO.
  - **Depth** = how much the ladder replaces the base value.
  - With **Scale 0.0–1.0** on, the ladder is proportionally normalized (max → 1.0) rather than clamped, so Multiplication mode actually sweeps across the unit range.
  - The clip trigger square sweeps clockwise once per full N‑step cycle.

  **Random Generator** — seeded PRNG, outputs reproducibly from the Value as seed:
  - **Type**: Int / Float (1e‑11 precision) / Colour (r,g,b as three int OSC args per token).
  - **Min / Max** range per channel.
  - **Rate**: same Free/BPM/dotted/triplet as LFO.
  - Multi‑value Value fields emit one random per entry (3 per entry in Colour mode).

- **Sequencer** (collapsed by default — tick the checkbox to expand)
  - Steps: 1 – 16 (default 8)
  - **Sync mode**: **Sync (BPM)** — lock to session global BPM; **Sync (Tempo)** — use the clip's own tempo slider; **Free (ms)** — independent step duration.
  - Per‑step values, auto‑detected like the main Value field
  - The currently playing step is highlighted in the inspector and pulses orange. With Modulation also on, the modulator operates on the current step's value.

#### Visual cues

- **Trigger square solid orange** — clip is armed and held.
- **Clockwise orange sweep inside the square** — clip is modulating or sequencing. Sweep period equals the LFO period (or the full sequencer cycle).
- **Live value text in orange** in the cell tile — currently being modulated/sequenced; falls back to the static `value` when stopped.
- **Per‑step pulse** in the Inspector — flashes the current step at the sequencer rate.

### Templates

Right‑click an empty cell to pick from saved Clip Templates ("Empty" creates a default clip). With a clip selected, the **Template** dropdown at the top of the right panel lets you apply existing templates or **Save** the current clip as a new template (a modal asks for a name).

Templates are stored in **localStorage** under `dataflou:clipTemplates:v1`, so they survive app restarts (per‑install — dev mode and the packaged build keep separate stores).

### Sequence view

A 1 – 128 slot grid (configurable via the **Scene steps** input at the top) for laying out scenes in playback order.

- **Drag a scene** from the left palette into a slot.
- **Drag slots** to swap their contents.
- **Click "Clear mode"** then click slots to empty them.
- **Click a filled slot** (outside Clear mode) to focus that scene.
- **Bottom transport** — Play (start the focused scene or the first slot), Pause (freeze auto‑advance — clips keep playing), Stop (morph everything to 0).

### MIDI

Uses the browser's **Web MIDI API** so no native module is needed — Electron's renderer talks to your interface directly. Pick your controller from the **MIDI** dropdown in the toolbar.

- **Note On (velocity > 0)** and **CC (value > 0)** trigger bindings.
- **MIDI Learn**: click the Learn button on a scene or message row, play a note/CC. Click "cancel" while waiting to back out.
- Clip triggers fire **the cell for that message in the focused scene**. Click a scene column to focus it.

### Transport (top right)

- **Edit / Sequence** — view tabs (also Tab key).
- **Stop All** — graceful stop, every active clip morphs to 0 over its `Transition` time. Flashes red.
- **Panic** — instant kill, no morph. Flashes red.

### Themes

10 built‑in themes (selector lives at the bottom of the Sequence view's left palette):

- **Dark** — default; charcoal grey + warm orange, Ableton‑ish.
- **Light** — bright but high contrast (no washed‑out white).
- **Pastel** — dusty rose + lavender, Quicksand/Nunito font.
- **Reaper Classic** — `#1e1e1e` charcoal + Reaper blue accent.
- **Smooth** — low‑contrast warm greys.
- **Hydra** — desaturated blue‑grey + cyan accent.
- **DarkSide** — near‑black + hot red‑orange.
- **Solaris** — deep blue + sky accent.
- **Flame** — FL‑Studio‑inspired, dark grey + signature FL orange.
- **Analog** — X‑Raym‑style warm browns + cream + Georgia serif.

Selection is per‑install (UI preference, not saved with sessions).

---

## Sessions

Saved as plain JSON via the standard OS save dialog (suggested extension `.dflou.json`).

Contents:

- Session name, default OSC address & destination, global BPM, tick rate, sequence length
- All Messages (with their per‑message defaults and MIDI bindings)
- All Scenes (name, color, notes, duration, next mode, MIDI binding) and the cells inside them
- The 128‑slot sequence
- Selected MIDI input device name

The Save button **flashes blue** on a successful write.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **Tab** | Toggle Edit ↔ Sequence (suppressed inside text fields) |
| **Ctrl + T** *(Cmd + T on macOS)* | Add a Message |
| **Alt + S** | Add a Scene |
| **Esc** | Close any open modal / cancel MIDI Learn |
| **Ctrl + drag** *(Cmd + drag on macOS)* a clip onto an empty cell | Duplicate that clip |
| **Right‑click** an empty cell | Open the Clip Template menu |

---

## Architecture

- **Electron 33 / electron‑vite / TypeScript / React 18 / Tailwind / Zustand**
- **Main process (Node)** — owns UDP sockets, the scene engine, fixed‑tick LFO + sequencer, file I/O. Pure logic so timing stays stable independent of the UI.
- **Renderer process** — all UI, Web MIDI input handling, drag‑drop sequence grid (`@dnd-kit`), live state mirror of the engine.
- **Preload** — typed `window.api` bridge (`contextIsolation: true`, `nodeIntegration: false`).

```
src/
├── main/         # Electron main: UDP, scene engine, MIDI, file I/O, IPC
├── preload/      # window.api bridge
├── shared/       # types & factories used by main and renderer
└── renderer/
    ├── components/  # React UI
    ├── store.ts     # Zustand global state
    ├── midi.ts      # Web MIDI manager
    └── styles.css   # Tailwind + theme CSS variables
```

---

## Project status

This is a v1 personal tool by [Vincent Fillion](https://vincentfillion.com). It runs end‑to‑end and is daily‑driver usable, but a few things are intentionally out of scope for now:

- No undo / redo
- No MIDI output (MIDI is input‑only for triggering)
- No OSC bundles with timestamps (each tick sends individual messages)
- No quantized scene changes
- No auto‑save / crash recovery

Issues and PRs welcome.

---

## License

ISC — do whatever you want, no warranty.
