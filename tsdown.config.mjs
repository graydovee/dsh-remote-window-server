export default {
  entry: { protocol: 'src/protocol.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: false,
}
