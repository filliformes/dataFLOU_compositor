# dataFLOU_compositor

**Send OSC and MIDI data to many destinations as triggerable scenes.** A rotated‑Ableton‑Session‑style editor that fires multiple OSC bundles + MIDI messages at once with modulation, sequencing, transitions, delays, MIDI input control, an authorable **Pool of Instruments and Parameters**, a one‑click **Capture** function that snapshots live OSC / MIDI traffic into Pool Instruments + Saved Scenes, **OSC forwarding** so the compositor can sit in front of Pure Data / Ableton / another machine, **3‑deep undo/redo**, and a **per‑session GUI layout** that re‑opens at exactly the size and shape you left it.

![dataFLOU_compositor — Edit view](docs/images/dataFLOU_Compositor_EditMode.png)

Built as a desktop app for Windows and macOS using Electron + React. Sessions are saved as plain JSON files and round‑trip cleanly between machines.

---

## Table of Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
  - [Run from source](#run-from-source)
  - [Build a Windows installer](#build-a-windows-installer)
  - [Build a macOS dmg](#build-a-macos-dmg-must-run-on-a-mac)
- [How it's organized](#how-its-organized)
- [Concepts in detail](#concepts-in-detail)
  - [Instruments + Parameters (rows)](#instruments--parameters-rows)
  - [Pool drawer](#pool-drawer)
  - [Network discovery (Pool · Network tab)](#network-discovery-pool--network-tab)
  - [Group triggers (Instrument × Scene)](#group-triggers-instrument--scene)
  - [Scenes (columns)](#scenes-columns)
  - [Sequence view + Timeline](#sequence-view)
  - [Transport (bottom bar)](#transport-bottom-bar)
  - [Cue system](#cue-system)
  - [Scene‑to‑scene Morph](#scene-to-scene-morph)
  - [Clips (cells)](#clips-cells)
  - [Sequencer — 9 modes](#sequencer--9-modes)
  - [Generative mode](#generative-mode)
  - [Modulators — 8 types with live visuals](#modulators--8-types-with-live-visuals)
  - [Smart Scale 0.0 – 1.0 (auto‑range)](#smart-scale-00--10-auto-range)
  - [Hold vs Last rest behaviour](#hold-vs-last-rest-behaviour)
  - [Multi‑arg parameters + pinned slots](#multi-arg-parameters--pinned-slots)
  - [Templates & bulk actions](#templates--bulk-actions)
  - [OSC monitor](#osc-monitor)
  - [Autosave + crash recovery](#autosave--crash-recovery)
  - [Meta Controller (32 knobs, 4 banks, Destination picker)](#meta-controller-32-knobs-4-banks-destination-picker)
  - [Show / Kiosk mode](#show--kiosk-mode)
  - [Themes (15 + rich themes)](#themes-15--rich-themes)
- [Sessions](#sessions)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Release notes](#release-notes--055)
  - [0.5.5](#release-notes--055)
  - [0.5.1](#release-notes--051)
  - [0.5.0](#release-notes--050)
  - [0.4.5](#release-notes--045)
  - [0.4.1](#release-notes--041)
  - [0.4.0](#release-notes--040)
  - [0.3.6](#release-notes--036)
  - [0.3.5](#release-notes--035)
  - [0.3.0](#release-notes--030)
- [Project status](#project-status)
- [License](#license)

---

## What it does

You build a grid of **Instruments** (rows — each Instrument is a typed group of OSC **Parameters**) and **Scenes** (columns). Each cell at the intersection (a "clip") holds the value, modulation, sequencing, and timing parameters that this Parameter will use whenever this Scene is triggered. The big square at the **Instrument × Scene intersection** is a **group trigger** that fires every Parameter under the Instrument at once.

- **One scene trigger** fires every clip in that column simultaneously.
- **Per‑Parameter triggers** let you fire individual messages without launching the whole scene.
- **Per‑Instrument group trigger** at each Instrument × Scene intersection fires (or stops) every child Parameter's clip on that scene as a single gesture. MIDI‑learnable.
- **Hardware Mode (v0.5.5)** — drive any compositor cell's args from a physical OSC controller (Trill bars, MIDI-to-OSC bridges, anything streaming UDP). Per-Instrument-template config: bind to a discovered device, pick **Reset** or **Persist** catch-mode, set catch tolerance + movement threshold, optionally narrow to specific Track instances and specific arg slots. Soft-takeover: the hardware value only takes over once it matches the currently-emitted scene value (or persists across scene changes if you want it to). Movement detection skips static/idle packets. Caught arg values render **red** in the live cell of the currently-playing scene, with a pulsing red dot in the Track sidebar + "HW Mode On" badge under the Instrument. Toggle the same Hardware Mode block from either the Pool inspector OR the grid Instrument inspector — both write the same `template.hardwareMode` blob.
- **Per-sequence-slot overrides (v0.5.5)** — the same scene placed twice in the sequence can now have different durations AND different follow actions per placement. Click any sequencer slot → an accent-bordered **Slot N override** panel appears at the top of the right inspector. Live progress fill + countdown only paints the slot that's actually playing, not every visual instance of the scene. Loop follow-action correctly restarts on the same slot instead of disappearing.
- **Velocity Humanize (v0.5.5)** — 0–100 % jitter slider next to the Velocity field in the Cell Inspector. Engine rolls a fresh random velocity offset on every noteOn (sequencer step OR modulator-driven note edge), so the badge value visibly jitters at the same rate as the audible notes. Live cell badge mirrors the actual emitted velocity (with fixed-width 3-char padding so the number doesn't wiggle the layout).
- **Modulator-driven MIDI re-trigger (v0.5.5)** — Note-mode MIDI cells now fire a fresh noteOn whenever the modulator's value crosses a note boundary, not just on sequencer steps. Lets you drive a synth with a free-running LFO / Random / Chaos modulator and hear every note transition cleanly. Old behavior (one noteOn at trigger, held forever) is gone.
- **Learned MIDI panel (v0.5.5)** — far-right column in the Monitor lists every active MIDI binding in the session (Cue GO, Morph time, Meta knobs, scene triggers, instrument group triggers, per-clip triggers). Each row shows kind + CC/note + channel. Click **Edit** to re-learn OR type a binding inline (kind / number / channel). Resizable, hidden when MIDI traffic is unticked or no bindings exist. Press **L** anywhere to toggle MIDI Learn mode.
- **Native MIDI output (v0.5)** — `@julusian/midi` (RtMidi) lives in the main process. Each cell / track / Parameter blueprint can carry a `midiOut` config (port + channel + CC# / Note + velocity / gate). The same modulators and sequencer that drive your OSC fire MIDI in parallel. Six new MIDI Pool blueprints ship out of the box (CC, Note, CC pair, Drum, DAW macro bank, CC×8 template). Global enable toggle in the prefs sub‑toolbar.
- **Pool drawer with four tabs** — Built‑in, User, **Scenes**, **Network**. Browse shipped Instrument Templates (OCTOCOSME, Generic XYZ, Pandore) and Parameter blueprints (RGB Light, Knob, Motor, Button, XY Pad, MIDI CC, MIDI Note, MIDI CC pair, MIDI Drum, MIDI DAW macros, MIDI CC×8); author your own; recall **Saved Scenes** across sessions; or watch the local network for OSC senders and drag any discovered device onto the grid as an Instrument with one Parameter per observed address.
- **Capture (v0.5)** — one button (or **`C`** key) opens a popup that snapshots live OSC / MIDI traffic into the Pool. Four modes: **New Scene for Instrument** (snapshot current values into an existing Pool Instrument), **New Instrument + Scene** (build both at once), **New OSC Instrument** (just the Pool entry), **New MIDI Instrument** (every wiggled CC / Note becomes a Parameter). Live in‑popup monitor shows the full multi‑arg payload per address with type‑coloured chips + freshness dots. Resizable, X‑remove per address, per‑parameter argSpec auto‑generated from observed OSC tag strings.
- **OSC forwarding (v0.5)** — every UDP packet received on the compositor's listen port is byte‑copied to a configurable LIST of downstream destinations (Pure Data, Ableton, another machine). Lets the compositor sit in front of consumers whose OSC port is fixed (firmware‑locked controllers). Configured via a "Forward" popover in the Default OSC group; per‑target enable + label + IP + port.
- **Pool + Scene libraries (v0.5)** — User Instruments + Parameters persist to `<userData>/pool-library.json` and are auto‑merged into every new / loaded session, so authored instruments follow you across files. Saved Scenes are reusable presets that live in `<userData>/scene-library.json`; drag any Saved Scene anywhere on the grid (including blank space) to instantiate; right‑click in the grid → Save N Scenes to Pool / Duplicate N Scenes works for multi‑selections; Ctrl+click + Del bulk‑delete in the Scenes tab.
- **Saved Scene Inspector (v0.5)** — left‑click any Saved Scene in the Pool to inspect/edit its name, color, notes, duration, multiplier, morph‑in, next‑mode, plus a read‑only Contents breakdown showing every Instrument + Parameter + captured cell value the scene carries.
- **Multi‑value OSC** — space‑separated entries in a clip's Value field become multiple OSC args in a single message. Every modulator treats each entry independently. **Pin individual slots** to freeze them while the sequencer / modulator drives the rest, with a **two‑level pin model (v0.5)**: the Parameter Inspector sets a row default; each clip can override (true / false / inherit) so Scene A can pin a slot while Scene B leaves it modulated.
- **Per‑arg post‑modulation Scaling (v0.5)** — new collapsible section in the Cell Inspector between Values and Timing. Clamps each arg's output to a user‑chosen `[min, max]` band AFTER modulators / sequencer but BEFORE Scale 0.0–1.0 and MIDI Scale. Lets you tame extreme values from a Random / Chaos / Generative source without rewriting the whole sequencer. Per‑cell, per‑arg.
- **3‑deep undo / redo (v0.5)** — Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. Snapshot ring buffer (3 past + 3 future), 500 ms coalesce so typing bursts count as one undoable edit. Buttons live in the prefs sub‑toolbar with depth indicators. History resets on session load.
- **Smart Scale 0.0 – 1.0** — auto‑ranges each parameter's actual min/max into `[0, 1]` instead of blunt‑clamping. Works for sequencer cycles, modulator outputs, even multi‑arg colour channels.
- **Eight modulation types with live visualisations** — **LFO**, **Ramp** (Normal / Inverted / Loop), **Envelope (ADSR)**, **Arpeggiator** (with mode‑aware playback patterns), **Random Generator**, **Sample & Hold**, **Slew**, **Chaos** (logistic map). All share one clock-rate control (Free Hz or BPM-synced with dotted/triplet); per‑modulator preview SVG redraws as you tweak.
- **Nine sequencer modes** — **Steps**, **Euclidean**, **Polyrhythm** (two interlocking rings), **Density** (per‑step probability), **Cellular** (1‑D Wolfram automaton with Seed LFO), **Drift** (Brownian playhead), **Ratchet** (sub‑pulse bursts with 7 shaping modes), **Bounce** (geometrically accelerating step duration), **Draw** (free‑form curve up to 1024 steps). Each has its own inspector preview.
- **Generative mode** — flip a switch on any sequencer and the engine reinterprets the step values through a per‑mode musical rule (Tide, Accent, Voicing, Wave, Crowd, Terrain, Scatter, Bounce). Variation knob controls how far values stray from the user's base.
- **Hold vs Last** rest behaviour — choose whether a muted step keeps emitting the last value (Hold) or replays the previous step's value (Last). Default Hold.
- **Transitions** morph the previous clip's value into the new one over a configurable time, even while the LFO keeps running.
- **Ableton‑style follow actions** — Stop / Loop / Next / Previous / First / Last / Any / Other, plus a per‑scene **×Multiplicator**. Right‑click a scene (or multi‑selection) → **Set Follow Action** and the menu's submenu applies to every selected scene at once.
- **Sequence grid** — 1–128‑step drag‑laid sequence in the Sequence view. **Multi‑select scenes in the palette and drop a single drag** to fill consecutive Scene Steps next to each other in one gesture.
- **Timeline view** — alternate Sequence visualization where each occupied slot becomes a flex block whose width is proportional to its Duration. Live remaining-time + progress fill on every instance of the active scene.
- **Live scene progress everywhere** — Scene Steps and Timeline both fill from 0 → 100% orange across the playing scene's duration, on every visual instance, so you can see exactly where you are even when the scene is placed in multiple slots.
- **Meta Controller** — **32 knobs across 4 banks** (A B C D), with a new **Destination picker** that walks Instrument → Parameter → optional Value‑slot and adds the resolved OSC destination with one click. Each knob still supports user name, min/max range, **Smooth (ms)** time, one of **14 output curves**, up to **8 OSC destinations** broadcasting simultaneously, and MIDI CC learn.
- **Cue system** — arm a scene as "next", fire it with **GO** / **Space** / MIDI. Optional auto‑advance to the next sequence slot after each GO.
- **Scene‑to‑scene Morph** — one knob in the transport glides every cell from scene A to scene B over N ms.
- **Pause freezes scene time** — Pressing Pause freezes the active scene's elapsed time; on Resume the countdown continues from where it was. Visual countdowns in Timeline + transport bar freeze in lockstep.
- **Show / Kiosk mode** — locks the UI into a performance view (F11, hold Escape to exit).
- **Autosave + crash recovery** — silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/`, keeps 30 rolling copies. Writes are atomic so a crash mid‑save can never corrupt the session file.
- **Save‑before‑quit + Save‑before‑new (v0.5)** — clicking the OS X button or the **New** button prompts a "Save before…?" modal with Yes / No / Cancel. Yes overwrites the current file or writes into the project's `Sessions/` folder. No discards. Cancel aborts.
- **Per‑session GUI layout (v0.5)** — zoom, row height, column widths, inspector width, drawer height, and Collapse Scenes / Collapse Instruments flags are saved inside the session file. Re‑opening a session restores the exact layout you saved.
- **Monitor drawer (renamed v0.5)** — bottom panel streams BOTH outgoing OSC AND outgoing MIDI in parallel resizable columns. Per‑data‑column widths drag from the header. Filter + Pause + Clear. Buffers persist across drawer close. Toggle with **O**.
- **Transport bar** — always visible at the bottom: Play / Pause / Stop, cue GO, Morph enable + ms, **live HH:MM:SS:MS time counter** AND a **live remaining‑time pill** for the currently playing scene right next to it.
- **Clip Templates** — save full clip configs and apply them to empty cells.
- **Multi‑select clips** — Ctrl+click adds clips to a disjoint selection.
- **Multi‑select sequence slots** — Shift+click in the Scene Steps grid OR the Timeline extends a contiguous slot range. Right‑click → Clear Scene from N slots / Set Follow Action on every covered scene at once.
- **Global MIDI Learn** — one button. Click a scene, clip trigger, **Instrument group trigger**, or Meta knob, wiggle a MIDI control. Blue overlays show learnables, green = bound.
- **UI zoom** — Ctrl+wheel rescales everything below the main toolbar (0.5×–2×), including the Pool drawer + OSC monitor.
- **17 themes** — including two **rich themes** (Nature, Cream) that swap classic HTML controls for bespoke Rainbow‑Circuit‑flavoured arc sliders, mode icon rows, console‑style readouts, and card‑wrapped inspector sections.

OSC is sent over UDP. The engine runs in the Electron main process at a configurable tick rate (10–300 Hz) so timing stays stable even if the UI is busy.

---

## Quick start

### Run from source

Requires [Node.js](https://nodejs.org) (LTS or newer).

```bash
git clone https://github.com/filliformes/dataFLOU_compositor.git
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
| **Top toolbar** | **dataFLOU** brand button (preferences sub‑toolbar: Theme picker + Enter Show Mode), session name, file actions, default OSC, Tick rate, Global BPM, MIDI input picker, MIDI Learn, **Edit ↔ Sequence** view toggle, Stop All, Panic. |
| **Transport bar (bottom)** | Play / Pause / Stop (colored by active state), GO + auto‑advance toggle, Morph enable + ms, selected scene readout, **live HH:MM:SS:MS time + remaining‑time pill**. Always visible in both views. |
| **Meta Controller bar** | Toggled via the Inspector or **M** — sits below the main toolbar, resizable. |
| **Editor** (Edit view) | Left: Scenes/Instruments header (Add buttons + counts) and Instruments sidebar (Templates with their child Parameters indented under them). Each Instrument header has a `+PARAM` chip and a centered group‑trigger button at every Scene intersection. Center: Scene columns. Right: Inspector panel (toggleable with **I**) — top toggles for Notes / Meta Controller / Collapse Scenes / Collapse Instruments, then Clip Template dropdown when a cell is selected, then the clip's full parameters. |
| **Sequence view** | Left: resizable Scenes palette (200–1200 px) + a per‑scene inspector below it (toggleable with **S**). Center: 128‑slot Scene Steps grid OR Timeline visualization (toggle next to Clear mode), with progress fills + live time on every instance of the playing scene. Bottom: global transport bar. |

**Tab** toggles Edit ↔ Sequence — even from inside text inputs, dedicated to view‑switch only.

**Ctrl+wheel** zooms the whole app (except the main toolbar). **Left‑click** on either Collapse toggle flips just that axis; **right‑click** flips both.

---

## Concepts in detail

### Instruments + Parameters (rows)

The sidebar's vocabulary mirrors the dataFLOU C++ library: each row is either a **Template** (Instrument header) or a **Parameter** (child row that owns clips).

- **A new session opens with one Scene + one Instrument 1 with a child Parameter 1**, ready to send OSC.
- **+ Instrument** in the Scenes/Instruments header (or **Ctrl+T**) creates a new draft Template + one seeded child Parameter.
- **`+PARAM`** chip on the right edge of each Instrument header (or **Ctrl+P** with the Instrument selected) adds another child Parameter.
- **Right‑click a row** for: Add Instrument · Add orphan Parameter · Add Parameter to <X> · Save as Template · Show/Hide Pool · Delete.
- **Drag rows to reorder** them. Templates carry their child Parameters as a contiguous block.
- **Save as Template** flips the draft into a saved User Template in the Pool, re‑instantiable across sessions.

### Pool drawer

Toggle with **P** (also opens the OSC drawer if it's closed) or via the **Show Pool** entry in the Instruments right‑click menu.

- **Built‑in tab** — shipped library.
  - **Instruments**: OCTOCOSME (5 RGB rings + strip RGB), Generic XYZ pad, Pandore.
  - **Parameters**: RGB Light (v3 0–255), Knob (float 0–1), Motor (bipolar ‑1..1), Button (bool discrete), XY Pad (v2).
- **User tab** — your authored Instrument Templates + Parameter blueprints.
- **Network tab** — auto‑discovered OSC senders on the local network (see below).
- **Drag any item onto the Edit‑view sidebar** to instantiate.
- **Click an item** to edit its full metadata in the right‑side Inspector.
- **Pop out** the Pool (`⤢` button or fast double‑click on the title bar) into a centered floating window.

### Network discovery (Pool · Network tab)

Auto‑discovers OSC senders on the local network and lets you drag any device straight onto the grid as an Instrument.

- **Passive UDP listener** — click **Listen** to bind a port (default `9000`, configurable) and the Pool starts logging every sender that hits that port.
- **Discovered devices** show as draggable rows keyed by `ip:port`, with a green/grey activity dot (fresh < 2 s), packet count, and last‑seen age that refreshes every second.
- **Expand a device** to see every OSC address path it has emitted, with its OSC type tags and a short live preview of the latest args.
- **Drag a device onto the Edit sidebar** to materialise it as a user Instrument Template:
  - One Parameter per observed OSC address.
  - **Auto‑typed**: 1× `f`/`i` → float / int / bool / string; 2× numeric → `v2`; 3× → `v3`; 4× → `v4`; OSC type tags from the observed args drive `paramType`. Multi‑arg discoveries get a full `argSpec` with canonical slot names (x/y, x/y/z, x/y/z/w, r/g/b/a for colour with max=255).
  - **Common OSC root extracted** — if half or more of a device's addresses share `/octocosme/...`, the template adopts `octocosme` as its name and `/octocosme` as its base path, with each Parameter's path stripped to the remainder.
- **Status header** shows the listener's bound port + this machine's IPv4 addresses so the user knows exactly what to point their sender at.
- **Drag‑cancel cleanup** — if you start dragging a discovered device and abort (Esc, drop off‑target), the just‑materialised template is removed from the Pool so you don't accumulate orphan Instruments.
- **Clear** wipes the discovered‑device cache (useful after moving networks).
- **Title‑bar dot** stays in sync with bind status even when the Pool drawer is collapsed — green when listening, red on bind error.

The listener stays closed by default so the app doesn't fight other tools for port 9000 unless you ask it to.

### Group triggers (Instrument × Scene)

Templates carry no clips of their own, so the cell at each Instrument header × Scene column intersection is a **centered Play/Stop button** that fires every child Parameter's clip on that scene at once.

- Click → triggers all children that have a clip on this scene.
- Click again (any child playing) → stops every active child of this Instrument on this scene.
- **MIDI‑learnable** — Global MIDI Learn → click the group trigger → wiggle a control.
- Greyed out when no child has a clip on this scene yet.

### Scenes (columns)

A Scene is a column. It has:

- A **name**, **color** (color picker), and **notes** (italic, toggle visibility globally via **Notes**).
- A **Duration** (0.5 – 300 s) and a **Next** follow‑action.
- A **×Multiplicator** (Sequence‑tab inspector only).
- A **Morph‑in (ms)** override.
- A **MIDI Learn** binding.
- A **trigger button** (top of column) that **fills clockwise over the scene Duration**.

#### Adding scenes

- **+ Scene** button in the palette header (or **Alt+S**).
- **+ Silence** button — adds a gray scene with no cells (no OSC fires).
- **Right‑click in the palette's blank area** → Add Scene · Add Scenes…
- **Delete** key with one or more scenes selected.

### Sequence view

A 1 – 128 slot grid for laying out scenes in playback order. Left column is user‑resizable (200 – 1200 px).

- **Scene Steps grid** — 16 columns by default; with > 72 scenes, cells shrink to 28 px min width.
- **Timeline view** — each occupied slot becomes a horizontal block whose width is proportional to its Duration. Click a segment to highlight it; the segment currently playing gets a separate accent ring + live `Xs left` readout.
- **Click a scene** in either view to focus + mark it as the Transport Play start point.
- **Shift+click** extends a contiguous slot multi‑selection.
- **Right‑click a slot or segment** → menu with **Clear Scene** and **Set Follow Action ▸** submenu (bulk‑aware).
- **Drag a slot** to swap its content with another slot.
- **Clear mode** — click any slot to empty it.
- **Live progress fill** — every instance of the currently playing scene fills orange from 0 → 100% across its Duration.
- **Single‑instance highlight** — only the slot that fired gets the accent ring.

### Transport (bottom bar)

- **Play** — Sequence view: starts the sequence from the selected slot. Edit view: plays the focused scene as a one‑shot.
- **Pause** — freezes auto‑advance AND freezes the active scene's elapsed time.
- **Stop** — full stop, clears the slot selection.
- **Time** — running HH:MM:SS:MS counter.
- **Scene remaining** — colored pill with the current scene's color + live countdown.
- **GO** + Next auto‑advance toggle.
- **Morph** enable + ms.

### Cue system

- **Arm** a scene three ways: right‑click → *Arm as next* · Alt‑click · press **A** with the scene focused.
- An armed scene shows a pulsing blue ring + `▶▶` chevron everywhere it appears.
- **Fire** with the **GO** button, **Space**, or a MIDI binding.
- **Next (auto‑advance arm)** — automatically arm the next non‑empty sequence slot after each fire.

### Scene‑to‑scene Morph

A single transport knob that turns every scene trigger from a snap into a glide. Per‑scene override + MIDI CC mapping (0..127 → 0..10 000 ms).

### Clips (cells)

Each clip carries the full per‑scene settings for one Parameter. Open a clip in the Inspector by clicking its tile.

- **Destination** (IP : port, with `~def~` link to session default), **OSC Address**, **Value** (auto‑detected at send), **Delay** + **Transition**.
- **Modulation** (collapsed by default): LFO / Ramp / Envelope / Arpeggiator / Random / Sample & Hold / Slew / Chaos — each with its own live visual.
- **Sequencer** (collapsed by default): 1–16 steps (or 4–1024 for Draw), one of 9 modes, BPM/Tempo/Free sync.
- **Scale 0.0–1.0**, **Rest behaviour** (Hold / Last), per‑arg **Pin** for multi‑value parameters.

#### Visual cues

- **Trigger square solid orange** — clip is armed and held.
- **Clockwise orange sweep inside the square** — clip is modulating or sequencing.
- **Live value text in orange** in the cell tile — currently being modulated/sequenced.
- **Per‑step pulse** in the Inspector — flashes the current step at the sequencer rate.

### Sequencer — 9 modes

Each mode is its own rhythmic / generative engine, picked from a row of pictogram buttons at the top of the Sequencer section.

| Mode | What it does |
| --- | --- |
| **Steps** | Classic 1–16 step cycle. Each step holds its own value; the playhead walks left→right at the sync rate. |
| **Euclidean** | N pulses distributed as evenly as possible across M steps with rotation. Live preview row shows which steps are active. |
| **Polyrhythm** | Two interlocking ring clocks (lengths A and B). Combine mode chooses whether a step fires when A and B coincide, when either fires, or only on the coincidence. |
| **Density** | Per‑step "personality" from a seeded hash + a Density knob (0–100 %). At classic mode, each step's value is multiplied by `(density/100) × hash(step, seed)` so the slider sculpts intensity instead of gating. |
| **Cellular** | 1‑D Wolfram cellular automaton (rule 0–255). The current row's bits decide which steps fire; the row evolves once per cycle. **Cellular Seed LFO** modulates the initial row at a user‑set rate / depth for slow pattern drift. Stable starter seed so the preview looks alive out of the box. |
| **Drift** | Brownian playhead. Each step the head moves back / stays / forward, biased by a slider. Edge behaviour: wrap or reflect. Useful for non‑repeating organic motion. |
| **Ratchet** | Per‑step burst into 2–16 sub‑pulses. **Probability** and **MaxDiv** decide if and how many; **Mode** picks the shape of the burst (**Octaves / Ramp / Inverse / Ping‑pong / Echo / Trill / Random**). **Variation** blends global vs per‑step random. |
| **Bounce** | Step durations shrink geometrically across the row, like a ball settling. **Decay** knob (0–100) controls how fast. Animated SVG ball + splash rings in the preview. |
| **Draw** | Free‑form curve sketcher. Click + drag to draw up to **1024 steps**. **X / Y output range** maps the drawn 0..1 curve onto any numeric span. **Randomize** button rolls a smooth‑stepped random curve as a starting point. With Generative on, the engine regenerates a hash‑varied curve at each cycle wrap based on the user's drawing. |

The 9 mode pictograms read as a row of mini instruments — pick by clicking the icon. Rich themes (Nature, Cream) render the row as a stylised icon picker; standard themes use a dropdown.

### Generative mode

Flip the **Generative** switch on any sequencer and the engine reinterprets every step value through a per‑mode musical rule rooted in a "true artistic world intention." Each rule reads the cell's base value as a seed and shapes the step output around it; the **Variation** knob controls how far the output strays from the base.

| Mode | Generative rule |
| --- | --- |
| Steps | **Tide** — smooth sine swell across one cycle, peak position seeded. |
| Euclidean | **Accent** — hits land harder on the downbeat, off‑beats lighter. |
| Polyrhythm | **Voicing** — Ring A and Ring B sit at different pitch/colour levels, coincidences resonate. |
| Density | **Wave** — gate samples through a sine wave, amplitude knob = swing. |
| Cellular | **Crowd** — cells with crowded neighbours emit louder than lonely ones. |
| Drift | **Terrain** — walker samples a height field shaped by Variation. |
| Ratchet | **Scatter** — burst values picked from a chaotic distribution. |
| Bounce | **Decay envelope** — each step shrinks by `bounceCoeff^i`. |
| Draw | **Live curve** — regenerates a hash‑varied curve at each cycle wrap, anchored to your drawing. |

Generative outputs respect Scale 0.0–1.0 — values stay inside `[0, 1]` even when the base is large.

### Modulators — 8 types with live visuals

Each modulator type has its own SVG preview in the Inspector that redraws as you change its parameters, so you can see the shape before it ever fires.

| Modulator | Reactive controls |
| --- | --- |
| **LFO** | Shape (sine, triangle, sawtooth, square, rndStep, rndSmooth), Mode (bipolar / unipolar), Depth, Rate (Free Hz or BPM‑synced with division dropdown). |
| **Ramp** | One‑shot 0→1 curve with **Mode** (Normal / Inverted / Loop), exponent, Sync (Free / Synced / FreeSync). Live progress dot rides the curve at the engine's actual position. Total time label shown for synced modes. |
| **Envelope (ADSR)** | Attack / Decay / Sustain / Release as percentages of the total time. **Total time label** shown in synced modes. Live progress dot rides the ADSR shape. |
| **Arpeggiator** | Steps (1–8), **Arp Mode** (Up / Down / Ping‑pong / Random / Walk / Drunk / Inclusion / Exclusion / Chord), Multiplication mode (×1, ×2, fractional). Visual shows the ladder for the chosen mode with per‑step labels. |
| **Random** | Value type (float / int / colour), min/max, Rate. Output range is normalised under Scale 0.0–1.0 so colour values map cleanly into `[0, 1]` instead of clipping. |
| **Sample & Hold** | Probability (0–100 %), Smooth (cosine‑smoothed stair vs hard stair). |
| **Slew** | Random target at the clock rate, glides toward it with **independent rise / fall half‑life** (1 ms – 60 s each). |
| **Chaos** | Logistic map iterate (`r` 3.4 – 4.0). 3.83 hides the famous period‑3 window. |

All modulators share one clock — **Free Hz** or **BPM‑synced + division** (whole / dotted / triplet). The visualisation respects sync mode so a synced LFO shows the right number of cycles per beat as you slide BPM.

### Smart Scale 0.0 – 1.0 (auto‑range)

Old behaviour: `clamp01()` on every output. A value range of 0..255 collapsed to 0/1.

New behaviour: when **Scale 0.0–1.0** is on, the engine **auto‑ranges the actual cycle's min/max** into `[0, 1]`. The full musical span maps proportionally — a 0..255 RGB byte becomes 0..1 with every intermediate value preserved.

- **Sequencer + Scale** — precomputes the cycle's per‑token min/max (including ratchet sub‑pulses up to maxDiv=16) and normalises into `[0, 1]`.
- **Modulator + Scale (no sequencer)** — predicts the modulator's output range and normalises against THAT, so a Chaos modulator on a base of 100 spans the full `[0, 1]` visually rather than clipping.
- **Plain Scale (no mod, no seq)** — classic clamp.
- **Degenerate range** (all step values identical) — emits the user's actual value clamped into `[0, 1]`, not a flat 0.5 placeholder.

### Hold vs Last rest behaviour

Choose how the engine handles sequencer rests (steps the gate mutes).

- **Hold** (default) — re‑sending the same payload is suppressed; the receiver naturally holds whatever it received last tick. Saves bandwidth and avoids re‑triggering one‑shot receivers.
- **Last** — re‑emits the previous step's value on every rest. Useful for receivers that need a fresh packet to stay alive.

Per cell. Sticks with the session.

### Multi‑arg parameters + pinned slots

Parameters with an `argSpec` (e.g. OCTOCOSME Voice Pots with four pots per voice, or any discovered v3 / v4 / colour) emit multi‑arg OSC bundles.

- **One numeric input per slot** in the cell editor, labelled by name (HAUTEUR1 / r / x / etc.).
- **Each slot has its own pin**: click the pin to freeze that slot at the value shown. Modulators + the sequencer keep running on the unpinned slots; the pinned slot emits its captured value forever until unpinned.
- **Sequencer respects pinned slots** — when the sequencer is on and your step value is a single number, that number is broadcast to every *unpinned* slot. Pinned slots keep their frozen values. Type a multi‑token step (`0.5 0.7 0.9 0.2`) to drive each unpinned slot independently per step.
- **Fixed protocol headers** (argSpec entries declared with `fixed:`, like OCTOCOSME's `sender: "compositor"` and `timestamp: 0`) appear in the pin list as **locked rows with a `FIXED` badge**. The engine bypasses sequencer + modulator on these slots entirely — they always emit their declared value so receivers like Pure Data's `list split 2` can do their job.

This means you can sequence one channel of a multi‑value parameter while leaving the other channels pinned at a hand‑set value, and the receiver's protocol header stays intact even under heavy modulation.

### Templates & bulk actions

- **Right‑click an empty cell** → pick from saved Clip Templates.
- **With a clip selected**, the **Template** dropdown at the top of the Inspector applies templates or saves the current clip as a new template.
- **Ctrl‑click clips** to build a disjoint multi‑selection across any scene/parameter combination.
- **Apply template** → bulk‑apply across the selection.
- **Use Default OSC** → overwrite OSC address + destination on every selected clip with the session's current defaults.

### OSC monitor

A bottom drawer that streams outgoing OSC traffic for debugging.

- Toggle with **O** or right‑click the Instruments column → **Show Pool**.
- **Resizable** — drag the top edge. Max height now adapts to UI zoom so the drawer can't eat the workspace at 2× scale.
- Single‑line title bar — `× close · OSC Monitor · Log N/M · filter input · Live · Clear`.
- Filter by substring, pause, clear.
- Pool pane sits beside the log; each can be hidden independently.
- **Scales with Ctrl+wheel zoom** — Pool tabs, device rows, and OSC log all scale alongside the rest of the app.

### Autosave + crash recovery

- Silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/<name>-<timestamp>.dflou.json`.
- Keeps the most recent **30** copies.
- **Atomic writes** — saves go through `<file>.tmp` then `fs.rename`, so a crash mid‑write can never corrupt the existing session file.
- A `.running` sentinel detects unclean shutdowns; on next launch the app pops a **Restore from autosave?** modal.
- One final autosave fires on quit (serialised with the 60 s tick so concurrent writes can't race).

### Meta Controller (32 knobs, 4 banks, Destination picker)

**32 knobs across 4 banks (A, B, C, D)** — 8 per bank. Toggled with **M** or via the Inspector. Bank selector is a single column of 4 buttons so the bar's footprint stays narrow.

Per‑knob: name, min/max, smooth (ms), curve (14 shapes), MIDI CC binding, up to 8 OSC destinations.

**New Destination picker** in the Destinations row — instead of "+ Destination" creating an empty row you fill in by hand, the picker walks Instrument → Parameter → optional Value‑slot, then `+` commits the resolved destination:

1. **Instrument** dropdown — lists every Instrument header on the current sidebar, plus an "(orphan parameters)" section for un‑grouped Function rows.
2. **Parameter** dropdown — appears after picking an Instrument, lists its child Parameters.
3. **Value** dropdown — appears only when the chosen Parameter has multiple value slots (`argSpec.length > 1`). Pick "All values" to send to the parent address, or pick a specific slot (x / r / HAUTEUR1 / etc.) to suffix the OSC address with a sanitised slot name.

Click **+** to commit. The resolved `destIp`/`destPort`/`oscAddress` is pre‑filled into a new destination row; with no Instrument picked the **+** falls back to the freeform "add empty destination" behaviour. After committing, the Instrument stays sticky so you can rapidly wire several Parameters under the same Instrument.

### Show / Kiosk mode

Locks the UI into a performance view. Enabled from the preferences sub‑toolbar or with **F11**. Hides authoring chrome; keeps transport, GO button, scene palette, sequence grid, Meta Controller knobs. Exit by holding Escape ≥ 800 ms or pressing F11 again.

### Themes (15 + rich themes)

**17 built‑in themes** (picker in the preferences sub‑toolbar). Bundled woff2 fonts so everything works offline.

**Two of them are "rich themes"** — Nature (Hopscotch palette: dark warm grey + olive→teal + orange) and Cream (Peaks palette: cream paper + mustard ochre). When either is active, the inspector swaps several controls for bespoke Rainbow‑Circuit‑flavoured replacements:

- **Mode icon row** — sequencer mode picker becomes a row of 9 mini pictograms (vertical bars for Steps, dots on a circle for Euclidean, two interlocking rings for Polyrhythm, etc.). Active icon glows in the accent hue.
- **Arc slider** — Modulation Rate becomes a half‑circle of warm→cool gradient bars (RcArcSlider).
- **Flat gradient bar** — Sequencer Variation becomes a horizontal tonal sweep with a tip indicator (RcFlatBar).
- **Card‑wrapped sections** — Soft cards group inspector blocks, console‑style readouts for numerics.

Classic themes (Studio Dark, Warm Charcoal, Graphite, Paper Light, plus the original 10) keep the standard HTML controls.

---

## Sessions

Saved as plain JSON via the standard OS save dialog (suggested extension `.dflou.json`).

Contents:

- Session name, default OSC, global BPM, tick rate, sequence length
- All Tracks (Templates + Parameters with their kind/parent/source‑template links), per‑track defaults, MIDI bindings, per‑arg `persistentSlots` / `persistentValues` (pins), `midiOut` defaults
- All Scenes (name, color, notes, duration, follow action, multiplicator, morph‑in, MIDI binding, per‑Instrument group MIDI bindings) and the cells inside them — with every sequencer + modulator field, including drawValues (length 1024), ratchet mode, cellular seed LFO, generative state, rest behaviour, `midiOut`, per‑cell `persistentSlots` overrides, `scalingEnabled` / `scalingMin` / `scalingMax`, etc.
- The 128‑slot sequence
- The Pool (Instrument Templates + Parameter blueprints; builtin entries dedup'd against the shipped library on load)
- Selected MIDI input device name (reopened automatically on load)
- Meta Controller bank state (knobs + MIDI bindings)
- `forwardTargets[]` — OSC fan‑out configuration
- `session.ui` — persisted GUI layout: zoom, row height, column widths, drawer height, collapse flags

In addition, two separate library files live in `<userData>/`:

- `pool-library.json` — User Instruments + Parameters that follow you across sessions. Auto‑merged into every new / loaded session's pool.
- `scene-library.json` — Saved Scenes (capture results + manual saves). Displayed in the Pool's **Scenes** tab; drag onto the grid to instantiate.

Old sessions migrate cleanly via `propagateDefaults()` + `migrateSequencer()` — pre‑v0.4.0 single‑track sessions load as orphan Parameters with no parent; new fields (MIDI Out, persistentSlots, scaling, session.ui) are backfilled with sane defaults.

Saves are **atomic** — the file is written to `<path>.tmp` then renamed, so a crash mid‑write can never corrupt your session. The Save button **flashes blue** on a successful write.

By default, sessions saved via the Save‑before‑quit / Save‑before‑new flow (when no file path is set yet) land in `<project-root>/Sessions/` (or `<install-dir>/Sessions/` in production builds), with a fallback to `<userData>/Sessions/` if the install dir is unwritable.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **Tab** | Toggle Edit ↔ Sequence (works even inside text inputs) |
| **Space** | GO — fire the armed scene; if none, trigger the next non‑empty slot |
| **A** | Arm / unarm the focused scene as the next cue |
| **1 – 9 / 0** | Trigger scenes 1–10 in the sequence directly |
| **Enter** (in a clip's Value field) | Commit the new value AND re‑trigger the clip |
| **. / Shift + .** | Stop All (graceful) / Panic (instant) |
| **F11** | Toggle Show / Kiosk mode |
| **Esc** (hold ≥ 800 ms) | Exit Show mode |
| **M** | Toggle the Meta Controller bar |
| **O** | Toggle the Monitor drawer |
| **P** | Toggle the Pool inside the Monitor drawer (opens drawer if closed) |
| **C** | Open the Capture popup |
| **I** | Toggle the right‑side Inspector panel (Edit view) |
| **S** | Toggle the focused‑Scene info panel (Sequence view) |
| **Ctrl/⌘ + Z** | Undo (3 levels) |
| **Ctrl/⌘ + Shift + Z** *or* **Ctrl/⌘ + Y** | Redo |
| **Ctrl + S** *(Cmd + S on macOS)* | Save the current session |
| **Ctrl + T** *(Cmd + T on macOS)* | Add a new Instrument |
| **Ctrl + P** *(Cmd + P on macOS)* | Add a Parameter to the selected Instrument's group |
| **Alt + S** | Add a Scene |
| **Delete** | Multi‑selected Scenes → bulk delete; otherwise focused scene / selected Instrument(s) |
| **Ctrl + wheel** | Zoom the whole app (except the main toolbar), 0.5×–2× |
| **Ctrl + drag** *(Cmd + drag on macOS)* a clip onto an empty cell | Duplicate that clip |
| **Ctrl + click** a clip | Add / remove it from the disjoint multi‑selection |
| **Shift + click** a scene | Extend range selection from the anchor |
| **Alt + click** a scene / palette pill / sequence slot | Arm that scene as the next cue (toggle) |
| **Right‑click** an empty cell | Open the Clip Template picker |
| **Right‑click** a filled clip (or multi‑selection) | Apply template / Use Default OSC |
| **Right‑click** a palette pill | Arm as next · Set Follow Action ▸ · Delete |
| **Right‑click** a Scene Step or Timeline segment | Clear Scene · Set Follow Action ▸ |
| **Right‑click** a scene column header | Arm · Set Follow Action chips · Delete |
| **Right‑click** an Instrument row | Add Instrument · Add orphan Parameter · Add Parameter to <X> · Save as Template · Show/Hide Pool · Delete |
| **Right‑click** a Collapse toggle | Flip BOTH Collapse Scenes + Collapse Instruments together |
| **Double‑click** the Pool title bar | Pop the Pool out into a floating window (or dock back) |
| **Drag** the floating Pool's title bar | Move the floating window |
| **Shift + drag** a knob | Fine adjustment (×4 slower) |
| **Double‑click** a knob | Reset to 0 |

---

## Architecture

- **Electron 33 / electron‑vite / TypeScript / React 18 / Tailwind / Zustand**
- **Main process (Node)** — UDP sockets (OSC sender + passive discovery listener + byte‑perfect Forwarder), native MIDI output (`@julusian/midi` / RtMidi), scene engine, fixed‑tick LFO + sequencer + all 9 generative modes, file I/O, autosave, Pool library, Scene library, network discovery. Pure logic so timing stays stable independent of the UI.
- **Renderer process** — all UI, Web MIDI input handling, drag‑drop sequence grid (`@dnd-kit`), bespoke SVG modulator visuals, Capture popup, Undo/Redo subscriber.
- **Preload** — typed `window.api` bridge.

```
src/
├── main/
│   ├── engine.ts            # fixed-tick scene engine, 9 sequencer modes, 8 modulators,
│   │                          # cell pin precedence (cell > track > argSpec fixed),
│   │                          # per-arg post-modulation Scaling clamp (10–300 Hz)
│   ├── osc.ts               # UDP OSC sender
│   ├── oscNetwork.ts        # passive UDP OSC discovery listener +
│   │                          # byte-perfect Forwarder (sits in front of Pd/Ableton/etc.)
│   ├── midiOut.ts           # native MIDI output (RtMidi), lazy port open, global enable
│   ├── session.ts           # Save / Save As / Open / Save-to-default (Sessions folder) + atomic JSON I/O
│   ├── autosave.ts          # 60s rolling snapshots + crash-recovery sentinel + serialised writes
│   ├── sceneLibrary.ts      # cross-session SavedScene library (<userData>/scene-library.json)
│   ├── poolLibrary.ts       # cross-session User-Pool library (<userData>/pool-library.json)
│   └── index.ts             # window creation, IPC handler wiring, safeHandle wrapper,
│                              # save-before-quit intercept (app:before-close)
├── preload/
├── shared/                  # types & factories used by main and renderer
│   ├── types.ts             # Session (incl session.ui for GUI layout + forwardTargets),
│   │                          # SavedScene, Cell (incl persistentSlots/scalingMin/scalingMax),
│   │                          # Track, ParamArgSpec, MidiOut, MidiBinding,
│   │                          # OscForwardTarget, DiscoveredOscAddress (incl argValues),
│   │                          # EngineState, ExposedApi, …
│   └── factory.ts           # makeEmptySession, makeBuiltinPool (incl 6 MIDI Pool blueprints),
│                              # buildInitialValueFromArgSpec, generative rules
│                              # (tide/accent/voicing/wave/crowd/terrain/scatter/bounce), …
└── renderer/
    ├── components/
    │   ├── TopBar / TransportBar / OscMonitor / PoolPane / InstrumentsInspectorPane
    │   ├── EditView / TrackSidebar / SceneColumn / CellTile / Inspector
    │   ├── CapturePopup     # 4 modes + live multi-arg monitor + ArgChip / SceneForInstrumentRow
    │   ├── SequenceView / MetaControllerBar (incl DestinationPicker) / MetaKnob
    │   ├── DrawCanvas / ModulatorVisuals (LFO/Ramp/Envelope/Arp/Random/SH/Slew/Chaos)
    │   └── RcModeIcons / RcArcSlider / RcFlatBar  # rich-theme controls
    ├── fonts/
    ├── hooks/sessionIntegrity.ts, useSceneCountdown.ts
    ├── store.ts             # Zustand global state — session, UI state, network devices,
    │                          # poolLibraryCache, sceneLibrary, undo/redo counters,
    │                          # newSessionConfirmOpen, captureOpen, …
    │                          # + buildSessionForSave() helper
    ├── undo.ts              # 3-deep ring buffer subscriber, 500ms coalesce
    ├── metaSmooth.ts        # renderer-side knob-value tweener
    ├── midi.ts              # Web MIDI input manager
    └── styles.css           # incl rich-theme variables + animations
```

---

## Release notes — 0.5.5

A **performance + hardware integration** release. Forty-plus distinct fixes across engine, IPC, layout, MIDI, drag-and-drop, and sequencer. Headlines: **Hardware Mode** (drive any cell's args from a physical OSC controller with catch-mode soft-takeover), **per-sequence-slot overrides** (per-placement duration + follow-action), **velocity Humanize** that visibly rolls at the modulator's note rate, **Learned MIDI panel** with inline binding editor, and a measurable perf pass that removed the per-cell `Object.keys` hot path.

### Hardware Mode

Drive any compositor cell's arg slots from a physical OSC controller (Trill bar, Lemur, custom firmware sending UDP), with soft-takeover that prevents value jumps when the knob position doesn't match the currently-emitted scene value.

Per-Instrument-template config (lives at `template.hardwareMode`, edited from either the Pool's Template Inspector OR the grid's Instrument Inspector — same store action, same blob):

- **Enable** checkbox with a red "ON" badge when active.
- **Device** dropdown — pulls live from the Pool's Network discovery list (whatever's broadcasting OSC at the compositor's listen port). Bind by `ip:port`.
- **Mode** — `Reset on scene change` (default; the user has to re-catch the value of the new scene before HW takes over again) OR `Persist across scene changes` (HW keeps controlling the matching slot even after a scene flip).
- **Catch tolerance %** — how close the hardware value has to be to the currently-emitted scene value before takeover engages. Default ~5 %.
- **Movement Δ %** — minimum change between OSC packets to be considered "moving". Kills the continuous-static streams that a non-moving knob emits.
- **Apply to** — shown when the template has >1 Track instance; checkboxes scope which instances HW controls.
- **Per-Parameter arg locks** — for every multi-arg Parameter on the template, a checkbox row narrows HW control to specific slots (e.g. "HW controls slot 2 only, leave slots 0/1/3 to the scene").

Engine flow (in `src/main/oscNetwork.ts` + `src/main/engine.ts`):

1. `oscNetwork.setOnMessage(...)` hook fires for every incoming OSC packet at the listen port — registered once at app start, fast-paths out instantly when no template has HW Mode enabled (`engine.hasAnyHardwareModeEnabled` cached on every session update).
2. When HW is enabled, the hook routes to `engine.handleHardwareInput(ip, port, address, numericArgs)`. Per-device-per-address movement detection caches the last value + last-change wall-clock, so a controller streaming the same value 200 Hz doesn't trigger catches on "movement" that isn't real.
3. For each matched template's matching Track instance + matching arg slot lock, the engine compares the hardware value to the slot's current `lastSentNumeric` (the engine's most-recent computed value). If they're within `catchTolerance × range`, the slot transitions from "uncaught" → "caught" and the override engages.
4. While caught, every subsequent hardware OSC packet refreshes `hardwareOverride[trackId|slot]`. The per-slot emit loop reads this between pitch-snap and the pin, so HW always wins (except over `argSpec.fixed` protocol prefixes + over user pins, which are still the explicit final say).
5. Scene change fires `clearHardwareCatchIfReset()` — only clears catches when AT LEAST ONE active HW template is in `reset` mode. Persist-mode catches survive scene flips.
6. **Note-edge int-to-float coercion** — when a slot is HW-caught AND its argSpec type is `'i'`, the engine sends as `'f'` instead so the knob's continuous 0..1 value isn't quantized to 0 or 1 on the wire.

Visual feedback (renderer):

- **Caught arg values render red** in the live cell of the currently-playing scene only (inactive scenes stay clean — earlier behavior was confusing because the same template's cells across all scenes lit up red).
- **Red pulsing dot** next to any Track sidebar entry whose template has at least one caught slot.
- **"HW Mode On" badge** in red under the Instrument template label.
- Engine pre-buckets the catch state into `Record<trackId, sortedSlot[]>` on emit so each CellTile only does an O(1) lookup by trackId instead of scanning every key for a prefix match — measurable hot-path win when many cells are on screen.

### Per-sequence-slot overrides

The same scene placed twice in the sequence now behaves as two independent placements. Click any slot in the Scene Steps grid → an accent-bordered **Slot N override** panel appears at the top of the right Scene Inspector with:

- **Duration override (sec)** — independent of the scene's default duration.
- **Follow action override** — Stop / Loop / Next / Previous / First / Last / Any / Other, independent of the scene's default.

Each override is per-slot, not per-scene, so `[Scene1@5s+next, Scene2, Scene1@10s+stop]` plays Scene1 for 5 s → Scene2 → Scene1 for 10 s → stop. The engine tracks `activeSequenceSlotIdx` and uses it in `armSceneAdvance` for duration AND in `advanceScene` for follow-action, both per-slot.

A small accent dot on each slot's grid cell marks placements that have overrides. The Timeline view sizes each segment proportionally to its **effective** duration (override if set, else scene default).

**Bug fixes related to this:**

- `advanceScene` used `seq.findIndex(id => id === current.id)` to determine where to advance from — always returned the FIRST occurrence of a scene, breaking every follow-action when the same scene appeared in multiple slots. Now uses the live `activeSequenceSlotIdx`.
- Loop follow-action used to re-trigger via `triggerScene(id)` without `sourceSlotIdx`, which nulled the slot index and caused the slot's progress bar to vanish on every loop iteration. Now preserves the active slot.
- Multiplicator re-trigger path got the same fix.

### Velocity Humanize

0–100 % jitter slider next to the Velocity field in the Cell Inspector (MIDI output section). Engine math:

```
span = (humanize / 100) × 127
jitter = (Math.random() − 0.5) × span
velocity = clamp(0, 127, round(velocity + jitter))
```

Rolls fresh on every noteOn — which now happens at the modulator's note-edge rate, not just on sequencer steps. The engine's note-edge detector was previously only triggered by `isNoteEdge` (first-tick / step-change / ratchet-sub-pulse), so modulator-only Note cells fired one noteOn and held forever. Now `noteNumberChanged = ts.midiHeldNote !== noteNum` also triggers a noteOff + new noteOn, which is exactly the cadence the user hears.

The cell's MIDI badge displays the actual emitted velocity (from `engine.lastEmittedVelocityByCell[sceneId|trackId]`), padded to fixed-width 3 chars (`  9`, ` 99`, `127`) with `whitespace-pre` + `tabular-nums` so the layout doesn't jiggle as the number crosses digit-count thresholds.

`lastEmittedVelocity` is set AFTER `sendNoteOn` so a humanize-clipped-to-zero velocity (which skips the noteOn to avoid a phantom held note) doesn't lock the badge at 0.

### Learned MIDI panel

Far-right column of the Monitor drawer, visible only when (a) at least one MIDI binding exists in the session AND (b) the MIDI traffic column is on. Lists every active binding:

- Cue GO + Morph time
- 32 Meta knobs across 4 banks
- Per-scene `midiTrigger`
- Per-scene per-Instrument group triggers (`instrumentTriggers[templateId]`)
- Per-clip `midiTrigger`

Each row: source label + name + `CC NN ch N` / `C4 ch N` formatted binding. Two buttons:

- **Edit** — toggles MIDI Learn mode ON and arms this binding as the target (wiggle a controller to re-learn) AND swaps the binding display for an inline editor (kind dropdown + number input + channel input). Click Edit again to exit.
- **✕** — clears just the MIDI link (the trigger / knob stays).

Resizable via a 4 px handle on the left edge (clamped against viewport width so dragging can't push the panel under the Pool). Width persists across drawer toggles via `localStorage[dataflou:monitor:learnedColPx:v1]`. Default 180 px.

Global **L key** toggles MIDI Learn mode (works anywhere outside text inputs).

### Drag-overlay snap-to-cursor

Scene drag in the Sequence palette used to "jump left" relative to the cursor at the moment of grab — dnd-kit's default `draggingNodeRect` chases the overlay's own position as it moves, so the math drifted further from the pointer the longer the user dragged.

Fix: window-level `pointermove` listener writes `{x, y}` into a `dragCursorRef`. Custom `cursorTrackOverlay` modifier reads the ref on every dnd-kit call and returns a transform that places the overlay's center exactly at the pointer, using `activeNodeRect` (stable source rect) instead of `draggingNodeRect`. Primed at drag start from `activatorEvent` so the first frame is already snapped.

### Pool color sync (legacy scenes too)

Editing a scene's color / name / notes / duration / follow-action / multiplicator / morph-in in the Edit view now mirrors to the linked Pool SavedScene immediately. Newly-saved scenes get the link automatically (`linkedSavedSceneId` on the Scene + `linkedSavedSceneId` on instantiation from the Pool). **Legacy scenes** saved before this feature existed get a **name-match backfill** on first edit: if exactly one SavedScene matches the scene's prior name, the link is written and the mirror engages.

### Drag highlight only on the hovered slot

Earlier, dnd-kit's default `rectIntersection` collision detection lit up every droppable whose rect intersected the drag overlay — when the overlay was wider than a slot (long scene names), multiple slots in different rows could light orange simultaneously, and the LEFTMOST one usually won "over". Replaced with `pointerWithin` (matches only droppables the pointer is actually inside), falling back to `closestCenter` when the pointer is in a gap between cells.

Active / selected rings on SlotCells are also suppressed during any drag so the drop hover is the only highlight visible.

### Collapse Instruments — narrower scene columns + per-track row growth

When **Collapse Instruments** is toggled, each Scene column's value side now uses a 4-column compact value grid with `max-w-[180px]` + `overflow-hidden` so multi-arg cells wrap to multiple rows instead of stretching the column horizontally.

**Per-track row height** in compact mode — computed from `track.argSpec` (non-fixed slot count): 1–4 args → 32 px (default), 5–8 → 34 px, 9–12 → 48 px, 13–16 → 62 px. Applied symmetrically in `TrackSidebar` and `SceneColumn` so heights stay aligned. Multi-arg parameters (OCTOCOSME 12-float bundles, etc.) get the vertical room they need; single-arg parameters keep the tight 32 px floor.

### Pitch-snap (live MIDI scale snapping)

Per-cell scale + root in the Cell Inspector. Snaps the post-modulation, pre-pin value to the nearest note in the configured scale, then renormalises back into the cell's note window (`m.noteMin..m.noteMax`).

- **26 scales** grouped into Major modes, Minor modes, Pentatonic, Symmetric, Exotic.
- **12 roots** (C through B).
- 12-bit pitch-class bitmask per scale (OR of the scale's intervals) — snap is a constant-time search across the ±12-semitone window.
- Per-slot snap config: `Cell.pitchSnap = { scaleId, root, slotIdx }`. Only the specified slot gets snapped; other slots emit unmodified.
- Inspector readout shows "N notes in window" so the user can see at a glance whether their note range will land more than one scale degree on a given knob throw.

### Monitor + Pool layout cleanup

- **Toolbars on the same visual line** — both the Monitor's top bar (Clear / OSC / MIDI toggles) and the Pool's tab strip (POOL / Built-in / User / Scenes / Network) have `min-h-[28px]`. Column-header rows (OSC `time | kind | …`, MIDI, Pool `INSTRUMENTS` / `PARAMETERS`) all share `min-h-[20px]` + `items-center` + matching `border-b`.
- **Pool resize clamp** — Pool's `max` width is now `paneRowWidth − MIN_MONITOR − Learned − handles`, computed via a `ResizeObserver` on the pane row. Dragging the Pool wide can't push the Learned panel + MIDI column behind it. OSC↔MIDI resize handle has its own matching clamp.
- **Learned resize clamp** — same pattern; Learned's `max` is `paneRowWidth − Pool − OSC_MIN − MIN_MIDI − handles`. Edit / ✕ buttons can't slip under the Pool.
- **Pane 1 has `overflow-hidden`** as a hard cap so even a misbehaving column can't bleed into the Pool.
- **Resize handles have a pseudo-element pointer-event extension** (`::before` with ±5 px negative offsets) so the visible 4 px stripe has a ~14 px hit area. Applies to every ResizeHandle in the app.

### Horizontal scroll wheel + Shift+wheel

Logitech MX Master 3S (and any mouse with a native horizontal wheel) emits `deltaX` events; the global wheel handler now lets those flow through to whatever scrollable element the cursor is over — no `preventDefault` unless Ctrl (zoom) or Shift (translate to horizontal scroll) is held.

**Shift+wheel** explicitly walks up from the event target to the nearest `overflow-x: auto/scroll` ancestor and applies `deltaY` as `scrollLeft +=`. Lets users without a horizontal wheel scroll Edit grid / Sequence palette wide layouts.

### Performance pass

The user reported general slowness; the audit (`Agent` audit) surfaced three measurable hot paths:

- **CellTile `caughtKey` selector** ran `Object.keys(hardwareCaught).filter(k => k.startsWith(trackId))` per tile per store update — thousands of allocations per second with many cells on screen. Engine now pre-buckets the flat Map into `Record<trackId, sortedSlot[]>` once per emit; selector is O(1) per tile and returns a joined string for stable `Object.is` equality.
- **Hardware Maps leaked** — `hardwareCaught` and `hardwareOverride` (keyed `${trackId}|${slot}`) were never pruned when tracks were deleted. `updateSession` now matches the existing per-track keep-set logic and deletes orphaned entries.
- **OscMonitor buffer trim** — `splice(0, overflow)` ran on every batch push at 500 msg/sec, each splice O(N). Now lets the buffer overshoot to `MAX_ROWS × 2` (2000) before a single splice trims back to 1000. Display path slices to last `MAX_ROWS` at render time. Steady-state per-push work drops from O(N) to O(1).
- **handleHardwareInput fast-path** — cached `hasAnyHardwareModeEnabled` boolean (computed once per `updateSession`) short-circuits the per-packet template filter when no template has HW Mode enabled session-wide. Saves a filter + array allocation per OSC packet (200 Hz+).

### Misc fixes

- **MIDI velocity no longer gets stuck** — `lastEmittedVelocity` moved to after the `sendNoteOn` call so velocity ≤ 0 (humanize jitter clipping) doesn't lock the badge at zero. Note-edge detector also relaxed to fire after gate-timer noteOff (was stuck silent in modulator-only mode with gate length > 0).
- **HW-caught red highlight scoped to active scene only** — was lighting up the same slots across every scene's copy of the parameter. Inactive scenes get an empty caughtSlots Set now.
- **HW-caught slot index off when cell has fixed argSpec prefix** — display token indices were used to look up `caughtSlots` (keyed by engine arg-slot indices). Now CellTile builds a `displayIdx → engineIdx` map (`argTokenMap`) from `track.argSpec` and passes it to CellValueGrid.
- **MIDI badge fixed-width** — `note→vel` padded to 3-char (`  9→ 99`) so digit-count crossings don't wiggle the layout.
- **Scene column shrink** — Follow dropdown is now sized to fit just "Previous" (its widest label); MIDI binding chip moved out of the column header into the Learned panel.
- **Slot Override panel discoverable** — moved to the TOP of the Scene Inspector (was below Notes / Dur / Next, often invisible without scrolling), with an accent border + tinted background.
- **MIDI Monitor `Learned` panel auto-hides** when the MIDI traffic column is unticked.

---

## Release notes — 0.5.1

A small follow‑up to v0.5.0 focused on **scene ergonomics** and **musical MIDI**. Three additions on top of the v0.5.0 feature set:

### Drag‑to‑reorder scenes

- **In the Edit view grid** — grab the top‑edge color strip of any scene column and drag it horizontally. Other columns slide aside in real time; release to drop. The 6 px strip doubles as the visual scene identifier (its colour) AND the drag handle (cursor‑grab on hover). Activation distance is 4 px so a quick click on the strip never starts a stray drag.
- **In the Sequence view palette** — drop a scene pill onto another pill to reorder. Existing pill → slot, slot → slot drag-and-drop behaviours are preserved unchanged; the reorder is just a new "drop target = sibling pill" case in the same `DndContext`.
- **`session.sequence` is preserved on reorder** — sequence slots reference scenes by ID, so reordering the palette doesn't touch the timeline. Multi‑select, arming, focused scene, engine state all key by ID and survive intact.
- New store action: `moveScene(fromIndex, toIndex)` with clamp + no-op-on-equal-indices.

### User‑configurable MIDI note window

Replaces the v0.5.0 hard‑coded C2..C6 `[0..1] → MIDI note` mapping with a per‑Parameter, per‑cell setting.

- New `MidiOut.noteMin` + `MidiOut.noteMax` (defaults 36 / 84 — old sessions unchanged).
- New "Note range" row in the Cell Inspector's MIDI Output section, only visible in Note mode AND when `midiScale || scaleToUnit` is on (the path that does the [0..1] → note mapping). Lets you set the melodic octave window: `60 → 72` for one chromatic octave starting at C4, `48 → 72` for two octaves, etc. Pretty‑name readout (`C4 – C5`) next to the inputs.
- Engine + CellTile live readout both read the new fields with the same fallback semantics, so the on‑screen MIDI byte always matches what's on the wire.

### Pitch snap — 26 scales × 12 roots

Quantises the modulated / sequenced output to the nearest in‑scale semitone in BOTH the OSC and MIDI paths, so a single generative source can drive a hardware synth (MIDI) AND a Pure Data / Max patch (OSC) with the **same** melody.

Where it sits in the pipeline:

```
seq + gen + modulators → Scaling clamp → scaleToUnit → PITCH SNAP → pin → finalVal
                                                                       ↙       ↘
                                                          OSC (stepped [0..1])  MIDI Note
                                                                              (snapped int)
```

- **26 scales**, grouped in 6 `<optgroup>` sections: Diatonic modes (7), Minor variants (2), Pentatonic + Blues (4), Symmetric (3), Chord tones (5), World / exotic (5). Roster spans Western diatonic, jazz, pentatonic/blues, whole‑tone, octatonic, triads + 7ths, Japanese (Hirajoshi, Insen), Hungarian Minor, Phrygian Dominant, Double Harmonic.
- **12‑root picker** (C through B with sharps/flats labelled).
- **Live "N notes in window" readout** under the dropdowns shows the actual snapped degrees inside the configured Note range, so you can see "8 notes: C4 D4 E4 F4 G4 A4 B4 C5" at a glance. Drops to a red warning when the window has zero in‑scale notes.
- Engine uses a **12‑bit pitch‑class mask** (one `|=` per scale interval at snap time) so the per‑tick membership test is one bitwise AND — no per‑candidate `Array.includes`.
- **Snap re‑normalises back to [0..1]** of the Note range window so OSC stays in [0..1] but is now stepped (one position per scale degree). Round‑trips identically to MIDI: the MIDI emit path's `lo + out × (hi − lo) → round` recomputes the exact snapped note we just chose.
- **Per‑arg**: `pitchSnap.slotIdx` (default 0) picks which arg slot gets snapped; the others pass through unchanged. Multi‑arg cells (e.g. `[note, velocity, duration]`) can have pitch quantised while velocity stays continuous.
- **Pin override beats snap** — a pinned slot's value is the user's explicit final‑say and bypasses the snap.
- Backwards‑compatible: `Cell.pitchSnap` is optional; v0.5.0 sessions load unchanged.

### Practical example — same melody to DAW and Pure Data

1. Add a `MIDI Note` Parameter (Pool → MIDI Note blueprint). Port = your DAW's IAC bus. `noteMin = 60, noteMax = 84` (C4..C6).
2. Add a generic `OSC` Parameter pointing at Pure Data on `127.0.0.1:9000` address `/melody/pitch`.
3. Same scene, same cell on both rows. Turn ON Sequencer + Generative (`Tide` metaphor, amount = 0.6). Turn ON `scaleToUnit`.
4. In the MIDI Output section: enable **Scale snap**, Root = `A`, Scale = `Pentatonic Minor`.
5. Hit Play:
   - DAW receives `A4 C5 D5 E5 G5 A5 C6 …` — generative melody in A minor pentatonic.
   - Pure Data receives `0.000 0.125 0.208 0.333 0.583 0.708 0.917 …` on `/melody/pitch` — same melody, normalised so your custom hardware controller sees the values directly in its [0..1] range.

### Files changed since v0.5.0

- `src/shared/types.ts` — `MidiOut.noteMin/noteMax`, `Cell.pitchSnap`, `ScaleId`, `SCALE_INTERVALS`, `SCALE_LABELS`, `SCALE_GROUPS`, `ROOT_LABELS`
- `src/main/engine.ts` — `snapToScale()` helper + the per‑slot pipeline splice; pitch snap respects the cell's MIDI note window
- `src/renderer/src/components/Inspector.tsx` — Note range row + `PitchSnapEditor` component (root/scale dropdowns + live readout)
- `src/renderer/src/components/CellTile.tsx` — MIDI live readout reads `noteMin/noteMax` instead of the hardcoded 36/84
- `src/renderer/src/components/SceneColumn.tsx` — color strip is now the drag handle via `useSortable`
- `src/renderer/src/components/EditView.tsx` — `DndContext` + `SortableContext` around the scene‑columns row
- `src/renderer/src/components/SequenceView.tsx` — `SortableContext` around the palette; pill → pill drop reorders
- `src/renderer/src/store.ts` — new `moveScene(fromIndex, toIndex)` action

---

## Release notes — 0.5.0

The "native MIDI + Capture + libraries + undo" release. On top of v0.4.5's sequencer / modulator / Pool foundation, v0.5 adds a parallel MIDI output engine, a Capture function that snapshots live OSC / MIDI traffic into the Pool, OSC forwarding so the compositor can fan out to multiple downstream consumers, cross‑session Pool + Scene libraries, 3‑deep undo / redo, per‑session GUI layout persistence, a Save‑before‑quit flow, per‑arg post‑modulation Scaling, and a long list of UX + correctness fixes.

### Native MIDI output

`@julusian/midi` (RtMidi) ships in the main process. Every cell / track / Parameter blueprint can carry a `midiOut` config — port name + channel + kind (`cc` / `note`) + cc number or note number + velocity + gate length. The same modulators + sequencer that drive your OSC fire MIDI in parallel.

- **`MidiOutSender`** in `src/main/midiOut.ts` — lazy port open, rate‑limited error logging, panic, `setEnabled(false)` closes every open port.
- **Global MIDI Output toggle** in the prefs sub‑toolbar — zero‑CPU when off (every emit short‑circuits before the native call).
- **Six MIDI Pool blueprints** out of the box: `par_midi_cc`, `par_midi_note`, `par_midi_cc_pair`, `par_midi_drum`, `par_midi_daw_macro_bank`, `tpl_midi_cc8`.
- **Per‑cell MIDI Output section** in the Inspector — Port picker, Channel (1–16 wide enough to read), Kind (CC/Note), CC# / Note number, Velocity (with its own pin), Gate length, Persistent note flag.
- **MIDI Scale** checkbox next to Scale 0.0–1.0 — independent normalisation; scales the cell's `[0, 1]` float into `0–127` for the MIDI emit only.
- **Live MIDI byte** in the cell tile (`ClipMidiLiveValue`) — violet for CC mode, teal for Note mode, always visible above the transport badge so you can read what's going out on the wire at a glance.
- **`ClipTransportBadge`** — OSC / MIDI / OSC+MIDI pill in every clip tile (slate / violet / teal palette).
- **Native module bundling** via `electron-builder`'s `asarUnpack` so the prebuilt `.node` binaries load at runtime on Windows + macOS universal.

### Monitor drawer (renamed from "OSC Monitor")

Bottom drawer now streams BOTH OSC and MIDI in parallel resizable columns.

- **OSC + MIDI checkboxes** at the top of the toolbar; either column can be hidden.
- **Resizable column split** — vertical drag handle between OSC and MIDI panes; widths persist.
- **Per‑data‑column widths** — drag any header's right edge to resize. Per‑column widths persist independently for OSC vs MIDI.
- **Module‑scope IPC buffers** — closing + reopening the drawer keeps the captured history; capture keeps running while the drawer is closed, so reopening shows messages that fired during the closure.
- **Pool pane resizable** via a leftmost drag bar inside the drawer (200–1200 px, persisted).
- **HMR‑safe IPC subscribers** — Vite hot‑reload no longer doubles the log rows.

### Capture function

A one‑click popup that snapshots live OSC / MIDI traffic into the Pool. Opens via the **● Capture** button in the Pool drawer's header, or by pressing **`C`**.

Four modes:

1. **New Scene for Instrument** *(default)* — pick an existing Pool Instrument; the popup watches OSC traffic that matches its addresses and writes a SavedScene seeded with current values. No new Pool entry.
2. **New Instrument + Scene** — capture a discovered sender as a fresh Pool Instrument AND save its current state as a Scene in the library. Two name fields (Instrument + Scene).
3. **New OSC Instrument** — just the Pool Instrument, no Scene.
4. **New MIDI Instrument** — listens for CC / Note events; each unique slot becomes a Parameter with `midiOut` pre‑wired.

Inside the popup:

- **Live capture monitor** — full multi‑arg payload per address, one **type‑coloured `ArgChip`** per slot (strings amber, ints accent, floats white, bools green / muted, nil / blob muted). Freshness dot per row (green < 500 ms, accent < 3 s, muted otherwise).
- **Mirror monitor in "New Scene for Instrument"** — same chip‑row layout against the picked Instrument's Parameters, with `(no traffic yet)` placeholders for addresses that haven't been seen.
- **Resizable popup** via native CSS `resize: both` corner grip — default `640 × min(700, 88vh)`; no persistence so every open starts at the default.
- **X‑remove per address** — clicking ✕ on a captured row excludes it from the resulting Instrument (toggle ↺ to restore).
- **Address list resize handle** at the bottom edge — drag to grow the captured‑addresses scroll box.
- **Drop‑focus fix on close** — modal close no longer leaves Chromium's sticky pseudo‑focus on the popup's inputs.
- **`destPort` defaults to `dev.port`** instead of hardcoded 9000 — works for OCTOCOSME (1986) or any non‑canonical inbox.
- **Full OSC path as Parameter name** — captured `/A/strips/pots` reads as `/A/strips/pots` in the sidebar, not just `Pots` (which used to collide across mixed‑root devices).
- **Multi‑arg argSpec auto‑generated** from observed OSC type tags — every arg becomes an editable `Value N` slot with the matching type. Pin the leading IP‑string / sequence‑int afterwards in the Pool Inspector's Arg Layout.
- **Cell value positional** — captured cells store the FULL token list (including fixed‑slot placeholders) so `tokensWithDefaults` lines up correctly on edit + emit.
- **Mode order**: top row = scene workflows (`Scene for Instrument`, `Instrument + Scene`); bottom row = bootstrap workflows (`OSC Instrument`, `MIDI Instrument`). Name input blank by default; placeholders read `My OSC Instrument`, `New Scene`, etc.

### OSC forwarding (multi‑target fan‑out)

The compositor can now sit IN FRONT of downstream consumers whose OSC port is fixed. Every UDP packet received on the listen port is byte‑copied to a configurable LIST of forward targets.

- **Forward popover** in the Default OSC group of the top toolbar — green dot + `Forward N/M` count chip; click for the popover.
- **Per‑target row**: enable checkbox, label, IP, port, ✕ remove. `+ Add target` button at the bottom.
- **Byte‑perfect** — a second `'message'` listener attached to the listener's `dgram.Socket` captures raw bytes BEFORE osc‑js parses them; forwarded via a dedicated outbound socket so the source port is ephemeral.
- **Persisted with the session** in `session.forwardTargets[]`. Replayed to main on app load.
- **Safe under disable race** — `setForwardTargets([])` mid‑callback re‑checks the socket inside the loop and try/catches the synchronous `ERR_SOCKET_DGRAM_NOT_RUNNING`.

### Cross‑session libraries

#### Pool library (User Instruments + Parameters)

User‑authored Pool entries now persist to `<userData>/pool-library.json` separately from the session file, and auto‑merge into every new / loaded session.

- **Main process `PoolLibrary`** class — same atomic write pattern as `SceneLibrary`.
- **Auto‑push on every change** — the renderer pushes the User‑entry set to main whenever the store's pool changes.
- **Auto‑merge on load + new** — `setSession` and `newSession` seed the freshly‑built session's pool with the library entries before the auto‑push effect fires, so the library never gets accidentally wiped to `[]` mid‑frame.
- **Cache mirror** in `poolLibraryCache` module‑scope state so `newSession` can re‑seed without an extra IPC roundtrip.

#### Scene library + new Saved Scene Inspector

- **Drag a Saved Scene anywhere on the grid** to instantiate — works in both the Edit‑view grid (including blank space between columns) and the Sequence‑view palette.
- **`instantiateSavedScene` focuses + selects** the new scene; Pool's saved‑scene multi‑selection is cleared at the same time so subsequent Del doesn't act on the source.
- **Save Scene to Pool** right‑click now works (the previous version silently failed because Electron disables `window.prompt`). Uses the scene's current name; rename in the inspector after.
- **Multi‑select Saved Scenes** in the Pool: Ctrl/⌘ + click toggles inclusion, plain click resets to that one; Del bulk‑removes with confirm. Selection auto‑clears when the user switches Pool tab.
- **Save N Scenes to Pool** + **Duplicate N Scenes** right‑click actions on a grid scene multi‑selection.
- **Auto‑increment duplicate names**: `OCTOCOSME (copy)`, then `(copy 1)`, `(copy 2)`, ... — strips an existing `(copy N)` suffix before duplicating so chains stay clean. Applies to Templates, Parameters, and Scenes.
- **New `SavedSceneInspector`** — left‑click a Saved Scene in the Pool's Scenes tab to inspect:
  - Editable: Name, Color (color picker), Notes, Duration, Multiplier, Morph‑in (ms), Next mode.
  - Read‑only "Contents" breakdown listing every Instrument + child Parameter with its captured value; clickable Instrument names jump the Pool selection to its Template Inspector. A `new` badge marks templates not yet in the local Pool.
  - **Use** / **Delete** action buttons.
- **Track ordering on save** — `saveSceneToLibrary` now builds the `tracks[]` list by filtering `session.tracks` in its native sidebar order (Set of needed ids), guaranteeing parent header rows come BEFORE their child Function rows. Eliminates the "scenes reshuffle on instantiate to a blank grid" bug.
- **Scene drag‑drop blur** — after dropping a Saved Scene onto the grid, `requestAnimationFrame(blur + body.focus)` releases Chromium's sticky drag pseudo‑focus so the next click on a clip's input lands cleanly without an alt‑tab.

### Per‑arg pin + per‑arg post‑modulation Scaling

Two new value‑shaping affordances on multi‑arg cells, both per‑slot.

- **Cell‑level pin override** — every editable slot in a multi‑arg cell now has its own pin checkbox in the Cell Inspector with a "cell" / "track" source badge. Three states per slot:
  - `cell.persistentSlots[i] === true` → pinned for this clip, emits `cell.persistentValues[i]`.
  - `cell.persistentSlots[i] === false` → explicit unpin, overrides the track default for this clip only.
  - `cell.persistentSlots[i] === undefined` → inherits the track default.
- **Engine emit precedence**: `argSpec.fixed` (Pool) > cell pin > track pin > live modulated value.
- **Scaling section (new, between Values and Timing)** — collapsible, disabled by default. Per slot:
  - Slot name + Min input + Max input.
  - When enabled, the engine clamps each slot's `out` to `[min, max]` AFTER modulators / sequencer but BEFORE Scale 0.0–1.0 and MIDI Scale. Pinned slots bypass (their value is the user's explicit final say).
  - Lets you tame a Random / Chaos / Generative source overshooting your target band without rewriting the entire sequencer.
- **Inspector `ParameterArgSpecSection`** in the Pool — collapsible Arg Layout editor with per‑slot Name / Type / Pinned / Value rows. Lets you author and edit multi‑arg argSpec entries (including pinning protocol prefixes) on User templates — not just on captured ones.

### Undo / redo — 3 levels

Module `src/renderer/src/undo.ts` runs a Zustand subscriber on `session` identity changes and writes deep‑cloned snapshots into a 3‑deep ring buffer.

- **Coalesce window** of 500 ms — typing bursts collapse into one undoable step.
- **`undo()` / `redo()`** with `suppressSnapshot` flag flipped synchronously inside `try/finally` so unrelated synchronous setStates can't get accidentally swallowed.
- **Counters in store** (`undoCount` / `redoCount`) drive disabled state + depth indicators on the Undo / Redo buttons.
- **Buttons** in the prefs sub‑toolbar (under the dataFLOU brand drop‑down), just left of Close.
- **Keyboard**: Ctrl/⌘+Z (undo), Ctrl/⌘+Shift+Z (redo), Ctrl/⌘+Y (redo alias). Works inside text fields — the snapshot coalescer treats a typing burst as one logical edit, so Ctrl+Z mid‑edit rolls back the whole burst cleanly.
- **History reset** on session load / new / autosave restore so you can't "undo" your way back into a previous file's state.

### Save‑before‑quit + Save‑before‑new

OS X‑button (window close) and toolbar `New` button both go through a modal asking "Save before …?".

- **Save before quitting?** modal — Yes saves the current session (overwrite path or write into the project's `Sessions/` folder if no path), then closes. No discards. Cancel keeps the window open. Errors during save show a red‑bordered banner inside the modal and keep it open instead of silently dropping data.
- **Save before opening a new session?** modal — identical UX, runs `newSession()` after the user picks. New button no longer creates a fresh session without prompting.
- **Sessions folder** — `<project-root>/Sessions/` in dev (or `<install-dir>/Sessions/` in production), with `<userData>/Sessions/` as a fallback when the install dir is unwritable. Auto‑numbered filenames (`session.dflou.json` → `session (1).dflou.json` → …) avoid silent overwrites.

### Per‑session GUI layout

A new `session.ui` subfield captures the user's layout so a saved session re‑opens at the exact size and shape it was at save time.

Fields persisted:

```ts
ui: {
  uiScale, rowHeight, sceneColumnWidth, inspectorWidth,
  trackColumnWidth, editorNotesHeight, oscMonitorHeight,
  tracksCollapsed, scenesCollapsed
}
```

- **`buildSessionForSave(state)`** helper in `store.ts` bundles UI state into the session at every save site (Save / Save As / Ctrl+S / Save‑before‑quit / Save‑before‑new / autosave push).
- **`setSession`** reads `session.ui` and applies each field to the matching top‑level store key, clamped against the same bounds the live UI sliders use. `uiScale` mirrors to localStorage so the runtime zoom hook stays in sync.
- **Older sessions** without `ui` inherit current runtime defaults — no breakage.
- **Default UI scale bumped** from 1.0 to 1.35 so fresh installs aren't tiny on modern monitor DPIs.

### MIDI bindings recall on session load

Every MIDI binding stored in the session (scene `midiTrigger`, cell `midiTrigger`, track `midiTrigger`, `instrumentTriggers`, Meta knob `midiCc`, transport `goMidi` / `morphTimeMidi`) was already serialised — but the renderer never re‑attached the persisted MIDI input device after load, so the bindings looked "gone" until the user manually re‑picked their controller from the top toolbar.

Fixed with a watcher in App.tsx that calls `midi.open(midiInputName)` whenever `session.midiInputName` changes. Open / autosave‑restore / new session all funnel through this and reopen the device cleanly.

### Top toolbar

- **Default OSC group is collapsible** + collapsed by default. Compact chip reads `Default OSC 127.0.0.1:9000 ▸`; click to expand the address / IP / port inputs. Saves ~340 px of toolbar space on the common case.
- **Forward popover button** sits in the Default OSC group with a status dot + `N/M enabled` count.
- **Listening pill** moved from the top toolbar to the Pool drawer's header, immediately left of the `● Capture` button. Reads `Listening 192.168.x.x:1986` with a status dot (green bound, red error, grey off). Auto‑binds the listener to `session.defaultDestPort` on app start.
- **Vertical separator** after the **Pool** label in the Pool's tab strip so the static label no longer reads as a disabled 5th tab.
- **Scenes tab moved** to position 3 (before Network).

### Cell tile rendering

- **Multi‑arg cells** now wrap into a 4‑column grid (`CellValueGrid`). ≤4 tokens render inline; >4 tokens wrap to 3+ rows. Token text rounded to ≤5 chars per slot.
- **Auto‑prefix tokens hidden** from the clip tile display — only EDITABLE slots render (the engine still emits the fixed prefix at send time).
- **Adaptive layout based on row height**: at `rowHeight ≥ 75` shows ip:port row + modulator chips footer; at `60–74` hides ip:port; at `45–59` hides both so the value grid gets every available pixel. Minimum row height bumped from 30 → 45 (below 45 the cell was visually empty).
- **Default row height bumped** from 60 → 95 so multi‑arg cells fit without cropping out of the box.

### Cell + Parameter Inspector

- **CollapsibleViewSection `headerEnd` slot** — renders content at the FAR RIGHT of the section header (outside the toggle button). Used by Destination's `OSC Output` checkbox so the chevron stays in the leftmost column, aligned with every other section's chevron.
- **Parameter Inspector multi‑arg layout** is visible even when there's no clip on the focused scene yet — falls back to `argSpec.init` values as synthetic "current" tokens so the user can pin / unpin slots immediately after dragging in a captured Instrument.
- **MIDI binding chip on scene headers** folded inline with the DUR / NEXT row — no more orphan "floating" lines.
- **Scene name + cell input drop‑focus fixes** — `onFocus` on the scene name re‑anchors selection; cell click stops propagation so it doesn't bubble to the scene header and clobber `selectedCell`.
- **Selection mutex** — clicking a scene clears Pool / track / cell selections; clicking a cell clears Pool selection but preserves the cell's own. Resolves the Del key picking the wrong branch.

### Pool inspector improvements

- **Argument layout editor** for Pool Instruments — collapsible "Arg Layout" section with per‑slot Name / Type / Pinned / Value rows + `+ Add slot` / `Clear all`. Required for duplicated OCTOCOSME‑style templates (the user couldn't edit their multi‑arg argSpec before).
- **"Save as Template" renamed to "Save as User"** in the Track sidebar right‑click menu (the destination is the User tab, not just any "template").
- **"Save Clip as Template"** action added to the filled‑clip right‑click menu. Auto‑names the saved template `Track — Scene`.
- **Multi‑arg clip template projection** — applying a multi‑arg clip template to an empty Parameter row also writes the template's argSpec onto the target track so the multi‑slot structure travels with the template.

### Generative formulas — non‑negative

The generative system used to produce negative values in some modes (tide / wave centred on 0, etc.), which then got clamped to 0 by `scaleToUnit` — giving the appearance of an all‑zero output. Every generative helper rewritten to LIFT above the base instead of swinging around it:

- `tideValue`: `(sin + 1) / 2` for a unipolar sine swell.
- `accentValue`: lift accents above the base by Variation.
- `voicingValue`: Ring A = +33 %, Ring B = +66 %, coincidence = +100 %.
- `waveValue` / `crowdValue` / `terrainValue` / `scatterValue` / `bounceValue` — all post‑clamp to `[0, 1]` if scaleToUnit, otherwise just non‑negative.
- `bounceValue` switched from multiplicative `base × ...` to additive `base + e^i × amount × mag` so it doesn't collapse a zero base.
- `generateStepValue` post‑clamp: `v < 0 → 0`; `if scaleToUnit && v > 1 → 1`.

### Misc engine + correctness

- **OSC port `9000` no longer hardcoded** in Capture — uses the discovered device's actual source port.
- **`/touches`, `/switches_change`** and other captured paths that don't share the dominant root now keep their leading `/`. Previously the no‑root branch stripped them unconditionally.
- **Bounce + Ratchet sub‑pulse** timing uses the actual current step duration (which Bounce varies geometrically across the row).
- **Modulator reseed** under `rndStep` / `rndSmooth` / S&H / Slew / Chaos uses the per‑track PRNG instead of `Math.random()` for deterministic re‑triggers.
- **OSC forwarder use‑after‑close** guarded with an inner socket re‑check + try/catch.
- **Auto‑increment duplicate names** strip existing `(copy N)` suffixes so chains stay clean.

### Build + packaging

- **Native MIDI module bundling** — `electron-builder.yml` adds `node_modules/@julusian/midi/**/*` to `files` and `node_modules/@julusian/midi/prebuilds/**/*` to `asarUnpack` so the prebuilt `.node` binaries load at runtime on Windows + macOS.
- **macOS DMG target** unchanged (universal arch).
- **Windows NSIS + portable** targets unchanged.

---

## Release notes — 0.4.5

The "huge expansion" release. Builds on top of v0.4.1 with a massive sequencer + modulator overhaul, a new generative system, network discovery in the Pool, a Meta Controller destination picker, rich themes, and a long correctness pass.

### Nine sequencer modes

The Sequencer panel now ships with 9 modes instead of 2. Each is its own little instrument:

- **Steps** — the classic 1‑16 step cycle (unchanged).
- **Euclidean** — Pulses + Rotation, evenly distributed across M steps.
- **Polyrhythm** — two interlocking ring clocks (lengths A and B) with a Combine mode (AND / OR / coincidence only).
- **Density** — per‑step probability shaped by Seed + Density knob. In classic mode, density acts as a multiplier on the step value rather than a gate, so the slider sculpts intensity smoothly.
- **Cellular** — 1‑D Wolfram automaton (rule 0‑255). The row evolves once per cycle. **Cellular Seed LFO** modulates the initial row at a user‑set rate/depth for slow pattern drift. Default seed picked so the preview reads as "alive" out of the box.
- **Drift** — Brownian playhead with bias and wrap/reflect edge behaviour.
- **Ratchet** — per‑step burst into 2‑16 sub‑pulses with **7 shaping modes** (Octaves, Ramp, Inverse, Ping‑pong, Echo, Trill, Random). Probability + MaxDiv per step, Variation knob blends global vs per‑step random. Bursts work with Bounce mode (sub‑pulses respect the current step's actual duration).
- **Bounce** — step duration shrinks geometrically across the row, like a settling ball. Animated SVG ball + splash rings in the inspector preview.
- **Draw** — free‑form curve sketcher with **up to 1024 steps**. **X / Y output range** maps the drawn 0..1 curve onto any numeric span. **Randomize** button rolls a smooth‑stepped random starting curve. Per‑step dots up to 64 steps, single playhead dot above that.

The 9 modes are picked from a dropdown in standard themes; rich themes (Nature / Cream) show a row of 9 mini pictograms.

### Generative mode

A new switch on every sequencer that reinterprets step values through a per‑mode musical rule:

- Steps → **Tide** (sine swell across the cycle)
- Euclidean → **Accent** (downbeat lands harder)
- Polyrhythm → **Voicing** (Ring A low, Ring B high, coincidences resonate)
- Density → **Wave** (sample through a sine)
- Cellular → **Crowd** (cells with more neighbours emit louder)
- Drift → **Terrain** (walker samples a height field)
- Ratchet → **Scatter** (chaotic burst distribution)
- Bounce → **Decay envelope**
- Draw → **Live curve** (regenerates a hash‑varied curve at each cycle wrap, anchored to your drawing)

**Variation** knob (0‑100 %) controls how far values stray from the user's base. Generative outputs respect Scale 0.0–1.0 internally so they can't smuggle values out of `[0, 1]`.

### Eight modulators, each with a live visual

Every modulator now has its own SVG preview in the Inspector that reacts to its parameters in real time. The visuals respect sync mode so a BPM‑synced LFO at 1/8 shows 8 cycles per beat.

- **LFO** — sine / triangle / sawtooth / square / rndStep / rndSmooth, bipolar or unipolar.
- **Ramp** — **Mode menu** (Normal / Inverted / Loop), exponent, sync mode. Live progress dot rides the curve. Mode change mid‑play restarts the ramp from t=0 cleanly.
- **Envelope (ADSR)** — Attack / Decay / Sustain / Release as percentages. **Total time label** shown for synced modes. Live progress dot on the ADSR shape.
- **Arpeggiator** — Mode menu (Up / Down / Ping‑pong / Random / Walk / Drunk / Inclusion / Exclusion / Chord) drives playback order; visual shows the ladder for the chosen mode with per‑step labels.
- **Random** — float / int / colour with proper Scale 0.0–1.0 normalisation (RGB bytes map to `[0, 1]` cleanly instead of clipping).
- **Sample & Hold** — probability + smooth modes. Visuals correctly invert probability (was inverted in v0.4.1).
- **Slew** — independent rise / fall half‑life (1 ms – 60 s each).
- **Chaos** — logistic map.

### Network discovery in the Pool

New **Network tab** in the Pool drawer. Click **Listen** to bind a UDP port (default 9000) and the Pool starts logging every OSC sender on the local network.

- Devices show as draggable rows keyed by `ip:port`, with activity dot, packet count, and last‑seen age that refreshes every second.
- Expand a device to see every OSC address it has emitted, with type tags and a live preview of the latest args.
- **Drag onto the sidebar** → materialised as a user Instrument Template with one Parameter per observed address. Multi‑arg addresses get a full `argSpec` (canonical slot names, max=255 for colour) so the cell editor's split‑input strip works immediately.
- Common OSC root auto‑extracted into the template's base path.
- Cancelled drags (Esc / drop off‑target) auto‑clean the just‑materialised template.
- Status header shows local IPv4 addresses + bind status; subscription stays alive at app‑level so the title‑bar dot updates even when the drawer is collapsed.

### Meta Controller — Destination picker + 4‑row bank

Adding a destination to a Meta knob used to be "click +, then hand‑type the IP / port / address." Now the row next to the Destinations header holds **three dropdowns** + a `+`:

- **Instrument** — every Instrument header on the current sidebar (plus orphan Parameters).
- **Parameter** — appears after picking an Instrument; lists its child Parameters.
- **Value** — appears only for multi‑arg Parameters; pick All or a specific slot (x / r / HAUTEUR1 / etc.) to suffix the OSC address.

Click **+** to commit the resolved destination. With no Instrument picked, **+** falls back to the freeform "add empty destination" behaviour.

The **A / B / C / D bank selector** is now a single‑column 4‑row stack so the bar's footprint stays narrow.

### Multi‑arg Sequencer respects pinned slots + fixed protocol headers

When the sequencer is on for a multi‑value parameter (e.g. OCTOCOSME Voice Pots' four pots), the engine now emits the **full** multi‑arg bundle every step. Pinned slots keep their frozen values; unpinned slots receive the sequencer's output (broadcast from the single token, or matched per‑slot if you type a multi‑token step value). You can now sequence one channel while leaving the others hand‑set.

Additionally, **argSpec entries marked `fixed:`** (the protocol headers OCTOCOSME prepends as `sender: "compositor"` and `timestamp: 0` for Pure Data's `list split 2`) are now always emitted as their declared value — the engine bypasses sequencer + modulator on those slots entirely. Previously the sequencer's broadcast value could overwrite them, breaking the receiver's split. The Inspector's pin list shows these slots as locked rows with a `FIXED` badge so you can see what's being prepended on every send.

### Rich themes — Nature + Cream

Two themes opt into a bespoke "rich" UI surface inspired by Hopscotch and Peaks: bespoke arc sliders for Rate / Variation, a mini‑pictogram icon row in place of the sequencer mode dropdown, soft cards around inspector sections, console‑style numeric readouts. **Nature** (Hopscotch palette: dark warm grey + olive→teal + orange) and **Cream** (Peaks palette: cream paper + mustard ochre).

Other themes keep the classic HTML controls.

### Smart Scale 0.0 – 1.0 (auto‑range)

Scale 0.0–1.0 used to be a blunt `clamp01()`. It now **auto‑ranges**:

- **Sequencer + Scale** → precomputes the cycle's per‑token min/max (including ratchet sub‑pulses up to maxDiv=16) and normalises into `[0, 1]`.
- **Modulator + Scale (no sequencer)** → predicts the modulator's output range and normalises against that.
- **Degenerate range** → emits the user's actual value clamped into `[0, 1]` instead of forcing 0.5.
- **Random colour mode** now normalises through `(v - min) / (max - min)` so RGB bytes don't collapse to 0/1.

### Hold vs Last rest behaviour

A new dropdown on every sequencer: **Hold** (default — receiver naturally holds the previous value during rests; the engine suppresses redundant re‑sends) or **Last** (re‑emits the previous step's value on every rest tick).

### Engine + correctness pass

A long list of small fixes from the v0.4.5 review:

- **Atomic session + autosave writes** — saves go to `<path>.tmp` then `fs.rename`, so a crash mid‑write can never corrupt the file.
- **Autosave write race** fixed via an `inFlight` Promise mutex — shutdown final‑flush and the 60s tick can't double‑write or race the prune step.
- **Engine.stop()** now clears every ephemeral tick field (`liveValues`, `lastTickAt`, `pauseStartedAt`, active scene bookkeeping) so a re‑`start()` doesn't compute against stale state.
- **Modulator state reseed** (rndStep / rndSmooth / S&H / Slew / Chaos) now uses the per‑track PRNG instead of `Math.random()` for deterministic re‑triggers.
- **Ratchet sub‑pulse timing** under Bounce mode now uses the current step's actual (variable) duration rather than the constant `stepDurMs`.
- **predictModRange** for ratchet auto‑range raised from 8 to 16 to match the runtime cap — high‑division bursts no longer clip.
- **LFO sync‑mode jumps** that wrap multiple cycles in a single tick now iterate the resampler loop so intermediate rndStep / rndSmooth samples aren't dropped.
- **oscNetwork listener** clears `enabled` on post‑ready errors, awaits the underlying socket's `'close'` event before resolving (fast re‑bind no longer EADDRINUSEs), and `observe()` short‑circuits when not enabled so late dgram packets can't mutate the device map.
- **IPC handlers** wrapped in a `safeHandle` that catches throws and logs by channel name, so a malformed payload can't half‑mutate engine state.
- **stepHash** XOR'd with a golden‑ratio constant so the all‑zero input (step=0, seed=0) no longer returns 0 (which would make every density gate fire at step 0).
- **Generator helpers** now post‑clamp under Scale 0.0–1.0 so tide / accent / voicing / wave / crowd / terrain / scatter / bounce can't smuggle out‑of‑range values past the engine.
- **DrawCanvas Randomize** now starts from a zeroed length‑1024 buffer so increasing `drawSteps` later doesn't expose stale tail values.
- **DrawCanvas high‑res playhead** modulos by `drawSteps` so a stale `currentStep ≥ drawSteps` doesn't make the dot vanish.
- **DestinationPicker** drops `instrumentId` when the picked Instrument is removed from the sidebar, and clamps `slotIdx` when fnArgSpec shrinks.
- **PoolPane port input** now ignores external status pushes while focused, and shows empty instead of "0" when cleared.
- **Network listener subscription** hoisted from PoolPane to App so the title‑bar status dot updates while the drawer is hidden.
- **Network device row age labels** refresh at 1 Hz between push updates.
- **Cellular initial row** at low step counts now re‑folds the user's full `cellSeed` into the visible bit window so an even seed at steps=1 isn't silently masked to 0.
- **Drift bias asymmetry** fixed — extreme bias (`±1`) now produces a truly monotonic walk (was capped at 2/3 forward).
- **Modulator visuals** now correctly invert S&H probability (the high‑probability branch was firing the low‑probability path) and use proper Slew bipolar dropdown sizing.
- **Random Stepped LFO** no longer disappears at fast BPM‑sync — `visibleStairs = max(8, cycles*8)`.
- **Arpeggiator visual** rebuilt to be driven by Arp Mode (not multMode) for accurate playback‑order display.
- **Inspector step‑value edits** read fresh state inside the onChange callback so rapid keystrokes can't race across re‑renders.
- **CellTile triggerAtRef** moved from render body to a `useEffect` so the ramp progress dot doesn't micro‑jitter at trigger.
- **RcArcSlider / RcFlatBar** got pointer cancel handlers + try/catch around capture so OS‑yanked pointers don't leave them in a captured‑scrub state.
- **RcModeIcons** switched to `flex-wrap` so the 9 icons fold onto two rows at narrow widths / high UI zoom.
- **OscMonitor + Pool now scale with Ctrl+wheel zoom** — moved inside the zoom wrapper, with drawer max height adapting to `uiScale` so the drawer can't eat the workspace at 2×.
- **Pool header layout fixed** — User tab's "+ Instr / + Param / ⤢ / Hide" cluster shrunk so "Built‑in" doesn't wrap to two rows.
- **`materialiseNetworkDevice` regex injection** fixed — OSC roots containing `.` / `(` / `+` etc. no longer produce malformed patterns.
- **Render‑deterministic empty session** — atomic writes, integrity migration backfills every new sequencer / modulator field with sane defaults so v0.3.x and v0.4.0 sessions load cleanly.

---

## Release notes — 0.4.1

A polish pass on top of v0.4.0 with two user‑reported papercuts fixed and a deeper authoring loop for clips that send multi‑arg OSC.

### Open dialog now actually loads
- **Open → click a saved session → it loads.** v0.4.0 silently swallowed a `ReferenceError` (`require is not defined`) inside `requestSessionLoad`. Replaced the dynamic `require` of the integrity‑check module with a static ESM import.

### Ctrl+S saves
- **Ctrl + S** *(Cmd + S on macOS)* saves the current session.

### OCTOCOSME builtin retargeted at the software
- The shipped **OCTOCOSME** Instrument Template now targets port 1986 with 8 bundle Parameters matching the Pure Data show‑control patch's `list split 2` convention.

### Schema‑driven multi‑arg editor
- Pool Parameters can declare a typed list of args (`ParamArgSpec[]`).
- Cells inheriting an `argSpec` show a **Values** section with one bounded numeric input per arg.
- Each arg participates in modulation independently.

### Per‑Track enable / disable + per‑slot persistence
- Per‑Parameter enable checkboxes in the Instrument inspector.
- Pin individual args on a multi‑arg cell — modulation keeps running on the others.

### Other
- Scene cells auto‑size to widest clip.
- Track‑defaults auto‑inheritance.
- Drop‑focus stickiness fix.

---

## Release notes — 0.4.0

**The big merger toward Alex Burton's dataFLOU C++ library:** the editor now speaks the library's vocabulary natively. A flat row of Messages becomes a hierarchy of typed **Instruments** (Templates) holding **Parameters**, with a browseable **Pool** for shipped + user‑authored entries.

- **Pool of Instruments + Parameters** — Built‑in / User tabs, shipped library of 3 Instruments + 5 Parameter blueprints, drag‑to‑instantiate.
- **Group triggers** at every Instrument × Scene intersection — fires every child clip in one gesture.
- **Timeline view** — alternate Sequence visualization, scenes as flex blocks proportional to Duration.
- **Sequence polish** — palette pills hug their names, multi‑scene drag‑drop fills consecutive slots, slot multi‑selection.
- **Transport** — Play in Sequence is dedicated to sequence transport; Pause freezes scene time end‑to‑end; live remaining‑time pill.
- **Inspector toggles** — I / S / M / O / P.
- **OSC Monitor drawer** resizable.
- "Collapse Messages" → "Collapse Instruments".

---

## Release notes — 0.3.6

Three new modulators, Euclidean sequencing, and correctness fixes.

- **Sample & Hold**, **Slew**, **Chaos** modulators.
- **Euclidean** sequencer mode.
- Follow actions, Stop, S&H smooth math, shutdown sequencing fixes.

---

## Release notes — 0.3.5

Live‑performance polish + Ramp + autosave.

- **Cue system** + Morph + Show / Kiosk + transport HH:MM:SS:MS.
- **Ramp** modulator + Envelope synced mode.
- **Autosave + crash recovery**.
- **OSC monitor drawer**.
- **Meta Controller expanded to 32 knobs / 4 banks**.

---

## Release notes — 0.3.0

- **Meta Controller** bank (8 knobs originally), 14 curves, MIDI CC learn, 8 destinations per knob.
- **Follow actions** + ×Multiplicator.
- **Multi‑select** everywhere.
- **5 new themes**, **UI zoom**, **Scene inspector in Sequence view**, **Notes** toggle.

---

## Project status

A personal tool by [Vincent Fillion](https://vincentfillion.com), in active use. As of v0.5.5:

- ✅ **Hardware Mode** — drive any cell's args from a physical OSC controller with catch-mode soft-takeover, per-template config, multi-instance scope, per-arg locks, RESET / PERSIST modes, live red highlighting on caught slots.
- ✅ **Per-sequence-slot overrides** — duration + follow-action per placement; same scene in two slots can have independent timing AND independent next-actions.
- ✅ **Velocity Humanize** — 0–100 % jitter rolling at the same rate as modulator-driven note edges, with live wire-accurate badge display.
- ✅ **Learned MIDI panel** — every active MIDI binding listed in the Monitor's far-right column, with inline kind / number / channel editor.
- ✅ **Pitch-snap** — 26 scales × 12 roots, per-cell per-slot, snapping after modulation before pin.
- ✅ **Undo / redo** — 3 levels deep, debounced, available via Ctrl+Z / Ctrl+Shift+Z and toolbar buttons.
- ✅ **MIDI output** — native (RtMidi) per cell / track / Parameter, with global enable + live Monitor.
- ✅ **OSC fan‑out** — multi‑target Forward popover lets the compositor sit in front of Pure Data / Ableton / another machine.
- ✅ **Cross‑session libraries** — Pool (Instruments + Parameters) and Scene libraries persist across sessions.
- ✅ **Save‑on‑quit / Save‑on‑new** with confirmation modals + error surfacing.

Still out of scope:

- No OSC bundles with timestamps
- No quantized scene changes (cue firing is immediate)
- No mDNS / OSCQuery (Network discovery is passive listening only)
- No MIDI clock output (MIDI is per‑message CC + Note; sync is OSC‑driven internally)

Issues and PRs welcome.

---

## License

ISC — do whatever you want, no warranty.
