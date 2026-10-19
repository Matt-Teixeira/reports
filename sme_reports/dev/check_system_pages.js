// Checks for the per-system System Activity pages
// (PLAN-FLEET-SYSTEM-PAGES.md). DB-free: synthetic rows in the shapes
// incident/activity_data.js and run_one's result.activity produce.
//
//   node sme_reports/dev/check_system_pages.js
//
// Asserts: the Avante scrub; page selection (attention ∪ data issue ∪
// failed, never healthy or limited); zip chunking; GE / Philips / Siemens
// non-TIM / failed-system pages render, carry their own labels, contain no
// Avante user and none of the Anomaly Report's interpretive sections;
// byte-identical output for identical input; and every page loads in
// Chromium with zero page errors.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { scrub_avante, is_avante_user } = require("../incident/scrub");
const { analyze_activity, SLOT_MS } = require("../incident/activity");
const { build_system_page, system_page_name } = require("../incident/system_page");
const { select_page_systems, chunk_pages } = require("../incident/system_pages");

const T0 = Date.UTC(2026, 9, 1, 0, 0); // window start (Oct 1 2026, 00:00Z)
const DAYS = 3;
const T1 = T0 + DAYS * 86400e3;
const H = 3600e3;

// --- the Avante scrub --------------------------------------------------------
{
  for (const email of [
    "jane@avantehs.com",
    "JANE@AvanteHS.com",
    "ops@avante-hs.com",
    "x@avantehealth.org",
    "joe.avante@gmail.com"
  ])
    assert.ok(is_avante_user(email, null), `${email} must be Avante`);
  assert.ok(is_avante_user("pat@hospital.org", { first_name: "Pat", last_name: "Avante" }), "Avante surname");
  assert.ok(is_avante_user("pat@hospital.org", { first_name: "AVANTE Service", last_name: "Desk" }), "Avante first name");
  assert.ok(!is_avante_user("pat@hospital.org", { first_name: "Pat", last_name: "Smith" }), "customer user kept");
  assert.ok(!is_avante_user("tech@crothall.com", null), "contractor kept");

  const r = scrub_avante({
    notifications: [{ user_id: "Jane@AvanteHS.com" }, { user_id: "pat@hospital.org" }, { user_id: "desk@hospital.org" }],
    recipients: [
      { email_address: "pat@hospital.org", first_name: "Pat", last_name: "Smith" },
      { email_address: "desk@hospital.org", first_name: "Avante", last_name: "Desk" }
    ]
  });
  assert.deepStrictEqual(r.notifications.map((n) => n.user_id), ["pat@hospital.org"]);
  assert.deepStrictEqual(r.recipients.map((u) => u.email_address), ["pat@hospital.org"]);
  assert.strictEqual(r.dropped_addresses, 2);
}

// --- selection -----------------------------------------------------------------
{
  const rec = (system_id, summary) => ({ system_id, archetype: summary.archetype, summary });
  const results = [
    rec("SME00001", { archetype: "stable_healthy" }),
    rec("SME00002", { archetype: "pressure_rising" }),
    rec("SME00003", { archetype: "stable_healthy", sensor_suspect: true }),
    rec("SME00004", { archetype: "stable_healthy", offline_kind: "no_signal" }),
    rec("SME00005", { assessment_status: "limited_coverage" }),
    rec("SME00006", { archetype: "stable_healthy", quenched: true }),
    rec("SME00007", { archetype: "compressor_stop_recovered" })
  ];
  const failures = [{ system_id: "SME00008", message: "no GE monitor data for SME00008 in the requested period" }];
  const sel = select_page_systems(results, failures);
  assert.deepStrictEqual(
    sel.map((s) => s.system_id),
    ["SME00002", "SME00003", "SME00004", "SME00006", "SME00007", "SME00008"],
    "attention ∪ data issue ∪ failed, in result then failure order; healthy and limited excluded"
  );
  assert.strictEqual(sel[5].result, null);
  assert.ok(sel[5].message);
}

// --- zip chunking ------------------------------------------------------------------
{
  const p = (id, deflated) => ({ system_id: id, deflated });
  const parts = chunk_pages([p("a", 5), p("b", 5), p("c", 5), p("d", 20), p("e", 1)], 10);
  assert.deepStrictEqual(parts.map((x) => x.map((y) => y.system_id)), [["a", "b"], ["c"], ["d"], ["e"]]);
  assert.deepStrictEqual(chunk_pages([], 10), []);
}

// --- synthetic systems -------------------------------------------------------------
const identity = (system_id, manufacturer) => ({
  system_id,
  manufacturer,
  modality: "MR",
  model: "TEST 1.5T",
  cus_sys_id: "MRI-1",
  site_id: "C000001",
  site_name: "Test Hospital",
  city: "Springfield",
  state: "IL",
  customer_id: "C0001",
  customer_name: "Test Health",
  site_group_id: null,
  site_group_name: null
});
const model = (id, field_name_alias, operator, threshold, threshold_units, severity = "high") => ({
  id,
  field_name_alias,
  operator,
  threshold,
  threshold_units,
  threshold_offset: null,
  severity,
  enabled: true,
  customized: false,
  notify_frequency: 4,
  last_update: new Date(T0),
  last_updated_by: "someone@avantehs.com" // must never reach the page
});
const half_hours = (fn) => {
  const out = [];
  for (let t = T0; t < T1; t += SLOT_MS) {
    const v = fn(t);
    if (v !== undefined) out.push(v);
  }
  return out;
};

// Alert rows shared by every vendor fixture: a pressure detection run every
// half hour on day 2, one notification batch to a customer user, an Avante
// user and a contractor.
const alert_rows = (primary_alias, primary_threshold, units) => {
  const models = [
    model("00000000-0000-0000-0000-00000000000a", primary_alias, "greater_than", primary_threshold, units),
    model("00000000-0000-0000-0000-00000000000b", "He Level", "less_than", "60", "%", "medium"),
    model("00000000-0000-0000-0000-00000000000c", "MMB Unreachable", "offline", "12", "Hrs"),
    model("00000000-0000-0000-0000-00000000000d", "Compressor", "equals", "false", null)
  ];
  const detections = [];
  for (let t = T0 + 86400e3; t < T0 + 2 * 86400e3; t += SLOT_MS)
    detections.push({
      alert_model_id: models[0].id,
      field_name: "x",
      resolved_field_content: String(primary_threshold * 1.1),
      resolved_field_units: units,
      operator: "greater_than",
      threshold: String(primary_threshold),
      resolved_threshold_content: null,
      threshold_units: units,
      inserted_at: new Date(t + 4 * 60e3),
      capture_datetime: new Date(t)
    });
  const at = new Date(T0 + 86400e3 + 10 * 60e3);
  const notifications = ["pat@testhealth.org", "jane@avantehs.com", "tech@crothall.com"].map((user_id) => ({
    last_update: at,
    user_id,
    customer_id: "C0001",
    email_status: "SENT",
    sms_status: "DISABLED",
    detected_alert_models: [models[0].id],
    run_id: "11111111-1111-1111-1111-111111111111"
  }));
  const recipients = [
    { email_address: "pat@testhealth.org", first_name: "Pat", last_name: "Smith", status: "active", customer_ids: ["C0001"] },
    { email_address: "jane@avantehs.com", first_name: "Jane", last_name: "Doe", status: "active", customer_ids: ["C0001", "C0002"] },
    { email_address: "tech@crothall.com", first_name: "Tech", last_name: "Contractor", status: "active", customer_ids: ["C0001", "C0002"] }
  ];
  return { models, detections, notifications, recipients };
};

const fixture = (system_id, vendor) => {
  const v = {
    GE: { manufacturer: "GE", alias: "He Pressure", thr: 5.2, units: "PSI", primary: "He pressure", p: (t) => 4 + Math.sin(t / H) * 0.2, he: "%", hev: 72, dec: { pressure: 3, helium: 2 } },
    PHILIPS: { manufacturer: "Philips", alias: "He Pressure", thr: 100, units: "mBar", primary: "He pressure", p: (t) => 60 + Math.sin(t / H) * 3, he: "%", hev: 80, dec: { pressure: 0, helium: 1 } },
    SIEMENS_NON_TIM: { manufacturer: "Siemens", alias: "Shield Temp", thr: 100, units: "K", primary: "Shield temp", p: (t) => 48 + Math.sin(t / H), he: "%", hev: 90, dec: { pressure: 1, helium: 1 } }
  }[vendor];
  const rows = alert_rows(v.alias, v.thr, v.units);
  const data = { identity: identity(system_id, v.manufacturer), meta: { serial_number: "S1", process_mag: true, process_edu: true }, ...rows };
  const readings = {
    vendor_key: vendor,
    primary_name: v.primary,
    units: { pressure: vendor === "PHILIPS" ? "mbar" : v.units, helium: v.he },
    decimals: v.dec,
    sources: { mag: `mag.test_${vendor.toLowerCase()}`, edu: "edu.v3" },
    compressor_source: "edu_comp_vib",
    // A 6-hour gap on day 3 (no readings at all) and a compressor stop on day 2.
    pressure: half_hours((t) => (t >= T0 + 2 * 86400e3 && t < T0 + 2 * 86400e3 + 6 * H ? undefined : { t, v: v.p(t) })),
    helium: half_hours((t) => (t >= T0 + 2 * 86400e3 && t < T0 + 2 * 86400e3 + 6 * H ? undefined : { t, v: v.hev })),
    compressor: half_hours((t) => ({ t, on: !(t >= T0 + 30 * H && t < T0 + 36 * H) }))
  };
  return { data, readings };
};

const render = ({ data, readings }, notice = null) => {
  const scrubbed = scrub_avante(data);
  const a = analyze_activity({ ...data, ...scrubbed }, readings, { from: T0, to: T1 });
  const html = build_system_page(a, { identity: data.identity, meta: data.meta, model_count: data.models.length, period_label: "6 months", notice });
  return { a, html };
};

// Strings that must never appear on a customer page (outside branding).
const AVANTE_USER = /[\w.+-]*avante[\w.+-]*@|@[\w.-]*avante|\bJane\b|someone@/i;
const BANNED_SECTIONS = ["Hypothesis", "What the data shows", "Steps for improvement", "Re-create this timeline", "Expected, not detected", "Start where the compressor stopped"];

const pages = [];
for (const [id, vendor] of [["SME10001", "GE"], ["SME10002", "PHILIPS"], ["SME10003", "SIEMENS_NON_TIM"]]) {
  const f = fixture(id, vendor);
  const { a, html } = render(f);
  // facts
  assert.strictEqual(a.slots.length, DAYS * 48, `${vendor}: one slot per half hour`);
  assert.strictEqual(a.counts.detections, 48, `${vendor}: every detection placed`);
  assert.strictEqual(a.counts.recipients, 2, `${vendor}: Avante recipient scrubbed, customer + contractor kept`);
  assert.ok(!Object.keys(a.users).some((u) => /avante/i.test(u)), `${vendor}: no Avante user key`);
  assert.deepStrictEqual(a.org_order, ["Test Health", "Other recipients"]);
  assert.strictEqual(a.orgs["pat@testhealth.org"], "Test Health");
  assert.strictEqual(a.orgs["tech@crothall.com"], "Test Health", "contractor whose access names the customer groups with it");
  assert.strictEqual(a.slots.filter((s) => s.mag).length, DAYS * 48 - 12, `${vendor}: the 6-hour gap is 12 empty slots`);
  assert.strictEqual(a.slots.filter((s) => s.comp === false).length, 12, `${vendor}: 6-hour compressor stop`);
  assert.ok(
    a.models.some((m) => m.kind === "pressure" && m.value === Number(f.data.models[0].threshold)),
    `${vendor}: the primary model's threshold is on the primary chart`
  );
  // markup
  assert.ok(!AVANTE_USER.test(html), `${vendor}: an Avante user or address leaked onto the page`);
  for (const b of BANNED_SECTIONS.filter((x) => x !== "Expected, not detected" && x !== "Start where the compressor stopped"))
    assert.ok(!html.includes(b), `${vendor}: "${b}" must not be on the page`);
  assert.ok(html.includes(`${id} System Activity`), `${vendor}: title`);
  assert.ok(!html.includes("Anomaly Report"), `${vendor}: not branded as an Anomaly Report`);
  const payload = JSON.parse(html.match(/<script type="application\/json" id="timeline-data">([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, "<"));
  assert.strictEqual(payload.show_missed, false);
  assert.strictEqual(payload.shade, null);
  assert.strictEqual(payload.jump, null);
  assert.deepStrictEqual(payload.evidence, []);
  assert.strictEqual(payload.labels.primary, f.readings.primary_name);
  // determinism
  assert.strictEqual(render(f).html, html, `${vendor}: identical input must give byte-identical output`);
  pages.push({ id, vendor, html, primary: f.readings.primary_name });
}

// A failed system: alerts only, a plain notice, no readings.
{
  const f = fixture("SME10004", "GE");
  const notice = "This system could not be analyzed for this period (no monitor data received in the requested period), so no readings are shown. Its alert detections and notifications are below.";
  const { a, html } = render({ data: f.data, readings: null }, notice);
  assert.strictEqual(a.analyzed, false);
  assert.strictEqual(a.slots.filter((s) => s.mag || s.comp !== null).length, 0, "no readings on a failed system");
  assert.strictEqual(a.counts.detections, 48, "its detections still shown");
  assert.ok(html.includes("could not be analyzed"), "the notice is on the page");
  assert.ok(!AVANTE_USER.test(html));
  pages.push({ id: "SME10004", vendor: "failed", html, primary: "He pressure" });
}

assert.strictEqual(system_page_name("SME10001", T1, "-6mo"), "Avante-SME10001-Activity-6mo-2026-10-03.html");

// --- every page loads in Chromium with zero page errors --------------------------
(async () => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-system-pages-"));
  try {
    for (const p of pages) {
      const file = path.join(dir, `${p.id}.html`);
      fs.writeFileSync(file, p.html);
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(`file://${file}`, { waitUntil: "load" });
      // Exercise the controls: expand every day, pick a slot, flip zone + clock.
      await page.click("#toggleDays");
      await page.click("#rows tr.run");
      await page.click('.seg button[data-tz="UTC"]');
      await page.click('.seg button[data-clock="12"]');
      const text = await page.evaluate(() => document.body.innerText);
      assert.deepStrictEqual(errors, [], `${p.id} (${p.vendor}): page errors`);
      assert.ok(!AVANTE_USER.test(text), `${p.id}: Avante user in rendered text`);
      for (const b of BANNED_SECTIONS) assert.ok(!text.includes(b), `${p.id}: "${b}" rendered`);
      assert.ok(text.includes(p.primary), `${p.id}: primary metric label "${p.primary}" rendered`);
      const lanes = await page.$$eval("#lanes svg", (s) => s.length);
      assert.strictEqual(lanes, 1, `${p.id}: timeline drawn`);
      await page.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`check_system_pages: all assertions passed (${pages.length} pages)`);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
