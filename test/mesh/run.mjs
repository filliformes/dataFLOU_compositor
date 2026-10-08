// Runs test/mesh/mesh.test.ts: bundles it with esbuild ('electron' → a stub,
// '@shared' → src/shared, as in electron-vite) and executes it with Node.
//
//   npm run test:mesh            (env: DATAFLOU_ROOT, DFHOST — see mesh.test.ts)

import { build } from 'esbuild'
import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const out = path.join(os.tmpdir(), 'dataflou-mesh-test.bundle.mjs')

await build({
  entryPoints: [path.join(here, 'mesh.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: {
    '@shared': path.join(repo, 'src', 'shared'),
    electron: path.join(here, 'electron-stub.ts')
  },
  // CommonJS dependencies (multicast-dns, dns-packet) need `require` in ESM
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'error'
})

const r = spawnSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, MESH_TEST_REPO: repo }
})
process.exit(r.status ?? 1)
