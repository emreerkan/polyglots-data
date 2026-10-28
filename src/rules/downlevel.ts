import YAML, { isMap, isScalar, isSeq, type Document } from 'yaml'

/**
 * The oldest rules schema the manifest still serves. A rules file newer than
 * this is also published at every schema from here up to its own, so a
 * client that cannot read the newest file keeps getting updates. Raise it
 * when the clients that read only the older schema are gone.
 */
export const OLDEST_SCHEMA = 2

/**
 * The first polyglots release that reads each schema: the minPolyglots of a
 * row at that schema. A schema missing here is new with the pinned version,
 * and its rows take the pin.
 */
export const SCHEMA_MIN_POLYGLOTS: Readonly<Record<number, string>> = { 2: '1.0.0', 3: '1.2.0' }

export function minPolyglotsFor(schema: number, pin: string): string {
  return SCHEMA_MIN_POLYGLOTS[schema] ?? pin
}

export interface Downlevel { schema: number; bytes: Buffer }

/** The rule names schema 3 added; a schema 2 reader refuses them in rules.enable and rules.disable. */
const SCHEMA_3_RULES = ['date-format', 'name-order']
const NBSP = ' '
const CLOCK_24H_FIND = '(?<![A-Za-z\\\\])[gh]:i(?![A-Za-z])'

interface Pattern { text?: string; find?: string; level?: string; note?: string; when?: { source?: string; notSource?: string } }

/**
 * Every older schema this file is also published at, from OLDEST_SCHEMA up
 * to one below its own, each as the bytes to publish. Comments are kept. A
 * file at OLDEST_SCHEMA or below has none; a schema this build cannot lower
 * throws, and the build reports it.
 */
export function downlevels(text: string, schema: number): Downlevel[] {
  const out: Downlevel[] = []
  let current = text
  for (let s = schema; s > OLDEST_SCHEMA; s--) {
    if (s !== 3) throw new Error(`no conversion from rules schema ${s} to ${s - 1}`)
    current = threeToTwo(current)
    out.unshift({ schema: s - 1, bytes: Buffer.from(current) })
  }
  return out
}

/**
 * Schema 3 to 2: dateTime goes, and what a schema 2 file can say of it
 * becomes hints. clock: 24h is the 12-hour time hint; each formats entry is a
 * hint on the copied source, and again with the non-breaking space core
 * writes before am/pm ("g:i\u00a0a"), which a plain space does not match. order has no schema 2 form
 * beyond those entries. names has no schema 2 form and goes. date-format and
 * name-order leave rules.enable and rules.disable.
 */
function threeToTwo(text: string): string {
  const doc = YAML.parseDocument(text)
  if (doc.errors.length) throw new Error(`rules file does not parse: ${doc.errors[0]!.message}`)
  const dateTime = (doc.toJS() as { dateTime?: { clock?: string; formats?: Record<string, string> } } | null)?.dateTime
  doc.delete('dateTime')
  doc.delete('names')
  for (const key of ['enable', 'disable']) {
    const seq = doc.getIn(['rules', key], true)
    if (isSeq(seq)) seq.items = seq.items.filter((i) => !(isScalar(i) && SCHEMA_3_RULES.includes(i.value as string)))
  }
  const added = datePatterns(dateTime)
  if (added.length) appendPatterns(doc, added)
  doc.set('schema', 2)
  const header = ` Generated from the schema 3 file for polyglots releases that read schema 2.\n Edit the schema 3 file, not this one.`
  doc.commentBefore = doc.commentBefore ? `${header}\n\n${doc.commentBefore}` : header
  return doc.toString({ lineWidth: 0 })
}

function datePatterns(dateTime: { clock?: string; formats?: Record<string, string> } | undefined): Pattern[] {
  if (!dateTime) return []
  const out: Pattern[] = []
  if (dateTime.clock === '24h') {
    const example = dateTime.formats?.['g:i a'] ?? 'H:i'
    out.push({ find: CLOCK_24H_FIND, level: 'hint', when: { source: ':i' }, note: `Use 24-hour time in a time format, as "${example}" for "g:i a"` })
  }
  for (const [source, target] of Object.entries(dateTime.formats ?? {})) {
    const core = source.replace(/ (?=[aA](?![A-Za-z]))/g, NBSP)
    for (const v of core === source ? [source] : [source, core]) out.push({ text: v, level: 'hint', when: { source: v }, note: `Use "${target}" for "${source}"` })
  }
  return out
}

/** The hand-written files' style: quoted text and expressions, `when` on one line. */
function styled(node: unknown, inWhen = false): void {
  if (isMap(node)) {
    node.flow = inWhen
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined
      if (key === 'when') styled(pair.value, true)
      else if (isScalar(pair.value) && key !== 'level') pair.value.type = 'QUOTE_SINGLE'
    }
    if (inWhen) for (const pair of node.items) if (isScalar(pair.value)) pair.value.type = 'QUOTE_SINGLE'
  }
}

const same = (a: Pattern, b: Pattern) =>
  a.text === b.text && a.find === b.find && a.when?.source === b.when?.source && a.when?.notSource === b.when?.notSource

/** Appends the patterns the file does not already have, under one comment. */
function appendPatterns(doc: Document, patterns: Pattern[]): void {
  let seq = doc.get('patterns', true)
  if (!isSeq(seq)) {
    seq = doc.createNode([])
    doc.set('patterns', seq)
  }
  const existing = (doc.toJS() as { patterns?: Pattern[] }).patterns ?? []
  const fresh = patterns.filter((p) => !existing.some((e) => same(e, p)))
  fresh.forEach((p, i) => {
    const node = doc.createNode(p)
    styled(node)
    if (i === 0) { node.spaceBefore = true; node.commentBefore = ' From dateTime in the schema 3 file.' }
    ;(seq as YAML.YAMLSeq).items.push(node)
  })
}
