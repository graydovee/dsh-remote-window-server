/** Build and pack the installable server plugin tarball for the QA installer.
 *
 * Output (git-ignored): dist/server-plugin/dsh-remote-workspace-server-<version>.tgz
 * plus its .sha256 and .manifest.json. The archive keeps npm's `package/`
 * prefix; the client installer strips it when extracting into the profile.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outDir = join(root, 'dist', 'server-plugin')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('pnpm', ['build'])
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
run('pnpm', ['pack', '--pack-destination', outDir])

const tarball = join(outDir, `${manifest.name}-${manifest.version}.tgz`)
const bytes = await readFile(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
await writeFile(`${tarball}.sha256`, `${sha256}  ${manifest.name}-${manifest.version}.tgz\n`, { mode: 0o644 })
await writeFile(`${tarball}.manifest.json`, `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  protocol: 1,
  phase: 'M2q',
  features: ['persist-rpc', 'managed-blank', 'eventcount-shared-cache', 'seq-mismatch-bad-request', 'executor-switch', 'mux-ws', 'fs-list', 'blank-cold-fix', 'registry-guard-stable', 'error-status-map', 'session-executor-row', 'spawn-diagnostics-path', 'archived-pin-status', 'session-rename-fallback', 'refresh-route-survival', 'onboarding-dismiss', 'execution-world-extracted', 'v2-timeline-events-agent', 'v2-data-fixes', 'agent-scoped-approval', 'approval-prepend-diagnostics'],
  mux: 'ws-frame-mux',
  dshVersion: manifest.engines?.dsh ?? null,
  tarball: `${manifest.name}-${manifest.version}.tgz`,
  sha256,
  bytes: bytes.length,
}, null, 2)}\n`, { mode: 0o644 })
console.log(`server plugin tarball: ${tarball}`)
console.log(`sha256: ${sha256}`)
