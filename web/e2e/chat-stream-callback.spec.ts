import { expect, test, type Page } from '@playwright/test'

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

async function replaceCallback(page: Page, version: string): Promise<void> {
  await page.evaluate(value => {
    window.dispatchEvent(new CustomEvent('replace-chat-callback', { detail: value }))
  }, version)
  await expect(page.getByTestId('callback-version')).toHaveText(version)
}

test('active catchup and send streams call the latest state callback without restarting catchup', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('possibility_token', 'e2e-token'))
  await page.route('**/__e2e/chat-stream-callback', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module">import { mountChatStreamCallbackHarness } from "/e2e/fixtures/chat-stream-callback-harness.tsx"; mountChatStreamCallbackHarness(document.getElementById("root"));</script></body></html>',
  }))

  let catchupRequests = 0
  let releaseCatchup!: () => void
  const catchupGate = new Promise<void>(resolve => { releaseCatchup = resolve })
  await page.route('**/api/conversations/conversation-1/catchup', async route => {
    catchupRequests += 1
    await catchupGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: frame({ type: 'state', state: { simTime: '2026-10-01T00:00:00.000Z', location: 'home', activity: 'resting', mood: 'calm', goal: 'catchup-state' } }) + frame({ type: 'done' }),
    })
  })

  let historyRequests = 0
  let sendRequests = 0
  let sendRequestId = ''
  let releaseSend!: () => void
  const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
  await page.route('**/api/conversations/conversation-1/messages', async route => {
    if (route.request().method() === 'POST') {
      sendRequests += 1
      sendRequestId = (route.request().postDataJSON() as { requestId: string }).requestId
      await sendGate
      await route.fulfill({
        contentType: 'text/event-stream',
        body: frame({ type: 'state', state: { simTime: '2026-10-01T00:00:00.000Z', location: 'home', activity: 'resting', mood: 'calm', goal: 'send-state' } }) + frame({ type: 'done', requestId: sendRequestId }),
      })
      return
    }
    historyRequests += 1
    await route.fulfill({ json: { messages: [] } })
  })
  await page.route('**/api/conversations/conversation-1/requests/**', route => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ json: path.endsWith('/pending') ? { requests: [] } : { status: 'completed', errorCode: null } })
  })

  await page.goto('/__e2e/chat-stream-callback')
  await expect.poll(() => catchupRequests).toBe(1)
  await replaceCallback(page, 'catchup-current')
  expect(catchupRequests).toBe(1)
  expect(historyRequests).toBe(0)
  releaseCatchup()

  await expect(page.getByTestId('callback-results')).toContainText('catchup-current:catchup-state')
  await expect.poll(() => historyRequests).toBe(1)
  const input = page.getByPlaceholder('说点什么…')
  await expect(input).toBeEnabled()
  await input.fill('hello')
  await input.press('Enter')
  await expect.poll(() => sendRequests).toBe(1)

  await replaceCallback(page, 'send-current')
  expect(catchupRequests).toBe(1)
  expect(historyRequests).toBe(1)
  releaseSend()

  await expect(page.getByTestId('callback-results')).toContainText('send-current:send-state')
  await expect.poll(() => historyRequests).toBe(2)
  expect(sendRequests).toBe(1)
})
