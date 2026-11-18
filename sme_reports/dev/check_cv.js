// Checks for the GE CV Insights viewer (hhm_rpp_ge PLAN-CV-INSIGHTS.md
// §13.4). DB-free: the page is built from the prod fixture
// (sme_reports/cv/test/fixtures, built read-only by cv/tools/build_fixture.js).
//
//   node sme_reports/dev/check_cv.js
//
// Asserts:
//   - the shared imports load (insights/page and its client core, the CT
//     model and as-of helpers), so a change to a shared module that breaks
//     CV fails here;
//   - "Internal" in the title, the header and the file name;
//   - the build is deterministic: byte-identical for the same input, and for
//     the same input with every dataset in reverse order;
//   - text from the database is escaped: a site name, metric catalog
//     labels, code labels and finding text carrying markup stay text, in
//     server-drawn and client-drawn HTML;
//   - the as-of day: a real calendar day, and only the snapshot's UTC day;
//   - privacy: source files are base names; no debug text or encoded field
//     names in the file;
//   - exact half-up rounding of the client's rates and shares (q2);
//   - in headless Chromium: zero page errors; every finding-band label
//     inside its chart (also for a band spanning the whole period); a single
//     visible dim keeps its name; a period's leading axis past palette slot 8
//     is shown by name; the dashboard and every system
//     view, in every period and with either peak scale, have no sideways
//     scroll at 390 px; a panel is shown exactly when the system logs one of
//     its metrics (also with capabilities removed), and a chart only when its
//     metric is logged (SME08640 has no PIB); the peak scale toggle cuts and
//     restores the peaks; the dashboard filter, row click, next / previous,
//     back, the period carried across systems, and a chart tooltip work.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const M = require("../cv/model");
const { build_cv_page, page_name, TITLE } = require("../cv/render");
const { resolve_as_of } = require("../ct/cli");
const { args: cli_args } = require("../cv/cli");

const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "cv", "test", "fixtures", "cv_fixture.json.gz"))).toString("utf8"));
const AS_OF = FX.as_of;
const build = (raw) => build_cv_page(M.build_model(raw, { as_of: AS_OF }));

// --- shared imports, names, Internal -------------------------------------------
for (const m of ["../insights/page", "../insights/verify_core", "../ct/model", "../render/fleet_page", "../incident/timeline", "../incident/system_page", "../render/assets/logo_small"]) require(m);
const base = build(FX);
assert.strictEqual(base.name, `Avante-GE-CV-Insights-Internal-${AS_OF}.html`);
assert.strictEqual(page_name("2026-01-02"), "Avante-GE-CV-Insights-Internal-2026-01-02.html");
assert.ok(/Internal/.test(base.name), "file name says Internal");
assert.ok(base.html.includes(`<title>${TITLE}</title>`) && TITLE.includes("Internal"), "title says Internal");
assert.ok(base.html.includes('GE CV Insights<span class="internal-tag">Internal</span>'), "header says Internal");
assert.ok(!/\/\/@@[a-z-]+@@/.test(base.html), "no client marker left");

// --- deterministic ------------------------------------------------------------
assert.strictEqual(build(FX).html, base.html, "same input, same bytes");
const reversed = Object.fromEntries(Object.entries(FX).map(([k, v]) => [k, Array.isArray(v) ? v.slice().reverse() : v]));
assert.strictEqual(build(reversed).html, base.html, "input order does not matter");

// --- escaping -------------------------------------------------------------------
const evil = '<img src=x onerror="window.__pwned=1">';
const tainted = build({
  ...FX,
  identity: FX.identity.map((r) => ({ ...r, site_name: evil, customer_name: "A & B <C>" })),
  inventory: FX.inventory.map((r) => ({ ...r, site_name: evil })),
  findings: FX.findings.map((f) => ({ ...f, label: evil, description: evil, category: evil }))
});
assert.ok(!tainted.html.includes(evil), "identity and finding text with markup is escaped");
assert.ok(tainted.html.includes("A &amp; B &lt;C&gt;"), "customer name escaped");
// catalog labels and code labels reach client-drawn HTML; code labels also the finding cards
const label_tainted = build({
  ...FX,
  capabilities: FX.capabilities.map((c) => ({ ...c, label: `${evil}${c.label}` })),
  codes: FX.codes.map((c) => ({ ...c, label: c.label === null ? null : `${evil}${c.label}`, sourcefile: c.sourcefile ? `${evil}.c` : c.sourcefile }))
});
assert.ok(!label_tainted.html.includes(evil), "code and catalog labels escaped in server HTML and inert in the JSON blocks");

// --- the as-of day ----------------------------------------------------------------
assert.strictEqual(resolve_as_of(null, "2026-11-18"), "2026-11-18");
for (const bad of ["2026-11-17", "2026-11-19", "2026-02-31"]) assert.throws(() => resolve_as_of(bad, "2026-11-18"), undefined, `--as-of ${bad} refused`);
assert.throws(() => cli_args(["--as-of", "2026-02-31"]), /bad --as-of/);
assert.throws(() => cli_args(["--bogus"]), /unknown argument/);
assert.throws(() => M.build_model(FX, { as_of: "2026-02-31" }), /bad as_of/);

// --- privacy ----------------------------------------------------------------------
const index = JSON.parse(base.html.match(/<script type="application\/json" id="app-index">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/gi, "<"));
for (const [c, k] of Object.entries(index.codes)) assert.ok(!k.sourcefile || !/[\\/]/.test(k.sourcefile), `code ${c}: source file base name`);
for (const k of ["debugtext", "errortext", "majorfunction", "minorfunction", "fru"]) assert.ok(!new RegExp(`"${k}"`).test(base.html), `no ${k} in the file`);
assert.ok(Object.keys(index.codes).length > 100, "code labels carried");

// --- capabilities removed ---------------------------------------------------------
const model = M.build_model(FX, { as_of: AS_OF });
const order = [...model.reporting, ...model.not_reporting].map((r) => r.system_id);
const PANEL_TITLES = Object.fromEntries(M.PANELS.map((p) => [p.key, p.label]));
const drop = ["cv.detector_com_error", "cv.positioner_collision", "cv.anticollision_error", "cv.table_encoder_failure", "cv.emergency_backout"];
const no_pos = build({ ...FX, capabilities: FX.capabilities.filter((c) => !(c.system_id === "SME02412" && drop.includes(c.metric_key))) });
assert.ok(!model.views.SME08640.ev["cv.pib_com_loss"] && model.views.SME02412.ev["cv.pib_com_loss"], "fixture: PIB logged on SME02412 only");

// --- exact rounding in the client (review CV6-PAGE F4) -----------------------------
const CLIENT_SRC = fs.readFileSync(path.join(__dirname, "..", "cv", "cv.client.js"), "utf8");
const q2_src = CLIENT_SRC.match(/const q2 = \(n, d, scale = 1\) => \{[\s\S]*?\n\};/);
assert.ok(q2_src, "q2 found in cv.client.js");
const q2 = new Function(`${q2_src[0]}; return q2;`)();
for (const [n, d, sc, want] of [[323, 40, 1, "8.08"], [1, 8, 1, "0.13"], [2, 3, 100, "66.67"], [1, 3, 100, "33.33"], [0, 5, 1, "0.00"], [5, 0, 1, "—"], [17, 200, 100, "8.50"], [7, 1, 1, "7.00"], [45692, 74, 1, "617.46"]]) {
  assert.strictEqual(q2(n, d, sc), want, `q2(${n}, ${d}, ${sc})`);
}

// --- band label and dim edge cases (review CV6-PAGE F2, F3) ------------------------
// a finding open since before the data starts: its band spans every period
const spanning = (() => {
  const f = FX.findings.find((x) => x.system_id === "SME02412" && x.status === "resolved");
  const g = { ...f, status: "open", resolved_at: null, evidence: { ...f.evidence, opened_day: "2026-01-01", resolved_day: null } };
  return build({ ...FX, findings: FX.findings.map((x) => (x === f ? g : x)) });
})();
// a recent burst on an axis ranked past slot 8 over all history (l_arm)
const L02412 = M.build_model(FX, { as_of: AS_OF }).views.SME02412.header.last_day;
// ... and, on the same page, only one table-encoder axis (rotation, slot 2) in
// the last 30 days: its bars keep rotation's colour (review CV6-PAGE F1)
const L30 = new Date(Date.parse(`${L02412}T00:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10);
const burst_fx = {
  ...FX,
  daily: [...FX.daily.filter((r) => !(r.system_id === "SME02412" && r.m === "cv.table_encoder_failure" && r.dim !== "rotation" && r.day >= L30)),
    { system_id: "SME02412", day: L02412, m: "cv.anticollision_error", dim: "l_arm", n: 100, sub: null }]
};
const burst_model = M.build_model(burst_fx, { as_of: AS_OF });
assert.ok(burst_model.views.SME02412.ranks["cv.anticollision_error"].all.indexOf("l_arm") >= 8, "l_arm is past slot 8 over all history");
assert.strictEqual(burst_model.views.SME02412.ranks["cv.anticollision_error"]["30d"][0], "l_arm", "l_arm leads the 30-day period");
const burst = build_cv_page(burst_model);

// --- Chromium -----------------------------------------------------------------------
const fits_phone = async (page, what) => {
  const vp = page.viewport();
  await page.setViewport({ width: 390, height: 844 });
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${what}: sideways scroll at phone width`);
  await page.setViewport(vp);
};
const panel_titles = (page) => page.$$eval(".panels > section > h2", (h) => h.map((x) => x.firstChild.textContent.trim()));
const chart_titles = (page) => page.$$eval(".panels .chart h3", (h) => h.map((x) => x.textContent.trim()));
// every band label inside its SVG's view box (review CV6-PAGE F3)
const band_labels_outside = (page) => page.$$eval("svg text.bandt", (ts) => ts.filter((t) => {
  const b = t.getBBox(), w = t.ownerSVGElement.viewBox.baseVal.width;
  return b.x < -0.5 || b.x + b.width > w + 0.5;
}).map((t) => t.textContent));

(async () => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: "new", executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-cv-"));
  let views = 0;
  try {
    const file = path.join(dir, base.name);
    fs.writeFileSync(file, base.html);
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const at = (hash) => page.waitForFunction((h) => location.hash === h, {}, hash);

    // dashboard
    await page.goto(`file://${file}`, { waitUntil: "load" });
    assert.strictEqual(await page.title(), TITLE);
    assert.ok((await page.$eval(".brandbar", (e) => e.textContent)).includes("Internal"), "header shows Internal");
    assert.ok((await page.$eval("h1", (e) => e.textContent)).includes("Internal"), "h1 shows Internal");
    await fits_phone(page, "dashboard");
    assert.deepStrictEqual(await page.$$eval("#systems tbody tr[data-sys]", (r) => r.map((x) => x.dataset.sys)), order, "fleet rows in model order");
    assert.strictEqual(await page.$$eval(".nodatalist tbody tr", (r) => r.length), model.no_data.length, "configured without data listed");
    assert.strictEqual(await page.$$eval(".inv tbody tr", (r) => r.length), model.inventory.length, "inventory footer");
    await page.type("#dfilter", order[0].toLowerCase());
    assert.strictEqual(await page.$$eval("#systems tbody tr[data-sys]:not([hidden])", (r) => r.length), 1, "filter");
    await page.$eval("#dfilter", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); });

    // every system view, every period, both scales
    await page.click(`#systems tr[data-sys="${order[0]}"] td:nth-child(3)`);
    await at(`#${order[0]}`);
    for (let i = 0; i < order.length; i++) {
      const sid = order[i];
      if (i) {
        await page.evaluate((s) => { location.hash = s; }, sid);
        await at(`#${sid}`);
      }
      assert.strictEqual(await page.title(), `${sid} · ${TITLE}`);
      const want = M.PANELS.filter((p) => model.views[sid].panels.includes(p.key)).map((p) => PANEL_TITLES[p.key]);
      for (const p of model.periods) {
        await page.click(`.periodbar .seg button[data-period="${p.key}"]`);
        assert.strictEqual(await page.$eval(`.periodbar .seg button[data-period="${p.key}"]`, (b) => b.getAttribute("aria-pressed")), "true");
        assert.deepStrictEqual(await panel_titles(page), want, `${sid} ${p.key}: panels shown = panels logged`);
        for (const scale of ["full", "clip"]) {
          await page.click(`button[data-scale="${scale}"]`);
          assert.strictEqual(await page.$eval(`button[data-scale="${scale}"]`, (b) => b.getAttribute("aria-pressed")), "true", `${sid} ${p.key} scale ${scale}`);
          assert.strictEqual(await page.$eval('.periodbar .seg button[aria-pressed="true"]', (b) => b.dataset.period), p.key, "the scale keeps the period");
          await fits_phone(page, `${sid} ${p.key} ${scale}`);
        }
        assert.deepStrictEqual(await band_labels_outside(page), [], `${sid} ${p.key}: band labels inside the chart`);
        const charts = await chart_titles(page);
        if (sid === "SME08640" && p.key === "all") assert.ok(charts.includes("Detector communication errors per day (waitRxCommandDm)"), "a single operation keeps its name (review CV6-PAGE F1)");
        assert.strictEqual(charts.includes("PIB communication loss per day"), !!model.views[sid].ev["cv.pib_com_loss"], `${sid} ${p.key}: PIB chart only when logged`);
        views++;
      }
      assert.strictEqual(await page.$$eval(".fcard", (c) => c.length), model.views[sid].findings.length, `${sid}: one card per finding`);
    }

    // the peak scale: SME02412 over 90 days has a day above the cut
    await page.evaluate(() => { location.hash = "SME02412"; });
    await at("#SME02412");
    await page.click('.periodbar .seg button[data-period="90d"]');
    await page.click('button[data-scale="clip"]');
    assert.ok((await page.$$("svg path.peak")).length > 0, "clipped peaks are marked");
    await page.click('button[data-scale="full"]');
    assert.strictEqual((await page.$$("svg path.peak")).length, 0, "full scale: no cut");
    await page.click('button[data-scale="clip"]');

    // period carried across systems; next / previous; back; tooltip
    await page.evaluate((s) => { location.hash = s; }, order[0]);
    await at(`#${order[0]}`);
    await page.click('.periodbar .seg button[data-period="30d"]');
    await page.click(".appnav .step a");
    await at(`#${order[1]}`);
    assert.strictEqual(await page.$eval('.periodbar .seg button[aria-pressed="true"]', (b) => b.dataset.period), "30d", "period carried to the next system");
    const svg = await page.$(".panels svg[data-chart]");
    await svg.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    assert.strictEqual(await page.$eval("#tip", (t) => t.hidden), false, "chart tooltip on hover");
    await page.click('.appnav a[href="#"]');
    await page.waitForSelector("#systems");
    assert.strictEqual(await page.title(), TITLE, "back on the dashboard");
    assert.deepStrictEqual(errors, [], "page errors");
    await page.close();

    // capabilities removed: their panels are not drawn
    const f2 = path.join(dir, "no-positioner.html");
    fs.writeFileSync(f2, no_pos.html);
    const p2 = await browser.newPage();
    const e2 = [];
    p2.on("pageerror", (e) => e2.push(e.message));
    await p2.goto(`file://${f2}#SME02412`, { waitUntil: "load" });
    assert.deepStrictEqual(await panel_titles(p2), ["Errors", "Errors by code", "Connectivity"], "SME02412: detector and positioner panels hidden without their capability");
    assert.deepStrictEqual(e2, []);
    await p2.close();

    // a band spanning the period: its label goes inside the plot, never outside (F3)
    const f5 = path.join(dir, "spanning.html");
    fs.writeFileSync(f5, spanning.html);
    const p5 = await browser.newPage();
    const e5 = [];
    p5.on("pageerror", (e) => e5.push(e.message));
    await p5.goto(`file://${f5}#SME02412`, { waitUntil: "load" });
    for (const p of model.periods) {
      await p5.click(`.periodbar .seg button[data-period="${p.key}"]`);
      assert.deepStrictEqual(await band_labels_outside(p5), [], `spanning band ${p.key}: labels inside`);
      assert.ok((await p5.$$("svg text.bandt.in")).length >= 1, `spanning band ${p.key}: label placed inside the plot`);
    }
    assert.deepStrictEqual(e5, []);
    await p5.close();

    // a period's leading axis past slot 8 is shown by name, not folded into other (F2)
    const f6 = path.join(dir, "burst.html");
    fs.writeFileSync(f6, burst.html);
    const p6 = await browser.newPage();
    await p6.goto(`file://${f6}#SME02412`, { waitUntil: "load" });
    await p6.click('.periodbar .seg button[data-period="30d"]');
    const ac = await p6.$$eval(".panels .chart", (cs) => cs.filter((c) => c.querySelector("h3").textContent.startsWith("Anticollision")).map((c) => c.textContent)[0]);
    assert.ok(/l arm 100/.test(ac), "l_arm shown with its 30-day total");
    const te = burst_model.views.SME02412.ranks["cv.table_encoder_failure"];
    assert.deepStrictEqual(te["30d"], ["rotation"], "one table-encoder axis in 30 days");
    const slot = te.all.indexOf("rotation");
    assert.ok(slot >= 1, "rotation is not slot 1, so the aggregate's colour would differ");
    const fills = await p6.$$eval(".panels .chart", (cs) => {
      const c = cs.find((x) => x.querySelector("h3").textContent.startsWith("Table encoder"));
      return [...new Set([...c.querySelectorAll("svg rect[fill]")].map((r) => r.getAttribute("fill")).filter((f) => f.startsWith("#") && f.toUpperCase() !== "#EEF1F4"))];
    });
    const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
    assert.deepStrictEqual(fills, [SERIES[slot]], "a single visible axis keeps its own colour");
    await p6.close();

    // labels with markup stay text in every system view and period
    const f4 = path.join(dir, "label-tainted.html");
    fs.writeFileSync(f4, label_tainted.html);
    const p4 = await browser.newPage();
    const e4 = [];
    p4.on("pageerror", (e) => e4.push(e.message));
    await p4.goto(`file://${f4}`, { waitUntil: "load" });
    for (const sid of order) {
      await p4.evaluate((s) => { location.hash = s; }, sid);
      await p4.waitForFunction((h) => location.hash === h, {}, `#${sid}`);
      await p4.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
      for (const p of model.periods) {
        await p4.click(`.periodbar .seg button[data-period="${p.key}"]`);
        await p4.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
        assert.strictEqual(await p4.evaluate(() => window.__pwned === undefined && !document.querySelector("#app img")), true, `${sid} ${p.key}: label markup stays text`);
      }
      assert.ok((await p4.$eval(".panels", (e) => e.textContent)).includes("onerror"), `${sid}: the tainted labels are shown as text`);
    }
    assert.deepStrictEqual(e4, []);
    await p4.close();

    // escaped identity and finding markup never runs
    const f3 = path.join(dir, "tainted.html");
    fs.writeFileSync(f3, tainted.html);
    const p3 = await browser.newPage();
    await p3.goto(`file://${f3}`, { waitUntil: "load" });
    await p3.evaluate(() => { location.hash = "SME02412"; });
    await p3.waitForFunction(() => location.hash === "#SME02412");
    assert.strictEqual(await p3.evaluate(() => window.__pwned === undefined && !document.querySelector("img[onerror]")), true, "markup in site names and findings stays text");
    await p3.close();
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`check_cv: all assertions passed (${order.length} systems, ${views} system views x periods x 2 scales, ${(Buffer.byteLength(base.html) / 1e6).toFixed(2)} MB)`);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
