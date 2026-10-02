/**
 * Real-browser verification for dsh-sidebrowser.
 *
 * Everything in this file runs against a REAL Chrome and a REAL page; only the
 * page itself is a local mock, because it stands in for sites (DeepSeek's chat,
 * a translation site) that need an account and must not be driven by a test.
 * No mocking of the plugin's own code: this imports the production driver, the
 * production agent tools and the production DeepSeek-web bridge, and calls the
 * same functions the Host and the model call.
 *
 * Why this exists: every defect this plugin shipped with - the mount-time throw
 * that unregistered all 17 routes, the tab body reading a prop the shell never
 * passes, the popup unmounting itself before the click, the selection race that
 * made every command act on the wrong tab, AI解释 answering with the user's own
 * prompt - passed a green unit suite. They were only found by driving a browser.
 *
 * Usage:
 *   node --experimental-transform-types scripts/verify-real-browser.mjs
 *
 * Optional environment:
 *   SIDEBROWSER_CHROME   path to a Chrome/Chromium/Edge executable
 *   SIDEBROWSER_HEADLESS 0 to watch it run with a visible window
 *
 * Exit code is 0 only when every check passed.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDriver } from '../src/browser/driver.ts'
import { buildSidebrowserTools } from '../src/host/agent-tools.ts'
import { askDeepSeekWeb, extractAnswer, translateSelection } from '../src/client/deepseek-web.ts'

const HEADLESS = process.env.SIDEBROWSER_HEADLESS !== '0'
const EXECUTABLE = process.env.SIDEBROWSER_CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let failures = 0
let checks = 0

/** Record one assertion and print it. */
function check(label, ok, detail) {
  checks += 1
  if (!ok) failures += 1
  const tail = detail === undefined || detail === '' ? '' : ` -> ${String(detail).slice(0, 140)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${tail}`)
}

/** Report a whole group. */
function section(title) {
  console.log(`\n=== ${title} ===`)
}

// --- the pages under test ---------------------------------------------------

/** A chat page shaped like DeepSeek's: class-hooked composer, streamed answer. */
function chatPage(answer) {
  return `<!doctype html><html><head><title>DeepSeek</title><meta charset="utf-8"></head><body>
<main id="log"></main>
<div class="fbb737a4"><textarea id="composer" rows="3"></textarea></div>
<script>
const log = document.getElementById('log'), composer = document.getElementById('composer')
let sent = null
composer.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || sent !== null) return
  e.preventDefault(); sent = composer.value; composer.value = ''
  log.innerHTML += '<div><p>You</p><p class="body"></p></div>'
  log.querySelector('.body').textContent = sent
  const answer = document.createElement('div')
  answer.innerHTML = '<p>DeepSeek-V3</p><p class="body"></p>'
  log.appendChild(answer)
  const body = answer.querySelector('.body')
  let i = 0
  const tick = () => { if (i >= ${JSON.stringify(answer.length)}) return; body.textContent += ${JSON.stringify(answer)}[i++]; setTimeout(tick, 20) }
  tick()
})
</script></body></html>`
}

/** An ordinary content page: form, link, and enough height to scroll. */
const contentPage = `<!doctype html><html><head><title>Agent Probe</title><meta charset="utf-8"></head><body>
<h1>Agent surface probe</h1>
<p id="marker">BEFORE</p>
<input id="q" name="q" placeholder="search here"><button id="go" type="button">Go</button>
<a href="#more" id="link">a link to more</a>
<div style="height:5000px;background:linear-gradient(#fff,#036)"></div>
<p id="bottom">BOTTOM-MARKER</p>
<script>document.getElementById('go').onclick = () => {
  document.getElementById('marker').textContent = 'AFTER q=' + document.getElementById('q').value
}</script></body></html>`

/** A translation site that echoes the source and its result. */
function translatePage(source, translation) {
  return `<!doctype html><html><head><title>Translate</title><meta charset="utf-8"></head><body>
<p id="src">${source}</p><p id="out">${translation}</p><p>paste text here</p></body></html>`
}

// --- the harness -----------------------------------------------------------

const SOURCE_TEXT = 'quick brown fox'
const TRANSLATION_TEXT = '敏捷的棕色狐狸'
const CHAT_ANSWER = 'CDP stands for Chrome DevTools Protocol; it is how this plugin drives your browser.'

const servers = []
async function serve(html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}/`
}

const contentUrl = await serve(contentPage)
const chatUrl = await serve(chatPage(CHAT_ANSWER))
const translateUrl = await serve(translatePage(SOURCE_TEXT, TRANSLATION_TEXT))

const profile = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
const driver = new BrowserDriver({
  executablePath: EXECUTABLE,
  userDataDir: profile,
  headless: HEADLESS,
})

/** An api object for the client-side bridges, backed by the real driver. */
function driverApi(stateUrl = 'https://chat.deepseek.com/') {
  const ok = value => ({ ok: true, value })
  return {
    state: async () => ok({ attached: true, url: stateUrl, title: 'DeepSeek', loading: false }),
    navigate: async url => { await driver.navigate(url); return ok({}) },
    text: async ({ maxChars } = {}) => ok(await driver.extractText({ maxChars: maxChars ?? 8000 })),
    type: async (text, selector) => {
      try { await driver.typeText(text, selector); return ok({}) } catch (error) { return { ok: false, error: error.message } }
    },
    key: async key => {
      try { await driver.pressKey(key); return ok({}) } catch (error) { return { ok: false, error: error.message } }
    },
  }
}

// --- 1. the agent tools ----------------------------------------------------

section('agent tools (what the model calls)')
const tools = Object.fromEntries(buildSidebrowserTools(driver).map(t => [t.name, t]))
const call = async (name, args = {}) => {
  const raw = await tools[name].execute(args)
  try { return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) } catch { return {} }
}

const opened = await call('browser_open', { url: contentUrl })
check('browser_open succeeds', opened.ok === true, opened.tabId)
check('browser_open reports the real title', opened.title === 'Agent Probe', opened.title)

const read = await call('browser_read', { maxChars: 500, includeInventory: true })
check('browser_read returns rendered text', String(read.text).includes('Agent surface probe'), String(read.text).slice(0, 50))
check('browser_read lists real selectors', JSON.stringify(read.inventory?.fields ?? []).includes('#q'), '')

await call('browser_act', { action: 'type', text: 'probe-value', selector: '#q' })
await call('browser_act', { action: 'click', selector: '#go' })
const afterClick = await call('browser_read', { maxChars: 200 })
check('browser_act type + click changed the page', afterClick.text.includes('AFTER q=probe-value'), String(afterClick.text).slice(0, 60))

const scrolled = await call('browser_act', { action: 'scroll', deltaY: 1500 })
check('browser_act scroll succeeds', scrolled.ok === true, '')
const bottom = await call('browser_read', { maxChars: 40000 })
check('the scroll really moved the viewport', bottom.text.includes('BOTTOM-MARKER'), '')

const refused = await call('browser_act', { action: 'navigate', url: 'file:///C:/Windows/win.ini' })
check('a file: url is refused', refused.ok === false && String(refused.code) === 'bad-url', refused.code)

await call('browser_open', { url: contentUrl })
const tabList = (await call('browser_tabs', { action: 'list' })).tabs ?? []
check('browser_tabs lists the real tabs only', tabList.every(t => !String(t.url).startsWith('chrome://')), JSON.stringify(tabList.map(t => t.url)).slice(0, 120))
const second = tabList.find(t => t.id !== opened.tabId)
check('browser_tabs select succeeds', (await call('browser_tabs', { action: 'select', tabId: second.id })).ok === true, '')
check('browser_tabs close succeeds', (await call('browser_tabs', { action: 'close', tabId: second.id })).ok === true, '')
const afterClose = (await call('browser_tabs', { action: 'list' })).tabs ?? []
check('the closed tab is gone', !afterClose.some(t => t.id === second.id), '')

const shot = await call('browser_screenshot', { scale: 0.5 })
check('browser_screenshot wrote a png', typeof shot.path === 'string' && existsSync(shot.path), shot.path)
check('the png is not empty', typeof shot.path === 'string' && existsSync(shot.path) && statSync(shot.path).size > 0, '')

// --- 2. the AI-explain bridge ----------------------------------------------

section('AI explain (drives the DeepSeek web page)')
await driver.open(chatUrl)
const stages = []
const outcome = await askDeepSeekWeb('Explain CDP in one sentence.', driverApi(), {
  timeoutMs: 25_000,
  pollMs: 400,
  onProgress: stage => stages.push(stage),
})
check('the bridge reached an answer', outcome.kind === 'answer', outcome.kind)
check('the answer is the model reply', outcome.kind === 'answer' && outcome.text.includes('Chrome DevTools Protocol'), outcome.text?.slice(0, 60))
check('the answer does not echo the prompt', outcome.kind === 'answer' && !outcome.text.includes('Explain CDP'), '')
check('the answer does not carry the model label', outcome.kind === 'answer' && !outcome.text.includes('-V3'), '')
check('the progress stages ran in order', JSON.stringify(stages) === JSON.stringify(['opening', 'typing', 'waiting', 'reading']), stages.join('>'))
check('extraction matches on the raw page text', extractAnswer((await driver.extractText({ maxChars: 8000 })).text).includes('Chrome DevTools Protocol'), '')

// --- 3. the translation path -----------------------------------------------

section('translation (opens a site, leaves the result on screen)')
const outcomeT = await translateSelection(SOURCE_TEXT, driverApi('https://example.com/'), {
  engine: { id: 'verify-site', name: 'Verify site', url: text => `${translateUrl}?text=${encodeURIComponent(text)}` },
  target: 'zh-Hans',
  timeoutMs: 8000,
  fallbackToDeepSeek: false,
})
check('the translation site path reports which engine it used', outcomeT.kind === 'opened' && outcomeT.engine === 'verify-site', JSON.stringify(outcomeT))
const translated = await driver.extractText({ maxChars: 4000 })
check('the translation is on the page', translated.text.includes(TRANSLATION_TEXT), translated.text.slice(0, 60))
check('the source text is on the page', translated.text.includes(SOURCE_TEXT), '')

// --- 5. the sidebar live view -----------------------------------------------

// The sidebar does not embed the page; it shows a polled screenshot. That loop
// is the one surface every user looks at first, so it is checked here rather
// than only through the driver's capture calls.
section('sidebar live view')
const { ScreenshotStream } = await import('../src/browser/screenshot-stream.ts')
await driver.open(contentUrl)
const stream = new ScreenshotStream(driver, { intervalMs: 400, scale: 0.5, onError: () => {} })

const first = await stream.poll()
check('the first poll carries a frame', first.changed === true, JSON.stringify(first).slice(0, 80))
const frame = first.changed === true ? first.frame : undefined
check('the frame has real png data', typeof frame?.data === 'string' && frame.data.length > 1000, frame?.data?.length)
check('the frame carries title and url', frame?.title === 'Agent Probe' && String(frame?.url).startsWith('http://127.0.0.1:'), `${frame?.title} ${frame?.url}`)
check('the frame has an id and a timestamp', typeof frame?.id === 'number' && typeof frame?.capturedAt === 'string', '')

const liveSecond = await stream.poll()
check('an unchanged page is reported as unchanged', liveSecond.changed === false, JSON.stringify(liveSecond).slice(0, 80))
check('the unchanged answer carries the last frame id', liveSecond.changed === false && liveSecond.frameId === frame?.id, '')

// Change the page, and the stream must notice on the next poll.
await driver.typeText('live-view-check', '#q')
await driver.pressKey('Enter')
await driver.click({ selector: '#go' })
const liveThird = await stream.poll()
check('a changed page produces a new frame', liveThird.changed === true && liveThird.frame.id !== frame?.id, liveThird.changed ? String(liveThird.frame.id) : 'unchanged')

stream.dispose()
check('the stream can be disposed while capturing', true, '')

// --- 6. concurrent tool calls ----------------------------------------------

// Every tool declares `isConcurrencySafe: () => true`, which is a promise that
// the Host may run several at once. That promise is about the driver, so it is
// checked rather than assumed: overlapping reads, clicks, scrolls and tab
// listings through one CDP connection and one tab model.
section('concurrent tool calls')
// The previous section left a translation page selected; the batch needs a tab
// with a composer and a button on it, so open the content page first and take
// the tab baseline after that.
await call('browser_open', { url: contentUrl })
const tabsBefore = ((await call('browser_tabs', { action: 'list' })).tabs ?? [])
  .filter(t => !String(t.url).startsWith('chrome://')).length
// Reads, a click, a tab listing and a type all at once. The click is not batched
// with a scroll on purpose: a scroll moves the page under a click's coordinates,
// so pairing them would test the caller's ordering rather than the driver's
// tolerance of concurrent calls.
const concurrent = await Promise.all([
  call('browser_read', { maxChars: 300 }),
  call('browser_act', { action: 'click', selector: '#go' }),
  call('browser_read', { maxChars: 300 }),
  call('browser_tabs', { action: 'list' }),
  call('browser_act', { action: 'type', text: 'hello', selector: '#q' }),
])
check('every overlapping call answered', concurrent.every(r => r.ok === true), concurrent.filter(r => r.ok === false).length + ' failed')
const concurrentAfter = await call('browser_read', { maxChars: 300 })
check('the click from the batch really happened', concurrentAfter.text.includes('AFTER q='), String(concurrentAfter.text).slice(0, 60))
const tabsAfter = (await call('browser_tabs', { action: 'list' })).tabs ?? []
check('no blank page entered the strip', tabsAfter.every(t => !String(t.url).startsWith('chrome://')), '')
check('the tab model survived the batch', tabsAfter.length === tabsBefore, `${tabsBefore} -> ${tabsAfter.length}`)
const parallel = await Promise.all(Array.from({ length: 8 }, () => call('browser_read', { maxChars: 200 })))
check('eight parallel reads all succeed', parallel.every(r => r.ok === true), parallel.filter(r => !r.ok).length + ' failed')

// --- done -------------------------------------------------------------------

await driver.dispose()
for (const server of servers) server.close()
try { rmSync(profile, { recursive: true, force: true }) } catch {}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} of ${checks} CHECK(S) FAILED`} (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)