const logo_base64 = require("./assets/logo");

// Assembles the full one-page HTML document from the view-model built by
// model.js. Interpolation only — no logic beyond mapping lists to markup.
// Both <style> blocks are copied verbatim from the reports_new exemplars
// (the second block is the density patch that keeps everything on one page).

const BASE_CSS = `
@page { size: letter; margin: 0; } * { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #070809; }
.page { width: 8.5in; height: 11in; padding: .42in .5in 0; overflow: hidden; position: relative; background: #fff; }
.hdr { display: flex; align-items: center; justify-content: space-between; }
.hdr img { height: .48in; } .hdr .r { text-align: right; font-size: 9.5pt; color: #57585A; line-height: 1.35; }
.band { height: .08in; border-radius: .05in; margin: .09in 0 .16in; background: linear-gradient(90deg,#002B43 0 30%,#004E79 30% 62%,#97C6E9 62% 100%); }
h1 { font-size: 17.5pt; color: #002B43; } .sub { font-size: 10.5pt; color: #57585A; margin-top: .04in; }
.tiles { display: flex; gap: .1in; margin-top: .16in; }
.tile { flex: 1; border-radius: .12in; padding: .1in .12in; background: #EBF0F5; }
.tile .k { font-size: 7.5pt; letter-spacing: .1em; color: #57585A; } .tile .v { font-size: 15pt; font-weight: 800; margin-top: .02in; }
.tile .s { font-size: 8pt; color: #57585A; margin-top: .015in; }
.good .v { color: #00695C; } .bad .v { color: #E50B14; } .warn .v { color: #C25E00; } .ink .v { color: #002B43; }
.dim .v { color: #57585A; }
.banner { margin-top: .1in; border: 1.5px solid #C9CDD2; border-radius: .1in; padding: .06in .12in; background: #F4F4F5; font-size: 8.4pt; line-height: 1.4; color: #57585A; }
.banner b { color: #070809; letter-spacing: .06em; }
h2 { font-size: 10pt; letter-spacing: .1em; color: #004E79; margin: .18in 0 .04in; }
.story { margin-top: .16in; background: #EBF0F5; border-radius: .12in; padding: .12in .15in; font-size: 9.6pt; line-height: 1.5; }
.story b { color: #002B43; }
.rx { margin-top: .12in; display: flex; gap: .1in; }
.rx .card { flex: 1; border-radius: .1in; padding: .09in .12in; font-size: 8.8pt; line-height: 1.45; border: 1.5px solid #97C6E9; }
.rx .card b { color: #004E79; display: block; font-size: 8pt; letter-spacing: .08em; margin-bottom: .02in; }
.foot { position: absolute; left: 0; right: 0; bottom: 0; height: .38in; background: #002B43; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 .5in; font-size: 8.5pt; }
`;

// .sub ellipsizes rather than hard-clipping at the page edge: on long site
// names the tail ("analyzed <date>") used to vanish without a trace. Every
// fact in that tail is stated elsewhere on the page (header date, chart
// headings, DATA NOTES), so truncation loses nothing — wrapping instead
// would cost a line of vertical space on exactly the tightest pages.
const DENSITY_CSS = `h2{margin:.09in 0 .02in}.tiles{margin-top:.1in}.story{margin-top:.07in;font-size:9pt;line-height:1.38}.rx{margin-top:.07in}.rx .card{font-size:8.2pt;padding:.06in .09in}.sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card svg{display:block}`;

// Compact tier (vm.density === "compact"): applied when the period produced
// more prose than the normal layout's measured capacity (model.js
// COMPACT_AT). Every value here was tuned against the maximal fixtures in
// dev/check_chart.js, which lay the page out in Chromium and assert nothing
// crosses the footer — do not change one without re-running that check.
const COMPACT_CSS = `.page.compact .band{margin:.07in 0 .12in}
.page.compact .tiles{margin-top:.08in}
.page.compact .tile .v{font-size:14pt}
.page.compact .tile .s{font-size:7.6pt}
.page.compact .banner{font-size:8pt;line-height:1.35;padding:.05in .1in;margin-top:.08in}
.page.compact h2{margin:.07in 0 .015in}
.page.compact .story{font-size:8.3pt;line-height:1.3;margin-top:.06in;padding:.09in .12in}
.page.compact .rx{margin-top:.06in}
.page.compact .rx .card{font-size:7.7pt;line-height:1.34;padding:.05in .08in}`;

const tile_html = (t) =>
  ` <div class="tile ${t.cls}"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s}</div></div>`;

const card_html = (c) => `<div class="card"><b>${c.heading}</b>${c.body}</div>`;

// Sensor-suspect strip (RULES.md §5) — sits between the sub-line and the
// tiles so it reframes every value below it before the reader meets one.
const banner_html = (b) =>
  b ? `<div class="banner">⚠ <b>${b.label}</b> — ${b.text}</div>\n` : "";

const heading_note = (note) =>
  `<span style="color:#57585A;font-weight:400;letter-spacing:0">${note}</span>`;

const build_page = (vm) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${vm.title}</title></head><style>${BASE_CSS}</style><style>${DENSITY_CSS}</style><style>${COMPACT_CSS}</style><body><div class="page${vm.density ? ` ${vm.density}` : ""}">
<div class="hdr"><img src="data:image/png;base64,${logo_base64}"><div class="r">Magnet Health Brief<br><b>${vm.analyzed_date}</b></div></div>
<div class="band"></div>
<h1>${vm.h1_text}</h1>
<div class="sub">${vm.sub_line}</div>
${banner_html(vm.banner)}<div class="tiles">
${vm.tiles.map(tile_html).join("\n")}
</div>
<h2>${vm.pressure_heading} ${heading_note(vm.pressure_heading_note)}</h2>
<div class="card">${vm.pressure_chart_svg}</div>
<h2>${vm.helium_heading} ${heading_note(vm.helium_heading_note)}</h2>
<div class="card">${vm.helium_chart_svg}</div>
<div class="story">${vm.story_html}</div>
<div class="rx">${vm.rx_cards.map(card_html).join("")}</div>
<div class="foot"><span>Avante · Moving Healthcare Forward</span><span>${vm.foot_source}</span></div>
</div></body></html>
`;

module.exports = { build_page };
