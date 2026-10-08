// Stands in for 'electron' when the mesh bridge runs outside Electron (tests).
import * as os from 'os'
import * as path from 'path'

export const app = {
  getPath: (_name: string): string => path.join(os.tmpdir(), 'dataflou-mesh-test', 'userData'),
  getVersion: (): string => '0.6.7'
}
