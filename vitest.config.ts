import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    allowOnly: false,
    passWithNoTests: true,
    // Browser API stubs for jsdom component tests; a no-op under node.
    setupFiles: ['./src/test/dom-setup.ts'],
  },
});
