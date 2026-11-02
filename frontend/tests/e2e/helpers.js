import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(path.join(here, '.users.json'), 'utf8'))

export const password = fixture.password
export const users = fixture.users

// Signs in through the real form, by email, so each browser context gets its own
// sessionStorage token and cookie exactly like a separate person would.
export async function login(page, user) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Email', exact: true }).click()
  await page.locator('input[type="email"]').fill(user.email)
  await page.locator('input[type="password"]').fill(fixture.password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ timeout: 20_000 })
}

export async function openChat(page, name) {
  await page.locator('.chat-row').filter({ hasText: name }).first().click()
  await page.getByLabel('Type a message').waitFor()
}

export function uniqueMessage(label) {
  return `${label} ${Date.now()}-${Math.floor(Math.random() * 1000)}`
}
