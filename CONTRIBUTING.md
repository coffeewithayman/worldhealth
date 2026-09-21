# Contributing

Thanks for considering a contribution to World Dashboard. This is a small,
opinionated project — read `CLAUDE.md` for the architecture and invariants
before making non-trivial changes; most of what would otherwise need
explaining in review is written down there.

## Getting set up

```bash
npm install
npm run build
npm run migrate
npm run backfill   # deep history — needed before percentile scoring means anything
npm test
```

`npm run doctor` is the fastest way to see which upstream sources are live
without writing anything to the database.

## Before opening a PR

- `npm run build && npm test` must pass. `npm test` builds first, then runs
  `node --test` over the compiled output.
- If you touched `packages/web`, also run `npm -w @wd/web exec tsc -- --noEmit` —
  the web package is type-checked separately and nothing else catches it.
- Keep the relevant README section (and `CLAUDE.md` if an invariant or
  architectural decision changed) in sync with the code in the same PR.

## Adding a data source or indicator

Follow the recipes in `CLAUDE.md` under "Adding things" — they cover the
`Connector` interface, where a new indicator's config block goes in
`config/indicators.yaml`, and what a derived series needs. Verify a new
indicator against live data at a quiet date and a known-firing date before
committing, and add a test that pins the transform's behavior.

## Ground rules

- `core ← connectors ← ingest ← api` is one-way. Don't add a reverse
  dependency, and don't give `web` an internal dependency — it talks to the
  API over HTTP only.
- Every score needs its arithmetic (`ScoreRecord.inputs` / `IndicatorScore.explanation`).
  A score without an explanation isn't reviewable, so it isn't accepted.
- Never log or persist a credential. `redactUrl()` and `scrubSecrets()` exist
  for this; use them rather than adding a parallel scrubbing path.
- `bands` vs `percentile` is a modelling decision — see `CLAUDE.md` for when
  each applies. Don't switch one for the other as a style preference.

## Reporting bugs / requesting features

Open a GitHub issue with what you expected, what happened, and (for a data
issue) the series id and date involved. For anything data-source related,
check the "Sources already evaluated and rejected" section of the README
first — a few obvious ones have already been tried and don't work.

## Code of conduct

Be respectful and constructive. Disagree about code, not people.
