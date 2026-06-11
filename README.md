# dataFLOU_compositor

**Send OSC and MIDI data to many destinations as triggerable scenes.** A rotated‑Ableton‑Session‑style editor that fires multiple OSC bundles + MIDI messages at once with modulation, sequencing, transitions, delays, MIDI input control, an authorable **Pool of Instruments and Parameters**, a one‑click **Capture** function that snapshots live OSC / MIDI traffic into Pool Instruments + Saved Scenes, **OSC forwarding** so the compositor can sit in front of another software or another machine, **100‑deep undo/redo**, and a **per‑session GUI layout** that re‑opens at exactly the size and shape you left it.

![dataFLOU_compositor - Edit view](docs/images/dataFLOU_Compositor_EditMode.png)

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
  - [Scene‑to‑scene Morph](#scenetoscene-morph)
  - [Clips (cells)](#clips-cells)
  - [Sequencer - 9 modes](#sequencer---9-modes)
  - [Generative mode](#generative-mode)
  - [Modulators - 8 types with live visuals](#modulators---8-types-with-live-visuals)
  - [Smart Scale 0.0 – 1.0 (auto‑range)](#smart-scale-00--10-autorange)
  - [Hold vs Last rest behaviour](#hold-vs-last-rest-behaviour)
  - [Multi‑arg parameters + pinned slots](#multiarg-parameters--pinned-slots)
  - [Templates & bulk actions](#templates--bulk-actions)
  - [OSC monitor](#osc-monitor)
  - [Autosave + crash recovery](#autosave--crash-recovery)
  - [Meta Controller (32 knobs, 4 banks, Destination picker)](#meta-controller-32-knobs-4-banks-destination-picker)
  - [Show / Kiosk mode](#show--kiosk-mode)
  - [Themes (15 + rich themes)](#themes-15--rich-themes)
- [Sessions](#sessions)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Release notes - 0.5.14](#release-notes---0514)
- [Release notes - 0.5.13](#release-notes---0513)
- [Release notes - 0.5.12](#release-notes---0512)
- [Release notes - 0.5.11](#release-notes---0511)
- [Release notes - 0.5.10](#release-notes---0510)
- [Release notes - 0.5.9](#release-notes---059)
- [Release notes - 0.5.8](#release-notes---058)
- [Release notes - 0.5.7](#release-notes---057)
- [Release notes - 0.5.6](#release-notes---056)
- [Release notes - 0.5.5](#release-notes---055)
- [Release notes - 0.5.1](#release-notes---051)
- [Release notes - 0.5.0](#release-notes---050)
- [Release notes - 0.4.5](#release-notes---045)
- [Release notes - 0.4.1](#release-notes---041)
- [Release notes - 0.4.0](#release-notes---040)
- [Release notes - 0.3.6](#release-notes---036)
- [Release notes - 0.3.5](#release-notes---035)
- [Release notes - 0.3.0](#release-notes---030)
- [Project status](#project-status)
- [License](#license)

---

## What it does

You build a grid of **Instruments** (rows - each Instrument is a typed group of OSC **Parameters**) and **Scenes** (columns). Each cell at the intersection (a "clip") holds the value, modulation, sequencing, and timing parameters that this Parameter will use whenever this Scene is triggered. The big square at the **Instrument × Scene intersection** is a **group trigger** that fires every Parameter under the Instrument at once.

- **One scene trigger** fires every clip in that column simultaneously.
- **Per‑Parameter triggers** let you fire individual messages without launching the whole scene.
- **Per‑Instrument group trigger** at each Instrument × Scene intersection fires (or stops) every child Parameter's clip on that scene as a single gesture. MIDI‑learnable.
- **Hardware Mode UX hardening (v0.5.12 + v0.5.13)**: live status dot next to the "Hardware Mode" label (🟢 healthy / 🟡 enabled-but-no-packets / 🔴 dual-emission), `deviceMatch: 'ipOnly'` toggle for controllers with ephemeral source ports (Lemur, TouchOSC, ad-hoc software OSC), `forwardMode: 'suppress' | 'always' | 'whenIdle'` policy so the controller can reach downstream consumers (PD, Max) only when no scene is playing (auto-flipping via `engine.activeSceneId`), **int + bool slots catch on value change** (v0.5.13 — no threshold, no idle-time window; a flip after an hour idle catches instantly, while a streaming controller's unchanged state can't steal slots back from a freshly-triggered scene), info-popup tooltips on every Hardware Mode field, right-click "Bind to template" actions on Network Discovery rows (per-template, eliminates the manual-typing-source-port trap), and a "self loopback" flag that excludes dataFLOU's own emissions from HW Mode bindings + the Capture popup's device list.
- **Capture current state as new scene (v0.5.12)**: right-click any scene → "Capture current state as new scene" snapshots the engine's currently-emitted values for every cell on the scene (including Hardware Mode catches from a physical controller, sequencer step, modulator output, per-arg pins) into a new scene cloned from the source. Inserted directly adjacent to the source in the grid. Workflow: trigger a base scene, tweak via controller, right-click → capture. Named `<source> (capture)`.
- **Gesture modulator (v0.5.8)**: record an X/Y stream by dragging on a square surface in the Inspector and use it as a modulator. The polyline + a crayon-style cursor render LIVE while you draw (canvas pinned-centered so it doesn't shift). On playback the engine loops the captured curve at the modulator's standard Rate (Hz or BPM-synced), and a coloured **playhead dot** animates on the canvas at ~30 Hz so you SEE the curve being traced. Three **Play modes** (Forward / Backward / Ping-Pong), a **Wiggle** knob (0–100 %, sinusoidal back-and-forth jitter on the playhead - modulatable by Modulation 2 as the third "Shape" target), and an **Output** picker: `XY` (X → slot 0, Y → slot 1) or `Merged` (radial distance √(x² + y²)/√2 broadcast to every slot). Two-channel fan-out via `gestureChannelFor`.
- **Two-stage modulator - Modulation 2 (v0.5.7, expanded v0.5.8 + v0.5.9)**: every clip carries an optional SECOND modulator that modulates **Modulation 1's Rate, Depth, and a context-aware Shape parameter** (LFO shape morph, S&H/Random Distribution, Strange Attractor Chaos, Chaos r, Slew Rise/Fall, Envelope Sustain, Ramp Curve, Arpeggiator Mode, Gesture Wiggle). **Every modulator type** is now usable as Modulation 2 (v0.5.8): LFO, S&H, Slew, Chaos, Strange Attractor, Envelope, Random, Ramp, Arpeggiator (Gesture-as-Mod-2 reserved for a future revision). Three math modes (Multiplicative / Additive / Mix). Per-target enable + amount knob. The Modulation 1 sub-editors **animate in real-time**: sliders and number inputs overlay the engine's live effective values at ~30 Hz while still letting you edit the base value - Mod 2's modulation breathes around whatever you author. The orange "live" overlay tint is gated on Modulation 2 being enabled, so it doesn't fire when nothing is actually modulating. Mod 2 also gets its own Routing-matrix column for per-slot gating.
- **Modulation 2 → Sequencer (v0.5.9)**: Modulation 2 now also has a parallel route into the cell's Sequencer (in addition to its existing route into Modulation 1). Inspector's Mod 2 section renders TWO Targets blocks: "Mod 1 Targets" and "Seq Targets". The Seq block's Shape label is mode-aware - Rotation for Euclidean, Seed for Density, Rule for Cellular, Ring A Length for Polyrhythm, Bias for Drift, Probability for Ratchet, Decay for Bounce. **Rate** targets bpm + stepMs; **Depth** universally targets the **Generative wildness slider** (`genAmount`) - making Modulation 2 → Sequencer a "calm ↔ chaotic" breathing source for generative sequencer modes. Routing matrix grows a new M2>S column next to M2>1.
- **Generative Scene Sequencer (v0.5.10)**: a one-button shuffle for the scene timeline. Click GENERATIVE at the top of the Sequence view and the engine starts picking the next scene from a weighted pool with min/max duration windows, four selection-mode presets (**Random / Drift / Surprise / Shuffle**), a bipolar **Affinity** slider (-100 Contrast .. +100 Coherence) that biases toward similar or dissimilar scenes via an auto-computed multi-arg-aware scene similarity matrix, per-scene **Weight** (1-10) + a **Random Weights** button, a **Use Morph** toggle, and seven MIDI-learnable controls for hands-on stage use. Manual triggers (Cue/GO, scene clicks, Space, 1-0, MIDI scene triggers) still play the scene at its authored duration - only natural advances are diverted, so you keep precise manual control. Made for installations + live shows with generative input.
- **Address sequencer Stage-2 sub-mode (v0.5.8)**: Address mode's third sub-mode is now wired: Modulation 2 drives the playhead address while Modulation 1 modulates the addressed step's value. Falls back to Modulation 1 driving the playhead if Modulation 2 is disabled on the cell.
- **Hardware Mode (v0.5.5)**: drive any compositor cell's args from a physical OSC controller (Trill bars, MIDI-to-OSC bridges, anything streaming UDP). Per-Instrument-template config: bind to a discovered device, pick **Reset** or **Persist** catch-mode, set catch tolerance + movement threshold, optionally narrow to specific Track instances and specific arg slots. Soft-takeover: the hardware value only takes over once it matches the currently-emitted scene value (or persists across scene changes if you want it to). Movement detection skips static/idle packets. Caught arg values render **red** in the live cell of the currently-playing scene, with a pulsing red dot in the Track sidebar + "HW Mode On" badge under the Instrument. Toggle the same Hardware Mode block from either the Pool inspector OR the grid Instrument inspector - both write the same `template.hardwareMode` blob. **Session persistence (v0.5.7)**: the caught-slot map (per-track arg indices currently overridden by hardware) is saved with the session and restored on load, so a power-cycle no longer wipes which slots are bound.
- **Strange Attractor modulator (v0.5.7)**: new modulator type drawing from 6 well-known chaotic ODEs: **Lorenz, Aizawa, Thomas, Rössler, Rössler-4D, Lü-4D**. Per-tick Euler integration with adaptive sub-steps + per-step `±200` clamps + NaN guards so high-Speed × high-Chaos never blows up. Three knobs: **Type, Speed, Chaos**. Each tick produces a bounded, correlated 3-channel (or 4-channel for 4D types) trajectory; multi-arg cells fan out as slot 0 = X, slot 1 = Y, slot 2 = Z, slot 3 = W (= speed for 3D types, native W for 4D). Live SVG visual previews the 2-D projection of the orbit. Mod 2's Rate target patches `attractor.speed`, not `rateHz`.
- **Routing matrix (v0.5.7)**: new collapsible section at the bottom of the Cell Inspector. Per-slot 3-column toggle grid (Mod / Mod 2 / Seq) plus **Delay (ms)** and **Variation (%)** columns. Untick a tick to gate the driver out for that slot (slot reads its cell.value seed instead of the modulated value). Click+drag across ticks to paint several at once. Bulk ⇆ buttons toggle a whole column. Delay staggers a slot's modulator/sequencer onset after each trigger. Variation introduces a per-trigger random ±scaling so multi-arg cells stay "similar but a bit different" across slots (with a small SVG knob next to the % input). Modulation 2 column greys out when Mod 2 is disabled on the cell.
- **Address sequencer mode (v0.5.7)**: 10th sequencer mode. The Modulator's output is interpreted as a **CV-style playhead address** into a row of step values: `stepIdx = floor(modUnipolar01 * stepsA)`. Three sub-modes: **Hijack** (default, Mod consumed entirely as playhead; the addressed step value emits as-is), **Parallel** (Mod still drives normal modulation on top of the addressed step), and Stage-2 (reserved for v0.5.8). Pairs especially well with LFO and S&H Modulation 1 types.
- **Distribution knob on Random + S&H modulators (v0.5.7)**: a "0 % = edges only · 50 % = uniform · 100 % = centre-hugging" warp on every fresh sample (Buchla 266 Stored Random Voltages style). Applied at trigger-time seeding AND every per-tick draw. Mod 2's Shape target on these types sweeps Distribution.
- **Scaling PRE/POST switch (v0.5.7)**: the per-arg post-modulation Scaling section can now be applied either AFTER modulators + sequencer (POST - default, clamps the final output) or BEFORE them (PRE - the whole modulator/sequencer chain operates inside the clamped band). Switch lives in the Scaling section header.
- **Editable pinned values broadcast to clips (v0.5.7)**: pinned slots in the Parameter Inspector are now an inline text field instead of a static display. Edit the captured value live; engine picks it up immediately. The "Send to clips" button now **also** stamps the new pinned values into every clip's `value` string at the pinned positions, so the grid display stays in sync with what the engine emits.
- **Parameter row right-click menu (v0.5.7)**: Parameter rows now get their own context menu (Duplicate Parameter / Delete Parameter), distinct from the Instrument template menu.
- **Ctrl+C / Ctrl+V clipboard (v0.5.7)**: internal clipboard for Instruments, Parameters, and clips. Copy from the row sidebar or grid → paste at the current selection. Suppressed inside editable inputs.
- **Saved Scene right-click menu (v0.5.7)**: Pool · Scenes tab gets Rename (inline) + "Update from Grid" so the linked scene's contents are refreshed from the current grid in one click. Unique-name suffix `_N` on duplicate saves.
- **Per-sequence-slot overrides (v0.5.5)**: the same scene placed twice in the sequence can now have different durations AND different follow actions per placement. Click any sequencer slot → an accent-bordered **Slot N override** panel appears at the top of the right inspector. Live progress fill + countdown only paints the slot that's actually playing, not every visual instance of the scene. Loop follow-action correctly restarts on the same slot instead of disappearing.
- **Velocity Humanize (v0.5.5)**: 0–100 % jitter slider next to the Velocity field in the Cell Inspector. Engine rolls a fresh random velocity offset on every noteOn (sequencer step OR modulator-driven note edge), so the badge value visibly jitters at the same rate as the audible notes. Live cell badge mirrors the actual emitted velocity (with fixed-width 3-char padding so the number doesn't wiggle the layout).
- **Modulator-driven MIDI re-trigger (v0.5.5)**: Note-mode MIDI cells now fire a fresh noteOn whenever the modulator's value crosses a note boundary, not just on sequencer steps. Lets you drive a synth with a free-running LFO / Random / Chaos modulator and hear every note transition cleanly. Old behavior (one noteOn at trigger, held forever) is gone.
- **Learned MIDI panel (v0.5.5)**: far-right column in the Monitor lists every active MIDI binding in the session (Cue GO, Morph time, Meta knobs, scene triggers, instrument group triggers, per-clip triggers). Each row shows kind + CC/note + channel. Click **Edit** to re-learn OR type a binding inline (kind / number / channel). Resizable, hidden when MIDI traffic is unticked or no bindings exist. Press **L** anywhere to toggle MIDI Learn mode.
- **Native MIDI output (v0.5)**: `@julusian/midi` (RtMidi) lives in the main process. Each cell / track / Parameter blueprint can carry a `midiOut` config (port + channel + CC# / Note + velocity / gate). The same modulators and sequencer that drive your OSC fire MIDI in parallel. Six new MIDI Pool blueprints ship out of the box (CC, Note, CC pair, Drum, DAW macro bank, CC×8 template). Global enable toggle in the prefs sub‑toolbar.
- **Pool drawer with four tabs**: Built‑in, User, **Scenes**, **Network**. Browse shipped Instrument Templates (OCTOCOSME, Generic XYZ, Pandore) and Parameter blueprints (RGB Light, Knob, Motor, Button, XY Pad, MIDI CC, MIDI Note, MIDI CC pair, MIDI Drum, MIDI DAW macros, MIDI CC×8); author your own; recall **Saved Scenes** across sessions; or watch the local network for OSC senders and drag any discovered device onto the grid as an Instrument with one Parameter per observed address.
- **Capture (v0.5)**: one button (or **`C`** key) opens a popup that snapshots live OSC / MIDI traffic into the Pool. Four modes: **New Scene for Instrument** (snapshot current values into an existing Pool Instrument), **New Instrument + Scene** (build both at once), **New OSC Instrument** (just the Pool entry), **New MIDI Instrument** (every wiggled CC / Note becomes a Parameter). Live in‑popup monitor shows the full multi‑arg payload per address with type‑coloured chips + freshness dots. Resizable, X‑remove per address, per‑parameter argSpec auto‑generated from observed OSC tag strings.
- **OSC forwarding (v0.5)**: every UDP packet received on the compositor's listen port is byte‑copied to a configurable LIST of downstream destinations (Pure Data, Ableton, another machine). Lets the compositor sit in front of consumers whose OSC port is fixed (firmware‑locked controllers). Configured via a "Forward" popover in the Default OSC group; per‑target enable + label + IP + port.
- **Pool + Scene libraries (v0.5)**: User Instruments + Parameters persist to `<userData>/pool-library.json` and are auto‑merged into every new / loaded session, so authored instruments follow you across files. Saved Scenes are reusable presets that live in `<userData>/scene-library.json`; drag any Saved Scene anywhere on the grid (including blank space) to instantiate; right‑click in the grid → Save N Scenes to Pool / Duplicate N Scenes works for multi‑selections; Ctrl+click + Del bulk‑delete in the Scenes tab.
- **Saved Scene Inspector (v0.5)**: left‑click any Saved Scene in the Pool to inspect/edit its name, color, notes, duration, multiplier, morph‑in, next‑mode, plus a read‑only Contents breakdown showing every Instrument + Parameter + captured cell value the scene carries.
- **Multi‑value OSC**: space‑separated entries in a clip's Value field become multiple OSC args in a single message. Every modulator treats each entry independently. **Pin individual slots** to freeze them while the sequencer / modulator drives the rest, with a **two‑level pin model (v0.5)**: the Parameter Inspector sets a row default; each clip can override (true / false / inherit) so Scene A can pin a slot while Scene B leaves it modulated.
- **Per‑arg post‑modulation Scaling (v0.5)**: new collapsible section in the Cell Inspector between Values and Timing. Clamps each arg's output to a user‑chosen `[min, max]` band AFTER modulators / sequencer but BEFORE Scale 0.0–1.0 and MIDI Scale. Lets you tame extreme values from a Random / Chaos / Generative source without rewriting the whole sequencer. Per‑cell, per‑arg.
- **100‑deep undo / redo (v0.5, expanded to 100 in v0.5.14)**: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. Snapshot ring buffer (100 past + 100 future), 500 ms coalesce so typing bursts count as one undoable edit. Buttons live in the prefs sub‑toolbar with depth indicators. History resets on session load.
- **Smart Scale 0.0 – 1.0**: auto‑ranges each parameter's actual min/max into `[0, 1]` instead of blunt‑clamping. Works for sequencer cycles, modulator outputs, even multi‑arg colour channels.
- **Ten modulation types with live visualisations**: **LFO**, **Ramp** (Normal / Inverted / Loop), **Envelope (ADSR)**, **Arpeggiator** (with mode‑aware playback patterns), **Random Generator**, **Sample & Hold**, **Slew**, **Chaos** (logistic map), **Strange Attractor** (v0.5.7 - Lorenz / Aizawa / Thomas / Rössler / Rössler-4D / Lü-4D, 3-/4-channel fan-out), and **Gesture** (v0.5.8 - XY recorder with live crayon preview, Wiggle, Forward / Backward / Ping-Pong playback; 2-channel fan-out or merged radial). All share one clock-rate control (Free Hz or BPM-synced with dotted/triplet); per‑modulator preview SVG redraws as you tweak. Each cell can stack a SECOND modulator (Modulation 2) that modulates Modulation 1's Rate / Depth / context-aware Shape - see top of the feature list.
- **Ten sequencer modes**: **Steps**, **Euclidean**, **Polyrhythm** (two interlocking rings), **Density** (per‑step probability), **Cellular** (1‑D Wolfram automaton with Seed LFO), **Drift** (Brownian playhead), **Ratchet** (sub‑pulse bursts with 7 shaping modes), **Bounce** (geometrically accelerating step duration), **Draw** (free‑form curve up to 1024 steps), and **Address** (v0.5.7 - CV-style playhead driven by the Modulator's output, three sub-modes). Each has its own inspector preview.
- **Generative mode**: flip a switch on any sequencer and the engine reinterprets the step values through a per‑mode musical rule (Tide, Accent, Voicing, Wave, Crowd, Terrain, Scatter, Bounce). Variation knob controls how far values stray from the user's base.
- **Hold vs Last** rest behaviour - choose whether a muted step keeps emitting the last value (Hold) or replays the previous step's value (Last). Default Hold.
- **Transitions** morph the previous clip's value into the new one over a configurable time, even while the LFO keeps running.
- **Ableton‑style follow actions**: Stop / Loop / Next / Previous / First / Last / Any / Other, plus a per‑scene **×Multiplicator**. Right‑click a scene (or multi‑selection) → **Set Follow Action** and the menu's submenu applies to every selected scene at once.
- **Sequence grid**: 1–128‑step drag‑laid sequence in the Sequence view. **Multi‑select scenes in the palette and drop a single drag** to fill consecutive Scene Steps next to each other in one gesture.
- **Timeline view**: alternate Sequence visualization where each occupied slot becomes a flex block whose width is proportional to its Duration. Live remaining-time + progress fill on every instance of the active scene.
- **Live scene progress everywhere**: Scene Steps and Timeline both fill from 0 → 100% orange across the playing scene's duration, on every visual instance, so you can see exactly where you are even when the scene is placed in multiple slots.
- **Meta Controller**: **32 knobs across 4 banks** (A B C D), with a new **Destination picker** that walks Instrument → Parameter → optional Value‑slot and adds the resolved OSC destination with one click. Each knob still supports user name, min/max range, **Smooth (ms)** time, one of **14 output curves**, up to **8 OSC destinations** broadcasting simultaneously, and MIDI CC learn.
- **Cue system**: arm a scene as "next", fire it with **GO** / **Space** / MIDI. Optional auto‑advance to the next sequence slot after each GO.
- **Scene‑to‑scene Morph**: one knob in the transport glides every cell from scene A to scene B over N ms.
- **Pause freezes scene time**: Pressing Pause freezes the active scene's elapsed time; on Resume the countdown continues from where it was. Visual countdowns in Timeline + transport bar freeze in lockstep.
- **Show / Kiosk mode**: locks the UI into a performance view (F11, hold Escape to exit).
- **Autosave + crash recovery**: silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/`, keeps 30 rolling copies. Writes are atomic so a crash mid‑save can never corrupt the session file.
- **Save‑before‑quit + Save‑before‑new (v0.5)**: clicking the OS X button or the **New** button prompts a "Save before…?" modal with Yes / No / Cancel. Yes overwrites the current file or writes into the project's `Sessions/` folder. No discards. Cancel aborts.
- **Per‑session GUI layout (v0.5)**: zoom, row height, column widths, inspector width, drawer height, and Collapse Scenes / Collapse Instruments flags are saved inside the session file. Re‑opening a session restores the exact layout you saved.
- **Monitor drawer (renamed v0.5)**: bottom panel streams BOTH outgoing OSC AND outgoing MIDI in parallel resizable columns. Per‑data‑column widths drag from the header. Filter + Pause + Clear. Buffers persist across drawer close. Toggle with **O**.
- **Transport bar**: always visible at the bottom: Play / Pause / Stop, cue GO, Morph enable + ms, **live HH:MM:SS:MS time counter** AND a **live remaining‑time pill** for the currently playing scene right next to it.
- **Clip Templates**: save full clip configs and apply them to empty cells.
- **Multi‑select clips**: Ctrl+click adds clips to a disjoint selection.
- **Multi‑select sequence slots**: Shift+click in the Scene Steps grid OR the Timeline extends a contiguous slot range. Right‑click → Clear Scene from N slots / Set Follow Action on every covered scene at once.
- **Global MIDI Learn**: one button. Click a scene, clip trigger, **Instrument group trigger**, or Meta knob, wiggle a MIDI control. Blue overlays show learnables, green = bound.
- **UI zoom**: Ctrl+wheel rescales everything below the main toolbar (0.5×–2×), including the Pool drawer + OSC monitor.
- **17 themes**: including two **rich themes** (Nature, Cream) that swap classic HTML controls for bespoke Rainbow‑Circuit‑flavoured arc sliders, mode icon rows, console‑style readouts, and card‑wrapped inspector sections.

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
| **Meta Controller bar** | Toggled via the Inspector or **M**: sits below the main toolbar, resizable. |
| **Editor** (Edit view) | Left: Scenes/Instruments header (Add buttons + counts) and Instruments sidebar (Templates with their child Parameters indented under them). Each Instrument header has a `+PARAM` chip and a centered group‑trigger button at every Scene intersection. Center: Scene columns. Right: Inspector panel (toggleable with **I**) - top toggles for Notes / Meta Controller / Collapse Scenes / Collapse Instruments, then Clip Template dropdown when a cell is selected, then the clip's full parameters. |
| **Sequence view** | Left: resizable Scenes palette (200–1200 px) + a per‑scene inspector below it (toggleable with **S**). Center: 128‑slot Scene Steps grid OR Timeline visualization (toggle next to Clear mode), with progress fills + live time on every instance of the playing scene. Bottom: global transport bar. |

**Tab** toggles Edit ↔ Sequence - even from inside text inputs, dedicated to view‑switch only.

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

- **Built‑in tab**: shipped library.
  - **Instruments**: OCTOCOSME (5 RGB rings + strip RGB), Generic XYZ pad, Pandore.
  - **Parameters**: RGB Light (v3 0–255), Knob (float 0–1), Motor (bipolar ‑1..1), Button (bool discrete), XY Pad (v2).
- **User tab**: your authored Instrument Templates + Parameter blueprints.
- **Network tab**: auto‑discovered OSC senders on the local network (see below).
- **Drag any item onto the Edit‑view sidebar** to instantiate.
- **Click an item** to edit its full metadata in the right‑side Inspector.
- **Pop out** the Pool (`⤢` button or fast double‑click on the title bar) into a centered floating window.

### Network discovery (Pool · Network tab)

Auto‑discovers OSC senders on the local network and lets you drag any device straight onto the grid as an Instrument.

- **Passive UDP listener**: click **Listen** to bind a port (default `9000`, configurable) and the Pool starts logging every sender that hits that port.
- **Discovered devices** show as draggable rows keyed by `ip:port`, with a green/grey activity dot (fresh < 2 s), packet count, and last‑seen age that refreshes every second.
- **Expand a device** to see every OSC address path it has emitted, with its OSC type tags and a short live preview of the latest args.
- **Drag a device onto the Edit sidebar** to materialise it as a user Instrument Template:
  - One Parameter per observed OSC address.
  - **Auto‑typed**: 1× `f`/`i` → float / int / bool / string; 2× numeric → `v2`; 3× → `v3`; 4× → `v4`; OSC type tags from the observed args drive `paramType`. Multi‑arg discoveries get a full `argSpec` with canonical slot names (x/y, x/y/z, x/y/z/w, r/g/b/a for colour with max=255).
  - **Common OSC root extracted**: if half or more of a device's addresses share `/octocosme/...`, the template adopts `octocosme` as its name and `/octocosme` as its base path, with each Parameter's path stripped to the remainder.
- **Status header** shows the listener's bound port + this machine's IPv4 addresses so the user knows exactly what to point their sender at.
- **Drag‑cancel cleanup**: if you start dragging a discovered device and abort (Esc, drop off‑target), the just‑materialised template is removed from the Pool so you don't accumulate orphan Instruments.
- **Clear** wipes the discovered‑device cache (useful after moving networks).
- **Title‑bar dot** stays in sync with bind status even when the Pool drawer is collapsed - green when listening, red on bind error.

The listener stays closed by default so the app doesn't fight other tools for port 9000 unless you ask it to.

### Group triggers (Instrument × Scene)

Templates carry no clips of their own, so the cell at each Instrument header × Scene column intersection is a **centered Play/Stop button** that fires every child Parameter's clip on that scene at once.

- Click → triggers all children that have a clip on this scene.
- Click again (any child playing) → stops every active child of this Instrument on this scene.
- **MIDI‑learnable**: Global MIDI Learn → click the group trigger → wiggle a control.
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
- **+ Silence** button - adds a gray scene with no cells (no OSC fires).
- **Right‑click in the palette's blank area** → Add Scene · Add Scenes…
- **Delete** key with one or more scenes selected.

### Sequence view

A 1 – 128 slot grid for laying out scenes in playback order. Left column is user‑resizable (200 – 1200 px).

- **Scene Steps grid**: 16 columns by default; with > 72 scenes, cells shrink to 28 px min width.
- **Timeline view**: each occupied slot becomes a horizontal block whose width is proportional to its Duration. Click a segment to highlight it; the segment currently playing gets a separate accent ring + live `Xs left` readout.
- **Click a scene** in either view to focus + mark it as the Transport Play start point.
- **Shift+click** extends a contiguous slot multi‑selection.
- **Right‑click a slot or segment** → menu with **Clear Scene** and **Set Follow Action ▸** submenu (bulk‑aware).
- **Drag a slot** to swap its content with another slot.
- **Clear mode**: click any slot to empty it.
- **Live progress fill**: every instance of the currently playing scene fills orange from 0 → 100% across its Duration.
- **Single‑instance highlight**: only the slot that fired gets the accent ring.

### Transport (bottom bar)

- **Play**: Sequence view: starts the sequence from the selected slot. Edit view: plays the focused scene as a one‑shot.
- **Pause**: freezes auto‑advance AND freezes the active scene's elapsed time.
- **Stop**: full stop, clears the slot selection.
- **Time**: running HH:MM:SS:MS counter.
- **Scene remaining**: colored pill with the current scene's color + live countdown.
- **GO** + Next auto‑advance toggle.
- **Morph** enable + ms.

### Cue system

- **Arm** a scene three ways: right‑click → *Arm as next* · Alt‑click · press **A** with the scene focused.
- An armed scene shows a pulsing blue ring + `▶▶` chevron everywhere it appears.
- **Fire** with the **GO** button, **Space**, or a MIDI binding.
- **Next (auto‑advance arm)**: automatically arm the next non‑empty sequence slot after each fire.

### Scene‑to‑scene Morph

A single transport knob that turns every scene trigger from a snap into a glide. Per‑scene override + MIDI CC mapping (0..127 → 0..10 000 ms).

### Clips (cells)

Each clip carries the full per‑scene settings for one Parameter. Open a clip in the Inspector by clicking its tile.

- **Destination** (IP : port, with `~def~` link to session default), **OSC Address**, **Value** (auto‑detected at send), **Delay** + **Transition**.
- **Modulation** (collapsed by default): LFO / Ramp / Envelope / Arpeggiator / Random / Sample & Hold / Slew / Chaos - each with its own live visual.
- **Sequencer** (collapsed by default): 1–16 steps (or 4–1024 for Draw), one of 9 modes, BPM/Tempo/Free sync.
- **Scale 0.0–1.0**, **Rest behaviour** (Hold / Last), per‑arg **Pin** for multi‑value parameters.

#### Visual cues

- **Trigger square solid orange**: clip is armed and held.
- **Clockwise orange sweep inside the square**: clip is modulating or sequencing.
- **Live value text in orange** in the cell tile - currently being modulated/sequenced.
- **Per‑step pulse** in the Inspector - flashes the current step at the sequencer rate.

### Sequencer - 9 modes

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

The 9 mode pictograms read as a row of mini instruments - pick by clicking the icon. Rich themes (Nature, Cream) render the row as a stylised icon picker; standard themes use a dropdown.

### Generative mode

Flip the **Generative** switch on any sequencer and the engine reinterprets every step value through a per‑mode musical rule rooted in a "true artistic world intention." Each rule reads the cell's base value as a seed and shapes the step output around it; the **Variation** knob controls how far the output strays from the base.

| Mode | Generative rule |
| --- | --- |
| Steps | **Tide**: smooth sine swell across one cycle, peak position seeded. |
| Euclidean | **Accent**: hits land harder on the downbeat, off‑beats lighter. |
| Polyrhythm | **Voicing**: Ring A and Ring B sit at different pitch/colour levels, coincidences resonate. |
| Density | **Wave**: gate samples through a sine wave, amplitude knob = swing. |
| Cellular | **Crowd**: cells with crowded neighbours emit louder than lonely ones. |
| Drift | **Terrain**: walker samples a height field shaped by Variation. |
| Ratchet | **Scatter**: burst values picked from a chaotic distribution. |
| Bounce | **Decay envelope**: each step shrinks by `bounceCoeff^i`. |
| Draw | **Live curve**: regenerates a hash‑varied curve at each cycle wrap, anchored to your drawing. |

Generative outputs respect Scale 0.0–1.0 - values stay inside `[0, 1]` even when the base is large.

### Modulators - 8 types with live visuals

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

All modulators share one clock - **Free Hz** or **BPM‑synced + division** (whole / dotted / triplet). The visualisation respects sync mode so a synced LFO shows the right number of cycles per beat as you slide BPM.

### Smart Scale 0.0 – 1.0 (auto‑range)

Old behaviour: `clamp01()` on every output. A value range of 0..255 collapsed to 0/1.

New behaviour: when **Scale 0.0–1.0** is on, the engine **auto‑ranges the actual cycle's min/max** into `[0, 1]`. The full musical span maps proportionally - a 0..255 RGB byte becomes 0..1 with every intermediate value preserved.

- **Sequencer + Scale**: precomputes the cycle's per‑token min/max (including ratchet sub‑pulses up to maxDiv=16) and normalises into `[0, 1]`.
- **Modulator + Scale (no sequencer)**: predicts the modulator's output range and normalises against THAT, so a Chaos modulator on a base of 100 spans the full `[0, 1]` visually rather than clipping.
- **Plain Scale (no mod, no seq)**: classic clamp.
- **Degenerate range** (all step values identical) - emits the user's actual value clamped into `[0, 1]`, not a flat 0.5 placeholder.

### Hold vs Last rest behaviour

Choose how the engine handles sequencer rests (steps the gate mutes).

- **Hold** (default) - re‑sending the same payload is suppressed; the receiver naturally holds whatever it received last tick. Saves bandwidth and avoids re‑triggering one‑shot receivers.
- **Last**: re‑emits the previous step's value on every rest. Useful for receivers that need a fresh packet to stay alive.

Per cell. Sticks with the session.

### Multi‑arg parameters + pinned slots

Parameters with an `argSpec` (e.g. OCTOCOSME Voice Pots with four pots per voice, or any discovered v3 / v4 / colour) emit multi‑arg OSC bundles.

- **One numeric input per slot** in the cell editor, labelled by name (HAUTEUR1 / r / x / etc.).
- **Each slot has its own pin**: click the pin to freeze that slot at the value shown. Modulators + the sequencer keep running on the unpinned slots; the pinned slot emits its captured value forever until unpinned.
- **Sequencer respects pinned slots**: when the sequencer is on and your step value is a single number, that number is broadcast to every *unpinned* slot. Pinned slots keep their frozen values. Type a multi‑token step (`0.5 0.7 0.9 0.2`) to drive each unpinned slot independently per step.
- **Fixed protocol headers** (argSpec entries declared with `fixed:`, like OCTOCOSME's `sender: "compositor"` and `timestamp: 0`) appear in the pin list as **locked rows with a `FIXED` badge**. The engine bypasses sequencer + modulator on these slots entirely - they always emit their declared value so receivers like Pure Data's `list split 2` can do their job.

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
- **Resizable**: drag the top edge. Max height now adapts to UI zoom so the drawer can't eat the workspace at 2× scale.
- Single‑line title bar - `× close · OSC Monitor · Log N/M · filter input · Live · Clear`.
- Filter by substring, pause, clear.
- Pool pane sits beside the log; each can be hidden independently.
- **Scales with Ctrl+wheel zoom**: Pool tabs, device rows, and OSC log all scale alongside the rest of the app.

### Autosave + crash recovery

- Silent snapshot every 60 s to `~/AppData/Roaming/dataFLOU/autosave/<name>-<timestamp>.dflou.json`.
- Keeps the most recent **30** copies.
- **Atomic writes**: saves go through `<file>.tmp` then `fs.rename`, so a crash mid‑write can never corrupt the existing session file.
- A `.running` sentinel detects unclean shutdowns; on next launch the app pops a **Restore from autosave?** modal.
- One final autosave fires on quit (serialised with the 60 s tick so concurrent writes can't race).

### Meta Controller (32 knobs, 4 banks, Destination picker)

**32 knobs across 4 banks (A, B, C, D)**: 8 per bank. Toggled with **M** or via the Inspector. Bank selector is a single column of 4 buttons so the bar's footprint stays narrow.

Per‑knob: name, min/max, smooth (ms), curve (14 shapes), MIDI CC binding, up to 8 OSC destinations.

**New Destination picker** in the Destinations row - instead of "+ Destination" creating an empty row you fill in by hand, the picker walks Instrument → Parameter → optional Value‑slot, then `+` commits the resolved destination:

1. **Instrument** dropdown - lists every Instrument header on the current sidebar, plus an "(orphan parameters)" section for un‑grouped Function rows.
2. **Parameter** dropdown - appears after picking an Instrument, lists its child Parameters.
3. **Value** dropdown - appears only when the chosen Parameter has multiple value slots (`argSpec.length > 1`). Pick "All values" to send to the parent address, or pick a specific slot (x / r / HAUTEUR1 / etc.) to suffix the OSC address with a sanitised slot name.

Click **+** to commit. The resolved `destIp`/`destPort`/`oscAddress` is pre‑filled into a new destination row; with no Instrument picked the **+** falls back to the freeform "add empty destination" behaviour. After committing, the Instrument stays sticky so you can rapidly wire several Parameters under the same Instrument.

### Show / Kiosk mode

Locks the UI into a performance view. Enabled from the preferences sub‑toolbar or with **F11**. Hides authoring chrome; keeps transport, GO button, scene palette, sequence grid, Meta Controller knobs. Exit by holding Escape ≥ 800 ms or pressing F11 again.

### Themes (15 + rich themes)

**17 built‑in themes** (picker in the preferences sub‑toolbar). Bundled woff2 fonts so everything works offline.

**Two of them are "rich themes"**: Nature (Hopscotch palette: dark warm grey + olive→teal + orange) and Cream (Peaks palette: cream paper + mustard ochre). When either is active, the inspector swaps several controls for bespoke Rainbow‑Circuit‑flavoured replacements:

- **Mode icon row**: sequencer mode picker becomes a row of 9 mini pictograms (vertical bars for Steps, dots on a circle for Euclidean, two interlocking rings for Polyrhythm, etc.). Active icon glows in the accent hue.
- **Arc slider**: Modulation Rate becomes a half‑circle of warm→cool gradient bars (RcArcSlider).
- **Flat gradient bar**: Sequencer Variation becomes a horizontal tonal sweep with a tip indicator (RcFlatBar).
- **Card‑wrapped sections**: Soft cards group inspector blocks, console‑style readouts for numerics.

Classic themes (Studio Dark, Warm Charcoal, Graphite, Paper Light, plus the original 10) keep the standard HTML controls.

---

## Sessions

Saved as plain JSON via the standard OS save dialog (suggested extension `.dflou.json`).

Contents:

- Session name, default OSC, global BPM, tick rate, sequence length
- All Tracks (Templates + Parameters with their kind/parent/source‑template links), per‑track defaults, MIDI bindings, per‑arg `persistentSlots` / `persistentValues` (pins), `midiOut` defaults
- All Scenes (name, color, notes, duration, follow action, multiplicator, morph‑in, MIDI binding, per‑Instrument group MIDI bindings) and the cells inside them - with every sequencer + modulator field, including drawValues (length 1024), ratchet mode, cellular seed LFO, generative state, rest behaviour, `midiOut`, per‑cell `persistentSlots` overrides, `scalingEnabled` / `scalingMin` / `scalingMax`, etc.
- The 128‑slot sequence
- The Pool (Instrument Templates + Parameter blueprints; builtin entries dedup'd against the shipped library on load)
- Selected MIDI input device name (reopened automatically on load)
- Meta Controller bank state (knobs + MIDI bindings)
- `forwardTargets[]` - OSC fan‑out configuration
- `session.ui` - persisted GUI layout: zoom, row height, column widths, drawer height, collapse flags

In addition, two separate library files live in `<userData>/`:

- `pool-library.json` - User Instruments + Parameters that follow you across sessions. Auto‑merged into every new / loaded session's pool.
- `scene-library.json` - Saved Scenes (capture results + manual saves). Displayed in the Pool's **Scenes** tab; drag onto the grid to instantiate.

Old sessions migrate cleanly via `propagateDefaults()` + `migrateSequencer()` - pre‑v0.4.0 single‑track sessions load as orphan Parameters with no parent; new fields (MIDI Out, persistentSlots, scaling, session.ui) are backfilled with sane defaults.

Saves are **atomic**: the file is written to `<path>.tmp` then renamed, so a crash mid‑write can never corrupt your session. The Save button **flashes blue** on a successful write.

By default, sessions saved via the Save‑before‑quit / Save‑before‑new flow (when no file path is set yet) land in `<project-root>/Sessions/` (or `<install-dir>/Sessions/` in production builds), with a fallback to `<userData>/Sessions/` if the install dir is unwritable.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **Tab** | Toggle Edit ↔ Sequence (works even inside text inputs) |
| **Space** | GO - fire the armed scene; if none, trigger the next non‑empty slot |
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
- **Main process (Node)**: UDP sockets (OSC sender + passive discovery listener + byte‑perfect Forwarder), native MIDI output (`@julusian/midi` / RtMidi), scene engine, fixed‑tick LFO + sequencer + all 9 generative modes, file I/O, autosave, Pool library, Scene library, network discovery. Pure logic so timing stays stable independent of the UI.
- **Renderer process**: all UI, Web MIDI input handling, drag‑drop sequence grid (`@dnd-kit`), bespoke SVG modulator visuals, Capture popup, Undo/Redo subscriber.
- **Preload**: typed `window.api` bridge.

```
src/
├── main/
│   ├── engine.ts            # fixed-tick scene engine, 10 sequencer modes, 10 modulators,
│   │                          # two-stage modulator (Mod 2 → Mod 1's rate/depth/shape),
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
    ├── store.ts             # Zustand global state - session, UI state, network devices,
    │                          # poolLibraryCache, sceneLibrary, undo/redo counters,
    │                          # newSessionConfirmOpen, captureOpen, …
    │                          # + buildSessionForSave() helper
    ├── undo.ts              # 3-deep ring buffer subscriber, 500ms coalesce
    ├── metaSmooth.ts        # renderer-side knob-value tweener
    ├── midi.ts              # Web MIDI input manager
    └── styles.css           # incl rich-theme variables + animations
```

---

## Release notes - 0.5.14

A large correctness + features release: **8 new features**, **35 bug fixes** (a multi-agent review pass over the whole v0.5.13 surface, plus issues found in live use), a routing-gate fix, and a README cleanup. Highlights below; the full bug list follows.

### New features

- **Modulation 2 → direct value routing.** Mod 2 can now modulate a clip's parameter **value** directly — a third routing column **M2** in the Cell Inspector's routing matrix (column order: MOD · M2>1 · **M2** · M2>S · SEQ), with its own ALL toggle, defaulting all-unchecked. A new **M2 > Value amount** knob (default 50%) and an **Add / Mult / Mix** math selector control how it combines with Mod 1 when both drive the same slot. Per-slot Delay / Variation apply as for the other routes. Stacking with M2>1 is allowed (tooltip warns it doubles Mod 2's influence).
- **Hardware Mode "Takeover: Catch / Jump"** (opt-in per template, default Catch). **Jump** makes any controller value change take over a parameter instantly — no soft-takeover approach, no catch tolerance. For switches/selectors and for performers who want the knob's current position to win immediately. Catch (the v0.5.5 soft-takeover) stays the default.
- **Ramp modulator "From" mode.** A fourth Ramp mode beside Normal / Inverted / Loop: two number boxes (**From** / **To**) let the ramp run between arbitrary values (including negative and >1 raw OSC values) over the ramp's time/curve, composing with depth exactly like Normal mode.
- **"Update scene to current settings"** — right-click a scene (under "Capture current state as new scene"). Stamps the engine's currently-emitted values — Hardware Mode overrides included, plus sequencer steps, modulator output, per-arg pins — into THIS scene's cells in place. Disabled when the scene isn't playing (no live values). Undo-able; refreshes the linked Pool entry.
- **Scene Inspector in Grid view.** Clicking a scene header in the Grid now shows the Scene Inspector (name / notes / Dur / Next / Morph / Weight) in the inspector pane, exactly like the Sequence view.
- **Duplicate / new scene insert adjacent.** Duplicating a scene, and creating a new scene, now insert directly **after** the source / focused scene instead of at the end of the timeline.
- **Undo depth 3 → 100.** The undo history now stores structural-shared session references instead of deep clones (the store is strictly copy-on-write), so 100 levels cost less memory and CPU than the old 3 did. A dev-only deep-freeze guard catches any future in-place mutation loudly.

### Modulation 2 routing-gate fix

Enabling Mod 2 with the **M2>1** column unchecked was still letting Mod 2 affect Mod 1 — both in the Inspector's live "breathing" overlays (they keyed only on Mod 2 being *enabled*, not *routed*) and, in the **envelope** and **ramp** engine paths, in the actual output (those two branches weren't gated per-slot like the others). Both are fixed: all Mod-1-side overlays and every modulator path now honor the per-slot M2>1 routing. The **M2** column spacing was also evened out.

### Bug fixes

**Hardware Mode (engine):**

1. `deviceMatch: 'ipOnly'` now keys movement state by IP alone — it was keyed by `ip:port`, so ephemeral-port senders never caught and leaked one map entry per packet. Added an eviction cap.
2. Disabling Hardware Mode now clears caught overrides — they used to freeze a parameter at the last hardware value forever.
3. Slow float-knob turns now catch (the movement gate matched its own spec: cross-threshold OR aged-with-change).
4. A `reset`-mode scene change no longer wipes `persist`-mode templates' catches.
5. Catch state is restored from the session only on a real load, not on every session push (fixes a resurrection race).
6. Non-finite OSC args no longer permanently poison a slot's movement baseline.
7. `whenIdle` forward no longer un-suppresses during a scene's fade-out (dual-emission).
33. Catches restored from a saved session now self-heal on the first packet (already-caught check moved ahead of the change gate).
34. The **Random** modulator now honors the routing matrix — it was ignoring the per-slot MOD column and driving all slots. Now respects MOD/Delay/Variation and the new M2-direct route too.

**Network:**

8. Forward-diagnostics and discovered-device maps evict the oldest entry instead of refusing new senders at the cap.
9. Double-enabling the OSC listener no longer clobbers a healthy socket (fd leak).
10. Loopback detection covers all `127.x.y.z` addresses, not just `127.0.0.1`.
11. The forward socket isn't recreated by the next packet when all forward targets are disabled.

**Sessions / persistence:**

12. `forwardMode` / `deviceMatch` / `alwaysForward` are no longer **stripped on session load** — the load-time sanitizer dropped them, so "When idle" / "IP only" reverted to defaults on every reopen (and re-saved stripped). This was the cause of Hardware Mode silently failing to forward to downstream after reopening a session.
13. Released catches no longer resurrect — stale `hardwareState` is cleared on save.
14. "Capture current state as new scene" / "Duplicate scene" no longer copy the source's Pool-library link or MIDI trigger (renaming the copy used to overwrite the source's saved entry).
15. Undo / redo sanitizes dangling selections (could crash the Inspector).
16. Linked Pool scenes re-sync after undo / redo.
17. Scene-id generation guards against collisions.
18. Scene-palette and info-panel sizes now persist across restarts.
20. The linked-scene library disk write is debounced (was one write per keystroke).

**UI:**

19. Saved-scene **Notes** no longer drops focus / loses characters while typing.
21. Saved-scene Duration / Multiplier / Morph commit on blur (were one disk write per keystroke).
22. The Capture popup restores the OSC listener to its prior state on close.
23. The Hardware Mode tooltip points at the current "Forward to downstream" control (was the removed "Always forward" checkbox).
24. The listener bind-error tooltip points at the correct "Listen on" port.
25. The Hardware Mode device picker shows a configured-but-offline binding instead of "pick a device".
26. The per-parameter arg-slot lock can now lock out all slots (unchecking the last one used to silently re-check everything).
27. The "Bind to template" menu hides hidden draft templates.
28. Double-clicking the Listening pill no longer toggles the listener twice before opening Capture.
29. The collapsed-mode scene-name input no longer drops focus.
30. Capture-popup freshness dots tick live; 31. and re-pick a device when the list repopulates.
32. The scene Arm / Clear-arm menu label no longer goes stale while open.
35. **Typing a multi-digit duration in a scene header no longer triggers other scenes.** The header's focus-release blur was stealing focus to `<body>`, so digits typed into the Duration field (e.g. "40") leaked to the global number-key scene-trigger shortcut and fired scenes 4 and 10. The header click now keeps focus on an editable control the user clicked into.

### Docs

- README: fixed 23 broken Table-of-Contents anchor links and normalized the heading / emphasis hierarchy.

### Known parked item

- View-switch grid-scroll preservation was reverted — the earlier attempt interfered with horizontal mouse-wheel scrolling. (Unrelated: if your horizontal wheel only scrolls one direction, that's a mouse-driver mapping issue, not dataFLOU — `Shift` + the vertical wheel scrolls horizontally both ways as a built-in workaround.)

---

## Release notes - 0.5.13

**Single-purpose patch release: Hardware Mode discrete-slot catch.** Two failure modes, one gate:

1. **After v0.5.12, slow single switch increments never caught** — fast turning worked, one-press-then-wait didn't. The int/bool catch path sat behind the float movement detector, whose `movementWindowMs` aging treats a long-idle flip as "not moving" and whose two-sample baseline eats the first packet entirely.
2. **The obvious counter-fix (catch on ANY packet) fails the other way** for controllers that **stream** their state continuously (the OCTOCOSME broadcasts at a fixed rate): the first packet after a scene trigger cleared catches would instantly re-catch every discrete slot, so scenes could never assert their saved switch data. The hardware state always won. (This variant briefly shipped as the first v0.5.13 build — withdrawn and replaced by this one.)

### Fix

Discrete (`int` / `bool`) slots now gate on **value change** (`changedPerSlot`): did this slot's value differ from the device's previous transmission? No movement threshold (integer deltas are always ≥ 1), no `movementWindowMs` aging (a switch flipped after an hour idle is exactly as intentional as one flipped immediately). A re-send of an **unchanged** value — a static stream, or a multi-arg packet where only a sibling slot flipped — is not a change and cannot catch.

The resulting contract:

- **Scene trigger** → catches clear (`reset` mode) → scene's saved switch data plays, even while the controller keeps streaming its (unchanged) state
- **You flip a switch** — slowly, quickly, after any idle gap → instant catch on that slot
- **Multi-arg packet where only one switch flipped** (e.g. `/B/strips/switches` with 8 bools) → only the flipped slot catches; siblings stay under scene control
- **Float slots unchanged** — still the classic v0.5.5 movement detector (threshold + aging window)

Soft-takeover exists to protect smooth float handoffs; a switch, instrument selector, or kill toggle has nothing smooth to protect — any **value change** IS the user's intentional input.

Only file changed: `src/main/engine.ts` (`handleHardwareInput`). No session migration, no schema change, no UI change.

---

## Release notes - 0.5.12

A Hardware Mode UX hardening + workflow pass. The headline is **closing every silent-failure mode** in Hardware Mode that bit show-day setup: a live status dot next to the HW Mode label, a `deviceMatch: ipOnly` toggle for controllers with ephemeral source ports, right-click "Bind to template" on Network Discovery rows, a 3-state `forwardMode: 'suppress' | 'always' | 'whenIdle'` policy that lets the controller reach downstream consumers (PD, Max) only when no scene is playing (auto-flipping via engine.activeSceneId), int + bool slots that catch INSTANTLY under Hardware Mode (no more "encoder feels dead unless I land on the exact int"), info-popup tooltips on every Hardware Mode field, and a new "Capture current state as new scene" right-click action that snapshots the engine's live emitted values (including HW Mode catches) into a new scene cloned from the source. Plus loopback flag in Network Discovery, Capture loopback filter, and legacy `oscEnabled` cleanup on session load.

### Hardware Mode status dot

A small coloured dot now sits next to the "Hardware Mode" label in the Instrument Inspector. Polls `network:getForwardDiag` at 2 Hz against the configured `deviceIp`/`devicePort` and shows:
- 🟢 **green** - packets observed AND suppressed in the last 5 s (healthy)
- 🟡 **yellow** - HW Mode enabled but no matching packets in the last 5 s (controller offline, wrong devicePort, firewall blocking, wrong listener port - the most common silent-failure mode after first-time setup)
- 🔴 **red** - packets observed AND being forwarded too (dual emission detected, would have surfaced as ⚠ DUAL EMISSION in the Pool's HW Mode Suppress panel)

Single point of "is my controller getting through" at the place where you configure it - no need to flip to the Pool · Network tab to confirm.

### `deviceMatch: 'ipOnly'` toggle

New "Source match" dropdown in the Hardware Mode section. Default `Exact ip:port` keeps the v0.5.5 strict match - correct when the controller binds a fixed source port (OCTOCOSME Teensy uses `udp.begin(8888)` which fixes its source port). New `IP only` option relaxes the check to match any source port from the configured IP - necessary for software OSC senders that bind ephemeral source ports per packet (Lemur, TouchOSC, ad-hoc Max/PD/Python OSC clients). When the HW Mode Suppress panel shows **⚠ PORT MISMATCH** for a template, switching to `IP only` is the fix. Engine reads `template.hardwareMode.deviceMatch` in both `isHardwareModeSource` (the v0.5.11 forward-suppression hook) and `handleHardwareInput` (the per-packet catch-mode entry point), so both paths stay in lockstep.

### `alwaysForward` toggle

New checkbox in the Hardware Mode section: **"Always forward (controller reaches PD/Max even with no scene)"**. Default OFF preserves v0.5.11 forward-suppression behaviour (clean single emission per parameter). ON lets the raw forward path through even though Hardware Mode is consuming the packet - the engine STILL catches the controller into scene cells AND the downstream consumers (PD, Max, anything in Forward targets) STILL get the raw bytes. Use case: when no scene is playing, suppression alone would close the controller's path to downstream consumers entirely - this gap broke standalone controller use during rehearsal / soundcheck. Trade-off: during scene playback, downstream sees both the raw forward AND the engine's caught value (dual emission for caught slots); most downstream consumers handle this fine (last-write-wins). Opt-in escape hatch documented in the field's tooltip.

### Right-click "Bind to template" from Network Discovery

The right-click menu on a Pool · Network device row gets per-template **Bind to <Template name>** actions below the existing "Rebind every HW-Moded Instrument" batch action. Each per-template item sets that template's `hardwareMode.{deviceIp, devicePort, enabled}` to this device's source ip:port in one click, auto-enabling HW Mode if it was off. Templates already bound to this exact device show a ✓ prefix. Eliminates the manual-typing-source-port trap that was the most common Hardware Mode config bug. Loopback sources (127.0.0.1 / ::1) are hard-excluded from this list - you can't accidentally bind HW Mode to dataFLOU's own scene-to-loopback-bus emissions.

### Loopback flag in Network Discovery + Capture filter

`DiscoveredOscDevice` carries a new `isLoopback?: boolean` flag set in `observe()` when the source IP is `127.0.0.1` or `::1`. Affects three UIs:
- **Network Discovery row**: loopback devices render with a muted italic ID + a "self loopback" tag.
- **Hardware Mode device picker**: hard-excluded (`networkDevices.filter(d => !d.isLoopback)`).
- **Capture popup**: hard-excluded from the device list, the auto-pick, and the per-row chips. Eliminates the per-row "compositor / 192.168.101.191" flicker that appeared when dataFLOU's own loopback emissions and a real hardware controller both pumped packets into the listener.

### Capture current state as new scene

The scene right-click menu gets a new **"Capture current state as new scene"** action between Duplicate and Delete (single-scene only). Reads the engine's `currentValueBySceneAndTrack[sceneId][trackId]` for each cell on the source scene and writes the live string into the new scene's cell value. Live string already reflects: source scene's base value → sequencer step → modulator output → per-arg pins → **Hardware Mode catches**. So the workflow is: trigger a base scene → tweak via OCTOCOSME → right-click → Capture current state. The new scene appears inserted **directly after** the source in the grid (not appended) so the visual association is preserved. Named `<source> (capture)` (vs Duplicate's `(copy)`). When the right-clicked scene is not currently active (engine has no live values), falls back to plain duplicate.

### HW Mode Suppress panel: per-source `lastSeenAtMs`

`ForwardDiagEntry` carries a new optional `lastSeenAtMs` field set on every packet in the listener's per-source counters map. The HW Mode Suppress panel's per-template card uses it to render a green / yellow "X seconds ago" badge alongside the counter trio - reveals "configured source has gone silent" even when the static counter snapshot looks healthy.

### Info-popup tooltips on Hardware Mode fields

The local `Field` component in `InstrumentsInspectorPane.tsx` learned an optional `tooltip?: string` prop. When set, renders a small circled `i` affordance next to the label (discoverable - users don't randomly hover labels) and propagates a native `title` to the wrapping label so hovering anywhere in the field surfaces the description. Applied to every non-obvious Hardware Mode field: Hardware Mode checkbox itself, Catch lifecycle, Source match, Catch tol, Movement Δ, Always forward. Tooltip strings cover the WHY + the trade-off + the tune-up/tune-down decision at the point of configuration.

### Session-load migration: template-kind `oscEnabled` cleanup

`applyV0512Migrations()` runs in `setSession()`. Walks `session.scenes[].cells` and force-sets `oscEnabled = false` on every cell whose track has `kind === 'template'`. Template-kind tracks (Instrument-template "header" rows) host the group-trigger UI button, not data-emitting cells; the engine's `oscEmitAllowed` gate already blocked emission at runtime, but the on-disk flag was lying. Cleans up the ghost `/dataflou/value 0`-style packets that some legacy sessions emitted on every scene trigger. Logs a one-line summary to the dev console (`[v0.5.12 migration] template-cell oscEnabled forced false: N`). Idempotent and non-destructive (only flips a flag).

**Migration NOT included** (and a cautionary tale documented in the source): stripping the `compositor 0` prefix from cell values was implemented and reverted before shipping. The prefix looks like a vestigial pre-v0.5.5 takeover-gate artifact, but `cell.value` is **positionally indexed** against `argSpec` - stripping the two-token prefix shifts every editable slot by 2, silently corrupting multi-arg cells with `fixed` argSpec entries (OCTOCOSME `/A/strips/pots` is the worst case: editing HAUTEUR1 would write into MODA3). The fix for the original symptom (Capture flicker) lives in the loopback filter instead, not in touching cell.value.

### Group-trigger cell tooltip

`InstrumentTriggerCell`'s tooltip now explicitly says "Group trigger ... The header itself emits no OSC; it just batches the children." Closes the loop on the engine + factory + on-disk template-kind-is-not-data-emitting invariant. Pairs with the migration above.

### `BoundedNumberInput commitOn="blur"` opt-in

The shared `BoundedNumberInput` component learned an opt-in `commitOn?: 'change' | 'blur'` prop. `'change'` (default) preserves all existing behaviour across the codebase. `'blur'` defers upstream `onChange` until the input loses focus / Enter / Escape - local `str` state still updates every keystroke so the input is visually responsive, just the parent isn't told until the user finishes typing. Used by the Hardware Mode Catch tol / Movement Δ inputs because their values go through a non-bijective transform (`Math.round(x * 1000) / 10` on display, `/100` on commit) - per-keystroke commits caused snap-back and, under the constant store re-render pressure from the OSC monitor, focus loss while typing. Blur-only commit fixes both.

### Engine: per-template HW source match honors `deviceMatch`

`engine.isHardwareModeSource(ip, port)` (the v0.5.11 forward-suppression predicate) and `engine.handleHardwareInput(...)` (the per-packet catch-mode entry point) both honor `template.hardwareMode.deviceMatch`. When `deviceMatch === 'ipOnly'`, the port-equality check is skipped.

### `forwardMode: 'suppress' | 'always' | 'whenIdle'` (replaces the in-flight `alwaysForward` boolean)

The `alwaysForward` boolean shipped briefly in an internal v0.5.12 build but exposed an architectural gap: neither half of the toggle was correct alone.

- `alwaysForward = false`: clean single-emission during scene playback (no flicker), but the controller is silent at downstream consumers (PD, Max) whenever no scene is playing — breaks rehearsal / soundcheck.
- `alwaysForward = true`: controller always reaches downstream, but dual-emission during scene playback produces visible flicker.

v0.5.12 ships a 3-state enum instead:

```typescript
forwardMode?: 'suppress' | 'always' | 'whenIdle'
```

- **`'suppress'`** (default) — preserves v0.5.11 behaviour: never forward HW-Mode-bound packets. Clean single emission, no flicker. Controller silent when no scene plays.
- **`'always'`** — never suppress, forward always proceeds. Engine still consumes via `handleHardwareInput`, but downstream also receives raw bytes. Dual emission during playback (last-write-wins consumers handle it fine).
- **`'whenIdle'`** (recommended for live shows) — suppress DURING scene playback (no flicker), forward when no scene is active. The engine consults its own `activeSceneId` at packet-arrival time, so the policy flips automatically on scene start/stop without any UI action.

Backward compat: legacy sessions with `alwaysForward: true` continue working — `isHardwareModeSource()` resolves `forwardMode ?? (alwaysForward ? 'always' : 'suppress')`. The "Always forward" checkbox is replaced with a "Forward to downstream" dropdown carrying all three options + tooltip-documented trade-offs; the dropdown writes `forwardMode` directly and clears `alwaysForward` on first touch.

### Hardware Mode int + bool instant catch

The v0.5.5 catch-tolerance logic uses a percentage-of-range model that breaks down for integer and boolean slots. For an int slot like OCTOCOSME's `/A/strips/switches` (instrument selector 0-7) with a 5% catchTolerance, the engine computed `tol = 0.05 * 6 = 0.3`. But integer deltas are always 0, 1, 2... — anything off-by-1 fails because `1 > 0.3`. The encoder had to land EXACTLY on the scene's integer to catch, which broke "turn the encoder, it takes over" for any switch / selector / discrete control.

**Fix**: in `engine.handleHardwareInput`, when the slot's `track.argSpec[i].type` is `'int'` or `'bool'`, skip the tolerance check entirely and catch on first detected movement (movement detection is already gated upstream by `movingPerSlot[i]`). For `'float'` (and `'string'` as fallback), the existing tolerance-based soft-takeover is preserved — soft-takeover only makes sense for continuous params where there's a smooth-handoff to protect against. Discrete params have no audible/visible jump on integer transitions; any movement IS the intentional input.

For OCTOCOSME specifically, all four switch-typed tracks now behave correctly under Hardware Mode for the first time:

| Track | OSC address | Slot types → behavior |
|---|---|---|
| Voice Instruments | `/A/strips/switches` | INSTRU1-4 (int) → instant catch |
| Voice Kills | `/B/strips/switches` | KILL1-4 (bool) → instant catch |
| Intervalle | `/A/global/switches` | INTERVALLE (int) → instant catch |
| Global / Touch Mode | `/B/global/switches` | GLOBAL_MODE, TOUCH_MODE (bool) → instant catch |

Float pots (HAUTEUR, MODA, MODB, Global FX) continue using the existing 5% catch tolerance — smooth handoff preserved.

---

## Release notes - 0.5.11

A live-routing + ergonomics pass ahead of the **Juin Generatif** show. The headline is **session-wide OSC routing**: you can now flip the whole session's outgoing broadcast destination and listener port from the prefs toolbar, and an **Instrument-wide OSC port broadcast** lets you swap which physical controller an entire Instrument talks to in one click. Plus a diagnostic panel for the v0.5.10 Hardware-Mode-vs-Forward crash, a version + session name in the window title, a separate saveable toolbar zoom, and a tighter scene-title row.

### Session-wide OSC routing

The prefs sub-toolbar gets two new compact controls:
- **OSC Broadcast** (IP + port + Apply) - sets the session's default outgoing OSC destination in one place. Calls `broadcastSessionDest`, which stamps the chosen IP/port across the session's default OSC group so every Instrument that inherits the session default follows it.
- **Listener Port** (port + Apply) - sets the UDP port the compositor binds for incoming OSC (Hardware Mode + Capture + Forward source). Persisted on the session as `listenerPort`; the Pool · Network tab's port input now reads from and writes to the same session value, so the two surfaces never drift.

### Instrument-wide OSC port broadcast

The grid-side **Instrument Inspector** (click a Template/Instrument row header) gets a new **OSC Port (Instrument-wide)** section: type a port, click **Apply**, and the chosen port is written to the template default **and** every instantiated Parameter row's `defaultDestPort` **and** every clip across every scene. Built for the "two physical OCTOCOSME units on 1985 + 1986" case - swap which unit an Instrument drives mid-show without rebinding cells one by one (`broadcastInstrumentPort`).

### Rebind every HW-Moded Instrument to one device

Pool · Network tab: right-click any discovered device → **Rebind every HW-Moded Instrument to this device**. Repoints every Instrument whose Hardware Mode is enabled at the chosen device's IP/port in one action - handy when a controller comes up on a new address (`rebindAllHardwareModesToDevice`).

### Hardware Mode Forward-suppress diagnostic panel

A new panel at the bottom of the Pool · Network tab surfaces the v0.5.10 dual-emission fix live. While expanded it polls `network:getForwardDiag` (~500 ms) and shows a per-source card with **received / suppressed / forwarded** counters and a status badge: **✓ HEALTHY** (HW-Mode source is being suppressed as intended), **🔥 DUAL EMISSION** (packets are being forwarded that shouldn't be), **⚠ PORT MISMATCH** (source port ≠ the device's configured port, so the suppress hook is missing), or **✕ NO PACKETS**. The collapsed pill shows a red dot if anything is still forwarding. A **Reset** button clears the counters. This is the tool to confirm whether Max is getting clean single-emission OSC.

### Window title with version + session name

The window title now reads `dataFLOU_compositor v0.5.11 : OCTOCOSME` - app name + version (from `package.json` via `app.getVersion()`) + the current session name (session name → loaded filename → "Untitled"). Updates live when you load or rename a session.

### Separate, saveable toolbar zoom + zoom shortcuts

The whole UI's zoom (`uiScale`) already persisted per session; v0.5.11 wires the keyboard shortcuts **Ctrl + =** (zoom in), **Ctrl + -** (zoom out), and **Ctrl + 0** (reset to 100 %). On top of that, the **top toolbar now has its own independent zoom** (`topBarScale`) with a **Toolbar [−] NN% [+]** control in the prefs panel - the percent button resets it to 100 %. Saved inside the session, so a per-show toolbar size travels with the file. Useful on small laptop screens where the global zoom made the toolbar text too tiny.

### Tighter scene-title row + horizontal scroll

- **Scene title row**: the per-scene colour-picker square now sits flush above the **Next** (Follow Action) dropdown's right edge instead of stretching to the full column width, reclaiming horizontal space in every scene column.
- **Narrower minimum widths**: scene columns can now shrink to **140 px** (was 180) and the right Inspector to **280 px** (was 320).
- **Horizontal scroll wheel**: trackpad / tilt-wheel horizontal deltas (`deltaX`) now scroll the grid horizontally even when the pointer isn't over a native horizontal scrollbar.

---

## Release notes - 0.5.10

The big one for **Juin Generatif** (June 14 talk): a **Generative Scene Sequencer**. One button at the top of the Sequence view turns the entire scene timeline into a shuffle source - the engine picks each next scene from a weighted, similarity-aware pool with min/max duration windows, four selection-mode presets, and seven MIDI-learnable controls so you can drive the whole thing from a hardware controller during a live set or installation.

### Generative Scene Sequencer

Click **GENERATIVE** at the top of the Sequence view's Scenes column **OR** in the Transport bar (mirrors the same store flag) **OR** hit **G** from anywhere in the app. The engine stops following each scene's authored Follow Action and starts picking the next scene randomly from a configurable pool. Manual triggers (Cue/GO, scene clicks, MIDI scene triggers, Space + 1-0 keys) still preempt the flow, but under Generative they auto-roll a fresh duration from the min/max window so the FIRST scene you Play also obeys the generative timing.

When Generative is ON, an orange **● Generative ON** badge appears in the TopBar between MIDI Learn and the Grid/Sequence view toggle. Click the badge to flip Generative off without opening the popover.

The Generative popover (chevron next to the GENERATIVE pill, or G hotkey) is **draggable** by its title bar, **centered** on every open (re-centers when toggled off + on), and gets a **📌 pin** button so it stays visible while you edit other surfaces. Esc / ✕ / G still close it.

Under Generative mode, EVERY follow action is overridden including Stop and Loop -- the selector picks the next scene unconditionally after each min/max-rolled duration. To make a scene actually loop while in Generative, narrow the pool to that single scene (the no-repeat clause auto-disables for a 1-scene pool).

**Pool Source** dropdown:
- **All scenes** (default) - every scene in the session is eligible (like Spotify shuffling your whole library).
- **Timeline only** - only scenes currently placed in the timeline are eligible (shuffles just the songs you queued).

A per-scene **checklist** in the popover narrows the pool further. Excluded scenes stay completely silent under generative mode but remain playable manually.

**Selection Mode** presets (the dropdown writes a known combination of the underlying knobs - tweaking afterward auto-switches the label to **Custom** so the user can see what's been changed):
- **Random** *(default)* - weight-biased random with No-Repeat. Affinity = 0.
- **Drift** - Affinity = +80, strong pull toward similar scenes. Smooth gradual exploration.
- **Surprise** - Affinity = -80, strong pull toward dissimilar scenes. Forces variety.
- **Shuffle** - every scene plays once before any can repeat. Affinity = 0, cycle resets automatically.
- **Custom** - the underlying knobs (Affinity, No-Repeat, Shuffle Cycle) have been tweaked away from any preset's defaults.

**Affinity** slider (bipolar, -100..+100, default 0):
- `-100 = Contrast` - always pick the most-dissimilar candidate scene.
- `0 = Random` - similarity is ignored, pure weight-based pick.
- `+100 = Coherence` - always pick the most-similar candidate scene.
- Continuous in between: `|Affinity|/100` maps to an exponent in `[0, 4]` applied to each candidate's similarity (or `1 - similarity` when negative).

**Scene similarity** is computed automatically. Each pair of scenes gets a 0..1 similarity score derived from cell-by-cell, token-by-token comparison: matched silence = 1.0; one cell active and the other not = 0.0; both active = element-wise normalized numeric distance across every numeric token in the cell's value string. **Multi-arg cells are handled element-wise** - a 4-arg OCTOCOSME cell is compared token-by-token to other 4-arg cells on the same track. Non-numeric tokens (like the `compositor` protocol prefix) are skipped. The matrix is sub-millisecond to compute for typical sessions and only rebuilds on session changes.

**No immediate repeat** toggle (default ON, MIDI-learnable) - prevents back-to-back duplicates of the same scene.

**Shuffle Cycle** toggle - every scene in the pool must play once before any can repeat. Automatically resets each cycle.

**Min / Max scene duration** sliders + editable float boxes (default 5s and 600s, both MIDI CC learnable). Each time the engine auto-advances under generative mode, it rolls a fresh duration uniformly distributed in `[min, max]` and uses that instead of the scene's authored `durationSec`.

**Use Morph** toggle (default ON) - when ON, generative auto-advances apply the current TransportBar morph time so transitions glide smoothly. When OFF, scenes snap.

**Per-scene Weight** slider (1-10, default 1) lives in the Scene Inspector's Generative section. A scene with weight 10 is 10× more likely to be picked than a weight-1 scene. The **Random Weights** button in the Generative popover rolls fresh weights into every scene in one click (also MIDI-learnable - tap a pad mid-set for a one-shot reshuffle of the probability landscape).

**Repetition penalty** - recent plays get their effective weight shrunk so the engine doesn't keep returning to scenes you've just heard. The history ring buffer holds the last 24 plays.

**Reproducibility** - the selector is purely `Math.random()`-driven in v0.5.10. A future revision may add seeded RNG so a rehearsal can be replayed identically.

**MIDI Learn** - all seven generative controls (Toggle / No-Repeat / Affinity / Min duration / Max duration / Use Morph / Random Weights) are independently learnable via the same `L`-hotkey + Learned-panel flow as scene triggers and Meta knobs. Affinity / Min / Max accept CC only (continuous). The four toggles + Random Weights accept either note or CC.

### Per-track Default Transition broadcast

In the grid-side Parameter Inspector (click a track header), a new **Default Transition** field with a **Send to all clips** button. Type a ms value, click the button, every cell on that row's `transitionMs` is updated at once. Doesn't touch each cell's `timingEnabled` flag, so cells with Timing turned off keep their state - they just remember the new value for when re-enabled.

### Cell Inspector Transition tooltip

Hover the **Transition** label in the Cell Inspector's Timing section for a short explanation of what Transition does, how it relates to Scene Morph, and the `timingEnabled` bypass. Long-awaited docs for a long-existing feature.

### Generative readout on per-scene Dur + Next

Each scene's **Dur** input shows the engine's most-recently-rolled duration as an **orange overlay** when Generative is ON. Visible everywhere a scene's Dur appears — the SceneColumn header in Grid view AND the Scene Inspector in Sequence view. Focus the input to peek/edit the authored value (overlay hides while focused); blur to bring it back.

Each scene's **Next** (Follow Action) dropdown gets an orange **?** overlay when Generative is ON — because under Generative the engine picks the next scene, not the dropdown's authored value. Hover or click to peek/edit the authored Follow Action.

Engine side: tracks the last-rolled duration per scene id in a `Map<sceneId, ms>`, mirrored into `EngineState.generativeRolledBySceneId`. Pruned automatically on session reload + scene removal.

### Sequence view: Edit → Grid relabel + resizable Scene Inspector

The "Edit" button in the Sequence view's view-toggle now reads **Grid** (matching how dataFLOU regulars talk about it). The lower Scene Inspector panel below the Scenes palette is now **resizable** -- drag its top edge upward to grow the editor area. Height persists across the session.

### Hardware Mode × OSC Forward dual-emission fix

Reported during late v0.5.10 testing: when Hardware Mode is bound to an OSC controller (e.g. OCTOCOSME on 127.0.0.1:9000) AND the OSC Forward feature is fanning out to downstream consumers (Pure Data, Max, another machine), the same incoming packets were both consumed by Hardware Mode (clean catch-mode emission) AND independently relayed by the raw byte-forward path. Downstream consumers ended up receiving two competing values per packet on the same OSC address, producing visual flicker on Pd patches and a slow Max message-queue saturation that crashed the receiver after ~5 minutes of sustained dual-emission.

Fixed via a new `setOnShouldSuppressForward` gate on the OSC listener (`src/main/oscNetwork.ts`). The engine wires `isHardwareModeSource(ip, port)` to this gate at startup, so the raw forward path now skips ONLY packets whose source matches a Hardware-Mode-bound device. Packets from any other source (other controllers, computers on the LAN) still fan out as before. When no Hardware Mode is enabled session-wide, the gate is a single boolean read -- zero behaviour change for users not using HW Mode.

---

## Release notes - 0.5.9

A small follow-up to v0.5.8: one new musical feature (Modulation 2 can now modulate the Sequencer as well as Modulation 1), one persistence bug fix (Hardware Mode config), the Modulation 1 relabel, and two long-standing drop-focus regressions in the Inspector squashed.

### Modulation 2 → Sequencer

The second-stage modulator now has a parallel route into the Sequencer. The Mod 2 section in the Inspector renders two Targets blocks: the original "Mod 1 Targets" (Rate / Depth / Shape applied to Modulation 1) plus a new "Seq Targets" (Rate / Depth / Shape applied to the cell's Sequencer). Same math-mode dropdown drives both — Multiplicative / Additive / Mix is shared so the two blocks compose predictably.

Per-mode Shape mapping (the third target is mode-aware, just like the Mod 1 side):

- **Euclidean** → Rotation (0..steps-1) - which step the pattern starts on
- **Density** → Seed - tiny offsets give micro-variations, big offsets give wholly different hit patterns
- **Cellular** → Rule (0..255) - **strong** target, each rule is a totally different evolving pattern, keep amount low for musical use
- **Polyrhythm** → Ring A Length - cross-rhythm density breathes in and out
- **Drift** → Bias (-100..+100) - pull the random walker toward one end of the step range
- **Ratchet** → Probability (0..100 %) - bursts breathe in and out
- **Bounce** → Decay - long bounces taper to short bounces and back
- **Steps / Draw / Address** → no-op (no single dominant "personality" knob, the row greys out)

**Depth** universally targets the **Generative wildness slider** (`genAmount`, 0..100). This is the highest-impact musical knob in the v0.5.9 batch: swing genAmount from 0 to 100 with an LFO and the sequencer breathes between metronomic and chaotic. Pairs especially well with Cellular or Density modes, where genAmount governs how far the variations stray from the baseline pattern.

**Rate** targets `bpm` (when syncMode is `bpm` or `tempo`) AND `stepMs` (when syncMode is `free`) so the user can flip syncMode mid-session without losing the modulation. Engine clamps to legal ranges (10..500 BPM, 1..60000 ms).

Routing matrix gets a new column: the existing per-slot "Mod 2" tick is now labelled **M2>1** (Modulation 2 → Modulation 1) and a sibling **M2>S** (Modulation 2 → Sequencer) column sits next to it with a spacer between, so the two features read as distinct. Bulk ⇆ toggle, click-and-drag paint, per-slot ticks - all work the same. Cell-level semantics: if every slot's M2>S flag is explicitly false, Mod 2 → Seq is skipped cell-wide; any ticked slot enables the routing (the sequencer's state is shared per cell, so true per-slot gating isn't musically meaningful here).

Engine side: new `applyMod2ToSeq(seq, m2cfg, mod2NormBipolar)` helper after `applyMod2ToMod1`. Same skip-when-no-target fast path - cells that don't use this feature pay zero cost. Call site shallow-clones the cell with both `modulation: effMod1` and `sequencer: effSeq` so downstream code reads the modulated values uniformly.

Factory: `DEFAULT_MODULATION2.targetsSeq` ships with all three rows disabled (amounts pre-loaded at 50 % so flipping a checkbox gives an immediate audible effect).

### "Modulation" → "Modulation 1" relabel

The Cell Inspector's first modulator section was titled "Modulation" since v0.1, which read as the only modulator. With v0.5.7's introduction of Modulation 2 (and now v0.5.9's Mod 2 → Sequencer extension), the asymmetric label confused users into thinking Modulation 2 was a sub-feature. Now the section title is **"Modulation 1"** - parity with "Modulation 2" makes the two-stage chain visible at a glance.

### Hardware Mode session persistence

Reported during the v0.5.9 batch by a session that had `OCTOCOSME` bound to Hardware Mode but kept losing the binding on every reload. Root cause: the session-load sanitizer (`sanitizePool` + `sanitizeTemplate` in the store) had two layers that each dropped the `hardwareMode` blob:

1. `sanitizeTemplate` was building a fresh template object from each saved entry but never copied `hardwareMode` over. Result: saved entries arrived at the pool merge with `hardwareMode === undefined`.
2. `sanitizePool` then merged saved entries against the fresh builtin pool. When a saved id collided with a builtin (the common case - the user binds Hardware Mode to a builtin template they instantiated), the merge SKIPPED the saved entry entirely. Result: even if step 1 had carried `hardwareMode` through, step 2 would have discarded it.

Both layers patched. `sanitizeTemplate` now does a shape-validated copy of every `HardwareModeConfig` field (enabled, deviceIp, devicePort, mode, catchTolerance, movementThreshold, movementWindowMs, args, appliesToTrackIds). `sanitizePool` now grafts the saved `hardwareMode` onto fresh builtin entries when ids collide - the builtin still wins for everything else (color, functions, etc.), but the user's per-session HW Mode config rides through.

The catch-state map (per-track arg indices currently overridden by hardware) was already persisting since v0.5.7; what was missing was the binding config that says WHICH device, WHICH catch mode, etc. The combined fix means a v0.5.9 session round-trips cleanly: bind, save, close, reopen, the red instrument badge + "HW Mode On" pill come back exactly where you left them.

### Drop-focus fixes (Inspector inputs)

Two separate causes, both squashed in the same batch.

**Cause 1: live-overlay clobber in `BoundedNumberInput`.** When Modulation 2 is enabled, the engine pushes `mod1Live` over IPC at ~30 Hz so the Inspector's Rate / Depth / Shape fields can animate to show the *effective* (post-Mod 2) values. Those fields' `value` prop binds to the live float. The component's value-sync `useEffect` runs on every external `value` change, and the existing "if str already parses to value, leave alone" guard never triggered because the live value is a continuously-drifting float - every tick of the engine overwrote whatever the user was typing. Visible symptom: caret stays put but every keystroke is wiped before the next frame.

Fix: added a `dirty` ref that flips true on the first onChange after focus. The value-sync useEffect now bails when `focused && dirty` - the user's in-progress text is sacred. onFocus resets dirty=false so the live overlay continues tracking until they actually start typing; onBlur skips the commit if `!dirty` so focusing and leaving without typing doesn't accidentally clobber an externally-updated value.

**Cause 2: drop-handler blur theft in EditView / SequenceView / TrackSidebar.** The three drag-and-drop handlers explicitly call `document.activeElement.blur()` on every drop, deferred to `requestAnimationFrame`. This was added as a defensive workaround for an Electron / Chromium "sticky drag pseudo-focus" bug where the drag source (a Pool pill or button) would keep keyboard interest after the drop and swallow subsequent click → input-focus chains. The workaround did its job for the sticky-button case but fired unconditionally - so when the user was typing in an Inspector input and dropped a saved scene onto the grid, the defensive blur yanked focus out of the Inspector field.

Fix: all three call sites now bail out when `document.activeElement` is an `INPUT`, `TEXTAREA`, or `contentEditable` element. The original Chromium workaround still fires for buttons / pills / divs that hold focus (the case it was designed for), but the user's typing is no longer collateral damage.

### New button save-before-discard modal

The TopBar's New button has been wired through App.tsx's `newSessionConfirmOpen` flag since v0.5.0, with a 3-button modal (Yes saves + opens fresh, No discards + opens fresh, Cancel keeps current). Confirmed in this batch that the wiring is intact - reported as missing during v0.5.8 testing, but the code at HEAD was correct; the user was likely running a stale binary. No change shipped here; documented for confidence.

---

## Release notes - 0.5.8

A modulator-focused follow-up to v0.5.7. Headlines: a **Gesture modulator** (10th modulator type - XY recorder with a live crayon while you draw, animated playhead dot during playback, **Wiggle** knob, three **Play modes**); the **Address sequencer's Stage-2 sub-mode** is now wired (Modulation 2 drives the playhead while Modulation 1 modulates the step value); every modulator type is now usable as Modulation 2 (**Random / Ramp / Arpeggiator** added alongside the v0.5.7 set); engine + Inspector audit pass with five real bug fixes and four notable perf wins (binary-searched gesture sampling, cached merged-mode sqrt, ref-backed pointermove array kills the O(N²) drawing cost, Mod-2-gated `useStore` selectors stop the editors re-rendering at 30 Hz when Mod 2 is off).

### Gesture modulator

A new modulator type that records an X/Y stream from a square surface in the Inspector and loops it as a continuous modulation source. Capture model: every pointermove during a drag becomes a `GesturePoint` with a relative ms timestamp and (x, y) in [0, 1]². The recorder shows the **in-progress polyline live as you draw**, plus a **crayon-style dot** at the current pointer position (filled accent circle with a subtle pulse ring) - same "ink flowing onto the canvas" feel as the Draw sequencer.

Once recorded, playback:

- **Rate** sweeps the playhead through the captured curve at the modulator's standard `rateHz` / sync controls - same dropdown as every other modulator (Free Hz or BPM-synced with dotted / triplet).
- **Wiggle** (0..100 %) overlays a sinusoidal back-and-forth jitter on the playhead, scaling up to a roughly half-loop swing at 100 %. This is the **third "Shape" target Modulation 2 can sweep** when Mod 1 = Gesture (label flips to "Gesture · Wiggle" in the Mod 2 Targets row).
- **Play mode** picks the playhead direction: **Forward** (default - 0 → 1 each loop), **Backward** (1 → 0), or **Ping-Pong** (0 → 1 → 0 each loop, triangle wave). Ping-Pong covers twice as much ground at the same Rate, so halve the Rate if you want forward-and-back to feel as slow as a single forward pass.
- **Output** picks the slot fan-out: **XY** (slot 0 ← X, slot 1 ← Y; slots ≥ 2 read X for musical coherence rather than going silent) or **Merged** (√(x² + y²) / √2 broadcast to every slot - the unit square maps cleanly to [0, 1]).

Animated playhead dot - the engine streams the gesture's current (x, y) at ~30 Hz via the existing `engine:mod1Live` IPC channel. The Inspector's GestureRecorder canvas overlays an accent-coloured dot at that position so you can watch the curve being traced in real time (independent of whether Modulation 2 is on - the dot animates whenever the cell is armed).

Engine side:

- `Modulation.gesture: GestureParams = { points, mode, wiggle, playMode }` on the cell.
- `TrackState.gestureX/Y` updated per tick.
- `sampleGesture(points, playhead01)` - binary search through the time-ordered points, linear interpolation between adjacent samples; returns `(0.5, 0.5)` for empty / single-point recordings.
- `gestureChannelFor(ts, slotIdx, mode, gestureMode)` - multi-arg fan-out, with a per-tick cache on the merged-mode sqrt so multi-arg cells don't recompute the radial value per slot.
- Phase-driven loop (reuses `ts.phase`) so Modulation 2 → Rate works out of the box.

### Stage-2 Address sub-mode

Address mode's third sub-mode is now functional: **Modulation 2 drives the playhead address** while Modulation 1 modulates the resulting step's value. Replaces the v0.5.7 placeholder ("requires Two-stage Mod, v0.5.8") in the dropdown. Falls back gracefully to Modulation 1 driving the playhead when Modulation 2 is disabled on the cell - so the dropdown is never a silent no-op.

Engine side: hoisted `mod2NormBipolar` out of the Mod 2 enabled block in the per-tick loop so the Address branch can read it later in the same iteration; new `useMod2ForAddress` flag picks the source.

### Random / Ramp / Arpeggiator now usable as Modulation 2

The v0.5.7 release shipped Mod 2 with only the continuous-signal types (LFO / S&H / Slew / Chaos / Strange Attractor / Envelope) - the other three were marked `(n/a)` in the dropdown. They're now all wired:

- **Random**: clock-driven fresh sample at the modulator's effective rate. New `Mod2State.randCurrent` + `randLastAdvanceAt`. Honours the user's distribution warp. Mod 2 collapses Random's multi-channel output to a single bipolar value per advance.
- **Ramp**: one-shot evolve-then-hold: `2 * computeRampGain - 1` swings the playhead from -1 → +1 (or +1 → -1 inverted) over the configured length, then settles at the endpoint. Loop mode gives Mod 2 a slow saw-tooth.
- **Arpeggiator**: clock-driven step advance via the reused `advanceArpStep` helper (signature loosened from `TrackState` to structural `{ arpStepIdx, arpPatternIdx }`). Emits the current step's normalised position as bipolar `(k / (N-1)) * 2 - 1`, so an "up" pattern sweeps -1 → +1 across the ladder, "down" sweeps the reverse, "upDown" makes a triangle. New `Mod2State.arpStepIdx / arpPatternIdx / arpLastAdvanceAt`.

`arpStartStep` accepts an optional seeded RNG so Mod 2's reproducibility holds for `random`-mode arp reseeds (uses `m2.rng` instead of `Math.random`).

### Live overlay gated on Modulation 2 enabled

When the live-emit stream became always-on (so the Gesture playhead can animate without Modulation 2), every Mod 1 control started showing the orange `.live-overlay` tint constantly - `live?.X !== undefined` was always true once a stream existed. Now each editor's `useStore((s) => isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live)` returns a stable `null` whenever the overlay should be off, which has two effects:

1. The orange tint only appears when Modulation 2 is actually driving (the old, clearer visual feedback).
2. Zustand's default reference-equality skips re-rendering those editors at the engine's 30 Hz live-emit cadence - the Inspector drops from ~30 Hz wasteful re-renders to 0 Hz when Mod 2 is off.

GestureEditor is the exception: it keeps a second always-on subscription (gated only on `isMod2`) feeding the playhead dot, with the Mod-2 gate applied locally to the Wiggle overlay only.

### Engine + Inspector audit pass

Five real bugs found and fixed in a dedicated audit pass:

- **Wiggle multiplicative no-op at base=0**: Gesture's factory default is `wiggle: 0`, so `0 * (1 + mod2 * amt)` = 0 silently in multiplicative mode. Now falls through to additive when `baseWiggle === 0` so Mod 2 → Shape on a fresh cell has a visible effect.
- **`endRecord` stale closure**: `drawing` was read from React state, which might not have flushed the last pointermove. Switched to a `drawingRef` ref-backed array - `endRecord` always sees the freshest data.
- **Live emit firing while cell stopping / Mod 1 disabled**: guard added (`!ts.stopping && cell.modulation.enabled`). Playhead dot stops freezing mid-fade-out. The renderer's `mod1Live` slot is also cleared on selection change so a previous cell's stale snapshot doesn't bleed into the new cell's Inspector for ~33 ms.
- **`arpStartStep('random')` used `Math.random`**: broke Mod 2's reproducibility promise (same cell value should produce the same trajectory). Now accepts an optional `rng` param; Mod 2 trigger reseed passes `rngM2`.
- **`applyMod2ToMod1` Gesture branch missing `playMode`** in the fallback object literal - fixed to track `DEFAULT_GESTURE`.

Perf wins:

- **GestureRecorder pointermove O(N²) allocation**: `setDrawing(prev => [...prev, p])` allocated a fresh N-element array per move. A 20s recording at 60 Hz = ~720K element copies. Replaced with `drawingRef.current.push(p)` (in-place, O(1)) + a counter state for renders. Long recordings stay flat now.
- **`sampleGesture` linear scan → binary search**: was O(N) per tick. At 120 Hz × 500-point recordings, drops from ~60K cmp/sec to ~240. Comment notes the array's monotonic ordering invariant.
- **`gestureChannelFor` merged-mode sqrt cache**: was per-slot per-tick. Now cached on `ts.gestureMergedCache` with a tick-stamp invalidation, so an 8-slot merged-mode cell does one sqrt per tick instead of eight.
- **Inspector `livePlayhead` allocation**: wrapped with `useMemo` so the `<GestureRecorder>` child sees a stable object reference across renders.
- **`mod1Live` subscriber gating**: pushed the Mod-2-enabled gate into each editor's `useStore` selector (see above). 30 Hz → 0 Hz re-renders when Mod 2 is off.

---

## Release notes - 0.5.7

The biggest single release since v0.5. Headlines: a **Two-stage modulator** (every clip's Modulation 1 can now be modulated by a SECOND modulator, with **live overlay** of the effective values on the Inspector controls so you SEE the modulation breathe in real time); a new **Strange Attractor** modulator drawing from 6 chaotic ODEs (Lorenz / Aizawa / Thomas / Rössler / Rössler-4D / Lü-4D) with multi-channel slot fan-out; a per-cell **Routing matrix** (Mod / Mod 2 / Seq × N slots, plus Delay + Variation columns); a CV-addressed **Address** sequencer mode; editable **pinned values** that broadcast to clips; **Distribution** knob on Random + S&H; **Scaling PRE/POST** switch; **Hardware Mode session persistence**; **Ctrl+C/V** clipboard; right-click menus for Parameters + Saved Scenes; and a long tail of UX polish.

### Two-stage modulator - Modulation 2

Every cell gets an optional second-stage modulator that modulates Modulation 1's three most expressive knobs: **Rate, Depth, and a context-aware "Shape" parameter** whose meaning depends on Modulation 1's current type. Modulation 1's stored values are NEVER mutated - each tick the engine builds an "effective Modulation 1" by applying Mod 2's bipolar [-1, +1] signal to a fresh copy.

- **Same Type picker as Modulation 1**: LFO, S&H, Slew, Chaos, Strange Attractor, Envelope all work as a second-stage signal. Random / Ramp / Arpeggiator are disabled in the picker (note/time-targeted, not continuous).
- **Targets sub-block** in the Modulation 2 section - math-mode dropdown (**Multiplicative** / **Additive** / **Mix**) + three enable checkboxes + per-target amount knobs. Each target can be on/off independently.
- **Context-aware Shape label**: the third target row's label live-updates with Mod 1's type:
  - LFO → **Shape** (sweeps the shape index across sine → triangle → square → sawtooth → rndStep → rndSmooth → spastic)
  - S&H → **Distribution** (centre-hug ↔ uniform ↔ edge-weight warp)
  - Strange Attractor → **Chaos** (the attractor's bifurcation knob)
  - Chaos → **r** (logistic-map stability, 3.4..4.0)
  - Random → **Distribution**
  - Slew → **Slew Time** (stretches Rise + Fall together)
  - Envelope → **Sustain** (sustain level 0..1)
  - Ramp → **Curve** (-100 ↔ +100 ease-in/out)
  - Arpeggiator → **Mode** (cycles through `up → down → upDown → downUp → exclusion → walk → drunk → random`)
- **Rate target is type-aware**: for LFO/S&H/Slew/Chaos/Random/Arp it patches `rateHz`; for **Strange Attractor** it patches `attractor.speed`; for **Ramp** it patches `ramp.rampMs` + `ramp.totalMs` (inverted: higher Rate signal = shorter ramp time, so "faster" reads consistently across types).
- **Per-slot Mod 2 routing column** in the Routing matrix (see Routing section below) - untick a slot to bypass Modulation 2's effect on that arg.

Engine side: a parallel `Mod2State` slot on every TrackState holds Mod 2's modulator-state fields (phase, S&H held, Slew value, Chaos x, Attractor X/Y/Z/W, etc.) + its own seeded PRNG so Mod 2's RNG doesn't shift Mod 1's reproducibility. Trigger-time reseed mirrors Mod 1's. `applyMod2ToMod1` produces the effective Mod 1 with sane clamps per type (rate ∈ [0.01, 20] Hz, speed ∈ [0.05, 10], depth ∈ [0, 100], chaos.r ∈ [3.4, 4.0], distribution ∈ [0, 1], rampMs ∈ [0.1, 300000], etc.). The Shape branches all spread from `out.X ?? m1.X` so Rate + Shape targets compose correctly (Speed + Chaos both animate at once when both are enabled).

### Live modulation feedback in the Inspector

The engine streams the effective Modulation 1 values for the currently-watched cell to the renderer at ~30 Hz via a new `engine:mod1Live` IPC channel. Inspector controls overlay the live values on top of the stored authoring values: slider thumbs track the engine's actual effective Hz / depth / shape, number readouts show 1-decimal live values + a "Live: X · Base: Y" tooltip, the affected control gets an accent-tinted outline (`.live-overlay` CSS class). **Editing still writes the base**: drag a slider or type into a number, Mod 2 then breathes around the new authored value.

Covered: LFO (Rate/Depth/Shape), Sample & Hold (Rate/Depth/Distribution), Slew (Rate/Depth/Rise/Fall), Chaos (Rate/Depth/r), Strange Attractor (Speed/Depth/Chaos), Envelope (Sustain/Depth), Ramp (Ramp time/Curve/Depth), Arpeggiator (Rate/Depth/Mode), Random (Rate/Depth/Distribution). Rate + Depth flow through the shared `CompactRateControls` + `CompactDepthMode` helpers so adding a new modulator type automatically inherits the overlay.

`Mod1LiveSample` (in `src/shared/types.ts`) is a small typed envelope with just the params Mod 2 can target; renderer stores it in a Zustand slice and the Inspector's `CellInspector` notifies the engine which (sceneId, trackId) to watch on mount + when Mod 2's enabled flag changes.

### Strange Attractor modulator

Ninth modulator type. Per-tick Euler integration of one of six chaotic ODE systems, with adaptive sub-steps so high Speed × high Chaos stays stable:

- **Lorenz** (sigma=10, rho=28+chaos×12, beta=8/3) - the canonical butterfly
- **Aizawa**: slow, organic, with a per-tick SAFE_MAX=200 clamp on `(x³)` term to avoid NaN propagation
- **Thomas**: sin-driven cyclically symmetric attractor, slow + dreamy
- **Rössler**: 3-D ribbon attractor, classic
- **Rössler 4-D**: hyperchaotic 4-D, faster integration step `h=0.003` with `skip=400` `N=2000` in the visualizer
- **Lü 4-D**: hyperchaotic 4-D with sub-attractor structure

Three knobs: **Type** (dropdown), **Speed** (0.05..10×), **Chaos** (the canonical bifurcation knob for each system). Per-tick: raw integration in native units, then per-axis normalize to [0, 1] with per-type scales (Aizawa z up to 2, Rössler-4D w up to 50, Lü-4D w up to 150, etc.) and finite-check guards returning 0.5 on non-finite input. Multi-arg cells fan out by slot index:

- 3-D types: slot 0 = X, slot 1 = Y, slot 2 = Z, slot 3 = EMA-smoothed |velocity| (the "speed breath")
- 4-D types: slot 0 = X, slot 1 = Y, slot 2 = Z, slot 3 = W (native 4th channel)

`AttractorVisual` renders a 2-D projection of the trajectory live in the Inspector; falls back to "attractor diverged - try lower chaos" if the system explodes.

### Routing matrix per-cell

New collapsible section at the bottom of the Cell Inspector. Per-slot toggle grid plus two number-input columns:

```
slot name | Mod | Mod 2 | Seq | Delay | Var
```

- **Mod**: Modulation 1's per-slot gate. Untick → that slot emits its `cell.value` seed instead of the modulated value.
- **Mod 2** (v0.5.7) - Modulation 2's per-slot gate. Untick → that slot reads the ORIGINAL Modulation 1 params (Depth + Shape revert; Rate is shared globally and can't be "unmodulated" per-slot because the engine keeps a single phase). Greyed out when Mod 2 is disabled on the cell.
- **Seq**: Sequencer's per-slot gate.
- **Delay (ms)**: stagger a slot's modulator + sequencer onset after each trigger. Lets multi-arg cells "ripple" their modulation across the bundle (slot 0 starts immediately, slot 1 at +100 ms, slot 2 at +200 ms…).
- **Var (%)**: float 0..100 (2 decimals, e.g. 65.50 %). Per-trigger random ±scaling of the modulator output for that slot, sampled once at trigger from the cell-seeded PRNG so the personality is reproducible. Includes a tiny PD-vradio-style 16-px rotary knob next to the number input (drag vertically, Shift = fine, double-click = 0).

Click + drag across ticks to paint several at once. Bulk ⇆ buttons at the top of each tick column toggle the whole column. Section header has a chevron-style collapse toggle (`CollapsibleViewSection`); body defaults to expanded.

Beaten by `argSpec.fixed` (always emits the declared value) and per-slot Pin (frozen at captured value, routing ignored).

Engine side: when any slot has `routing.modulation2[idx] === false` AND Modulation 2 is enabled, the engine runs `computeModNorm` a SECOND time against the ORIGINAL Mod 1 (`mod1OriginalForSlots`) and the per-slot emit loop picks `modNormForSlot` and `depthSlot` (effective vs original) per the routing tick. Same logic applies to the Arpeggiator branch.

### Address sequencer mode

Tenth sequencer mode (renamed from "Adresse" mid-development per French → English consistency; old session JSONs migrate at load).

The Modulator's output is interpreted as a **CV playhead address** into the row of step values:

```
stepIdx = floor(modUnipolar01 * stepsA)
```

Three sub-modes:

- **Hijack** (default) - the Modulator is CONSUMED entirely as the playhead position; the addressed step value emits as-is, no additional modulation on top.
- **Parallel**: the addressed step value AND the modulator both contribute (modulator on top of the addressed step).
- **Stage-2**: reserved for v0.5.8 (will let Modulation 2 do the addressing while Modulation 1 modulates).

Pairs well with LFO (smooth sweep through steps) and S&H (jumpy random reach into the step row). Ramp + Arpeggiator are weird matches because they don't sweep continuously by nature (documented in the mode-picker tooltip).

### Live preview infrastructure

- New shared type `Mod1LiveSample` - typed envelope of the live effective-Mod-1 values (rateHz, depthPct + per-type shape field).
- New IPC channel `engine:mod1Live` (main → renderer) - emits a sample every ~33 ms while a cell is being watched.
- New IPC handler `engine:setSelectedCellForLive` (renderer → main) - Inspector tells the engine which (sceneId, trackId) to stream for. `null` to stop.
- Renderer Zustand slice `mod1Live` + `setMod1Live` action; subscriber wired in `App.tsx`. `CellInspector` updates the engine selection on mount + when `modulation2.enabled` flips, clears on unmount.
- Engine: ~30 Hz throttle (`lastMod1LiveEmitAt`); only emits when the watched cell matches AND Mod 2 is enabled on the cell - zero overhead when the user isn't watching.

### Editable pinned values + Send to clips broadcast

The Parameter Inspector's pinned-slot list (`PersistentSlotList`) used to display pinned values as static text. Now each pinned row swaps in an inline `UncontrolledTextInput` so the captured value can be edited in place. The engine reads `track.persistentValues[i]` every emit, so changes take effect immediately.

The **"Send to clips"** button on the Parameter Inspector now ALSO rewrites every clip's `value` string at the pinned positions (using the track's argSpec to pad short value strings to full length). Cells with an explicit per-cell `persistentSlots[i] === false` override are left alone. Auto-created clips on previously-empty scenes get the pinned tokens stamped in too. Confirm dialog adds a "Pinned values (N) will also be written to each clip's value tokens." note when pins exist.

Store: new action `setTrackPersistentValue(id, slotIdx, value)` guards against editing slots that aren't currently pinned (typo can't accidentally pin a fresh slot).

### Distribution knob - Random + Sample & Hold

New continuous knob on both Random Generator and S&H modulators, in the same place across both editors. 0..1 unit warp:

- **0 %**: edge-weighted (samples cluster at the rails)
- **50 %**: uniform (passthrough)
- **100 %**: centre-hugging

Inspired by Buchla 266 "Stored Random Voltages". Applied at every fresh draw - both at trigger-time seeding AND every per-tick sample. Engine: `warpDistribution(u01, dist)` helper, called from both `sampleRandom` (Random) and the S&H clock-tick block. Modulation 2's Shape target on either type sweeps the Distribution knob.

### Scaling PRE/POST switch

The per-arg Scaling section (clamps each arg's output to a user-chosen `[min, max]` band) was POST-only (clamp after modulators + sequencer, before Scale 0.0–1.0 and MIDI Scale). Now configurable via a PRE/POST select in the Scaling section header:

- **POST** (default) - legacy behavior. Clamps the final output. Tames extreme values from generative sources.
- **PRE**: clamps the seed value BEFORE modulators + sequencer pick it up. The whole downstream modulation operates inside the band, which can produce more musical results when you want the modulator to "live inside" a tight range rather than getting clipped at the boundaries.

Default is POST so old sessions behave identically.

The Scaling section's description text is now in the section title's hover tooltip rather than a visible paragraph, freeing vertical space in the Inspector.

### Hardware Mode session persistence

The `hardwareCaught` map (per-track arg indices currently overridden by hardware) is now saved with the session under `session.hardwareState.caughtByTrack` and restored on load. Previously a power-cycle wiped which slots were bound; now you can save a performance, reopen, and Hardware Mode is exactly where you left it. Engine reads + writes on session load via `updateSession`; cleanup on track removal preserves the catch state for surviving tracks.

### Ctrl+C / Ctrl+V - internal clipboard

App-wide keyboard handler (in `App.tsx`) for Ctrl+C (or Cmd+C) / Ctrl+V on:

- **Cells** in the grid (single or multi-selection)
- **Parameter** rows in the sidebar
- **Instrument** templates in the sidebar

Internal clipboard (lives in the Zustand store, NOT the system clipboard) so the copied content keeps its full session shape (modulation, sequencer, routing, etc.) without serializing through the OS clipboard's text format. Suppressed when focus is inside an editable target (input, textarea, contenteditable) so the OS-level Ctrl+C still works for text. Paste creates new IDs so each paste is a fresh instance.

Store actions: `copyToClipboard()`, `pasteFromClipboard()`, plus `clipboard` state.

### Parameter row right-click menu

Right-clicking a row in the Track sidebar now branches the context menu based on whether the row is a Parameter (child of an Instrument template) or the Instrument template itself:

- **Parameter rows**: Duplicate Parameter / Delete Parameter
- **Instrument (template) rows**: Duplicate Instrument / Delete Instrument plus existing items (Save as Template / Show Pool / etc.)

Store actions: `duplicateFunctionTrack(id)`, `duplicateInstrumentTrack(id)`.

### Saved Scene right-click menu

The Pool · Scenes tab's Saved Scene rows now get a context menu (right-click):

- **Rename**: inline `<input>` swap on the row label
- **Update from Grid**: rebuilds the Saved Scene's contents from the currently-linked scene in the grid (so you can dial in a scene, then sync it back to the library entry in one click). Uses `linkedSavedSceneId` (legacy scenes get back-filled by name match on session load).

Saving a scene with a name conflict auto-suffixes `_N` (incrementing) so the library stays unique without surprise overwrites.

### Two-stage helpers in the engine

New helpers (bottom of `src/main/engine.ts`):

- `advanceMod2State(m, m2, dt, t, bpm, tickIdx)` - per-tick state advance for Mod 2 (LFO / S&H / Slew / Chaos / Strange Attractor; Envelope handled in eval directly).
- `evalMod2Bipolar(m, m2, triggerTimeMs, nowMs, bpm, tickIdx, sceneDurSec)` - returns bipolar [-1, +1] regardless of Mod 2's own `mode` (forces symmetric swing - Mod 2 isn't an OSC output, it's a modulator of a modulator, so unipolar doesn't make sense).
- `applyMod2ToMod1(m1, m2cfg, mod2NormBipolar)` - builds an effective Mod 1 with per-target patches. Fast-path early-return when no target has `enabled: true`.

The `lfo()` function's signature was relaxed from `state: TrackState` to a structural `{ rndStepValue, rndSmoothPrev, rndSmoothNext }` so both `ts` (Mod 1) and `ts.m2` (Mod 2) can be passed.

### Smaller fixes + polish

- **Inspector resize handle CSS regression**: `.resize-h:not(.absolute):not(.fixed):not(.sticky)` to scope position-relative override (Tailwind utility order had made my rule win unintentionally).
- **Aizawa NaN propagation**: per-sub-step `SAFE_MAX = 200` clamp on x/y/z/w + finite-check guards; widened Aizawa z-range from 1.5 → 2 to match canonical orbit.
- **Rössler-4D / Lü-4D visuals**: slower integration (`h=0.003`, `skip=400`, `N=2000`) so the hyperchaotic systems actually render visible structure; empty-pts fallback "attractor diverged - try lower chaos".
- **Random modulator pin awareness**: Random's dedicated emit path now respects per-slot pins + `argSpec.fixed` (was bypassing them).
- **Modulation 2 Rate target on Strange Attractor**: earlier audit pass found Rate target was patching `rateHz` only (silent no-op for attractor). Fixed: patches `attractor.speed` too when Mod 1 type is attractor.
- **`applyMod2ToMod1` Rate/Shape composition**: Shape branch's nested spreads now read from `out.X ?? m1.X` so the Rate branch's earlier patches survive (Speed + Chaos compose correctly).
- **Float Variation**: Routing matrix Variation column accepts 2-decimal floats (e.g. 65.50 %); knob + input both use the same float math.
- **Targets dropdown sized to content**: `width: fit-content` instead of fixed 110 px so "Multiplicative" reads cleanly on macOS' wider system font.
- **Mod 2 Targets row**: narrow 56-px number inputs sized to fit "100.00", knob + checkbox sit adjacent, dropdown auto-widths.

---

## Release notes - 0.5.6

A small follow-up to v0.5.5 with two new authoring tools and one MIDI-input bug fix.

### Int Scale (per-cell, per-arg)

New checkbox next to **Scale 0.0–1.0** and **MIDI Scale** in the Cell Inspector. When ticked, every numeric arg's final value is rounded to integer **AFTER** `Scale 0.0–1.0` (which clamps to `[0,1]`) but **BEFORE** `MIDI Scale` (which multiplies by 127). Per-cell toggle; applied to each arg independently.

- With **Scale 0.0–1.0 ON** + **Int Scale ON** → binary `0` / `1` OSC output (useful with the new Spastic LFO below).
- With **Scale 0.0–1.0 OFF** + **Int Scale ON** → rounds the raw modulated value to its nearest integer (e.g. a `0..127` Random modulator emits discrete int steps).
- With **Int Scale + MIDI Scale ON** → integer OSC value AND MIDI byte (after the `× 127` map).

Engine: applied in the per-slot emit loop with `out = Math.round(out)` right after the `scaleToUnit` clamp, before pitch-snap / HW override / pin. Live - takes effect mid-play.

### Spastic LFO shape

New LFO shape added to the **Shape** dropdown in the LFO modulator inspector, between **Random Smoothed** and the future shapes. It's `rndStep` quantised to exactly `{-1, +1}` on every wrap - never a value in between.

- Under **Unipolar mode** + **depth 100 %** + **base 0**, output is binary `0` / `1`.
- Step rate is set by the LFO **Rate** slider (Hz or BPM-synced).
- "Different step lengths" emerge organically: back-to-back identical samples (50 % probability each step) extend the run, so a sequence like `0 1 1 0 0 0 1 0 1 1 …` plays as runs of 1, 2, 3, 1, 1, 2 steps - naturally polyrhythmic.
- Engine: same held-value pattern as `rndStep` (uses `ts.rndStepValue`); the resample block at every LFO phase wrap chooses `−1` or `+1` randomly when `cell.modulation.shape === 'spastic'`.
- ModulatorVisuals: the SVG preview renders the binary stair pattern on the rails so the user can see the chosen sequence at-a-glance before playing.

**Tip:** pair Spastic LFO + Int Scale + Scale 0.0–1.0 to get a hard `0` / `1` gate at the LFO's rate - handy for triggering kicks / accents / button-style hardware destinations.

### MIDI Learn fix

`setMidiLearnMode(on)` was unconditionally clearing `midiLearnTarget` on every flip, regardless of `on=true` or `on=false`. This wiped the Learned-panel Edit flow's pre-set target (`setMidiLearnTarget(b.editTarget); setMidiLearnMode(true)` → target instantly null → no MIDI message ever bound). Now:

- `on === true` → only sets `midiLearnMode: true`, leaves target as-is.
- `on === false` → clears both (cancellation semantics intact).

After a successful bind, `midi.ts` itself still clears the target while leaving mode on (Ableton-style "keep mapping the next control" behaviour) - unchanged.

### Misc

- Diagnostic `[MIDI]` logging stripped from `midi.ts` (was added during the v0.5.5 → v0.5.6 testing window).

---

## Release notes - 0.5.5

A **performance + hardware integration** release. Forty-plus distinct fixes across engine, IPC, layout, MIDI, drag-and-drop, and sequencer. Headlines: **Hardware Mode** (drive any cell's args from a physical OSC controller with catch-mode soft-takeover), **per-sequence-slot overrides** (per-placement duration + follow-action), **velocity Humanize** that visibly rolls at the modulator's note rate, **Learned MIDI panel** with inline binding editor, and a measurable perf pass that removed the per-cell `Object.keys` hot path.

### Hardware Mode

Drive any compositor cell's arg slots from a physical OSC controller (Trill bar, Lemur, custom firmware sending UDP), with soft-takeover that prevents value jumps when the knob position doesn't match the currently-emitted scene value.

Per-Instrument-template config (lives at `template.hardwareMode`, edited from either the Pool's Template Inspector OR the grid's Instrument Inspector - same store action, same blob):

- **Enable** checkbox with a red "ON" badge when active.
- **Device** dropdown - pulls live from the Pool's Network discovery list (whatever's broadcasting OSC at the compositor's listen port). Bind by `ip:port`.
- **Mode**: `Reset on scene change` (default; the user has to re-catch the value of the new scene before HW takes over again) OR `Persist across scene changes` (HW keeps controlling the matching slot even after a scene flip).
- **Catch tolerance %**: how close the hardware value has to be to the currently-emitted scene value before takeover engages. Default ~5 %.
- **Movement Δ %**: minimum change between OSC packets to be considered "moving". Kills the continuous-static streams that a non-moving knob emits.
- **Apply to**: shown when the template has >1 Track instance; checkboxes scope which instances HW controls.
- **Per-Parameter arg locks**: for every multi-arg Parameter on the template, a checkbox row narrows HW control to specific slots (e.g. "HW controls slot 2 only, leave slots 0/1/3 to the scene").

Engine flow (in `src/main/oscNetwork.ts` + `src/main/engine.ts`):

1. `oscNetwork.setOnMessage(...)` hook fires for every incoming OSC packet at the listen port - registered once at app start, fast-paths out instantly when no template has HW Mode enabled (`engine.hasAnyHardwareModeEnabled` cached on every session update).
2. When HW is enabled, the hook routes to `engine.handleHardwareInput(ip, port, address, numericArgs)`. Per-device-per-address movement detection caches the last value + last-change wall-clock, so a controller streaming the same value 200 Hz doesn't trigger catches on "movement" that isn't real.
3. For each matched template's matching Track instance + matching arg slot lock, the engine compares the hardware value to the slot's current `lastSentNumeric` (the engine's most-recent computed value). If they're within `catchTolerance × range`, the slot transitions from "uncaught" → "caught" and the override engages.
4. While caught, every subsequent hardware OSC packet refreshes `hardwareOverride[trackId|slot]`. The per-slot emit loop reads this between pitch-snap and the pin, so HW always wins (except over `argSpec.fixed` protocol prefixes + over user pins, which are still the explicit final say).
5. Scene change fires `clearHardwareCatchIfReset()` - only clears catches when AT LEAST ONE active HW template is in `reset` mode. Persist-mode catches survive scene flips.
6. **Note-edge int-to-float coercion**: when a slot is HW-caught AND its argSpec type is `'i'`, the engine sends as `'f'` instead so the knob's continuous 0..1 value isn't quantized to 0 or 1 on the wire.

Visual feedback (renderer):

- **Caught arg values render red** in the live cell of the currently-playing scene only (inactive scenes stay clean - earlier behavior was confusing because the same template's cells across all scenes lit up red).
- **Red pulsing dot** next to any Track sidebar entry whose template has at least one caught slot.
- **"HW Mode On" badge** in red under the Instrument template label.
- Engine pre-buckets the catch state into `Record<trackId, sortedSlot[]>` on emit so each CellTile only does an O(1) lookup by trackId instead of scanning every key for a prefix match - measurable hot-path win when many cells are on screen.

### Per-sequence-slot overrides

The same scene placed twice in the sequence now behaves as two independent placements. Click any slot in the Scene Steps grid → an accent-bordered **Slot N override** panel appears at the top of the right Scene Inspector with:

- **Duration override (sec)**: independent of the scene's default duration.
- **Follow action override**: Stop / Loop / Next / Previous / First / Last / Any / Other, independent of the scene's default.

Each override is per-slot, not per-scene, so `[Scene1@5s+next, Scene2, Scene1@10s+stop]` plays Scene1 for 5 s → Scene2 → Scene1 for 10 s → stop. The engine tracks `activeSequenceSlotIdx` and uses it in `armSceneAdvance` for duration AND in `advanceScene` for follow-action, both per-slot.

A small accent dot on each slot's grid cell marks placements that have overrides. The Timeline view sizes each segment proportionally to its **effective** duration (override if set, else scene default).

**Bug fixes related to this:**

- `advanceScene` used `seq.findIndex(id => id === current.id)` to determine where to advance from - always returned the FIRST occurrence of a scene, breaking every follow-action when the same scene appeared in multiple slots. Now uses the live `activeSequenceSlotIdx`.
- Loop follow-action used to re-trigger via `triggerScene(id)` without `sourceSlotIdx`, which nulled the slot index and caused the slot's progress bar to vanish on every loop iteration. Now preserves the active slot.
- Multiplicator re-trigger path got the same fix.

### Velocity Humanize

0–100 % jitter slider next to the Velocity field in the Cell Inspector (MIDI output section). Engine math:

```
span = (humanize / 100) × 127
jitter = (Math.random() − 0.5) × span
velocity = clamp(0, 127, round(velocity + jitter))
```

Rolls fresh on every noteOn - which now happens at the modulator's note-edge rate, not just on sequencer steps. The engine's note-edge detector was previously only triggered by `isNoteEdge` (first-tick / step-change / ratchet-sub-pulse), so modulator-only Note cells fired one noteOn and held forever. Now `noteNumberChanged = ts.midiHeldNote !== noteNum` also triggers a noteOff + new noteOn, which is exactly the cadence the user hears.

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

- **Edit**: toggles MIDI Learn mode ON and arms this binding as the target (wiggle a controller to re-learn) AND swaps the binding display for an inline editor (kind dropdown + number input + channel input). Click Edit again to exit.
- **✕**: clears just the MIDI link (the trigger / knob stays).

Resizable via a 4 px handle on the left edge (clamped against viewport width so dragging can't push the panel under the Pool). Width persists across drawer toggles via `localStorage[dataflou:monitor:learnedColPx:v1]`. Default 180 px.

Global **L key** toggles MIDI Learn mode (works anywhere outside text inputs).

### Drag-overlay snap-to-cursor

Scene drag in the Sequence palette used to "jump left" relative to the cursor at the moment of grab - dnd-kit's default `draggingNodeRect` chases the overlay's own position as it moves, so the math drifted further from the pointer the longer the user dragged.

Fix: window-level `pointermove` listener writes `{x, y}` into a `dragCursorRef`. Custom `cursorTrackOverlay` modifier reads the ref on every dnd-kit call and returns a transform that places the overlay's center exactly at the pointer, using `activeNodeRect` (stable source rect) instead of `draggingNodeRect`. Primed at drag start from `activatorEvent` so the first frame is already snapped.

### Pool color sync (legacy scenes too)

Editing a scene's color / name / notes / duration / follow-action / multiplicator / morph-in in the Edit view now mirrors to the linked Pool SavedScene immediately. Newly-saved scenes get the link automatically (`linkedSavedSceneId` on the Scene + `linkedSavedSceneId` on instantiation from the Pool). **Legacy scenes** saved before this feature existed get a **name-match backfill** on first edit: if exactly one SavedScene matches the scene's prior name, the link is written and the mirror engages.

### Drag highlight only on the hovered slot

Earlier, dnd-kit's default `rectIntersection` collision detection lit up every droppable whose rect intersected the drag overlay - when the overlay was wider than a slot (long scene names), multiple slots in different rows could light orange simultaneously, and the LEFTMOST one usually won "over". Replaced with `pointerWithin` (matches only droppables the pointer is actually inside), falling back to `closestCenter` when the pointer is in a gap between cells.

Active / selected rings on SlotCells are also suppressed during any drag so the drop hover is the only highlight visible.

### Collapse Instruments - narrower scene columns + per-track row growth

When **Collapse Instruments** is toggled, each Scene column's value side now uses a 4-column compact value grid with `max-w-[180px]` + `overflow-hidden` so multi-arg cells wrap to multiple rows instead of stretching the column horizontally.

**Per-track row height** in compact mode - computed from `track.argSpec` (non-fixed slot count): 1–4 args → 32 px (default), 5–8 → 34 px, 9–12 → 48 px, 13–16 → 62 px. Applied symmetrically in `TrackSidebar` and `SceneColumn` so heights stay aligned. Multi-arg parameters (OCTOCOSME 12-float bundles, etc.) get the vertical room they need; single-arg parameters keep the tight 32 px floor.

### Pitch-snap (live MIDI scale snapping)

Per-cell scale + root in the Cell Inspector. Snaps the post-modulation, pre-pin value to the nearest note in the configured scale, then renormalises back into the cell's note window (`m.noteMin..m.noteMax`).

- **26 scales** grouped into Major modes, Minor modes, Pentatonic, Symmetric, Exotic.
- **12 roots** (C through B).
- 12-bit pitch-class bitmask per scale (OR of the scale's intervals) - snap is a constant-time search across the ±12-semitone window.
- Per-slot snap config: `Cell.pitchSnap = { scaleId, root, slotIdx }`. Only the specified slot gets snapped; other slots emit unmodified.
- Inspector readout shows "N notes in window" so the user can see at a glance whether their note range will land more than one scale degree on a given knob throw.

### Monitor + Pool layout cleanup

- **Toolbars on the same visual line**: both the Monitor's top bar (Clear / OSC / MIDI toggles) and the Pool's tab strip (POOL / Built-in / User / Scenes / Network) have `min-h-[28px]`. Column-header rows (OSC `time | kind | …`, MIDI, Pool `INSTRUMENTS` / `PARAMETERS`) all share `min-h-[20px]` + `items-center` + matching `border-b`.
- **Pool resize clamp**: Pool's `max` width is now `paneRowWidth − MIN_MONITOR − Learned − handles`, computed via a `ResizeObserver` on the pane row. Dragging the Pool wide can't push the Learned panel + MIDI column behind it. OSC↔MIDI resize handle has its own matching clamp.
- **Learned resize clamp**: same pattern; Learned's `max` is `paneRowWidth − Pool − OSC_MIN − MIN_MIDI − handles`. Edit / ✕ buttons can't slip under the Pool.
- **Pane 1 has `overflow-hidden`** as a hard cap so even a misbehaving column can't bleed into the Pool.
- **Resize handles have a pseudo-element pointer-event extension** (`::before` with ±5 px negative offsets) so the visible 4 px stripe has a ~14 px hit area. Applies to every ResizeHandle in the app.

### Horizontal scroll wheel + Shift+wheel

Logitech MX Master 3S (and any mouse with a native horizontal wheel) emits `deltaX` events; the global wheel handler now lets those flow through to whatever scrollable element the cursor is over - no `preventDefault` unless Ctrl (zoom) or Shift (translate to horizontal scroll) is held.

**Shift+wheel** explicitly walks up from the event target to the nearest `overflow-x: auto/scroll` ancestor and applies `deltaY` as `scrollLeft +=`. Lets users without a horizontal wheel scroll Edit grid / Sequence palette wide layouts.

### Performance pass

The user reported general slowness; the audit (`Agent` audit) surfaced three measurable hot paths:

- **CellTile `caughtKey` selector** ran `Object.keys(hardwareCaught).filter(k => k.startsWith(trackId))` per tile per store update - thousands of allocations per second with many cells on screen. Engine now pre-buckets the flat Map into `Record<trackId, sortedSlot[]>` once per emit; selector is O(1) per tile and returns a joined string for stable `Object.is` equality.
- **Hardware Maps leaked**: `hardwareCaught` and `hardwareOverride` (keyed `${trackId}|${slot}`) were never pruned when tracks were deleted. `updateSession` now matches the existing per-track keep-set logic and deletes orphaned entries.
- **OscMonitor buffer trim**: `splice(0, overflow)` ran on every batch push at 500 msg/sec, each splice O(N). Now lets the buffer overshoot to `MAX_ROWS × 2` (2000) before a single splice trims back to 1000. Display path slices to last `MAX_ROWS` at render time. Steady-state per-push work drops from O(N) to O(1).
- **handleHardwareInput fast-path**: cached `hasAnyHardwareModeEnabled` boolean (computed once per `updateSession`) short-circuits the per-packet template filter when no template has HW Mode enabled session-wide. Saves a filter + array allocation per OSC packet (200 Hz+).

### Misc fixes

- **MIDI velocity no longer gets stuck**: `lastEmittedVelocity` moved to after the `sendNoteOn` call so velocity ≤ 0 (humanize jitter clipping) doesn't lock the badge at zero. Note-edge detector also relaxed to fire after gate-timer noteOff (was stuck silent in modulator-only mode with gate length > 0).
- **HW-caught red highlight scoped to active scene only**: was lighting up the same slots across every scene's copy of the parameter. Inactive scenes get an empty caughtSlots Set now.
- **HW-caught slot index off when cell has fixed argSpec prefix**: display token indices were used to look up `caughtSlots` (keyed by engine arg-slot indices). Now CellTile builds a `displayIdx → engineIdx` map (`argTokenMap`) from `track.argSpec` and passes it to CellValueGrid.
- **MIDI badge fixed-width**: `note→vel` padded to 3-char (`  9→ 99`) so digit-count crossings don't wiggle the layout.
- **Scene column shrink**: Follow dropdown is now sized to fit just "Previous" (its widest label); MIDI binding chip moved out of the column header into the Learned panel.
- **Slot Override panel discoverable**: moved to the TOP of the Scene Inspector (was below Notes / Dur / Next, often invisible without scrolling), with an accent border + tinted background.
- **MIDI Monitor `Learned` panel auto-hides** when the MIDI traffic column is unticked.

---

## Release notes - 0.5.1

A small follow‑up to v0.5.0 focused on **scene ergonomics** and **musical MIDI**. Three additions on top of the v0.5.0 feature set:

### Drag‑to‑reorder scenes

- **In the Edit view grid**: grab the top‑edge color strip of any scene column and drag it horizontally. Other columns slide aside in real time; release to drop. The 6 px strip doubles as the visual scene identifier (its colour) AND the drag handle (cursor‑grab on hover). Activation distance is 4 px so a quick click on the strip never starts a stray drag.
- **In the Sequence view palette**: drop a scene pill onto another pill to reorder. Existing pill → slot, slot → slot drag-and-drop behaviours are preserved unchanged; the reorder is just a new "drop target = sibling pill" case in the same `DndContext`.
- **`session.sequence` is preserved on reorder**: sequence slots reference scenes by ID, so reordering the palette doesn't touch the timeline. Multi‑select, arming, focused scene, engine state all key by ID and survive intact.
- New store action: `moveScene(fromIndex, toIndex)` with clamp + no-op-on-equal-indices.

### User‑configurable MIDI note window

Replaces the v0.5.0 hard‑coded C2..C6 `[0..1] → MIDI note` mapping with a per‑Parameter, per‑cell setting.

- New `MidiOut.noteMin` + `MidiOut.noteMax` (defaults 36 / 84 - old sessions unchanged).
- New "Note range" row in the Cell Inspector's MIDI Output section, only visible in Note mode AND when `midiScale || scaleToUnit` is on (the path that does the [0..1] → note mapping). Lets you set the melodic octave window: `60 → 72` for one chromatic octave starting at C4, `48 → 72` for two octaves, etc. Pretty‑name readout (`C4 – C5`) next to the inputs.
- Engine + CellTile live readout both read the new fields with the same fallback semantics, so the on‑screen MIDI byte always matches what's on the wire.

### Pitch snap - 26 scales × 12 roots

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
- Engine uses a **12‑bit pitch‑class mask** (one `|=` per scale interval at snap time) so the per‑tick membership test is one bitwise AND - no per‑candidate `Array.includes`.
- **Snap re‑normalises back to [0..1]** of the Note range window so OSC stays in [0..1] but is now stepped (one position per scale degree). Round‑trips identically to MIDI: the MIDI emit path's `lo + out × (hi − lo) → round` recomputes the exact snapped note we just chose.
- **Per‑arg**: `pitchSnap.slotIdx` (default 0) picks which arg slot gets snapped; the others pass through unchanged. Multi‑arg cells (e.g. `[note, velocity, duration]`) can have pitch quantised while velocity stays continuous.
- **Pin override beats snap**: a pinned slot's value is the user's explicit final‑say and bypasses the snap.
- Backwards‑compatible: `Cell.pitchSnap` is optional; v0.5.0 sessions load unchanged.

### Practical example - same melody to DAW and Pure Data

1. Add a `MIDI Note` Parameter (Pool → MIDI Note blueprint). Port = your DAW's IAC bus. `noteMin = 60, noteMax = 84` (C4..C6).
2. Add a generic `OSC` Parameter pointing at Pure Data on `127.0.0.1:9000` address `/melody/pitch`.
3. Same scene, same cell on both rows. Turn ON Sequencer + Generative (`Tide` metaphor, amount = 0.6). Turn ON `scaleToUnit`.
4. In the MIDI Output section: enable **Scale snap**, Root = `A`, Scale = `Pentatonic Minor`.
5. Hit Play:
   - DAW receives `A4 C5 D5 E5 G5 A5 C6 …` - generative melody in A minor pentatonic.
   - Pure Data receives `0.000 0.125 0.208 0.333 0.583 0.708 0.917 …` on `/melody/pitch` - same melody, normalised so your custom hardware controller sees the values directly in its [0..1] range.

### Files changed since v0.5.0

- `src/shared/types.ts` - `MidiOut.noteMin/noteMax`, `Cell.pitchSnap`, `ScaleId`, `SCALE_INTERVALS`, `SCALE_LABELS`, `SCALE_GROUPS`, `ROOT_LABELS`
- `src/main/engine.ts` - `snapToScale()` helper + the per‑slot pipeline splice; pitch snap respects the cell's MIDI note window
- `src/renderer/src/components/Inspector.tsx` - Note range row + `PitchSnapEditor` component (root/scale dropdowns + live readout)
- `src/renderer/src/components/CellTile.tsx` - MIDI live readout reads `noteMin/noteMax` instead of the hardcoded 36/84
- `src/renderer/src/components/SceneColumn.tsx` - color strip is now the drag handle via `useSortable`
- `src/renderer/src/components/EditView.tsx` - `DndContext` + `SortableContext` around the scene‑columns row
- `src/renderer/src/components/SequenceView.tsx` - `SortableContext` around the palette; pill → pill drop reorders
- `src/renderer/src/store.ts` - new `moveScene(fromIndex, toIndex)` action

---

## Release notes - 0.5.0

The "native MIDI + Capture + libraries + undo" release. On top of v0.4.5's sequencer / modulator / Pool foundation, v0.5 adds a parallel MIDI output engine, a Capture function that snapshots live OSC / MIDI traffic into the Pool, OSC forwarding so the compositor can fan out to multiple downstream consumers, cross‑session Pool + Scene libraries, 3‑deep undo / redo, per‑session GUI layout persistence, a Save‑before‑quit flow, per‑arg post‑modulation Scaling, and a long list of UX + correctness fixes.

### Native MIDI output

`@julusian/midi` (RtMidi) ships in the main process. Every cell / track / Parameter blueprint can carry a `midiOut` config - port name + channel + kind (`cc` / `note`) + cc number or note number + velocity + gate length. The same modulators + sequencer that drive your OSC fire MIDI in parallel.

- **`MidiOutSender`** in `src/main/midiOut.ts` - lazy port open, rate‑limited error logging, panic, `setEnabled(false)` closes every open port.
- **Global MIDI Output toggle** in the prefs sub‑toolbar - zero‑CPU when off (every emit short‑circuits before the native call).
- **Six MIDI Pool blueprints** out of the box: `par_midi_cc`, `par_midi_note`, `par_midi_cc_pair`, `par_midi_drum`, `par_midi_daw_macro_bank`, `tpl_midi_cc8`.
- **Per‑cell MIDI Output section** in the Inspector - Port picker, Channel (1–16 wide enough to read), Kind (CC/Note), CC# / Note number, Velocity (with its own pin), Gate length, Persistent note flag.
- **MIDI Scale** checkbox next to Scale 0.0–1.0 - independent normalisation; scales the cell's `[0, 1]` float into `0–127` for the MIDI emit only.
- **Live MIDI byte** in the cell tile (`ClipMidiLiveValue`) - violet for CC mode, teal for Note mode, always visible above the transport badge so you can read what's going out on the wire at a glance.
- **`ClipTransportBadge`**: OSC / MIDI / OSC+MIDI pill in every clip tile (slate / violet / teal palette).
- **Native module bundling** via `electron-builder`'s `asarUnpack` so the prebuilt `.node` binaries load at runtime on Windows + macOS universal.

### Monitor drawer (renamed from "OSC Monitor")

Bottom drawer now streams BOTH OSC and MIDI in parallel resizable columns.

- **OSC + MIDI checkboxes** at the top of the toolbar; either column can be hidden.
- **Resizable column split**: vertical drag handle between OSC and MIDI panes; widths persist.
- **Per‑data‑column widths**: drag any header's right edge to resize. Per‑column widths persist independently for OSC vs MIDI.
- **Module‑scope IPC buffers**: closing + reopening the drawer keeps the captured history; capture keeps running while the drawer is closed, so reopening shows messages that fired during the closure.
- **Pool pane resizable** via a leftmost drag bar inside the drawer (200–1200 px, persisted).
- **HMR‑safe IPC subscribers**: Vite hot‑reload no longer doubles the log rows.

### Capture function

A one‑click popup that snapshots live OSC / MIDI traffic into the Pool. Opens via the **● Capture** button in the Pool drawer's header, or by pressing **`C`**.

Four modes:

1. **New Scene for Instrument** *(default)* - pick an existing Pool Instrument; the popup watches OSC traffic that matches its addresses and writes a SavedScene seeded with current values. No new Pool entry.
2. **New Instrument + Scene**: capture a discovered sender as a fresh Pool Instrument AND save its current state as a Scene in the library. Two name fields (Instrument + Scene).
3. **New OSC Instrument**: just the Pool Instrument, no Scene.
4. **New MIDI Instrument**: listens for CC / Note events; each unique slot becomes a Parameter with `midiOut` pre‑wired.

Inside the popup:

- **Live capture monitor**: full multi‑arg payload per address, one **type‑coloured `ArgChip`** per slot (strings amber, ints accent, floats white, bools green / muted, nil / blob muted). Freshness dot per row (green < 500 ms, accent < 3 s, muted otherwise).
- **Mirror monitor in "New Scene for Instrument"**: same chip‑row layout against the picked Instrument's Parameters, with `(no traffic yet)` placeholders for addresses that haven't been seen.
- **Resizable popup** via native CSS `resize: both` corner grip - default `640 × min(700, 88vh)`; no persistence so every open starts at the default.
- **X‑remove per address**: clicking ✕ on a captured row excludes it from the resulting Instrument (toggle ↺ to restore).
- **Address list resize handle** at the bottom edge - drag to grow the captured‑addresses scroll box.
- **Drop‑focus fix on close**: modal close no longer leaves Chromium's sticky pseudo‑focus on the popup's inputs.
- **`destPort` defaults to `dev.port`** instead of hardcoded 9000 - works for OCTOCOSME (1986) or any non‑canonical inbox.
- **Full OSC path as Parameter name**: captured `/A/strips/pots` reads as `/A/strips/pots` in the sidebar, not just `Pots` (which used to collide across mixed‑root devices).
- **Multi‑arg argSpec auto‑generated** from observed OSC type tags - every arg becomes an editable `Value N` slot with the matching type. Pin the leading IP‑string / sequence‑int afterwards in the Pool Inspector's Arg Layout.
- **Cell value positional**: captured cells store the FULL token list (including fixed‑slot placeholders) so `tokensWithDefaults` lines up correctly on edit + emit.
- **Mode order**: top row = scene workflows (`Scene for Instrument`, `Instrument + Scene`); bottom row = bootstrap workflows (`OSC Instrument`, `MIDI Instrument`). Name input blank by default; placeholders read `My OSC Instrument`, `New Scene`, etc.

### OSC forwarding (multi‑target fan‑out)

The compositor can now sit IN FRONT of downstream consumers whose OSC port is fixed. Every UDP packet received on the listen port is byte‑copied to a configurable LIST of forward targets.

- **Forward popover** in the Default OSC group of the top toolbar - green dot + `Forward N/M` count chip; click for the popover.
- **Per‑target row**: enable checkbox, label, IP, port, ✕ remove. `+ Add target` button at the bottom.
- **Byte‑perfect**: a second `'message'` listener attached to the listener's `dgram.Socket` captures raw bytes BEFORE osc‑js parses them; forwarded via a dedicated outbound socket so the source port is ephemeral.
- **Persisted with the session** in `session.forwardTargets[]`. Replayed to main on app load.
- **Safe under disable race**: `setForwardTargets([])` mid‑callback re‑checks the socket inside the loop and try/catches the synchronous `ERR_SOCKET_DGRAM_NOT_RUNNING`.

### Cross‑session libraries

#### Pool library (User Instruments + Parameters)

User‑authored Pool entries now persist to `<userData>/pool-library.json` separately from the session file, and auto‑merge into every new / loaded session.

- **Main process `PoolLibrary`** class - same atomic write pattern as `SceneLibrary`.
- **Auto‑push on every change**: the renderer pushes the User‑entry set to main whenever the store's pool changes.
- **Auto‑merge on load + new**: `setSession` and `newSession` seed the freshly‑built session's pool with the library entries before the auto‑push effect fires, so the library never gets accidentally wiped to `[]` mid‑frame.
- **Cache mirror** in `poolLibraryCache` module‑scope state so `newSession` can re‑seed without an extra IPC roundtrip.

#### Scene library + new Saved Scene Inspector

- **Drag a Saved Scene anywhere on the grid** to instantiate - works in both the Edit‑view grid (including blank space between columns) and the Sequence‑view palette.
- **`instantiateSavedScene` focuses + selects** the new scene; Pool's saved‑scene multi‑selection is cleared at the same time so subsequent Del doesn't act on the source.
- **Save Scene to Pool** right‑click now works (the previous version silently failed because Electron disables `window.prompt`). Uses the scene's current name; rename in the inspector after.
- **Multi‑select Saved Scenes** in the Pool: Ctrl/⌘ + click toggles inclusion, plain click resets to that one; Del bulk‑removes with confirm. Selection auto‑clears when the user switches Pool tab.
- **Save N Scenes to Pool** + **Duplicate N Scenes** right‑click actions on a grid scene multi‑selection.
- **Auto‑increment duplicate names**: `OCTOCOSME (copy)`, then `(copy 1)`, `(copy 2)`, ... - strips an existing `(copy N)` suffix before duplicating so chains stay clean. Applies to Templates, Parameters, and Scenes.
- **New `SavedSceneInspector`**: left‑click a Saved Scene in the Pool's Scenes tab to inspect:
  - Editable: Name, Color (color picker), Notes, Duration, Multiplier, Morph‑in (ms), Next mode.
  - Read‑only "Contents" breakdown listing every Instrument + child Parameter with its captured value; clickable Instrument names jump the Pool selection to its Template Inspector. A `new` badge marks templates not yet in the local Pool.
  - **Use** / **Delete** action buttons.
- **Track ordering on save**: `saveSceneToLibrary` now builds the `tracks[]` list by filtering `session.tracks` in its native sidebar order (Set of needed ids), guaranteeing parent header rows come BEFORE their child Function rows. Eliminates the "scenes reshuffle on instantiate to a blank grid" bug.
- **Scene drag‑drop blur**: after dropping a Saved Scene onto the grid, `requestAnimationFrame(blur + body.focus)` releases Chromium's sticky drag pseudo‑focus so the next click on a clip's input lands cleanly without an alt‑tab.

### Per‑arg pin + per‑arg post‑modulation Scaling

Two new value‑shaping affordances on multi‑arg cells, both per‑slot.

- **Cell‑level pin override**: every editable slot in a multi‑arg cell now has its own pin checkbox in the Cell Inspector with a "cell" / "track" source badge. Three states per slot:
  - `cell.persistentSlots[i] === true` → pinned for this clip, emits `cell.persistentValues[i]`.
  - `cell.persistentSlots[i] === false` → explicit unpin, overrides the track default for this clip only.
  - `cell.persistentSlots[i] === undefined` → inherits the track default.
- **Engine emit precedence**: `argSpec.fixed` (Pool) > cell pin > track pin > live modulated value.
- **Scaling section (new, between Values and Timing)**: collapsible, disabled by default. Per slot:
  - Slot name + Min input + Max input.
  - When enabled, the engine clamps each slot's `out` to `[min, max]` AFTER modulators / sequencer but BEFORE Scale 0.0–1.0 and MIDI Scale. Pinned slots bypass (their value is the user's explicit final say).
  - Lets you tame a Random / Chaos / Generative source overshooting your target band without rewriting the entire sequencer.
- **Inspector `ParameterArgSpecSection`** in the Pool - collapsible Arg Layout editor with per‑slot Name / Type / Pinned / Value rows. Lets you author and edit multi‑arg argSpec entries (including pinning protocol prefixes) on User templates - not just on captured ones.

### Undo / redo - 3 levels

Module `src/renderer/src/undo.ts` runs a Zustand subscriber on `session` identity changes and writes deep‑cloned snapshots into a 3‑deep ring buffer.

- **Coalesce window** of 500 ms - typing bursts collapse into one undoable step.
- **`undo()` / `redo()`** with `suppressSnapshot` flag flipped synchronously inside `try/finally` so unrelated synchronous setStates can't get accidentally swallowed.
- **Counters in store** (`undoCount` / `redoCount`) drive disabled state + depth indicators on the Undo / Redo buttons.
- **Buttons** in the prefs sub‑toolbar (under the dataFLOU brand drop‑down), just left of Close.
- **Keyboard**: Ctrl/⌘+Z (undo), Ctrl/⌘+Shift+Z (redo), Ctrl/⌘+Y (redo alias). Works inside text fields - the snapshot coalescer treats a typing burst as one logical edit, so Ctrl+Z mid‑edit rolls back the whole burst cleanly.
- **History reset** on session load / new / autosave restore so you can't "undo" your way back into a previous file's state.

### Save‑before‑quit + Save‑before‑new

OS X‑button (window close) and toolbar `New` button both go through a modal asking "Save before …?".

- **Save before quitting?** modal - Yes saves the current session (overwrite path or write into the project's `Sessions/` folder if no path), then closes. No discards. Cancel keeps the window open. Errors during save show a red‑bordered banner inside the modal and keep it open instead of silently dropping data.
- **Save before opening a new session?** modal - identical UX, runs `newSession()` after the user picks. New button no longer creates a fresh session without prompting.
- **Sessions folder**: `<project-root>/Sessions/` in dev (or `<install-dir>/Sessions/` in production), with `<userData>/Sessions/` as a fallback when the install dir is unwritable. Auto‑numbered filenames (`session.dflou.json` → `session (1).dflou.json` → …) avoid silent overwrites.

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
- **Older sessions** without `ui` inherit current runtime defaults - no breakage.
- **Default UI scale bumped** from 1.0 to 1.35 so fresh installs aren't tiny on modern monitor DPIs.

### MIDI bindings recall on session load

Every MIDI binding stored in the session (scene `midiTrigger`, cell `midiTrigger`, track `midiTrigger`, `instrumentTriggers`, Meta knob `midiCc`, transport `goMidi` / `morphTimeMidi`) was already serialised - but the renderer never re‑attached the persisted MIDI input device after load, so the bindings looked "gone" until the user manually re‑picked their controller from the top toolbar.

Fixed with a watcher in App.tsx that calls `midi.open(midiInputName)` whenever `session.midiInputName` changes. Open / autosave‑restore / new session all funnel through this and reopen the device cleanly.

### Top toolbar

- **Default OSC group is collapsible** + collapsed by default. Compact chip reads `Default OSC 127.0.0.1:9000 ▸`; click to expand the address / IP / port inputs. Saves ~340 px of toolbar space on the common case.
- **Forward popover button** sits in the Default OSC group with a status dot + `N/M enabled` count.
- **Listening pill** moved from the top toolbar to the Pool drawer's header, immediately left of the `● Capture` button. Reads `Listening 192.168.x.x:1986` with a status dot (green bound, red error, grey off). Auto‑binds the listener to `session.defaultDestPort` on app start.
- **Vertical separator** after the **Pool** label in the Pool's tab strip so the static label no longer reads as a disabled 5th tab.
- **Scenes tab moved** to position 3 (before Network).

### Cell tile rendering

- **Multi‑arg cells** now wrap into a 4‑column grid (`CellValueGrid`). ≤4 tokens render inline; >4 tokens wrap to 3+ rows. Token text rounded to ≤5 chars per slot.
- **Auto‑prefix tokens hidden** from the clip tile display - only EDITABLE slots render (the engine still emits the fixed prefix at send time).
- **Adaptive layout based on row height**: at `rowHeight ≥ 75` shows ip:port row + modulator chips footer; at `60–74` hides ip:port; at `45–59` hides both so the value grid gets every available pixel. Minimum row height bumped from 30 → 45 (below 45 the cell was visually empty).
- **Default row height bumped** from 60 → 95 so multi‑arg cells fit without cropping out of the box.

### Cell + Parameter Inspector

- **CollapsibleViewSection `headerEnd` slot**: renders content at the FAR RIGHT of the section header (outside the toggle button). Used by Destination's `OSC Output` checkbox so the chevron stays in the leftmost column, aligned with every other section's chevron.
- **Parameter Inspector multi‑arg layout** is visible even when there's no clip on the focused scene yet - falls back to `argSpec.init` values as synthetic "current" tokens so the user can pin / unpin slots immediately after dragging in a captured Instrument.
- **MIDI binding chip on scene headers** folded inline with the DUR / NEXT row - no more orphan "floating" lines.
- **Scene name + cell input drop‑focus fixes**: `onFocus` on the scene name re‑anchors selection; cell click stops propagation so it doesn't bubble to the scene header and clobber `selectedCell`.
- **Selection mutex**: clicking a scene clears Pool / track / cell selections; clicking a cell clears Pool selection but preserves the cell's own. Resolves the Del key picking the wrong branch.

### Pool inspector improvements

- **Argument layout editor** for Pool Instruments - collapsible "Arg Layout" section with per‑slot Name / Type / Pinned / Value rows + `+ Add slot` / `Clear all`. Required for duplicated OCTOCOSME‑style templates (the user couldn't edit their multi‑arg argSpec before).
- **"Save as Template" renamed to "Save as User"** in the Track sidebar right‑click menu (the destination is the User tab, not just any "template").
- **"Save Clip as Template"** action added to the filled‑clip right‑click menu. Auto‑names the saved template `Track - Scene`.
- **Multi‑arg clip template projection**: applying a multi‑arg clip template to an empty Parameter row also writes the template's argSpec onto the target track so the multi‑slot structure travels with the template.

### Generative formulas - non‑negative

The generative system used to produce negative values in some modes (tide / wave centred on 0, etc.), which then got clamped to 0 by `scaleToUnit` - giving the appearance of an all‑zero output. Every generative helper rewritten to LIFT above the base instead of swinging around it:

- `tideValue`: `(sin + 1) / 2` for a unipolar sine swell.
- `accentValue`: lift accents above the base by Variation.
- `voicingValue`: Ring A = +33 %, Ring B = +66 %, coincidence = +100 %.
- `waveValue` / `crowdValue` / `terrainValue` / `scatterValue` / `bounceValue` - all post‑clamp to `[0, 1]` if scaleToUnit, otherwise just non‑negative.
- `bounceValue` switched from multiplicative `base × ...` to additive `base + e^i × amount × mag` so it doesn't collapse a zero base.
- `generateStepValue` post‑clamp: `v < 0 → 0`; `if scaleToUnit && v > 1 → 1`.

### Misc engine + correctness

- **OSC port `9000` no longer hardcoded** in Capture - uses the discovered device's actual source port.
- **`/touches`, `/switches_change`** and other captured paths that don't share the dominant root now keep their leading `/`. Previously the no‑root branch stripped them unconditionally.
- **Bounce + Ratchet sub‑pulse** timing uses the actual current step duration (which Bounce varies geometrically across the row).
- **Modulator reseed** under `rndStep` / `rndSmooth` / S&H / Slew / Chaos uses the per‑track PRNG instead of `Math.random()` for deterministic re‑triggers.
- **OSC forwarder use‑after‑close** guarded with an inner socket re‑check + try/catch.
- **Auto‑increment duplicate names** strip existing `(copy N)` suffixes so chains stay clean.

### Build + packaging

- **Native MIDI module bundling**: `electron-builder.yml` adds `node_modules/@julusian/midi/**/*` to `files` and `node_modules/@julusian/midi/prebuilds/**/*` to `asarUnpack` so the prebuilt `.node` binaries load at runtime on Windows + macOS.
- **macOS DMG target** unchanged (universal arch).
- **Windows NSIS + portable** targets unchanged.

---

## Release notes - 0.4.5

The "huge expansion" release. Builds on top of v0.4.1 with a massive sequencer + modulator overhaul, a new generative system, network discovery in the Pool, a Meta Controller destination picker, rich themes, and a long correctness pass.

### Nine sequencer modes

The Sequencer panel now ships with 9 modes instead of 2. Each is its own little instrument:

- **Steps**: the classic 1‑16 step cycle (unchanged).
- **Euclidean**: Pulses + Rotation, evenly distributed across M steps.
- **Polyrhythm**: two interlocking ring clocks (lengths A and B) with a Combine mode (AND / OR / coincidence only).
- **Density**: per‑step probability shaped by Seed + Density knob. In classic mode, density acts as a multiplier on the step value rather than a gate, so the slider sculpts intensity smoothly.
- **Cellular**: 1‑D Wolfram automaton (rule 0‑255). The row evolves once per cycle. **Cellular Seed LFO** modulates the initial row at a user‑set rate/depth for slow pattern drift. Default seed picked so the preview reads as "alive" out of the box.
- **Drift**: Brownian playhead with bias and wrap/reflect edge behaviour.
- **Ratchet**: per‑step burst into 2‑16 sub‑pulses with **7 shaping modes** (Octaves, Ramp, Inverse, Ping‑pong, Echo, Trill, Random). Probability + MaxDiv per step, Variation knob blends global vs per‑step random. Bursts work with Bounce mode (sub‑pulses respect the current step's actual duration).
- **Bounce**: step duration shrinks geometrically across the row, like a settling ball. Animated SVG ball + splash rings in the inspector preview.
- **Draw**: free‑form curve sketcher with **up to 1024 steps**. **X / Y output range** maps the drawn 0..1 curve onto any numeric span. **Randomize** button rolls a smooth‑stepped random starting curve. Per‑step dots up to 64 steps, single playhead dot above that.

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

- **LFO**: sine / triangle / sawtooth / square / rndStep / rndSmooth, bipolar or unipolar.
- **Ramp**: **Mode menu** (Normal / Inverted / Loop), exponent, sync mode. Live progress dot rides the curve. Mode change mid‑play restarts the ramp from t=0 cleanly.
- **Envelope (ADSR)**: Attack / Decay / Sustain / Release as percentages. **Total time label** shown for synced modes. Live progress dot on the ADSR shape.
- **Arpeggiator**: Mode menu (Up / Down / Ping‑pong / Random / Walk / Drunk / Inclusion / Exclusion / Chord) drives playback order; visual shows the ladder for the chosen mode with per‑step labels.
- **Random**: float / int / colour with proper Scale 0.0–1.0 normalisation (RGB bytes map to `[0, 1]` cleanly instead of clipping).
- **Sample & Hold**: probability + smooth modes. Visuals correctly invert probability (was inverted in v0.4.1).
- **Slew**: independent rise / fall half‑life (1 ms – 60 s each).
- **Chaos**: logistic map.

### Network discovery in the Pool

New **Network tab** in the Pool drawer. Click **Listen** to bind a UDP port (default 9000) and the Pool starts logging every OSC sender on the local network.

- Devices show as draggable rows keyed by `ip:port`, with activity dot, packet count, and last‑seen age that refreshes every second.
- Expand a device to see every OSC address it has emitted, with type tags and a live preview of the latest args.
- **Drag onto the sidebar** → materialised as a user Instrument Template with one Parameter per observed address. Multi‑arg addresses get a full `argSpec` (canonical slot names, max=255 for colour) so the cell editor's split‑input strip works immediately.
- Common OSC root auto‑extracted into the template's base path.
- Cancelled drags (Esc / drop off‑target) auto‑clean the just‑materialised template.
- Status header shows local IPv4 addresses + bind status; subscription stays alive at app‑level so the title‑bar dot updates even when the drawer is collapsed.

### Meta Controller - Destination picker + 4‑row bank

Adding a destination to a Meta knob used to be "click +, then hand‑type the IP / port / address." Now the row next to the Destinations header holds **three dropdowns** + a `+`:

- **Instrument**: every Instrument header on the current sidebar (plus orphan Parameters).
- **Parameter**: appears after picking an Instrument; lists its child Parameters.
- **Value**: appears only for multi‑arg Parameters; pick All or a specific slot (x / r / HAUTEUR1 / etc.) to suffix the OSC address.

Click **+** to commit the resolved destination. With no Instrument picked, **+** falls back to the freeform "add empty destination" behaviour.

The **A / B / C / D bank selector** is now a single‑column 4‑row stack so the bar's footprint stays narrow.

### Multi‑arg Sequencer respects pinned slots + fixed protocol headers

When the sequencer is on for a multi‑value parameter (e.g. OCTOCOSME Voice Pots' four pots), the engine now emits the **full** multi‑arg bundle every step. Pinned slots keep their frozen values; unpinned slots receive the sequencer's output (broadcast from the single token, or matched per‑slot if you type a multi‑token step value). You can now sequence one channel while leaving the others hand‑set.

Additionally, **argSpec entries marked `fixed:`** (the protocol headers OCTOCOSME prepends as `sender: "compositor"` and `timestamp: 0` for Pure Data's `list split 2`) are now always emitted as their declared value - the engine bypasses sequencer + modulator on those slots entirely. Previously the sequencer's broadcast value could overwrite them, breaking the receiver's split. The Inspector's pin list shows these slots as locked rows with a `FIXED` badge so you can see what's being prepended on every send.

### Rich themes - Nature + Cream

Two themes opt into a bespoke "rich" UI surface inspired by Hopscotch and Peaks: bespoke arc sliders for Rate / Variation, a mini‑pictogram icon row in place of the sequencer mode dropdown, soft cards around inspector sections, console‑style numeric readouts. **Nature** (Hopscotch palette: dark warm grey + olive→teal + orange) and **Cream** (Peaks palette: cream paper + mustard ochre).

Other themes keep the classic HTML controls.

### Smart Scale 0.0 – 1.0 (auto‑range)

Scale 0.0–1.0 used to be a blunt `clamp01()`. It now **auto‑ranges**:

- **Sequencer + Scale** → precomputes the cycle's per‑token min/max (including ratchet sub‑pulses up to maxDiv=16) and normalises into `[0, 1]`.
- **Modulator + Scale (no sequencer)** → predicts the modulator's output range and normalises against that.
- **Degenerate range** → emits the user's actual value clamped into `[0, 1]` instead of forcing 0.5.
- **Random colour mode** now normalises through `(v - min) / (max - min)` so RGB bytes don't collapse to 0/1.

### Hold vs Last rest behaviour

A new dropdown on every sequencer: **Hold** (default - receiver naturally holds the previous value during rests; the engine suppresses redundant re‑sends) or **Last** (re‑emits the previous step's value on every rest tick).

### Engine + correctness pass

A long list of small fixes from the v0.4.5 review:

- **Atomic session + autosave writes**: saves go to `<path>.tmp` then `fs.rename`, so a crash mid‑write can never corrupt the file.
- **Autosave write race** fixed via an `inFlight` Promise mutex - shutdown final‑flush and the 60s tick can't double‑write or race the prune step.
- **Engine.stop()** now clears every ephemeral tick field (`liveValues`, `lastTickAt`, `pauseStartedAt`, active scene bookkeeping) so a re‑`start()` doesn't compute against stale state.
- **Modulator state reseed** (rndStep / rndSmooth / S&H / Slew / Chaos) now uses the per‑track PRNG instead of `Math.random()` for deterministic re‑triggers.
- **Ratchet sub‑pulse timing** under Bounce mode now uses the current step's actual (variable) duration rather than the constant `stepDurMs`.
- **predictModRange** for ratchet auto‑range raised from 8 to 16 to match the runtime cap - high‑division bursts no longer clip.
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
- **Drift bias asymmetry** fixed - extreme bias (`±1`) now produces a truly monotonic walk (was capped at 2/3 forward).
- **Modulator visuals** now correctly invert S&H probability (the high‑probability branch was firing the low‑probability path) and use proper Slew bipolar dropdown sizing.
- **Random Stepped LFO** no longer disappears at fast BPM‑sync - `visibleStairs = max(8, cycles*8)`.
- **Arpeggiator visual** rebuilt to be driven by Arp Mode (not multMode) for accurate playback‑order display.
- **Inspector step‑value edits** read fresh state inside the onChange callback so rapid keystrokes can't race across re‑renders.
- **CellTile triggerAtRef** moved from render body to a `useEffect` so the ramp progress dot doesn't micro‑jitter at trigger.
- **RcArcSlider / RcFlatBar** got pointer cancel handlers + try/catch around capture so OS‑yanked pointers don't leave them in a captured‑scrub state.
- **RcModeIcons** switched to `flex-wrap` so the 9 icons fold onto two rows at narrow widths / high UI zoom.
- **OscMonitor + Pool now scale with Ctrl+wheel zoom**: moved inside the zoom wrapper, with drawer max height adapting to `uiScale` so the drawer can't eat the workspace at 2×.
- **Pool header layout fixed**: User tab's "+ Instr / + Param / ⤢ / Hide" cluster shrunk so "Built‑in" doesn't wrap to two rows.
- **`materialiseNetworkDevice` regex injection** fixed - OSC roots containing `.` / `(` / `+` etc. no longer produce malformed patterns.
- **Render‑deterministic empty session**: atomic writes, integrity migration backfills every new sequencer / modulator field with sane defaults so v0.3.x and v0.4.0 sessions load cleanly.

---

## Release notes - 0.4.1

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
- Pin individual args on a multi‑arg cell - modulation keeps running on the others.

### Other
- Scene cells auto‑size to widest clip.
- Track‑defaults auto‑inheritance.
- Drop‑focus stickiness fix.

---

## Release notes - 0.4.0

**The big merger toward Alex Burton's dataFLOU C++ library:** the editor now speaks the library's vocabulary natively. A flat row of Messages becomes a hierarchy of typed **Instruments** (Templates) holding **Parameters**, with a browseable **Pool** for shipped + user‑authored entries.

- **Pool of Instruments + Parameters**: Built‑in / User tabs, shipped library of 3 Instruments + 5 Parameter blueprints, drag‑to‑instantiate.
- **Group triggers** at every Instrument × Scene intersection - fires every child clip in one gesture.
- **Timeline view**: alternate Sequence visualization, scenes as flex blocks proportional to Duration.
- **Sequence polish**: palette pills hug their names, multi‑scene drag‑drop fills consecutive slots, slot multi‑selection.
- **Transport**: Play in Sequence is dedicated to sequence transport; Pause freezes scene time end‑to‑end; live remaining‑time pill.
- **Inspector toggles**: I / S / M / O / P.
- **OSC Monitor drawer** resizable.
- "Collapse Messages" → "Collapse Instruments".

---

## Release notes - 0.3.6

Three new modulators, Euclidean sequencing, and correctness fixes.

- **Sample & Hold**, **Slew**, **Chaos** modulators.
- **Euclidean** sequencer mode.
- Follow actions, Stop, S&H smooth math, shutdown sequencing fixes.

---

## Release notes - 0.3.5

Live‑performance polish + Ramp + autosave.

- **Cue system** + Morph + Show / Kiosk + transport HH:MM:SS:MS.
- **Ramp** modulator + Envelope synced mode.
- **Autosave + crash recovery**.
- **OSC monitor drawer**.
- **Meta Controller expanded to 32 knobs / 4 banks**.

---

## Release notes - 0.3.0

- **Meta Controller** bank (8 knobs originally), 14 curves, MIDI CC learn, 8 destinations per knob.
- **Follow actions** + ×Multiplicator.
- **Multi‑select** everywhere.
- **5 new themes**, **UI zoom**, **Scene inspector in Sequence view**, **Notes** toggle.

---

## Project status

A personal tool by [Vincent Fillion](https://vincentfillion.com), in active use. As of v0.5.14:

- ✅ **Correctness + features pass (v0.5.14)**: Modulation 2 → direct value routing (new M2 column), Hardware Mode Catch/Jump takeover, Ramp "From" mode, "Update scene to current settings", Scene Inspector in Grid view, adjacent scene insert, undo depth raised to 100, plus 35 bug fixes — including `forwardMode`/`deviceMatch` no longer being stripped on session load, the Random modulator now honoring the routing matrix, and typing a duration no longer firing scene triggers.
- ✅ **Hardware Mode discrete-slot catch on value change (v0.5.13)**: int + bool slots catch the moment their value differs from the device's previous transmission — no threshold, no idle-time window. Slow single presses catch instantly (the v0.5.12 bug), and a streaming controller's unchanged state can no longer steal slots back from a freshly-triggered scene. Fixes the OCTOCOSME instrument selector, INTERVALLE, KILL switches, GLOBAL_MODE / TOUCH_MODE — while letting scenes assert their saved switch data.
- ✅ **Hardware Mode UX hardening (v0.5.12)**: live status dot at the configuration site, `deviceMatch: 'ipOnly'` toggle for ephemeral-port senders, `forwardMode: 'suppress' | 'always' | 'whenIdle'` policy so the controller can reach downstream only when no scene is playing (auto-flipping via `engine.activeSceneId`), int + bool slots catch instantly under HW Mode (v0.5.12 introduced the type-aware branch; v0.5.13 finished the job by moving it ahead of the movement gate), info-popup tooltips on every field, right-click "Bind to template" from Network Discovery rows, loopback flag + Capture-popup filter.
- ✅ **Capture current state as new scene (v0.5.12)**: right-click any scene → snapshot the engine's live emitted values (incl. Hardware Mode catches) into a new scene cloned from the source, inserted adjacent.
- ✅ **Session-load migration: template-kind OSC cleanup (v0.5.12)**: legacy `oscEnabled: true` on template-header cells forced false on load; matches the engine's runtime invariant.
- ✅ **Hardware Mode**: drive any cell's args from a physical OSC controller with catch-mode soft-takeover, per-template config, multi-instance scope, per-arg locks, RESET / PERSIST modes, live red highlighting on caught slots.
- ✅ **Per-sequence-slot overrides**: duration + follow-action per placement; same scene in two slots can have independent timing AND independent next-actions.
- ✅ **Velocity Humanize**: 0–100 % jitter rolling at the same rate as modulator-driven note edges, with live wire-accurate badge display.
- ✅ **Learned MIDI panel**: every active MIDI binding listed in the Monitor's far-right column, with inline kind / number / channel editor.
- ✅ **Pitch-snap**: 26 scales × 12 roots, per-cell per-slot, snapping after modulation before pin.
- ✅ **Undo / redo**: 3 levels deep, debounced, available via Ctrl+Z / Ctrl+Shift+Z and toolbar buttons.
- ✅ **MIDI output**: native (RtMidi) per cell / track / Parameter, with global enable + live Monitor.
- ✅ **OSC fan‑out**: multi‑target Forward popover lets the compositor sit in front of Pure Data / Ableton / another machine.
- ✅ **Cross‑session libraries**: Pool (Instruments + Parameters) and Scene libraries persist across sessions.
- ✅ **Save‑on‑quit / Save‑on‑new** with confirmation modals + error surfacing.

Still out of scope:

- No OSC bundles with timestamps
- No quantized scene changes (cue firing is immediate)
- No mDNS / OSCQuery (Network discovery is passive listening only)
- No MIDI clock output (MIDI is per‑message CC + Note; sync is OSC‑driven internally)

Issues and PRs welcome.

---

## License

ISC - do whatever you want, no warranty.
