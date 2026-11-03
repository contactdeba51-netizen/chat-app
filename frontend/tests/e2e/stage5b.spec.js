import { test, expect } from '@playwright/test'

// Stage 5B drill: this test is deliberately false so CI proves a Playwright
// failure blocks deployment. It is temporary and must never be merged to main.
test('stage5b deliberate Playwright failure drill', async () => {
  expect(false, 'stage5b deliberate Playwright failure drill: this assertion is intentionally false').toBe(true)
})
