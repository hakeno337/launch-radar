// Launch Radar's page: renders the board the program wrote into ../data.js - the same figures,
// the same order, the same plans as board.json, because both come from one run of the model.
// No framework, no fetch, no network: sort, filter, search and the detail view all happen here.

const R = window.RADAR;
const rows = R.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));
const state = { q: '', fam: 'All families', chain: 'All chains', verdict: 'All verdicts', wl: false, key: 'rank', dir: 1, sel: null };

// The verdict scenario: position size as a multiple of each plan's stated position, the
// share of the launch value the position is assumed to capture, and the horizon in weeks
// (0 = each plan's own). At the defaults - x1, 100%, as planned - the recomputation below
// returns the board's printed verdicts exactly; the protocol pages always show those.
const scen = { size: 1, share: 100, horizon: 0 };

function scenarioVerdict(r) {
  const gross = r.expected_value_usd * (scen.share / 100) * scen.size;
  const weeks = scen.horizon === 0 ? r.plan.weeks : scen.horizon;
  const gas = r.plan.total_cost_usd + r.plan.weekly_gas_usd * (weeks - r.plan.weeks);
  const hours = (60 + 10 * weeks) / 60;
  return {
    label: gross >= 1e6 ? 'Farm first' : gross >= 1e5 ? 'Farm' : gross >= 1e4 ? 'Farm small' : 'Watch only',
    net: Math.round(gross - gas),
    perHour: Math.round((gross / hours) * 100) / 100,
  };
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => {
  if (n === null || n === undefined) return '-';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
};
const small = (n) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const pct = (n) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}%`);
const age = (d) => (d === null || d === undefined ? 'unknown' : d >= 730 ? `${(d / 365.25).toFixed(1)}y` : d >= 60 ? `${Math.round(d / 30.4)}mo` : `${d}d`);
const mult = (n) => `x${(Math.round(n * 100) / 100).toFixed(2)}`;
const vclass = (label) => (label === 'Farm first' || label === 'Farm' ? 'farm' : label === 'Farm small' ? 'small' : 'watch');
const x2 = (n) => (n === null || n === undefined ? '-' : `x${n.toFixed(2)}`);

// ---------------------------------------------------------------- the strip

function strip() {
  const a = R.accounting;
  const v = R.model.validation;
  const chips = [
    `<b>${a.total}</b> protocols accounted for`,
    `<b>${a.ranked}</b> pre-token ranked`,
    `<b class="good">${a.watchlist}/${a.watchlist}</b> watchlist covered`,
    `model fitted on <b>${v.comps}</b> traded comps`,
    `held-out median error <b>x${v.half_a.median_error_x.toFixed(2)}</b> and <b>x${v.half_b.median_error_x.toFixed(2)}</b> (both directions)`,
    `<b>${Math.round((v.half_a.within_2x_pct + v.half_b.within_2x_pct) / 2)}%</b> of held-out comps priced within x2`,
    `launch odds from the peer record (base rate <b>${R.model.odds_base_pct}%</b> hold a token)`,
  ];
  $('strip').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
  $('asof').innerHTML = `Snapshot as of ${esc(R.as_of)}<br>Model <b>${esc(R.model.version)}</b> - watchlist floor ${money(R.floor_usd)}`;
}

// ---------------------------------------------------------------- accounting and integrity

// The board's checksum, the same FNV-1a the program states: recomputed here from the rows
// this page actually received, so the strip below is a check, not a copy.
function boardChecksum(list) {
  let h = 0x811c9dc5;
  const s = list.map((r) => `${r.rank}|${r.slug}|${r.implied_value_usd}|${r.expected_value_usd}`).join(';');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function renderChecks() {
  const a = R.accounting;
  const groupSum = a.groups.reduce((s, g) => s + g.count, 0);
  const ranksOk = rows.every((r, i) => r.rank === i + 1);
  const orderOk = rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd);
  const wlOk = rows.filter((r) => r.watchlist).length === a.watchlist;
  const sumOk = groupSum === a.total;
  const csOk = boardChecksum(rows) === R.integrity.checksum;
  const mark = (ok) => (ok ? '<b class="good">holds</b>' : '<b class="bad">FAILS</b>');
  const chips = [
    `<b>${a.total}</b> protocols, each in exactly one group: ${a.groups.map((g) => `<b>${g.count}</b> ${esc(g.short)}`).join(' - ')}`,
    `recomputed by this page from the rows it received: the groups sum to the snapshot total - ${mark(sumOk)} - ranks run 1 to ${rows.length} in order - ${mark(ranksOk)} - implied values never rise - ${mark(orderOk)} - all <b>${a.watchlist}</b> watchlist protocols are ranked - ${mark(wlOk)}`,
    `board checksum <b>${R.integrity.checksum}</b>, recomputed by this page from the rows it received - ${mark(csOk)}`,
  ];
  $('checks').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
}

// ---------------------------------------------------------------- the evidence panel

function renderEvidence() {
  const e = R.evidence;
  const w = e.walk_forward;
  $('evidence-text').innerHTML = `
    <p>Nothing on this page is asserted. The program that wrote this board also put it through two blind
    tests on this snapshot's <b>${e.loo_comps} traded comps</b>, with its own fitting code. <b>Walk-forward:</b>
    fit on the ${w.trained_on} comps listed earlier (${w.undated_in_train} record no listing date and train
    only), then price the ${w.tested_on} listed later. <b>Leave-one-out:</b> price each comp with a fit on the
    other ${e.loo_comps - 1}. Errors are medians, stated as multiples. Below the terms, a third test -
    a repeated split-half - decides which staged model the board ships; a fourth, the slug-hash split
    in both directions, is in the model panel below.</p>`;
  $('term-rows').innerHTML = e.terms.map((t) => `
    <tr><td><span class="pname">${esc(t.term)}</span>${t.verdict.startsWith('not kept') ? '<span class="cat"> - not in the model</span>' : ''} <span class="cat">- ${esc(t.detail)}</span></td>
    <td class="num">${x2(t.walk_forward_x)}</td><td class="num">${x2(t.loo_x)}</td><td>${esc(t.verdict)}</td></tr>`).join('');
  const s = e.selection;
  const stageName = ['no terms', 'size', 'size + family', 'size + family + growth', 'all four terms'];
  const med = s.stage_median_x.map((x, i) => `${stageName[i]} <b>x${x.toFixed(2)}</b>`).join(', ');
  $('selection-text').innerHTML = `
    <p>Why the model stops at two terms. The staged fits were also priced head to head over
    <b>${s.splits} seeded random splits</b> of the comps - fitted on ${s.train}, priced on ${s.test},
    then swapped: <b>${s.directions} pricings</b> per stage, computed by this program from this
    snapshot. Median error by stage: ${med}. The fuller models lose. The four-term model beats the
    shipped two-term model in only <b>${s.full_vs_shipped.win_rate_pct}%</b> of the pricings, and where
    both price the same split its median error runs <b>x${s.full_vs_shipped.ratio_median.toFixed(2)}</b>
    the shipped model's. The age term is the largest single offender: the four-term model beats the
    three-term model in only <b>${s.full_vs_growth.win_rate_pct}%</b> of pricings, so the step from
    three terms to four is where most of the damage arrives. Growth itself is a wash in the table
    above - walk-forward cannot tell it from nothing, and leave-one-out prices worse with it. The
    shipped model against size alone is a tie here (it wins <b>${s.shipped_vs_size.win_rate_pct}%</b>);
    family stays because walk-forward - the test shaped like the board's use, the past pricing the
    future - is where the two-term model posts the best error of any stage
    (x${e.terms[2].walk_forward_x.toFixed(2)}). A term the tests do not reward is not carried,
    however reasonable it sounds.</p>`;
  const srow = (label, c, note) => `
    <tr><td><span class="pname">${label}</span> <span class="cat">- ${note}</span></td>
    <td class="num">${c.wins} of ${s.directions}</td><td class="num">${c.win_rate_pct}%</td><td class="num">x${c.ratio_median.toFixed(2)}</td></tr>`;
  $('selection-rows').innerHTML =
    srow('Four terms vs the shipped two', s.full_vs_shipped, 'the fuller model prices worse blind; the board does not ship it') +
    srow('Four terms vs three - the age step', s.full_vs_growth, 'age alone accounts for most of the fuller model\u2019s damage') +
    srow('The shipped two vs size alone', s.shipped_vs_size, 'a tie here; the walk-forward column above is what keeps family');
  const o = e.odds;
  $('odds-text').innerHTML = `
    <p>The launch odds were scored the same way: the peer record fitted on one half of the snapshot's
    ${o.tested} protocols, blind, then used to call the other half - and swapped. Their Brier score (mean
    squared miss of the called probability; lower is better) is <b>${o.brier_model.toFixed(3)}</b>, against
    <b>${o.brier_base.toFixed(3)}</b> for calling the ${o.base_rate_pct}% base rate for everyone. The pooled
    record beats the base rate blind; it remains a record of peers, not a forecast.</p>`;
  const u = e.uncertainty;
  $('uncertainty-text').innerHTML = `
    <p>Uncertainty, from <b>${u.rounds} bootstrap refits</b> - the model refitted on resamples of its own
    comps, the spread of each statistic across the rounds stated as its standard error: the median fitted
    multiple is <b>x${u.multiple_median.toFixed(2)}</b> with a standard error of <b>${u.multiple_se.toFixed(2)}</b>;
    the out-of-bag median error is <b>x${u.oob_median_x.toFixed(2)}</b> with a standard error of
    <b>${u.oob_se_x.toFixed(2)}</b>; the Brier score above carries a standard error of <b>${u.brier_se.toFixed(3)}</b>.
    The multiples are wide because the comps themselves are wide; the page states the spread rather than
    hiding it.</p>`;
  const g = e.range;
  const levelRow = (lvl, name) => `
    <tr><td>${name} (x${lvl.lo_mult.toFixed(2)} to x${lvl.hi_mult.toFixed(2)})</td>
    <td class="num">${lvl.stated_pct}%</td><td class="num">${lvl.walk_forward_pct === null ? '-' : `${lvl.walk_forward_pct}%`}</td><td class="num">${lvl.loo_pct}%</td></tr>`;
  $('range-rows').innerHTML =
    levelRow(g.inner, `The range printed beside each implied value - the middle half of the model's own errors; ${g.within_3x_pct}% of blind-priced comps land within x3 of their real cap (leave-one-out)`) +
    levelRow(g.outer, `The wider range - the middle four fifths of the model's own errors, printed here for its record, not beside the values`);
}

// ---------------------------------------------------------------- the board

function visible() {
  let out = rows.filter((r) =>
    (state.fam === 'All families' || r.family === state.fam) &&
    (state.chain === 'All chains' || r.chains.includes(state.chain)) &&
    (state.verdict === 'All verdicts' || scenarioVerdict(r).label === state.verdict) &&
    (!state.wl || r.watchlist) &&
    (state.q === '' || r.name.toLowerCase().includes(state.q) || r.slug.includes(state.q)));
  if (state.key !== 'rank') {
    out = [...out].sort((a, b) => {
      const x = a[state.key];
      const y = b[state.key];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * state.dir;
    });
  }
  return out;
}

function renderBoard() {
  const out = visible();
  $('count').textContent = `${out.length} of ${rows.length} ranked protocols`;
  const worth = rows.filter((r) => scenarioVerdict(r).label !== 'Watch only').length;
  $('sc-head').innerHTML = `Worth farming in this scenario: <b>${worth} of ${rows.length}</b>`;
  $('rows').innerHTML = out.map((r) => {
    const sv = scenarioVerdict(r);
    return `
    <tr data-slug="${esc(r.slug)}" class="${state.sel === r.slug ? 'sel' : ''}">
      <td class="num">${r.rank}</td>
      <td><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="wl">WATCHLIST</span>' : ''}<br><span class="cat">${esc(r.category ?? 'Uncategorised')}</span></td>
      <td>${esc(r.family)}</td>
      <td class="chains">${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
      <td class="num">${age(r.age_days)}</td>
      <td class="num imp">${money(r.implied_value_usd)}<span class="rng">${money(r.implied_value_usd * R.evidence.range.inner.lo_mult)}-${money(r.implied_value_usd * R.evidence.range.inner.hi_mult)}</span></td>
      <td class="num">${Math.round(r.launch_odds * 100)}%</td>
      <td class="num">${money(r.expected_value_usd)}</td>
      <td class="num"><span class="vlab ${vclass(sv.label)}">${esc(sv.label)}</span><span class="rng">net ${money(sv.net)} - ${small(sv.perHour)}/h</span></td>
    </tr>`;
  }).join('');
  for (const tr of document.querySelectorAll('#rows tr')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  }
}

// ---------------------------------------------------------------- the detail view

// The plan's steps come from the program's own data (r.steps): the same steps, word for
// word, that board.json carries for this protocol, so the page cannot drift from the board.

function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  state.sel = slug;
  const d = $('detail');
  d.hidden = false;
  d.innerHTML = `
    <button class="close" id="close-detail">Close</button>
    <h2>${esc(r.name)} ${r.watchlist ? '<span class="wl">WATCHLIST</span>' : ''}</h2>
    <p class="sub">Rank #${r.rank} of ${rows.length} - ${esc(r.family)} (${esc(r.category ?? 'uncategorised')}) - on ${esc(r.chains.join(', ') || 'no chain listed')} - listed ${esc(r.listed_at ?? 'date unknown')}, ${age(r.age_days)} tokenless</p>
    <h3>How the model prices it</h3>
    <table>
      <tr><td>Size term - the fitted line read at its TVL of ${money(r.tvl_usd)}</td><td class="num">${money(r.base_value_usd)}</td></tr>
      <tr><td>Family adjustment (${esc(r.family)})</td><td class="num">${mult(r.family_multiplier)}</td></tr>
      <tr><td>Growth adjustment (7d TVL ${pct(r.change_7d)})${R.model.growth_coef === 0 ? ' - not a term of the shipped model: fitted, tested blind and not kept (see model selection above)' : ''}</td><td class="num">${mult(r.growth_multiplier)}</td></tr>
      <tr><td>Age adjustment (${age(r.age_days)} with no token)${R.model.age_coef === 0 ? ' - not a term of the shipped model: fitted, tested blind and not kept (see model selection above)' : ''}</td><td class="num">${mult(r.age_multiplier)}</td></tr>
      <tr><td><b>Implied launch value</b></td><td class="num imp">${money(r.implied_value_usd)}</td></tr>
      <tr><td>Launch odds - the peer record for its family, age band and size band</td><td class="num">${Math.round(r.launch_odds * 100)}%</td></tr>
      <tr><td><b>Expected value</b> (implied x odds)</td><td class="num">${money(r.expected_value_usd)}</td></tr>
      <tr><td>Printed range - the middle half of the model's own errors</td><td class="num">${money(r.implied_value_usd * R.evidence.range.inner.lo_mult)}-${money(r.implied_value_usd * R.evidence.range.inner.hi_mult)}</td></tr>
      <tr><td>Plan cost, all-in gas</td><td class="num">${small(r.plan.total_cost_usd)}</td></tr>
    </table>
    <div class="verdict"><b>Verdict: ${esc(r.verdict_label)}.</b> ${esc(r.verdict)}<br>Net of the plan's gas, the expected value is <b>${money(r.net_usd)}</b> - <b>${small(r.per_hour_usd)}</b> per active hour of the plan.</div>
    <h3>Farm plan - ${esc(r.plan.chain)}, ${small(r.plan.capital_usd)} position, ${r.plan.hold_days} days</h3>
    <ol class="plan">${r.steps.map((s) => `<li>${esc(s.text)}<span class="ct">Cost: ${esc(s.cost)}. Time: ${esc(s.time)}.</span></li>`).join('')}</ol>`;
  $('close-detail').addEventListener('click', () => { d.hidden = true; state.sel = null; renderBoard(); });
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderBoard();
}

// ---------------------------------------------------------------- the live set and the model

function renderLive() {
  $('live-rows').innerHTML = R.live.map((p) => `
    <tr><td><span class="pname">${esc(p.name)}</span><br><span class="cat">${esc(p.category ?? 'Uncategorised')}</span></td>
    <td>${esc(p.family)}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td>
    <td class="num">${p.multiple === null ? '-' : mult(p.multiple)}</td>
    <td class="num ${p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down'}">${pct(p.change_7d)}</td></tr>`).join('');
}

function renderModel() {
  const m = R.model;
  const v = m.validation;
  const a = R.accounting;
  const sel = R.evidence.selection;
  $('model-text').innerHTML = `
    <p>The implied value of every row comes from one function, fitted on the <b>${v.comps} protocols in
    this snapshot whose token already trades</b> with a market cap and a TVL (exchange tokens set aside).
    In log space: <code>value = A + B x log TVL + family</code>, with B = ${m.slope}. The size term is
    fitted by least squares with one Huber reweighting pass, because the comps' value-to-TVL ratios run
    from under 0.01x to over 100x and the extremes should not drag the line; the family adjustment is
    fitted on the residuals the size term leaves, each family's mean residual shrunk toward zero by
    n/(n+6) so a family with two comps barely moves it. No protocol's name is special-cased anywhere.</p>
    <p>Two further terms were fitted on the residuals in the same way - a growth term on the clamped
    7-day TVL change and an age term on log(1 + years tokenless) - and the model does not carry them:
    priced blind over ${sel.directions} repeated split-half pricings, the four-term model beats this
    one only ${sel.full_vs_shipped.win_rate_pct}% of the time. The term table and the model-selection
    record in the evidence panel above show the tests that decided it; each protocol's detail view
    still shows the two adjustments, at x1.00, because a term that is not carried moves nothing.</p>
    <p>Launch odds are the snapshot's own cross-section, not a forecast: for a protocol's family, its age
    band and its TVL band, the share of protocols that already record a token, each smoothed toward the
    universe's ${m.odds_base_pct}% base rate and pooled. Expected value is implied value times those odds.
    Treat every implied value as the centre of the printed range beside it - the middle half of the
    model's own errors - whose measured coverage the evidence panel above the board states. The
    ranking is what the model stands behind; the exact dollar figure is an estimate
    with held-out median errors of x${v.half_a.median_error_x.toFixed(1)} and x${v.half_b.median_error_x.toFixed(1)} in the two directions.</p>
    <p>Every row's farm plan is written by the program, not pasted: six steps priced from the protocol's
    own chain, TVL band and age, and a seventh when its record calls for one - a seven-day TVL fall of
    15% or more, a rise of 25% or more, no listing date recorded, a listing under 60 days old, or a
    protocol spread over six or more chains. The step the record calls for sits fourth, right after
    the position itself is opened, and the detail view shows it in place.</p>`;
  const hrow = (label, h) => `<tr><td>${label}</td><td class="num">${h.fitted_on}</td><td class="num">${h.tested_on}</td><td class="num">x${h.median_error_x.toFixed(2)}</td><td class="num">${h.within_2x_pct}%</td></tr>`;
  $('valid-rows').innerHTML = hrow('Half A fits, half B is priced', v.half_a) + hrow('Half B fits, half A is priced', v.half_b);
  $('fam-rows').innerHTML = Object.keys(m.family_adj).map((f) => `
    <tr><td>${esc(f)}</td><td class="num">${m.family_comps[f]}</td><td class="num">${mult(Math.exp(m.family_adj[f]))}</td></tr>`).join('');
  const arow = (label, n) => `<tr><td>${label}</td><td class="num">${n}</td></tr>`;
  $('acct-rows').innerHTML =
    arow('Protocols in the snapshot', a.total) +
    a.groups.map((g) => arow(esc(g.label[0].toUpperCase() + g.label.slice(1)), g.count)).join('') +
    arow(' - of the ranked, on the house watchlist', a.watchlist);
  $('foot').textContent = `Data: the sealed DefiLlama snapshot of ${R.as_of}, read once by the program; nothing on this page is fetched. Model ${m.version}. Farm plans are planning estimates - gas figures are per-chain planning numbers, and a protocol's own page is the authority on its program.`;
}

// ---------------------------------------------------------------- wiring

function init() {
  strip();
  renderChecks();
  renderEvidence();
  const fams = ['All families', ...new Set(rows.map((r) => r.family))];
  $('fam').innerHTML = fams.map((f) => `<option>${esc(f)}</option>`).join('');
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = ['All chains', ...chains].map((c) => `<option>${esc(c)}</option>`).join('');
  $('vfilter').innerHTML = ['All verdicts', 'Farm first', 'Farm', 'Farm small', 'Watch only'].map((v) => `<option>${esc(v)}</option>`).join('');
  $('vfilter').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  const scenSync = () => {
    $('sc-size-v').textContent = `x${scen.size.toFixed(2)}`;
    $('sc-share-v').textContent = `${scen.share}%`;
    $('sc-horizon-v').textContent = scen.horizon === 0 ? 'as planned' : `${scen.horizon} weeks`;
  };
  $('sc-size').addEventListener('input', (e) => { scen.size = Number(e.target.value); scenSync(); renderBoard(); });
  $('sc-share').addEventListener('input', (e) => { scen.share = Number(e.target.value); scenSync(); renderBoard(); });
  $('sc-horizon').addEventListener('input', (e) => { scen.horizon = Number(e.target.value); scenSync(); renderBoard(); });
  $('sc-reset').addEventListener('click', () => {
    scen.size = 1; scen.share = 100; scen.horizon = 0;
    $('sc-size').value = '1'; $('sc-share').value = '100'; $('sc-horizon').value = '0';
    scenSync(); renderBoard();
  });
  scenSync();
  const hf = location.hash.match(/^#\/f\/(.+)$/);
  if (hf) {
    const fam = decodeURIComponent(hf[1]);
    if (fams.includes(fam)) { state.fam = fam; $('fam').value = fam; }
  }
  $('q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderBoard(); });
  $('fam').addEventListener('change', (e) => { state.fam = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('wl').addEventListener('change', (e) => { state.wl = e.target.checked; renderBoard(); });
  for (const th of document.querySelectorAll('#board th.sortable')) {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (k === 'rank') { state.key = 'rank'; }
      else if (state.key === k) { state.dir = -state.dir; }
      else { state.key = k; state.dir = k === 'name' || k === 'family' ? 1 : -1; }
      renderBoard();
    });
  }
  renderBoard();
  renderLive();
  renderModel();
  const h = location.hash.match(/^#\/p\/(.+)$/);
  if (h) openDetail(decodeURIComponent(h[1]));
}

init();
