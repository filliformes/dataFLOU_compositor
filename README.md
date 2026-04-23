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
- **Five modulation types** — pick per clip: **LFO**, **Ramp**, **Envelope (ADSR)**, **Arpeggiator**, **Random Generator**.
- **Sequencer (1–16 steps)** — cycles through per‑step values at BPM (session‑locked), Tempo (per‑clip slider), or Free (ms). With Modulation also on, the modulator operates on the current step value.
- **Transitions** morph the previous clip's value into the new one over a configurable time, even while the LFO keeps running.
- **Ableton‑style follow actions** — Stop / Loop / Next / Previous / First / Last / Any / Other, plus a per‑scene **×Multiplicator** (how many times the scene plays before the follow action fires).
- **Sequence grid** — 1–128‑step drag‑laid sequence in the Sequence view, with a floating drag preview while you drop scenes into slots.
- **Meta Controller** — **32 knobs across 4 banks** (A B C D). Each knob has a user name, min/max range, a **Smooth (ms)** time to interpolate between values, one of **14 output curves** (linear, log, exp, geom, ease‑in, ease‑out, cubic, sqrt, sigmoid, smoothstep, dB taper, gamma, step, invert), up to **8 OSC destinations** broadcasting simultaneously, and MIDI CC learn. Dial position = what leaves the socket — smoothing is visible, not just sent.
- **Cue system** — arm a scene as "next", fire it with **GO** / **Space** / MIDI. Optional auto‑advance to the next sequence slot after each GO; turns a linear show into Space‑Space‑Space.
- **Scene‑to‑scene Morph** — one knob in the transport glides every cell from scene A to scene B over N ms, fading orphan tracks out at the same rate. Per‑scene override plus MIDI CC control (0..127 → 0..10 000 ms).
- **Show / Kiosk mode** — locks the UI into a performance view (F11, hold Escape to exit). Hides all editing chrome, pulses a discreet banner, keeps transport + GO + Tab visible.
- **Autosave + crash recovery** — silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/`, keeps 30 rolling copies. On next launch after an unclean shutdown, offers to restore.
- **OSC monitor drawer** — optional bottom panel streams outgoing OSC in real time (ip:port · address · args), filterable, pausable. Toggle with **Caps Lock** or the **OSC** button next to the brand.
- **Transport bar** — always visible at the bottom: Play / Pause / Stop (colored by active state), cue GO, Morph enable + ms, selected scene readout, **live HH:MM:SS:MS time counter** (starts on Play, freezes on Pause, resets on Stop).
- **Clip Templates** — save full clip configs and apply them to empty cells via the right‑click menu or the Template dropdown. Persisted in localStorage, survive app restarts.
- **Multi‑select clips** — Ctrl+click adds clips to a disjoint selection; right‑click the selection to bulk‑apply a template or re‑sync every selected clip's OSC to the session defaults.
- **Global MIDI Learn** (Ableton‑style, one button) — enter learn mode, click a scene, clip trigger, or Meta knob, wiggle a MIDI control. Blue overlays show learnables, green = bound.
- **Live value display** — every active clip's current output shows in real time inside its cell tile.
- **UI zoom** — Ctrl+wheel rescales everything below the main toolbar (0.5×–2×). Persisted per‑install.
- **15 themes** — 5 new ones in 0.3.0 (Studio Dark, Warm Charcoal, Graphite, Cream, Paper Light) with bundled Inter / Roboto / Work Sans / IBM Plex Sans fonts.

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
| **Top toolbar** | **dataFLOU** brand button (click to reveal the preferences sub‑toolbar: **Theme** picker + **Enter Show Mode**), **OSC** monitor toggle, session name, file actions (New / Open / Save / Save As), default OSC address & destination, Tick rate, Global BPM, MIDI input picker, **MIDI Learn**, **Edit ↔ Sequence** view toggle, **Stop All**, **Panic**. Shows a pulsing *SHOW — hold Esc to exit* banner when in Show mode. |
| **Transport bar (bottom)** | Play / Pause / Stop (colored by active state), **GO** (cue fire) + auto‑advance toggle, **Morph** enable + ms, selected scene readout, live HH:MM:SS:MS time counter. Always visible in both Edit and Sequence views. |
| **Meta Controller bar** | Toggled via the Inspector's top "Meta Controller" button — sits below the main toolbar, resizable via the handle on its bottom edge. 8 circular knobs + a details pane for the selected knob |
| **Editor** (Edit view) | Left: "Buttons box" (Scenes/Messages counts + add buttons) and Messages sidebar (rows). Center: Scene columns. Right: Inspector panel (top toggles for Notes / Meta Controller / Collapse Scenes / Collapse Messages, then Clip Template dropdown when a cell is selected, then the clip's full parameters) |
| **Sequence view** (the other tab) | Left: resizable palette column holding the scene list (pills auto‑size to their names) + a per‑scene inspector (name / color / notes / duration / Next follow‑action / ×Multiplicator / Delete). Center: 128‑slot drag‑drop sequence grid with floating drag preview. Bottom: status/transport bar (Play / Pause / Stop, focused scene name, message count) |

Tab toggles Edit ↔ Sequence (suppressed inside text inputs).

**Ctrl+wheel** zooms the whole app (except the main toolbar). **Left‑click** on either Collapse toggle flips just that axis; **right‑click** on either flips both (full compact mode).

---

## Concepts in detail

### Messages (rows)

A Message is a row in the editor. Each Message can hold optional defaults — a default destination (`IP:port`) and default OSC address — used by the **"Send to clips"** button on its row, which propagates those defaults to every existing clip on that Message. Empty Message defaults are skipped, so you can propagate just a port, just an address, etc.

Add a Message with the **`+ Message`** button in the "Buttons box" (top‑left of the Edit view) or with **Ctrl + T**. Click a message to select it; **Shift‑click** another to select the range between them. **Right‑click** a message row (or selection) to delete — bulk delete is supported.

### Scenes (columns)

A Scene is a column. It has:

- A **name** (editable), **color** (color picker), and **notes** (italic text under the name; toggle visibility globally via the **Notes** button at the top of the Inspector, and drag the strip at the bottom of any scene header to resize notes across all scenes).
- A **Duration** (0.5 – 300 s) and a **Next** follow‑action (Ableton‑style):
  - `Stop` — at duration end, cells keep modulating but the scene loses its active flag once they settle.
  - `Loop` — re‑trigger the same scene indefinitely.
  - `Next` / `Previous` — walk the sequence grid (wraps).
  - `First` / `Last` — jump to the first / last non‑empty slot in the sequence.
  - `Any` — random pick from every sequenced scene (including self).
  - `Other` — random pick from every sequenced scene except self.
- A **×Multiplicator** (Sequence‑tab inspector only) — how many times the scene plays before the follow action fires. `Stop × 3` plays three times then stops; `Next × 2` plays twice then advances. Default 1.
- A **MIDI Learn** chip — click "MIDI Learn", play a note/CC, the binding is captured. Click the chip's ✕ to clear.
- A **trigger button** (top of column) that **fills clockwise over the scene Duration** to give you a visual countdown.

Add a Scene with the **`+ Scene`** button in the "Buttons box" or with **Alt + S**. Click a scene to focus it; **Shift‑click** another to select the range. **Right‑click** a scene header (or selection) to delete — bulk delete is supported. **Delete** key in Sequence view also deletes the focused scene.

### Clips (cells)

Each clip carries the full per‑scene settings for one Message. Open a clip in the Inspector by clicking its tile. Parameters:

- **Destination** — IP and port. **`~def~`** chip means it's linked to the session default; click **Default** to relink it. Editing the field unlinks. **Changing the session default no longer overwrites existing linked clips** — all currently‑linked clips freeze at the old default at the moment of change, so "edit default OSC" only affects clips created after it.
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

  **Ramp** — one‑shot 0 → target glide, then holds:
  - **Ramp time** (Free ms 0.1 – 300 000) **or** scene‑synced **or** Free (synced) with a user‑picked Total (ms).
  - **Curve** (−100 → +100 %): point‑symmetric easing pair. Negative = ease‑in (slow start, fast finish); positive = ease‑out (fast start, slow tail). 0 = linear.
  - **Depth**: 0–100 %; defaults to 100 % the first time Ramp is selected.
  - Inline visualizer draws the curve and animates a live orange dot along it while the clip is playing. After the ramp completes, the clip's sweep icon stops and the trigger square settles into solid orange (still armed, no longer updating).

  **Envelope (ADSR)** — multiplicative VCA shape:
  - Attack, Decay, Sustain time, Release + Sustain level
  - **Sync**: Synced (each stage a % of scene duration), Free (each stage 0–10 000 ms), or **Free (synced)** — stages as % of a user‑picked **Total (ms)**, independent of the scene duration.
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

### Templates & bulk clip actions

- **Right‑click an empty cell** → pick from saved Clip Templates ("Empty" creates a default clip).
- **With a clip selected**, the **Template** dropdown at the top of the Inspector lets you apply existing templates or **Save** the current clip as a new template (a modal asks for a name).
- **Ctrl‑click clips** to build a disjoint multi‑selection across any scene/message combination. **Right‑click any selected clip** to open a menu that operates on every selected clip at once:
  - **Apply template** → bulk‑apply a saved template.
  - **Use Default OSC** → overwrite OSC address + destination on every selected clip with the session's current defaults (and re‑link them, so a future default change will freeze them at the new value).

Templates are stored in **localStorage** under `dataflou:clipTemplates:v1`, so they survive app restarts (per‑install — dev mode and the packaged build keep separate stores).

### Cue system

Live‑performance convention: pre‑arm a scene as the "next" moment, then fire it instantly on a single gesture.

- **Arm a scene** three ways: **right‑click** a scene header / palette pill / sequence slot and pick *Arm as next ▶▶*; **Alt‑click** any of the same; or press **A** with the scene focused.
- An armed scene shows a pulsing blue ring + `▶▶` chevron on both the palette pill and the sequence slot.
- **Fire it** with the **GO** button in the transport bar, with **Space**, or with a MIDI note / CC bound to GO via global MIDI Learn.
- **Next (auto‑advance arm)** — tick the `Next` checkbox next to GO to automatically arm the next non‑empty sequence slot after each fire. Turns a linear show into Space‑Space‑Space.
- State is ephemeral — arming doesn't save with the session, since "what's armed next" is a current‑run concern, not a compositional one.

### Scene‑to‑scene Morph

A single transport knob that turns every scene trigger from a snap into a glide.

- **Enable + duration** live at the bottom of the screen (`[Morph] [____] ms`).
- When on, every scene trigger (click, Space, GO, 1–9/0 hotkeys, MIDI) morphs every cell over the configured time, AND fades any tracks that were active in the previous scene but have no cell in this one (orphans) out over the same time. So A → B in 8 s converges the whole sonic picture onto B's state.
- **Per‑scene override** — each scene has a **Morph‑in (ms)** field in the Sequence view's scene inspector. Leave blank to follow the transport; set a value (including 0 for a hard snap) to pin THIS scene's glide regardless of transport.
- **MIDI‑learnable** — bind a CC to the Morph time; sweeping the knob maps 0..127 → 0..10 000 ms and auto‑enables Morph.
- A thin blue progress strip along the top of the transport bar shows the morph in flight.

### Show / Kiosk mode

Locks the UI into a performance view. Enabled from the preferences sub‑toolbar (*Enter Show Mode* button) or with **F11**.

- **Hides** all authoring chrome: Messages sidebar, scene add buttons, clip inspectors, file menu, modulation inspectors. Keeps: transport, GO button, scene palette, sequence grid, Meta Controller knobs (read‑only, still twistable), OSC Monitor toggle.
- A pulsing red *SHOW — hold Esc to exit* banner lives centered in the top toolbar so you always know you're in show mode.
- **Exit**: hold Escape for ≥ 800 ms, or press **F11** again. Short Esc taps still close menus.
- **Tab** works to switch Edit ↔ Sequence views so you can hide the grid vs. show the message‑level detail mid‑performance.

### OSC monitor

A bottom drawer that streams outgoing OSC traffic for debugging.

- Toggle with **Caps Lock** or the compact `OSC` button next to the **dataFLOU** brand label in the top toolbar.
- Rolling log of the last 1000 messages: timestamp · `ip:port` · address · args.
- Filter by substring (any match on address or `ip:port`), pause capture, clear, auto‑scroll sticks to the bottom until you scroll up.
- Main‑process batches sends every 50 ms to keep IPC volume bounded even at 120 Hz tick rate.

### Autosave + crash recovery

- Every 60 s (while the session has changed), a silent snapshot is written to `~/AppData/Roaming/dataFLOU/autosave/<name>-<timestamp>.dflou.json` (on macOS: `~/Library/Application Support/dataFLOU/autosave/`).
- Keeps the most recent **30** copies; older ones are pruned automatically.
- A `.running` sentinel file is written on app.ready and deleted on quit. If it's still there on the next launch, the previous run didn't exit cleanly — the app pops a **Restore from autosave?** modal listing the newest snapshots.
- One final autosave fires on quit to catch last‑second edits.

### Meta Controller

**32 knobs across 4 banks (A, B, C, D)** — 8 per bank. Toggled from the Inspector's top **Meta Controller** button. Lives as a resizable strip immediately below the main toolbar, with a vertical **Banks** selector between the knob row and the details panel.

Per‑knob parameters:

- **Name** — free text.
- **Min / Max** — output range, any float, positive or negative.
- **Smooth (ms)** — when a new target arrives (drag or MIDI), the knob tweens from its current visible position toward the target over this many milliseconds at ~60 Hz, firing OSC on every frame. Smooths MIDI CC stair‑stepping into a continuous ramp. 0 = instant.
- **Curve** — one of 14 shapes applied to the normalized position before mapping into [min, max]:
  - `Linear` — straight line.
  - `Log` / `Exp` — fast‑then‑slow / slow‑then‑fast.
  - `Geom` — true log‑space interpolation (constant ratio; use for frequency 20→20000 Hz or amplitude 0.01→1).
  - `Ease‑in (t²)` / `Ease‑out` / `Cubic (t³)` / `Square root` — polynomial curves.
  - `Sigmoid (S)` / `Smoothstep` — S‑curves (logistic vs. Hermite).
  - `dB taper (audio)` — 60 dB perceived‑linear volume.
  - `Gamma 2.2 (brightness)` — perceived‑linear brightness.
  - `Step` — snap to 8 discrete levels.
  - `Invert` — flips the range.
- **MIDI** — assign a CC via global MIDI Learn or the knob's own Learn flow. While bound, incoming CC (0..127) drives the knob position; outgoing OSC follows the same smoothing path the UI shows.
- **Destinations** — up to 8 OSC destinations (IP + port + address), each with a mute checkbox. One knob move blasts to every enabled destination simultaneously.
- **Dragging** — click + drag vertically; **Shift** = fine (×4 slower); **double‑click** = reset to 0. Cursor disappears during drag (Ableton‑style).

### Sequence view

A 1 – 128 slot grid (configurable via the **Scene steps** input at the top) for laying out scenes in playback order. Left column is user‑resizable (drag its right edge).

- **Scene palette** (top of the left column) — each scene as a pill that auto‑sizes to its own name. Click to focus, Shift‑click to range‑select, drag to drop into a grid slot (with a floating drag preview following the cursor).
- **Scene inspector** (bottom of the left column, appears when a scene is focused) — edit name / color / notes / Duration / Next follow‑action / **×Multiplicator**, or Delete.
- **Drag slots** to swap their contents.
- **Click "Clear mode"** then click slots to empty them.
- **Click a filled slot** (outside Clear mode) to focus that scene.
- **Bottom transport** (now global — visible in BOTH Edit and Sequence views): Play / Pause / Stop buttons (colored by active state), Cue **GO** + Next‑auto toggle, **Morph** enable + ms, selected scene readout, live **HH:MM:SS:MS time counter** (starts on Play, freezes on Pause, resets on Stop).

### MIDI

Uses the browser's **Web MIDI API** so no native module is needed — Electron's renderer talks to your interface directly. Pick your controller from the **MIDI** dropdown in the toolbar.

- **Note On (velocity > 0)** fires scene / clip trigger bindings.
- **CC** (any value including 0) drives **Meta Controller knobs** continuously. CC > 0 also fires scene / clip trigger bindings.
- **Global MIDI Learn** (button in the main toolbar): click it, then click any scene trigger, clip trigger, or Meta knob — the next MIDI message you send binds it. Stays in learn mode so you can chain several bindings; click the button again to exit.
- **Per‑knob Learn** — each Meta knob also has its own Learn button in the details panel for one‑shot binding without using global learn mode.
- Knob CC values are routed through the smoother, so the OSC ramp you hear matches the dial position on screen even when the controller is emitting chunky CC steps.
- Clip triggers fire **the cell for that message in the focused scene**. Click a scene column to focus it.

### Transport (top right)

- **Edit / Sequence** — view tabs (also Tab key).
- **Stop All** — graceful stop, every active clip morphs to 0 over its `Transition` time. Flashes red.
- **Panic** — instant kill, no morph. Flashes red.

### Themes

15 built‑in themes (picker lives in the preferences sub‑toolbar — click the **dataFLOU** brand button at the top‑left to reveal it). Each theme sets colors + radius + typography. Fonts are bundled as woff2 (`Inter`, `Roboto`, `Work Sans`, `IBM Plex Sans`) so everything works offline.

**New in 0.3.0** (listed first in the picker):

- **Studio Dark** — canonical DAW dark. `#1E1E1E` bg, `#2A2A2A` panels, inset inputs (`#151515` — darker than the panel), warm orange `#FF8E0F`, Inter with `ss01` + `cv11` tuning for an Ableton‑Sans‑ish feel. **Default**.
- **Warm Charcoal** — same DNA as Studio Dark, warmer neutrals, Inter.
- **Graphite** — cool flat dark, Bitwig‑ish, Roboto.
- **Cream** — warm paper light, burnt‑orange accent, IBM Plex Sans.
- **Paper Light** — cool grey canvas with pure‑white panels, light‑grey inset inputs, Figma blue, Work Sans.

**Original themes** (kept intact):

- **Dark** — charcoal grey + warm orange.
- **Light** — bright but high contrast.
- **Pastel** — dusty rose + lavender, Quicksand/Nunito font.
- **Classic** — `#1e1e1e` charcoal + blue accent.
- **Smooth** — low‑contrast warm greys.
- **Hydra** — desaturated blue‑grey + cyan accent.
- **DarkSide** — near‑black + hot red‑orange.
- **Solaris** — deep blue + sky accent.
- **Flame** — dark grey + hot orange.
- **Analog** — warm browns + cream + Georgia serif.

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
| **Space** | **GO** — fire the armed scene; if none, trigger the next non‑empty slot. Suppressed inside text fields. |
| **A** | Arm / unarm the focused scene as the next cue |
| **1 – 9 / 0** | Trigger scenes 1–10 in the sequence directly |
| **Enter** (in a clip's Value field) | Commit the new value AND re‑trigger the clip (modulation + sequencer restart from 0) |
| **. / Shift + .** | Stop All (graceful) / Panic (instant) |
| **F11** | Toggle Show / Kiosk mode |
| **Esc** (hold ≥ 800 ms) | Exit Show mode. Short taps still close menus / cancel MIDI Learn. |
| **Caps Lock** | Toggle the OSC monitor drawer |
| **Tab** | Toggle Edit ↔ Sequence (suppressed inside text fields, stays active in Show mode) |
| **Ctrl + T** *(Cmd + T on macOS)* | Add a Message |
| **Alt + S** | Add a Scene |
| **Delete** | In Sequence view, delete the focused scene |
| **Ctrl + wheel** | Zoom the whole app (except the main toolbar), 0.5×–2× |
| **Ctrl + drag** *(Cmd + drag on macOS)* a clip onto an empty cell | Duplicate that clip |
| **Ctrl + click** a clip | Add / remove it from the disjoint multi‑selection |
| **Shift + click** a scene or message | Extend range selection from the anchor |
| **Alt + click** a scene / palette pill / sequence slot | Arm that scene as the next cue (toggle) |
| **Right‑click** an empty cell | Open the Clip Template picker |
| **Right‑click** a filled clip (or multi‑selection) | Apply template / Use Default OSC menu |
| **Right‑click** a scene header / palette pill / sequence slot | Arm as next ▶▶ · Delete (bulk if multi‑selected) |
| **Right‑click** a message row | Delete message menu (bulk if multi‑selected) |
| **Right‑click** a Collapse toggle | Flip BOTH Collapse Scenes + Collapse Messages together |
| **Shift + drag** a knob | Fine adjustment (×4 slower) |
| **Double‑click** a knob | Reset to 0 |

---

## Architecture

- **Electron 33 / electron‑vite / TypeScript / React 18 / Tailwind / Zustand**
- **Main process (Node)** — owns UDP sockets, the scene engine, fixed‑tick LFO + sequencer, file I/O. Pure logic so timing stays stable independent of the UI.
- **Renderer process** — all UI, Web MIDI input handling, drag‑drop sequence grid (`@dnd-kit`), live state mirror of the engine.
- **Preload** — typed `window.api` bridge (`contextIsolation: true`, `nodeIntegration: false`).

```
src/
├── main/         # Electron main: UDP (osc.ts), scene engine, file I/O, autosave, IPC
│   ├── engine.ts        # fixed-tick scene engine + OSC output (20–120 Hz)
│   ├── osc.ts           # UDP sender + rate-limited error logging
│   ├── session.ts       # Save / Save As / Open dialogs + JSON I/O
│   ├── autosave.ts      # 60 s rolling snapshots + crash-recovery sentinel
│   └── index.ts         # window creation, IPC handler wiring
├── preload/      # window.api bridge (contextIsolation + typed ExposedApi)
├── shared/       # types & factories used by main and renderer
└── renderer/
    ├── components/    # React UI
    │   ├── TopBar / TransportBar / OscMonitor / CrashRecoveryPrompt / ErrorBoundary
    │   ├── EditView / TrackSidebar / SceneColumn / CellTile / Inspector
    │   └── SequenceView / MetaControllerBar / MetaKnob / Modal / ResizeHandle
    ├── fonts/         # bundled woff2 for themes (Inter, Roboto, Work Sans, IBM Plex Sans)
    ├── store.ts       # Zustand global state (session + ephemeral UI state)
    ├── metaSmooth.ts  # renderer-side knob-value tweener (rAF-driven, fires OSC)
    ├── midi.ts        # Web MIDI manager
    └── styles.css     # Tailwind + theme CSS variables + @font-face declarations
```

---

## Release notes — 0.3.5

Live‑performance polish + new modulator + scene gliding.

### Performance workflow
- **Cue system** — arm a scene as next (right‑click / `A` key / Alt‑click), fire with **GO** / **Space** / MIDI. Auto‑advance arm turns a linear show into a single‑finger walkthrough.
- **Scene‑to‑scene Morph** — transport‑level knob glides every cell over N ms on scene change, fading orphan tracks out synchronously. Per‑scene override + MIDI CC mapping (0..127 → 0..10 000 ms).
- **Show / Kiosk mode** — F11 toggle, hold‑Esc exit, hides all edit chrome while keeping transport + GO + Tab + Meta knobs live.
- **Global transport bar** — always visible in both Edit and Sequence views. Play / Pause buttons now colored by state (grey → accent while playing, grey → blue while paused). Added GO, Morph, and a live **HH:MM:SS:MS time counter**.
- **Performance hotkeys** — `1–9/0` direct scene fire, `Space` GO, `A` arm, `.` / `Shift+.` Stop All / Panic, `Caps Lock` OSC monitor, `Enter` in a clip's Value re‑triggers the clip.

### New modulator
- **Ramp** — one‑shot 0 → target glide, then hold. Free (ms) / Synced (scene) / Free (synced) modes; `Curve` (−100..+100 %) for ease‑in / linear / ease‑out; live SVG visualizer with orange progress dot; depth defaults to 100 %.
- **Envelope — Free (synced)** — third sync option: stages as % of a user‑picked Total (ms), independent of scene duration.

### Autosave + recovery
- Silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/` (30 rolling copies). Sentinel file detects unclean shutdowns and prompts to restore on next launch.

### OSC monitor
- Bottom‑drawer log of outgoing OSC traffic; filterable, pausable, auto‑scrolled. Toggle with **Caps Lock** or the `OSC` button next to the brand label. Main‑process batches sends every 50 ms to keep IPC bounded.

### Meta Controller expansion
- **32 knobs across 4 banks (A / B / C / D)**. Vertical bank selector between the knob row and the details pane. Each bank is a separate 8‑knob page.

### Stability + safety
- **Windows freeze fix** — rate‑limited main‑process `console.error` on hot paths; previously a failing OSC destination at 120 Hz × N cells could flood stderr fast enough to block Node's stdout pipe and freeze both the app AND the dev‑server terminal simultaneously.
- **Session updateSession IPC coalesced** on `requestAnimationFrame` — bursts of state mutations produce ONE IPC per frame instead of one per change.
- **SceneColumn hook‑order fix** — useState / useEffect for the context menu were living below a defensive early return; hoisted above to prevent rules‑of‑hooks failures on scene deletion.
- **OSC pre‑ready queue bounded** to 1024 entries and drained on port error, so a UDP socket that fails to bind can't leak memory.
- **`session.ts` `JSON.parse` wrapped** — malformed session files now surface a friendly error instead of a raw SyntaxError across IPC.
- **`applyClipTemplate`** — new ramp field now deep‑cloned on template apply so edits never mutate shared state.
- **`newSession` / `setSession`** — ephemeral UI state (armed cue, selection arrays, transport timer, MIDI learn target) now properly reset on Open / New.
- **Root‑level ErrorBoundary** — renderer throws show an in‑place error panel with message + stack instead of a blank window.

### Misc
- **Minimum‑width clip tile** now shows the OSC address on the primary row (not cropped). `ip:port` demoted to secondary.
- **Session name / Tick / BPM inputs shrunk** so Panic stays on‑screen at narrow widths.
- **Ramp / Morph progress dots** re‑subscribe reliably to per‑cell play state (fixed stale‑selector bug that hid the live dot).
- **View‑toggle button** (Edit ↔ Sequence) returned to the top toolbar; visible in Show mode too.

---

## Release notes — 0.3.0

Big UI + features pass.

- **Meta Controller** bank — 8 knobs, 14 curves, per‑knob smoothing, MIDI CC learn, up to 8 OSC destinations per knob.
- **Ableton‑style follow actions** (Stop / Loop / Next / Previous / First / Last / Any / Other) + per‑scene **×Multiplicator**.
- **Multi‑select** everywhere — Shift‑click for scene / message range, Ctrl‑click for disjoint clip selection; right‑click bulk‑deletes or bulk‑actions (template apply, default‑OSC reset).
- **Default OSC bug fix** — editing the session default no longer rewrites every existing linked clip. Existing clips freeze at their previous address; only new clips get the new default.
- **Clip right‑click menu** with `Apply template` + `Use Default OSC`.
- **5 new themes** (Studio Dark, Warm Charcoal, Graphite, Cream, Paper Light) with bundled Inter / Roboto / Work Sans / IBM Plex Sans fonts.
- **Theme picker** moved to a preferences sub‑toolbar behind the **dataFLOU** brand button.
- **Collapse Scenes / Messages** — independent by default, right‑click either to flip both together. Collapsed scene columns now auto‑size to their content (each scene as wide as its own name).
- **UI zoom** — Ctrl+wheel (persisted 0.5×–2×).
- **Scene inspector in Sequence view** — per‑scene edit panel under the palette, resizable column, draggable drag preview.
- **Notes** — toggle globally via the Inspector's Notes button; hidden by default, one line when enabled, drag to grow.
- **Number inputs cleared** — every bounded number input (Min / Max / Smooth / Delay / Transition / sequencer steps / BPM / stepMs / durations) uses the `BoundedNumberInput` pattern so you can fully delete the value and re‑type it.
- **Cursor hides during knob drag** (Ableton style).
- **Session migration hardened** — MIDI bindings are shape‑validated, tracks get proper defaults, old `nextMode` values auto‑translate (`off` → `stop`, `random` → `any`), and clip‑template application merges over a fresh baseline so older templates with missing fields no longer crash the renderer.

## Project status

This is a personal tool by [Vincent Fillion](https://vincentfillion.com). It runs end‑to‑end and is daily‑driver usable, but a few things are intentionally out of scope for now:

- No undo / redo
- No MIDI output (MIDI is input‑only for triggering)
- No OSC bundles with timestamps (each tick sends individual messages)
- No quantized scene changes (cue firing is immediate; beat‑locked GO is a future feature)

Issues and PRs welcome.

---

## License

ISC — do whatever you want, no warranty.
