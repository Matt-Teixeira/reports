/* GE Insights viewers: the shared client core (sme_reports/insights/,
   hhm_rpp_ge PLAN-CV-INSIGHTS.md §13.3 Q1). Not a script on its own: each
   viewer keeps a parts file (ct/ct.client.js, cv/cv.client.js) with four
   sections, and insights/page.js assemble_client() puts them in place of
   the four marker lines below. Everything above the header marker (this
   comment) is dropped.
     //@@header@@      the viewer's own leading comment
     //@@charts@@      viewer-specific chart functions
     //@@panel-keys@@  const PANELS = [...]   (panel order)
     //@@panels@@      const PANEL = {...}    (one draw function per panel)
   The core gives the parts, inside one IIFE: INDEX, app, tip, period,
   the colours C1 / C2 / NODATA / RAMP, esc, n0, n2, DAY, MON, DOW,
   longDay, sum, count, label, unit, W / H / ML / MR / MT / MB, charts,
   chartSeq, niceMax, fmtTick, xAxis, yAxis, noData, frame, legendOf,
   bars, line, gauge, hookCharts (tooltips: plain day charts, plus
   c.heat / c.cal cells), stat, box, evBars, evTotal; and it mounts the
   dashboard filter (#dfilter, #systems) and each system view (period bar,
   .panels drawn as PANELS.filter(in v.panels).map(PANEL[k])).
   Do not add comments below the header marker without checking
   dev/check_ct.js and the CT byte-identity note in §13.5 step 1: every
   byte below it reaches the CT page. */
//@@header@@
(function(){
'use strict';
const INDEX = JSON.parse(document.getElementById('app-index').textContent);
const app = document.getElementById('app');
const tip = document.getElementById('tip');
const titles = new Map(INDEX.systems.map(s => [s.id, s.title]));
const PERIODS = INDEX.periods;
let period = INDEX.default_period; // carried from system to system
let filter = '';
let current = null;                // null before the first view, '' = the dashboard
let dashY = 0;
if('scrollRestoration' in history) history.scrollRestoration = 'manual';

// Colors: categorical slots 1-2 and a one-hue sequential ramp (validated
// with the dataviz palette checks on the white surface).
const C1 = '#2a78d6', C2 = '#eb6834', NODATA = '#EEF1F4', RAMP = ['#cde2fb','#9ec5f4','#6da7ec','#3987e5','#256abf','#184f95','#0d366b'];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n0 = v => v == null ? '—' : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const n2 = v => v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2);
const DAY = 864e5;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// ------------------------------------------------------------ dashboard

function mountDashboard(){
  const input = document.getElementById('dfilter');
  const rows = [...document.querySelectorAll('#systems tbody tr[data-sys]')];
  const shown = document.getElementById('dshown');
  const apply = () => {
    const q = filter.trim().toLowerCase();
    let n = 0;
    rows.forEach(r => { const hit = !q || r.dataset.q.includes(q); r.hidden = !hit; if(hit) n++; });
    shown.textContent = q ? `${n} of ${rows.length} shown` : '';
  };
  input.value = filter;
  input.addEventListener('input', () => { filter = input.value; apply(); });
  document.getElementById('systems').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-sys]');
    if(tr && !e.target.closest('a')) location.hash = tr.dataset.sys;
  });
  apply();
}

// ------------------------------------------------------------ system view

function mountSystem(sys){
  const v = JSON.parse(document.getElementById('data-' + sys).textContent);
  const d0 = Date.parse(v.d0 + 'T00:00:00Z') / DAY;
  v.day = i => { const d = new Date((d0 + i) * DAY); return d.toISOString().slice(0, 10); };
  v.L = v.nd - 1;
  const bar = app.querySelector('.seg');
  const draw = () => {
    bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
    const p = PERIODS.find(x => x.key === period);
    const a = p.days == null ? 0 : Math.max(0, v.L - p.days + 1);
    app.querySelector('.pspan').textContent = `${longDay(v.day(a))} – ${longDay(v.day(v.L))} · ${count(v.data, a, v.L)} data days`;
    app.querySelector('.panels').innerHTML = PANELS.filter(k => v.panels.includes(k)).map(k => PANEL[k](v, a, v.L)).join('');
    hookCharts();
  };
  bar.addEventListener('click', e => { const b = e.target.closest('button[data-period]'); if(b){ period = b.dataset.period; draw(); } });
  draw();
}
const longDay = d => `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;
const sum = (arr, a, b) => { let s = 0; if(arr) for(let i = a; i <= b; i++) s += arr[i]; return s; };
const count = (mask, a, b) => { let s = 0; for(let i = a; i <= b; i++) if(mask[i] === '1') s++; return s; };
const label = (v, m) => (v.labels[m] && v.labels[m].label) || m;
const unit = (v, m) => (v.labels[m] && v.labels[m].unit) || '';

// ----------------------------------------------------------------- charts

const W = 960, H = 150, ML = 46, MR = 10, MT = 10, MB = 24;
const charts = new Map(); let chartSeq = 0;

function niceMax(x){ if(!(x > 0)) return 1; const e = Math.pow(10, Math.floor(Math.log10(x))); for(const m of [1, 2, 2.5, 5, 10]) if(m * e >= x) return m * e; return 10 * e; }
function fmtTick(x){ return Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(x % 1e6 ? 1 : 0) + 'M' : Math.abs(x) >= 1e4 ? (x / 1e3).toFixed(0) + 'k' : Math.abs(x) < 10 && x % 1 ? x.toFixed(1) : String(Math.round(x)); }

// x axis: month (or week) starts between a and b
function xAxis(v, a, b, x){
  const n = b - a + 1, out = [];
  let last = -1e9;
  for(let i = a; i <= b; i++){
    const d = v.day(i);
    const tick = n > 70 ? d.slice(8) === '01' : new Date(d + 'T00:00:00Z').getUTCDay() === 1;
    if(!tick) continue;
    const px = x(i);
    if(px - last < 46) continue;
    last = px;
    const lab = n > 70 ? (d.slice(5, 7) === '01' || out.length === 0 ? `${MON[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}` : MON[+d.slice(5, 7) - 1]) : `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8)}`;
    out.push(`<line class="grid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${H - MB}" y2="${H - MB + 4}"/><text x="${px.toFixed(1)}" y="${H - 6}" text-anchor="middle">${lab}</text>`);
  }
  return out.join('');
}
function yAxis(lo, hi, y){
  return [lo, (lo + hi) / 2, hi].map(t => `<line class="grid" x1="${ML}" x2="${W - MR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text x="${ML - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtTick(t)}</text>`).join('');
}
// grey background on days without data, so "zero" and "no data" differ
function noData(v, a, b, x, bw){
  const out = [];
  for(let i = a; i <= b; i++){
    if(v.data[i] === '1') continue;
    let j = i; while(j + 1 <= b && v.data[j + 1] !== '1') j++;
    out.push(`<rect x="${x(i).toFixed(1)}" y="${MT}" width="${(x(j) - x(i) + bw).toFixed(1)}" height="${H - MT - MB}" fill="${NODATA}"/>`);
    i = j;
  }
  return out.join('');
}
function frame(id, title, cap, legend, inner){
  return `<div class="chart"><h3>${esc(title)}</h3>${legend || ''}<div class="cw"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" data-chart="${id}">${inner}</svg></div>${cap ? `<p class="cap">${cap}</p>` : ''}</div>`;
}
const legendOf = items => `<div class="lg">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('')}</div>`;

// Daily (stacked) bars. stacks: [{ name, color, arr }]
function bars(v, a, b, title, stacks, cap){
  const n = b - a + 1, bw = (W - ML - MR) / n, gap = bw > 4 ? 1 : 0;
  const x = i => ML + (i - a) * bw;
  let max = 0;
  for(let i = a; i <= b; i++){ let s = 0; for(const st of stacks) s += st.arr[i]; if(s > max) max = s; }
  const top = niceMax(max), y = val => H - MB - (val / top) * (H - MT - MB);
  const rects = [];
  for(let i = a; i <= b; i++){
    let base = 0;
    for(const st of stacks){
      const val = st.arr[i]; if(!val) continue;
      rects.push(`<rect x="${(x(i) + gap / 2).toFixed(2)}" y="${y(base + val).toFixed(2)}" width="${Math.max(0.6, bw - gap).toFixed(2)}" height="${(y(base) - y(base + val)).toFixed(2)}" fill="${st.color}"/>`);
      base += val;
    }
  }
  const id = 'c' + (++chartSeq);
  charts.set(id, { a, b, x0: ML, bw, tip: i => `<b>${longDay(v.day(i))}</b>${v.data[i] === '1' ? '' : ' · no data'}<br>${stacks.map(st => `${esc(st.name)}: ${n0(st.arr[i])}`).join('<br>')}` });
  const legend = stacks.length > 1 ? legendOf(stacks.map(s => [s.color, s.name])) : '';
  return frame(id, title, cap, legend, noData(v, a, b, x, bw) + yAxis(0, top, y) + rects.join('') + xAxis(v, a, b, x));
}

// A value per reading day: points [i, value]; marks: [{ i, text }]
function line(v, a, b, title, pts, marks, cap, fmt){
  const n = b - a + 1, bw = (W - ML - MR) / n, x = i => ML + (i - a + 0.5) * bw;
  const inside = pts.filter(p => p[0] >= a && p[0] <= b);
  let lo = Infinity, hi = -Infinity;
  for(const p of inside){ lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  if(!inside.length){ lo = 0; hi = 1; }
  if(lo === hi){ lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const y = val => H - MB - ((val - lo) / (hi - lo)) * (H - MT - MB);
  const path = inside.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const mk = (marks || []).filter(m => m.i >= a && m.i <= b).map(m => `<line x1="${x(m.i).toFixed(1)}" x2="${x(m.i).toFixed(1)}" y1="${MT}" y2="${H - MB}" stroke="${C2}" stroke-width="2" stroke-dasharray="4 3"/><text x="${(x(m.i) + 4).toFixed(1)}" y="${MT + 10}" style="fill:${C2}">${esc(m.text)}</text>`).join('');
  const id = 'c' + (++chartSeq);
  const byI = new Map(inside.map(p => [p[0], p]));
  charts.set(id, { a, b, x0: ML, bw, tip: i => { const p = byI.get(i); const m = (marks || []).find(q => q.i === i); return `<b>${longDay(v.day(i))}</b><br>${p ? fmt(p) : 'no reading'}${m ? `<br>${esc(m.text)}` : ''}`; } });
  return frame(id, title, cap, '', noData(v, a, b, i => ML + (i - a) * bw, bw) + yAxis(lo + pad, hi - pad, y) + mk + `<path d="${path}" fill="none" stroke="${C1}" stroke-width="2" stroke-linejoin="round"/>` + xAxis(v, a, b, x));
}

// Gauge: per reading day [i, min, max, mean]: the daily range as a bar, the mean as a dot
function gauge(v, a, b, m, rows){
  const n = b - a + 1, bw = (W - ML - MR) / n, x = i => ML + (i - a) * bw;
  const inside = rows.filter(r => r[0] >= a && r[0] <= b);
  let lo = Infinity, hi = -Infinity;
  for(const r of inside){ lo = Math.min(lo, r[1]); hi = Math.max(hi, r[2]); }
  if(!inside.length){ lo = 0; hi = 1; }
  if(lo === hi){ lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const y = val => H - MB - ((val - lo) / (hi - lo)) * (H - MT - MB);
  const w = Math.max(1, bw - (bw > 4 ? 1 : 0));
  const marks = inside.map(r => `<rect x="${x(r[0]).toFixed(2)}" y="${y(r[2]).toFixed(2)}" width="${w.toFixed(2)}" height="${Math.max(1, y(r[1]) - y(r[2])).toFixed(2)}" fill="#9ec5f4"/>` +
    (bw >= 3 ? `<circle cx="${(x(r[0]) + w / 2).toFixed(2)}" cy="${y(r[3]).toFixed(2)}" r="${Math.min(3, bw / 2).toFixed(2)}" fill="${C1}"/>` : `<rect x="${x(r[0]).toFixed(2)}" y="${(y(r[3]) - 1).toFixed(2)}" width="${w.toFixed(2)}" height="2" fill="${C1}"/>`)).join('');
  const id = 'c' + (++chartSeq), u = unit(v, m);
  const byI = new Map(inside.map(r => [r[0], r]));
  charts.set(id, { a, b, x0: ML, bw, tip: i => { const r = byI.get(i); return `<b>${longDay(v.day(i))}</b><br>${r ? `min ${r[1]} · mean ${r[3]} · max ${r[2]}${u ? ' ' + esc(u) : ''}` : 'no reading'}`; } });
  let gmin = Infinity, gmax = -Infinity; for(const r of inside){ gmin = Math.min(gmin, r[1]); gmax = Math.max(gmax, r[2]); }
  const cap = inside.length ? `${inside.length} reading days in the period · lowest ${gmin} · highest ${gmax}${u ? ' ' + esc(u) : ''}` : 'No readings in the period.';
  return frame(id, `${label(v, m)}${u ? ` (${u})` : ''}`, cap, legendOf([['#9ec5f4', 'daily range'], [C1, 'daily mean']]), noData(v, a, b, x, bw) + yAxis(lo + pad, hi - pad, y) + marks + xAxis(v, a, b, x));
}

//@@charts@@
function hookCharts(){
  app.querySelectorAll('svg[data-chart]').forEach(svg => {
    const c = charts.get(svg.dataset.chart); if(!c) return;
    const at = e => {
      if(c.heat){ const r = e.target.closest('rect[data-d]'); return r ? c.tip(+r.dataset.d, +r.dataset.h) : null; }
      if(c.cal){ const r = e.target.closest('rect[data-i]'); return r ? c.tip(+r.dataset.i) : null; }
      const box = svg.getBoundingClientRect(), px = (e.clientX - box.left) * (W / box.width);
      const i = c.a + Math.floor((px - c.x0) / c.bw);
      return i >= c.a && i <= c.b ? c.tip(i) : null;
    };
    svg.addEventListener('pointermove', e => {
      const html = at(e);
      if(!html){ tip.hidden = true; return; }
      tip.innerHTML = html; tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.max(4, Math.min(window.innerWidth - r.width - 4, e.clientX + 12)) + 'px';
      tip.style.top = Math.max(4, e.clientY - r.height - 12) + 'px';
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

// ----------------------------------------------------------------- panels

//@@panel-keys@@
// every part escaped: labels come from the metric catalog (review PHASE6-PAGE F1)
const stat = (k, val, s) => `<div class="stat"><span>${esc(k)}</span><b>${esc(val)}</b>${s ? `<div class="src">${esc(s)}</div>` : ''}</div>`;
const box = (title, sub, stats, body) => `<section class="panel panelbox"><h2>${title}${sub ? ` <small>${sub}</small>` : ''}</h2>${stats.length ? `<div class="stats">${stats.join('')}</div>` : ''}${body}</section>`;
const evBars = (v, a, b, m, cap) => v.ev[m] ? bars(v, a, b, `${label(v, m)}${unit(v, m) ? ` (${unit(v, m)})` : ''} per day`, [{ name: label(v, m), color: C1, arr: v.ev[m] }], cap) : '';
const evTotal = (v, a, b, m) => v.ev[m] ? stat(label(v, m), n0(sum(v.ev[m], a, b)), 'in the period') : '';

//@@panels@@
// ----------------------------------------------------------------- router

function show(){
  const id = decodeURIComponent(location.hash.slice(1));
  const sys = titles.has(id) ? id : '';
  if(sys === current) return;
  if(current === '') dashY = window.scrollY;
  tip.hidden = true; charts.clear();
  app.replaceChildren(document.getElementById(sys ? 'view-' + sys : 'view-dashboard').content.cloneNode(true));
  if(sys){
    mountSystem(sys);
    document.title = titles.get(sys);
    window.scrollTo(0, 0);
  } else {
    mountDashboard();
    document.title = INDEX.title;
    window.scrollTo(0, dashY);
  }
  current = sys;
}
window.addEventListener('hashchange', show);
show();
})();
