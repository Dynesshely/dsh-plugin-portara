/**
 * Write one reload-safe `plugin:` record into a Session log.
 *
 * `Session.append()` cannot set the `ignorable` marker, so an unknown type
 * written that way makes the Session unreadable on the next load. The only
 * supported writer is `appendPluginRecord()`, a module-level function that
 * commits through a module-private binding. Calling a *second copy* of
 * `@deepseek-ai/dsh-session` would therefore throw on its private brand, so
 * this module resolves the instance the Host itself loaded — first the source
 * entry (a source checkout runs the Session module through its TypeScript
 * loader) and then the built entry — and keeps the first candidate that
 * accepts a real append.
 *
 * Every failure is silent: routing information is cosmetic and must never
 * affect a request, a Session, or the process.
 *
 * @module dsh-plugin-portara/host/records
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Module specifier resolved from the Host's own installation. */
const SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/** Package name the walking resolver accepts as the Session package root. */
const SESSION_PACKAGE_NAME = '@deepseek-ai/dsh-session'

/**
 * Walk up from a resolved entry file to the package root that owns it.
 * @param {string} file - absolute file path.
 * @returns {string | undefined} directory whose `package.json` names the package.
 */
function packageRootOf(file) {
  let directory = dirname(file)
  for (let depth = 0; depth < 5; depth += 1) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed?.name === SESSION_PACKAGE_NAME) return directory
      } catch { /* unreadable manifest: keep walking */ }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * File URLs that may resolve the Host's Session package: the profile directory
 * first (the profile's `node_modules` links the exact installed packages), then
 * the checkout the Host process was started in.
 * @param {object} ctx - plugin context.
 * @returns {string[]} anchor URLs usable with `createRequire`.
 */
function anchors(ctx) {
  const urls = []
  const base = ctx?.baseUrl
  if (typeof base === 'string' && base !== '') {
    try {
      urls.push(new URL('package.json', base).href)
    } catch { /* not a URL-shaped base */ }
  }
  const cwd = process.cwd()
  urls.push(pathToFileURL(join(cwd, 'package.json')).href)
  urls.push(pathToFileURL(join(cwd, 'apps', 'cli', 'package.json')).href)
  urls.push(import.meta.url)
  return urls
}

/**
 * Candidate module file URLs for the Session package, most-likely-Host instance
 * first. A source checkout loads `src/index.ts` through the TypeScript loader;
 * an installed deployment loads `lib/index.js`.
 * @param {object} ctx - plugin context.
 * @returns {string[]} unique candidate URLs.
 */
export function sessionModuleCandidates(ctx) {
  const urls = new Set()
  for (const anchor of anchors(ctx)) {
    let packageDir
    try {
      const resolved = createRequire(anchor).resolve(SESSION_PACKAGE)
      packageDir = packageRootOf(realpathSync(resolved))
    } catch {
      continue
    }
    if (packageDir === undefined) continue
    for (const entry of [join(packageDir, 'src', 'index.ts'), join(packageDir, 'lib', 'index.js')]) {
      if (!existsSync(entry)) continue
      try {
        urls.add(pathToFileURL(realpathSync(entry)).href)
      } catch { /* unreadable candidate */ }
    }
  }
  return [...urls]
}

/**
 * Read the Session placement of the newest step boundary without touching the
 * (private) event log: `eventAt()` is the supported point read.
 *
 * Besides the coordinates, the walk records the Turn's opening sequence — the
 * first `step/start` of that Turn (falling back to its `turn/start`). Sending it
 * with the record lets the browser anchor the card deterministically instead of
 * re-deriving Turn boundaries from whatever history window it happens to hold.
 *
 * @param {object} session - Session instance.
 * @returns {{ turn?: number, step?: number, anchorSeq?: number }} placement, empty when unknown.
 */
export function sessionCoordinates(session) {
  if (session === null || typeof session !== 'object') return {}
  const end = Number(session.seq)
  if (!Number.isSafeInteger(end) || end <= 0 || typeof session.eventAt !== 'function') return {}
  let turn
  let step
  let firstStepSeq
  let turnStartSeq
  const floor = Math.max(0, end - 2_000)
  for (let seq = end - 1; seq >= floor; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return {}
    }
    if (event === undefined || event === null || event.data === null || typeof event.data !== 'object') continue
    const { data } = event
    if (event.type === 'step/start' && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      if (turn === undefined) {
        turn = data.turn
        step = data.step
        firstStepSeq = seq
      } else if (data.turn === turn) {
        firstStepSeq = seq
      }
    } else if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      if (turn === undefined) turn = data.turn
      if (data.turn === turn) {
        turnStartSeq = seq
        break
      }
    }
  }
  if (turn === undefined) return {}
  const anchorSeq = firstStepSeq ?? turnStartSeq
  return {
    turn,
    ...(step === undefined ? {} : { step }),
    ...(anchorSeq === undefined ? {} : { anchorSeq }),
  }
}

/**
 * Create the record writer for one plugin lifetime.
 * @param {object} ctx - plugin context.
 * @param {{ signal: AbortSignal, logger?: { warn(message: string): void } }} options - lifetime and diagnostics.
 * @returns {{ append(session: object, type: string, data: unknown): Promise<boolean> }} writer.
 */
export function createRecordWriter(ctx, options) {
  /** @type {((session: object, type: string, data: unknown) => void) | undefined} */
  let committed
  let resolved = false
  let warned = false

  /**
   * Resolve and validate the writer once per plugin lifetime.
   * @param {object} session - Session instance that will receive the record.
   * @param {string} type - plugin record type.
   * @param {unknown} data - first payload, used as the identity probe.
   * @returns {Promise<boolean>} whether a Host-owned writer was found.
   */
  async function resolve(session, type, data) {
    resolved = true
    for (const url of sessionModuleCandidates(ctx)) {
      if (options.signal.aborted) return false
      let moduleNamespace
      try {
        moduleNamespace = await import(url)
      } catch {
        continue
      }
      const append = moduleNamespace?.appendPluginRecord
      if (typeof append !== 'function') continue
      try {
        append(session, type, data)
      } catch {
        // A foreign copy of the Session module cannot brand this instance.
        continue
      }
      committed = append
      return true
    }
    if (!warned) {
      warned = true
      options.logger?.warn(
        'portara-route: the Host Session module could not be resolved, so no routing card will be written',
      )
    }
    return false
  }

  return {
    /**
     * Append one record, resolving the writer on first use.
     * @param {object} session - Session instance.
     * @param {string} type - plugin record type.
     * @param {unknown} data - JSON payload.
     * @returns {Promise<boolean>} whether the record was committed.
     */
    async append(session, type, data) {
      if (options.signal.aborted) return false
      if (session === null || typeof session !== 'object') return false
      if (committed !== undefined) {
        try {
          committed(session, type, data)
          return true
        } catch {
          return false
        }
      }
      if (resolved) return false
      try {
        return await resolve(session, type, data)
      } catch {
        return false
      }
    },
  }
}
