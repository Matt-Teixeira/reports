const fs = require("fs");
const path = require("path");

// Renders brief HTML to PDF with headless Chromium. The browser instance is
// shared across a run — launching Chromium costs ~4-6 s, which dominated
// large batches when every PDF launched its own. The orchestrator MUST call
// close_pdf_renderer() when done (in finally) or the process will not exit.
//
// puppeteer is pinned to 21.x — the server runs Node 16 and puppeteer 22+
// requires Node >= 18. If Chromium can't be bundled on a host, set
// PUPPETEER_EXECUTABLE_PATH to a system Chrome and it will be used instead.

let browser_promise = null;

const launch_browser = () => {
  const puppeteer = require("puppeteer");
  return puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // Cloud VMs typically run this as an unprivileged user without user
    // namespaces, where Chromium's sandbox cannot start.
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
};

const get_browser = () => {
  if (!browser_promise) browser_promise = launch_browser();
  return browser_promise;
};

const render_page = async (browser, html, pdf_path, extra_options = {}) => {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdf_path,
      printBackground: true,
      preferCSSPageSize: true, // honors @page { size: letter; margin: 0 }
      ...extra_options
    });
  } finally {
    await page.close().catch(() => {});
  }
};

const render_to = async (pdf_path, html, extra_options) => {
  try {
    await render_page(await get_browser(), html, pdf_path, extra_options);
  } catch (error) {
    // A crashed/dead browser poisons the shared instance — relaunch once.
    browser_promise = null;
    await render_page(await get_browser(), html, pdf_path, extra_options);
  }
  return pdf_path;
};

const render_pdf = async (out_dir, system_id, html) => {
  fs.mkdirSync(out_dir, { recursive: true });
  const pdf_path = path.join(out_dir, `Avante-${system_id}-Magnet-Health.pdf`);
  // .page is a fixed 11in with overflow hidden; belt and suspenders.
  return render_to(pdf_path, html, { pageRanges: "1" });
};

// Multi-page sibling for aggregate documents (the fleet summary). Takes a
// full filename and, crucially, omits pageRanges so every sheet survives.
// Lives here rather than in its own module so it shares browser_promise —
// a second puppeteer.launch() would not be closed by close_pdf_renderer()
// and the process would never exit.
const render_pdf_document = async (out_dir, filename, html) => {
  fs.mkdirSync(out_dir, { recursive: true });
  return render_to(path.join(out_dir, filename), html, {});
};

const close_pdf_renderer = async () => {
  if (!browser_promise) return;
  const pending = browser_promise;
  browser_promise = null;
  const browser = await pending.catch(() => null);
  if (browser) await browser.close().catch(() => {});
};

module.exports = { render_pdf, render_pdf_document, close_pdf_renderer };
