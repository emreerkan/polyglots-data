// test/build.test.ts
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../src/config/load.js'
import type { Previous } from '../src/build/previous.js'
import { runBuild, type BuildInput } from '../src/build/run.js'
import { selfCheck } from '../src/build/selfcheck.js'
import { sha512 } from '../src/build/state.js'
import type { HttpClient } from '../src/wporg/client.js'
import { apiUrl, exportUrl } from '../src/wporg/urls.js'

const TR = { slug: 'tr', set: 'default' }
const wp = new Map([['tr_TR', TR], ['el', { slug: 'el', set: 'default' }]])
const now = new Date('2026-10-16T03:00:00Z')

function po(entries: Array<[string, string]>): Buffer {
  const head = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=n > 1;\\n"\n\n'
  return Buffer.from(head + entries.map(([s, t]) => `msgid "${s}"\nmsgstr "${t}"\n`).join('\n'))
}
const api = (current: number, lastModified = '2026-10-15 00:00:00') => Buffer.from(JSON.stringify({
  translation_sets: [{ locale: 'tr', slug: 'default', wp_locale: 'tr_TR', current_count: current, all_count: current, percent_translated: 100, last_modified: lastModified }],
}))
function client(files: Record<string, Buffer | number>): HttpClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async get(url) {
      calls.push(url)
      const f = files[url]
      if (f === undefined || typeof f === 'number') return { ok: false, status: typeof f === 'number' ? f : 404, error: `HTTP ${f ?? 404}` }
      return { ok: true, status: 200, body: f }
    },
  }
}
const repo = (localePaths: string[] = ['wp-plugins/a/dev-readme']): Repo => ({
  root: '/x',
  core: ['wp/dev'],
  locales: new Map([
    ['tr_TR', { code: 'tr_TR', tm: { projects: localePaths.map((path) => ({ path, added: '2026-10-16', by: 'emre', reviewed: 'r' })), exclude: [] }, meta: { locale: 'tr_TR', maintainers: [{ wporg: 'emre', github: 'emreerkan', role: 'Locale Manager' }], rules: { status: 'maintained' } } }],
  ]),
})
const first: Previous = { first: true, state: { schema: 1, locales: {} }, units: new Map(), problems: [] }
const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  repo: repo(), wp, previous: first, rebuild: ['tr_TR'], force: false, accept: new Set(), tag: 'data-20261016-030000',
  toolVersion: 'abc', minPolyglots: '1.0.0', rules: new Map(), now, ...over,
})
const units = (n: number) => Array.from({ length: n }, (_, i) => [`s${i}`, `t${i}`] as [string, string])

describe('runBuild', () => {
  it('first run downloads everything and writes the agreed manifest', async () => {
    const c = client({
      [apiUrl('wp/dev')]: api(2), [exportUrl('wp/dev', TR)]: po([['Post', 'Yazı'], ['Shared', 'Ortak']]),
      [apiUrl('wp-plugins/a/dev-readme')]: api(2), [exportUrl('wp-plugins/a/dev-readme', TR)]: po([['Shared', 'Ortak'], ['Long', 'Uzun']]),
    })
    const r = await runBuild(input(), c)
    expect(r.red).toEqual([])
    expect(r.publish).toBe(true)
    expect(r.downloads).toBe(2)
    const tm = r.manifest.tm[0]!
    expect(tm).toMatchObject({ locale: 'tr_TR', slug: 'tr', units: 3, built: now.toISOString(), url: 'https://github.com/emreerkan/polyglots-data/releases/download/data-20261016-030000/tr_TR.tmx.gz' })
    expect(tm.projects).toEqual([{ path: 'wp/dev', units: 2 }, { path: 'wp-plugins/a/dev-readme', units: 2, kind: 'long-text' }])
    const xml = gunzipSync(r.assets.get('tr_TR.tmx.gz')!).toString()
    expect((xml.match(/x-weight/g) ?? []).length).toBe(1)
    expect(tm.bytesUncompressed).toBe(Buffer.byteLength(xml))
    expect(selfCheck(r.assets, r.manifest, r.state, 'data-20261016-030000')).toEqual([])
  })

  it('second run with an unchanged API downloads nothing and does not publish', async () => {
    const files = {
      [apiUrl('wp/dev')]: api(2), [exportUrl('wp/dev', TR)]: po([['Post', 'Yazı'], ['Shared', 'Ortak']]),
      [apiUrl('wp-plugins/a/dev-readme')]: api(2), [exportUrl('wp-plugins/a/dev-readme', TR)]: po([['Shared', 'Ortak'], ['Long', 'Uzun']]),
    }
    const r1 = await runBuild(input(), client(files))
    const prev = previousFrom(r1)
    const c2 = client(files)
    const r2 = await runBuild(input({ previous: prev, now: new Date('2026-10-23T03:00:00Z') }), c2)
    expect(c2.calls.filter((u) => u.includes('export-translations'))).toEqual([])
    expect(r2.publish).toBe(false)
    expect(r2.manifest.tm[0]!.built).toBe(now.toISOString())
  })

  it('html export keeps last good', async () => {
    const files: Record<string, Buffer> = { [apiUrl('wp/dev')]: api(60), [exportUrl('wp/dev', TR)]: po(units(60)) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    files[apiUrl('wp/dev')] = api(61, '2026-10-20 00:00:00')
    files[exportUrl('wp/dev', TR)] = Buffer.from('<!DOCTYPE html><html>maintenance</html>')
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: new Date('2026-10-23T03:00:00Z') }), client(files))
    expect(r2.manifest.tm[0]!.projects).toEqual([{ path: 'wp/dev', units: 60, stale: now.toISOString() }])
    expect(r2.manifest.tm[0]!.units).toBe(60)
    expect(r2.red).toEqual([])
  })

  it('turns red when a project is stale for more than 28 days after its first failure', async () => {
    const files: Record<string, Buffer | number> = { [apiUrl('wp/dev')]: api(60), [exportUrl('wp/dev', TR)]: po(units(60)) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    files[apiUrl('wp/dev')] = api(61, '2026-11-20 00:00:00')
    files[exportUrl('wp/dev', TR)] = 503
    // First failure 35 days after the last good build: the clock starts now, so this is not red.
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: new Date('2026-11-20T03:00:00Z') }), client(files))
    expect(r2.red).toEqual([])
    expect(r2.state.locales['tr_TR']!.projects['wp/dev']!.staleSince).toBe('2026-11-20T03:00:00.000Z')
    expect(r2.manifest.tm[0]!.projects[0]!.stale).toBe(now.toISOString())
    const p2 = { ...previousFrom(r2), units: previousFrom(r1).units }
    const r3 = await runBuild(input({ repo: repo([]), previous: p2, now: new Date('2026-12-18T03:00:00Z') }), client(files))
    expect(r3.red).toEqual([])
    expect(r3.state.locales['tr_TR']!.projects['wp/dev']!.staleSince).toBe('2026-11-20T03:00:00.000Z')
    const r4 = await runBuild(input({ repo: repo([]), previous: p2, now: new Date('2026-12-20T03:00:00Z') }), client(files))
    expect(r4.red).toEqual([expect.stringMatching(/^tr_TR wp\/dev: stale since 2026-11-20T03:00:00.000Z .*last good 2026-10-16T03:00:00.000Z$/)])
    expect(r4.manifest.tm[0]!.projects[0]!.stale).toBe(now.toISOString())
  })

  it('one failure on old content is not red', async () => {
    const files: Record<string, Buffer | number> = { [apiUrl('wp/dev')]: api(60), [exportUrl('wp/dev', TR)]: po(units(60)) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    files[apiUrl('wp/dev')] = api(61, '2027-06-01 00:00:00')
    files[exportUrl('wp/dev', TR)] = 503
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: new Date('2027-06-01T03:00:00Z') }), client(files))
    expect(r2.log.map((x) => x.action)).toEqual(['stale'])
    expect(r2.red).toEqual([])
  })

  it('drops staleSince on a fresh result', async () => {
    const files: Record<string, Buffer | number> = { [apiUrl('wp/dev')]: api(60), [exportUrl('wp/dev', TR)]: po(units(60)) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    files[apiUrl('wp/dev')] = api(61, '2026-10-20 00:00:00')
    files[exportUrl('wp/dev', TR)] = 503
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: new Date('2026-10-23T03:00:00Z') }), client(files))
    expect(r2.state.locales['tr_TR']!.projects['wp/dev']!.staleSince).toBeDefined()
    files[exportUrl('wp/dev', TR)] = po(units(61))
    const r3 = await runBuild(input({ repo: repo([]), previous: { ...previousFrom(r2), units: previousFrom(r1).units }, now: new Date('2026-10-24T03:00:00Z') }), client(files))
    expect(r3.log.map((x) => x.action)).toEqual(['downloaded'])
    expect(r3.state.locales['tr_TR']!.projects['wp/dev']!.staleSince).toBeUndefined()
    expect(r3.manifest.tm[0]!.projects[0]!.stale).toBeUndefined()
  })

  it('a forced recovery that builds no project keeps the previous TM', async () => {
    const files: Record<string, Buffer | number> = { [apiUrl('wp/dev')]: api(2), [exportUrl('wp/dev', TR)]: po([['A', 'B'], ['C', 'D']]) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    files[exportUrl('wp/dev', TR)] = 503
    const damaged: Previous = { ...previousFrom(r1), units: new Map(), problems: ['tr_TR: units file HTTP 502'] }
    const r2 = await runBuild(input({ repo: repo([]), previous: damaged, force: true, tag: 'data-20261023-030000', now: new Date('2026-10-23T03:00:00Z') }), client(files))
    expect(r2.manifest.tm).toEqual(r1.manifest.tm)
    expect(r2.state.locales['tr_TR']).toEqual(r1.state.locales['tr_TR'])
    expect(r2.red).toContain('tr_TR: no project could be built; the previous TM stays')
    expect(r2.assets.has('tr_TR.tmx.gz')).toBe(false)
    expect(selfCheck(r2.assets, r2.manifest, r2.state, 'data-20261023-030000')).toEqual([])
  })

  it('drops a locale without tm.yaml', async () => {
    const files = { [apiUrl('wp/dev')]: api(1), [exportUrl('wp/dev', TR)]: po([['A', 'B']]) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(files))
    const noTm = repo([])
    noTm.locales.set('tr_TR', { ...noTm.locales.get('tr_TR')!, tm: undefined })
    const r2 = await runBuild(input({ repo: noTm, previous: previousFrom(r1), rebuild: [] }), client(files))
    expect(r2.manifest.tm).toEqual([])
    expect(r2.state.locales).toEqual({})
  })

  it('a project with no set for the locale is left out without a download', async () => {
    const c = client({ [apiUrl('wp/dev')]: Buffer.from(JSON.stringify({ translation_sets: [] })) })
    const r = await runBuild(input({ repo: repo([]) }), c)
    expect(c.calls.some((u) => u.includes('export-translations'))).toBe(false)
    expect(r.red).toEqual(['tr_TR wp/dev: left out (no translation set for this locale)', 'tr_TR: no project left'])
  })

  it('leaves a failing rules file out and turns red', async () => {
    const bytes = Buffer.from('schema: 2\n')
    const bad = { file: 'x', items: { regexes: [], fixes: [], prompts: [], whens: [] }, findings: [{ level: 'error' as const, check: 'redos', message: 'patterns[0].find: ReDoS check says vulnerable' }], schema: 2 }
    const good = { ...bad, findings: [] }
    const files = { [apiUrl('wp/dev')]: api(1), [exportUrl('wp/dev', TR)]: po([['A', 'B']]) }
    const r1 = await runBuild(input({ repo: repo([]), rules: new Map([['tr_TR', { bytes, check: good }]]) }), client(files))
    expect(r1.manifest.rules).toEqual([{ locale: 'tr_TR', slug: 'tr', url: 'https://github.com/emreerkan/polyglots-data/releases/download/data-20261016-030000/tr_TR.rules.yaml', sha512: sha512(bytes), schema: 2, minPolyglots: '1.0.0', status: 'maintained', maintainers: ['emre'] }])
    // No previous entry: the locale is left out.
    const r2 = await runBuild(input({ repo: repo([]), rules: new Map([['tr_TR', { bytes, check: bad }]]) }), client(files))
    expect(r2.manifest.rules).toEqual([])
    expect(r2.red).toEqual(['tr_TR rules: patterns[0].find: ReDoS check says vulnerable'])
    // A previous entry exists: it stays, pointing at the older asset, and no new asset is written.
    const r3 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), tag: 'data-20261023-030000', now: new Date('2026-10-23T03:00:00Z'), rules: new Map([['tr_TR', { bytes: Buffer.from('schema: 2\n# new\n'), check: bad }]]) }), client(files))
    expect(r3.manifest.rules).toEqual(r1.manifest.rules)
    expect(r3.assets.has('tr_TR.rules.yaml')).toBe(false)
    expect(r3.red).toEqual(['tr_TR rules: patterns[0].find: ReDoS check says vulnerable'])
    expect(selfCheck(r3.assets, r3.manifest, r3.state, 'data-20261023-030000')).toEqual([])
  })

  describe('rules at several schemas', () => {
    const files = { [apiUrl('wp/dev')]: api(1), [exportUrl('wp/dev', TR)]: po([['A', 'B']]) }
    const check = (schema: number, error?: string) => ({
      file: 'x', items: { regexes: [], fixes: [], prompts: [], whens: [] }, schema,
      findings: error ? [{ level: 'error' as const, check: 'downlevel', message: error }] : [],
    })
    const three = Buffer.from('schema: 3\n')
    const two = Buffer.from('# Generated\nschema: 2\n')
    const url = (tag: string, name: string) => `https://github.com/emreerkan/polyglots-data/releases/download/${tag}/${name}`

    it('puts the older schema first, each with its own minPolyglots', async () => {
      const r = await runBuild(input({ repo: repo([]), minPolyglots: '1.2.0', rules: new Map([['tr_TR', { bytes: three, check: check(3), older: [{ schema: 2, bytes: two, check: check(2) }] }]]) }), client(files))
      expect(r.manifest.rules).toEqual([
        { locale: 'tr_TR', slug: 'tr', url: url('data-20261016-030000', 'tr_TR.rules.schema2.yaml'), sha512: sha512(two), schema: 2, minPolyglots: '1.0.0', status: 'maintained', maintainers: ['emre'] },
        { locale: 'tr_TR', slug: 'tr', url: url('data-20261016-030000', 'tr_TR.rules.yaml'), sha512: sha512(three), schema: 3, minPolyglots: '1.2.0', status: 'maintained', maintainers: ['emre'] },
      ])
      expect(r.red).toEqual([])
      expect(selfCheck(r.assets, r.manifest, r.state, 'data-20261016-030000')).toEqual([])
    })

    it('gives a schema 2 file the schema 2 minimum, whatever the pin', async () => {
      const r = await runBuild(input({ repo: repo([]), minPolyglots: '1.2.0', rules: new Map([['tr_TR', { bytes: two, check: check(2) }]]) }), client(files))
      expect(r.manifest.rules.map((e) => [e.schema, e.minPolyglots])).toEqual([[2, '1.0.0']])
    })

    it('keeps the previous older row when the older file fails, and still publishes the newest', async () => {
      const ok = await runBuild(input({ repo: repo([]), minPolyglots: '1.2.0', rules: new Map([['tr_TR', { bytes: three, check: check(3), older: [{ schema: 2, bytes: two, check: check(2) }] }]]) }), client(files))
      const tag = 'data-20261023-030000'
      const r = await runBuild(input({
        repo: repo([]), minPolyglots: '1.2.0', previous: previousFrom(ok), tag, now: new Date('2026-10-23T03:00:00Z'),
        rules: new Map([['tr_TR', { bytes: Buffer.from('schema: 3\n# new\n'), check: check(3), older: [{ schema: 2, bytes: Buffer.alloc(0), check: check(2, 'schema 2 version: broken') }] }]]),
      }), client(files))
      expect(r.manifest.rules.map((e) => [e.schema, e.url])).toEqual([[2, url('data-20261016-030000', 'tr_TR.rules.schema2.yaml')], [3, url(tag, 'tr_TR.rules.yaml')]])
      expect(r.assets.has('tr_TR.rules.schema2.yaml')).toBe(false)
      expect(r.red).toEqual(['tr_TR rules: schema 2 version: broken'])
      expect(selfCheck(r.assets, r.manifest, r.state, tag)).toEqual([])
    })

    it('keeps every previous row when the newest file fails', async () => {
      const ok = await runBuild(input({ repo: repo([]), minPolyglots: '1.2.0', rules: new Map([['tr_TR', { bytes: three, check: check(3), older: [{ schema: 2, bytes: two, check: check(2) }] }]]) }), client(files))
      const r = await runBuild(input({ repo: repo([]), previous: previousFrom(ok), tag: 'data-20261023-030000', now: new Date('2026-10-23T03:00:00Z'), rules: new Map([['tr_TR', { bytes: three, check: check(3, 'bad') }]]) }), client(files))
      expect(r.manifest.rules).toEqual(ok.manifest.rules)
    })
  })
})

describe('publish rules', () => {
  const files = () => ({ [apiUrl('wp/dev')]: api(2), [exportUrl('wp/dev', TR)]: po([['Post', 'Yazı'], ['Shared', 'Ortak']]) })
  const later = new Date('2026-10-23T03:00:00Z')

  it('does not publish when the previous release had problems', async () => {
    const r1 = await runBuild(input({ repo: repo([]) }), client(files()))
    const a = await runBuild(input({ repo: repo([]), rebuild: [], previous: { ...previousFrom(r1), index: undefined, problems: ['index.json: HTTP 502'] } }), client(files()))
    expect(a.publish).toBe(false)
    expect(a.red).toContain('previous release: index.json: HTTP 502')
    const b = await runBuild(input({ repo: repo([]), previous: { ...previousFrom(r1), problems: ['tr_TR units: bad'] }, now: later }), client(files()))
    expect(b.publish).toBe(false)
  })

  it('a 404 on index.json outside the first run blocks the publish', async () => {
    const lost: Previous = { first: false, state: { schema: 1, locales: {} }, units: new Map(), problems: ['index.json: HTTP 404'] }
    const r = await runBuild(input({ repo: repo([]), previous: lost }), client(files()))
    expect(r.publish).toBe(false)
    expect(r.red).toContain('previous release: index.json: HTTP 404')
  })

  it('publishes a damaged previous only after a forced full rebuild', async () => {
    const r1 = await runBuild(input({ repo: repo([]) }), client(files()))
    const damaged = { ...previousFrom(r1), index: undefined, problems: ['index.json: HTTP 502'] }
    const ok = await runBuild(input({ repo: repo([]), previous: damaged, force: true, now: later }), client(files()))
    expect(ok.publish).toBe(true)
    expect(ok.red).toContain('previous release: index.json: HTTP 502')
    const partial = await runBuild(input({ repo: repo([]), previous: damaged, force: true, rebuild: [], now: later }), client(files()))
    expect(partial.publish).toBe(false)
  })

  it('ignores the tool version in the TMX', async () => {
    const r1 = await runBuild(input({ repo: repo([]), toolVersion: 'aaa' }), client(files()))
    const r2 = await runBuild(input({ repo: repo([]), toolVersion: 'bbb', previous: previousFrom(r1), now: later }), client(files()))
    expect(r2.manifest.tm[0]!.sha512).toBe(r1.manifest.tm[0]!.sha512)
    expect(r2.publish).toBe(false)
  })

  it('keeps the TMX when a re-download has identical units', async () => {
    const r1 = await runBuild(input({ repo: repo([]) }), client(files()))
    const f = { ...files(), [apiUrl('wp/dev')]: api(2, '2026-10-22 00:00:00') }
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: later }), client(f))
    expect(r2.downloads).toBe(1)
    expect(r2.manifest.tm[0]!.sha512).toBe(r1.manifest.tm[0]!.sha512)
    expect(r2.manifest.tm[0]!.url).toBe(r1.manifest.tm[0]!.url)
    expect(r2.manifest.tm[0]!.built).toBe(now.toISOString())
    expect(r2.state.locales['tr_TR']!.projects['wp/dev']!.built).toBe(later.toISOString())
    expect(r2.publish).toBe(true)
  })

  it('does not publish for a project that stays stale', async () => {
    const f: Record<string, Buffer | number> = { [apiUrl('wp/dev')]: api(60), [exportUrl('wp/dev', TR)]: po(units(60)) }
    const r1 = await runBuild(input({ repo: repo([]) }), client(f))
    f[apiUrl('wp/dev')] = api(61, '2026-10-20 00:00:00')
    f[exportUrl('wp/dev', TR)] = 503
    const r2 = await runBuild(input({ repo: repo([]), previous: previousFrom(r1), now: later }), client(f))
    expect(r2.publish).toBe(true)
    const r3 = await runBuild(input({ repo: repo([]), previous: { ...previousFrom(r2), units: previousFrom(r1).units }, now: new Date('2026-10-24T03:00:00Z') }), client(f))
    expect(r3.downloads).toBe(1)
    expect(r3.publish).toBe(false)
  })
})

/** What loadPrevious would return after r was published. */
function previousFrom(r: Awaited<ReturnType<typeof runBuild>>): Previous {
  const unitsMap = new Map<string, Map<string, { built: string; units: { source: string; context: string; target: string }[] }>>()
  for (const [code, loc] of Object.entries(r.state.locales)) {
    const file = [...r.assets.entries()].find(([name]) => name === `${code}.units.json.gz`)?.[1]
    if (!file) continue
    const f = JSON.parse(gunzipSync(file).toString()) as { projects: Record<string, { built: string; units: [string, string, string][] }> }
    unitsMap.set(code, new Map(Object.entries(f.projects).map(([p, v]) => [p, { built: v.built, units: v.units.map(([source, context, target]) => ({ source, context, target })) }])))
    expect(loc.sha512).toBe(sha512(file))
  }
  return { first: false, index: r.manifest, state: r.state, units: unitsMap, problems: [] }
}
