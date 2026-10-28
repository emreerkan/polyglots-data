import YAML from 'yaml'
import type { Finding } from '../findings.js'
import { isLongText, PATH_RE } from '../paths.js'
import { findSet, parseProjectApi } from '../wporg/api.js'
import type { HttpClient } from '../wporg/client.js'
import { apiUrl } from '../wporg/urls.js'
import { REPO_MAINTAINER } from './scope.js'

export const MAX_NEW_PATHS = 20
/** The share of strings translated and approved that a locale's TM project needs (CONTRIBUTING). */
export const MIN_PERCENT = 90

function paths(text: string | undefined): string[] {
  if (!text) return []
  try {
    const doc = YAML.parse(text) as { projects?: Array<{ path?: unknown }> } | null
    return (doc?.projects ?? []).map((p) => p.path).filter((p): p is string => typeof p === 'string')
  } catch {
    return []
  }
}

/**
 * New project paths in a tm.yaml. A path that fails PATH_RE is already a
 * schema error; it is dropped here so it neither counts towards the cap nor
 * reaches a URL.
 */
export function addedPaths(baseText: string | undefined, headText: string): string[] {
  const before = new Set(paths(baseText))
  return paths(headText).filter((p) => !before.has(p) && PATH_RE.test(p))
}

/**
 * One pull request may add at most MAX_NEW_PATHS paths, so a stranger's pull
 * request cannot make CI hammer translate.wordpress.org. The repository
 * maintainer is not capped, and their paths are not requested at all.
 */
export function newPathsCap(count: number, author: string): Finding | undefined {
  if (count <= MAX_NEW_PATHS || author === REPO_MAINTAINER) return undefined
  return { level: 'error', check: 'new-paths', message: `${count} new paths; at most ${MAX_NEW_PATHS} per pull request, split it` }
}

/** The maintainer checks their own projects; the build reports a path that does not exist. */
function maintainerLine(count: number): string {
  return `${count} new path${count === 1 ? '' : 's'}, not checked on translate.wordpress.org: the repository maintainer checks them`
}

export async function newPathFindings(added: string[], locales: Array<{ code: string; slug: string; set: string }>, client: HttpClient, author = ''): Promise<{ findings: Finding[]; lines: string[] }> {
  const findings: Finding[] = []
  const lines: string[] = []
  const err = (message: string) => findings.push({ level: 'error', check: 'new-paths', message })
  const cap = newPathsCap(added.length, author)
  if (cap) return { findings: [cap], lines }
  if (author === REPO_MAINTAINER) return { findings, lines: added.length ? [maintainerLine(added.length)] : [] }
  for (const path of added) {
    const r = await client.get(apiUrl(path))
    const parsed = r.ok ? parseProjectApi(r.body) : undefined
    if (!r.ok || !parsed?.ok) { err(`${path}: not found on translate.wordpress.org (${r.ok ? 'not a project' : r.error})`); continue }
    for (const l of locales) {
      const set = findSet(parsed.sets, l)
      if (!set || set.currentCount === 0) { err(`${path}, ${l.code}: no approved strings`); continue }
      lines.push(`${path}, ${l.code}: ${set.currentCount.toLocaleString('en')} approved of ${set.allCount.toLocaleString('en')} (${set.percent}%)`)
      if (!isLongText(path) && set.percent < MIN_PERCENT) err(`${path}, ${l.code}: ${set.percent}% approved, at least ${MIN_PERCENT}% is needed`)
    }
  }
  return { findings, lines }
}
