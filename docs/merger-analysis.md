# dataFLOU compositor ↔ dataFLOU library — merger analysis

Working notes on what the two codebases are, what's missing on each side,
and the merger paths that look viable. Written after the compositor's
v0.4.0 ship (Pool / Instruments + Parameters / Timeline) so it has the
shared vocabulary baked in. The library reference is `124_dataflou-main`
v53/core v7 (the version the screenshots came from — circular web
visualizer with DRUMMER-01 / SYNTH-01 / CONTROLLER-01 nodes).

---

## TL;DR

The compositor and the library are **complementary, not redundant**.

- The **library** is a decentralized, real-time **parameter mesh** between
  embedded devices and desktop hosts, with a beautiful read-only +
  hover-edit web visualizer. It has no concept of time, scenes, MIDI, or
  modulators.
- The **compositor** is an **authoring + performance editor** for time-
  bounded scenes that emit OSC over UDP, with rich modulators, a cue
  system, and MIDI control. It has no concept of a mesh, peers,
  subscriptions, or a live universe.

The compositor v0.4.0 vocabulary already mirrors the library's (`paramType`,
`nature`, `streamMode`, `min/max/init`, `unit`, classes-as-blueprints). The
remaining work is **wiring**, not redesign.

**Chosen direction (after discussion with Vincent):** the compositor
joins the mesh as an **Agent** — a `dataflou::Node` peer with its own
SKU. It discovers other Agents via mDNS, exposes its own state
(scenes, Meta Controller, transport) as a parameter tree under
`compositor-01/…`, and *sends OSC* as the data plane (the existing
engine, unchanged). Other Agents' parameter trees auto-populate the
Pool's new **Mesh** tab; drag-drop creates Instrument rows whose OSC
destinations are auto-resolved from the peer's mDNS-resolved IP +
declared osc_bridge port.

Implementation uses the dataflou CLI binary as a **sidecar process**
(no native addon, no node-gyp pain). Renderer talks to the sidecar
via the same WebSocket protocol the web/ visualizer uses.

---

## What each system is

### dataFLOU library (Alex Burton)

A C++17 mesh framework. Each device on a LAN runs a `dataflou::Node`
which:

- **discovers peers** over mDNS (`_dataflou._tcp.local.`)
- **gossips schemas** — every node DECLAREs its parameter tree (CBOR over
  TCP) and pulls peers' trees into a local `WorldView` via version
  vectors. No central controller.
- **streams values** — destination requests, source pushes (`SUBREQ → STREAMREQ`,
  UDP, `stream_codec`) at the parameter's declared `rate_hz`. 15 s
  keepalive, 30 s expiry, automatic `value_cast` between numeric types.
- **persists the world** to disk (`IStorage`) so a node remembers offline
  peers. FLUSH is the only way to remove one.
- **exposes a WebSocket visualizer** (`vis_server`) with 9 message types
  for snapshot push, value sets, subscription edits, parameter add/
  delete/update, FLUSH. The web/ folder is a vanilla-JS + D3 SVG circular
  layout — exactly what the screenshots show.
- **plans a "geste" event layer** (designed in `docs/geste.md`, runs
  inside Atelier — *not* the library). Lua coroutines, a destination-
  first DSL (`flou("path") + 0.2`), pools (N×M parameter templates),
  and a Form FSM for scene transitions with crossfades.

Everything builds for embedded (ESP32, Teensy via PlatformIO + lwIP)
**and** desktop (CMake + ASIO). Single-threaded, tick-driven `poll()`.

### dataFLOU_compositor v0.4.0 (Vincent)

An Electron + React desktop app. A 2D grid where:

- **Rows = Instruments** (Templates owning child Parameters). Each row
  knows an OSC destination + path.
- **Columns = Scenes** with a duration, follow-action, multiplicator,
  morph-in.
- **Cells = clips** with value, modulators (LFO/Ramp/Envelope/Arp/
  Random/S&H/Slew/Chaos), sequencer (steps + Euclidean), delay,
  transition.
- **Pool drawer** with Built-in / User tabs hosting Instrument Templates
  and standalone Parameter blueprints (`InstrumentFunction` and
  `ParameterTemplate` already use the library's `ParamMeta` field
  vocabulary on purpose).
- **Engine** runs in the Electron main process at 10–100 Hz, sends OSC
  via UDP, supports per-cell smoothing, group triggers per Instrument
  per Scene.
- **Sequence + Timeline views**, **Cue/GO**, **Scene Morph**,
  **Meta Controller** (32 knobs × 4 banks × 14 curves × 8 destinations),
  **MIDI Learn**, **autosave + crash recovery**, **show mode**.

Sessions are plain JSON files. There's no notion of peers, no mesh, no
subscriptions, no incoming values — strictly a one-way OSC sender.

---

## Vocabulary mapping (already mostly aligned)

| Compositor (v0.4.0) | Library | Notes |
|---|---|---|
| `InstrumentTemplate` (Pool) | a node's parameter sub-tree, or a **Class** | The compositor lacks the library's `inherits` mechanism — Templates clone fields explicitly. |
| `InstrumentFunction` | leaf `ParamNode` | 1:1 |
| `ParameterTemplate` (User Pool, RGB Light, Knob…) | **Class** (a `ParamMeta` template referenced via `"inherits"`) | Same idea! Compositor is missing the inheritance resolver. |
| `Track` (sidebar row) | instantiated leaf `ParamNode` in the local store | 1:1, except the compositor row also carries an OSC destination. |
| `paramType: bool/int/float/v2/v3/v4/colour/string` | `ParamType: Bool/Number/String/V2/V3/V4/Blob/Colour` | Library has `Blob` (compositor doesn't); library has no separate `int`. Mostly compatible, mappable both ways. |
| `nature: lin/log/exp` | `Nature: Lin/Log/Exp` | identical |
| `streamMode: streaming/discrete/polling` | `StreamMode: Streaming/Discrete/Polling` | identical |
| `min/max/init` | `range_min/max/init` | identical |
| `unit` | `unit` (`etl::string<8>`) | identical |
| `smoothMs` (single number) | `smooth_up + smooth_down` (asymmetric) | **Library is richer.** Compositor should split this. |
| `oscAddress: /foo/bar` | `path: foo/bar` (slash-separated, no leading slash) | Mechanical conversion. |
| `destIp:destPort` (per cell) | inferred at runtime by the source node from its peer table | **Library doesn't think in OSC at all** — the address-of-a-target is `(sku, path)`. |
| Scene | (none) | The library has no time bounds. |
| follow action / multiplicator | (planned in geste Form FSM, library-side: `from(state):to(state):when(expr):fade(secs)`) | Different mechanic, similar intent. |
| Modulators (LFO/Ramp/…) | (none — values arrive from a connected source param) | The library expects modulation to come from a **producer node** (an LFO is just another node). |
| Cue / GO | (none) | live performance is not the library's concern. |
| MIDI Learn | (none) | the library has no MIDI awareness. |

The Pool tab system I built (`Built-in: Instruments + Parameters` /
`User: Instruments + Parameters`) is essentially a static cousin of the
library's `WorldView` — same vocabulary, no mesh.

---

## What's missing (in each direction)

### What the library has that the compositor doesn't

These are **infrastructure** features the compositor currently fakes by
sending blind OSC.

| Feature | Library | Compositor |
|---|---|---|
| Multi-node mesh discovery (mDNS) | ✓ | ✗ |
| Schema gossip (DECLARE / DIGEST / version vectors) | ✓ | ✗ |
| Live `WorldView` of all peers' parameter trees | ✓ | ✗ |
| Parameter subscriptions (one source → many destinations) | ✓ | ✗ |
| UDP data plane with keepalive (`stream_codec`) | ✓ | ✗ (uses raw OSC) |
| `value_cast` between numeric types (Number↔V3↔Colour) | ✓ | ✗ |
| `Topology` enum (Span/Centered/Cyclic/Free) for spatial fields | ✓ | ✗ |
| `Access` (R/W/RW), `FlowDir` (Source/Dest/Bidir) | ✓ | ✗ — every track is implicitly Source/Write |
| `ground: bool` (revert to init on source disconnect) | ✓ | ✗ |
| `hardware: bool` (this param is a real knob) | ✓ | ✗ |
| `inherits` (CSS-cascade param classes) | ✓ | partial — Pool Templates clone but don't inherit |
| Pool kind (N×M template expansion for polyphony) | planned (`docs/geste.md`) | ✗ |
| Asymmetric smoothing (`smooth_up`/`smooth_down`) | ✓ | partial — `smoothMs` is single-valued |
| `Universe` namespacing | ✓ | ✗ |
| Persistence with version vectors + offline-aware nodes | ✓ | only flat JSON sessions |
| BLOB transport (Lua source push) | ✓ | ✗ |
| WebSocket visualizer with hover-edit | ✓ | ✗ |
| Geste / Form / Pool event layer (Lua) | designed | ✗ |

### What the compositor has that the library doesn't

These are the **authoring + performance** layer the library leaves to
its host (Atelier or anyone else).

| Feature | Compositor | Library |
|---|---|---|
| Scenes with duration + follow action | ✓ | ✗ |
| Step / Euclidean sequencer per cell | ✓ | ✗ |
| 8 modulator types with sync modes | ✓ | ✗ |
| Cue / GO / arm with MIDI binding | ✓ | ✗ |
| Per-clip scene-to-scene Morph | ✓ | ✗ |
| Meta Controller (32 knobs × 8 dests × 14 curves) | ✓ | ✗ |
| MIDI Learn + Web MIDI input | ✓ | ✗ |
| Show / Kiosk mode | ✓ | ✗ |
| Autosave + crash recovery | ✓ | partial (persistence, no rolling snapshots) |
| Theme system + UI zoom | ✓ | ✗ |
| Authoring UI surface (the actual editor) | ✓ | ✗ (the library has only a visualizer + REPL) |

The library deliberately punts all of this to the **host**. Atelier was
the planned host, with Lua gestes. The compositor is a viable parallel
host with a graphical scene editor instead of a Lua DSL.

---

## Merger paths

Five paths, in order of decreasing pragmatism / increasing depth.

### Path A — Static JSON import (one-shot)

**Goal:** Vincent's existing dataflou device JSON configs (`octocosme.json`,
node1.json, …) become Pool entries on import.

**Mechanism:**
- File menu: `Import dataFLOU device…` opens a `.json` file.
- A small parser maps `params[].kind=class` → `ParameterTemplate` (the
  Pool's User Parameters tab); `params[].kind=group + children:[…]` →
  `InstrumentTemplate` with child `InstrumentFunction[]`.
- `inherits: "fader"` resolves locally to the matching Class entry.
- Path mapping: `mixer/volume` → OSC `/<deviceLabel>/mixer/volume`.
- Round-trip: `Export Pool item as dataFLOU JSON` writes back the schema
  the library can load directly.

**Pros:** zero runtime coupling, no native modules, ships in days. The
compositor instantly understands every device the user has already
declared.

**Cons:** static — values don't flow back, no live view. The user keeps
authoring scenes blind.

**Effort:** ~2 days. Pure renderer-side code in `shared/` (parser) +
file picker in main.

### Path B — Compositor as a dataflou WebSocket client (recommended first step)

**Goal:** The compositor connects to a running `dataflou::Node`'s
WebSocket (the same one the web visualizer uses) and treats the live
`WorldView` as a dynamic Pool.

**Mechanism:**
- New TopBar control: **dataFLOU mesh ▾** — connects to
  `ws://<host>:<port>/ws` (mDNS-discoverable as
  `_dataflou-vis._tcp.local.`).
- Subscribe to `snapshot` messages → populate a third Pool tab,
  **Mesh**, alongside Built-in / User. Each peer node becomes an
  Instrument Template; its leaf params become child Parameters; its
  classes become Parameter blueprints.
- Drag a Mesh entry onto the Edit-view sidebar → instantiates a row
  whose OSC destination is replaced by a `(sku, path)` *mesh
  reference*.
- The engine, when triggering a cell whose track is a mesh reference,
  sends `set_value` over the WebSocket instead of an OSC packet. (The
  receiving node turns around and emits OSC / hardware updates / etc.
  via its own bindings.)
- Inversely: on `snapshot` updates, mesh-bound clip tiles show the live
  current value as their countdown text.
- Hover-edit, MIDI Learn, Meta Controller all work as before; their
  output writes via the WS bridge.

**Pros:**
- Pure JSON over WebSocket. **No native modules.** Implementable as a
  small renderer-side module sitting next to `midi.ts`.
- Backwards-compatible: legacy OSC tracks keep emitting OSC; mesh
  tracks emit through the bridge. Per-track choice.
- The compositor gains the mesh's discovery, persistence, and
  keepalive **for free** — the dataflou node handles all of that and
  the compositor just listens for snapshots.
- Vincent can author with real, live device parameters in front of him
  (the screenshots show how dense the live information is — perfect for
  the Pool's right-side Inspector).

**Cons:**
- Requires a `dataflou::Node` running somewhere on the LAN (a desktop
  helper or the device itself). Not standalone.
- WebSocket framing means values cap at the WS server's poll rate,
  not the UDP `stream_codec` rate. Fine for scene values; not great
  for per-clip 120 Hz LFOs through the bridge. (Solution: keep
  modulators emitting OSC directly to the device, only schedule
  scene-level changes through the mesh.)

**Effort:** ~1 week.
- `src/renderer/src/mesh.ts` — WS connection, snapshot diffing,
  outgoing message types.
- New store slice: `mesh: { connected, world: Map<sku, Node>, ... }`.
- Pool tab adds `Mesh` mode reading from the store.
- `Track` gets an optional `meshRef?: { sku, path }` discriminating it
  from OSC tracks.
- Engine path: `triggerCell` checks `track.meshRef` and dispatches to
  `mesh.setValue(...)` instead of `osc.send(...)`.

This is **the path I'd recommend first.** It buys the merger's most
visible payoff (live mesh-aware authoring) at low integration cost.

### Path C — Embed `dataflou::Node` inside the Electron main process

**Goal:** The compositor IS a node in the mesh (with its own SKU,
appears in other peers' WorldViews) — not just a client.

**Mechanism:**
- Compile `libdataflou` (CMake) into a Node native addon (N-API) or
  call out to a sidecar process (simpler — spawn a CLI node and bridge
  via stdin/stdout / IPC). Sidecar wins on portability since the
  library already has a CLI binary.
- The compositor's session declares its top-level Pool entries as the
  node's parameter tree. The engine's per-track output writes the
  param's value via `Node::set_value(local_path, …)` and the dataflou
  data plane handles streaming to subscribers.
- The compositor gains `Node::subscribe(local_path, source_sku,
  source_path)` — wire any mesh source to drive a Meta knob, a clip
  value, a scene-trigger.

**Pros:** the compositor becomes a first-class member of the mesh.
Other devices can subscribe to its scene outputs directly without
going through OSC.

**Cons:**
- **Native module pain** (the app-creation skill flags this — node-gyp
  + libdataflou cross-compilation for Win/Mac CI is real work).
  Sidecar avoids this but adds an IPC layer.
- The compositor is now structurally tied to the dataflou library's
  release cycle.

**Effort:** 2–3 weeks for the sidecar approach; 4+ weeks for a native
addon with CI builds.

### Path D — Compositor becomes Atelier's authoring UI

**Goal:** Replace the Lua DSL planned for Atelier with the compositor's
graphical authoring surface. A Scene becomes a `geste`. The Form FSM
becomes the sequencer.

**Mechanism:**
- Each Scene gets exported as a Lua coroutine via a code generator:
  ```lua
  geste("scene1", function(self)
    self:define {
      ["mixer/volume"] = adsr(0.1, 0.5, 0.7, 1.0),
      ["lights/color"] = flou("controller/knobs/k1") * 0.5
    }
    yield_for(scene.durationSec)
  end)
  ```
- Modulators get translated into Lua expressions (the LFO's
  `sin(2π·rate·t)` is trivial; the sequencer + Euclidean is one
  function).
- Follow actions become the Form FSM transitions.
- The compositor saves *both* `.dflou.json` (its native format) AND a
  `scenes.lua` for Atelier consumption.

**Pros:** a complete merger. The compositor is no longer "talking to"
the library; it generates the runtime that runs on it.

**Cons:**
- Big rewrite. Engine becomes a code generator instead of a runtime.
- Modulator semantics need to match exactly — easy to drift.
- Lua execution is not yet implemented in the library (geste is
  designed but not built per `docs/architecture-review.md`).

**Effort:** 6–8 weeks, gated on Atelier landing.

### Path E — Hybrid: discover via mesh, drive via OSC (fastest payoff)

**Goal:** Use the WebSocket connection only to *discover* the world
(populate the Pool); keep the engine on UDP/OSC.

**Mechanism:**
- Same as Path B for the discovery half.
- When the user drags a Mesh Pool entry onto the sidebar, the row's
  destination is set to the device's mDNS-resolved IP + a configured
  OSC port (which a dataflou node would expose via an `osc_bridge`
  param adapter). Path conversion: `foo/bar` → `/<deviceLabel>/foo/bar`.
- The compositor never sends through the WebSocket — it just *reads*
  the schema.

**Pros:** zero engine changes. Even faster than Path B (no bridge
write path). Works with devices that already speak OSC (most do).

**Cons:** the compositor doesn't drive the mesh, doesn't hover-edit
remotely. It's a one-way "import live schema" — useful, but stops short
of the merger payoff.

**Effort:** 2–3 days (just the discovery half of Path B).

---

## Chosen direction — Compositor as an Agent

The five paths above were the option survey. The chosen direction
combines **Path C's "compositor IS a node"** with **Path E's "data
plane stays OSC"**, implemented via a **sidecar process** to dodge
the native-addon complexity. Vocabulary tweak: the system calls them
"Agents" rather than "Nodes" — same concept, friendlier name.

### The picture

```
LAN
├── DRUMMER-01      (ESP32, dataflou::Node)
├── SYNTH-01        (Teensy, dataflou::Node)
├── CONTROLLER-01   (custom, dataflou::Node)
└── COMPOSITOR-01   ← the compositor (dataflou::Node, desktop)
      ↑
      └─ Electron renderer
```

```
Electron app
├── main (Node)
│   ├── existing OSC engine                ─→  UDP/OSC to peers
│   ├── DataflouAgent                      (sidecar process)
│   │   └─ runs: dataflou-cli
│   │            --label=compositor-01
│   │            --listen-ws=:7401
│   │            --osc-bridge-in=:9050     (so peers can write to us via OSC too)
│   └── IPC bridge to renderer
└── renderer
    ├── Edit / Sequence views (unchanged)
    ├── mesh.ts  (parallel to midi.ts)
    │   └─ ws://localhost:7401/ws ←→ snapshot, subscribe, set_value, …
    └── Pool > **Mesh** tab (new)
```

### Why "be an Agent" beats "be a client"

Three things appear for free that pure-WS-client wouldn't give you:

1. **Compositor shows up in everyone else's visualizer.** It's not
   just consuming the world — it's participating in it.
2. **Compositor's own state is a tree of subscribable params.** Each
   Scene's active flag, every Meta Controller knob's value, transport
   time, focused scene id — all under `compositor-01/…`. Another
   Agent can subscribe `lights/intensity ← compositor-01/meta/A/k1/value`
   and the lights track the knob with no router in between. The
   compositor stops being just a sender; it becomes a routable part
   of the mesh.
3. **Persistence + offline grace are inherited.** When the compositor
   quits, peers see its node go offline (frozen schema, last values).
   When it comes back with the same SKU, version vectors reconcile.
   That's a lot of plumbing the compositor doesn't have to write.

### User workflow once it's wired

1. User powers on DRUMMER-01 + CONTROLLER-01. They join the mesh.
2. User launches dataFLOU_compositor. It spawns its sidecar Agent,
   joins the mesh as `compositor-01`.
3. **Pool > Mesh** tab populates from `snapshot` messages — DRUMMER-01
   and CONTROLLER-01 appear as Instruments with their full parameter
   trees as children.
4. User drags DRUMMER-01 onto the sidebar → creates an Instrument row
   with one Parameter per leaf in DRUMMER-01's tree (`kit/kick/pitch`,
   `mixer/volume`, …). Each child Parameter's track is preconfigured
   with the right OSC destination (DRUMMER-01's IP + its declared
   osc_bridge port + the path translated to slash-prefixed OSC).
5. User authors clips on the Scene Steps. The engine sends OSC as it
   always has — DRUMMER-01's `osc_bridge` decodes incoming OSC into
   `set_value` calls on its local store. The mesh wasn't used for the
   data plane, but it provided the *schema discovery + addressing*.
6. Concurrently, CONTROLLER-01 has subscribed to
   `compositor-01/meta/A/k1/value`. The user grabs that knob; the
   value flows through the mesh's UDP data plane (not OSC) at the
   declared rate; CONTROLLER-01's hardware LED tracks it. No glue
   code in the compositor needed for this — the mesh handles it.

### Phased engineering plan

**Phase 1 — Sidecar wiring.** Build the dataflou CLI for Win/Mac,
bundle it inside the Electron app's `resources/`. Add a `DataflouAgent`
manager in main process: spawn on app start, kill on quit, restart on
crash, persist SKU between launches.

**Phase 2 — Read the world.** `mesh.ts` in the renderer connects to
`ws://localhost:7401/ws`. Listens for `snapshot` messages, mirrors
them into a `meshWorld` zustand slice. New Pool tab: **Mesh**, lists
every non-self Agent + their tree. Drag-drop instantiates Instruments;
track addresses auto-resolve via the peer's mDNS-resolved IP + an
`osc_bridge_port` field on the peer's identity (see library-side
asks below).

**Phase 3 — Declare ourselves.** The compositor pushes its own
parameter tree to the sidecar via `add_param` / `update_param` WS
messages: every Scene's metadata + active flag, every Meta Controller
knob with its `min/max/curve/unit`, transport time, etc. Other peers'
visualizers now show `compositor-01` as a real Agent. The engine
writes the live values into the local ParamStore on each tick → peer
subscriptions just work.

**Phase 4 — Author from the world.** Right-click any leaf in Pool >
Mesh → *"Bind a Meta knob to this"*: opens a learn flow that creates
the inverse subscription (compositor's knob value drives the remote
param). At this point the compositor is fully bidirectional.

**Phase 5 — Optional: mesh data plane.** Per-track toggle: "Send via
OSC" (default, current behavior) vs "Send via mesh" (writes through
the WS bridge → SETVAL → UDP `stream_codec` to the peer). For peers
that don't run osc_bridge.

### Asks for the library side

Three small additions on the library side that fall out of this
workflow. None reshape anything — they're all conventions /
advertisements.

1. **mDNS TXT advertisement of the osc_bridge listening port.**
   Today the compositor would have to ask the user "what port does
   DRUMMER-01 listen for OSC on?" If the Agent advertises
   `osc_in=9050` in its mDNS TXT record (or exposes it as a well-
   known parameter like `meta/osc_in_port`), the compositor reads it
   from the Agent's discovery record and the user never sees the
   question.

2. **The `atelier_ver` TXT key** — already mentioned in
   `docs/atelier-integration.md` for Atelier. The compositor can use
   the same convention to identify itself as the mesh's authoring
   host (e.g. `atelier_ver=4` so other peers know an authoring
   surface is on the network).

3. **Standardize a `device_label`-driven OSC namespace convention.**
   When the compositor sends OSC to `192.168.x.y:9050`, it prefixes
   the address with the peer's label: `/octocosme/kit/kick/pitch`.
   The receiving osc_bridge already does this — it just needs to be
   documented as the convention so the compositor can rely on it.

If Alex is comfortable with these three, the merger is mostly an
integration project on the compositor side and the library doesn't
fork.

### Two questions for Alex

1. **Is the dataflou CLI sidecar approach (vs N-API native addon)
   acceptable on the library side?** It assumes the CLI binary stays
   a stable surface across versions — its WS protocol + command-line
   flags become part of the API contract.
2. **Would he be open to standardizing `osc_in_port` (or
   `meta/osc_in_port`) for OSC-bridge-equipped Agents?** It removes
   a manual setup step from every authoring session.

### Risks / failure modes worth flagging

- **Sidecar lifecycle:** another process to launch / quit / crash-
  handle. Need to handle sidecar crashes gracefully (auto-restart,
  surface errors in the TopBar).
- **Session ↔ declaration coupling:** when the user opens session A
  vs session B, `compositor-01`'s declared parameter tree changes.
  That's a `decl_version` bump and re-DECLARE — fine for the library
  to handle, but worth testing with multi-peer setups.
- **Multicast on corporate networks:** mDNS gets blocked sometimes.
  Provide a manual `--peers=ip:port,…` fallback in the sidecar.
- **macOS Gatekeeper for the sidecar binary:** bundle inside the
  `.app` so it shares the parent's signing context.

---

## Concrete v0.4.x → v0.5.0 backlog

To prep for the chosen direction (and any of the alternative paths if
priorities shift), four small structural changes worth making before
the sidecar work itself starts:

1. **Split `smoothMs` into `smoothUpMs` + `smoothDownMs`** in
   `InstrumentFunction` / `ParameterTemplate`. Migrate via
   `propagateDefaults` (single value populates both). Matches library
   `smooth_up`/`smooth_down`.
2. **Add `groundOnDisconnect: bool` and `hardware: bool`** flags to
   `InstrumentFunction`. Inert today (the OSC engine doesn't have a
   "disconnect" event) but they round-trip through any mesh import/
   export and unlock Path A's bidirectional JSON.
3. **Path field decoupling.** Today a Track stores
   `defaultOscAddress: "/octocosme/mixer/volume"`. Split into:
   `device: "octocosme"` + `path: "mixer/volume"`. Render the OSC
   address as `"/" + device + "/" + path`. This prepares Track for
   Path E (the device label maps to the dataflou node's mDNS label
   automatically).
4. **`atelier_ver` TXT advertisement.** When the compositor adds a
   sidecar/mesh client, advertise itself with an extra TXT key
   (`atelier_ver=4`) per `docs/atelier-integration.md` — so other
   nodes know an authoring host is on the network.

These are 1–2 day changes each, do them while the merger work itself is
still being scoped.

---

## Notes on the screenshots

The web visualizer in the screenshots is the library's `web/` rendered
via `vis_server` (port 80 / `192.168.101.101` is the running node). Each
node is one of the concentric arcs; the leaf parameters live around the
perimeter; lines between params are subscriptions ("gestes"). The
right-hand atelier panel is the planned Lua editor (per
`docs/atelier-integration.md` — the `vis_server` `on_message` hook
dispatches `atelier.*` namespaced messages).

The "subscriptions" overlay in screenshot 2 (top-right table:
`controller-01/hw/knobs/k2 → mixer/aux/send`, etc.) is the same data the
compositor would render in its Pool's right-side Inspector if it
listened to the WS protocol. That panel is in the library's
`docs/visualizer.md` and renders from the `snapshot` message's `subs`
array on each leaf param.

The "Subscriptions: 4 / 5 underserved" toast some screenshots imply is
the "underserved" detection (actual rate < declared rate) — rendered as
a 4,2 dash pattern on cables. Worth borrowing for the compositor's
in-grid health visualization.
