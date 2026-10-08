// End-to-end test of the dataflou mesh bridge (src/main/dataflouMesh.ts)
// against the real C++ core: two dfhost nodes (Alex's examples/node1.json and
// examples/node2.json --simulate, moved to an isolated universe) + the
// compositor's MeshAgent, driven like the main process drives it (session
// pushes, engine output hook, engine state).
//
//   npm run test:mesh
//
// Env:
//   DATAFLOU_ROOT  the 124_dataflou clone (default: ../124_dataflou)
//   DFHOST         the dfhost executable (default: <DATAFLOU_ROOT>/build/bin/dfhost[.exe])
// dfhost is built with the library (typescript/test/dfhost in 124_dataflou).
//
// Also checks that every local Sessions/*.dflou.json (not committed) fits the
// C++ core's fixed tree sizes.

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MeshAgent, buildDecls } from '../../src/main/dataflouMesh'
import * as P from '../../src/main/dataflou/protocol'
import { ParamStore } from '../../src/main/dataflou/model'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const REPO = process.env.MESH_TEST_REPO ?? process.cwd()
const ROOT = process.env.DATAFLOU_ROOT ?? path.resolve(REPO, '..', '124_dataflou')
const EXE =
  process.env.DFHOST ??
  ['dfhost.exe', 'dfhost'].map((f) => path.join(ROOT, 'build', 'bin', f)).find((f) => fs.existsSync(f)) ??
  ''
if (!EXE || !fs.existsSync(EXE)) {
  console.error('dfhost not found. Build 124_dataflou (cmake -S . -B build && cmake --build build) or set DFHOST.')
  process.exit(2)
}
if (!fs.existsSync(path.join(ROOT, 'examples', 'node1.json'))) {
  console.error(`examples/node1.json not found under ${ROOT} — set DATAFLOU_ROOT to the 124_dataflou clone.`)
  process.exit(2)
}

const UNIVERSE = 'df-compositor-test'
const N1 = 'c0ffee01-0000-4000-8000-000000000001'
const N2 = 'c0ffee02-0000-4000-8000-000000000002'
const WORK = path.join(os.tmpdir(), 'dataflou-mesh-test')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })

const results: string[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  — ' + detail}`)
}

// ── session fixture ────────────────────────────────────────────────

const knobs = Array.from({ length: 32 }, (_, i) => ({
  name: `Knob ${i + 1}`,
  min: 0,
  max: 1,
  curve: 'linear',
  value: 0,
  smoothMs: 0,
  destinations: i < 12 ? [{ destIp: '127.0.0.1', destPort: 9000, oscAddress: `/meta/${i + 1}` }] : []
}))
const SESSION: Any = {
  version: 1,
  name: 'mesh-test',
  tickRateHz: 60,
  globalBpm: 100,
  tracks: [
    { id: 't-inst', name: 'OCTOCOSME', kind: 'template' },
    {
      id: 't-int',
      name: 'Intervalle',
      kind: 'function',
      parentTrackId: 't-inst',
      argSpec: [
        { name: 'mode', type: 'string', fixed: 'int' },
        { name: 'Intervalle', type: 'float', min: 0, max: 15 }
      ]
    },
    {
      id: 't-pots',
      name: 'Voice Pots',
      kind: 'function',
      parentTrackId: 't-inst',
      argSpec: Array.from({ length: 6 }, (_, i) => ({ name: `HAUTEUR${i + 1}`, type: 'float', min: 0, max: 1 }))
    },
    { id: 't-gate', name: 'Global Mode', kind: 'function', parentTrackId: 't-inst', argSpec: [{ name: 'on', type: 'bool' }] },
    { id: 't-free', name: 'Loose Param', kind: 'function' }
  ],
  scenes: [
    { id: 's-noir', name: 'NOIR' },
    { id: 's-blanc', name: 'BLANC' },
    { id: 's-gris', name: 'Gris clair' }
  ],
  metaController: { visible: false, selectedKnob: 0, height: 120, knobs }
}

// ── 0. tree shape: within the C++ core's fixed sizes, DECLARE < 32 KB ──

function fits(label: string, s: Any): void {
  const b = buildDecls(s)
  const store = new ParamStore()
  for (const d of b.decls) (d.meta.kind === 2 ? store.declareParam(d.path, d.meta) : store.declareGroup(d.path, d.meta))
  let maxKids = store.root.children.length
  let count = 0
  store.walk((_p: string, n: Any) => {
    count++
    maxKids = Math.max(maxKids, n.children.length)
  })
  const id = { sku: 'x', label: 'x', product: 'dataFLOU_compositor', version: 700, state: 0 }
  const decl = P.encodeDeclare(1, N1, N1, 1, id, store)
  check(
    `tree fits library limits: ${label}`,
    count <= 127 && maxKids <= 32 && decl.length < 32000 && count === b.decls.length,
    `nodes=${count} maxChildren=${maxKids} declare=${decl.length}B`
  )
}
fits('fixture', SESSION)
const sessDir = path.join(REPO, 'Sessions')
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir).filter((x) => x.endsWith('.dflou.json'))) {
    try {
      fits(`Sessions/${f}`, JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')))
    } catch (e) {
      check(`tree fits library limits: Sessions/${f}`, false, (e as Error).message)
    }
  }
}

// ── C++ nodes ──────────────────────────────────────────────────────

function isolatedConfig(file: string, sku: string): string {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', file), 'utf8'))
  cfg.universe = UNIVERSE
  cfg.identity.sku = sku
  const out = path.join(WORK, file)
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2))
  return out
}

interface Host {
  proc: ChildProcess
  cmd: (l: string) => void
  world: () => Any
  log: () => string
}

function host(name: string, cfg: string, extra: string[] = []): Host {
  const dir = path.join(WORK, name)
  fs.mkdirSync(dir, { recursive: true })
  const cmdFile = path.join(dir, 'cmd.txt')
  const worldFile = path.join(dir, 'world.json')
  fs.writeFileSync(cmdFile, '')
  let out = ''
  const proc = spawn(EXE, [cfg, path.join(dir, 'storage'), cmdFile, worldFile, ...extra])
  proc.stdout?.on('data', (d) => (out += d.toString()))
  proc.stderr?.on('data', (d) => (out += d.toString()))
  return {
    proc,
    cmd: (l) => fs.appendFileSync(cmdFile, l + '\n'),
    world: () => {
      try {
        return JSON.parse(fs.readFileSync(worldFile, 'utf8'))
      } catch {
        return { nodes: [] }
      }
    },
    log: () => out
  }
}

function findParam(tree: Any, p: string): Any {
  let cur = tree
  for (const seg of p.split('/')) {
    cur = (cur?.children ?? []).find((c: Any) => c.name === seg)
    if (!cur) return null
  }
  return cur
}

const built = buildDecls(SESSION)
const h1 = host('n1', isolatedConfig('node1.json', N1))
await sleep(300)
const h2 = host('n2', isolatedConfig('node2.json', N2), ['--simulate'])
await sleep(300)

const calls: Any[] = []
const agent = new MeshAgent({
  triggerScene: (id: string) => calls.push({ t: 'scene', id }),
  stopAll: () => calls.push({ t: 'stop' }),
  action: (a: Any) => calls.push({ t: 'action', ...a })
})

try {
  await agent.init()
  check('mesh is off by default', agent.snapshot().running === false)
  agent.updateSession(SESSION)
  await agent.setConfig({ enabled: true, universe: UNIVERSE, label: 'compositor-test' })
  await sleep(400)
  const me = agent.snapshot()
  const SKU = me.sku
  check(
    'node starts with the session tree',
    me.running && !!me.nodes[0]?.isLocal && me.nodes[0].params.length === built.decls.length,
    JSON.stringify({ running: me.running, n: me.nodes[0]?.params.length, want: built.decls.length, err: me.error })
  )
  await sleep(7000)

  // 1. the C++ nodes see the compositor's tree
  const w1 = h1.world().nodes.find((n: Any) => n.sku === SKU)
  const [trackId, binding] = [...built.tracks.entries()].find(([, b]: Any) => b.path && b.type === 1) as Any
  const srcPath: string = binding.path
  check(
    'C++ sees the compositor online with instruments/meta/scenes/transport',
    !!w1?.online &&
      !!findParam(w1.params, srcPath) &&
      !!findParam(w1.params, 'instruments/OCTOCOSME/Voice_Pots/HAUTEUR1') &&
      !!findParam(w1.params, 'meta/A1') &&
      !!findParam(w1.params, 'transport/go') &&
      !!findParam(w1.params, [...built.scenes.keys()][0]),
    JSON.stringify(w1 ? { online: w1.online, kids: w1.params?.children?.map((c: Any) => c.name) } : null)
  )
  const snap = agent.snapshot()
  check(
    'snapshot lists both C++ nodes online with params',
    snap.nodes.filter((n: Any) => !n.isLocal && n.online && n.params.length > 3).length === 2,
    JSON.stringify(snap.nodes.map((n: Any) => [n.label, n.online, n.params.length]))
  )

  // 2. engine output → mesh source → C++ destination (stream, range-mapped 0..15 → 0..1)
  const spec = SESSION.tracks.find((t: Any) => t.id === trackId).argSpec ?? []
  const pump = setInterval(() => {
    const t = Date.now() / 1000
    const v = binding.min + (binding.max - binding.min) * (0.5 + 0.5 * Math.sin(t * 2))
    const args = spec.map((a: Any) => (a.fixed !== undefined ? { type: 's', value: String(a.fixed) } : { type: 'f', value: v }))
    agent.onTrackOutput(trackId, args, false)
  }, 20)
  h2.cmd(`sub ${N2} seq/swing ${SKU} ${srcPath}`)
  await sleep(2500)
  const sw: number[] = []
  for (let i = 0; i < 5; i++) {
    sw.push(findParam(h2.world().nodes.find((n: Any) => n.sku === N2)?.params, 'seq/swing')?.value)
    await sleep(300)
  }
  clearInterval(pump)
  check(
    'Parameter row output streams to a C++ destination',
    sw.every((x) => typeof x === 'number' && x >= 0 && x <= 1) && new Set(sw.map((x) => Math.round(x * 1000))).size >= 3,
    JSON.stringify(sw)
  )

  // 3. engine state → transport/scene + scenes/<x>
  const [scenePath, sceneId] = [...built.scenes.entries()][1]
  const sceneName = SESSION.scenes.find((s: Any) => s.id === sceneId).name
  agent.onEngineState({ activeSceneId: sceneId } as Any)
  await sleep(300)
  const selfTree = agent.snapshot().nodes[0].params
  check(
    'transport/scene + scenes/<x> follow the engine',
    selfTree.find((p: Any) => p.path === 'transport/scene')?.value === sceneName && selfTree.find((p: Any) => p.path === scenePath)?.value === 'true',
    JSON.stringify(selfTree.filter((p: Any) => p.path.startsWith('transport')))
  )

  // 4. C++ SETVAL → scene trigger, GO (momentary: each press fires), Stop
  const [scene0Path, scene0Id] = [...built.scenes.entries()][0]
  h1.cmd(`set ${SKU} ${scene0Path} true`)
  h1.cmd(`set ${SKU} transport/go true`)
  h1.cmd(`set ${SKU} transport/stop true`)
  await sleep(800)
  h1.cmd(`set ${SKU} transport/go true`)
  await sleep(600)
  check('SETVAL scenes/<x> true triggers that scene', calls.some((c) => c.t === 'scene' && c.id === scene0Id), JSON.stringify(calls))
  check(
    'SETVAL transport/go fires GO per press (momentary)',
    calls.filter((c) => c.t === 'action' && c.type === 'go').length === 2 &&
      agent.snapshot().nodes[0].params.find((p: Any) => p.path === 'transport/go')?.value === 'false',
    JSON.stringify(calls)
  )
  check('SETVAL transport/stop stops all', calls.some((c) => c.t === 'stop'))

  // 5. C++ source → compositor Meta knob A1 (bound from the compositor)
  const err = agent.subscribe(SKU, 'meta/A1', N2, 'transport/tempo', true)
  await sleep(2500)
  const kv = calls.filter((c) => c.t === 'action' && c.type === 'metaKnob' && c.index === 0).map((c) => c.value)
  check(
    'C++ stream drives Meta knob A1 (30..300 → 0..1)',
    err === null && kv.length > 5 && kv.every((k: number) => k >= 0 && k <= 1) && new Set(kv.map((k: number) => Math.round(k * 100))).size > 3,
    `err=${err} n=${kv.length} ${JSON.stringify(kv.slice(-4))}`
  )
  const a1 = agent.snapshot().nodes[0].params.find((p: Any) => p.path === 'meta/A1')
  check('the binding shows in the snapshot (subs)', !!a1?.subs?.some((s: Any) => s.sku === N2 && s.path === 'transport/tempo' && s.label), JSON.stringify(a1))

  // 6. bind a C++ destination to a compositor source (SUBREQ) + SETVAL to C++
  const e2 = agent.subscribe(N2, 'seq/steps', SKU, 'transport/bpm', true)
  const e3 = agent.setValue(N2, 'mixer/output/level', '-6')
  await sleep(1500)
  const n2w = h2.world().nodes.find((n: Any) => n.sku === N2)
  check(
    'compositor binds a remote destination (SUBREQ) + SETVAL with text parsing',
    e2 === null &&
      e3 === null &&
      findParam(n2w?.params, 'mixer/output/level')?.value === -6 &&
      (findParam(n2w?.params, 'seq/steps')?.subs ?? []).some((s: Any) => s.sku === SKU),
    JSON.stringify({ e2, e3, lvl: findParam(n2w?.params, 'mixer/output/level')?.value, subs: findParam(n2w?.params, 'seq/steps')?.subs })
  )
  check('a bad SETVAL value is rejected', agent.setValue(N2, 'mixer/output/level', 'loud') !== null)

  // 7. session edit → hot re-declare (renamed scene)
  const s2 = JSON.parse(JSON.stringify(SESSION))
  s2.scenes[0].name = 'Renamed By Test'
  agent.updateSession(s2)
  await sleep(1500)
  check(
    'a session edit re-declares to C++ (renamed scene appears)',
    !!findParam(h1.world().nodes.find((n: Any) => n.sku === SKU)?.params, 'scenes/Renamed_By_Test')
  )

  // 8. label change, switch off → LEAVE, persisted identity
  await agent.setConfig({ label: 'compositor-renamed' })
  await sleep(1500)
  check(
    'label change reaches C++',
    h1.world().nodes.find((n: Any) => n.sku === SKU)?.label === 'compositor-renamed',
    JSON.stringify(h1.world().nodes.map((n: Any) => n.label))
  )
  await agent.setConfig({ enabled: false })
  await sleep(1200)
  check('switching off → C++ marks the compositor offline', h1.world().nodes.find((n: Any) => n.sku === SKU)?.online === false)
  const cfg = JSON.parse(fs.readFileSync(path.join(WORK, 'userData', 'dataflou-mesh.json'), 'utf8'))
  check(
    'config persisted (stable sku, label, universe, enabled)',
    cfg.sku === SKU && cfg.label === 'compositor-renamed' && cfg.universe === UNIVERSE && cfg.enabled === false,
    JSON.stringify(cfg)
  )
  check('no reconnect churn on the C++ side', !/port changed/.test(h1.log() + h2.log()))
} catch (e) {
  check('test ran to completion', false, (e as Error).stack ?? String(e))
} finally {
  agent.shutdown()
  h1.cmd('quit')
  h2.cmd('quit')
  await sleep(400)
  h1.proc.kill()
  h2.proc.kill()
}

console.log(results.join('\n'))
const passed = results.filter((r) => r.startsWith('PASS')).length
console.log(`${passed}/${results.length} pass`)
if (passed !== results.length) console.log('--- n1 log tail ---\n' + h1.log().split('\n').slice(-20).join('\n'))
process.exit(passed === results.length ? 0 : 1)
