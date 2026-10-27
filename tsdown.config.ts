import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/skills.ts', 'src/doctor.ts', 'src/launcher.ts', 'src/setup.ts'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2022',
  fixedExtension: false, dts: false, clean: true,
  deps: { neverBundle: [/^@deepseek-ai/, /^@modelcontextprotocol/, /^node:/] },
})
