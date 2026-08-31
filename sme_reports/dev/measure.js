// Report per-page fill and per-column ellipsis for a rendered summary HTML.
// Usage: node sme_reports/dev/measure.js <file.html> [...]
// Read-only diagnostic; mirrors check_fleet.js's geometry pass.
const path = require("path");
const puppeteer = require("puppeteer");

(async () => {
  const files = process.argv.slice(2);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 816, height: 1056 });
  for (const f of files) {
    await page.goto("file://" + path.resolve(f), { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const FOOTER_PX = 0.38 * 96;
      const clipped = {};
      const pages = [...document.querySelectorAll(".page")].map((pg, i) => {
        const top = pg.getBoundingClientRect().top;
        let usable = pg.clientHeight - FOOTER_PX;
        const pin = pg.querySelector(".pin");
        if (pin) usable = Math.min(usable, pin.getBoundingClientRect().top - top);
        let lowest = 0;
        let rows = 0;
        for (const el of pg.querySelectorAll("tbody tr, h1, h2, table, .roll, .note, .lead")) {
          lowest = Math.max(lowest, el.getBoundingClientRect().bottom - top);
          if (el.tagName === "TR") rows += 1;
        }
        pg.querySelectorAll("table").forEach((t) => {
          const keys = [...(t.querySelectorAll("thead tr")[0]?.children || [])].map((th) =>
            th.textContent.trim()
          );
          t.querySelectorAll("tbody td").forEach((td) => {
            const st = getComputedStyle(td);
            const pad = parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
            const r = document.createRange();
            r.selectNodeContents(td);
            const w = r.getBoundingClientRect().width;
            r.detach();
            if (w <= td.clientWidth - pad + 1) return;
            const k = keys[[...td.parentNode.children].indexOf(td)] || "?";
            clipped[k] = (clipped[k] || 0) + 1;
          });
        });
        const row_h = pg.querySelector("tbody tr")
          ? pg.querySelector("tbody tr").getBoundingClientRect().height
          : null;
        return {
          p: i + 1,
          rows,
          fill: +(lowest / usable).toFixed(3),
          slack_px: Math.round(usable - lowest),
          row_h: row_h && +row_h.toFixed(1)
        };
      });
      return { pages, clipped };
    });
    console.log(`\n=== ${path.basename(f)} ===`);
    for (const p of m.pages)
      console.log(
        `  p${String(p.p).padStart(2)}  rows ${String(p.rows).padStart(2)}  fill ${(p.fill * 100).toFixed(0)}%  slack ${String(p.slack_px).padStart(4)}px  rowh ${p.row_h}`
      );
    console.log("  ellipsised cells by column:", JSON.stringify(m.clipped));
  }
  await browser.close();
})();
