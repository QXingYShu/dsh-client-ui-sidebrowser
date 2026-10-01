/**
 * A manual smoke test for the Host half against a real Chrome.
 *
 * It launches the driver, opens a page, extracts text and an inventory, clicks a
 * link and confirms the navigation, types, presses a key, scrolls, captures a
 * downscaled screenshot, and checks that the screenshot stream's change
 * detection reports the second poll as unchanged.
 *
 * It is deliberately NOT part of the unit suite: it needs a real browser and
 * takes real time. It exists so a maintainer can verify the whole CDP path by
 * hand after changing the driver.
 *
 * Run it through the bundler, because Node's type-stripping mode rejects the
 * TypeScript parameter properties the Host sources use:
 *
 *   node node_modules/tsdown/dist/run.mjs --config .tsdown.smoke.config.ts
 *   node .smoke/smoke-driver.mjs https://example.com/
 *
 * Usage: smoke-driver [url]
 */
import { BrowserDriver } from '../src/browser/driver.ts'
import { ScreenshotStream } from '../src/browser/screenshot-stream.ts'

const url = process.argv[2] ?? 'https://example.com/'
const driver = new BrowserDriver({ headless: true })
try {
  const tab = await driver.open(url)
  console.log('opened', tab.id, tab.url)
  const snapshot = await driver.snapshot()
  console.log('title:', snapshot.title)
  console.log('url:', snapshot.url)
  const text = await driver.extractText({ maxChars: 400, includeInventory: true })
  console.log('text:', JSON.stringify(text.text.slice(0, 120)))
  console.log('inventory headings:', text.inventory?.headings.length ?? 0, 'links:', text.inventory?.links.length ?? 0)

  // Click the single link on the page and confirm we actually navigated.
  const link = text.inventory?.links[0]
  if (link !== undefined) {
    await driver.click({ selector: `a[href="${link.href}"]`, tabId: tab.id })
    await driver.pressKey('Enter', tab.id)
    await new Promise(resolve => { setTimeout(resolve, 1500) })
    const after = await driver.snapshot(tab.id)
    console.log('after click url:', after.url)
  } else {
    console.log('after click: no link to click')
  }

  await driver.typeText('hello from dsh-sidebrowser', undefined, tab.id)
  await driver.pressKey('Enter', tab.id)
  console.log('typed and pressed Enter')
  await driver.scroll(400, tab.id)
  console.log('scrolled')

  const shot = await driver.captureScreenshot(false, tab.id, 0.5)
  console.log('screenshot base64 length:', shot.length)

  const stream = new ScreenshotStream(driver, { scale: 0.5 })
  const first = await stream.poll()
  const second = await stream.poll()
  console.log('poll 1 changed:', first.changed, 'poll 2 changed:', second.changed)
  stream.dispose()

  const tabs = await driver.listTabs()
  console.log('tabs:', tabs.map(t => `${t.id}:${t.title}`).join(', '))
} finally {
  await driver.dispose()
}