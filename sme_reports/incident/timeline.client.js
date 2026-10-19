/* Client script for the incident timeline page (timeline.js inlines it).
   Ported from the hand-built SME21284 timeline: same views, filters, table,
   detail pane and controls. What the seed hard-coded (model codes, threshold
   values, the window, the Crothall/Intelas grouping) now comes from the DATA
   payload the server embeds. Plain browser JS, no build step. */
(function(){
const DATA = JSON.parse(document.getElementById('timeline-data').textContent);

/* ---------- models ---------- */
const MODELS = Object.fromEntries(DATA.models.map(m => [m.code, m]));
const ORDER = DATA.models.map(m => m.code);
const byOrder = (a,b) => ORDER.indexOf(a) - ORDER.indexOf(b);
const CUST = DATA.customer_org;            // e.g. "Crothall / Intelas"
// Vendor-specific chart labels. Defaults are the GE pair the timeline
// was built on; the activity page (incident/activity.js) sends its own.
const LBL = Object.assign({primary:'He pressure', p_units:'PSI', p_dec:3, level:'He level', l_units:'%', l_dec:2}, DATA.labels || {});
const RECIPS = DATA.recipients_label || `${CUST} users`;

/* ---------- formatting ---------- */
let TZ = DATA.tz_default;
const fcache = {};
function fmt(d, opts, tz = TZ){
  const k = tz + JSON.stringify(opts);
  if(!fcache[k]) fcache[k] = new Intl.DateTimeFormat('en-US', {timeZone:tz, ...opts});
  return fcache[k].format(d);
}
let H24 = true;
const timeSec = d => fmt(d, H24 ? {hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'} : {hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true});
const timeMin = d => fmt(d, H24 ? {hour:'2-digit',minute:'2-digit',hourCycle:'h23'} : {hour:'numeric',minute:'2-digit',hour12:true});
const dayLabel = d => fmt(d,{weekday:'short',month:'short',day:'numeric'});
const shortDay = d => fmt(d,{month:'short',day:'numeric'});
const tzAbbr = () => (DATA.zones.find(z => z.tz === TZ) || {abbr:'UTC'}).abbr;
function isoOut(d){
  const s = d.toISOString().replace('T',' ').replace('Z','');
  return (s.endsWith('.000') ? s.slice(0,-4) : s) + '+00';
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- detections ---------- */
// Each detection keeps its raw alert.detections columns for the detail
// table, plus what the chips need: a number and unit, or a text value.
function mk(r, slot){
  const m = MODELS[r.code];
  const d = {code:r.code, ins:new Date(r.ins), cap:new Date(r.cap), slot, num:null,
    field:r.field, rfc:r.rfc ?? '', rfu:r.rfu ?? '', op:r.op, th:r.th ?? '', rtc:r.rtc ?? '', thu:r.thu ?? ''};
  const unit = r.rfu === '%' ? '%' : r.rfu ? ' ' + r.rfu : '';
  if(m.operator === 'delta_neg'){ d.num = +r.rtc; d.base = +r.rfc; d.unit = unit; }
  else if(m.operator === 'greater_than' || m.operator === 'less_than'){ d.num = +r.rfc; d.unit = unit; }
  else if(m.operator === 'absent_null_data') d.text = 'no data';
  else if(m.operator === 'offline') d.text = null;
  else d.text = r.rfc;
  return d;
}
const runs = DATA.runs.map(r => {
  const slot = new Date(r.slot);
  const dets = r.dets.map(x => mk(x, slot)).sort((a,b) => byOrder(a.code, b.code));
  return {ins:new Date(r.at), slot, dets, id:r.at};
});
const byCode = Object.fromEntries(ORDER.map(c => [c, []]));
runs.forEach(r => r.dets.forEach(d => byCode[d.code].push(d)));
const TOTAL = runs.reduce((n,r) => n + r.dets.length, 0);

/* ---------- notifications ---------- */
const USERS = DATA.users;                 // key -> address as stored
const ORGS = DATA.orgs;                   // key -> 'Avante' | CUST | 'Other'
const notes = DATA.notes.map(n => ({start:new Date(n.start), end:new Date(n.end), id:'n' + n.start,
  list:n.rows.map(r => ({u:r.u, email:r.email || '', sms:r.sms || '', codes:r.codes.slice().sort(byOrder)}))}));
const reached = r => r.email === 'SENT' || r.sms === 'SENT';
const errored = r => !reached(r) && (r.email === 'ERROR' || r.sms === 'ERROR');
const NOTE_ROWS = notes.reduce((n,b) => n + b.list.length, 0);
const userStats = {};
Object.keys(USERS).forEach(u => userStats[u] = {total:0, reached:0, email:0, sms:0});
notes.forEach(b => b.list.forEach(r => {
  const s = userStats[r.u]; s.total++;
  if(reached(r)) s.reached++;
  if(r.email === 'SENT') s.email++;
  if(r.sms === 'SENT') s.sms++;
}));
const org = u => ORGS[u] || 'Other';
const ORG_ORDER = DATA.org_order || ['Avante', CUST, 'Other'];

/* ---------- the capture-slot spine ---------- */
const slots = [], slotAt = new Map();
for(const x of DATA.slots){
  const s = {t:new Date(x.t), id:x.t, mag:x.mag, comp:x.comp, run:null, notes:[]};
  slots.push(s); slotAt.set(x.t, s);
}
const MAGN = slots.filter(s => s.mag).length, EDUN = slots.filter(s => s.comp != null).length;
runs.forEach(r => { const s = slotAt.get(r.slot.getTime()); if(s){ s.run = r; r.slotRef = s; } });
const LAST_RUN_SLOT = runs.length ? runs[runs.length-1].slot.getTime() : 0;
// A notification belongs to the slot its run evaluated: the latest run at or
// before the send.
notes.forEach(b => {
  let run = null; for(const r of runs){ if(r.ins <= b.start) run = r; else break; }
  b.slot = (run && slotAt.get(run.slot.getTime())) || slots[slots.length-1];
  b.run = b.slot.run; b.slot.notes.push(b);
});
// Alerts the data says should have triggered: each model's rule applied to
// the merged readings.
const rule = c => { const m = MODELS[c];
  if(m.kind === 'compressor') return s => s.comp === false;
  if(m.value == null || !s0Field(m)) return null;
  const f = s0Field(m);
  return m.op === '>' ? s => s.mag && s.mag[f] > m.value : m.op === '<' ? s => s.mag && s.mag[f] < m.value : null; };
function s0Field(m){ return m.kind === 'pressure' ? 'pr' : m.kind === 'level' ? 'lvl' : null; }
const RULES = ORDER.map(c => [c, rule(c)]).filter(x => x[1]);
function expected(s){
  if(s.t.getTime() > LAST_RUN_SLOT) return [];
  return RULES.filter(([, f]) => f(s)).map(([c]) => c);
}

/* ---------- state ---------- */
const active = new Set(ORDER);
const selR = new Set(Object.keys(USERS));
const merge = false, showMissed = DATA.show_missed, showNotes = true;
const openGroups = new Set();
const visRows = b => b.list.filter(r => selR.has(r.u) && r.codes.some(c => active.has(c)));

/* ---------- summary ---------- */
function renderSummary(){
  const a = slots[0].t, b = slots[slots.length-1].t;
  const allRows = notes.flatMap(n => n.list);
  const ok = allRows.filter(reached).length, err = allRows.filter(errored).length;
  const missedSlots = slots.filter(s => expected(s).some(c => !(s.run && s.run.dets.some(d => d.code === c)))).length;
  const off = NOTE_ROWS - ok - err;
  const tile = (k, v, sub, cls) => `<div class="tile${cls ? ' ' + cls : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  document.getElementById('stat-tiles').innerHTML = [
    tile('Period', `${esc(shortDay(a))} – ${esc(shortDay(b))}`, `${esc(dayLabel(a))} ${timeMin(a)} to ${esc(dayLabel(b))} ${timeMin(b)} ${tzAbbr()} · ${slots.length} half-hour slots`),
    tile('Readings', `${MAGN} · ${EDUN}`, `magnet · compressor, of ${slots.length} slots`),
    tile('Detections', TOTAL, `across ${ORDER.length} alert models in ${runs.length} runs` + (showMissed ? ` · <b>${missedSlots} slots</b> expected, not detected` : '')),
    tile('Notifications', NOTE_ROWS, `in ${notes.length} batches to ${esc(RECIPS)}`),
    tile('Reached', ok, `${off} with both channels off · ${err} error${err === 1 ? '' : 's'}`, 'good')
  ].join('');
  const ev = document.getElementById('evidence');
  if(ev) ev.innerHTML = DATA.evidence.map(e => `<li>${esc(e.text).replace(/\{(\d)\}/g, (_, i) => { const d = new Date(e.times[+i]); return `${esc(dayLabel(d))} ${timeMin(d)} ${tzAbbr()}`; })}</li>`).join('');
  document.getElementById('th-time').textContent = `Captured (${tzAbbr()})`;
}

/* ---------- chart and lanes ---------- */
const T0 = DATA.window.from, T1 = DATA.window.to;
const PTHR = DATA.models.filter(m => m.kind === 'pressure' && m.op === '>');
const LTHR = DATA.models.filter(m => m.kind === 'level' && m.op === '<');
const P_LO = DATA.scales.p_lo || 0, P_TOP = DATA.scales.p_top, L_LO = DATA.scales.l_lo, L_HI = DATA.scales.l_hi;
function renderLanes(){
  const W = 1100, L = 190, PW = W - L - 10, top = 30, LH = 24;
  const SH = 30, GAP = 26;
  const dataH = top, pY = dataH + SH, pH = 92, lY = pY + pH + 16, lH = 80, cY = lY + lH + 16, cH = 14;
  const detH = cY + cH + GAP, dY = detH + SH;
  const notH = dY + ORDER.length*LH + GAP, nY = notH + SH, H = nY + LH + 8;
  const x = t => L + (t - T0) / (T1 - T0) * PW;
  const py = v => pY + pH - (v - P_LO) / (P_TOP - P_LO) * pH, ly = v => lY + lH - (v - L_LO) / (L_HI - L_LO) * lH;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="He pressure, He level, compressor status, detections and notifications over the window">`;
  if(DATA.shade) s += `<rect class="band" x="${x(DATA.shade.start)}" y="${top-6}" width="${x(DATA.shade.end)-x(DATA.shade.start)}" height="${H-top+6}"/>`;
  const mids = [];
  for(let t = T0; t <= T1; t += 3600e3){ if(fmt(new Date(t),{hour:'2-digit',hourCycle:'h23'}) === '00') mids.push(t); }
  // One labelled gridline per k days, k chosen so labels stay >= 70px apart
  // (a 6-month window would otherwise print 180 overlapping dates).
  const every = Math.max(1, Math.ceil(70 / (86400e3 / (T1 - T0) * PW)));
  mids.forEach((m, i) => { if(i % every) return;
    s += `<line class="grid" x1="${x(m)}" x2="${x(m)}" y1="${top-6}" y2="${H}"/>`;
    // A label that would run past the plot's right edge is dropped (its
    // gridline stays) rather than clipped mid-word.
    if(x(m) <= L + PW - 64) s += `<text class="tick" x="${x(m)+4}" y="${top-12}">${esc(dayLabel(new Date(m)))}</text>`;
  });
  const sect = (y, label, sub, first) => {
    let h = first ? '' : `<line class="secrule" x1="0" x2="${W}" y1="${y-12}" y2="${y-12}"/>`;
    return h + `<rect class="sechead" x="0" y="${y}" width="${W}" height="${SH-8}"/><text class="sect" x="12" y="${y+16}">${label.toUpperCase()}</text><text class="secsub" x="${12 + label.length*10.4 + 12}" y="${y+16}">${sub}</text>`;
  };
  s += sect(dataH, 'Data', DATA.data_sub || `Readings from ${DATA.sources.mag} and ${DATA.sources.edu}, one point per capture slot`, true);
  s += sect(detH, 'Detections', 'alert.detections, placed at the capture slot each run evaluated');
  s += sect(notH, 'Notifications', 'alert.notifications batches; solid when at least one shown recipient was reached, outlined when none were');
  s += `<rect class="pframe" x="${L}" y="${pY}" width="${PW}" height="${pH}"/><rect class="pframe" x="${L}" y="${lY}" width="${PW}" height="${lH}"/>`;
  s += `<text x="${L-12}" y="${pY+pH/2}" text-anchor="end" class="plabel">${esc(LBL.primary)}</text><text x="${L-12}" y="${pY+pH/2+14}" text-anchor="end" class="tick">${esc(LBL.p_units)}</text>`;
  s += `<text x="${L-12}" y="${lY+lH/2}" text-anchor="end" class="plabel">${esc(LBL.level)}</text><text x="${L-12}" y="${lY+lH/2+14}" text-anchor="end" class="tick">${esc(LBL.l_units)}</text>`;
  // Axis extents, outside each panel's left edge: max at the top, min at the bottom.
  const ext = (y0, h, lo, hi) => `<text class="tick axv" x="${L-5}" y="${y0+9}" text-anchor="end">${hi}</text><text class="tick axv" x="${L-5}" y="${y0+h-1}" text-anchor="end">${lo}</text>`;
  s += ext(pY, pH, P_LO, P_TOP) + ext(lY, lH, L_LO, L_HI);
  PTHR.forEach(m => { if(m.value < P_LO || m.value > P_TOP) return; s += `<line class="thr ${m.sev === 'high' ? 'high' : 'med'}" x1="${L}" x2="${L+PW}" y1="${py(m.value)}" y2="${py(m.value)}"/><text class="tick" x="${L+4}" y="${py(m.value)-3}">${m.value}</text>`; });
  LTHR.forEach(m => { if(m.value < L_LO || m.value > L_HI) return;
    s += `<line class="thr ${m.sev === 'high' ? 'high' : 'med'}" x1="${L}" x2="${L+PW}" y1="${ly(m.value)}" y2="${ly(m.value)}"/><text class="tick" x="${L+4}" y="${ly(m.value)-3}">${m.value}</text>`; });
  const path = (fn, yf) => { let d = '', pen = false;
    for(const sl of slots){ const v = sl.mag ? fn(sl.mag) : null;
      if(v == null){ pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(sl.id).toFixed(1)},${yf(v).toFixed(1)}`; pen = true; }
    return d; };
  s += `<path class="pline" d="${path(m => m.pr, py)}"/><path class="lline" d="${path(m => m.lvl, ly)}"/>`;
  s += `<text x="${L-12}" y="${cY+cH-3}" text-anchor="end" class="plabel">Compressor</text>`;
  // Consecutive slots in the same state draw as ONE rect (a 6-month window
  // is ~8,760 slots); a gap in readings ends the run.
  const sw = 1800e3 / (T1 - T0) * PW;
  for(let i = 0; i < slots.length; ){ const a = slots[i]; if(a.comp == null){ i++; continue; }
    let j = i; while(j + 1 < slots.length && slots[j+1].comp === a.comp) j++;
    const b = slots[j], x0 = x(a.id) - sw/2, w = x(b.id) - x(a.id) + sw;
    const when = i === j ? `${esc(dayLabel(a.t))} ${timeMin(a.t)}` : `${esc(dayLabel(a.t))} ${timeMin(a.t)} to ${esc(dayLabel(b.t))} ${timeMin(b.t)}`;
    s += `<rect class="${a.comp ? 'con' : 'coff'}" x="${x0.toFixed(1)}" y="${cY}" width="${(w+0.3).toFixed(1)}" height="${cH}"><title>${when} ${tzAbbr()}: ${a.comp ? 'running' : 'off'}</title></rect>`;
    i = j + 1; }
  ORDER.forEach((c,i) => {
    const m = MODELS[c], y = dY + i*LH, cy = y + LH/2;
    s += `<g class="${active.has(c) ? '' : 'off'}"><line class="laneline" x1="${L}" x2="${L+PW}" y1="${cy}" y2="${cy}"/>`;
    s += `<text x="${L-12}" y="${cy+4}" text-anchor="end">${esc(m.name)}</text>`;
    // One mark per pixel column: on long windows many runs share a pixel,
    // and drawing each would add thousands of identical rects.
    const cols = new Map();
    for(const d of byCode[c]){ const k = Math.round(x(d.slot.getTime()));
      const e = cols.get(k); if(e) e.n++; else cols.set(k, {d, n:1}); }
    for(const {d, n} of cols.values()){
      s += `<rect class="mk ${m.sev}" x="${(x(d.slot.getTime())-1.1).toFixed(1)}" y="${y+5}" width="2.2" height="${LH-10}" rx="1"><title>${esc(m.name)}, ${esc(dayLabel(d.ins))} ${timeMin(d.ins)} ${tzAbbr()}${n > 1 ? ` (+${n-1} more nearby)` : ''}</title></rect>`;
    }
    s += `</g>`;
  });
  s += `<line class="laneline" x1="${L}" x2="${L+PW}" y1="${nY+LH/2}" y2="${nY+LH/2}"/><text x="${L-12}" y="${nY+LH/2+4}" text-anchor="end">Batches sent</text>`;
  for(const b of notes){ const rows = visRows(b); if(!rows.length) continue;
    const ok = rows.filter(reached).length;
    s += `<rect class="nk ${ok ? 'ok' : 'no'}" x="${(x(b.start)-2.5).toFixed(1)}" y="${nY+4}" width="5" height="${LH-8}" rx="1.5"><title>${esc(dayLabel(b.start))} ${timeMin(b.start)} ${tzAbbr()}: ${ok} of ${rows.length} recipients reached</title></rect>`; }
  document.getElementById('lanes').innerHTML = s + '</svg>';
}

/* ---------- model filters ---------- */
function renderFilters(){
  document.getElementById('filters').innerHTML = ORDER.map(c => {
    const m = MODELS[c];
    return `<button type="button" data-code="${c}" aria-pressed="${active.has(c)}">
      <span class="sw ${m.sev}"></span>
      <span>${esc(m.name)} <small>${byCode[c].length} detections, ${m.sev}, notify every ${m.freq} h</small></span>
    </button>`;
  }).join('');
  const hidden = ORDER.filter(c => !active.has(c));
  const presetLabel = {all:'All models', none:'No models', high:'High severity only', medium:'Medium severity only'}[mPreset];
  let txt;
  if(!hidden.length) txt = `All ${ORDER.length} shown`;
  else if(hidden.length === ORDER.length) txt = 'None shown';
  else if(presetLabel && mPreset !== 'all' && mPreset !== 'none') txt = `${presetLabel}, ${active.size} of ${ORDER.length} shown`;
  else txt = `${active.size} of ${ORDER.length} shown: ${ORDER.filter(c => active.has(c)).map(c => MODELS[c].name).join(', ')}`;
  document.getElementById('mcount').textContent = txt;
}
let mPreset = 'all', rPreset = 'all';
function recipSummary(){
  const n = selR.size, N = Object.keys(USERS).length;
  const label = {all:'', none:'', customers:DATA.customer_quick, reached:'Reached at least once', never:'Never reached', custom:'Custom selection'}[rPreset];
  if(n === N) return `All ${N} shown`;
  if(n === 0) return 'None shown';
  return `${label ? label + ', ' : ''}${n} of ${N} shown`;
}

/* ---------- recipient filters ---------- */
function renderRecips(){
  const orgs = ORG_ORDER;
  const keys = Object.keys(USERS).sort((a,b) => USERS[a].toLowerCase().localeCompare(USERS[b].toLowerCase()));
  let h = '';
  for(const o of orgs){
    const us = keys.filter(u => org(u) === o); if(!us.length) continue;
    h += `<div class="rorg">${esc(o)}</div>`;
    for(const u of us){
      const st = userStats[u], never = st.reached === 0;
      const via = never ? 'never reached' : [st.email ? `${st.email} by email` : '', st.sms ? `${st.sms} by SMS` : ''].filter(Boolean).join(', ');
      h += `<label class="rc${never ? ' never' : ''}"><input type="checkbox" data-u="${esc(u)}" ${selR.has(u) ? 'checked' : ''}>
        <span>${esc(USERS[u])}<small>${st.total} notifications, ${via}</small></span></label>`;
    }
  }
  document.getElementById('rgrid').innerHTML = h;
  document.getElementById('rcount').textContent = recipSummary();
}

/* ---------- table ---------- */
function chipValue(code, dets){
  const m = dets[0], model = MODELS[code];
  if(model.operator === 'offline') return 'last seen ' + esc(dayLabel(m.cap)) + ' ' + timeMin(m.cap);
  if(m.text != null) return esc(m.text);
  const nums = dets.map(d => d.num), lo = Math.min(...nums), hi = Math.max(...nums);
  const range = lo === hi ? `${lo}${m.unit}` : `${hi}–${lo}${m.unit}`;
  if(model.operator === 'delta_neg'){ const bases = [...new Set(dets.map(d => d.base))];
    return `${bases.length === 1 ? bases[0] : Math.max(...bases)+'…'}% → ${range}`; }
  return range;
}
const nodata = '<span class="nodata">No data</span>';
const LVL_LINE = LTHR.length ? Math.max(...LTHR.map(m => m.value)) : -Infinity;
const P_CRIT = PTHR.filter(m => m.sev === 'high').map(m => m.value), P_WARN = PTHR.map(m => m.value);
const P_CRIT_AT = P_CRIT.length ? Math.min(...P_CRIT) : Infinity, P_WARN_AT = P_WARN.length ? Math.min(...P_WARN) : Infinity;
const L_SFX = LBL.l_units === '%' ? '%' : '';
const lvlCell = v => v == null ? nodata : `<span class="${v < LVL_LINE ? 'warn' : ''}">${v.toFixed(LBL.l_dec)}${L_SFX}</span>`;
const prCell = v => v == null ? nodata : `<span class="${v > P_CRIT_AT ? 'crit' : v > P_WARN_AT ? 'warn' : ''}">${v.toFixed(LBL.p_dec)}</span>`;
const compCell = v => v == null ? nodata : v ? 'Running' : '<span class="crit">Off</span>';
function rangeCell(vals, f){
  if(!vals.length) return nodata;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return lo === hi ? f(lo) : `${f(lo)}<span class="to"> to </span>${f(hi)}`;
}
const isAbsent = c => MODELS[c].operator === 'absent_null_data';
function slotView(s){
  const dets = s.run ? s.run.dets.filter(d => active.has(d.code)) : [];
  const have = new Set(dets.map(d => d.code));
  const missed = showMissed ? expected(s).filter(c => active.has(c) && !have.has(c)) : [];
  const aFlag = [...have].some(isAbsent) && !!s.mag;
  const nv = showNotes ? s.notes.map(b => ({b, rows:visRows(b)})).filter(x => x.rows.length) : [];
  const key = [...have].join('') + '|' + missed.join('') + '|' + s.comp + '|' + (s.mag ? 1 : 0) + '|' + (aFlag ? 1 : 0);
  return {s, dets, have, missed, aFlag, nv, key};
}
const stCell = v => v ? `<span class="st-${v}">${v === 'SENT' ? 'Sent' : v === 'DISABLED' ? 'Disabled' : 'Error'}</span>` : `<span class="st-none">Not set</span>`;
const isHigh = c => MODELS[c].sev === 'high';
let selected = null;            // {kind:'s'|'g', id}
let viewById = new Map(), groupById = new Map();
const names = cs => cs.map(c => MODELS[c].name).join(', ');
function markers(views, ref){
  const codes = new Set(), missed = new Set(); let nb = 0, ok = 0;
  views.forEach(v => { v.have.forEach(c => codes.add(c)); v.missed.forEach(c => missed.add(c));
    v.nv.forEach(({rows}) => { nb++; ok += rows.filter(reached).length; }); });
  const hi = [...codes].filter(isHigh).sort(byOrder), md = [...codes].filter(c => !isHigh(c)).sort(byOrder);
  let h = '';
  if(hi.length) h += `<button type="button" class="mkr red" ${ref} data-sec="det" title="High-severity detections: ${esc(names(hi))}" aria-label="${hi.length} high-severity detections">${hi.length}</button>`;
  if(md.length) h += `<button type="button" class="mkr yellow" ${ref} data-sec="det" title="Medium-severity detections: ${esc(names(md))}" aria-label="${md.length} medium-severity detections">${md.length}</button>`;
  if(missed.size) h += `<button type="button" class="mkr miss" ${ref} data-sec="miss" title="Expected, not detected: ${esc(names([...missed].sort(byOrder)))}" aria-label="${missed.size} expected alerts not detected">${missed.size}</button>`;
  if(nb) h += `<button type="button" class="mkr ${ok ? 'green' : 'grey'}" ${ref} data-sec="note" title="Notification sent: ${ok} recipients reached" aria-label="Notification, ${ok} recipients reached">${ok}</button>`;
  return h;
}
function actualChips(views){
  const v0 = views[0];
  if(!v0.have.size) return '';
  return '<div class="chips">' + [...v0.have].sort(byOrder).map(c => {
    const ds = views.map(v => v.dets.find(d => d.code === c));
    return `<span class="chip ${MODELS[c].sev}"><b>${esc(MODELS[c].name)}</b>${chipValue(c, ds)}</span>`;
  }).join('') + '</div>';
}
function missReason(c, s){
  const m = MODELS[c];
  if(m.kind === 'compressor') return `${esc(m.field)} = false`;
  const txt = m.kind === 'pressure' ? s.mag.prTxt : s.mag.lvlTxt;
  return `${esc(m.field)} ${esc(txt)} ${m.op === '>' ? '&gt;' : '&lt;'} ${m.value}`;
}
function slotRow(v){
  const s = v.s, sel = selected && selected.kind === 's' && selected.id === s.id, ref = `data-s="${s.id}"`;
  return `<tr class="run${sel ? ' sel' : ''}" ${ref} tabindex="0" aria-selected="${!!sel}">
    <td class="t">${timeMin(s.t)}</td>
    <td class="num">${s.mag ? lvlCell(s.mag.lvl) : nodata}</td>
    <td class="num">${s.mag ? prCell(s.mag.pr) : nodata}</td>
    <td>${compCell(s.comp)}</td>
    <td class="mk">${markers([v], ref)}</td></tr>`;
}
function groupRow(g, open){
  const a = g.views[0].s, b = g.views[g.views.length-1].s, ref = `data-g="${a.id}"`;
  const sel = selected && selected.kind === 'g' && selected.id === a.id;
  const end = (dayLabel(a.t) === dayLabel(b.t) ? '' : esc(shortDay(b.t)) + ' ') + timeMin(b.t);
  const mags = g.views.map(v => v.s.mag).filter(Boolean);
  return `<tr class="${open ? 'ghead' : 'group'}${sel ? ' sel' : ''}" ${ref} tabindex="0" aria-expanded="${open}" aria-selected="${!!sel}">
    <td class="t"><span class="exp">›</span> ${timeMin(a.t)} to ${end}<span class="count">${g.views.length}</span></td>
    <td class="num">${rangeCell(mags.map(m => m.lvl), lvlCell)}</td>
    <td class="num">${rangeCell(mags.map(m => m.pr), prCell)}</td>
    <td>${compCell(a.comp)}</td>
    <td class="mk">${markers(g.views, ref)}</td></tr>`;
}
const expandedDays = new Set();   // days start collapsed
function renderTable(){
  const views = slots.map(slotView);
  viewById = new Map(views.map(v => [v.s.id, v]));
  const items = [];
  for(const v of views){
    const last = items[items.length-1];
    const sameDay = last && dayLabel(last.views[0].s.t) === dayLabel(v.s.t);
    if(merge && !v.nv.length && last && sameDay && !last.hasNotes && last.key === v.key) last.views.push(v);
    else items.push({key:v.key, views:[v], hasNotes:v.nv.length > 0});
  }
  groupById = new Map(items.filter(it => it.views.length > 1).map(it => [it.views[0].s.id, it]));
  const days = [];
  for(const it of items){
    const l = dayLabel(it.views[0].s.t);
    if(!days.length || days[days.length-1].label !== l) days.push({label:l, items:[]});
    days[days.length-1].items.push(it);
  }
  let html = '';
  for(const d of days){
    const collapsed = !expandedDays.has(d.label);
    const dv = d.items.flatMap(it => it.views);
    const sum = markers(dv, '').replace(/<button type="button"/g, '<span').replace(/<\/button>/g, '</span>');
    html += `<tr class="day" data-day="${esc(d.label)}" tabindex="0" aria-expanded="${!collapsed}"><th colspan="5" scope="rowgroup">
      <span class="exp">›</span> ${esc(d.label)}<span class="dsum">${dv.length} slots</span><span class="dmk">${sum}</span></th></tr>`;
    if(collapsed) continue;
    for(const it of d.items){
      const v0 = it.views[0];
      if(it.views.length === 1){ html += slotRow(v0); continue; }
      const open = openGroups.has(v0.s.id);
      html += groupRow(it, open);
      if(open) it.views.forEach(v => { html += slotRow(v); });
    }
  }
  document.getElementById('rows').innerHTML = html;
}
function stat(label, val){ return `<div class="stat"><span>${label}</span><b>${val}</b></div>`; }
function renderDetail(){
  const el = document.getElementById('detail');
  if(selected && selected.kind === 'g' && !groupById.has(selected.id)) selected = viewById.has(selected.id) ? {kind:'s', id:selected.id} : null;
  if(!selected){
    el.innerHTML = `<div class="empty"><h3>Slot details</h3><p>Select a row or one of its markers to see that capture slot's readings, detections, ${showMissed ? 'missed alerts ' : ''}and notifications here.</p>
      <ul class="legend"><li><span class="mkr red">2</span> High-severity detections</li><li><span class="mkr yellow">1</span> Medium-severity detections</li>
      ${showMissed ? '<li><span class="mkr miss">1</span> Expected but not detected</li>' : ''}<li><span class="mkr green">12</span> Notification, recipients reached</li><li><span class="mkr grey">0</span> Notification that reached no one</li></ul>
      ${DATA.jump ? `<button type="button" class="jump" data-jump="${DATA.jump}">Start where the compressor stopped</button>` : ''}</div>`;
    return;
  }
  if(selected.kind === 'g'){
    const g = groupById.get(selected.id), a = g.views[0].s, b = g.views[g.views.length-1].s;
    const mags = g.views.map(v => v.s.mag).filter(Boolean);
    const missed = g.views[0].missed;
    el.innerHTML = `<div class="dhead"><p class="kicker">${g.views.length} identical slots</p><h3>${esc(dayLabel(a.t))} ${timeMin(a.t)} to ${esc(shortDay(b.t))} ${timeMin(b.t)} ${tzAbbr()}</h3></div>
      <section id="d-data"><h4>Readings</h4><div class="stats">${stat(esc(LBL.level), rangeCell(mags.map(m => m.lvl).filter(v => v != null), lvlCell))}${stat(esc(LBL.primary), rangeCell(mags.map(m => m.pr).filter(v => v != null), prCell))}${stat('Compressor', compCell(a.comp))}</div></section>
      <section id="d-det"><h4>Detections</h4>${actualChips(g.views) || '<p class="nodata">None in these slots</p>'}${g.views[0].aFlag ? '<p class="flag">Absent/Null triggered on every slot here, though magnet data exists for them</p>' : ''}</section>
      ${missed.length ? `<section id="d-miss"><h4>Expected, not detected</h4><div class="chips">${missed.map(c => `<span class="chip miss"><b>${esc(MODELS[c].name)}</b>every slot</span>`).join('')}</div></section>` : ''}
      <p><button type="button" class="jump" data-expand="${a.id}">${openGroups.has(a.id) ? 'Collapse' : 'List'} these ${g.views.length} slots in the table</button></p>`;
    return;
  }
  const v = viewById.get(selected.id), s = v.s;
  let h = `<div class="dhead"><p class="kicker">Capture slot</p><h3>${esc(dayLabel(s.t))} ${timeMin(s.t)} ${tzAbbr()}</h3><p class="sub">capture_datetime ${isoOut(s.t)}</p></div>`;
  const pTxt = s.mag && s.mag.pr != null ? prCell(s.mag.pr) + (LBL.p_units ? ' ' + esc(LBL.p_units) : '') : nodata;
  h += `<section id="d-data"><h4>Readings</h4><div class="stats">${stat(esc(LBL.level), s.mag ? lvlCell(s.mag.lvl) : nodata)}${stat(esc(LBL.primary), pTxt)}${stat('Compressor', compCell(s.comp))}</div>
    <p class="src">${DATA.sources.mag ? (s.mag ? `${DATA.sources.mag} row found` : `No row in ${DATA.sources.mag}`) + '. ' : 'No readings for this period. '}${DATA.sources.edu ? (s.comp == null ? `No row in ${DATA.sources.edu}` : `${DATA.sources.edu} row found`) + '.' : ''}</p></section>`;
  h += `<section id="d-det"><h4>Detections</h4>`;
  if(!s.run) h += `<p class="nodata">No detection run evaluated this slot.</p>`;
  else {
    h += `<p class="src">Run at ${timeSec(s.run.ins)} ${tzAbbr()}</p>` + (actualChips([v]) || '<p class="nodata">The run produced no detections for the models shown.</p>');
    if(v.aFlag) h += `<p class="flag">Absent/Null triggered, but magnet data exists for this slot.</p>`;
    if(v.dets.length){
      const head = ['alert_model_id','field_name','resolved_field_content','resolved_field_units','operator','threshold','resolved_threshold_content','threshold_units','inserted_at','capture_datetime'];
      h += `<div class="scroll"><table><thead><tr>${head.map(x => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>` +
        v.dets.map(d => `<tr><td>${MODELS[d.code].id}</td><td>${esc(d.field)}</td><td>${esc(d.rfc)}</td><td>${esc(d.rfu)}</td><td>${esc(d.op)}</td><td>${esc(d.th)}</td><td>${esc(d.rtc)}</td><td>${esc(d.thu)}</td><td>${isoOut(d.ins)}</td><td>${isoOut(d.cap)}</td></tr>`).join('') + `</tbody></table></div>`;
    }
  }
  h += `</section>`;
  if(v.missed.length) h += `<section id="d-miss"><h4>Expected, not detected</h4><ul class="misslist">${v.missed.map(c => `<li><span class="chip miss"><b>${esc(MODELS[c].name)}</b></span> <code>${missReason(c, s)}</code></li>`).join('')}</ul></section>`;
  if(v.nv.length){
    h += `<section id="d-note"><h4>Notifications</h4>`;
    for(const {b, rows} of v.nv){
      const ok = rows.filter(reached).length, err = rows.filter(errored).length, off = rows.length - ok - err;
      const rank = r => reached(r) ? 0 : errored(r) ? 1 : 2;
      const sorted = [...rows].sort((x,y) => rank(x) - rank(y) || USERS[x.u].toLowerCase().localeCompare(USERS[y.u].toLowerCase()));
      const span = b.end - b.start > 60e3 ? ` to ${timeSec(b.end)}` : '';
      const codes = [...new Set(rows.flatMap(r => r.codes))].sort(byOrder);
      h += `<p class="src">Sent ${timeSec(b.start)}${span} ${tzAbbr()}</p><div class="chips">${codes.map(c => `<span class="chip ${MODELS[c].sev}"><b>${esc(MODELS[c].name)}</b></span>`).join('')}</div>
        <p class="nbs"><span class="nb ok">${ok} reached</span><span class="nb off">${off} both channels off</span>${err ? `<span class="nb err">${err} error</span>` : ''}</p>
        <div class="scroll"><table><thead><tr><th scope="col">Recipient</th><th scope="col">Email</th><th scope="col">SMS</th><th scope="col">Alerts</th></tr></thead><tbody>` +
        sorted.map(r => `<tr class="${reached(r) ? '' : 'dim'}"><td>${esc(USERS[r.u])}<small class="org">${esc(org(r.u))}</small></td><td>${stCell(r.email)}</td><td>${stCell(r.sms)}</td><td>${r.codes.map(c => esc(MODELS[c].name)).join(', ')}</td></tr>`).join('') + `</tbody></table></div>`;
    }
    h += `</section>`;
  }
  el.innerHTML = h;
}
function scrollToSec(sec){
  const pane = document.getElementById('detailpane');
  const target = sec && document.getElementById('d-' + sec);
  pane.scrollTop = target ? target.offsetTop - 12 : 0;
  if(matchMedia('(max-width: 960px)').matches) pane.scrollIntoView({block:'start'});
}
function select(kind, id, sec, focusSel){
  selected = {kind, id};
  renderTable(); renderDetail(); scrollToSec(sec);
  if(focusSel) document.querySelector(focusSel)?.focus({preventScroll:true});
}
function refresh(){ renderTable(); renderDetail(); }

function renderAll(){ renderSummary(); renderLanes(); renderFilters(); renderRecips(); refresh(); syncToggle(); }

/* ---------- events ---------- */
document.querySelectorAll('.seg button[data-tz]').forEach(b => b.addEventListener('click', () => {
  TZ = b.dataset.tz;
  document.querySelectorAll('.seg button[data-tz]').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderAll();
}));
document.getElementById('filters').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  const c = b.dataset.code; active.has(c) ? active.delete(c) : active.add(c); mPreset = 'custom';
  renderFilters(); renderLanes(); refresh();
  document.querySelector(`#filters button[data-code="${c}"]`)?.focus();
});
document.getElementById('rgrid').addEventListener('change', e => {
  const u = e.target.dataset.u; if(!u) return;
  e.target.checked ? selR.add(u) : selR.delete(u); rPreset = 'custom';
  document.getElementById('rcount').textContent = recipSummary();
  renderLanes(); refresh();
});
document.getElementById('rquick').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  selR.clear();
  const pick = {all:() => true, none:() => false, reached:u => userStats[u].reached > 0, never:u => userStats[u].reached === 0,
    customers:u => org(u) === CUST}[b.dataset.q];
  Object.keys(USERS).filter(pick).forEach(u => selR.add(u)); rPreset = b.dataset.q;
  renderRecips(); renderLanes(); refresh();
});
document.getElementById('mquick').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  const pick = {all:() => true, none:() => false, high:c => MODELS[c].sev === 'high', medium:c => MODELS[c].sev === 'medium'}[b.dataset.q];
  active.clear(); ORDER.filter(pick).forEach(c => active.add(c)); mPreset = b.dataset.q;
  renderFilters(); renderLanes(); refresh();
});
const tbody = document.getElementById('rows');
tbody.addEventListener('click', e => {
  const dt = e.target.closest('tr.day');
  if(dt){ const k = dt.dataset.day; expandedDays.has(k) ? expandedDays.delete(k) : expandedDays.add(k); syncToggle();
    renderTable(); document.querySelector(`#rows tr.day[data-day="${CSS.escape(k)}"]`)?.focus({preventScroll:true}); return; }
  const tr = e.target.closest('tr.run,tr.group,tr.ghead'); if(!tr) return;
  const m = e.target.closest('.mkr');
  if(tr.dataset.g){
    const id = +tr.dataset.g;
    if(!m){ openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id); }
    select('g', id, m ? m.dataset.sec : null, m ? `#rows tr[data-g="${id}"] .mkr[data-sec="${m.dataset.sec}"]` : `#rows tr[data-g="${id}"]`);
  } else {
    const id = +tr.dataset.s;
    select('s', id, m ? m.dataset.sec : null, m ? `#rows tr[data-s="${id}"] .mkr[data-sec="${m.dataset.sec}"]` : `#rows tr[data-s="${id}"]`);
  }
});
tbody.addEventListener('keydown', e => {
  if(e.target.closest('.mkr')) return;
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const tr = e.target.closest('tr.run,tr.group,tr.ghead,tr.day'); if(!tr) return;
  e.preventDefault(); tr.click();
});
document.getElementById('detail').addEventListener('click', e => {
  const j = e.target.closest('[data-jump]');
  if(j){ const id = +j.dataset.jump; expandedDays.add(dayLabel(new Date(id))); syncToggle();
    if(!viewById.has(id) || !document.querySelector(`#rows tr[data-s="${id}"]`)){ for(const [gid, g] of groupById) if(g.views.some(v => v.s.id === id)) openGroups.add(gid); }
    select('s', id, 'data'); document.querySelector(`#rows tr[data-s="${id}"]`)?.scrollIntoView({block:'center'}); return; }
  const x = e.target.closest('[data-expand]');
  if(x){ const id = +x.dataset.expand; openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id); refresh(); }
});
document.querySelectorAll('.seg button[data-clock]').forEach(b => b.addEventListener('click', () => {
  H24 = b.dataset.clock === '24';
  document.querySelectorAll('.seg button[data-clock]').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderAll();
}));
const allDays = () => [...new Set(slots.map(sl => dayLabel(sl.t)))];
const allOpen = () => allDays().every(d => expandedDays.has(d));
function syncToggle(){ const b = document.getElementById('toggleDays'); const open = allOpen();
  b.textContent = open ? 'Collapse all' : 'Expand all'; b.setAttribute('aria-pressed', open); }
document.getElementById('toggleDays').addEventListener('click', () => {
  if(allOpen()) expandedDays.clear(); else allDays().forEach(d => expandedDays.add(d));
  syncToggle(); renderTable();
});
renderAll();

document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
  const text = document.getElementById(b.dataset.copy).innerText;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents(document.getElementById(b.dataset.copy)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = 'Selected, press Ctrl+C'; }
  setTimeout(() => b.textContent = 'Copy', 2000);
}));
})();
