import { gzipSync } from 'node:zlib'
import type { LocaleData, Repo } from '../config/load.js'
import { manifestSlug, targetLang, type WpLocale, type WpLocales } from '../locales.js'
import { releaseUrl, type Manifest, type ManifestProject, type RulesEntry, type TmEntry } from '../manifest.js'
import { MIN_PERCENT } from '../check/new-paths.js'
import { isLongText } from '../paths.js'
import { poToUnits } from '../po/units.js'
import { resolveProjects } from '../resolve.js'
import type { OlderRules, RulesCheckResult } from '../rules/check.js'
import { minPolyglotsFor } from '../rules/downlevel.js'
import { TMX_FORMAT_VERSION, writeTmx } from '../tmx/write.js'
import type { Unit } from '../types.js'
import { findSet, parseProjectApi, type SetInfo } from '../wporg/api.js'
import type { HttpClient } from '../wporg/client.js'
import { apiUrl, exportUrl } from '../wporg/urls.js'
import { needsDownload, type CachedProject } from './cache.js'
import { decideProject, type Fresh } from './decide.js'
import { compareUnits, mergeUnits } from './merge.js'
import type { Previous } from './previous.js'
import { encodeUnitsFile, sha512, type State, type UnitsFile } from './state.js'

export const MAX_UNCOMPRESSED = 157_286_400
export const STALE_RED_DAYS = 28
const DAY = 86_400_000

export interface BuildInput {
  repo: Repo; wp: WpLocales; previous: Previous; rebuild: string[]; force: boolean; accept: Set<string>
  tag: string; toolVersion: string; minPolyglots: string
  rules: Map<string, { bytes: Buffer; check: RulesCheckResult; older?: OlderRules[] }>; now: Date
}
export interface ProjectLog { locale: string; path: string; action: 'cached' | 'downloaded' | 'stale' | 'missing'; units: number; note?: string }
export interface BuildResult { assets: Map<string, Buffer>; manifest: Manifest; state: State; log: ProjectLog[]; red: string[]; warnings: string[]; publish: boolean; downloads: number; toolVersion: string }

const byLocale = (a: { locale: string }, b: { locale: string }) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0)
const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n')

interface Ctx {
  input: BuildInput; api: Map<string, SetInfo[] | undefined>; wporg: HttpClient
  assets: Map<string, Buffer>; log: ProjectLog[]; red: string[]; warnings: string[]; downloads: number
}

/** One API request per distinct path across the rebuilt locales (spec 5.2 step 1). */
async function askApi(locales: LocaleData[], core: string[], wporg: HttpClient): Promise<Map<string, SetInfo[] | undefined>> {
  const api = new Map<string, SetInfo[] | undefined>()
  for (const l of locales) {
    for (const path of resolveProjects(core, l.tm!)) {
      if (api.has(path)) continue
      const r = await wporg.get(apiUrl(path))
      const parsed = r.ok ? parseProjectApi(r.body) : undefined
      api.set(path, parsed?.ok ? parsed.sets : undefined)
    }
  }
  return api
}

function sameUnits(a: Unit[], b: Unit[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort(compareUnits)
  const y = [...b].sort(compareUnits)
  return x.every((u, i) => compareUnits(u, y[i]!) === 0)
}

/** State with sorted keys, so key order never counts as a change. */
function stableState(s: State): string {
  return JSON.stringify(Object.keys(s.locales).sort().map((code) => {
    const l = s.locales[code]!
    return [code, l.units, l.sha512, Object.keys(l.projects).sort().map((p) => [p, l.projects[p]])]
  }))
}

/** Spec 5.2–5.8 for one rebuilt locale. Returns its manifest and state entries, or undefined. */
async function buildLocale(c: Ctx, l: LocaleData, loc: WpLocale): Promise<{ entry?: TmEntry; state?: State['locales'][string] }> {
  const { input } = c
  const { previous } = input
  const nowIso = input.now.toISOString()
  const nowMs = input.now.getTime()
  const prevEntry = previous.index?.tm.find((e) => e.locale === l.code)
  const prevState = previous.state.locales[l.code]
  const kept: Array<{ path: string; units: Unit[]; built: string; stale?: string }> = []
  const projectsState: Record<string, CachedProject> = {}

  const own = new Set(l.tm!.projects.map((p) => p.path))
  for (const path of resolveProjects(input.repo.core, l.tm!)) {
    const cached = prevState?.projects[path]
    const lastUnits = previous.units.get(l.code)?.get(path)
    const sets = c.api.get(path)
    const set = sets ? findSet(sets, loc) : undefined
    // Core projects and readmes have no threshold; the locale's own projects were added at 90% or more.
    if (set && own.has(path) && !isLongText(path) && set.percent < MIN_PERCENT) {
      c.warnings.push(`${l.code} ${path}: ${set.percent}% translated, under the ${MIN_PERCENT}% a TM project needs`)
    }
    if (cached && lastUnits && sets && set && !needsDownload(cached, set, nowMs, input.force)) {
      kept.push({ path, units: lastUnits.units, built: lastUnits.built })
      // The API is back at the last good values: the cached units are current, so the project is no longer stale.
      const { staleSince: _staleSince, ...current } = cached
      projectsState[path] = current
      c.log.push({ locale: l.code, path, action: 'cached', units: lastUnits.units.length })
      continue
    }
    let fresh: Fresh
    if (sets && !set) {
      fresh = { ok: false, error: 'no translation set for this locale' }
    } else {
      c.downloads++
      const r = await c.wporg.get(exportUrl(path, loc))
      fresh = r.ok ? poToUnits(r.body) : { ok: false, error: r.error }
    }
    const last = cached && lastUnits ? { ...lastUnits, lastModified: cached.lastModified, currentCount: cached.currentCount } : undefined
    const o = decideProject(fresh, last, input.accept.has(`${l.code}:${path}`))
    if (o.kind === 'fresh') {
      // Same content as last good: keep its build time so the TMX bytes stay identical.
      const same = last !== undefined && sameUnits(last.units, o.units)
      kept.push({ path, units: o.units, built: same ? last.built : nowIso })
      projectsState[path] = { units: o.units.length, built: nowIso, lastModified: set?.lastModified ?? '', currentCount: set?.currentCount ?? -1 }
      c.log.push({ locale: l.code, path, action: 'downloaded', units: o.units.length })
    } else if (o.kind === 'stale') {
      kept.push({ path, units: o.last.units, built: o.last.built, stale: o.last.built })
      // The alarm clock starts at the first failure, not at the last good build: old content that fails once is not red.
      // A malformed value from an old state.json restarts the clock instead of silencing it.
      const prior = cached!.staleSince
      const staleSince = typeof prior === 'string' && !Number.isNaN(Date.parse(prior)) ? prior : nowIso
      projectsState[path] = { ...cached!, staleSince }
      c.log.push({ locale: l.code, path, action: 'stale', units: o.last.units.length, note: o.reason })
      if (nowMs - Date.parse(staleSince) > STALE_RED_DAYS * DAY) c.red.push(`${l.code} ${path}: stale since ${staleSince} (${o.reason}); last good ${o.last.built}`)
    } else {
      c.log.push({ locale: l.code, path, action: 'missing', units: 0, note: o.reason })
      c.red.push(`${l.code} ${path}: left out (${o.reason})`)
    }
  }

  if (kept.length === 0) {
    // A forced recovery with no cache must never drop a good TM that the previous release still serves.
    if (prevEntry) {
      c.red.push(`${l.code}: no project could be built; the previous TM stays`)
      return { entry: prevEntry, state: prevState }
    }
    c.red.push(`${l.code}: no project left`)
    return {}
  }
  for (const k of kept) if (k.units.length === 0) c.warnings.push(`${l.code} ${k.path}: no units`)
  const merged = mergeUnits(kept)
  const created = new Date(Math.max(...kept.map((k) => Date.parse(k.built))))
  const xml = Buffer.from(writeTmx(merged, { lang: targetLang(l.code, loc), toolVersion: TMX_FORMAT_VERSION, created }))
  if (xml.length > MAX_UNCOMPRESSED) {
    c.red.push(`${l.code}: ${xml.length} bytes uncompressed, over the ${MAX_UNCOMPRESSED} limit; the previous TM stays`)
    return { entry: prevEntry, state: prevState }
  }
  const gz = gzipSync(xml, { level: 9 })
  const hash = sha512(gz)
  const projects: ManifestProject[] = kept.map((k) => ({
    path: k.path, units: k.units.length, ...(k.stale ? { stale: k.stale } : {}), ...(isLongText(k.path) ? { kind: 'long-text' as const } : {}),
  }))
  let entry: TmEntry
  if (prevEntry && prevEntry.sha512 === hash) {
    entry = { ...prevEntry, slug: manifestSlug(loc), units: merged.length, projects }
  } else {
    const name = `${l.code}.tmx.gz`
    c.assets.set(name, gz)
    entry = { locale: l.code, slug: manifestSlug(loc), url: releaseUrl(input.tag, name), bytes: gz.length, bytesUncompressed: xml.length, sha512: hash, units: merged.length, built: nowIso, projects }
  }
  const unitsFile: UnitsFile = { schema: 1, projects: Object.fromEntries(kept.map((k) => [k.path, { built: k.built, units: k.units.map((u) => [u.source, u.context, u.target] as [string, string, string]) }])) }
  const unitsBytes = encodeUnitsFile(unitsFile)
  const unitsHash = sha512(unitsBytes)
  if (prevState && prevState.sha512 === unitsHash) return { entry, state: { ...prevState, projects: projectsState } }
  const unitsName = `${l.code}.units.json.gz`
  c.assets.set(unitsName, unitsBytes)
  return { entry, state: { units: releaseUrl(input.tag, unitsName), sha512: unitsHash, projects: projectsState } }
}

/**
 * Spec 8: a rules file is published as read, or left out when a check fails.
 * A file newer than OLDEST_SCHEMA is also published at each older schema,
 * and those rows come first: a released client takes the first row for its
 * locale, so a newer row first would refuse every client that cannot read it.
 * Every row of a locale carries the same status and maintainers.
 */
function rulesEntries(c: Ctx): RulesEntry[] {
  const { input } = c
  const out: RulesEntry[] = []
  const previous = (code: string, schema?: number) =>
    (input.previous.index?.rules ?? []).filter((e) => e.locale === code && (schema === undefined || e.schema === schema))
  for (const [code, r] of [...input.rules].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const error = r.check.findings.find((f) => f.level === 'error')
    if (error) {
      // The previous entries still point at the older assets in their own release; keep serving them.
      out.push(...previous(code))
      c.red.push(`${code} rules: ${error.message}`)
      continue
    }
    const meta = input.repo.locales.get(code)?.meta
    const loc = input.wp.get(code)
    if (!meta || !loc) { c.red.push(`${code} rules: locale.yaml or the locale mapping is missing`); continue }
    const row = (schema: number, name: string, bytes: Buffer): RulesEntry => {
      c.assets.set(name, bytes)
      return {
        locale: code, slug: manifestSlug(loc), url: releaseUrl(input.tag, name), sha512: sha512(bytes), schema,
        minPolyglots: minPolyglotsFor(schema, input.minPolyglots), status: meta.rules.status, maintainers: meta.maintainers.map((m) => m.wporg),
      }
    }
    for (const o of [...(r.older ?? [])].sort((a, b) => a.schema - b.schema)) {
      const olderError = o.check.findings.find((f) => f.level === 'error')
      if (olderError) {
        out.push(...previous(code, o.schema))
        c.red.push(`${code} rules: ${olderError.message}`)
        continue
      }
      out.push(row(o.schema, `${code}.rules.schema${o.schema}.yaml`, o.bytes))
    }
    out.push(row(r.check.schema ?? 0, `${code}.rules.yaml`, r.bytes))
  }
  return out
}

/** Everything that decides "changed": rules URLs always name the new tag, so they are left out. */
function comparable(m: Manifest | undefined): string {
  if (!m) return ''
  return JSON.stringify({ tm: m.tm, rules: m.rules.map(({ url: _url, ...rest }) => rest) })
}

export async function runBuild(input: BuildInput, wporg: HttpClient): Promise<BuildResult> {
  const { repo, previous } = input
  const withTm = [...repo.locales.values()].filter((l) => l.tm)
  const rebuild = new Set(input.rebuild)
  const c: Ctx = {
    input, wporg, assets: new Map(), log: [], warnings: [], downloads: 0,
    red: previous.first ? [] : previous.problems.map((p) => `previous release: ${p}`),
    api: await askApi(withTm.filter((l) => rebuild.has(l.code) && input.wp.has(l.code)), repo.core, wporg),
  }
  const tm: TmEntry[] = []
  const state: State = { schema: 1, locales: {} }
  for (const l of withTm) {
    const loc = input.wp.get(l.code)
    const r = rebuild.has(l.code) && loc
      ? await buildLocale(c, l, loc)
      : { entry: previous.index?.tm.find((e) => e.locale === l.code), state: previous.state.locales[l.code] }
    if (r.entry) tm.push(r.entry)
    if (r.state) state.locales[l.code] = r.state
  }
  const manifest: Manifest = { schema: 1, generated: input.now.toISOString(), tm: tm.sort(byLocale), rules: rulesEntries(c).sort(byLocale) }
  // A damaged previous release means non-rebuilt locales lost their entries: build and report, never publish.
  // Recovery: a forced rebuild of every mapped TM locale carries nothing forward from the damaged release.
  const fullForced = input.force && withTm.every((l) => !input.wp.has(l.code) || rebuild.has(l.code))
  const damaged = !previous.first && previous.problems.length > 0 && !fullForced
  const publish = previous.first || (!damaged && (comparable(manifest) !== comparable(previous.index) || stableState(state) !== stableState(previous.state)))
  c.assets.set('index.json', json(manifest))
  c.assets.set('state.json', json(state))
  return { assets: c.assets, manifest, state, log: c.log, red: c.red, warnings: c.warnings, publish, downloads: c.downloads, toolVersion: input.toolVersion }
}
