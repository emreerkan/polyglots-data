# Contributing to polyglots-data

polyglots-data publishes WordPress translation data for the
[polyglots](https://github.com/emreerkan/polyglots) CLI and TUI. For each
locale it holds:

- a list of translate.wordpress.org projects whose approved translations make
  up the locale's translation memory (TM),
- a rules file that tells polyglots how the locale's team writes.

Every change comes through a pull request. These rules say who may propose
what, who approves it, and what CI checks.

## Who is who

- **Repository maintainer:** [@emreerkan](https://github.com/emreerkan). Merges
  every pull request.
- **Locale maintainers:** Locale Managers (LMs) and General Translation
  Editors (GTEs) of a locale, listed in `locales/<locale>/locale.yaml`. They
  review the changes to their locale.
- **Contributors:** anyone. You do not need to be a locale maintainer to open
  a pull request.

## How a pull request is approved

1. You open a pull request.
2. CI checks it (see [What CI checks](#what-ci-checks)) and reports whether a
   locale maintainer of that locale approved it.
3. A locale maintainer of that locale reviews it and approves or asks for
   changes. A locale maintainer without a GitHub account says so to the
   repository maintainer on WordPress.org Slack instead, and the repository
   maintainer notes it in the pull request.
4. The repository maintainer merges it.

If a locale has no locale maintainers yet, the repository maintainer reviews
the change and asks the locale's GTEs on translate.wordpress.org or Slack
before merging. A pull request from an author the repository maintainer does
not know is not merged until a GTE of that locale confirms it.

The repository maintainer may decline a pull request that breaks these rules,
even when a locale maintainer approved it.

## One locale per pull request

A pull request that changes `locales/<locale>/` changes nothing outside that
folder. Changes to `core/`, `data/`, `.github/` and the tooling are made by the
repository maintainer.

## Becoming a locale maintainer

You must be an LM or GTE of the locale on translate.wordpress.org. Open a pull
request that adds you to `locales/<locale>/locale.yaml`:

```yaml
locale: es_ES
maintainers:
  - wporg: your-wporg-username
    github: your-github-name   # optional
    role: General Translation Editor
```

`wporg` is required; `github` is optional, since not every GTE has a GitHub
account. polyglots shows the WordPress.org usernames to its users. Without a
GitHub account, ask the repository maintainer on WordPress.org Slack to add
you.

The repository maintainer checks your role on your WordPress.org profile or the
locale's team page before merging. A locale maintainer who is no longer an LM or
GTE is removed.

## The translation memory

A locale's TM is built from the projects in `core/tm.yaml`, which every locale
shares, plus the projects in `locales/<locale>/tm.yaml`. Only approved
(`current`) translations are used. Waiting, fuzzy, rejected and old strings are
never included.

### Adding a project

Add an entry to `locales/<locale>/tm.yaml`:

```yaml
projects:
  - path: wp-plugins/advanced-custom-fields/dev
    added: 2026-10-15
    by: your-wporg-username
    reviewed: Translated, reviewed and proofread by the es_ES team.
```

- `path` is the project path on translate.wordpress.org, without the locale
  and the translation set. You may paste the project URL instead; CI tells you
  the path to write.
- `by` is the WordPress.org username of the person who proposes the project.
- `reviewed` says who reviewed the project's translation for this locale, and
  how.

A project may be added when all of these are true:

- A GTE or PTE of this locale reviewed its translation.
- At least 90% of its strings are translated and approved for this locale.
  Readme projects (`dev-readme`, `stable-readme`) have no such threshold.
- Its translation is not bulk machine translation that nobody reviewed.

### Removing a project

Any locale maintainer may remove a project. Say why in the pull request. A
project whose translation got worse is removed, not left in.

### Excluding a core project

If a core project's translation for your locale is not good enough to learn
from, exclude it:

```yaml
exclude:
  - wp/dev/cc
```

## The rules file

`locales/<locale>/rules.yaml` uses the format polyglots reads, described in
polyglots' [Locale rules](https://github.com/emreerkan/polyglots/blob/main/docs/locale-rules.md).

- The file starts with `schema:` set to the rules schema version it is
  written for.
- `rules.status` in `locale.yaml` is `maintained` only when the locale team
  agreed to the file. Otherwise it is `draft`.

### Rules that keep users safe

Every polyglots user of a locale runs that locale's rules file. A bad regular
expression can freeze their reviews, and a bad instruction can mislead the AI
reviewer. These limits apply to every rules file:

- **Prompt text is in English.** This covers `guidance`, `capitalization`,
  `register`, and every `note` and `right` in `patterns` and `mistakes`.
  Examples in the locale's language are welcome inside the English text, as
  in `write "ya da", not "yada"`. Prompt text must not contain URLs.
- **Regular expressions** (`find` in `patterns`, and `sentenceEnd`) must
  compile with the `u` flag, be at most 1,000 characters, pass a ReDoS check,
  and run within a time budget on CI's test strings.
- **Automatic fixes** (`level: fix`) must not add `<`, `>`, `://`, `www.` or a
  domain name to a translation. A `$1` or `$<name>` in a replacement may only
  refer to a group that is a character class or a list of plain words, such
  as `([Yy])`.

If your rule needs something these limits do not allow, open an issue first.

## What CI checks

On every pull request:

- Every YAML file parses, and unknown keys are errors.
- Every project path exists on translate.wordpress.org and has approved
  strings for the locale. CI reports the count in its summary.
- The rules file is valid for polyglots and meets the safety limits above.
- The pull request changes only one locale's folder. The repository
  maintainer may change several.
- Whether a locale maintainer of that locale approved it.

The CI summary lists every changed regular expression, automatic fix and
prompt text, so reviewers see them in one place.

## Licence

The files in this repository are licensed under the [MIT licence](LICENSE).

The translations in the published TMs come from translate.wordpress.org,
where they are licensed GPL-2.0-or-later. The TMs stay under that licence.
They are the work of the WordPress locale teams: credit them and
translate.wordpress.org when you use the data.
