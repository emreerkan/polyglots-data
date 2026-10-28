import { describe, expect, it } from 'vitest'
import { MAX_ATTENTION_LINES, renderReport, type ReportData } from '../src/build/report.js'

const data = (over: Partial<ReportData> = {}): ReportData => ({
  toolVersion: 'abc', publish: true, downloads: 1, red: [], warnings: [],
  manifest: { schema: 1, generated: 'g', rules: [], tm: [{ locale: 'tr_TR', slug: 'tr', url: 'u', bytes: 1, bytesUncompressed: 1, sha512: 's', units: 1, built: 'b', projects: [{ path: 'wp/dev', units: 1, stale: 'x' }] }] },
  log: [{ locale: 'tr_TR', path: 'wp/dev', action: 'stale', units: 1, note: 'parse: <img src=x> | ## a\n- b' }],
  ...over,
})

describe('renderReport', () => {
  it('escapes notes and red lines', () => {
    const out = renderReport(data({ red: ['tr_TR wp/dev: left out (<b>|x</b>\n## Injected)'] }), 'data-20261016-030000')
    expect(out).toContain('parse: \\<img src=x\\> \\| \\#\\# a \\- b')
    expect(out).toContain('- tr\\_TR wp/dev: left out \\(\\<b\\>\\|x\\</b\\> \\#\\# Injected\\)')
    expect(out).not.toMatch(/^## Injected/m)
    expect(out).not.toContain('<b>')
  })

  it('lists warnings apart from what needs attention', () => {
    const out = renderReport(data({ warnings: ['tr_TR wp-plugins/a/dev: 85% translated, under the 90% a TM project needs'] }), 't', 'short')
    expect(out).toContain('## Warnings\n\n- tr\\_TR wp\\-plugins/a/dev: 85% translated')
    expect(out).not.toContain('## Needs attention')
    expect(renderReport(data(), 't')).not.toContain('## Warnings')
  })

  it('short mode has no Projects table', () => {
    const out = renderReport(data(), 't', 'short')
    expect(out).toContain('## TM')
    expect(out).toContain('## Rules')
    expect(out).not.toContain('## Projects')
    expect(renderReport(data(), 't')).toContain('## Projects')
  })

  it('caps the needs-attention list', () => {
    const red = Array.from({ length: MAX_ATTENTION_LINES + 5 }, (_, i) => `line ${i}`)
    const out = renderReport(data({ red }), 't', 'short')
    expect(out.match(/^- line /gm)).toHaveLength(MAX_ATTENTION_LINES)
    expect(out).toContain('- … and 5 more')
  })
})
