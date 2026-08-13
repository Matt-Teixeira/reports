// Screenshot each .page of a rendered summary/brief HTML at print geometry.
// Usage: node sme_reports/dev/shoot.js <in.html> <out-prefix> [pageNums...]
// Viewport 816x1056 = 8.5x11in at 96dpi. Scratch tool; not part of the gate.
const path = require("path");
const puppeteer = require("puppeteer");

(async () => {
  const [, , src, prefix, ...want] = process.argv;
  if (!src || !prefix) {
    console.error("usage: shoot.js <in.html> <out-prefix> [pageNums...]");
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 2 });
  await page.goto("file://" + path.resolve(src), { waitUntil: "networkidle0" });

  const count = await page.$$eval(".page", (els) => els.length);
  const nums = want.length ? want.map(Number) : Array.from({ length: count }, (_, i) => i + 1);
  for (const n of nums) {
    if (n < 1 || n > count) continue;
    const el = (await page.$$(".page"))[n - 1];
    const out = `${prefix}-p${String(n).padStart(2, "0")}.png`;
    await el.screenshot({ path: out });
    console.log(out);
  }
  console.log(`pages: ${count}`);
  await browser.close();
})();
