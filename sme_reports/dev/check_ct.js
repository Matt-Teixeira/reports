// Checks for the GE CT Insights viewer (hhm_rpp_ge PLAN-CT-INSIGHTS.md
// §16.4). DB-free: the page is built from the prod fixture
// (sme_reports/ct/test/fixtures, built read-only by ct/tools/build_fixture.js).
//
//   node sme_reports/dev/check_ct.js
//
// Asserts:
//   - the shared imports load (render/fleet_page esc, incident/timeline CSS,
//     incident/system_page footer / json_script / PAGE_CSS, the logo), so an
//     in-progress change that breaks them fails here;
//   - "Internal" in the title, the header and the file name;
//   - the build is deterministic: byte-identical for the same input, and for
//     the same input with every dataset in reverse order;
//   - text from the database is escaped (a site name, and metric catalog
//     labels drawn by the client, carrying markup stay text);
//   - the as-of day: a real calendar day, and the CLI accepts only the
//     snapshot's UTC day;
//   - no exam number or protocol reaches the file;
//   - in headless Chromium: zero page errors; the dashboard and every system
//     view, in every period, have no sideways scroll at 390 px; a panel is
//     shown exactly when the system logs one of its metrics (also with a
//     capability removed); the dashboard filter, row click, next / previous,
//     back, the period carried across systems, and a chart tooltip work.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const M = require("../ct/model");
const { build_ct_page, page_name, TITLE } = require("../ct/render");
const { resolve_as_of } = require("../ct/cli");

const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "ct", "test", "fixtures", "ct_fixture.json.gz"))).toString("utf8"));
const AS_OF = FX.as_of;
const build = (raw) => build_ct_page(M.build_model(raw, { as_of: AS_OF }));

// --- shared imports, names, Internal -------------------------------------------
for (const m of ["../render/fleet_page", "../incident/timeline", "../incident/system_page", "../render/assets/logo_small"]) require(m);
const base = build(FX);
assert.strictEqual(base.name, `Avante-GE-CT-Insights-Internal-${AS_OF}.html`);
assert.strictEqual(page_name("2026-01-02"), "Avante-GE-CT-Insights-Internal-2026-01-02.html");
assert.ok(/Internal/.test(base.name), "file name says Internal");
assert.ok(base.html.includes(`<title>${TITLE.replace("—", "—")}</title>`) && TITLE.includes("Internal"), "title says Internal");
assert.ok(base.html.includes('<span class="internal-tag">Internal</span>'), "header says Internal");

// --- deterministic ------------------------------------------------------------
assert.strictEqual(build(FX).html, base.html, "same input, same bytes");
const reversed = Object.fromEntries(Object.entries(FX).map(([k, v]) => [k, Array.isArray(v) ? v.slice().reverse() : v]));
assert.strictEqual(build(reversed).html, base.html, "input order does not matter");

// --- escaping and scrub ---------------------------------------------------------
const evil = '<img src=x onerror="window.__pwned=1">';
const tainted = build({ ...FX, identity: FX.identity.map((r, i) => (i === 0 ? { ...r, site_name: evil, customer_name: "A & B <C>" } : r)) });
assert.ok(!tainted.html.includes(evil), "a site name with markup is escaped");
assert.ok(tainted.html.includes("A &amp; B &lt;C&gt;"), "customer name escaped");
for (const k of ["exam_no", "protocol"]) assert.ok(!base.html.includes(`"${k}"`), `no ${k} in the file`);

// catalog labels reach client-drawn HTML (review PHASE6-PAGE F1)
const label_tainted = build({ ...FX, capabilities: FX.capabilities.map((c) => ({ ...c, label: `${evil}${c.label}`, unit: c.unit ? `${evil}${c.unit}` : c.unit })) });

// --- the as-of day (review PHASE6-PAGE F2) ---------------------------------------
assert.strictEqual(resolve_as_of(null, "2026-11-05"), "2026-11-05");
assert.strictEqual(resolve_as_of("2026-11-05", "2026-11-05"), "2026-11-05");
for (const bad of ["2026-11-04", "2026-11-06", "2026-02-31", "2026-13-01", "20261105"]) assert.throws(() => resolve_as_of(bad, "2026-11-05"), undefined, `--as-of ${bad} refused`);
assert.throws(() => M.build_model(FX, { as_of: "2026-02-31" }), /bad as_of/, "model refuses an impossible day");
assert.ok(M.valid_day("2028-02-29") && !M.valid_day("2026-02-29"), "leap days");

// --- a capability removed: its panel goes ----------------------------------------
const model = M.build_model(FX, { as_of: AS_OF });
const order = [...model.reporting, ...model.not_reporting].map((r) => r.system_id);
const PANEL_TITLES = { tube: "Tube", utilization: "Utilization", reliability: "Reliability", compliance: "Compliance", environment: "Environment", rotor: "Rotor" };
const with_rotor = order.find((s) => model.views[s].panels.includes("rotor"));
assert.ok(with_rotor, "fixture has a system with the rotor panel");
const rotor_metrics = M.PANELS.find((p) => p.key === "rotor").metrics;
const no_rotor = build({ ...FX, capabilities: FX.capabilities.filter((c) => !(c.system_id === with_rotor && rotor_metrics.includes(c.metric_key))) });
const panels_without = [...model.views[with_rotor].panels].filter((p) => p !== "rotor");
// panel variety: at least one system without some panel
assert.ok(order.some((s) => model.views[s].panels.length < M.PANELS.length), "fixture has a system missing a panel");

// --- Chromium -----------------------------------------------------------------------
const fits_phone = async (page, what) => {
  const vp = page.viewport();
  await page.setViewport({ width: 390, height: 844 });
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${what}: sideways scroll at phone width`);
  await page.setViewport(vp);
};
const panel_titles = (page) => page.$$eval(".panels > section > h2", (h) => h.map((x) => x.firstChild.textContent.trim()));

(async () => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: "new", executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-ct-"));
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
    await page.type("#dfilter", order[0].toLowerCase());
    assert.strictEqual(await page.$$eval("#systems tbody tr[data-sys]:not([hidden])", (r) => r.length), 1, "filter");
    await page.$eval("#dfilter", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); });

    // every system view, every period
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
        await page.click(`.seg button[data-period="${p.key}"]`);
        assert.strictEqual(await page.$eval(`.seg button[data-period="${p.key}"]`, (b) => b.getAttribute("aria-pressed")), "true");
        assert.deepStrictEqual(await panel_titles(page), want, `${sid} ${p.key}: panels shown = panels logged`);
        await fits_phone(page, `${sid} ${p.key}`);
        views++;
      }
      assert.strictEqual(await page.$$eval(".fcard", (c) => c.length), model.views[sid].findings.length, `${sid}: one card per finding`);
    }

    // period carried across systems; next / previous; back; tooltip
    await page.evaluate((s) => { location.hash = s; }, order[0]);
    await at(`#${order[0]}`);
    await page.click('.seg button[data-period="30d"]');
    await page.click(".appnav .step a");
    await at(`#${order[1]}`);
    assert.strictEqual(await page.$eval('.seg button[aria-pressed="true"]', (b) => b.dataset.period), "30d", "period carried to the next system");
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

    // a capability removed: the panel is not drawn
    const f2 = path.join(dir, "no-rotor.html");
    fs.writeFileSync(f2, no_rotor.html);
    const p2 = await browser.newPage();
    const e2 = [];
    p2.on("pageerror", (e) => e2.push(e.message));
    await p2.goto(`file://${f2}#${with_rotor}`, { waitUntil: "load" });
    assert.deepStrictEqual(await panel_titles(p2), M.PANELS.filter((p) => panels_without.includes(p.key)).map((p) => PANEL_TITLES[p.key]), `${with_rotor}: rotor panel hidden without its capability`);
    assert.deepStrictEqual(e2, []);
    await p2.close();

    // catalog labels with markup stay text in every system view and period
    const f4 = path.join(dir, "label-tainted.html");
    fs.writeFileSync(f4, label_tainted.html);
    const p4 = await browser.newPage();
    const e4 = [];
    p4.on("pageerror", (e) => e4.push(e.message));
    await p4.goto(`file://${f4}`, { waitUntil: "load" });
    let label_views = 0;
    for (const sid of order) {
      await p4.evaluate((s) => { location.hash = s; }, sid);
      await p4.waitForFunction((h) => location.hash === h, {}, `#${sid}`);
      for (const p of model.periods) {
        await p4.click(`.seg button[data-period="${p.key}"]`);
        assert.strictEqual(await p4.evaluate(() => window.__pwned === undefined && !document.querySelector("#app img")), true, `${sid} ${p.key}: catalog label markup stays text`);
        label_views++;
      }
      assert.ok((await p4.$eval(".panels", (e) => e.textContent)).includes("onerror"), `${sid}: the tainted label is shown as text`);
    }
    assert.deepStrictEqual(e4, []);
    await p4.close();

    // escaped markup never runs
    const f3 = path.join(dir, "tainted.html");
    fs.writeFileSync(f3, tainted.html);
    const p3 = await browser.newPage();
    await p3.goto(`file://${f3}`, { waitUntil: "load" });
    assert.strictEqual(await p3.evaluate(() => window.__pwned === undefined && !document.querySelector("img[onerror]")), true, "markup in a site name stays text");
    await p3.close();
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`check_ct: all assertions passed (${order.length} systems, ${views} system views x periods, ${(Buffer.byteLength(base.html) / 1e6).toFixed(2)} MB)`);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
