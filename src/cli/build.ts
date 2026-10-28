import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadPrevious } from '../build/previous.js'
import { renderReport } from '../build/report.js'
import { runBuild } from '../build/run.js'
import { selfCheck } from '../build/selfcheck.js'
import { loadRepo } from '../config/load.js'
import { loadWpLocales } from '../locales.js'
import { LATEST } from '../manifest.js'
import { checkOlderRules, checkRulesFile, loadRulesContext, type OlderRules } from '../rules/check.js'
import { OLDEST_SCHEMA } from '../rules/downlevel.js'
import { createClient } from '../wporg/client.js'
import { buildArgErrors, localesFromChanges, parseList } from './args.js'

const root = process.cwd()
const { values } = parseArgs({
  options: {
    locale: { type: 'string', multiple: true }, 'changed-from': { type: 'string' }, force: { type: 'boolean', default: false },
    accept: { type: 'string', multiple: true }, tag: { type: 'string' }, out: { type: 'string', default: 'dist' },
    'previous-base': { type: 'string', default: LATEST }, 'first-run': { type: 'boolean', default: false },
  },
})
if (!values.tag || !/^data-\d{8}-\d{6}$/.test(values.tag)) throw new Error('--tag data-YYYYMMDD-HHMMSS is required')

const wp = loadWpLocales(root)
const { repo, issues } = loadRepo(root, wp)
if (issues.length) {
  for (const i of issues) console.error(`${i.file}: ${i.message}`)
  process.exit(1)
}
const withTm = [...repo.locales.values()].filter((l) => l.tm).map((l) => l.code)
const out = values.out ?? 'dist'
const accept = parseList(values.accept)
let rebuild = parseList(values.locale)
const argErrors = buildArgErrors({ root, out, locales: rebuild, accept, changedFrom: values['changed-from'], withTm })
if (argErrors.length) {
  for (const e of argErrors) console.error(e)
  process.exit(1)
}
if (rebuild.length === 0 && values['changed-from'] && !/^0+$/.test(values['changed-from'])) {
  const files = execFileSync('git', ['diff', '--name-only', values['changed-from'], 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  rebuild = localesFromChanges(files, withTm)
} else if (rebuild.length === 0) {
  rebuild = withTm
}

const ctx = loadRulesContext(root)
const rules = new Map<string, { bytes: Buffer; check: Awaited<ReturnType<typeof checkRulesFile>>; older?: OlderRules[] }>()
for (const l of repo.locales.values()) {
  if (!l.rulesFile) continue
  const check = await checkRulesFile(l.rulesFile, ctx)
  const failed = check.findings.some((f) => f.level === 'error')
  const older = !failed && (check.schema ?? 0) > OLDEST_SCHEMA ? await checkOlderRules(l.rulesFile, check.schema!, ctx) : undefined
  rules.set(l.code, { bytes: readFileSync(l.rulesFile), check, ...(older ? { older } : {}) })
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }
const minPolyglots = pkg.devDependencies?.polyglots
if (!minPolyglots || !/^\d+\.\d+\.\d+$/.test(minPolyglots)) throw new Error('package.json must pin polyglots to an exact version')
const toolVersion = (process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim().slice(0, 12)

const github = createClient({ host: 'github.com', delayMs: 0, timeoutMs: 120_000 })
const previous = await loadPrevious(github, { firstRun: values['first-run'] ?? false, base: values['previous-base'] })
const result = await runBuild({
  repo, wp, previous, rebuild, force: values.force ?? false, accept: new Set(accept),
  tag: values.tag, toolVersion, minPolyglots, rules, now: new Date(),
}, createClient())

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'release'), { recursive: true })
for (const [name, bytes] of result.assets) writeFileSync(join(out, 'release', name), bytes)
const problems = selfCheck(result.assets, result.manifest, result.state, values.tag)
const red = [...result.red, ...problems.map((p) => `self-check: ${p}`)]
const publish = result.publish && problems.length === 0
writeFileSync(join(out, 'report.md'), renderReport({ ...result, red, publish }, values.tag, 'full'))
writeFileSync(join(out, 'notes.md'), renderReport({ ...result, red, publish }, values.tag, 'short'))
writeFileSync(join(out, 'outcome.json'), JSON.stringify({ tag: values.tag, publish, red }, null, 2) + '\n')
console.log(`build ${values.tag}: rebuilt ${rebuild.join(', ') || 'none'}; ${result.downloads} exports; publish ${publish}; red ${red.length}`)
process.exit(problems.length ? 1 : 0)
