import { test, expect } from '@playwright/test'
import { login, openChat, users } from './helpers.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('mobile layout opens and closes a conversation without overflow', async ({ page }) => {
  await login(page, users.a)

  const sidebar = page.locator('.sidebar')
  await expect(sidebar).toBeVisible()
  await expect(page.locator('.app-shell')).not.toHaveClass(/mobile-chat-open/)

  await openChat(page, users.b.displayName)
  await expect(page.locator('.app-shell')).toHaveClass(/mobile-chat-open/)
  await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()

  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  expect(overflows).toBe(false)

  await page.getByRole('button', { name: 'Back to chats' }).click()
  await expect(page.locator('.app-shell')).not.toHaveClass(/mobile-chat-open/)
  await expect(sidebar).toBeVisible()
  await expect(page.getByLabel('Type a message')).toBeHidden()
})

test('mobile composer stays reachable above the viewport edge', async ({ page }) => {
  await login(page, users.a)
  await openChat(page, users.b.displayName)

  const composer = page.locator('.message-composer')
  await expect(composer).toBeVisible()
  const box = await composer.boundingBox()
  expect(box).not.toBeNull()
  expect(box.y + box.height).toBeLessThanOrEqual(844 + 1)
  await expect(page.getByLabel('Type a message')).toBeEditable()
})
