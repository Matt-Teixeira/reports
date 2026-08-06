const fs = require("fs");
const path = require("path");

// Renders the one-page brief HTML to PDF with headless Chromium.
// puppeteer is pinned to 21.x — the server runs Node 16 and puppeteer 22+
// requires Node >= 18. If Chromium can't be bundled on a host, set
// PUPPETEER_EXECUTABLE_PATH to a system Chrome and it will be used instead.

const render_pdf = async (out_dir, system_id, html) => {
  const puppeteer = require("puppeteer");
  fs.mkdirSync(out_dir, { recursive: true });
  const pdf_path = path.join(out_dir, `Avante-${system_id}-Magnet-Health.pdf`);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // Cloud VMs typically run this as an unprivileged user without user
    // namespaces, where Chromium's sandbox cannot start.
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdf_path,
      printBackground: true,
      preferCSSPageSize: true, // honors @page { size: letter; margin: 0 }
      pageRanges: "1" // .page is a fixed 11in with overflow hidden; belt and suspenders
    });
  } finally {
    await browser.close();
  }
  return pdf_path;
};

module.exports = render_pdf;
