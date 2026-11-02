import { test, expect } from '@playwright/test'

// A sleeping Render service answers its first request with a proxy 503, and a
// dropped connection makes fetch throw a TypeError. Both used to leave the user
// on a login screen that could never work until they reloaded by hand.
test('recovers when the API answers 503 while waking', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/auth/me', async (route) => {
    attempts += 1
    if (attempts === 1) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'service is starting' })
    return route.continue()
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 25_000 })
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('recovers when the first request fails at the network layer', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/auth/me', async (route) => {
    attempts += 1
    if (attempts === 1) return route.abort('failed')
    return route.continue()
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 25_000 })
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('a login form survives one failed connection attempt', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

  let attempts = 0
  await page.route('**/api/auth/login', async (route) => {
    attempts += 1
    if (attempts === 1) return route.abort('failed')
    return route.continue()
  })

  await page.getByRole('button', { name: 'Email', exact: true }).click()
  await page.locator('input[type="email"]').fill('nobody@example.com')
  await page.locator('input[type="password"]').fill('WrongPassword123!')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()

  // The retried request reaches the server and returns its real 401 message.
  await expect(page.getByText('Invalid phone number, email, or password.')).toBeVisible({ timeout: 25_000 })
  expect(attempts).toBeGreaterThanOrEqual(2)
})
