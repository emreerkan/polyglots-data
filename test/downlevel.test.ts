import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { downlevels, minPolyglotsFor, OLDEST_SCHEMA } from '../src/rules/downlevel.js'
import { checkOlderRules, loadRulesContext } from '../src/rules/check.js'
import { polyglotsBin, runPolyglotsCheck } from '../src/rules/polyglots.js'

const root = join(import.meta.dirname, '..')
const three = `# polyglots rules for xx
#
# Top comment.

schema: 3

rules:
  enable: [title-case, date-format]
  disable: []

# The date settings.
dateTime:
  clock: 24h
  order: dmy
  formats:
    'F j, Y': 'j F Y'
    'g:i a': 'H:i'

patterns:
  # An existing one.
  - text: 'F j, Y'
    level: hint
    when: { source: 'F j, Y' }
    note: old

guidance: |
  Hello.
`
const lower = (text: string) => downlevels(text, 3).map((d) => ({ schema: d.schema, text: d.bytes.toString() }))
const inLocale = (code: string, text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'pd-dl-')), code, 'rules.yaml')
  mkdirSync(join(f, '..'))
  writeFileSync(f, text)
  return f
}

describe('downlevels', () => {
  it('leaves a file at the oldest schema alone', () => expect(downlevels('schema: 2\n', OLDEST_SCHEMA)).toEqual([]))

  it('refuses a schema it cannot lower', () => expect(() => downlevels('schema: 4\n', 4)).toThrow('no conversion from rules schema 4 to 3'))

  it('turns dateTime into schema 2 hints and keeps the comments', () => {
    const [d, ...rest] = lower(three)
    expect(rest).toEqual([])
    expect(d!.schema).toBe(2)
    const doc = YAML.parse(d!.text) as { schema: number; dateTime?: unknown; rules: { enable: string[] }; patterns: Array<{ text?: string; find?: string; when?: { source: string }; note?: string }> }
    expect(doc.schema).toBe(2)
    expect(doc.dateTime).toBeUndefined()
    expect(doc.rules.enable).toEqual(['title-case'])
    expect(d!.text).toMatch(/^# Generated from the schema 3 file/)
    expect(d!.text).toContain('# Top comment.')
    expect(d!.text).toContain('# An existing one.')
    expect(d!.text).toContain('# From dateTime in the schema 3 file.')
    expect(doc.patterns.map((p) => p.text ?? p.find)).toEqual([
      'F j, Y', // the hand-written one; the generated twin is left out
      '(?<![A-Za-z\\\\])[gh]:i(?![A-Za-z])',
      'g:i a',
      'g:i a', // core writes a non-breaking space before am/pm
    ])
    expect(doc.patterns[3]!.when).toEqual({ source: 'g:i a' })
    expect(doc.patterns[2]!.note).toBe('Use "H:i" for "g:i a"')
  })

  it('takes the 24-hour example from the file', () => {
    const [d] = lower("schema: 3\ndateTime:\n  clock: 24h\n  formats:\n    'g:i a': 'G:i'\n")
    expect((YAML.parse(d!.text) as { patterns: Array<{ note: string }> }).patterns[0]!.note).toBe('Use 24-hour time in a time format, as "G:i" for "g:i a"')
  })

  it('drops names and name-order', () => {
    const [d] = lower('schema: 3\nrules:\n  enable: [name-order]\n  disable: []\nnames:\n  order: family-first\n')
    expect(YAML.parse(d!.text)).toEqual({ schema: 2, rules: { enable: [], disable: [] } })
  })

  it('adds nothing for a 12-hour clock and no formats', () => {
    const [d] = lower('schema: 3\ndateTime:\n  clock: 12h\n')
    expect(YAML.parse(d!.text)).toEqual({ schema: 2 })
  })

  it('is read as a valid schema 2 file by the pinned polyglots', async () => {
    const nl = readFileSync(join(root, 'locales', 'nl_NL', 'rules.yaml'), 'utf8')
      .replace(/^schema: 2$/m, "schema: 3\ndateTime:\n  clock: 24h\n  order: dmy\n  formats:\n    'M j, Y': 'j M Y'\n    'g:i a': 'G:i'")
    const [d] = lower(nl)
    const r = await runPolyglotsCheck(inLocale('nl_NL', d!.text), polyglotsBin(root))
    expect(r.json).toMatchObject({ valid: true, schema: 2 })
  }, 60_000)

  it('names the schema of each row', () => {
    expect(minPolyglotsFor(2, '1.2.0')).toBe('1.0.0')
    expect(minPolyglotsFor(3, '1.2.0')).toBe('1.2.0')
  })
})

describe('checkOlderRules', () => {
  const ctx = { ...loadRulesContext(root), bin: join(import.meta.dirname, 'fixtures/fake-polyglots.mjs') }

  it('checks the lowered file under the locale', async () => {
    const [o, ...rest] = await checkOlderRules(inLocale('tr_TR', three), 3, ctx)
    expect(rest).toEqual([])
    expect(o!.schema).toBe(2)
    expect(o!.check.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(o!.bytes.toString()).toContain('schema: 2')
  }, 60_000)

  it('reports a file it cannot lower as one failing row', async () => {
    const [o] = await checkOlderRules(inLocale('tr_TR', 'schema: 4\n'), 4, ctx)
    expect(o!.schema).toBe(2)
    expect(o!.check.findings[0]).toMatchObject({ level: 'error', check: 'downlevel', message: 'schema 2 version: no conversion from rules schema 4 to 3' })
  })
})
