import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRulesFile, loadRulesContext } from '../src/rules/check.js'

const root = join(import.meta.dirname, '..')
const ctx = { ...loadRulesContext(root), bin: join(import.meta.dirname, 'fixtures/fake-polyglots.mjs') }
const tmp = (text: string) => { const d = mkdtempSync(join(tmpdir(), 'pd-')); const f = join(d, 'rules.yaml'); writeFileSync(f, text); return f }

describe('checkRulesFile', () => {
  it('passes every committed rules file', async () => {
    for (const l of ['tr_TR', 'sv_SE', 'el', 'bo', 'dzo', 'th']) {
      const file = join(root, 'locales', l, 'rules.yaml')
      const r = await checkRulesFile(file, ctx)
      expect(r.findings.filter((f) => f.level === 'error'), l).toEqual([])
      expect(r.schema, l).toBe(Number(/^schema: (\d+)$/m.exec(readFileSync(file, 'utf8'))![1]))
    }
  }, 120_000)

  it('reports polyglots invalid with the line', async () => {
    const r = await checkRulesFile(tmp('schema: 2\nINVALID: 1\n'), ctx)
    expect(r.findings).toContainEqual(expect.objectContaining({ level: 'error', check: 'polyglots', message: 'line 2: unknown key INVALID' }))
  })

  it('reports a dangerous fix and a URL', async () => {
    const r = await checkRulesFile(tmp('schema: 2\nguidance: See https://x.org\npatterns:\n  - find: "(.+)"\n    replace: "$1"\n    level: fix\n'), ctx)
    expect(r.findings.map((f) => f.check)).toEqual(expect.arrayContaining(['prompt', 'fix']))
  })

  it('reports YAML that does not parse', async () => {
    const r = await checkRulesFile(tmp('schema: [\n'), ctx)
    expect(r.findings[0]).toMatchObject({ level: 'error', check: 'yaml' })
  })
})
