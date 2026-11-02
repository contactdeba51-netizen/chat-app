import { defineConfig } from '@playwright/test'

// Uses the system Chrome locally because the downloaded Chromium bundles are
// large and may be blocked on some networks. CI installs the pinned Chromium and
// leaves the channel unset. Install Chrome, or set PLAYWRIGHT_CHANNEL (chrome,
// msedge, or chromium) explicitly.
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.env.CI ? '' : 'chrome')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './tests/e2e/global-setup.js',
  globalTeardown: './tests/e2e/global-teardown.js',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    ...(channel ? { channel } : {}),
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      // Fake devices let a headless browser join a real WebRTC call.
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'node src/server.js',
      cwd: '../backend',
      url: 'http://localhost:5000/healthz',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ...process.env, LOGIN_RATE_LIMIT: '500' },
    },
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      cwd: '.',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
