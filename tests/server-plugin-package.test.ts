import { readFileSync } from 'node:fs'
import { inject } from '../src/server-plugin/index.ts'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('installable server plugin package contract', () => {
  it('exposes the v1 plugin entry and keeps the DSH runtime pinned', () => {
    const manifest = JSON.parse(read('../package.json')) as {
      name: string
      version: string
      main: string
      exports: Record<string, unknown>
      engines: { dsh: string }
      peerDependencies?: Record<string, string>
      dsh: { bundle: { patch: string }; client?: { inject: string[]; platform: string } }
      files: string[]
      scripts: Record<string, string>
    }
    expect(manifest.name).toBe('dsh-remote-workspace-server')
    expect(manifest.main).toBe('lib/plugin.js')
    expect(manifest.exports['.']).toBe('./lib/plugin.js')
    // The plugin accepts the whole verified interval; the client picks an exact
    // runtime inside it, so the manifest must not pin one release.
    expect(manifest.engines.dsh).toBe('>=0.2.1-rc.2 <=0.2.2-rc.1')
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (/^@deepseek-ai\/dsh(-|$)/u.test(name)) expect(range, name).toBe('>=0.2.1-rc.2 <=0.2.2-rc.1')
    }
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    // The browser half ships in the same `lib/` directory and is published
    // through its own export so the shell's module loader can resolve it.
    expect(manifest.files).toContain('lib')
    expect(manifest.exports['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    })
    expect(manifest.dsh.client).toEqual({
      inject: ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
      platform: 'web',
    })
    // Both the host plugin and the browser half are rebuilt by `prepare`/`build`.
    expect(manifest.scripts['build']).toContain('tsdown.client.config.mjs')
    expect(manifest.scripts['prepare']).toContain('tsdown.client.config.mjs')
  })

  it('registers the browser half as a slot contribution bundle', () => {
    const clientConfig = read('../tsdown.client.config.mjs')
    expect(clientConfig).toContain("entry: { client: 'src/client/index.tsx' }")
    expect(clientConfig).toContain('format: \'cjs\'')
    expect(clientConfig).toContain('platform: \'browser\'')
    expect(clientConfig).toContain("const PLUGIN_ID = 'dsh-remote-workspace-server'")
    expect(clientConfig).toContain('window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {')
    expect(clientConfig).toContain("footer: 'return module.exports; } });'")
    expect(clientConfig).toContain('dsh-client-bundle-purity')
  })

  it('injects the execution-world providers used by the mux controller', () => {
    expect(inject).toEqual(['webServer', 'connection', 'fs', 'subprocess', 'sandbox', 'sessionPersistence'])
    expect(inject).not.toContain('sessionController')
  })

  it('patch inserts exactly one v1 plugin row', () => {
    const patch = read('../cordis.patch.yml')
    expect(patch).toContain('id: dsh-remote-workspace-server')
    expect(patch).toContain('name: dsh-remote-workspace-server')
    expect((patch.match(/id: dsh-remote-workspace-server/g) ?? []).length).toBe(1)
  })
})
