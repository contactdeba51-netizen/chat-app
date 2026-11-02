import { test, expect } from '@playwright/test'
import { login, openChat, users, uniqueMessage } from './helpers.js'

test('two independent sessions exchange messages live', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  try {
    await login(pageA, users.a)
    await login(pageB, users.b)
    await openChat(pageA, users.b.displayName)
    await openChat(pageB, users.a.displayName)

    const first = uniqueMessage('Hello from Alice')
    await pageA.getByLabel('Type a message').fill(first)
    await pageA.getByRole('button', { name: 'Send message' }).click()
    await expect(pageB.locator('.message.incoming').filter({ hasText: first })).toBeVisible({ timeout: 15_000 })

    const reply = uniqueMessage('Reply from Bob')
    await pageB.getByLabel('Type a message').fill(reply)
    await pageB.getByRole('button', { name: 'Send message' }).click()
    await expect(pageA.locator('.message.incoming').filter({ hasText: reply })).toBeVisible({ timeout: 15_000 })

    // Each context has its own bearer token; no shared localStorage identity.
    const tokenA = await pageA.evaluate(() => sessionStorage.getItem('chat-access-token'))
    const tokenB = await pageB.evaluate(() => sessionStorage.getItem('chat-access-token'))
    expect(tokenA).toBeTruthy()
    expect(tokenB).toBeTruthy()
    expect(tokenA).not.toBe(tokenB)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('a session stays signed in after a reload', async ({ page }) => {
  await login(page, users.a)
  await page.reload()
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ timeout: 20_000 })
  await expect(page.locator('.chat-row').filter({ hasText: users.b.displayName })).toBeVisible()
})
