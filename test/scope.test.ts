import { expect, it } from 'vitest'
import { scopeFindings } from '../src/check/scope.js'

it('accepts one locale folder', () => expect(scopeFindings(['locales/tr_TR/tm.yaml', 'locales/tr_TR/rules.yaml'], 'someone')).toEqual({ findings: [], locale: 'tr_TR' }))
it('refuses two locales', () => expect(scopeFindings(['locales/tr_TR/tm.yaml', 'locales/el/rules.yaml'], 'someone').findings[0]?.message).toBe('the pull request changes more than one locale: el, tr_TR'))
it('lets the maintainer change several locales', () => expect(scopeFindings(['locales/tr_TR/tm.yaml', 'locales/el/rules.yaml'], 'emreerkan').findings).toEqual([]))
it('refuses files outside locales/ from others', () => expect(scopeFindings(['locales/tr_TR/tm.yaml', '.github/workflows/pr.yml'], 'someone').findings[0]?.message).toBe('only the repository maintainer changes files outside locales/: .github/workflows/pr.yml'))
it('lets the maintainer change tooling', () => expect(scopeFindings(['src/x.ts', 'core/tm.yaml'], 'emreerkan').findings).toEqual([]))
it('counts a file directly under locales/ as outside', () => expect(scopeFindings(['locales/README.md'], 'someone').findings[0]?.message).toBe('only the repository maintainer changes files outside locales/: locales/README.md'))
