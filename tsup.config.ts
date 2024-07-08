import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'], // Change this to the entry point of your library
  format: ['cjs', 'esm'],  // Output formats
  dts: true,  // Generate type declaration files
  sourcemap: true, // Optional: generate source maps
  clean: true  // Clean the output directory before each build
});