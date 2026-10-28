import { esc } from '../summary.js'
import type { BuildResult } from './run.js'

export const MAX_ATTENTION_LINES = 200

export type ReportData = Pick<BuildResult, 'manifest' | 'log' | 'red' | 'warnings' | 'publish' | 'downloads' | 'toolVersion'>

/**
 * The build report. Every interpolated value is escaped: paths, notes and
 * red lines carry text from translate.wordpress.org and from PRs. The short
 * mode is the release body (no Projects table, which can run to thousands of
 * rows); the full mode goes to the job summary.
 */
export function renderReport(r: ReportData, tag: string, mode: 'full' | 'short' = 'full'): string {
  const lines = [`# Build ${esc(tag)}`, '', `Tool ${esc(r.toolVersion)}`, '', r.publish ? 'Published.' : 'Nothing changed; no release.', '']
  if (r.red.length) {
    const shown = r.red.slice(0, MAX_ATTENTION_LINES)
    lines.push('## Needs attention', '', ...shown.map((x) => `- ${esc(x)}`))
    if (r.red.length > shown.length) lines.push(`- … and ${r.red.length - shown.length} more`)
    lines.push('')
  }
  if (r.warnings.length) {
    const shown = r.warnings.slice(0, MAX_ATTENTION_LINES)
    lines.push('## Warnings', '', ...shown.map((x) => `- ${esc(x)}`))
    if (r.warnings.length > shown.length) lines.push(`- … and ${r.warnings.length - shown.length} more`)
    lines.push('')
  }
  lines.push('## TM', '', '| Locale | Units | Built | Stale projects |', '|---|---:|---|---|')
  for (const e of r.manifest.tm) {
    const stale = e.projects.filter((p) => p.stale).map((p) => esc(p.path)).join(', ') || '–'
    lines.push(`| ${esc(e.locale)} | ${e.units.toLocaleString('en')} | ${esc(e.built)} | ${stale} |`)
  }
  lines.push('', `Exports downloaded: ${r.downloads}.`, '')
  if (mode === 'full') {
    lines.push('## Projects', '', '| Locale | Path | Action | Units | Note |', '|---|---|---|---:|---|')
    for (const p of r.log) lines.push(`| ${esc(p.locale)} | ${esc(p.path)} | ${p.action} | ${p.units} | ${esc(p.note ?? '')} |`)
    lines.push('')
  }
  lines.push('## Rules', '', ...r.manifest.rules.map((e) => `- ${esc(e.locale)}: schema ${e.schema}, ${esc(e.status)}`), '')
  return lines.join('\n')
}
