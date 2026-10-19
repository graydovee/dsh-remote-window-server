/**
 * Server-package staging: turn `@deepseek-ai/dsh@<version>` into one
 * self-contained tarball for a target platform.
 *
 * Shared by the connect flow (`assets.buildDshRuntimePackage`, host-local
 * staging as an offline fallback) and the release build script
 * (`scripts/build-server-package.mjs`, CI matrix). One implementation, so the
 * CI artifact and the locally staged one cannot drift.
 *
 * Native-module closure is the load-bearing part: packages like
 * `node-addon-require-builtin` resolve their binding through *sibling* npm
 * packages named `<name>-<platform>-<arch>[-gnu|msvc]`, which a plain install
 * resolves for the **host** platform (a Mac staging for linux gets darwin
 * bindings — the round-4 failure). We therefore explicitly install the
 * target-platform sibling at the same version and strip foreign-platform
 * siblings, then assert the result.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** npm registries, tried in order: CN mirror first. */
export const STAGE_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/** Pure-JS postinstall scripts allowed during staging; native builds excluded
 *  (a cross-OS build would only produce host binaries, and the remote world
 *  does not require a pty provider). */
const BUILD_ALLOWLIST = ['@google/genai', 'protobufjs', 'koffi']

/** Run a local command as a promise with a byte ceiling. */
export function execLocal(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error != null) {
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
        return
      }
      resolve({ code: 0, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

/**
 * The staged dsh package's own bin entry (a JS file).
 *
 * Resolved from the package manifest rather than `<stage>/node_modules/.bin/dsh`
 * because that shim is a **shell** script: `node .bin/dsh` cannot parse it, and
 * the old POSIX-only probe also hard-coded `/usr/bin/env`, which does not exist
 * on Windows — a Windows host must be able to stage packages for WSL targets.
 * @param stage - the staging directory.
 * @returns the absolute bin script path, or undefined when the package is absent.
 */
async function resolveDshBin(stage: string): Promise<string | undefined> {
  const manifestPath = join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  let manifest: { bin?: string | Record<string, string> } | undefined
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
  } catch {
    return undefined
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string' || bin === '') return undefined
  const script = join(dirname(manifestPath), bin)
  return await stat(script).then(entry => entry.isFile() ? script : undefined, () => undefined)
}

/** The `<platform>-<arch>[-libc]` artifact tag. */
export function artifactTag(platform: 'linux' | 'darwin', arch: 'x64' | 'arm64', libc: '' | 'gnu' | 'musl'): string {
  return libc === '' ? `${platform}-${arch}` : `${platform}-${arch}-${libc}`
}

/** The server-package artifact name for one target. */
export function artifactName(version: string, tag: string): string {
  return `dsh-remote-server-${version}-${tag}.tar.gz`
}

/**
 * The sibling-package suffix that `node-addon-require-builtin` resolves for a
 * target. glibc/musl only exists on linux.
 */
export function bindingPackageSuffix(platform: 'linux' | 'darwin', arch: 'x64' | 'arm64', libc: '' | 'gnu' | 'musl'): string {
  const base = `${platform}-${arch}`
  return platform === 'linux' && libc !== '' ? `${base}-${libc}` : base
}

/** Binding families that ship one sibling package per platform flavour.
 *  `require-builtin` is required on the target; `system` (and any future
 *  family) is stripped when foreign so shipped trees are target-only. */
export const BINDING_FAMILIES = ['node-addon-require-builtin', 'node-addon-system']

const PLATFORM_FLAVOURS = ['darwin', 'linux', 'win32']

/** Split one `.pnpm` entry into a known binding family + flavour, if it is one. */
export function bindingOf(dirName: string): { family: string; flavour: string } | undefined {
  // Scoped names arrive as `@deepseek-ai+node-addon-system-darwin-arm64@0.1.2`.
  const withoutVersion = dirName.replace(/@[^@]+$/, '')
  for (const family of BINDING_FAMILIES) {
    const index = withoutVersion.lastIndexOf(family)
    if (index < 0) continue
    const flavour = withoutVersion.slice(index + family.length + 1)
    if (PLATFORM_FLAVOURS.some(platform => flavour === platform || flavour.startsWith(`${platform}-`))) {
      return { family, flavour }
    }
  }
  return undefined
}

/** Whether one `.pnpm` directory name belongs to a foreign-platform binding. */
/**
 * The flavour one binding family must carry for one target.
 *
 * `node-addon-require-builtin` publishes `-<libc>` flavours
 * (`linux-x64-gnu`); `node-addon-system` publishes plain `<platform>-<arch>`
 * (`linux-x64`) and has no win32 build at all. Comparing the system family
 * against the require-builtin suffix made every freshly installed system sibling
 * look foreign, so the staging step deleted the binding it had just added.
 */
function targetFlavour(family: string, suffix: string): string {
  return family === 'node-addon-require-builtin' ? suffix : suffix.split('-').slice(0, 2).join('-')
}

/** Whether one `.pnpm` entry is a native binding for some *other* flavour. */
export function isForeignBindingDir(dirName: string, suffix: string): boolean {
  const binding = bindingOf(dirName)
  if (binding === undefined) return false
  return binding.flavour !== targetFlavour(binding.family, suffix)
}

/**
 * Stage `@deepseek-ai/dsh@<version>` for one target platform into `stage`.
 * @returns the installed dsh version (from the launcher probe).
 */
export async function stageDshPackage(options: {
  stage: string
  version: string
  platform: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  libc: '' | 'gnu' | 'musl'
  nodeBin: string
  pnpmCjs: string
  onProgress?: (message: string, detail?: string) => void
}): Promise<string> {
  const notify = options.onProgress ?? (() => {})
  await mkdir(options.stage, { recursive: true })
  await writeFile(join(options.stage, 'package.json'), `${JSON.stringify({
    name: 'dsh-remote-server',
    private: true,
    pnpm: { onlyBuiltDependencies: BUILD_ALLOWLIST },
  }, null, 2)}\n`)
  const failures: string[] = []
  for (const registry of STAGE_REGISTRIES) {
    await writeFile(join(options.stage, '.npmrc'), [
      `registry=${registry}`,
      `supported-architectures[]=os=${options.platform}`,
      `supported-architectures[]=cpu=${options.arch}`,
      ...(options.platform === 'linux' && options.libc !== '' ? [`supported-architectures[]=libc=${options.libc}`] : []),
      '',
    ].join('\n'))
    notify(`staging @deepseek-ai/dsh@${options.version} via pnpm (${registry.replace('https://', '')}, target ${options.platform}-${options.arch}${options.libc === '' ? '' : `-${options.libc}`})`)
    const add = await execLocal(options.nodeBin, [options.pnpmCjs, '-C', options.stage, 'add', `@deepseek-ai/dsh@${options.version}`, '--loglevel=warn'], 600_000)
    // Probe the package's own bin entry, not `<stage>/node_modules/.bin/dsh`:
    // that shim is a POSIX shell script, so `node .bin/dsh` cannot parse it and
    // `/usr/bin/env` does not exist on Windows at all. Staging must work on a
    // Windows host because WSL targets are Windows-only.
    const launcher = await resolveDshBin(options.stage)
    if (launcher === undefined) {
      failures.push(`${registry}: pnpm produced no dsh launcher: ${(add.stderr || add.stdout || `exit ${add.code}`).trim().slice(-300)}`)
      continue
    }
    await fixNativeClosure({ stage: options.stage, platform: options.platform, arch: options.arch, libc: options.libc, nodeBin: options.nodeBin, pnpmCjs: options.pnpmCjs, onProgress: notify })
    const probe = await execLocal(options.nodeBin, [launcher, '--version'], 120_000)
    const version = probe.stdout.trim().split('\n')[0] ?? ''
    if (probe.code !== 0 || version === '') {
      failures.push(`${registry}: launcher probe failed: ${(probe.stderr || probe.stdout || `exit ${probe.code}`).trim().slice(-300)}`)
      continue
    }
    return version
  }
  throw new Error(`could not stage @deepseek-ai/dsh@${options.version}; attempts: ${failures.join(' ;; ')}`)
}

/**
 * Install the target-platform native binding siblings and remove the
 * host-platform ones the installer resolved by mistake.
 */
export async function fixNativeClosure(options: {
  stage: string
  platform: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  libc: '' | 'gnu' | 'musl'
  nodeBin: string
  pnpmCjs: string
  onProgress?: (message: string, detail?: string) => void
}): Promise<void> {
  const notify = options.onProgress ?? (() => {})
  const pnpmDir = join(options.stage, 'node_modules', '.pnpm')
  const suffix = bindingPackageSuffix(options.platform, options.arch, options.libc)
  const plainSuffix = `${options.platform}-${options.arch}`

  /**
   * Native packages whose platform sibling must be installed for the *target*.
   *
   * `node-addon-require-builtin` is the PTC/`import.meta.main` addon and carries
   * `-<libc>`; `@deepseek-ai/node-addon-system` is the flock/file-lock addon and
   * publishes plain `<platform>-<arch>` siblings — and **no win32 build at all**,
   * so a Windows-hosted staging run installs none of them and the deployed server
   * dies the first time the session store takes a lock:
   * `Cannot find module '@deepseek-ai/node-addon-system-linux-x64/package.json'`.
   */
  const families: readonly { readonly main: RegExp; readonly target: string }[] = [
    { main: /^node-addon-require-builtin(?:-.+)?@(\d[^/]*)$/, target: `node-addon-require-builtin-${suffix}` },
    { main: /^@deepseek-ai\+node-addon-system@(\d[^/]*)$/, target: `@deepseek-ai/node-addon-system-${plainSuffix}` },
  ]

  for (const family of families) {
    const entries = await readdir(pnpmDir).catch(() => [])
    let version = ''
    for (const entry of entries) {
      const match = family.main.exec(entry)
      if (match !== null) {
        version = match[1] ?? ''
        break
      }
    }
    if (version === '') continue
    const flatName = family.target.replace('/', '+')
    if (entries.some(entry => entry.startsWith(`${flatName}@`))) continue
    notify(`adding native binding ${family.target}@${version}`)
    const add = await execLocal(options.nodeBin, [options.pnpmCjs, '-C', options.stage, 'add', `${family.target}@${version}`, '--loglevel=warn', '--save-optional=false'], 600_000)
    if (add.code !== 0 && add.stdout === '' && add.stderr !== '') {
      // pnpm may exit nonzero for lockfile notes; only a missing launcher
      // directory matters — re-checked below by the caller's probe.
      notify(`binding install warning`, (add.stderr || add.stdout).slice(-300))
    }
  }
  // Strip foreign-platform siblings so the shipped tree is target-only.
  for (const entry of await readdir(pnpmDir).catch(() => [])) {
    if (isForeignBindingDir(entry, suffix)) {
      notify(`removing foreign native binding ${entry}`)
      await rm(join(pnpmDir, entry), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Whether one `.pnpm` entry is a foreign `node-addon-system` platform sibling. */
function isForeignSystemBinding(entry: string, plainSuffix: string): boolean {
  const match = /^@deepseek-ai\+node-addon-system-(.+?)@/.exec(entry)
  return match !== null && match[1] !== plainSuffix
}

/**
 * Assert the staged tree is target-only: every shipped native binding dir
 * must match the target flavour. Throws with the offending names otherwise.
 */
export async function assertTargetOnly(stage: string, platform: 'linux' | 'darwin', arch: 'x64' | 'arm64', libc: '' | 'gnu' | 'musl'): Promise<void> {
  const suffix = bindingPackageSuffix(platform, arch, libc)
  const plainSuffix = `${platform}-${arch}`
  const pnpmDir = join(stage, 'node_modules', '.pnpm')
  const entries = await readdir(pnpmDir).catch(() => [])
  const foreign = entries.filter(entry => isForeignBindingDir(entry, suffix))
  if (foreign.length > 0) {
    throw new Error(`staged package contains foreign native bindings for ${platform}-${arch}${libc === '' ? '' : `-${libc}`}: ${foreign.join(', ')}`)
  }
  const required = entries.some(entry => entry.startsWith(`node-addon-require-builtin-${suffix}@`))
  if (!required) {
    throw new Error(`staged package is missing the native binding node-addon-require-builtin-${suffix}`)
  }
  // The signed session store locks files through this addon; a package staged on
  // a host that has no sibling for the target (Windows ships none) must fail
  // here instead of on the remote at the first session write.
  const hasSystemAddon = entries.some(entry => entry.startsWith('@deepseek-ai+node-addon-system@'))
  if (hasSystemAddon && !entries.some(entry => entry.startsWith(`@deepseek-ai+node-addon-system-${plainSuffix}@`))) {
    throw new Error(`staged package is missing the native binding @deepseek-ai/node-addon-system-${plainSuffix}`)
  }
}

/**
 * A usable `tar` for packing the staged tree.
 *
 * `/usr/bin/tar` is the POSIX default, but this build also has to run on a
 * **Windows** host — WSL targets are Windows-only, so their server package is
 * staged here too. Windows 10+ ships bsdtar as `tar.exe` on PATH, and it accepts
 * the same `-czf … -C … .` invocation; without this fallback every Windows
 * build died with ENOENT on `/usr/bin/tar`.
 */
function tarExecutable(): string {
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar'
}

/**
 * How long one `tar` pass may take.
 *
 * Measured on a Windows host (bsdtar, alpha51): packing the staged dsh tree —
 * ~31k entries, ~144 MB — needs **5–6 minutes**, and the old 300 s cap killed
 * tar mid-stream. Because the archive used to be written *in place*, the result
 * was a 135,659,520-byte `.tar.gz` that looked like an artifact but answered
 * `tar -tzf: Truncated input file`, with empty stderr and no `.sha256` /
 * `.manifest.json` next to it. 15 minutes keeps headroom for a slow disk while
 * still bounding a hang.
 */
export const PACK_TIMEOUT_MS = 900_000

/** One finished `tar` run, as {@link packStage} needs to see it. */
export interface TarRunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/**
 * How one `tar` invocation is executed.
 *
 * Injectable so {@link packStage}'s guarantees — pack into `.partial`, publish by
 * rename, never leave a half-written archive at the final name — are unit-tested
 * without a real `tar` and without waiting out a timeout.
 */
export type TarRunner = (options: {
  readonly executable: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
}) => Promise<TarRunResult>

/** The production runner: `execFile` with {@link PACK_TIMEOUT_MS}. */
function runTar(options: { executable: string; args: readonly string[]; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<TarRunResult> {
  type ExecFailure = Error & { code?: number | string; signal?: NodeJS.Signals | null }
  return new Promise<TarRunResult>((resolve) => {
    execFile(options.executable, [...options.args], { env: options.env, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      const failure = error as ExecFailure | null
      resolve({
        // A timeout kills tar, so `code` stays null and `signal` is what tells the
        // reason apart from a plain non-zero exit.
        code: failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null,
        signal: failure?.signal ?? null,
        stderr: stderr?.toString() ?? '',
      })
    })
  })
}

/**
 * Pack one staged tree into `outFile` (macOS AppleDouble files excluded).
 *
 * Two measured constraints:
 *
 * 1. **Pack into a per-run `<outFile>.<pid>-<rand>.partial`, publish with
 *    `rename`.** A killed tar must not leave bytes at the final name:
 *    `assets.cachedAssetIfReady` trusts file-size + the `.ready` digest and a
 *    release upload trusts the file name, so a truncated archive at the final
 *    path is a *silent* bad deployment. A failed run therefore leaves the
 *    previous artifact untouched and removes only its own partial. The suffix is
 *    unique per run because two connects can resolve the same artifact at the
 *    same time (`assets.resolveServerPackage`): with a fixed `.partial` name each
 *    would delete the other's in-progress archive. A crashed run can leave one
 *    such file behind; it is never published, and `assets.pruneCache` reaps it.
 * 2. **Name the reason on failure.** A timeout kills tar with empty stderr,
 *    which is why the alpha51 failure read `tar failed: ` and had to be
 *    diagnosed by measuring the output file. The signal and the pack budget are
 *    now part of the message.
 * @param stage - absolute path of the staged package tree.
 * @param outFile - absolute path of the final archive.
 * @param runner - tar invoker; tests inject a scripted one.
 */
export async function packStage(stage: string, outFile: string, runner: TarRunner = runTar): Promise<void> {
  const partial = `${outFile}.${process.pid}-${randomUUID().slice(0, 8)}.partial`
  let result: TarRunResult
  try {
    result = await runner({
      executable: tarExecutable(),
      args: ['-czf', partial, '-C', stage, '.'],
      timeoutMs: PACK_TIMEOUT_MS,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {})
    throw error
  }
  if (result.code !== 0) {
    await rm(partial, { force: true }).catch(() => {})
    const detail = result.stderr.trim()
    const cause = result.signal === null
      ? `exit ${result.code === null ? 'unknown' : String(result.code)}`
      : `signal ${result.signal}`
    throw new Error(`tar failed (${cause}; pack budget ${PACK_TIMEOUT_MS} ms): ${detail !== '' ? detail : 'no stderr output'}`)
  }
  // `rename` replaces an existing artifact atomically on POSIX and on Windows
  // (Node maps it to MoveFileEx with MOVEFILE_REPLACE_EXISTING).
  await rename(partial, outFile)
}

/** CLI entry for the release build script (see scripts/build-server-package.mjs). */
export async function buildServerPackage(options: {
  version: string
  platform: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  libc: '' | 'gnu' | 'musl'
  outDir: string
  nodeBin: string
  pnpmCjs: string
  onProgress?: (message: string, detail?: string) => void
}): Promise<{ file: string; sha256: string; size: number; manifest: Record<string, string | number> }> {
  const { createHash } = await import('node:crypto')
  const stage = join(options.outDir, `stage-${randomUUID().slice(0, 8)}`)
  try {
    const dshVersion = await stageDshPackage({ ...options, stage })
    await assertTargetOnly(stage, options.platform, options.arch, options.libc)
    const tag = artifactTag(options.platform, options.arch, options.libc)
    const file = join(options.outDir, artifactName(dshVersion, tag))
    await packStage(stage, file)
    const info = await stat(file)
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex')
    const manifest = {
      dshVersion,
      platformArch: artifactTag(options.platform, options.arch, options.libc),
      sha256,
      size: info.size,
      minNode: 'v24.21.0',
    }
    await writeFile(`${file}.sha256`, `${sha256}  ${file.split('/').pop()}\n`)
    await writeFile(join(options.outDir, artifactName(dshVersion, tag).replace(/\.tar\.gz$/, '.manifest.json')), `${JSON.stringify(manifest, null, 2)}\n`)
    return { file, sha256, size: info.size, manifest }
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}
