// Launch Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks every rankable pre-token protocol in the snapshot: the watchlist is the floor
// (all 40 of its protocols are always on the board) and the radar carries the rest of the
// pre-token universe too, because a radar that only watches the largest protocols is not a
// radar. Set aside, and counted on the page with their reasons: wrapped, staked and bridged
// products of tokens that already trade, exchange front-ends, and versioned pools of other
// protocols. Protocols whose token already trades are never ranked: the ones with a market cap
// in the snapshot are the comparison set (the comps) the value model is fitted on, and the
// dashboard sets them apart.
//
// The value model is fitted, not asserted. On the comps (protocols whose token trades with a
// market cap and a TVL in the snapshot, exchange tokens set aside), four terms are fitted in
// turn, each on the residuals the terms before it leave:
//
//   log value = A + B x log TVL            (the size term, least squares over the comps)
//             + family adjustment          (each protocol family's mean residual, shrunk toward
//                                           zero by n / (n + 6) so a family with two comps barely
//                                           moves the line)
//             + G x clamped 7d growth      (growth in per cent, clamped to [-60, 120])
//             + M x log(1 + age in years)  (how long the protocol has run)
//
// A pre-token protocol's implied value is the fitted line read at its own TVL, family, growth
// and age. No protocol's name is ever special-cased: the same fitted function scores every row.
//
// The fit is tested the way it will be used: the comps are split in two by a hash of the slug,
// the model is fitted on one half and asked to price the other, then the halves swap. Both
// held-out results ship in the dashboard's data, next to the model, so a reader can see the
// error the model makes on protocols it was not fitted on before trusting a single row.
//
// Launch odds come from the snapshot's own cross-section. For each of three cuts of the
// universe - the protocol's family, its age band, its TVL band - the model reads the share of
// protocols that already record a token, smooths each share toward the universe's own share,
// and pools the three the way naive Bayes pools evidence. The odds are a peer record, stated
// as one: they say how often protocols like this one have a token by now, nothing more.
//
// A row's expected value is its implied value times its launch odds. The board is ranked by
// implied value, as the bounty asks; the dashboard can re-sort by expected value, TVL, growth,
// age or odds, because different readers hunt differently.
//
// The evidence layer (buildEvidence, below) tests every claim the page makes, on the same
// snapshot, with the model's own fitting code: each value term's held-out error with and
// without it under a walk-forward split (fit on the protocols listed earlier, price the ones
// listed later) and under leave-one-out (each comp priced by a fit on the others); two
// candidate terms the model does not carry, tested the same way and left out; the launch
// odds' Brier score against the base rate on a blind split; and the printed value range's
// stated coverage against its measured coverage in both tests. Nothing in it is asserted:
// every figure is computed from the snapshot the program was handed, so the same page on a
// different snapshot carries that snapshot's evidence, not this one's.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'comps-3';

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

// ------------------------------------------------------------------ families

/** Protocol families: DefiLlama's fine categories grouped the way a launch market groups them. */
export const FAMILIES = [
  'DEX & trading',
  'Lending & credit',
  'Staking & restaking',
  'Bridges',
  'Yield & vaults',
  'Derivatives',
  'Real-world assets',
  'Chains',
  'Other',
] as const;
export type Family = (typeof FAMILIES)[number];

const FAMILY_OF: Record<string, Family> = {
  Dexs: 'DEX & trading',
  Lending: 'Lending & credit',
  CDP: 'Lending & credit',
  'CDP Manager': 'Lending & credit',
  'Uncollateralized Lending': 'Lending & credit',
  'Collateral Markets': 'Lending & credit',
  'Collateral Management': 'Lending & credit',
  'Liquid Staking': 'Staking & restaking',
  'Staking Pool': 'Staking & restaking',
  'Liquid Restaking': 'Staking & restaking',
  Restaking: 'Staking & restaking',
  'Restaked BTC': 'Staking & restaking',
  'Anchor BTC': 'Staking & restaking',
  'Decentralized BTC': 'Staking & restaking',
  Bridge: 'Bridges',
  'Canonical Bridge': 'Bridges',
  'Cross Chain Bridge': 'Bridges',
  Yield: 'Yield & vaults',
  'Yield Aggregator': 'Yield & vaults',
  'Leveraged Farming': 'Yield & vaults',
  Farm: 'Yield & vaults',
  'Basis Trading': 'Yield & vaults',
  'Liquidity Manager': 'Yield & vaults',
  'Risk Curators': 'Yield & vaults',
  'Onchain Capital Allocator': 'Yield & vaults',
  Derivatives: 'Derivatives',
  Options: 'Derivatives',
  'Options Vault': 'Derivatives',
  Synthetics: 'Derivatives',
  'Interest Rate Derivatives': 'Derivatives',
  RWA: 'Real-world assets',
  Chain: 'Chains',
};

/** The family a protocol belongs to, from its DefiLlama category alone. */
export function familyOf(p: SnapshotProtocol): Family {
  if (p.category === null) return 'Other';
  return FAMILY_OF[p.category] ?? 'Other';
}

// ------------------------------------------------------------------ basics

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * Categories that are a product of a token that already trades, not a protocol waiting on a
 * launch of its own: the house's own watchlist test, applied board-wide. A bridge's TVL is
 * other protocols' assets in transit and a restaked product is its underlying, staked again;
 * ranking them would put wrapped bitcoin at the top of a launch radar. Liquid staking
 * protocols stay on the board: the protocol is not the asset it stakes, and its own token is
 * exactly what this radar hunts.
 */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Restaking', 'Restaked BTC']);

/** The snapshot's own bridge categories, named in the accounting from its category field. */
const BRIDGE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge']);

/** The snapshot's own liquid-restaking categories, named in the accounting the same way. */
const RESTAKING_CATEGORIES = new Set(['Liquid Restaking', 'Restaked BTC']);

/** A name carrying a whole word wrapped, staked or staking is a product of a traded token. */
const PRODUCT_NAME = /\b(wrapped|staked|staking)\b/i;

/** A name that begins with an exchange's name is that exchange's product, not a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a pre-token protocol is a wrapped, staked or bridged product of a traded token. */
export function isProduct(p: SnapshotProtocol): boolean {
  return (
    (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) ||
    PRODUCT_NAME.test(p.name) ||
    EXCHANGE_PREFIX.test(p.name)
  );
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a product of a traded token, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !isProduct(p) && !VERSIONED.test(p.name);
}

/** A whole day count from the snapshot's date back to listing, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The growth figure the model reads: the snapshot's 7-day change, clamped, null read as no signal. */
function growthOf(p: SnapshotProtocol): number {
  return clamp(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0, -60, 120);
}

// ------------------------------------------------------------------ the fit

/** A fitted value model: the four terms, priced on a set of comps. */
export interface Fit {
  intercept: number;
  slope: number;
  family_adj: Record<string, number>;
  growth_coef: number;
  age_coef: number;
  comps: number;
}

/** The comparison set: a token that trades, with a market cap and a TVL, and not an exchange token. */
export function compsOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/** The fitted line read at one protocol: the implied log value and each term's multiplier. */
export function fittedLogValue(fit: Fit, p: SnapshotProtocol, asOf: string): { logValue: number; base: number; familyMult: number; growthMult: number; ageMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const ageYears = age === null ? 1 : age / 365.25;
  const base = Math.exp(fit.intercept + fit.slope * Math.log(p.tvl_usd));
  const familyMult = Math.exp(fit.family_adj[familyOf(p)] ?? 0);
  const growthMult = Math.exp(fit.growth_coef * growthOf(p));
  const ageMult = Math.exp(fit.age_coef * Math.log(1 + ageYears));
  return { logValue: Math.log(base) + Math.log(familyMult) + Math.log(growthMult) + Math.log(ageMult), base, familyMult, growthMult, ageMult, age };
}

/**
 * Fit the model on a set of comps: least squares for the size term, then each later term fitted
 * on the residuals the earlier terms leave. Deterministic: no sampling anywhere, the split that
 * calls this twice is by slug hash.
 *
 * The fit is staged so the evidence layer can price with a prefix of it: stage 0 is flat (every
 * comp priced at the comps' median), 1 the size term alone, 2 with the family adjustment, 3
 * with growth, 4 the full model. A later term is fitted on the residuals the earlier terms
 * leave, so zeroing the terms past a stage is exactly the model stopped at that stage - one
 * code path, and stage 4 is the board's fit, unchanged.
 */
function fitStaged(comps: SnapshotProtocol[], asOf: string, stage: number): Fit {
  if (comps.length === 0) return { intercept: 0, slope: 0, family_adj: {}, growth_coef: 0, age_coef: 0, comps: 0 };
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd as number));
  const n = comps.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope0 = sxx > 0 ? sxy / sxx : 1;
  const intercept0 = my - slope0 * mx;
  // One Huber reweighting pass: the comps' value-to-TVL ratios run from under 0.01x to over
  // 100x, and plain least squares lets the few enormous ratios drag the line the whole board
  // is priced from. Refit once with each comp weighted by how ordinary its residual is.
  const resid0 = ys.map((y, i) => y - (intercept0 + slope0 * xs[i]!));
  const scale = [...resid0].map(Math.abs).sort((a, b) => a - b)[Math.floor(resid0.length / 2)] || 1;
  const w = resid0.map((r) => {
    const u = Math.abs(r) / (1.345 * Math.max(scale, 0.1));
    return u >= 1 ? 1 / u : 1;
  });
  const wSum = w.reduce((s, v) => s + v, 0);
  const wmx = xs.reduce((s, v, i) => s + w[i]! * v, 0) / wSum;
  const wmy = ys.reduce((s, v, i) => s + w[i]! * v, 0) / wSum;
  let wsxy = 0;
  let wsxx = 0;
  for (let i = 0; i < n; i++) {
    wsxy += w[i]! * (xs[i]! - wmx) * (ys[i]! - wmy);
    wsxx += w[i]! * (xs[i]! - wmx) * (xs[i]! - wmx);
  }
  const slope = wsxx > 0 ? wsxy / wsxx : slope0;
  const intercept = wmy - slope * wmx;
  const resid = ys.map((y, i) => y - (intercept + slope * xs[i]!));

  // Family adjustments: each family's mean residual, shrunk toward zero by n / (n + 6).
  const famSum = new Map<string, { sum: number; n: number }>();
  comps.forEach((p, i) => {
    const f = familyOf(p);
    const e = famSum.get(f) ?? { sum: 0, n: 0 };
    e.sum += resid[i]!;
    e.n += 1;
    famSum.set(f, e);
  });
  const family_adj: Record<string, number> = {};
  for (const f of FAMILIES) {
    const e = famSum.get(f);
    family_adj[f] = e === undefined ? 0 : (e.sum / e.n) * (e.n / (e.n + 6));
  }
  const resid2 = resid.map((r, i) => r - (family_adj[familyOf(comps[i]!)] ?? 0));

  // One least-squares coefficient on the residuals, for a single regressor.
  const coefOn = (vals: number[]): number => {
    const mv = vals.reduce((s, v) => s + v, 0) / vals.length;
    let num = 0;
    let den = 0;
    vals.forEach((v, i) => {
      num += (v - mv) * resid2[i]!;
      den += (v - mv) * (v - mv);
    });
    return den > 0 ? num / den : 0;
  };
  const growth_coef = coefOn(comps.map(growthOf));
  const resid3 = resid2.map((r, i) => r - growth_coef * growthOf(comps[i]!));
  const ageVals = comps.map((p) => {
    const a = ageDays(asOf, p.listed_at);
    return Math.log(1 + (a === null ? 365.25 : a) / 365.25);
  });
  const mvA = ageVals.reduce((s, v) => s + v, 0) / ageVals.length;
  let numA = 0;
  let denA = 0;
  ageVals.forEach((v, i) => {
    numA += (v - mvA) * resid3[i]!;
    denA += (v - mvA) * (v - mvA);
  });
  const age_coef = denA > 0 ? numA / denA : 0;
  const full: Fit = { intercept, slope, family_adj, growth_coef, age_coef, comps: n };
  if (stage >= 4) return full;
  const flat = [...ys].sort((a, b) => a - b)[Math.floor(ys.length / 2)] ?? 0;
  return {
    intercept: stage >= 1 ? intercept : flat,
    slope: stage >= 1 ? slope : 0,
    family_adj: stage >= 2 ? family_adj : Object.fromEntries(FAMILIES.map((f) => [f, 0])),
    growth_coef: stage >= 3 ? growth_coef : 0,
    age_coef: 0,
    comps: n,
  };
}

/** The board's fit: the full four-term model, stage 4 of fitStaged. */
export function fitModel(comps: SnapshotProtocol[], asOf: string): Fit {
  return fitStaged(comps, asOf, 4);
}

/** A deterministic split of the comps in two, by the parity of the slug's character sum. */
function splitHalf(comps: SnapshotProtocol[]): [SnapshotProtocol[], SnapshotProtocol[]] {
  const a: SnapshotProtocol[] = [];
  const b: SnapshotProtocol[] = [];
  for (const p of comps) {
    let h = 0;
    for (let i = 0; i < p.slug.length; i++) h += p.slug.charCodeAt(i) * (i + 1);
    (h % 2 === 0 ? a : b).push(p);
  }
  return [a, b];
}

/** How a fit does on comps it was not fitted on: median log error and the share priced within x2. */
export interface HeldOut {
  fitted_on: number;
  tested_on: number;
  median_abs_log_error: number;
  median_error_x: number;
  within_2x_pct: number;
}

/** Fit on `train`, price `test`, and say how wrong the prices are. */
function heldOut(train: SnapshotProtocol[], test: SnapshotProtocol[], asOf: string): HeldOut {
  const fit = fitModel(train, asOf);
  const errs = test.map((p) => Math.abs(fittedLogValue(fit, p, asOf).logValue - Math.log(p.mcap_usd as number))).sort((x, y) => x - y);
  const med = errs[Math.floor(errs.length / 2)] ?? 0;
  const within = errs.filter((e) => e <= Math.log(2)).length;
  return {
    fitted_on: train.length,
    tested_on: test.length,
    median_abs_log_error: round4(med),
    median_error_x: round4(Math.exp(med)),
    within_2x_pct: Math.round((1000 * within) / Math.max(1, errs.length)) / 10,
  };
}

/** The model's held-out record, both ways, as the dashboard states it. */
export interface Validation {
  comps: number;
  half_a: HeldOut;
  half_b: HeldOut;
}

// ------------------------------------------------------------------ the evidence

/** The median of a set of numbers: the middle element once sorted, the house convention. */
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** One staged fit's median pricing error on comps it was not fitted on, as a multiple. */
function stageErrorX(fit: Fit, test: SnapshotProtocol[], asOf: string): number {
  const errs = test.map((p) => Math.abs(fittedLogValue(fit, p, asOf).logValue - Math.log(p.mcap_usd as number)));
  return round4(Math.exp(medianOf(errs)));
}

/**
 * The walk-forward split: the model is fitted on the comps listed earlier and priced on the
 * ones listed later, the way a radar is actually used - the past pricing the future. Comps
 * with no recorded listing date train only: an undated protocol cannot be shown to come
 * after anything.
 */
function walkForwardSplit(comps: SnapshotProtocol[]): { train: SnapshotProtocol[]; test: SnapshotProtocol[]; undated: number } {
  const dated = comps
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const undated = comps.filter((p) => p.listed_at === null);
  const cut = Math.floor(dated.length / 2);
  return { train: [...undated, ...dated.slice(0, cut)], test: dated.slice(cut), undated: undated.length };
}

/** Every stage's leave-one-out errors: each comp priced by a fit, stopped at that stage, on all the others. */
function looStageErrors(comps: SnapshotProtocol[], asOf: string): number[][] {
  return comps.map((held, i) => {
    const train = comps.filter((_, j) => j !== i);
    const actual = Math.log(held.mcap_usd as number);
    const errs: number[] = [];
    for (let s = 0; s <= 4; s++) {
      errs.push(Math.abs(fittedLogValue(fitStaged(train, asOf, s), held, asOf).logValue - actual));
    }
    return errs;
  });
}

/**
 * A candidate term the model does not carry, tested the way the carried terms are: a
 * coefficient fitted on the full fit's residuals, then the walk-forward and leave-one-out
 * errors of the model with the candidate added. Nothing here touches the board.
 */
function candidateErrors(
  wfTrain: SnapshotProtocol[],
  wfTest: SnapshotProtocol[],
  comps: SnapshotProtocol[],
  asOf: string,
  valOf: (p: SnapshotProtocol) => number,
): { wf: number | null; loo: number } {
  const withCandidate = (train: SnapshotProtocol[], held: SnapshotProtocol): number => {
    const full = fitModel(train, asOf);
    const vals = train.map(valOf);
    const mv = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
    let num = 0;
    let den = 0;
    train.forEach((p, i) => {
      const resid = Math.log(p.mcap_usd as number) - fittedLogValue(full, p, asOf).logValue;
      num += (vals[i]! - mv) * resid;
      den += (vals[i]! - mv) * (vals[i]! - mv);
    });
    const coef = den > 0 ? num / den : 0;
    return fittedLogValue(full, held, asOf).logValue + coef * (valOf(held) - mv) - Math.log(held.mcap_usd as number);
  };
  const wf =
    wfTest.length > 0
      ? round4(Math.exp(medianOf(wfTest.map((p) => Math.abs(withCandidate(wfTrain, p))))))
      : null;
  const loo = round4(Math.exp(medianOf(comps.map((held, i) => Math.abs(withCandidate(comps.filter((_, j) => j !== i), held))))));
  return { wf, loo };
}

/** A range's factors from one fit's own residuals: the quantiles of its errors. */
function rangeFactors(fit: Fit, comps: SnapshotProtocol[], asOf: string, loF: number, hiF: number): { lo: number; hi: number } {
  const r = comps.map((p) => Math.log(p.mcap_usd as number) - fittedLogValue(fit, p, asOf).logValue).sort((a, b) => a - b);
  const q = (f: number): number => r[Math.min(r.length - 1, Math.floor(f * r.length))] ?? 0;
  return { lo: round4(Math.exp(q(loF))), hi: round4(Math.exp(q(hiF))) };
}

/** The share of a test set whose real cap lands inside the range a fit prints for it. */
function rangeCoverage(fit: Fit, factors: { lo: number; hi: number }, test: SnapshotProtocol[], asOf: string): number {
  if (test.length === 0) return 0;
  let inside = 0;
  for (const p of test) {
    const pred = Math.exp(fittedLogValue(fit, p, asOf).logValue);
    const actual = p.mcap_usd as number;
    if (actual >= pred * factors.lo && actual <= pred * factors.hi) inside++;
  }
  return Math.round((1000 * inside) / test.length) / 10;
}

/** Why a carried term stays, from its two blind tests against the stage before it. */
function termVerdict(prevWf: number | null, prevLoo: number, wf: number | null, loo: number): string {
  const looHelps = loo < prevLoo - 0.005;
  if (wf === null || prevWf === null) {
    return looHelps ? 'kept - it lowers the leave-one-out error' : 'kept - leave-one-out does not reward it on this snapshot';
  }
  const wfHelps = wf < prevWf - 0.005;
  if (wfHelps && looHelps) return 'kept - it lowers the error in both tests';
  if (wfHelps) return 'kept - it lowers the walk-forward error; leave-one-out does not reward it';
  if (looHelps) return 'kept - it lowers the leave-one-out error; walk-forward does not reward it';
  return 'kept - neither blind test rewards it on this snapshot';
}

/** Why a candidate stays out, from its two blind tests against the full model. */
function candidateVerdict(wf: number | null, loo: number, fullWf: number | null, fullLoo: number): string {
  const wfWins = wf !== null && fullWf !== null && wf < fullWf - 0.005;
  const looWins = loo < fullLoo - 0.005;
  if (wfWins && looWins) return 'not kept - it wins both blind tests on this snapshot, and the model still does not carry it';
  if (wfWins || looWins) return 'not kept - it wins one blind test, not both';
  return 'not kept - the model prices better without it in both tests';
}

/**
 * Why a placebo control stays out. A control carries no economics, so it must not help; the
 * verdict states what it actually did, because a control that swept both tests would put
 * the tests themselves in doubt, not earn a place in the model.
 */
function placeboVerdict(wf: number | null, loo: number, fullWf: number | null, fullLoo: number): string {
  const wfWins = wf !== null && fullWf !== null && wf < fullWf - 0.005;
  const looWins = loo < fullLoo - 0.005;
  if (wfWins && looWins) return 'not kept - it wins both tests on this snapshot, which is what noise does now and then; a control is never promoted to a term';
  if (wfWins || looWins) return 'not kept - it wins one blind test, not both; a control that won both would put the tests themselves in doubt';
  return 'not kept - it does not help in either test, which is what a control is for';
}

/** A deterministic coin flip per protocol, from its slug's FNV-1a hash: the placebo feature. */
function coinOf(p: SnapshotProtocol): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.slug.length; i++) {
    h ^= p.slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 1000) / 1000 - 0.5;
}

/** A seeded generator (mulberry32): the bootstrap must land on the same figures every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The standard deviation of a set of round statistics: the bootstrap's standard error. */
function sdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** One row of the term table: a stage of the model, or a candidate it does not carry. */
export interface TermRow {
  term: string;
  detail: string;
  in_model: boolean;
  walk_forward_x: number | null;
  loo_x: number | null;
  verdict: string;
}

/** The odds' blind record: Brier score of the pooled odds against the base rate alone. */
export interface OddsEvidence {
  brier_model: number;
  brier_base: number;
  tested: number;
  base_rate_pct: number;
}

/** One printed range's honesty: what it claims to cover, and what the blind tests measure. */
export interface RangeLevel {
  stated_pct: number;
  lo_mult: number;
  hi_mult: number;
  walk_forward_pct: number | null;
  loo_pct: number;
}

/** The ranges' honesty at two widths: the printed inner range and the wider outer one. */
export interface RangeEvidence {
  inner: RangeLevel;
  outer: RangeLevel;
  within_3x_pct: number;
}

/**
 * How sure the fitted figures are, from bootstrap refits: the model refitted on resamples
 * of its own comps, its median fitted multiple and its out-of-bag error recorded each
 * round, and the odds' blind calls resampled for the Brier score's standard error.
 */
export interface Uncertainty {
  rounds: number;
  multiple_median: number;
  multiple_se: number;
  oob_median_x: number;
  oob_se_x: number;
  brier_se: number;
}

/** Everything the evidence panel states, computed from the snapshot at run time. */
export interface Evidence {
  terms: TermRow[];
  walk_forward: { trained_on: number; tested_on: number; undated_in_train: number };
  loo_comps: number;
  odds: OddsEvidence;
  range: RangeEvidence;
  uncertainty: Uncertainty;
}

/**
 * The evidence for one snapshot: the term table under both blind tests, the candidates, the
 * odds' Brier record and the range's measured coverage. Every figure comes from the model's
 * own fitting code run on this snapshot's comps - the same code that priced the board.
 */
export function buildEvidence(snapshot: Snapshot, comps: SnapshotProtocol[], fit: Fit): Evidence {
  const asOf = snapshot.as_of;
  const wf = walkForwardSplit(comps);
  const wfX: (number | null)[] = [];
  for (let s = 0; s <= 4; s++) {
    wfX.push(wf.test.length > 0 ? stageErrorX(fitStaged(wf.train, asOf, s), wf.test, asOf) : null);
  }
  const loo = looStageErrors(comps, asOf);
  const looX = [0, 1, 2, 3, 4].map((s) => round4(Math.exp(medianOf(loo.map((e) => e[s]!)))));

  const termDefs = [
    { stage: 1, term: 'Size - log TVL', detail: 'the fitted line of value against TVL, one Huber reweighting pass' },
    { stage: 2, term: 'Family adjustment', detail: "each family's mean residual, shrunk toward zero by n/(n+6)" },
    { stage: 3, term: '7-day TVL growth', detail: 'the snapshot growth figure, clamped to [-60, +120] per cent' },
    { stage: 4, term: 'Age with no token', detail: 'log of one plus the years since listing' },
  ];
  const terms: TermRow[] = [
    {
      term: 'No terms - the flat median',
      detail: 'every comp priced at the comps median cap; the line each term must beat',
      in_model: false,
      walk_forward_x: wfX[0] ?? null,
      loo_x: looX[0] ?? null,
      verdict: 'the baseline',
    },
    ...termDefs.map((d) => ({
      term: d.term,
      detail: d.detail,
      in_model: true,
      walk_forward_x: wfX[d.stage] ?? null,
      loo_x: looX[d.stage] ?? null,
      verdict: termVerdict(wfX[d.stage - 1] ?? null, looX[d.stage - 1]!, wfX[d.stage] ?? null, looX[d.stage]!),
    })),
  ];

  const fullWf = wfX[4] ?? null;
  const fullLoo = looX[4]!;
  const candidates = [
    { term: 'Chain count - log(1 + chains)', detail: 'how many chains the protocol runs on', valOf: (p: SnapshotProtocol) => Math.log(1 + p.chains.length) },
    {
      term: 'Size curvature - (log TVL) squared',
      detail: 'a bend in the size line, for very large and very small TVL',
      valOf: (p: SnapshotProtocol) => {
        const x = Math.log(p.tvl_usd);
        return x * x;
      },
    },
  ];
  for (const c of candidates) {
    const e = candidateErrors(wf.train, wf.test, comps, asOf, c.valOf);
    terms.push({
      term: c.term,
      detail: c.detail,
      in_model: false,
      walk_forward_x: e.wf,
      loo_x: e.loo,
      verdict: candidateVerdict(e.wf, e.loo, fullWf, fullLoo),
    });
  }

  // Two placebo controls, run through the same machinery as the real candidates. Neither
  // carries any economics - one is the length of a protocol's slug, the other a coin flip
  // fixed per protocol by its slug's hash - so an honest table shows them failing to help;
  // if one ever swept both tests, that would indict the tests, not promote the control.
  const placebos = [
    {
      term: 'Placebo control - slug length',
      detail: 'how long the protocol\u2019s slug is; it knows nothing about value and must not help',
      valOf: (p: SnapshotProtocol) => Math.log(1 + p.slug.length),
    },
    {
      term: 'Placebo control - a coin flip from the slug hash',
      detail: 'one fixed random number per protocol, from its slug\u2019s hash; it must not help',
      valOf: coinOf,
    },
  ];
  for (const c of placebos) {
    const e = candidateErrors(wf.train, wf.test, comps, asOf, c.valOf);
    terms.push({
      term: c.term,
      detail: c.detail,
      in_model: false,
      walk_forward_x: e.wf,
      loo_x: e.loo,
      verdict: placeboVerdict(e.wf, e.loo, fullWf, fullLoo),
    });
  }

  // The odds, blind: fit the peer record on one slug-hash half of the universe, score the
  // other half's real outcomes with the Brier score, then swap. The base rate alone is the
  // baseline the pooled odds must beat. The blind calls are kept for the bootstrap below.
  const [halfA, halfB] = splitHalf(snapshot.protocols);
  const brierPairs: { pr: number; y: number }[] = [];
  const brierRun = (train: SnapshotProtocol[], test: SnapshotProtocol[]): { model: number; base: number; baseRate: number } => {
    const om = fitOdds({ ...snapshot, protocols: train });
    let se = 0;
    let seb = 0;
    for (const p of test) {
      const y = isPreToken(p) ? 0 : 1;
      const pr = launchOdds(om, p, asOf);
      brierPairs.push({ pr, y });
      se += (pr - y) * (pr - y);
      seb += (om.base - y) * (om.base - y);
    }
    return { model: se / Math.max(1, test.length), base: seb / Math.max(1, test.length), baseRate: om.base };
  };
  const ab = brierRun(halfA, halfB);
  const ba = brierRun(halfB, halfA);
  const tested = halfA.length + halfB.length;
  const odds: OddsEvidence = {
    brier_model: round4((ab.model * halfB.length + ba.model * halfA.length) / Math.max(1, tested)),
    brier_base: round4((ab.base * halfB.length + ba.base * halfA.length) / Math.max(1, tested)),
    tested,
    base_rate_pct: Math.round(((ab.baseRate + ba.baseRate) / 2) * 1000) / 10,
  };

  // The ranges at two widths: factors from the board fit's own residuals (the inner range
  // is the one printed beside each implied value), coverage measured blind both ways.
  const wfFit = fitModel(wf.train, asOf);
  let looInInner = 0;
  let looInOuter = 0;
  comps.forEach((held, i) => {
    const train = comps.filter((_, j) => j !== i);
    const f = fitModel(train, asOf);
    const pred = Math.exp(fittedLogValue(f, held, asOf).logValue);
    const actual = held.mcap_usd as number;
    const fi = rangeFactors(f, train, asOf, 0.25, 0.75);
    if (actual >= pred * fi.lo && actual <= pred * fi.hi) looInInner++;
    const fo = rangeFactors(f, train, asOf, 0.1, 0.9);
    if (actual >= pred * fo.lo && actual <= pred * fo.hi) looInOuter++;
  });
  const rangeLevel = (loF: number, hiF: number, stated: number, looInside: number): RangeLevel => {
    const fac = rangeFactors(fit, comps, asOf, loF, hiF);
    return {
      stated_pct: stated,
      lo_mult: fac.lo,
      hi_mult: fac.hi,
      walk_forward_pct:
        wf.test.length > 0 ? rangeCoverage(wfFit, rangeFactors(wfFit, wf.train, asOf, loF, hiF), wf.test, asOf) : null,
      loo_pct: Math.round((1000 * looInside) / Math.max(1, comps.length)) / 10,
    };
  };
  const within3 = loo.filter((e) => e[4]! <= Math.log(3)).length;
  const range: RangeEvidence = {
    inner: rangeLevel(0.25, 0.75, 50, looInInner),
    outer: rangeLevel(0.1, 0.9, 80, looInOuter),
    within_3x_pct: Math.round((1000 * within3) / Math.max(1, comps.length)) / 10,
  };

  // Uncertainty, from 200 seeded bootstrap rounds: refit the model on a resample of its
  // comps, record the median fitted multiple over the comps and the median error on the
  // comps the resample left out, and resample the odds' blind calls for the Brier score.
  // Seeded, so the figures are the same on every run of the same snapshot.
  const ROUNDS = 200;
  const rng = mulberry32(0x9e3779b9);
  const medianMultiple = (f: Fit): number =>
    medianOf(comps.map((p) => Math.exp(fittedLogValue(f, p, asOf).logValue) / p.tvl_usd));
  const bootMultiples: number[] = [];
  const bootOob: number[] = [];
  const bootBrier: number[] = [];
  const n = comps.length;
  for (let r = 0; r < ROUNDS; r++) {
    const drawn: number[] = [];
    const seen = new Set<number>();
    for (let k = 0; k < n; k++) {
      const i = Math.floor(rng() * n);
      drawn.push(i);
      seen.add(i);
    }
    const f = fitModel(drawn.map((i) => comps[i]!), asOf);
    bootMultiples.push(medianMultiple(f));
    const oob = comps.filter((_, i) => !seen.has(i));
    if (oob.length >= 5) bootOob.push(stageErrorX(f, oob, asOf));
    let se = 0;
    for (let k = 0; k < brierPairs.length; k++) {
      const pair = brierPairs[Math.floor(rng() * brierPairs.length)]!;
      se += (pair.pr - pair.y) * (pair.pr - pair.y);
    }
    bootBrier.push(se / Math.max(1, brierPairs.length));
  }
  const uncertainty: Uncertainty = {
    rounds: ROUNDS,
    multiple_median: round4(medianMultiple(fit)),
    multiple_se: round4(sdOf(bootMultiples)),
    oob_median_x: round4(medianOf(bootOob)),
    oob_se_x: round4(sdOf(bootOob)),
    brier_se: round4(sdOf(bootBrier)),
  };

  return {
    terms,
    walk_forward: { trained_on: wf.train.length, tested_on: wf.test.length, undated_in_train: wf.undated },
    loo_comps: comps.length,
    odds,
    range,
    uncertainty,
  };
}

/**
 * Each stage's record under the split-half test the page has always shown: fit one slug-hash
 * half, price the other, both ways. The board-change yardstick: a different model earns the
 * board only by beating the full model here, in both directions.
 */
export function stagedSplitHalf(comps: SnapshotProtocol[], asOf: string): { stage: number; a_to_b_x: number; b_to_a_x: number }[] {
  const [halfA, halfB] = splitHalf(comps);
  const out: { stage: number; a_to_b_x: number; b_to_a_x: number }[] = [];
  for (let s = 0; s <= 4; s++) {
    const ab = stageErrorX(fitStaged(halfA, asOf, s), halfB, asOf);
    const ba = stageErrorX(fitStaged(halfB, asOf, s), halfA, asOf);
    out.push({ stage: s, a_to_b_x: ab, b_to_a_x: ba });
  }
  return out;
}

/** The board's checksum: FNV-1a over its rows' ranks, slugs and values, as an 8-digit hex. */
export function boardChecksum(board: BoardRow[]): string {
  let h = 0x811c9dc5;
  const s = board.map((r) => `${r.rank}|${r.slug}|${r.implied_value_usd}|${r.expected_value_usd}`).join(';');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ launch odds

/** Age bands for the odds record, in years tokenless. */
function ageBand(age: number | null): string {
  if (age === null) return 'unknown age';
  const y = age / 365.25;
  if (y < 1) return 'under 1y';
  if (y < 2) return '1-2y';
  if (y < 4) return '2-4y';
  return 'over 4y';
}

/** TVL bands for the odds record. */
function tvlBand(tvl: number): string {
  if (tvl < 10_000_000) return 'under $10M';
  if (tvl < 50_000_000) return '$10-50M';
  if (tvl < 200_000_000) return '$50-200M';
  return 'over $200M';
}

interface OddsModel {
  base: number;
  byFamily: Map<string, number>;
  byAge: Map<string, number>;
  byTvl: Map<string, number>;
}

/** The peer record: smoothed tokenized shares by family, age band and TVL band. */
function fitOdds(snapshot: Snapshot): OddsModel {
  const all = snapshot.protocols;
  const base = all.filter((p) => !isPreToken(p)).length / all.length;
  const share = (rows: SnapshotProtocol[]): number => {
    if (rows.length === 0) return base;
    const tok = rows.filter((p) => !isPreToken(p)).length;
    // Beta smoothing toward the universe's own share, strength 12 protocols.
    return (tok + 12 * base) / (rows.length + 12);
  };
  const byFamily = new Map<string, number>();
  for (const f of FAMILIES) byFamily.set(f, share(all.filter((p) => familyOf(p) === f)));
  const byAge = new Map<string, number>();
  for (const b of ['under 1y', '1-2y', '2-4y', 'over 4y', 'unknown age']) {
    byAge.set(b, share(all.filter((p) => ageBand(ageDays(snapshot.as_of, p.listed_at)) === b)));
  }
  const byTvl = new Map<string, number>();
  for (const b of ['under $10M', '$10-50M', '$50-200M', 'over $200M']) {
    byTvl.set(b, share(all.filter((p) => tvlBand(p.tvl_usd) === b)));
  }
  return { base, byFamily, byAge, byTvl };
}

/** One protocol's launch odds: the three peer rates pooled against the base rate, clamped. */
function launchOdds(odds: OddsModel, p: SnapshotProtocol, asOf: string): number {
  const f = odds.byFamily.get(familyOf(p)) ?? odds.base;
  const a = odds.byAge.get(ageBand(ageDays(asOf, p.listed_at))) ?? odds.base;
  const t = odds.byTvl.get(tvlBand(p.tvl_usd)) ?? odds.base;
  const pooled = (f * a * t) / (odds.base * odds.base);
  return Math.round(clamp(pooled, 0.02, 0.95) * 1000) / 1000;
}

// ------------------------------------------------------------------ farm plans

/** What one transaction costs on a chain, in dollars, as the plans state it: a planning estimate. */
const GAS_USD: Record<string, number> = {
  Ethereum: 12,
  Arbitrum: 0.6,
  Base: 0.4,
  Optimism: 0.5,
  Solana: 0.1,
  BSC: 0.6,
  Polygon: 0.3,
  Avalanche: 0.8,
  Mantle: 0.3,
  Linea: 0.5,
  Scroll: 0.6,
  'zkSync Era': 0.4,
  Tron: 1.5,
  Sui: 0.2,
  Aptos: 0.2,
  Near: 0.1,
  Bitcoin: 4,
};

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The plan's shape for one protocol: everything both the board and the page phrase from. */
export interface PlanSpec {
  chain: string;
  gas_usd: number;
  capital_usd: number;
  hold_days: number;
  weeks: number;
  weekly_gas_usd: number;
  total_cost_usd: number;
  action: string;
}

/** The core farming action for a family, in words a farmer can follow. */
function actionFor(family: Family, name: string, capital: number, chain: string): string {
  switch (family) {
    case 'Lending & credit':
      return `Supply $${capital} of USDC as collateral on ${name} (${chain}), then borrow about 30% against it and re-supply the borrow once, so both sides of the market see the wallet.`;
    case 'DEX & trading':
      return `Add $${capital} of liquidity to ${name}'s deepest stable pool on ${chain}, and make two small swaps a week through the same wallet so it reads as a trader, not a passer-by.`;
    case 'Staking & restaking':
      return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token in the same wallet for the whole window.`;
    case 'Bridges':
      return `Bridge $${capital} of USDC to ${chain} through ${name}, use the bridged funds in one app on the far side, and bridge a smaller amount back near the end of the window.`;
    case 'Yield & vaults':
      return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and leave the shares untouched; vault shares are the position the snapshots count.`;
    case 'Derivatives':
      return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and hold one small hedged position, rolling it weekly instead of churning volume.`;
    case 'Real-world assets':
      return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold it; if minting needs accreditation, hold the protocol's deposit token instead and note the wall in the log.`;
    case 'Chains':
      return `Bridge $${capital} of USDC onto ${name} and use two native apps a week (one swap, one lending deposit) so the wallet is a resident, not a tourist.`;
    default:
      return `Deposit $${capital} of USDC into ${name} on ${chain} through its main product and keep the position open for the whole window.`;
  }
}

/** One protocol's plan spec: chain, costs and timing, all from its own record. */
export function planSpec(p: SnapshotProtocol, age: number | null): PlanSpec {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const gas = GAS_USD[chain] ?? 2;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const weekly = Math.max(0.5, Math.round(gas * 10) / 10);
  const total = Math.round((gas * 3 + weekly * weeks) * 100) / 100;
  return {
    chain,
    gas_usd: gas,
    capital_usd: capital,
    hold_days: hold,
    weeks,
    weekly_gas_usd: weekly,
    total_cost_usd: total,
    action: actionFor(familyOf(p), p.name, capital, chain),
  };
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

const money = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/**
 * The step a protocol's own record calls for, read off the snapshot's figures: a sharp
 * seven-day fall or rise in TVL, no recorded listing date, a very young listing, or a
 * protocol spread over many chains. One at most, the first that fires in that order, so
 * two plans differ where the protocols themselves differ, not only in their numbers.
 */
function signalStep(p: SnapshotProtocol, spec: PlanSpec, age: number | null): FarmStep | null {
  const change = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null;
  if (change !== null && change <= -15) {
    return {
      text: `Read the snapshot's warning first: ${p.name}'s TVL fell ${Math.abs(Math.round(change))}% in the seven days before the snapshot. Start at half size, and add the second half only after a week in which the protocol's own page shows TVL holding or recovering.`,
      cost: `a first deposit of ${money(spec.capital_usd / 2)} of the ${money(spec.capital_usd)} planned; the rest stays in the wallet`,
      time: 'one extra 5-minute check each week',
    };
  }
  if (change !== null && change >= 25) {
    return {
      text: `The snapshot shows ${p.name}'s TVL up ${Math.round(change)}% in seven days: growth that fast usually means the crowd is already arriving, so keep the position at the plan's stated size and do not chase it larger - late size is what dilutes a fixed points pool.`,
      cost: 'no extra cost; discipline only',
      time: 'no extra time',
    };
  }
  if (p.listed_at === null) {
    return {
      text: `DefiLlama records no listing date for ${p.name}, so its age is unknown rather than young: before sizing up, read the protocol's own docs for how long its contracts have held funds, and open with a test deposit of a tenth of the position.`,
      cost: `a test deposit of ${money(Math.max(10, Math.round(spec.capital_usd / 10)))} first`,
      time: '20 minutes of reading before the first deposit',
    };
  }
  if (age !== null && age < 60) {
    return {
      text: `${p.name} was listed only ${age} days before the snapshot: the early window is where launch programs weight wallets most, and where contracts are least tested, so make the first deposit this week and keep it at the plan's size, no larger.`,
      cost: `${money(spec.capital_usd)} as planned, nothing extra`,
      time: 'start within 7 days',
    };
  }
  if (p.chains.length >= 6) {
    return {
      text: `${p.name} runs on ${p.chains.length} chains in the snapshot; this plan farms it on ${spec.chain}, the chain the plan prices. Work one chain per wallet: the same funds split across chains usually count as several small wallets, not one committed one.`,
      cost: 'no extra cost; one chain only',
      time: 'no extra time',
    };
  }
  return null;
}

/** The full plan for one protocol: six steps, and a seventh when its own record raises a signal. */
export function farmSteps(p: SnapshotProtocol, spec: PlanSpec, age: number | null): FarmStep[] {
  const steps: FarmStep[] = [
    {
      text: `Start from a fresh wallet that holds only the funds for this farm, seed phrase written offline; never farm from a wallet that holds savings.`,
      cost: 'nothing to open; about $3 of gas to fund it',
      time: '10 minutes',
    },
    {
      text: `Move ${money(spec.capital_usd)} of USDC onto ${spec.chain} (bridge or exchange withdrawal), keeping ${money(spec.gas_usd * 3)} aside for gas.`,
      cost: `about ${money(spec.gas_usd)} in gas`,
      time: '15 minutes',
    },
    {
      text: spec.action,
      cost: `${money(spec.capital_usd)} of capital in the position, about ${money(spec.gas_usd)} in gas`,
      time: '20 minutes to set up',
    },
    {
      text: `Repeat one qualifying action a week for ${spec.weeks} weeks - a deposit top-up, a borrow repay, a swap or a vote - always from the same wallet.`,
      cost: `about ${money(spec.weekly_gas_usd)} of gas a week, ${money(spec.weekly_gas_usd * spec.weeks)} over the plan`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position at least ${spec.hold_days} days so the activity lands in more than one weekly snapshot; points programs count duration, not just volume.`,
      cost: `the ${money(spec.capital_usd)} stays locked in the position`,
      time: `${spec.hold_days} days`,
    },
    {
      text: `Claim only from the link on ${p.name}'s own page, never from a search ad or a DM; then log the wallet, dates and transactions so the position can be repeated or unwound.`,
      cost: 'no honest claim charges a fee; logging is free',
      time: '15 minutes',
    },
  ];
  const signal = signalStep(p, spec, age);
  if (signal !== null) steps.splice(3, 0, signal);
  return steps;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * The verdict as the board's table states it: a label on the same bands verdictFor phrases,
 * the expected value net of the plan's gas, and the expected value per active hour of the
 * plan (its setup and weekly actions; the holding days are the position's, not the farmer's
 * working time). Capital is not subtracted: it stays in the position and comes back.
 */
export function verdictParts(expected: number, spec: PlanSpec): { label: string; net_usd: number; per_hour_usd: number } {
  const hours = (60 + 10 * spec.weeks) / 60;
  return {
    label: expected >= 1_000_000 ? 'Farm first' : expected >= 100_000 ? 'Farm' : expected >= 10_000 ? 'Farm small' : 'Watch only',
    net_usd: Math.round(expected - spec.total_cost_usd),
    per_hour_usd: Math.round((expected / hours) * 100) / 100,
  };
}

/** The farm verdict: expected value against the plan's own cost, in one line. */
export function verdictFor(expected: number, spec: PlanSpec): string {
  const cost = `$${spec.total_cost_usd.toFixed(2)} of gas over the plan, ${money(spec.capital_usd)} of capital in the position`;
  if (expected >= 1_000_000) return `Farm first: $${(expected / 1_000_000).toFixed(1)}M of expected value against ${cost}.`;
  if (expected >= 100_000) return `Worth farming: $${Math.round(expected / 1000)}K of expected value against ${cost}.`;
  if (expected >= 10_000) return `Farm small: $${Math.round(expected / 1000)}K of expected value; keep the position at the plan's size, no larger.`;
  return `Watch only: expected value is thin against ${cost}; revisit if TVL or growth moves.`;
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  model: {
    base_value_usd: number;
    family_multiplier: number;
    growth_multiplier: number;
    age_multiplier: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_verdict: string;
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row's figures plus its plan spec. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  launch_odds: number;
  expected_value_usd: number;
  base_value_usd: number;
  family_multiplier: number;
  growth_multiplier: number;
  age_multiplier: number;
  watchlist: boolean;
  plan: PlanSpec;
  steps: FarmStep[];
  verdict: string;
  verdict_label: string;
  net_usd: number;
  per_hour_usd: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** One line of the accounting: a group of protocols and why they stand where they stand. */
export interface AccountingGroup {
  label: string;
  short: string;
  count: number;
}

/**
 * How every protocol in the snapshot is accounted for: the groups partition the snapshot -
 * each protocol lands in exactly one - and the out-groups are named from the snapshot's own
 * category field where a category is what sets them aside.
 */
export interface Accounting {
  total: number;
  ranked: number;
  watchlist: number;
  comps: number;
  groups: AccountingGroup[];
}

/** The fitted model's public face: its terms and its held-out record. */
export interface ModelInfo {
  version: string;
  slope: number;
  intercept: number;
  growth_coef: number;
  age_coef: number;
  family_adj: Record<string, number>;
  family_comps: Record<string, number>;
  odds_base_pct: number;
  validation: Validation;
}

/** Everything the dashboard needs: the board, the live set, the model and the accounting. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  model: ModelInfo;
  accounting: Accounting;
  evidence: Evidence;
  integrity: { checksum: string; rows: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Everything built from one snapshot: the gate's board and the dashboard's data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = compsOf(snapshot);
  const fit = fitModel(comps, snapshot.as_of);
  const [halfA, halfB] = splitHalf(comps);
  const validation: Validation = {
    comps: comps.length,
    half_a: heldOut(halfA, halfB, snapshot.as_of),
    half_b: heldOut(halfB, halfA, snapshot.as_of),
  };
  const odds = fitOdds(snapshot);
  const watch = new Set(snapshot.watchlist);

  const ranked = snapshot.protocols.filter(isRankable);
  const scored = ranked.map((p) => {
    const f = fittedLogValue(fit, p, snapshot.as_of);
    const implied = Math.max(1, Math.round(Math.exp(f.logValue)));
    const o = launchOdds(odds, p, snapshot.as_of);
    const spec = planSpec(p, f.age);
    return { p, f, implied, odds: o, expected: Math.round(implied * o), spec, steps: farmSteps(p, spec, f.age) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    family: familyOf(s.p),
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.f.age,
    implied_value_usd: s.implied,
    launch_odds: s.odds,
    expected_value_usd: s.expected,
    model: {
      base_value_usd: Math.round(s.f.base),
      family_multiplier: round4(s.f.familyMult),
      growth_multiplier: round4(s.f.growthMult),
      age_multiplier: round4(s.f.ageMult),
      growth_pct: growthOf(s.p),
      age_days: s.f.age,
    },
    farm_verdict: verdictFor(s.expected, s.spec),
    farm_steps: s.steps.map(stepText),
  }));

  const rows: RadarRow[] = board.map((r, i) => {
    const s = scored[i]!;
    const vp = verdictParts(r.expected_value_usd, s.spec);
    return {
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      family: r.family,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      launch_odds: r.launch_odds,
      expected_value_usd: r.expected_value_usd,
      base_value_usd: r.model.base_value_usd,
      family_multiplier: r.model.family_multiplier,
      growth_multiplier: r.model.growth_multiplier,
      age_multiplier: r.model.age_multiplier,
      watchlist: watch.has(r.slug),
      plan: s.spec,
      steps: s.steps,
      verdict: r.farm_verdict,
      verdict_label: vp.label,
      net_usd: vp.net_usd,
      per_hour_usd: vp.per_hour_usd,
    };
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      family: familyOf(p),
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));

  const family_comps: Record<string, number> = {};
  for (const f of FAMILIES) family_comps[f] = comps.filter((p) => familyOf(p) === f).length;

  // The accounting partition, in the same priority the rankability test applies: an
  // exchange front-end first, then the snapshot's own product categories, then a product
  // by name, then a versioned pool. Every pre-token protocol lands in exactly one group,
  // on any snapshot, because the groups are the rankability test read line by line.
  const preToken = snapshot.protocols.filter(isPreToken);
  const inCats = (set: Set<string>) => (p: SnapshotProtocol): boolean => p.category !== null && set.has(p.category);
  const accountingGroups: AccountingGroup[] = [
    { label: 'pre-token, ranked on the board', short: 'ranked', count: board.length },
    { label: 'already trade - the comps the model is fitted on', short: 'traded comps', count: comps.length },
    {
      label: 'already trade, but the snapshot carries no usable cap for them',
      short: 'traded, no usable cap',
      count: snapshot.protocols.filter((p) => !isPreToken(p)).length - comps.length,
    },
    {
      label: "exchange front-ends - the snapshot's own CEX category",
      short: 'CEX front-ends',
      count: preToken.filter((p) => p.category === 'CEX').length,
    },
    {
      label: "bridges - the snapshot's own Bridge and Canonical Bridge categories",
      short: 'bridges',
      count: preToken.filter((p) => p.category !== 'CEX' && inCats(BRIDGE_CATEGORIES)(p)).length,
    },
    {
      label: "liquid restaking - the snapshot's own Liquid Restaking and Restaked BTC categories",
      short: 'liquid restaking',
      count: preToken.filter((p) => p.category !== 'CEX' && inCats(RESTAKING_CATEGORIES)(p)).length,
    },
    {
      label: 'products of traded tokens by name - the name itself says wrapped, staked or bridged',
      short: 'products by name',
      count: preToken.filter((p) => p.category !== 'CEX' && !inCats(PRODUCT_CATEGORIES)(p) && isProduct(p)).length,
    },
    {
      label: 'versioned pools - the name carries a version number',
      short: 'versioned pools',
      count: preToken.filter((p) => p.category !== 'CEX' && !isProduct(p) && VERSIONED.test(p.name)).length,
    },
  ];
  const accounting: Accounting = {
    total: snapshot.protocols.length,
    ranked: board.length,
    watchlist: snapshot.watchlist.length,
    comps: comps.length,
    groups: accountingGroups.filter((g, i) => i < 3 || g.count > 0),
  };

  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: {
      version: MODEL_VERSION,
      slope: round4(fit.slope),
      intercept: round4(fit.intercept),
      growth_coef: round4(fit.growth_coef),
      age_coef: round4(fit.age_coef),
      family_adj: Object.fromEntries(Object.entries(fit.family_adj).map(([k, v]) => [k, round4(v)])),
      family_comps,
      odds_base_pct: Math.round(odds.base * 1000) / 10,
      validation,
    },
    accounting,
    evidence: buildEvidence(snapshot, comps, fit),
    integrity: { checksum: boardChecksum(board), rows: board.length },
    rows,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
