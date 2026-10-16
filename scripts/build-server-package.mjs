/**
 * Package the server plugin for distribution.
 *
 *   node scripts/build-server-package.mjs [--out dist-server] [--version <ver>]
 *
 * Version defaults to this package's own `package.json`; the tarball carries
 * `package.json`, `cordis.patch.yml`, `lib/server.js`, `lib/protocol.js` and a
 * `manifest.json` ({protocol: 2}).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(new URL('..', import.meta.url).pathname)
const out = resolve(process.cwd(), process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'dist-server')
// Default to the package's own version: a literal here goes stale silently and
// stamps a wrong version into the manifest of a release artifact.
const packageVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const version = process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : packageVersion
await mkdir(out, { recursive: true })
await exec('pnpm', ['build'], { cwd: root })
const files = ['package.json', 'cordis.patch.yml', 'lib/server.js', 'lib/protocol.js']
const staging = resolve(out, `dsh-remote-workspace-server-${version}`)
await exec('mkdir', ['-p', staging])
for (const file of files) {
  const destination = resolve(staging, file)
  await mkdir(dirname(destination), { recursive: true })
  await exec('cp', [resolve(root, file), destination])
}
await writeFile(resolve(staging, 'manifest.json'), JSON.stringify({
  name: 'dsh-remote-workspace-server',
  version,
  protocol: 2,
  entry: 'lib/server.js',
  requires: { node: '>=22.19.0', dsh: 'profile host' },
}, null, 2) + '\n')
const archive = `${staging}.tar.gz`
await exec('tar', ['-czf', archive, '-C', out, `dsh-remote-workspace-server-${version}`])
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(`${archive}.sha256`, `${digest}  ${archive.split('/').at(-1)}\n`)
console.log(`${archive}\nsha256=${digest}`)
