# Launch Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hakeno337/launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hakeno337/launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

An entry for make.fun's [token launch radar bounty](https://make.fun/bounty/token-radar-01): a program that reads the sealed DefiLlama snapshot and ranks every pre-token protocol by what its token launch would be worth, with a farm plan for each one, presented as a static dashboard.

## The model

The implied value is fitted, not asserted. On the protocols in the snapshot whose token already trades with a market cap and a TVL (the comps, exchange tokens set aside), four terms are fitted in turn, each on the residuals the earlier terms leave:

- a size term, `log value = A + B x log TVL`, least squares with one Huber reweighting pass;
- a family adjustment per protocol family, shrunk toward zero by `n / (n + 6)`;
- a growth term on the clamped 7-day TVL change;
- an age term on `log(1 + years tokenless)`.

The fit is validated held-out both ways (split by slug hash: fit on one half, price the other, then swap), and both held-out results are printed on the dashboard next to the model. Launch odds come from the snapshot's own cross-section: the tokenized share by family, age band and TVL band, smoothed and pooled. Expected value is implied value times launch odds.

Every protocol in the snapshot is accounted for on the page: ranked, traded (priced or unpriced), or set aside with its reason (wrapped, staked or bridged products of traded tokens; exchange front-ends; versioned pools).

## Run it

Needs Node.js 22.18 or later.

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory, deterministically: two runs on the same snapshot write the same bytes.

## Layout

- `main.ts` - the entry point: snapshot in, board, data, dashboard, screenshots and dossier out.
- `lib/model.ts` - the fitted value model, the launch-odds record, the farm plans and the board.
- `dashboard/` - the static page (no framework, no network): sortable, filterable, with a detail view per protocol.
- `screenshots/` - the board, a detail view and a filtered view, taken of the built page.
- `vendor/makefun-board.ts` - the make.fun dossier library, vendored from the competition kit.
