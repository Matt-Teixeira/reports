// GE CT Insights viewer: the CT parts of the client (hhm_rpp_ge
// PLAN-CT-INSIGHTS.md §16; the shared core is sme_reports/insights/
// client_core.js, PLAN-CV-INSIGHTS.md §13.3 Q1). Not a script on its own:
// ct/render.js passes this file to insights/page.js assemble_client(),
// which puts each section below in place of the core's marker of the same
// name. Text before the first marker (this comment) is dropped.
//@@header@@
/* Client for the GE CT Insights viewer (ct/render.js inlines it). One file,
   many systems: the dashboard and every system view are inert <template>s,
   and the hash picks one (#SME21859; empty or unknown = the dashboard). A
   system's JSON block is parsed only when it is opened, and its panels are
   drawn from it for the chosen period (30 d / 90 d / 6 mo / all). The page
   only draws: every number comes from the builder, summed here over the
   period's days. Offline: no fetch, no server. */
//@@charts@@
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

//@@panel-keys@@
const PANELS = ['tube', 'utilization', 'reliability', 'compliance', 'environment', 'rotor'];
//@@panels@@
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

