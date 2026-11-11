/**
 * tsdown build for the server plugin's **browser half**.
 *
 * One CJS closure factory registering through
 * `window.__ModuleLoader__.load({ id: 'dsh-remote-workspace-server', factory })`,
 * exactly like the client package's browser half. Only the platform module table
 * is external; everything else (including the shared `src/protocol.ts`) is
 * inlined, and the purity gate below rejects Node builtins and cross-plugin
 * value imports that cannot resolve inside the browser module table.
 */
import { builtinModules } from 'node:module'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Platform module table shared by the DSH web shell (React + official UI packages). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Bundle id registered with the shell's module loader. */
const PLUGIN_ID = 'dsh-remote-workspace-server'

export default {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // Browsers only: never inherit the host plugin's node target.
  target: 'es2022',
  dts: false,
  sourcemap: false,
  // The host plugin build runs first and owns `lib/`; never clean it away.
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    'import.meta.resolve': 'undefined',
  },
  inputOptions: {
    resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
  },
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [
    {
      name: 'dsh-client-bundle-purity',
      resolveId(source) {
        if (NODE_BUILTINS.has(source)) {
          throw new Error(`client bundle purity: Node builtin "${source}" cannot run in the browser module table`)
        }
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is neither a platform module nor an inline-safe wire layer — `
          + 'collaborate through cordis services instead of value imports',
        )
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}
