/* Client for the GE CT Insights viewer (ct/render.js inlines it). One file,
   many systems: the dashboard and every system view are inert <template>s,
   and the hash picks one (#SME21859; empty or unknown = the dashboard). A
   system's JSON block is parsed only when it is opened, and its panels are
   drawn from it for the chosen period (30 d / 90 d / 6 mo / all). The page
   only draws: every number comes from the builder, summed here over the
   period's days. Offline: no fetch, no server. */
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

// Busy hours: exams by local day of week x local hour, a single-hue ramp
function heatmap(v, key){
  const h = v.heat[key], max = Math.max(1, ...h), cw = 34, ch = 20, l = 40, t = 18;
  const w = l + 24 * cw + 4, hh = t + 7 * ch + 4;
  const cells = [];
  for(let d = 0; d < 7; d++) for(let hr = 0; hr < 24; hr++){
    const n = h[d * 24 + hr];
    const fill = n ? RAMP[Math.min(RAMP.length - 1, Math.floor((n / max) * (RAMP.length - 0.001)))] : '#F4F6F8';
    cells.push(`<rect x="${l + hr * cw + 1}" y="${t + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${fill}" data-d="${d}" data-h="${hr}"/>`);
  }
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map(hr => `<text x="${l + hr * cw + cw / 2}" y="12" text-anchor="middle">${String(hr).padStart(2, '0')}:00</text>`).join('');
  const days = DOW.map((d, k) => `<text x="${l - 6}" y="${t + k * ch + 14}" text-anchor="end">${d}</text>`).join('');
  const total = h.reduce((s, x) => s + x, 0);
  const id = 'c' + (++chartSeq);
  charts.set(id, { heat: true, tip: (d, hr) => `<b>${DOW[d]} ${String(hr).padStart(2, '0')}:00–${String(hr).padStart(2, '0')}:59</b><br>${n0(h[d * 24 + hr])} exams` });
  return `<div class="chart"><h3>Busy hours <small>(device local time)</small></h3>${legendOf([[RAMP[0], 'fewer exams'], [RAMP[RAMP.length - 1], `more (max ${n0(max)} in one cell)`]])}<div class="cw"><svg class="heat" viewBox="0 0 ${w} ${hh}" role="img" aria-label="Exams by day of week and hour" data-chart="${id}">${hours}${days}${cells.join('')}</svg></div><p class="cap">${n0(total)} exams in the period by start time. The hour is the exam start on the device clock.</p></div>`;
}

// Prep calendar: one cell per day, weeks as columns, Monday on top
function prepCalendar(v, a, b){
  const cw = 14, l = 34, t = 16;
  const first = new Date(v.day(a) + 'T00:00:00Z').getUTCDay(), off = (first + 6) % 7;
  const nweeks = Math.ceil((b - a + 1 + off) / 7), w = Math.max(l + nweeks * cw + 4, 200), hh = t + 7 * cw + 4;
  const cells = [], months = [];
  let lastM = '';
  for(let i = a; i <= b; i++){
    const k = i - a + off, col = Math.floor(k / 7), row = k % 7, d = v.day(i);
    const scan = v.prep.scan[i] === '1', fc = v.prep.fast_cal[i] === '1', wu = v.prep.warmup[i] === '1', data = v.data[i] === '1';
    const fill = !data ? '#FFFFFF' : scan ? (fc ? C1 : C2) : fc ? '#9ec5f4' : '#E3E8ED';
    cells.push(`<rect x="${l + col * cw + 1}" y="${t + row * cw + 1}" width="${cw - 2}" height="${cw - 2}" rx="2" fill="${fill}" stroke="${data ? 'none' : '#DCE4EB'}" data-i="${i}"/>${wu ? `<circle cx="${l + col * cw + cw / 2}" cy="${t + row * cw + cw / 2}" r="2" fill="#fff" pointer-events="none"/>` : ''}`);
    if(d.slice(5, 7) !== lastM && row <= 3){ lastM = d.slice(5, 7); months.push(`<text x="${l + col * cw}" y="11">${MON[+lastM - 1]}</text>`); }
  }
  const days = DOW.map((d, k) => k % 2 ? '' : `<text x="${l - 4}" y="${t + k * cw + 11}" text-anchor="end">${d}</text>`).join('');
  const id = 'c' + (++chartSeq);
  charts.set(id, { cal: true, tip: i => `<b>${longDay(v.day(i))}</b><br>${v.data[i] !== '1' ? 'no data' : (v.prep.scan[i] === '1' ? 'scan day' : 'no exams')} · Fast Cal ${v.prep.fast_cal[i] === '1' ? 'done' : 'not done'}${v.prep.warmup[i] === '1' ? ' · tube warm-up' : ''}` });
  return `<div class="chart"><h3>Daily prep calendar</h3>${legendOf([[C1, 'scan day with Fast Cal'], [C2, 'scan day without Fast Cal'], ['#9ec5f4', 'Fast Cal, no exams'], ['#E3E8ED', 'no exams'], ['#FFFFFF', 'no data']])}<div class="scroll" style="border:0"><svg viewBox="0 0 ${w} ${hh}" style="width:100%;max-width:${Math.round(w * 3.2)}px;min-width:${Math.min(w, 340)}px" role="img" aria-label="Daily prep calendar" data-chart="${id}">${months}${days}${cells.join('')}</svg></div><p class="cap">A white dot marks a day with a tube warm-up step (Cold Tube Warmup / WarmupI / WarmupII; to be confirmed with field service).</p></div>`;
}

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

const PANELS = ['tube', 'utilization', 'reliability', 'compliance', 'environment', 'rotor'];
// every part escaped: labels come from the metric catalog (review PHASE6-PAGE F1)
const stat = (k, val, s) => `<div class="stat"><span>${esc(k)}</span><b>${esc(val)}</b>${s ? `<div class="src">${esc(s)}</div>` : ''}</div>`;
const box = (title, sub, stats, body) => `<section class="panel panelbox"><h2>${title}${sub ? ` <small>${sub}</small>` : ''}</h2>${stats.length ? `<div class="stats">${stats.join('')}</div>` : ''}${body}</section>`;
const evBars = (v, a, b, m, cap) => v.ev[m] ? bars(v, a, b, `${label(v, m)}${unit(v, m) ? ` (${unit(v, m)})` : ''} per day`, [{ name: label(v, m), color: C1, arr: v.ev[m] }], cap) : '';
const evTotal = (v, a, b, m) => v.ev[m] ? stat(label(v, m), n0(sum(v.ev[m], a, b)), 'in the period') : '';

const PANEL = {
  tube(v, a, b){
    const used = sum(v.tube.increments, a, b), dd = count(v.data, a, b), t = v.tube_now;
    const marks = v.tube.segments.filter(s => s.start_day).map(s => ({ i: Math.round((Date.parse(s.start_day + 'T00:00:00Z') - Date.parse(v.d0 + 'T00:00:00Z')) / DAY), text: s.confidence === 'initial' ? 'data start' : `tube change (${s.confidence || 'unknown'})` }));
    const segRows = v.tube.segments.map(s => `<tr><td>${esc(s.start_day || '—')}</td><td>${s.current ? 'current' : esc(s.ended || 'ended')}</td><td>${esc(s.install_date || '—')}</td><td>${esc(s.confidence || '—')}</td><td>${esc(s.source || '—')}</td><td class="num">${n0(s.mas)}</td><td class="num">${n0(s.mas_per_day)}</td></tr>`).join('');
    return box('Tube', 'mA·s from the tube counter', [
      stat('Current tube', t ? `${n0(t.mas)}` : '—', t ? (t.since_data_start ? `mA·s since data start ${t.since_data_start}` : `mA·s since install ${t.install_date || '(unknown)'}`) : ''),
      stat('mA·s in the period', n0(used), `${dd} data days`),
      stat('mA·s per data day', dd ? n0(used / dd) : '—', 'in the period')
    ], line(v, 0, v.L, 'Tube counter, all history (mA·s)', v.tube.counter, marks, 'The counter resets when a tube is replaced. Dashed lines mark the start of each tube segment and its confidence.', p => `${n0(p[1])} mA·s`) +
      bars(v, a, b, 'mA·s used per day', [{ name: 'mA·s', color: C1, arr: v.tube.increments }], 'The counter increase from the previous reading day (a drop counts 0). After a gap, the whole gap lands on the day readings resume.') +
      `<div class="chart"><h3>Tube segments</h3><div class="scroll"><table><thead><tr><th>Start</th><th>Status</th><th>Install date</th><th>Confidence</th><th>Source</th><th class="num">mA·s</th><th class="num">mA·s/day</th></tr></thead><tbody>${segRows}</tbody></table></div></div>`);
  },
  utilization(v, a, b){
    const ex = sum(v.ev['exam.start'], a, b), dd = count(v.data, a, b);
    const rows = sum(v.exams.rows, a, b), ser = sum(v.exams.series, a, b), img = sum(v.exams.images, a, b);
    return box('Utilization', '', [
      stat('Exams', n0(ex), `exam starts in ${dd} data days`),
      stat('Exams per data day', dd ? n2(ex / dd) : '—', 'in the period'),
      stat('Series per exam', rows ? n2(ser / rows) : '—', `${n0(ser)} series in ${n0(rows)} exam records`),
      stat('Images per exam', rows ? n2(img / rows) : '—', `${n0(img)} images`)
    ], evBars(v, a, b, 'exam.start', 'Exam starts per device day. Grey: no data that day.') + heatmap(v, period));
  },
  reliability(v, a, b){
    const ex = sum(v.ev['exam.start'], a, b), sa = sum(v.ev['scan.abort.system'], a, b), oa = sum(v.ev['scan.abort.operator'], a, b);
    const out = [];
    const st = [];
    if(v.ev['scan.abort.system'] || v.ev['scan.abort.operator']){
      st.push(stat('System aborts', n0(sa), ex ? `${n2(100 * sa / ex)} per 100 exams` : ''), stat('Operator aborts', n0(oa), ex ? `${n2(100 * oa / ex)} per 100 exams` : ''));
      const s = [];
      if(v.ev['scan.abort.system']) s.push({ name: 'system aborts', color: C1, arr: v.ev['scan.abort.system'] });
      if(v.ev['scan.abort.operator']) s.push({ name: 'operator aborts', color: C2, arr: v.ev['scan.abort.operator'] });
      out.push(bars(v, a, b, 'Scan aborts per day', s, `Per 100 exams over the period: system ${ex ? n2(100 * sa / ex) : '—'}, operator ${ex ? n2(100 * oa / ex) : '—'} (${n0(ex)} exams).`));
    }
    if(v.errors){
      const top = v.errors.top[period];
      st.push(stat('Errors', n0(top.total), `${top.codes.length} codes shown`));
      const rows = top.codes.map(([c, n]) => `<tr><td><code>${esc(c || '(no code)')}</code></td><td class="num">${n0(n)}</td><td class="num">${top.total ? n2(100 * n / top.total) : '—'}%</td></tr>`).join('') +
        (top.other ? `<tr class="dim"><td>other codes</td><td class="num">${n0(top.other)}</td><td class="num">${n2(100 * top.other / top.total)}%</td></tr>` : '');
      out.push(`${bars(v, a, b, 'Errors per day (all ermes codes)', [{ name: 'errors', color: C1, arr: v.errors.total }])}<div class="chart"><h3>Top error codes in the period</h3>${top.total ? `<div class="scroll"><table><thead><tr><th>ermes code</th><th class="num">Errors</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="nodata">No errors in the period.</p>'}</div>`);
    }
    if(v.ev['scan.safe_state']){ st.push(evTotal(v, a, b, 'scan.safe_state')); out.push(evBars(v, a, b, 'scan.safe_state')); }
    if(v.boots){
      const c = sum(v.boots.clean, a, b), u = sum(v.boots.unclean, a, b);
      st.push(stat('Boots', n0(c + u), `${n0(c)} clean · ${n0(u)} unclean`));
      out.push(bars(v, a, b, 'Boots per day', [{ name: 'clean (after a shutdown)', color: C1, arr: v.boots.clean }, { name: 'unclean (no shutdown logged)', color: C2, arr: v.boots.unclean }]));
    }
    const procs = Object.keys(v.restarts);
    if(procs.length){
      const tot = procs.map(p => [p, sum(v.restarts[p], a, b)]).filter(x => x[1]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const all = new Array(v.nd).fill(0); for(const p of procs) for(let i = 0; i < v.nd; i++) all[i] += v.restarts[p][i];
      st.push(stat('Process restarts', n0(sum(all, a, b)), `${tot.length} processes`));
      out.push(`${bars(v, a, b, 'Process restarts per day', [{ name: 'restarts', color: C1, arr: all }])}<div class="chart"><h3>Restarts by process in the period</h3>${tot.length ? `<div class="scroll"><table><thead><tr><th>Process</th><th class="num">Restarts</th></tr></thead><tbody>${tot.slice(0, 12).map(([p, n]) => `<tr><td><code>${esc(p || '(none)')}</code></td><td class="num">${n0(n)}</td></tr>`).join('')}</tbody></table></div>${tot.length > 12 ? `<p class="cap">${tot.length - 12} more processes.</p>` : ''}` : '<p class="nodata">No restarts in the period.</p>'}</div>`);
    }
    return box('Reliability', '', st, out.join(''));
  },
  compliance(v, a, b){
    const st = [], out = [];
    if(v.prep){
      let scan = 0, fc = 0, without = 0, wu = 0;
      for(let i = a; i <= b; i++){ const s = v.prep.scan[i] === '1', f = v.prep.fast_cal[i] === '1'; if(s) scan++; if(f) fc++; if(s && !f) without++; if(v.prep.warmup[i] === '1') wu++; }
      st.push(stat('Scan days', n0(scan), 'days with an exam'), stat('Without Fast Cal', n0(without), scan ? `${n2(100 * without / scan)}% of scan days` : ''), stat('Fast Cal days', n0(fc), ''), stat('Warm-up days', n0(wu), 'tube warm-up step logged'));
      out.push(prepCalendar(v, a, b));
    }
    for(const m of ['op.warmup_skipped', 'op.scan_in_warmup_zone', 'calibration.air_overdue', 'compliance.dose_display_disabled']) if(v.ev[m]){ st.push(evTotal(v, a, b, m)); out.push(evBars(v, a, b, m)); }
    return box('Compliance', '', st, out.join(''));
  },
  environment(v, a, b){
    const st = [], out = [];
    for(const m of ['env.plenum_temp', 'env.detector_temp_low', 'env.humidity_out_of_range']){
      if(v.gauges[m]) out.push(gauge(v, a, b, m, v.gauges[m]));
      if(v.ev[m]) st.push(evTotal(v, a, b, m));
    }
    for(const m of ['env.psu_temp_out_of_spec', 'env.psu_voltage_out_of_spec']) if(v.ev[m]){ st.push(evTotal(v, a, b, m)); out.push(evBars(v, a, b, m, 'Event counts only: the logged PSU values include a placeholder (2147483647), so no readings are charted.')); }
    return box('Environment', '', st, out.join(''));
  },
  rotor(v, a, b){
    const st = [], out = [];
    if(v.gauges['tube.rotor_sgb_slope']) out.push(gauge(v, a, b, 'tube.rotor_sgb_slope', v.gauges['tube.rotor_sgb_slope']));
    for(const m of ['tube.rotor_unexpected_stop', 'tube.rotor_not_at_speed']) if(v.ev[m]){ st.push(evTotal(v, a, b, m)); out.push(evBars(v, a, b, m)); }
    if(v.ev['tube.rotor_sgb_slope']) st.push(stat(`${label(v, 'tube.rotor_sgb_slope')} readings`, n0(sum(v.ev['tube.rotor_sgb_slope'], a, b)), 'in the period'));
    return box('Rotor', '', st, out.join(''));
  }
};

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
