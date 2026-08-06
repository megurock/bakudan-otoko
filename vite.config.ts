import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/client",
  base: "./",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
  test: {
    include: ["../shared/**/*.test.ts"],
    environment: "node",
  },
});
