import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/rxjs.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['rxjs'],
});
