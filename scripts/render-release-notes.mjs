/**
 * Render the GitHub Release body for one server release.
 *
 * The body is generated, never hand-written, because the one thing users ask a
 * release page is "which DSH does this support?" — and that answer lives in the
 * client repo's `compat/runtimes.json`, which this workflow downloads as
 * `runtime-compat.json`. Hand-maintained notes drifted from the manifest before
 * (the release page said `0.2.1-rc.2` while the package required `0.2.1-rc.3`).
 *
 * Usage:
 *
 *   node scripts/render-release-notes.mjs \
 *     --compat runtime-compat.json --plugin 0.1.0-alpha.4 --dsh 0.2.1-rc.3 \
 *     --dist dist --out notes.md
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const compatPath = arg('compat', 'runtime-compat.json')
const plugin = arg('plugin', '')
const dsh = arg('dsh', '')
const dist = resolve(arg('dist', 'dist'))
const out = arg('out', 'notes.md')

if (plugin === '' || dsh === '') {
  console.error('[release-notes] --plugin and --dsh are required')
  process.exit(2)
}

const compat = JSON.parse(readFileSync(compatPath, 'utf8'))
if (compat.plugin !== plugin) {
  console.error(`[release-notes] snapshot is for plugin ${compat.plugin}, this release is ${plugin}`)
  process.exit(1)
}

/** Platform tags this repository can build today (POSIX builders only). */
const BUILDABLE = new Set(['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64'])

const entry = compat.runtimes.find(candidate => candidate.dsh === dsh)
const published = (entry?.platforms ?? []).filter(platform => BUILDABLE.has(platform))
const missing = (entry?.platforms ?? []).filter(platform => !BUILDABLE.has(platform))

const files = []
for (const name of readdirSync(dist).sort()) {
  if (!name.endsWith('.tar.gz') && !name.endsWith('.tgz')) continue
  const path = join(dist, name)
  const bytes = readFileSync(path)
  files.push({
    name,
    size: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

const interval = compat.dsh.min === compat.dsh.max ? compat.dsh.min : `${compat.dsh.min} … ${compat.dsh.max}`
const lines = [
  `Server package **${plugin}** for DSH **${dsh}**.`,
  '',
  `## Runtime compatibility`,
  '',
  `This build supports DSH **${interval}** (both ends inclusive). That interval is declared in the client`,
  `repository (\`compat/runtimes.json\`) and the assets below were built for it; it is not derived from the`,
  `plugin version. Plugin versions and DSH versions do not move together.`,
  '',
  `| DSH release | Platforms with a published runtime | Not published yet |`,
  `| --- | --- | --- |`,
  `| ${dsh} | ${published.length === 0 ? '—' : published.join(', ')} | ${missing.length === 0 ? '—' : missing.join(', ')} |`,
  '',
  'A platform listed as *not published yet* is supported by the plugin but has no downloadable runtime:',
  'on a POSIX client host the client builds the same `node/` + `dsh/` layout locally, and a Windows target',
  'needs a pre-seeded artifact (`DSH_RW_RUNTIME_ARTIFACT`).',
  '',
  `## Assets`,
  '',
  '| File | Size | SHA-256 |',
  '| --- | --- | --- |',
  ...files.map(file => `| \`${file.name}\` | ${(file.size / (1024 * 1024)).toFixed(1)} MiB | \`${file.sha256}\` |`),
  '',
  '`runtime-compat.json` is the snapshot this release was built from; clients and tooling can read it to',
  'resolve which runtime a given plugin version needs.',
  '',
]

writeFileSync(out, lines.join('\n'))
console.log(`[release-notes] wrote ${out} (${files.length} asset(s), dsh ${interval})`)
