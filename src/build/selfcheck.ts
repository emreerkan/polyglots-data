import { isDeepStrictEqual } from 'node:util'
import { XMLValidator } from 'fast-xml-parser'
import { gunzipSync } from 'node:zlib'
import YAML from 'yaml'
import { releaseUrl, type Manifest } from '../manifest.js'
import { sha512, type State } from './state.js'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Spec 5.9: re-read every file this run wrote and check it against the
 * manifest. Entries carried over from an older release point at that
 * release's assets and are not checked here. Nothing here throws: a broken
 * asset is a problem, never a crash.
 */
export function selfCheck(assets: Map<string, Buffer>, manifest: Manifest, state: State, tag: string): string[] {
  const problems: string[] = []
  const prefix = releaseUrl(tag, '')
  const own = (url: string) => url.startsWith(prefix)
  const asset = (url: string) => assets.get(url.slice(prefix.length))
  const guard = (what: string, fn: () => void) => {
    try {
      fn()
    } catch (err) {
      problems.push(`${what}: ${message(err)}`)
    }
  }
  for (const e of manifest.tm.filter((x) => own(x.url))) {
    guard(`${e.locale}: TMX`, () => {
      const gz = asset(e.url)
      if (!gz) { problems.push(`${e.locale}: TMX asset missing`); return }
      if (gz.length !== e.bytes) problems.push(`${e.locale}: bytes ${gz.length} ≠ ${e.bytes}`)
      if (sha512(gz) !== e.sha512) problems.push(`${e.locale}: sha512 mismatch`)
      const xml = gunzipSync(gz)
      if (xml.length !== e.bytesUncompressed) problems.push(`${e.locale}: bytesUncompressed ${xml.length} ≠ ${e.bytesUncompressed}`)
      const text = xml.toString('utf8')
      if (XMLValidator.validate(text) !== true) problems.push(`${e.locale}: TMX is not well-formed XML`)
      const tus = text.match(/<tu>/g)?.length ?? 0
      if (tus !== e.units) problems.push(`${e.locale}: ${tus} <tu> ≠ units ${e.units}`)
    })
  }
  for (const e of manifest.rules.filter((x) => own(x.url))) {
    guard(`${e.locale}: rules schema ${e.schema}`, () => {
      const b = asset(e.url)
      if (!b) { problems.push(`${e.locale}: rules schema ${e.schema} asset missing`); return }
      if (sha512(b) !== e.sha512) problems.push(`${e.locale}: rules schema ${e.schema} sha512 mismatch`)
      const schema = (YAML.parse(b.toString('utf8')) as { schema?: unknown } | null)?.schema
      if (schema !== e.schema) problems.push(`${e.locale}: rules schema ${String(schema)} ≠ ${e.schema}`)
    })
  }
  for (const [code, loc] of Object.entries(state.locales).filter(([, l]) => own(l.units))) {
    guard(`${code}: units file`, () => {
      const b = asset(loc.units)
      if (!b || sha512(b) !== loc.sha512) problems.push(`${code}: units file missing or sha512 mismatch`)
    })
  }
  for (const [name, expected] of [['index.json', manifest], ['state.json', state]] as const) {
    guard(name, () => {
      const b = assets.get(name)
      if (!b) { problems.push(`${name} missing`); return }
      if (!isDeepStrictEqual(JSON.parse(b.toString('utf8')), JSON.parse(JSON.stringify(expected)))) problems.push(`${name} does not match the ${name === 'index.json' ? 'manifest' : 'state'}`)
    })
  }
  return problems
}
