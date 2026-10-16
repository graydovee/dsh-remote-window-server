const SERVER_EXTERNAL = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']
export default {
  entry: { server: 'src/server/index.ts', protocol: 'src/protocol.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: false,
  external: SERVER_EXTERNAL,
  noExternal: id => SERVER_EXTERNAL.includes(id) ? undefined : true,
}
