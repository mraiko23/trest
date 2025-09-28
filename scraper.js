const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (e) { /* optional */ }

// Reuse a single browser instance to avoid repeated process listeners and reduce overhead
let browserInstance = null;
async function getBrowser() {
  if (!puppeteer) return null;
  if (browserInstance) return browserInstance;

  // helper: try to find a local Chrome/Chromium binary from env or common paths
  const findInstalledChrome = () => {
    const candidates = [];
    if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
    if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
    if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);

    const platform = os.platform();
    if (platform === 'win32') {
      const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
      const programFilesx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(programFilesx86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'));
    } else if (platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else {
      // linux / other unix-like
      candidates.push('/usr/bin/google-chrome-stable');
      candidates.push('/usr/bin/google-chrome');
      candidates.push('/usr/bin/chromium-browser');
      candidates.push('/usr/bin/chromium');
      candidates.push('/snap/bin/chromium');
    }

    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
  };

  const launchArgs = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], headless: 'new' };

  try {
    browserInstance = await puppeteer.launch(launchArgs);
  } catch (err) {
    // common case on some hosts: bundled Chromium not downloaded/available
    const msg = err && err.message ? String(err.message) : '';
    if (msg.includes('Could not find Chromium') || msg.includes('Cannot find module') || msg.includes('ENOTFOUND') || msg.includes('failed')) {
      const exe = findInstalledChrome();
      if (exe) {
        try {
          // attempt to launch using system Chrome/Chromium
          browserInstance = await puppeteer.launch(Object.assign({}, launchArgs, { executablePath: exe }));
          try { console.log('puppeteer: launched system Chrome at', exe); } catch (e) {}
        } catch (err2) {
          try { console.error('puppeteer system chrome launch failed', err2 && err2.message); } catch (e) {}
          browserInstance = null;
        }
      } else {
        try { console.error('puppeteer fallback: no Chromium/Chrome binary found in common locations'); } catch (e) {}
        browserInstance = null;
      }
    } else {
      // unknown error — rethrow so caller can log
      throw err;
    }
  }

  // increase EventEmitter default max listeners to avoid warnings from puppeteer internals
  try { require('events').EventEmitter.defaultMaxListeners = 50; } catch (e) {}
  // install process exit handlers once to close the browser cleanly
  if (!global.__pvbr_browser_handlers_installed) {
    const closeBrowser = async () => {
      try { if (browserInstance) await browserInstance.close(); } catch (e) {}
      browserInstance = null;
    };
    process.once('exit', closeBrowser);
    process.once('SIGINT', async () => { await closeBrowser(); process.exit(); });
    process.once('SIGTERM', async () => { await closeBrowser(); process.exit(); });
    global.__pvbr_browser_handlers_installed = true;
  }
  return browserInstance;
}

const SOURCE_URL = 'https://plantsvsbrainrotsstocktracker.com/';

let lastEtag = null;
let lastHtmlHash = null;

function hashString(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

// fetchStock(options) -> returns null if nothing changed (304 or identical content),
// otherwise returns { seeds: [], gear: [], rawHtml }.
async function fetchStock(options = { force: false }) {
  const headers = {};
  if (lastEtag && !options.force) headers['If-None-Match'] = lastEtag;

  const res = await fetch(SOURCE_URL, { headers, timeout: 15000 });

  if (res.status === 304 && !options.force) {
    return null; // not modified
  }

  if (!res.ok) throw new Error('fetch failed ' + res.status);

  const html = await res.text();
  const etag = res.headers.get('etag');
  const h = hashString(html);
  if (!options.force) {
    // If server indicates content unchanged we usually skip work —
    // but if the page renders stock client-side we still want to
    // attempt a rendered (puppeteer) fetch when available.
    const etagUnchanged = etag && lastEtag && etag === lastEtag;
    const hashUnchanged = !etag && lastHtmlHash && h === lastHtmlHash;
    if (etagUnchanged || hashUnchanged) {
      if (!puppeteer) {
        return null;
      }
      // otherwise fall through and let the puppeteer fallback run
      // (we won't re-parse the unchanged server HTML again)
    }
  }

  // update caches
  if (etag) lastEtag = etag;
  lastHtmlHash = h;

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const seeds = [];
  const gear = [];

  // Preferred parsing: look for the specific containers `#seedsList` and `#gearList`
  try {
    const seedsContainer = doc.querySelector('#seedsList');
    if (seedsContainer) {
      const tiles = Array.from(seedsContainer.querySelectorAll('.item-tile'));
      tiles.forEach(tile => {
        const imgEl = tile.querySelector('.item-image');
        let img = imgEl ? imgEl.getAttribute('src') : null;
        if (img && img.startsWith('/')) img = SOURCE_URL.replace(/\/$/, '') + img;
        const name = tile.querySelector('.item-name') ? tile.querySelector('.item-name').textContent.trim() : null;
        const rarityEl = tile.querySelector('.item-rarity');
        const rarity = rarityEl ? rarityEl.textContent.trim() : (rarityEl ? rarityEl.className : null);
        const stock = tile.querySelector('.item-stock') ? tile.querySelector('.item-stock').textContent.trim() : null;
        const priceUsdEl = tile.querySelector('.price-usd');
        const priceUsd = priceUsdEl ? priceUsdEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
        const priceRobuxEl = tile.querySelector('.price-robux');
        let priceRobux = null;
        if (priceRobuxEl) {
          // remove any child img alt text and trim number
          priceRobux = priceRobuxEl.textContent.replace(/\u00a0/g, ' ').trim();
        }
        seeds.push({ name, rarity, stock, priceUsd, priceRobux, image: img });
      });
    }
  } catch (e) {
    // continue to other parsing methods on error
    // eslint-disable-next-line no-console
    console.error('seeds parsing error', e && e.message);
  }

  try {
    const gearContainer = doc.querySelector('#gearList');
    if (gearContainer) {
      const tiles = Array.from(gearContainer.querySelectorAll('.item-tile'));
      tiles.forEach(tile => {
        const imgEl = tile.querySelector('.item-image');
        let img = imgEl ? imgEl.getAttribute('src') : null;
        if (img && img.startsWith('/')) img = SOURCE_URL.replace(/\/$/, '') + img;
        const name = tile.querySelector('.item-name') ? tile.querySelector('.item-name').textContent.trim() : null;
        const rarityEl = tile.querySelector('.item-rarity');
        const rarity = rarityEl ? rarityEl.textContent.trim() : (rarityEl ? rarityEl.className : null);
        const stock = tile.querySelector('.item-stock') ? tile.querySelector('.item-stock').textContent.trim() : null;
        const priceUsdEl = tile.querySelector('.price-usd');
        const priceUsd = priceUsdEl ? priceUsdEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
        const priceRobuxEl = tile.querySelector('.price-robux');
        let priceRobux = null;
        if (priceRobuxEl) priceRobux = priceRobuxEl.textContent.replace(/\u00a0/g, ' ').trim();
        gear.push({ name, rarity, stock, priceUsd, priceRobux, image: img });
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('gear parsing error', e && e.message);
  }

  // log what we found from server HTML
  try { console.log(`parser: found ${seeds.length} seeds and ${gear.length} gear in server HTML`); } catch (e) {}

  // will hold rendered HTML if puppeteer runs
  let renderedHtml = null;
  let usedPuppeteer = false;

  // If structured parsing failed and puppeteer is available, render the page and extract
  if ((seeds.length === 0 || gear.length === 0) && puppeteer) {
    try {
      const browser = await getBrowser();
      if (!browser) throw new Error('puppeteer not available');
      const page = await browser.newPage();
      // set a common UA to avoid headless detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1200, height: 900 });
      // capture page console for debugging (per-page only)
      const onConsole = msg => { try { console.log('page.console>', msg.text()); } catch (e) {} };
      page.on('console', onConsole);
      // capture page errors to help diagnose timeouts
      page.on('pageerror', err => { try { console.log('page.error>', err && err.message); } catch (e) {} });
      page.on('requestfailed', req => { try { console.log('page.requestfailed>', req.url(), req.failure && req.failure().errorText); } catch (e) {} });

      // increase navigation timeout and be more robust when waiting for client-rendered content
      try { console.log('puppeteer: navigating to', SOURCE_URL); } catch (e) {}
      await page.goto(SOURCE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

      // wait for item tiles (more specific and longer timeout). If not found quickly, retry once.
      let waited = false;
      try {
        await page.waitForSelector('#seedsList .item-tile, #gearList .item-tile', { timeout: 20000 });
        waited = true;
      } catch (e) {
        try { console.log('puppeteer: initial waitForSelector timed out, giving extra time'); } catch (er) {}
        // short extra pause and a secondary wait
        await page.waitForTimeout(3000);
        try {
          await page.waitForSelector('#seedsList .item-tile, #gearList .item-tile', { timeout: 15000 });
          waited = true;
        } catch (e2) {
          try { console.log('puppeteer: secondary waitForSelector also timed out'); } catch (er) {}
        }
      }

      if (seeds.length === 0) {
        const seedData = await page.$$eval('#seedsList .item-tile', tiles => tiles.map(t => {
          const imgEl = t.querySelector('.item-image');
          const img = imgEl ? imgEl.getAttribute('src') : null;
          const name = t.querySelector('.item-name') ? t.querySelector('.item-name').textContent.trim() : null;
          const rarity = t.querySelector('.item-rarity') ? t.querySelector('.item-rarity').textContent.trim() : null;
          const stock = t.querySelector('.item-stock') ? t.querySelector('.item-stock').textContent.trim() : null;
          const priceUsdEl = t.querySelector('.price-usd');
          const priceUsd = priceUsdEl ? priceUsdEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
          const priceRobuxEl = t.querySelector('.price-robux');
          const priceRobux = priceRobuxEl ? priceRobuxEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
          return { name, rarity, stock, priceUsd, priceRobux, image: img };
        }));
        if (seedData && seedData.length) {
          seedData.forEach(s => { if (s.image) s.image = new URL(s.image, SOURCE_URL).href; });
          seeds.splice(0, seeds.length, ...seedData);
          try { console.log(`puppeteer: seedData length ${seedData.length}`); } catch (e) {}
          usedPuppeteer = true;
        }
      }

      if (gear.length === 0) {
        const gearData = await page.$$eval('#gearList .item-tile', tiles => tiles.map(t => {
          const imgEl = t.querySelector('.item-image');
          const img = imgEl ? imgEl.getAttribute('src') : null;
          const name = t.querySelector('.item-name') ? t.querySelector('.item-name').textContent.trim() : null;
          const rarity = t.querySelector('.item-rarity') ? t.querySelector('.item-rarity').textContent.trim() : null;
          const stock = t.querySelector('.item-stock') ? t.querySelector('.item-stock').textContent.trim() : null;
          const priceUsdEl = t.querySelector('.price-usd');
          const priceUsd = priceUsdEl ? priceUsdEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
          const priceRobuxEl = t.querySelector('.price-robux');
          const priceRobux = priceRobuxEl ? priceRobuxEl.textContent.replace(/\u00a0/g, ' ').trim() : null;
          return { name, rarity, stock, priceUsd, priceRobux, image: img };
        }));
        if (gearData && gearData.length) {
          gearData.forEach(g => { if (g.image) g.image = new URL(g.image, SOURCE_URL).href; });
          gear.splice(0, gear.length, ...gearData);
          try { console.log(`puppeteer: gearData length ${gearData.length}`); } catch (e) {}
          usedPuppeteer = true;
        }
      }

      try { renderedHtml = await page.content(); } catch (e) { renderedHtml = null; }
      try { await page.removeListener && page.removeListener('console', onConsole); } catch (e) {}
      try { await page.close(); } catch (e) {}
    } catch (e) {
      console.error('puppeteer fallback failed', e && e.message);
    }
  }

  // Fallback: try to extract lines mentioning known items if still empty
  if (!seeds.length) {
    const seedMatches = html.match(/Mr Carrot|Cocotank|\bseed\b[\w\s\-,:]{0,50}/gi);
    if (seedMatches) seedMatches.forEach(s => seeds.push(s.trim()));
  }
  if (!gear.length) {
    const gearMatches = html.match(/gear[\w\s\-,:]{0,50}/gi);
    if (gearMatches) gearMatches.forEach(g => gear.push(g.trim()));
  }

  return { seeds, gear, rawHtml: html, renderedHtml, usedPuppeteer };
}

module.exports = { fetchStock };

