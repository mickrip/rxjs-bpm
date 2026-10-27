import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	server: {
		port: 5174,
		// The lab imports the tracker straight from ../src, so Vite must be allowed
		// to serve files from outside its own root.
		fs: { allow: [".."] },
	},
	build: {
		outDir: "../dist-lab",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
				follow: resolve(__dirname, "follow.html"),
			},
		},
	},
});
