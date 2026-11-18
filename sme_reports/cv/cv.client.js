// GE CV Insights viewer: the CV parts of the client (hhm_rpp_ge
// PLAN-CV-INSIGHTS.md §13.2 item 6). Not a script on its own:
// cv/render.js passes this file to insights/page.js assemble_client(),
// which puts each section below in place of the core's marker of the same
// name (insights/client_core.js lists what the core gives). Text before the
// first marker (this comment) is dropped.
//@@header@@
/* Client for the GE CV Insights viewer (cv/render.js inlines it). One file,
   many systems: the dashboard and every system view are inert <template>s,
   and the hash picks one. A system's JSON block is parsed only when it is
   opened, and its panels are drawn from it for the chosen period. The page
   only draws: every number comes from the builder, summed here over the
   period's days. Offline: no fetch, no server. */
//@@charts@@
// Categorical slots 1-8 of the reference palette, in their fixed order
// (dataviz palette.md; slots 1-5 validated adjacent on the light surface).
// A dim keeps its slot in every period: the slot is its rank over all
// history. Anything past slot 8, or outside a chart's top list, is "other".
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#a3a29c';
// A dim in a chart's top list past slot 8 keeps its place with a fallback
// grey and its name in the legend and caption (review CV6-PAGE F2).
const FALLBACK = ['#5f5e5a', '#7d7c76'];
// n / d x scale to 2 decimals, exact half-up from integers (review CV6-PAGE
// F4: Math.round on the double can round a half-cent tie down, e.g. 323/40).
const q2 = (n, d, scale = 1) => {
  if(!d) return '—';
  const k = Math.floor((200 * scale * n + d) / (2 * d));
  return `${Math.floor(k / 100)}.${String(k % 100).padStart(2, '0')}`;
};
const SUB_COLOR = { POS: SERIES[0], RTA: SERIES[1], DL: SERIES[2], other: OTHER };
const SUB_NAME = { POS: 'positioner (POS)', RTA: 'acquisition (RTA)', DL: 'DL', other: 'other subsystems' };
const BAND_NAME = { cv_error_storm: 'storm', cv_detector_com_errors: 'detector', cv_anticollision_burst: 'anticollision', cv_table_encoder_fault: 'table', cv_pib_com_loss: 'PIB' };
const human = d => d === '' ? 'all' : String(d).replace(/_/g, ' ').trim();

// Peaks (§13.3 Q8): by default the errors timeline is cut at 1.5 x the
// period's 95th-percentile data day; "Full scale" shows every day whole.
let fullScale = false;
app.addEventListener('click', e => {
  const b = e.target.closest('button[data-scale]');
  if(!b) return;
  fullScale = b.dataset.scale === 'full';
  const cur = app.querySelector('.periodbar .seg button[aria-pressed="true"]');
  if(cur) cur.click(); // redraw the panels for the same period
});

function scaleBar(){
  return `<div class="scalebar"><span class="ctl-label">Scale</span><div class="seg" role="group" aria-label="Scale"><button type="button" data-scale="clip" aria-pressed="${!fullScale}">Clip peaks</button><button type="button" data-scale="full" aria-pressed="${fullScale}">Full scale</button></div></div>`;
}

// Stacked daily bars with the peaks cut at a limit (the core's bars() when
// nothing is cut). Days above the limit get a mark at the top; the tooltip
// gives the full counts.
function barsClip(v, a, b, title, stacks, cap){
  const tot = i => { let s = 0; for(const st of stacks) s += st.arr[i]; return s; };
  const vals = [];
  for(let i = a; i <= b; i++) if(v.data[i] === '1') vals.push(tot(i));
  vals.sort((x, y) => x - y);
  const max = vals.length ? vals[vals.length - 1] : 0;
  const p95 = vals.length ? vals[Math.max(0, Math.ceil(0.95 * vals.length) - 1)] : 0;
  const lim = niceMax(1.5 * p95);
  if(fullScale || !(p95 > 0) || max <= lim){
    const note = fullScale && p95 > 0 && max > lim ? ` Full scale: the busiest day is ${n0(max)}; the 95th-percentile day is ${n0(p95)}.` : '';
    return bars(v, a, b, title, stacks, cap + note);
  }
  const n = b - a + 1, bw = (W - ML - MR) / n, gap = bw > 4 ? 1 : 0;
  const x = i => ML + (i - a) * bw, y = val => H - MB - (Math.min(val, lim) / lim) * (H - MT - MB);
  const rects = [], marks = [];
  let cut = 0;
  for(let i = a; i <= b; i++){
    let base = 0;
    for(const st of stacks){
      const val = st.arr[i]; if(!val) continue;
      if(base < lim) rects.push(`<rect x="${(x(i) + gap / 2).toFixed(2)}" y="${y(base + val).toFixed(2)}" width="${Math.max(0.6, bw - gap).toFixed(2)}" height="${Math.max(0, y(base) - y(base + val)).toFixed(2)}" fill="${st.color}"/>`);
      base += val;
    }
    if(base > lim){
      cut++;
      const cx = x(i) + bw / 2, w = Math.max(3, Math.min(6, bw / 2));
      marks.push(`<path class="peak" d="M${(cx - w).toFixed(2)},${(MT + 6).toFixed(2)}L${cx.toFixed(2)},${MT.toFixed(2)}L${(cx + w).toFixed(2)},${(MT + 6).toFixed(2)}Z"/>`);
    }
  }
  const id = 'c' + (++chartSeq);
  charts.set(id, { a, b, x0: ML, bw, tip: i => `<b>${longDay(v.day(i))}</b>${v.data[i] === '1' ? '' : ' · no data'}<br>${stacks.map(st => `${esc(st.name)}: ${n0(st.arr[i])}`).join('<br>')}${tot(i) > lim ? `<br>total ${n0(tot(i))}, cut at ${n0(lim)}` : ''}` });
  const legend = stacks.length > 1 ? legendOf(stacks.map(s => [s.color, s.name])) : '';
  const note = ` Peaks above ${n0(lim)} a day are cut at the top (▲) on ${cut} day${cut === 1 ? '' : 's'}; the busiest is ${n0(max)}. The scale top is 1.5 × the period's 95th-percentile data day (${n0(p95)}), rounded up to an axis step; the tooltip gives every day's full count.`;
  return frame(id, title, cap + note, legend, noData(v, a, b, x, bw) + yAxis(0, lim, y) + rects.join('') + marks.join('') + xAxis(v, a, b, x));
}

// Findings as bands on the same day axis: opened day to resolved day (open:
// to the last data day), one row each; a band outside the period is left out.
function bandsChart(v, a, b){
  const vis = v.bands.filter(d => d.to >= a && d.from <= b);
  if(!vis.length) return `<div class="chart"><h3>Findings in the period</h3><p class="cap">No finding was open in the period.</p></div>`;
  const n = b - a + 1, bw = (W - ML - MR) / n, x = i => ML + (i - a) * bw, RH = 18, h = 8 + vis.length * RH;
  const rows = vis.map((d, k) => {
    const f = Math.max(d.from, a), t = Math.min(d.to, b), y0 = 4 + k * RH;
    const x0 = x(f), x1 = x(t) + bw, name = `${BAND_NAME[d.key] || d.key} (${d.severity}${d.status === 'open' ? ', open' : ''})`;
    // the label: right of the band, else left of it, else inside the plot
    // over the band (review CV6-PAGE F3); 6.4 user units a character is a
    // safe width at 10.5 px
    const tw = name.length * 6.4;
    const pos = x1 + 6 + tw <= W ? ['start', x1 + 6, ''] : x0 - 6 - tw >= 0 ? ['end', x0 - 6, ''] : ['start', Math.max(x0, ML) + 6, ' in'];
    return `<rect class="bandr ${esc(d.severity)}${d.status === 'open' ? '' : ' resolved'}" x="${x0.toFixed(2)}" y="${y0 + 3}" width="${Math.max(2, x1 - x0).toFixed(2)}" height="${RH - 8}" rx="3"/>` +
      `<text class="bandt${pos[2]}" x="${pos[1].toFixed(2)}" y="${y0 + 12}" text-anchor="${pos[0]}">${esc(name)}</text>`;
  }).join('');
  const id = 'c' + (++chartSeq);
  charts.set(id, { a, b, x0: ML, bw, tip: i => { const on = vis.filter(d => d.from <= i && d.to >= i); return `<b>${longDay(v.day(i))}</b><br>${on.length ? on.map(d => `${esc(d.label)} · ${esc(d.severity)}${d.status === 'open' ? ' · open' : ''}<br><small>${esc(d.opened_day)} → ${esc(d.end_day)}${d.status === 'open' ? ' (last data)' : ''}</small>`).join('<br>') : 'no finding open'}`; } });
  return `<div class="chart"><h3>Findings in the period</h3>${legendOf([['var(--high)', 'high'], ['var(--med)', 'medium'], ['var(--blue)', 'low']])}<div class="cw"><svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Findings in the period" data-chart="${id}">${rows}</svg></div><p class="cap">Each finding from the day it opened to the day it resolved (an open finding: to the last data day), on the same days as the chart above. Findings of one episode line up; faded bands are resolved.</p></div>`;
}

// A dim's slot: its rank over all history (verified ranks for the ranked
// metrics; else by total, then name).
function dimOrder(v, m){
  if(v.ranks[m]) return v.ranks[m].all;
  return Object.keys(v.dims[m] || {}).map(d => [d, sum(v.dims[m][d], 0, v.L)]).sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(p => p[0]);
}
// Stacks of a metric by dim: every dim (in slot order), or, for a ranked
// metric, the period's top `top` dims and "other".
function dimStacks(v, m, a, b, top){
  const order = dimOrder(v, m), dims = v.dims[m] || {};
  const slot = d => order.indexOf(d);
  // the period's top dims (ranked metrics) or every dim: all kept, whatever
  // their slot (review CV6-PAGE F2); past slot 8 a fallback grey
  const chosen = top ? (v.ranks[m][period] || []).slice(0, top) : order.filter(d => sum(dims[d], a, b) > 0 || order.length <= 5);
  let fb = 0;
  const stacks = chosen.map(d => ({ name: human(d), color: slot(d) >= 0 && slot(d) < SERIES.length ? SERIES[slot(d)] : FALLBACK[fb++ % FALLBACK.length], arr: dims[d] }));
  const rest = Object.keys(dims).filter(d => !chosen.includes(d));
  if(rest.length){
    const arr = new Array(v.nd).fill(0);
    for(const d of rest) for(let i = 0; i < v.nd; i++) arr[i] += dims[d][i];
    if(sum(arr, a, b) > 0) stacks.push({ name: `other (${rest.length})`, color: OTHER, arr });
  }
  return stacks;
}
// The period totals of each stack, as text (labels beside colour, §6 of the dataviz checks).
const totals = (stacks, a, b) => stacks.map(s => `${esc(s.name)} ${n0(sum(s.arr, a, b))}`).join(' · ');
// A metric with dims is drawn by dim, also when only one dim shows (it
// keeps its name and colour; review CV6-PAGE F1); a dimensionless metric
// (its only dim is '') as one series.
const metricBars = (v, a, b, m, cap, top) => {
  if(!v.ev[m]) return '';
  const dims = Object.keys(v.dims[m] || {});
  const plain = dims.length === 1 && dims[0] === '';
  const st = plain ? [] : dimStacks(v, m, a, b, top);
  const series = st.length ? st : [{ name: label(v, m), color: SERIES[0], arr: v.ev[m] }];
  const legend = st.length === 1 ? ` (${esc(st[0].name)})` : '';
  return bars(v, a, b, `${label(v, m)} per day${legend}`, series, `${cap ? cap + ' ' : ''}In the period: ${st.length ? totals(st, a, b) : n0(sum(v.ev[m], a, b))}.`);
};
const evDays = (v, m, a, b) => { let s = 0; if(v.ev[m]) for(let i = a; i <= b; i++) if(v.ev[m][i] > 0) s++; return s; };
const evStat = (v, a, b, m) => v.ev[m] ? stat(label(v, m), n0(sum(v.ev[m], a, b)), `on ${evDays(v, m, a, b)} days in the period`) : '';

// Error codes in the period: the top 10 and "other"; every code behind a toggle.
function codeRows(rows, total){
  return rows.map(([c, n, d]) => {
    const k = INDEX.codes[c] || {};
    const lbl = k.label == null ? '<span class="to">no readable label</span>' : `${esc(k.label)}${k.share != null ? `<small>${(100 * k.share).toFixed(1)}% of the code's rows have this text</small>` : ''}`;
    return `<tr><td><code>${esc(c)}</code></td><td>${esc(k.subsystem || '—')}</td><td class="lbl">${lbl}</td><td><code>${esc(k.sourcefile || '—')}</code></td><td class="num">${n0(n)}</td><td class="num">${q2(n, total, 100)}%</td><td class="num">${n0(d)}</td></tr>`;
  }).join('');
}
const CODE_HEAD = '<thead><tr><th scope="col">Code</th><th scope="col">Subsystem</th><th scope="col">Label (most common text, numbers masked)</th><th scope="col">Source file</th><th scope="col" class="num">Entries</th><th scope="col" class="num">Share</th><th scope="col" class="num">Days</th></tr></thead>';
//@@panel-keys@@
const PANELS = ['errors', 'codes', 'detector', 'positioner', 'connectivity'];
//@@panels@@
const PANEL = {
  errors(v, a, b){
    const keys = Object.keys(v.subs);
    const stacks = keys.map(k => ({ name: SUB_NAME[k] || k, color: SUB_COLOR[k] || OTHER, arr: v.subs[k] }));
    const all = new Array(v.nd).fill(0); for(const k of keys) for(let i = 0; i < v.nd; i++) all[i] += v.subs[k][i];
    const errs = sum(all, a, b), dd = count(v.data, a, b);
    let bi = -1; for(let i = a; i <= b; i++) if(bi < 0 || all[i] > all[bi]) bi = i;
    return box('Errors', 'error-log entries per device day', [
      stat('Entries', n0(errs), `in ${dd} data days`),
      stat('Per data day', q2(errs, dd), 'in the period'),
      stat('Busiest day', bi >= 0 && all[bi] ? n0(all[bi]) : '—', bi >= 0 && all[bi] ? longDay(v.day(bi)) : ''),
      stat('Findings', n0(v.bands.filter(d => d.to >= a && d.from <= b).length), 'open at some point in the period')
    ], scaleBar() + barsClip(v, a, b, 'Error-log entries per day, by subsystem', stacks, `In the period: ${totals(stacks, a, b)}. Grey: no log that day (the log has entries only when something is logged; a quiet day has about 8–50).`) + bandsChart(v, a, b));
  },
  codes(v, a, b){
    const t = v.codes[period];
    if(!t.total) return box('Errors by code', '', [], '<p class="nodata">No entries in the period.</p>');
    const top = t.rows.slice(0, t.top);
    const other = t.other ? `<tr class="dim"><td colspan="4">${t.rows.length - t.top} other codes</td><td class="num">${n0(t.other)}</td><td class="num">${q2(t.other, t.total, 100)}%</td><td></td></tr>` : '';
    return box('Errors by code', `${n0(t.rows.length)} codes in the period`, [
      stat('Entries', n0(t.total), `${n0(t.rows.length)} codes`),
      stat('Top 10 codes', t.total ? `${q2(t.total - t.other, t.total, 100)}%` : '—', 'of the entries')
    ], `<div class="chart"><h3>Top codes in the period</h3><div class="scroll"><table class="codes">${CODE_HEAD}<tbody>${codeRows(top, t.total)}${other}</tbody></table></div></div>` +
      (t.rows.length > t.top ? `<details class="allcodes"><summary>All ${n0(t.rows.length)} codes in the period</summary><div class="scroll"><table class="codes">${CODE_HEAD}<tbody>${codeRows(t.rows, t.total)}</tbody></table></div></details>` : '') +
      '<p class="note">Labels are internal wording derived from the data (the most common readable debug text of the code), not a decoding of GE\'s encoded fields. Source file: base name only.</p>');
  },
  detector(v, a, b){
    const m = 'cv.detector_com_error';
    const st = [evStat(v, a, b, m)];
    if(v.offset) st.push(stat('Detector offset (1200019)', n0(sum(v.offset, a, b)), 'entries in the period'));
    return box('Detector', '', st, metricBars(v, a, b, m, 'Stacked by the operation that failed.') +
      (v.offset ? bars(v, a, b, 'Detector offset entries per day (code 1200019)', [{ name: 'code 1200019', color: SERIES[0], arr: v.offset }], `In the period: ${n0(sum(v.offset, a, b))}. Shown on its own: the storm finding leaves this code out, and the detector finding reports it alongside.`) : ''));
  },
  positioner(v, a, b){
    const ms = ['cv.positioner_collision', 'cv.anticollision_error', 'cv.table_encoder_failure', 'cv.emergency_backout'];
    return box('Positioner and table', '', ms.map(m => evStat(v, a, b, m)).filter(Boolean),
      metricBars(v, a, b, 'cv.positioner_collision', 'By part.') +
      metricBars(v, a, b, 'cv.anticollision_error', 'The 4 axes with the most errors in the period, then the rest as other.', 4) +
      metricBars(v, a, b, 'cv.table_encoder_failure', 'The 4 axes with the most failures in the period, then the rest as other.', 4) +
      metricBars(v, a, b, 'cv.emergency_backout', '') +
      '<p class="note">Collisions and emergency backouts happen in everyday use; they are shown as data, not findings.</p>');
  },
  connectivity(v, a, b){
    const ms = ['cv.pib_com_loss', 'cv.worklist_query_failed', 'cv.dose_export_rejected'];
    return box('Connectivity', '', ms.map(m => evStat(v, a, b, m)).filter(Boolean),
      metricBars(v, a, b, 'cv.pib_com_loss', 'Positioner interface board resets and failures.') +
      metricBars(v, a, b, 'cv.worklist_query_failed', 'By failure kind.') +
      metricBars(v, a, b, 'cv.dose_export_rejected', '') +
      '<p class="note">The log has no success records, so these are counts, not rates. Dose-export rejections are data only until field service confirms the setup.</p>');
  }
};
