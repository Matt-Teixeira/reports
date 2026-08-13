// Per-column: allotted width vs the widest text actually rendered in it.
// Tells you which columns have slack to give and which are at their limit.
// Usage: node sme_reports/dev/colbudget.js <file.html>
const path = require("path");
const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 816, height: 1056 });
  for (const f of process.argv.slice(2)) {
    await page.goto("file://" + path.resolve(f), { waitUntil: "networkidle0" });
    const out = await page.evaluate(() => {
      const tables = {};
      document.querySelectorAll("table.vendor").forEach((t) => {
        const keys = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
        const sig = keys.join("|");
        tables[sig] = tables[sig] || keys.map((k) => ({ col: k, avail: 0, need: 0, over: 0 }));
        const acc = tables[sig];
        // Whole-cell Range, the same unit check_fleet.js asserts against: it
        // returns the union rect, i.e. the widest line of a two-line site
        // cell and the FULL line of an inline multi-span cell. Headers count
        // too — a clipped column title misnames every number beneath it.
        const measure = (el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const w = r.getBoundingClientRect().width;
          r.detach();
          return w;
        };
        t.querySelectorAll("thead tr, tbody tr").forEach((tr) => {
          [...tr.children].forEach((td, i) => {
            if (!acc[i]) return;
            const st = getComputedStyle(td);
            const pad = parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
            const avail = td.clientWidth - pad;
            const need = measure(td);
            acc[i].avail = Math.round(avail);
            acc[i].need = Math.max(acc[i].need, Math.round(need));
            if (need > avail + 1) acc[i].over += 1;
          });
        });
      });
      return tables;
    });
    console.log(`\n=== ${path.basename(f)} ===`);
    for (const [sig, cols] of Object.entries(out)) {
      console.log(`  table: ${sig}`);
      for (const c of cols)
        console.log(
          `    ${c.col.padEnd(14)} avail ${String(c.avail).padStart(4)}px  widest ${String(c.need).padStart(4)}px  ${c.need > c.avail ? `OVER by ${c.need - c.avail}px (${c.over} cells)` : `slack ${c.avail - c.need}px`}`
        );
    }
  }
  await browser.close();
})();
