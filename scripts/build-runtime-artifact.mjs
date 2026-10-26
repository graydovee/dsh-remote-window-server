/**
 * Build one isolated DSH runtime artifact for the v1 client.
 *
 * Layout contract (client `src/provision/runtime.ts`): the tarball root holds
 * `node/` (a full Node distribution) and `dsh/` (an installed
 * `@deepseek-ai/dsh@<dshVersion>`). The client uploads this file to the
 * per-client runtime directory and the remote install script verifies
 * `<node>/bin/node -v` before atomically swapping both directories.
 *
 * Usage (one target; CI builds one artifact per matrix slot and feeds a
 * platform-matched Node archive):
 *
 *   node scripts/build-runtime-artifact.mjs \
 *     --dsh-version 0.2.1-rc.2 --platform linux --arch x64 --libc gnu \
 *     --node-archive /path/node-v24.21.0-linux-x64.tar.gz --out dist-runtime
 *
 * Local smoke on the same platform can pass --node-dir /path/to/node-prefix
 * (the directory containing bin/node and lib/) and --verify-run.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { stageDshPackage } from '../src/provision/package-build.ts'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
function required(name) {
  const value = arg(name, '')
  if (value === '') { console.error(`[runtime-artifact] --${name} is required`); process.exit(2) }
  return value
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 'signal'}`)
}
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function findPnpm() {
  const explicit = arg('pnpm', '')
  if (explicit !== '') return resolve(explicit)
  const root = join(homedir(), '.dsh', 'dsh-runtimes')
  for (const entry of await readdir(root).catch(() => [])) {
    for (const candidate of [
      join(root, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
      join(root, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    ]) {
      if (await stat(candidate).then(entry => entry.isFile(), () => false)) return candidate
    }
  }
  throw new Error('cannot find pnpm.cjs (pass --pnpm or set up ~/.dsh/dsh-runtimes/*/dependencies/pnpm)')
}
async function extractNodeArchive(archive, nodeStage) {
  const unpack = `${nodeStage}.unpack`
  await rm(unpack, { recursive: true, force: true })
  await mkdir(unpack, { recursive: true })
  run('tar', ['-xzf', resolve(archive), '-C', unpack])
  const entries = await readdir(unpack, { withFileTypes: true })
  const directory = entries.find(entry => entry.isDirectory())
  const source = directory === undefined ? unpack : join(unpack, directory.name)
  const sourceStat = await stat(join(source, 'bin', 'node')).catch(() => undefined)
  if (sourceStat === undefined || !sourceStat.isFile()) throw new Error(`node archive ${archive} has no bin/node`)
  await mkdir(nodeStage, { recursive: true })
  await cp(source, nodeStage, { recursive: true, force: true })
  await rm(unpack, { recursive: true, force: true })
}
async function verifyLayout(nodeStage, dshStage, verifyRun) {
  const node = join(nodeStage, 'bin', 'node')
  const launcher = join(dshStage, 'node_modules', '.bin', 'dsh')
  const nodeInfo = await stat(node).catch(() => undefined)
  const launcherInfo = await stat(launcher).catch(() => undefined)
  if (nodeInfo === undefined || !nodeInfo.isFile()) throw new Error('staged runtime has no node/bin/node')
  if (launcherInfo === undefined) throw new Error('staged runtime has no dsh/node_modules/.bin/dsh')
  for (const path of [node, launcher]) run('chmod', ['+x', path])
  if (!verifyRun) return
  const version = spawnSync(node, ['-v'], { encoding: 'utf8' })
  if (version.status !== 0) throw new Error(`staged node did not answer -v: ${version.stderr}`)
  const launcherProbe = spawnSync(launcher, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(nodeStage, 'bin')}:${join(dshStage, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` },
  })
  if (launcherProbe.status !== 0) throw new Error(`staged dsh did not answer --version: ${launcherProbe.stderr}`)
  console.log(`[runtime-artifact] node ${version.stdout.trim()}; dsh ${(launcherProbe.stdout || launcherProbe.stderr).trim().split('\n')[0]}`)
}

const dshVersion = required('dsh-version')
const platform = required('platform')
const arch = required('arch')
const libc = arg('libc', platform === 'linux' ? 'gnu' : '')
if (platform !== 'linux' && platform !== 'darwin') { console.error('[runtime-artifact] platform must be linux or darwin'); process.exit(2) }
if (arch !== 'x64' && arch !== 'arm64') { console.error('[runtime-artifact] arch must be x64 or arm64'); process.exit(2) }
const outDir = resolve(arg('out', 'dist-runtime'))
const nodeArchive = arg('node-archive', '')
const nodeDir = arg('node-dir', '')
if (nodeArchive === '' && nodeDir === '') {
  console.error('[runtime-artifact] pass --node-archive <platform Node tarball> or --node-dir <extracted Node prefix>')
  process.exit(2)
}
const nodeBin = resolve(arg('node-bin', process.execPath))
const pnpmCjs = await findPnpm()
const name = `dsh-runtime-${dshVersion}-${platform}-${arch}.tar.gz`
const work = resolve(arg('work', join(outDir, `.stage-${platform}-${arch}-${process.pid}`)))
await rm(work, { recursive: true, force: true })
const nodeStage = join(work, 'node')
const dshStage = join(work, 'dsh')
await mkdir(work, { recursive: true })
console.log(`[runtime-artifact] ${name}: staging node + dsh@${dshVersion} for ${platform}-${arch}${libc === '' ? '' : `-${libc}`}`)
if (nodeArchive !== '') await extractNodeArchive(nodeArchive, nodeStage)
else {
  await mkdir(nodeStage, { recursive: true })
  await cp(resolve(nodeDir), nodeStage, { recursive: true, force: true })
}
await mkdir(dshStage, { recursive: true })
const installed = await stageDshPackage({
  stage: dshStage,
  version: dshVersion,
  platform,
  arch,
  libc,
  nodeBin,
  pnpmCjs,
  onProgress: message => console.log(`[runtime-artifact] ${message}`),
})
await verifyLayout(nodeStage, dshStage, process.argv.includes('--verify-run'))
await mkdir(outDir, { recursive: true })
const file = join(outDir, name)
run('tar', ['-czf', file, '-C', work, 'node', 'dsh'])
const digest = await sha256(file)
const bytes = (await stat(file)).size
await writeFile(`${file}.sha256`, `${digest}  ${name}\n`, { mode: 0o644 })
await writeFile(`${file}.manifest.json`, `${JSON.stringify({
  name,
  layout: 'node+dsh',
  dshVersion: installed,
  expectedDshVersion: dshVersion,
  platform,
  arch,
  ...(libc === '' ? {} : { libc }),
  platformArch: `${platform}-${arch}`,
  sha256: digest,
  bytes,
}, null, 2)}\n`, { mode: 0o644 })
await rm(work, { recursive: true, force: true })
console.log(`[runtime-artifact] ${file}`)
console.log(`[runtime-artifact] sha256 ${digest}`)
