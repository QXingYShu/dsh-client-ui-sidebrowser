/**
 * Regression: a spawn failure must not take down the Host.
 *
 * The bug: `spawn()` was called with no `'error'` listener. ChildProcess is an
 * EventEmitter, and an `'error'` event with no listener THROWS — so when the
 * executable exists but cannot be started (a directory, a .lnk, a quarantined
 * binary; on Windows `access(X_OK)` behaves as `F_OK`, so the probe passes for
 * all of these), the unhandled error killed the whole DSH process instead of
 * failing this one plugin.
 *
 * `spawn` is mocked to emit `'error'` on the next tick, exactly as Node does
 * for ENOENT/EACCES. Without the driver's own listener this test file itself
 * dies with an uncaught exception, which is the regression signal.
 *
 * @module
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned: Array<{ executable: string, args: string[] }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((executable: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { exitCode: number | null, kill: () => boolean }
      child.exitCode = null
      // `dispose` stops whatever handle is held; the fake needs a no-op kill.
      child.kill = () => true
      spawned.push({ executable, args })
      // Node emits spawn failures asynchronously on the child.
      process.nextTick(() => {
        child.emit('error', new Error('spawn ENOENT: does not exist (simulated)'))
      })
      return child
    }),
  }
})

const { BrowserDriver, BrowserError } = await import('../src/browser/driver.ts')
const { spawn } = await import('node:child_process')

/** Drivers created by this file, disposed after every case. */
const created: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const driver of created.splice(0)) await driver.dispose()
})

describe('launch: a spawn failure becomes a refusal, not a crash', () => {
  it('rejects with launch-failed when the process emits `error`', async () => {
    // `process.execPath` exists and is executable on every machine, so the
    // driver's own `access` probe passes and execution reaches `spawn` —
    // the exact gap where the unhandled error used to escape.
    const driver = new BrowserDriver({
      executablePath: process.execPath,
      port: 65_000 + Math.floor(Math.random() * 1000),
      userDataDir: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/dsh-sidebrowser-launch-test-${process.pid}`,
    })
    created.push(driver)

    // `launch` is intentionally private; the cast reaches it directly so the test
    // measures the spawn path rather than whatever public method wraps it.
    const launch = (driver as unknown as { launch(): Promise<void> }).launch.bind(driver)
    const error = await launch().then(
      () => { throw new Error('expected launch() to reject') },
      e => e as Error & { code?: string },
    )
    expect(error).toBeInstanceOf(BrowserError)
    expect(error.code).toBe('launch-failed')
    // The message surfaces the underlying cause for whoever reads the log.
    expect(error.message).toContain('could not be started')
    expect(error.message).toContain('simulated')

    // The fake spawn really was the one reached, so the assertions above are
    // not passing for some earlier validation failure.
    expect(spawned).toHaveLength(1)
    expect(vi.mocked(spawn)).toHaveBeenCalled()
  }, 15_000)
})