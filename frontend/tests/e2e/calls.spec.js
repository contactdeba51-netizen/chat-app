import { test, expect } from '@playwright/test'
import { login, openChat, users } from './helpers.js'

async function signInBoth(browser) {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  await login(pageA, users.a)
  await login(pageB, users.b)
  await openChat(pageA, users.b.displayName)
  await openChat(pageB, users.a.displayName)
  // Calls are refused while the recipient is offline, so wait for presence.
  await expect(pageA.locator('.conversation-header .contact-details span')).toHaveText('online', { timeout: 20_000 })
  return { contextA, contextB, pageA, pageB }
}

test('an audio call connects in two real browser sessions', async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await signInBoth(browser)
  try {
    await pageA.getByRole('button', { name: 'Audio call', exact: true }).click()
    await expect(pageB.locator('.incoming-call')).toBeVisible({ timeout: 20_000 })
    await expect(pageB.locator('.incoming-call')).toContainText('Incoming audio call')
    await pageB.getByRole('button', { name: 'Accept', exact: true }).click()

    await expect(pageA.locator('.call-info span')).toHaveText('Connected', { timeout: 30_000 })
    await expect(pageB.locator('.call-info span')).toHaveText('Connected', { timeout: 30_000 })

    await pageA.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(pageA.locator('.call-screen')).toHaveCount(0)
    await expect(pageB.locator('.call-screen')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('a video call delivers camera frames to both sides', async ({ browser }) => {
  const { contextA, contextB, pageA, pageB } = await signInBoth(browser)
  try {
    await pageA.getByRole('button', { name: 'Video call', exact: true }).click()
    await expect(pageB.locator('.incoming-call')).toBeVisible({ timeout: 20_000 })
    await expect(pageB.locator('.incoming-call')).toContainText('Incoming video call')
    await pageB.getByRole('button', { name: 'Accept', exact: true }).click()

    await expect(pageA.locator('.call-info span')).toHaveText('Connected', { timeout: 30_000 })
    await expect(pageB.locator('.call-info span')).toHaveText('Connected', { timeout: 30_000 })

    // A fake camera still produces real frames, so videoWidth proves the track
    // reached the element rather than just the call UI rendering.
    await expect.poll(() => pageA.locator('video.local-video').evaluate((video) => video.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(() => pageB.locator('video.remote-video').evaluate((video) => video.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0)

    await pageB.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(pageA.locator('.call-screen')).toHaveCount(0, { timeout: 15_000 })
    await expect(pageB.locator('.call-screen')).toHaveCount(0)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
