import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { approvalLines } from '../check/approval.js'
import { changedFiles, isFullSha, showFile } from '../check/git.js'
import { getFileAtRef, listPrFiles, listReviews } from '../check/github.js'
import { addedPaths, newPathFindings, newPathsCap } from '../check/new-paths.js'
import { diffItems } from '../check/rules-diff.js'
import { REPO_MAINTAINER, scopeFindings } from '../check/scope.js'
import { loadRepo, parseLocaleMeta } from '../config/load.js'
import { hasErrors, type Finding } from '../findings.js'
import { loadWpLocales } from '../locales.js'
import { checkRulesFile, loadRulesContext } from '../rules/check.js'
import { polyglotsBin } from '../rules/polyglots.js'
import { fixSamples } from '../rules/fix-safety.js'
import { extractItems } from '../rules/items.js'
import { renderSummary, type Section } from '../summary.js'
import { createClient } from '../wporg/client.js'

const { values } = parseArgs({ options: {
  base: { type: 'string' }, head: { type: 'string' }, author: { type: 'string' },
  approval: { type: 'boolean', default: false }, repo: { type: 'string' }, pr: { type: 'string' },
} })
const write = (md: string) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, md) : process.stdout.write(md))
const root = process.cwd()
/**
 * The checker's own checkout. PR CI runs the base commit's checker against
 * the pull request's tree, so a pull request cannot change the checks it is
 * judged by. Locally the two are the same folder.
 */
const own = join(import.meta.dirname, '..', '..')

const read = (file: string): string => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const tryParse = (text: string): unknown => { try { return YAML.parse(text) } catch { return undefined } }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

if (values.approval) {
  let lines: string[]
  try {
    const repo = values.repo ?? '', base = values.base ?? '', head = values.head ?? ''
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid --repo')
    if (!/^[1-9][0-9]*$/.test(values.pr ?? '')) throw new Error('invalid --pr')
    if (!isFullSha(base) || !isFullSha(head)) throw new Error('invalid --base/--head')
    const pr = Number(values.pr)
    const token = process.env.GITHUB_TOKEN ?? ''
    const files = await listPrFiles(repo, pr, token)
    const { locale } = scopeFindings(files, '')
    if (locale && loadWpLocales(root).has(locale)) {
      const text = await getFileAtRef(repo, `locales/${locale}/locale.yaml`, base, token)
      const meta = text ? parseLocaleMeta(text, 'locale.yaml').meta : undefined
      lines = approvalLines(await listReviews(repo, pr, token), meta?.maintainers ?? [], locale, head)
    } else {
      lines = ['No single known locale changed; the repository maintainer reviews it.']
    }
  } catch (e) {
    lines = [`Approval status unavailable: ${message(e)}`]
  }
  write(renderSummary([{ title: 'Approval', lines }]))
  process.exit(0)
}

const sections: Section[] = []
let failed = false
try {
  if (!isFullSha(values.base) || !isFullSha(values.head)) throw new Error('--base and --head must be full commit shas')
  const base = values.base, head = values.head, author = values.author ?? ''
  const files = changedFiles(base, head)
  const wp = loadWpLocales(root)

  // 2. Scope
  const scope = scopeFindings(files, author)
  sections.push({ title: 'Scope', findings: scope.findings, lines: [`Changed files: ${files.length}.`] })

  // 1. Schema (whole tree at head)
  const { repo, issues } = loadRepo(root, wp)
  sections.push({ title: 'Data files', findings: issues.map((i) => ({ level: 'error', check: 'schema', file: i.file.replace(root + '/', ''), message: i.message })) })

  // 3. New paths
  const tmLocales = [...repo.locales.values()].filter((l) => l.tm).map((l) => ({ code: l.code, ...wp.get(l.code)! }))
  const added: Array<{ path: string; locales: typeof tmLocales }> = []
  for (const f of files) {
    const m = /^locales\/([^/]+)\/tm\.yaml$/.exec(f)
    if (f === 'core/tm.yaml') for (const p of addedPaths(showFile(base, f), read(join(root, f)))) added.push({ path: p, locales: tmLocales })
    else if (m?.[1] && wp.has(m[1])) for (const p of addedPaths(showFile(base, f), read(join(root, f)))) added.push({ path: p, locales: tmLocales.filter((l) => l.code === m[1]) })
  }
  const client = createClient()
  const np: { findings: Finding[]; lines: string[] } = { findings: [], lines: [] }
  const cap = newPathsCap(added.length, author)
  if (cap) np.findings.push(cap)
  else if (author === REPO_MAINTAINER) np.lines.push(...(await newPathFindings(added.map((a) => a.path), [], client, author)).lines)
  else for (const a of added) { const r = await newPathFindings([a.path], a.locales, client); np.findings.push(...r.findings); np.lines.push(...r.lines) }
  sections.push({ title: 'New projects', findings: np.findings, lines: np.lines.length ? np.lines : added.length ? [] : ['No new project.'] })

  // 4, 5, 7. Rules
  // Others are checked with the base's polyglots; the maintainer's pull
  // request may move the pin, and is checked with its own.
  const ctx = { ...loadRulesContext(root), ...(author === REPO_MAINTAINER ? {} : { bin: polyglotsBin(own) }) }
  for (const f of files.filter((x) => /^locales\/[^/]+\/rules\.yaml$/.test(x))) {
    let headText: string
    try { headText = readFileSync(join(root, f), 'utf8') } catch { sections.push({ title: `Rules: ${f}`, lines: ['Removed.'] }); continue }
    const r = await checkRulesFile(join(root, f), ctx)
    const baseText = showFile(base, f)
    const baseDoc = baseText ? tryParse(baseText) : undefined
    const headDoc = tryParse(headText)
    const lines: string[] = []
    if (headDoc !== undefined) {
      const changes = diffItems(baseDoc !== undefined ? extractItems(baseDoc) : undefined, extractItems(headDoc))
      for (const c of changes) lines.push(`${c.change} ${c.kind} ${c.where}: ${c.text.slice(0, 300)}`)
    }
    for (const fx of r.items.fixes) for (const s of fixSamples(fx, ctx.corpus)) lines.push(`sample ${fx.where}: "${s.before}" → "${s.after}"`)
    sections.push({ title: `Rules: ${f}`, findings: r.findings.map((x) => ({ ...x, file: f })), lines })
  }
} catch (e) {
  failed = true
  sections.push({ title: 'Check error', findings: [{ level: 'error', check: 'run', message: message(e) }] })
}

write(renderSummary(sections))
const all = sections.flatMap((s) => s.findings ?? [])
process.exit(failed || hasErrors(all) ? 1 : 0)
