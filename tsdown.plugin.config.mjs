/** Build the v1 Cordis profile plugin.
 *
 * Official packages come from the profile runtime, except the ones the server
 * install does not ship: `dsh-ssh` (execution-world helper protocol/schemas)
 * and `dsh-subprocess-local/output`. Those, plus `zod`, are inlined so the
 * tarball stays self-contained for the offline profile installer.
 */
export default {
  entry: { plugin: 'src/server-plugin/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  deps: {
    neverBundle: id => id.startsWith('@deepseek-ai/')
      && !id.startsWith('@deepseek-ai/dsh-ssh')
      && !id.startsWith('@deepseek-ai/dsh-subprocess-local'),
    alwaysBundle: id => id.startsWith('@deepseek-ai/dsh-ssh')
      || id.startsWith('@deepseek-ai/dsh-subprocess-local')
      || id === 'zod',
  },
}
