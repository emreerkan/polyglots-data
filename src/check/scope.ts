import type { Finding } from '../findings.js'

export const REPO_MAINTAINER = 'emreerkan'

export function scopeFindings(files: string[], author: string): { findings: Finding[]; locale?: string } {
  const findings: Finding[] = []
  const locales = [...new Set(files.map((f) => /^locales\/([^/]+)\//.exec(f)?.[1]).filter((x): x is string => !!x))].sort()
  const outside = files.filter((f) => !/^locales\/[^/]+\//.test(f))
  if (locales.length > 1 && author !== REPO_MAINTAINER) findings.push({ level: 'error', check: 'scope', message: `the pull request changes more than one locale: ${locales.join(', ')}` })
  if (outside.length && author !== REPO_MAINTAINER) findings.push({ level: 'error', check: 'scope', message: `only the repository maintainer changes files outside locales/: ${outside.join(', ')}` })
  return { findings, ...(locales.length === 1 ? { locale: locales[0] } : {}) }
}
