import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [".build/**", "ui/e2e/**"],
  },
});
