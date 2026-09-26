import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "bb") } },
  test: {
    environment: "jsdom",
    include: ["bb/**/*.test.tsx"],
    setupFiles: ["bb/test-setup.ts"],
  },
});
