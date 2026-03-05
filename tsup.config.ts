import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node"
  }
});
