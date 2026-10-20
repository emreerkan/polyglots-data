import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import YAML from 'yaml'
import type { Finding } from '../findings.js'
import { adversarialStrings } from './adversarial.js'
import { loadCorpus } from './corpus.js'
import { downlevels, OLDEST_SCHEMA } from './downlevel.js'
import { dynamicFixFindings, staticFixFindings } from './fix-safety.js'
import { extractItems, type RulesItems } from './items.js'
import { intlTag } from './literal.js'
import { loadWpLocales, type WpLocales } from '../locales.js'
import { polyglotsBin, polyglotsFindings, runPolyglotsCheck } from './polyglots.js'
import { promptFindings } from './prompt-text.js'
import { recheckFindings, staticRegexFindings } from './regex-safety.js'
import { timeRegexes } from './regex-timing.js'

export interface RulesContext { corpus: string[]; allowlist: Set<string>; bin: string; wp?: WpLocales }
export interface RulesCheckResult { file: string; findings: Finding[]; items: RulesItems; schema?: number }
/** A rules file lowered to an older schema, checked as it will be published. */
export interface OlderRules { schema: number; bytes: Buffer; check: RulesCheckResult }

export function loadRulesContext(root: string): RulesContext {
  const files = [join(root, 'test', 'fixtures', 'tr_TR.tmx.gz')]
  const extra = join(root, 'test', 'fixtures', 'corpus')
  if (existsSync(extra)) for (const f of readdirSync(extra)) if (f.endsWith('.txt')) files.push(join(extra, f))
  const allowlist = new Set(JSON.parse(readFileSync(join(root, 'data', 'regex-allowlist.json'), 'utf8')) as string[])
  return { corpus: loadCorpus(files), allowlist, bin: polyglotsBin(root), wp: loadWpLocales(root) }
}

/** Spec 7, checks 4 and 5, for one rules file. Used by PR CI and by the build before publishing. */
export async function checkRulesFile(file: string, ctx: RulesContext): Promise<RulesCheckResult> {
  const empty: RulesItems = { regexes: [], fixes: [], prompts: [], whens: [] }
  let doc: unknown
  try {
    doc = YAML.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { file, items: empty, findings: [{ level: 'error', check: 'yaml', file, message: err instanceof Error ? err.message : String(err) }] }
  }
  const pg = await runPolyglotsCheck(file, ctx.bin)
  const findings: Finding[] = polyglotsFindings(pg, file)
  // locales/<code>/rules.yaml: polyglots keys casing by the translate.wordpress.org slug.
  const code = basename(dirname(file))
  const items = extractItems(doc, intlTag(ctx.wp?.get(code)?.slug ?? code))
  const staticRegex = staticRegexFindings(items.regexes, file)
  findings.push(...staticRegex)
  const broken = new Set(staticRegex.map((f) => f.message.split(':')[0]))
  const runnable = items.regexes.filter((r) => !broken.has(r.where))
  findings.push(...(await recheckFindings(runnable, ctx.allowlist, file)))
  findings.push(...(await timeRegexes(runnable, ctx.corpus, file)))
  findings.push(...staticFixFindings(items.fixes, file))
  // A fix whose regex failed the ReDoS or time check is not run again here.
  const slow = new Set(findings.filter((f) => f.check === 'regex-time' || f.check === 'redos').map((f) => f.message.split(':')[0]))
  const runnableFixes = items.fixes.filter((f) => !f.find || runnable.some((r) => r.source === f.find && !slow.has(r.where)))
  const fixStrings = [...ctx.corpus, ...runnableFixes.flatMap((f) => adversarialStrings(f.find ?? f.text ?? ''))]
  findings.push(...dynamicFixFindings(runnableFixes, fixStrings, file))
  findings.push(...promptFindings(items.prompts, file))
  return { file, findings, items, ...(pg.json?.schema !== undefined ? { schema: pg.json.schema } : {}) }
}

/**
 * The file at every older schema the manifest still serves, each checked as
 * its own rules file under locales/<code>/ in a temporary folder, so the
 * casing and the polyglots check see the locale. A conversion that fails is
 * one failing entry at OLDEST_SCHEMA.
 */
export async function checkOlderRules(file: string, schema: number, ctx: RulesContext): Promise<OlderRules[]> {
  const code = basename(dirname(file))
  const empty: RulesItems = { regexes: [], fixes: [], prompts: [], whens: [] }
  let lowered
  try {
    lowered = downlevels(readFileSync(file, 'utf8'), schema)
  } catch (err) {
    const message = `schema ${OLDEST_SCHEMA} version: ${err instanceof Error ? err.message : String(err)}`
    return [{ schema: OLDEST_SCHEMA, bytes: Buffer.alloc(0), check: { file, items: empty, findings: [{ level: 'error', check: 'downlevel', file, message }] } }]
  }
  const dir = mkdtempSync(join(tmpdir(), 'pd-older-'))
  try {
    const out: OlderRules[] = []
    for (const d of lowered) {
      const f = join(dir, String(d.schema), code, 'rules.yaml')
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, d.bytes)
      const check = await checkRulesFile(f, ctx)
      for (const finding of check.findings) finding.message = `schema ${d.schema} version: ${finding.message}`
      if (check.schema !== d.schema && !check.findings.some((x) => x.level === 'error')) {
        check.findings.push({ level: 'error', check: 'downlevel', file, message: `schema ${d.schema} version: polyglots read it as schema ${String(check.schema)}` })
      }
      out.push({ schema: d.schema, bytes: d.bytes, check: { ...check, file } })
    }
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
