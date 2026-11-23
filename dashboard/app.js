// Launch Radar's page: renders the board the program wrote into ../data.js - the same figures,
// the same order, the same plans as board.json, because both come from one run of the model.
// No framework, no fetch, no network: sort, filter, search and the detail view all happen here.

const R = window.RADAR;
const rows = R.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));
const state = { q: '', fam: 'All families', chain: 'All chains', wl: false, key: 'rank', dir: 1, sel: null };

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

// ---------------------------------------------------------------- the strip

function strip() {
  const a = R.accounting;
  const v = R.model.validation;
  const chips = [
    `<b>${a.total}</b> protocols accounted for`,
    `<b>${a.ranked}</b> pre-token ranked`,
    `<b class="good">${a.watchlist}/${a.watchlist}</b> watchlist covered`,
    `model fitted on <b>${v.comps}</b> traded comps`,
    `held-out median error <b>x${v.half_a.median_error_x}</b> and <b>x${v.half_b.median_error_x}</b> (both directions)`,
    `<b>${Math.round((v.half_a.within_2x_pct + v.half_b.within_2x_pct) / 2)}%</b> of held-out comps priced within x2`,
    `launch odds from the peer record (base rate <b>${R.model.odds_base_pct}%</b> hold a token)`,
  ];
  $('strip').innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
  $('asof').innerHTML = `Snapshot as of ${esc(R.as_of)}<br>Model <b>${esc(R.model.version)}</b> - watchlist floor ${money(R.floor_usd)}`;
}

// ---------------------------------------------------------------- the board

function visible() {
  let out = rows.filter((r) =>
    (state.fam === 'All families' || r.family === state.fam) &&
    (state.chain === 'All chains' || r.chains.includes(state.chain)) &&
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
  $('rows').innerHTML = out.map((r) => `
    <tr data-slug="${esc(r.slug)}" class="${state.sel === r.slug ? 'sel' : ''}">
      <td class="num">${r.rank}</td>
      <td><span class="pname">${esc(r.name)}</span>${r.watchlist ? '<span class="wl">WATCHLIST</span>' : ''}<br><span class="cat">${esc(r.category ?? 'Uncategorised')}</span></td>
      <td>${esc(r.family)}</td>
      <td class="chains">${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
      <td class="num">${age(r.age_days)}</td>
      <td class="num imp">${money(r.implied_value_usd)}</td>
      <td class="num">${Math.round(r.launch_odds * 100)}%</td>
      <td class="num">${money(r.expected_value_usd)}</td>
    </tr>`).join('');
  for (const tr of document.querySelectorAll('#rows tr')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  }
}

// ---------------------------------------------------------------- the detail view

// The plan's steps, phrased from the same spec the program priced into board.json.
function planSteps(r) {
  const s = r.plan;
  return [
    [`Start from a fresh wallet that holds only the funds for this farm, seed phrase written offline; never farm from a wallet that holds savings.`, 'nothing to open; about $3 of gas to fund it', '10 minutes'],
    [`Move ${small(s.capital_usd)} of USDC onto ${s.chain} (bridge or exchange withdrawal), keeping ${small(s.gas_usd * 3)} aside for gas.`, `about ${small(s.gas_usd)} in gas`, '15 minutes'],
    [s.action, `${small(s.capital_usd)} of capital in the position, about ${small(s.gas_usd)} in gas`, '20 minutes to set up'],
    [`Repeat one qualifying action a week for ${s.weeks} weeks - a deposit top-up, a borrow repay, a swap or a vote - always from the same wallet.`, `about ${small(s.weekly_gas_usd)} of gas a week, ${small(s.weekly_gas_usd * s.weeks)} over the plan`, '10 minutes a week'],
    [`Hold the position at least ${s.hold_days} days so the activity lands in more than one weekly snapshot; points programs count duration, not just volume.`, `the ${small(s.capital_usd)} stays locked in the position`, `${s.hold_days} days`],
    [`Claim only from the link on ${r.name}'s own page, never from a search ad or a DM; then log the wallet, dates and transactions so the position can be repeated or unwound.`, 'no honest claim charges a fee; logging is free', '15 minutes'],
  ];
}

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
      <tr><td>Growth adjustment (7d TVL ${pct(r.change_7d)})</td><td class="num">${mult(r.growth_multiplier)}</td></tr>
      <tr><td>Age adjustment (${age(r.age_days)} with no token)</td><td class="num">${mult(r.age_multiplier)}</td></tr>
      <tr><td><b>Implied launch value</b></td><td class="num imp">${money(r.implied_value_usd)}</td></tr>
      <tr><td>Launch odds - the peer record for its family, age band and size band</td><td class="num">${Math.round(r.launch_odds * 100)}%</td></tr>
      <tr><td><b>Expected value</b> (implied x odds)</td><td class="num">${money(r.expected_value_usd)}</td></tr>
      <tr><td>Plan cost, all-in gas</td><td class="num">${small(r.plan.total_cost_usd)}</td></tr>
    </table>
    <div class="verdict"><b>Verdict:</b> ${esc(r.verdict)}</div>
    <h3>Farm plan - ${esc(r.plan.chain)}, ${small(r.plan.capital_usd)} position, ${r.plan.hold_days} days</h3>
    <ol class="plan">${planSteps(r).map((s) => `<li>${esc(s[0])}<span class="ct">Cost: ${esc(s[1])}. Time: ${esc(s[2])}.</span></li>`).join('')}</ol>`;
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
  $('model-text').innerHTML = `
    <p>The implied value of every row comes from one function, fitted on the <b>${v.comps} protocols in
    this snapshot whose token already trades</b> with a market cap and a TVL (exchange tokens set aside).
    In log space: <code>value = A + B x log TVL + family + G x 7d growth + M x log(1 + age)</code>, with
    B = ${m.slope}, G = ${m.growth_coef} per growth point, M = ${m.age_coef}. The size term is fitted by
    least squares with one Huber reweighting pass, because the comps' value-to-TVL ratios run from under
    0.01x to over 100x and the extremes should not drag the line; each later term is fitted on the
    residuals the terms before it leave, and each family's adjustment is shrunk toward zero by
    n/(n+6) so a family with two comps barely moves it. No protocol's name is special-cased anywhere.</p>
    <p>Launch odds are the snapshot's own cross-section, not a forecast: for a protocol's family, its age
    band and its TVL band, the share of protocols that already record a token, each smoothed toward the
    universe's ${m.odds_base_pct}% base rate and pooled. Expected value is implied value times those odds.
    Treat every implied value as the centre of a wide range - the held-out record below is the honest
    width of it. The ranking is what the model stands behind; the exact dollar figure is an estimate
    with error bars of roughly x${v.half_a.median_error_x} either way.</p>`;
  const hrow = (label, h) => `<tr><td>${label}</td><td class="num">${h.fitted_on}</td><td class="num">${h.tested_on}</td><td class="num">x${h.median_error_x}</td><td class="num">${h.within_2x_pct}%</td></tr>`;
  $('valid-rows').innerHTML = hrow('Half A fits, half B is priced', v.half_a) + hrow('Half B fits, half A is priced', v.half_b);
  $('fam-rows').innerHTML = Object.keys(m.family_adj).map((f) => `
    <tr><td>${esc(f)}</td><td class="num">${m.family_comps[f]}</td><td class="num">${mult(Math.exp(m.family_adj[f]))}</td></tr>`).join('');
  const arow = (label, n) => `<tr><td>${label}</td><td class="num">${n}</td></tr>`;
  $('acct-rows').innerHTML =
    arow('Protocols in the snapshot', a.total) +
    arow('Ranked on this board (pre-token, launch candidates)', a.ranked) +
    arow(' - of which on the house watchlist', a.watchlist) +
    arow('Already trading, with a price - the comps the model is fitted on', a.comps) +
    arow('Already trading, no price recorded in the snapshot', a.tokenized_unpriced) +
    arow('Set aside: wrapped, staked or bridged products of tokens that already trade', a.excluded_products) +
    arow('Set aside: exchange front-ends', a.excluded_cex) +
    arow('Set aside: versioned pools of another protocol', a.excluded_versioned);
  $('foot').textContent = `Data: the sealed DefiLlama snapshot of ${R.as_of}, read once by the program; nothing on this page is fetched. Model ${m.version}. Farm plans are planning estimates - gas figures are per-chain planning numbers, and a protocol's own page is the authority on its program.`;
}

// ---------------------------------------------------------------- wiring

function init() {
  strip();
  const fams = ['All families', ...new Set(rows.map((r) => r.family))];
  $('fam').innerHTML = fams.map((f) => `<option>${esc(f)}</option>`).join('');
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = ['All chains', ...chains].map((c) => `<option>${esc(c)}</option>`).join('');
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
