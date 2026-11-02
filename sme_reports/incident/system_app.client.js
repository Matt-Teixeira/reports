/* Router for the System Activity app (system_app.js inlines it after
   timeline.client.js). One file, many systems: the dashboard and every
   system view are inert <template>s, and the hash picks one (#SME15807; empty
   or unknown = the dashboard). The pick is cloned into #app and a system is
   mounted with its own data block, parsed only when opened. Offline: no
   fetch, no server, so it opens from a zip or an attachment. */
(function(){
const INDEX = JSON.parse(document.getElementById('app-index').textContent);
const app = document.getElementById('app');
const titles = new Map(INDEX.systems.map(s => [s.id, s.title]));
const prefs = {};          // time zone and clock, carried from system to system
let filter = '';           // the dashboard's text filter, kept while browsing
let current = null;        // null before the first view, '' = the dashboard
let dashY = 0;             // where the reader was on the dashboard
if('scrollRestoration' in history) history.scrollRestoration = 'manual';

function mountDashboard(){
  const input = document.getElementById('dfilter');
  const rows = [...document.querySelectorAll('#systems tbody tr')];
  const shown = document.getElementById('dshown');
  const apply = () => {
    const q = filter.trim().toLowerCase();
    let n = 0;
    rows.forEach(r => { const hit = !q || r.dataset.q.includes(q); r.hidden = !hit; if(hit) n++; });
    shown.textContent = q ? `${n} of ${rows.length} shown` : '';
  };
  input.value = filter;
  input.addEventListener('input', () => { filter = input.value; apply(); });
  // The whole row opens its system; the link in it stays the keyboard path.
  document.getElementById('systems').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-sys]');
    if(tr && !e.target.closest('a')) location.hash = tr.dataset.sys;
  });
  apply();
}

function show(){
  const id = decodeURIComponent(location.hash.slice(1));
  const sys = titles.has(id) ? id : '';
  if(sys === current) return;
  if(current === '') dashY = window.scrollY;
  app.replaceChildren(document.getElementById(sys ? 'view-' + sys : 'view-dashboard').content.cloneNode(true));
  if(sys){
    mountTimeline(JSON.parse(document.getElementById('data-' + sys).textContent), prefs);
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
