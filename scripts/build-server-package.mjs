/**
 * Build the remote server package(s) — the dsh runtime world this project's
 * server runs inside.
 *
 * One-shot local build:
 *   node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu
 * Full release matrix (what CI runs):
 *   node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2
 *
 * Outputs into --out (default `dist-server`):
 *   dsh-remote-server-<dshVersion>-<platformArch>[-libc].tar.gz
 *   …tar.gz.sha256 / ….manifest.json
 *
 * These artifacts belong to **this** repository: the plugin only consumes them
 * from our GitHub releases (owner/repo hardcoded in the plugin's `assets.ts`,
 * `releaseAssetBase`). The staging logic lives in
 * `src/provision/package-build.ts`, a byte-identical copy of the plugin's
 * module — the same contract that keeps `src/protocol.ts`, `src/server/**` and
 * `src/frame/**` in step.
 *
 * (This replaces the old script that tarred this package's own `lib/`: the
 * plugin deploys its own server bundle, so a "package" of `lib/` was never what
 * a connection downloads. The runtime package below is.)
 *
 * Node ≥ 22.6 required (type stripping).
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildServerPackage, artifactTag } from '../src/provision/package-build.ts'

/** First `--flag value` on the command line, or the fallback. */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

/**
 * The node + pnpm pair used to stage `@deepseek-ai/dsh`.
 *
 * `DSH_HOST_PNPM`/`DSH_HOST_NODE` (absolute files) win — that is how CI hands
 * over a real `pnpm.cjs`, because a PATH shim cannot be run as
 * `node <shim> -C <stage> add …`. Otherwise the harness runtime layout under
 * `~/.dsh/dsh-runtimes/<runtime>/dependencies` is probed, accepting both the
 * POSIX and the Windows spellings.
 */
async function findHostPnpm() {
  const env = process.env
  if (env.DSH_HOST_PNPM !== undefined && env.DSH_HOST_NODE !== undefined) {
    return { node: env.DSH_HOST_NODE, pnpm: env.DSH_HOST_PNPM }
  }
  const isFile = path => stat(path).then(entry => entry.isFile(), () => false)
  const firstFile = async candidates => {
    for (const candidate of candidates) if (await isFile(candidate)) return candidate
    return undefined
  }
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
  for (const entry of await readdir(runtimes).catch(() => [])) {
    const deps = join(runtimes, entry, 'dependencies')
    const pnpm = await firstFile([
      join(deps, 'pnpm', 'bin', 'pnpm.cjs'),
      join(deps, 'pnpm', 'bin', 'pnpm.mjs'),
      join(deps, 'pnpm', 'pnpm.cjs'),
    ])
    const node = await firstFile([
      join(deps, 'node', 'bin', 'node'),
      join(deps, 'node', 'bin', 'node.exe'),
      join(deps, 'node', 'node.exe'),
    ])
    if (pnpm !== undefined && node !== undefined) return { node, pnpm }
  }
  throw new Error('cannot find a host pnpm to stage the dsh runtime package (set DSH_HOST_PNPM and DSH_HOST_NODE)')
}

const outDir = resolve(arg('out', 'dist-server'))
await mkdir(outDir, { recursive: true })

const tool = await findHostPnpm()
console.log(`[build-server] using node ${tool.node}`)
console.log(`[build-server] using pnpm ${tool.pnpm}`)

const dshVersion = arg('dsh-version', '')
if (dshVersion === '') {
  console.error('[build-server] --dsh-version is required (e.g. 0.2.1-rc.2)')
  process.exit(2)
}

/** The release matrix; musl slots are declared but fail loudly until a musl node dist is wired in. */
const MATRIX = [
  { platform: 'linux', arch: 'x64', libc: 'gnu' },
  { platform: 'linux', arch: 'arm64', libc: 'gnu' },
  { platform: 'darwin', arch: 'x64', libc: '' },
  { platform: 'darwin', arch: 'arm64', libc: '' },
]

const all = process.argv.includes('--all')
const targets = all
  ? MATRIX
  : [{
      platform: arg('platform', 'linux'),
      arch: arg('arch', 'x64'),
      libc: arg('libc', arg('platform', 'linux') === 'linux' ? 'gnu' : ''),
    }]

let failed = false
for (const target of targets) {
  const tag = artifactTag(target.platform, target.arch, target.libc)
  console.log(`[build-server] building ${tag} …`)
  try {
    const result = await buildServerPackage({
      version: dshVersion,
      platform: target.platform,
      arch: target.arch,
      libc: target.libc,
      outDir,
      nodeBin: tool.node,
      pnpmCjs: tool.pnpm,
      onProgress: message => console.log(`[build-server] ${message}`),
    })
    const size = (await stat(result.file)).size
    console.log(`[build-server] ${tag}: ${(size / 1024 / 1024).toFixed(1)} MB sha256=${result.sha256}`)
  } catch (error) {
    failed = true
    console.error(`[build-server] ${tag} FAILED: ${error.message}`)
  }
}
process.exit(failed ? 1 : 0)
