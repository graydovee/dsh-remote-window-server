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
      dsh: { bundle: { patch: string } }
      files: string[]
    }
    expect(manifest.name).toBe('dsh-remote-window-server')
    expect(manifest.main).toBe('lib/plugin.js')
    expect(manifest.exports['.']).toBe('./lib/plugin.js')
    expect(manifest.engines.dsh).toBe('0.2.1-rc.3')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('injects the execution-world providers used by the mux controller', () => {
    expect(inject).toEqual(['webServer', 'connection', 'fs', 'subprocess', 'sandbox', 'sessionPersistence'])
    expect(inject).not.toContain('sessionController')
  })

  it('patch inserts exactly one v1 plugin row', () => {
    const patch = read('../cordis.patch.yml')
    expect(patch).toContain('id: dsh-remote-window-server')
    expect(patch).toContain('name: dsh-remote-window-server')
    expect((patch.match(/id: dsh-remote-window-server/g) ?? []).length).toBe(1)
  })
})
