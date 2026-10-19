# polyglots-data

Locale data for [polyglots](https://github.com/emreerkan/polyglots), the CLI
and TUI for reviewing WordPress translations. polyglots ships no locale
knowledge of its own; it fetches it from this repository's releases.

For each locale this repository holds:

- **a translation memory (TM):** the approved translations of a curated list
  of translate.wordpress.org projects, published as TMX. It gives a translator
  who has no TM of their own a good start.
- **a rules file:** how the locale's team writes (capitalization, register,
  formality, sentence endings, common mistakes), which polyglots uses in its
  checks and in the AI reviewer's prompt.

## Using the data

With polyglots 1.0.0 or later:

```sh
polyglots tm fetch tr_TR      # import the tr_TR TM into the local database
polyglots rules fetch tr_TR   # download the tr_TR rules file
```

`rules fetch` shows what changes before it replaces a local rules file.

Both commands read the manifest of the latest release:

```
https://github.com/emreerkan/polyglots-data/releases/latest/download/index.json
```

Every entry in it points at a versioned asset and carries its SHA-512, so a
client can verify what it downloaded. Each release holds:

| Asset | Contents |
|---|---|
| `index.json` | The manifest: one entry per TM and per rules file |
| `<locale>.tmx.gz` | The locale's TM |
| `<locale>.rules.yaml` | The locale's rules file |
| `state.json`, `<locale>.units.json.gz` | The build cache (see below); not for clients |

## Locales

| Locale | TM | Rules |
|---|---|---|
| nl_NL | yes | maintained |
| tr_TR | yes | maintained |
| sv_SE | – | draft |
| el | – | draft |
| th | – | draft |
| bo | – | draft |
| dzo | – | draft |

A rules file is `maintained` when the locale team agreed to it, and `draft`
otherwise. To add a locale, a TM project or a rule, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## How the TM is built

A locale's TM is built from the projects in `core/tm.yaml`, which every locale
shares, plus the projects in `locales/<locale>/tm.yaml`, minus the locale's
`exclude` list. Only approved (`current`) translations are used. Readme and
release-notes projects are marked as long text, so polyglots gives them lower
weight.

The `Build` workflow runs:

- monthly, on the 1st at 03:17 UTC, for every locale with a TM;
- on a push to `main` that changes `core/`, `locales/`, `data/` or `src/`,
  for the locales the push changed;
- by hand (`workflow_dispatch`), for one locale, several, or all.

Each run asks the GlotPress API for every project's `last_modified` and
approved count, and downloads an export only for projects that changed since
the previous release. The previous release's `state.json` and units files are
the cache, so no other storage is needed. Requests to translate.wordpress.org
go one at a time, with a pause between them.

A release is published only when something changed. A failed export or a
sudden shrink never replaces a project's last good strings: the project keeps
them and is marked stale. A rules file that fails its checks keeps its
previous entry. Problems are listed in the run summary. The run fails, after
the release is published, when a rules file fails, a project has been stale
for more than 28 days or was left out, or a locale is over its size limit.

## Repository layout

```
core/tm.yaml              projects every locale's TM includes
locales/<locale>/
  locale.yaml             locale maintainers and rules status
  tm.yaml                 the locale's own TM projects and exclusions
  rules.yaml              the locale's rules file
data/wp-locales.json      WordPress locale codes, slugs and translation sets
data/regex-allowlist.json reviewed regular expressions the ReDoS check allows
src/                      build, PR checks and tooling (TypeScript)
test/                     unit tests, on fixtures only
.github/workflows/        PR checks, approval report, build
```

## Development

Node 24 or later.

```sh
npm ci
npm test            # unit tests; never touch translate.wordpress.org
npm run typecheck
```

Other commands:

- `npm run smoke -- --locale tr_TR --max 3` downloads at most three projects
  of one locale into `dist/smoke/`, one request at a time. Use it sparingly.
- `npm run update-locales` refreshes `data/wp-locales.json` from
  translate.wordpress.org (one request).
- `npm run build` and `npm run check` are run by the workflows; see
  `.github/workflows/` for their arguments.

The rules checks run the pinned `polyglots` devDependency (`polyglots rules
check --file`). Its version is also the `minPolyglots` every rules entry in
the manifest carries.

## Licence

The files in this repository are licensed under the [MIT licence](LICENSE).

The translations in the published TMs come from translate.wordpress.org, where
they are licensed GPL-2.0-or-later, and stay under that licence. They are the
work of the WordPress locale teams: credit them and translate.wordpress.org
when you use the data.
