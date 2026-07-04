// InputStash perf + functional harness.
// Usage: node bench.mjs <extensionDir> <mode: baseline|fixed>
// - Launch #1: seed a large legacy v1 blob into chrome.storage.local, quit.
// - Launch #2: type into tab A, measure main-thread blocking in tab B,
//   then (fixed mode) run functional assertions: migration, captures,
//   shadow DOM, contenteditable, password exclusion, settings push, popup UI.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = fileURLToPath(new URL('./browsers/chrome/mac_arm-150.0.7871.46/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', import.meta.url));
const [, , EXT_DIR, MODE = 'fixed'] = process.argv;
if (!EXT_DIR) { console.error('usage: node bench.mjs <extensionDir> <mode>'); process.exit(1); }

const PORT = 18093;
const LEGACY_KEY = 'inputstash:domains:v1';
const INDEX_KEY = 'inputstash:index:v2';
const DOMAIN_PREFIX = 'inputstash:domain:v2:';
const SEED_DOMAINS = 400, SEED_FIELDS = 3, SEED_RECORDS = 10, SEED_CHARS = 400;

const TYPE_HTML = `<!doctype html><meta charset="utf-8"><title>type page</title>
<textarea id="ta" rows="6" cols="60" aria-label="Main note"></textarea>
<div id="ce" contenteditable="true" style="border:1px solid #888;min-height:40px;width:400px">e</div>
<input id="pw" type="password" placeholder="secret">
<select id="sel" aria-label="Pick one"><option value="">--</option><option value="alpha">alpha</option><option value="beta">beta</option></select>
<div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({mode:'open'});
  root.innerHTML = '<div id="inner"></div><input id="shadow-input" placeholder="shadow field">';
  const nested = root.getElementById('inner').attachShadow({mode:'open'});
  nested.innerHTML = '<input id="nested-input" placeholder="nested shadow">';
  window.__shadowInput = () => root.getElementById('shadow-input');
  window.__nestedInput = () => nested.getElementById('nested-input');
</script>`;

const PROBE_HTML = `<!doctype html><meta charset="utf-8"><title>probe page</title>
<input id="probe-input" placeholder="probe">
<script>
  window.__stats = { blockedMs: 0, maxGapMs: 0, longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0 };
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const drift = now - last - 25;
    if (drift > 10) { __stats.blockedMs += drift; __stats.maxGapMs = Math.max(__stats.maxGapMs, drift); }
    last = now;
  }, 25);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        __stats.longTasks++; __stats.longTaskMs += e.duration;
        __stats.maxLongTaskMs = Math.max(__stats.maxLongTaskMs, e.duration);
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
</script>`;

function serve() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url.startsWith('/probe') ? PROBE_HTML : TYPE_HTML);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function launch(userDataDir) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--window-size=900,700', '--window-position=2000,2000',
    ],
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 20000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  return { browser, sw, extId };
}

async function seed(sw) {
  await sw.evaluate(async (key, nDomains, nFields, nRecords, nChars) => {
    const state = { domains: {} };
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(8);
    for (let d = 0; d < nDomains; d++) {
      const domain = `site${d}.example`;
      const fields = {};
      for (let f = 0; f < nFields; f++) {
        const fieldKey = `id:field-${f}`;
        const records = [];
        for (let r = 0; r < nRecords; r++) {
          records.push({
            id: `${d}-${f}-${r}`, value: filler.slice(0, nChars) + ` d${d}f${f}r${r}`,
            createdAt: 1700000000000 + r, updatedAt: 1700000000000 + r,
            reason: 'blur', sessionId: `s${d}-${f}-${r}`, draft: false, truncated: false,
            pageUrl: `https://${domain}/page`, pageTitle: `Page ${d}`, isFrame: false,
          });
        }
        fields[fieldKey] = {
          fieldKey, elementId: `field-${f}`, label: `Field ${f}`, inputType: 'text',
          lastUpdated: 1700000000000, pageUrl: `https://${domain}/page`, pageTitle: `Page ${d}`, records,
        };
      }
      state.domains[domain] = { domain, lastUpdated: 1700000000000 + d, iframeDomains: [], parentDomains: [], fields };
    }
    await chrome.storage.local.set({ [key]: state });
    return Object.keys(state.domains).length;
  }, LEGACY_KEY, SEED_DOMAINS, SEED_FIELDS, SEED_RECORDS, SEED_CHARS);
  const size = await sw.evaluate(async (key) => {
    const raw = await chrome.storage.local.get(key);
    return JSON.stringify(raw[key]).length;
  }, LEGACY_KEY);
  console.log(`seeded legacy blob: ${SEED_DOMAINS} domains, ~${(size / 1024 / 1024).toFixed(1)} MB`);
}

async function typeBursts(page, selectorFocus, cycles) {
  await selectorFocus();
  for (let i = 0; i < cycles; i++) {
    await page.keyboard.type(`word${i} some text `, { delay: 30 });
    await new Promise((r) => setTimeout(r, 460));
  }
}

async function main() {
  const server = await serve();
  const userDataDir = mkdtempSync(join(tmpdir(), `inputstash-${MODE}-`));
  console.log(`\n=== ${MODE} @ ${EXT_DIR}`);

  // Launch #1: seed legacy blob, then restart so (fixed) migration runs at startup.
  {
    const { browser, sw } = await launch(userDataDir);
    await seed(sw);
    await browser.close();
  }

  // Launch #2: measure typing impact with a second tab open.
  const { browser, sw, extId } = await launch(userDataDir);
  const typePage = await browser.newPage();
  await typePage.goto(`http://127.0.0.1:${PORT}/type`, { waitUntil: 'load' });
  const probePage = await browser.newPage();
  await probePage.goto(`http://127.0.0.1:${PORT}/probe`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2500)); // let migration/startup settle before measuring
  await probePage.evaluate(() => { __stats.blockedMs = 0; __stats.maxGapMs = 0; __stats.longTasks = 0; __stats.longTaskMs = 0; __stats.maxLongTaskMs = 0; });

  await typePage.bringToFront();
  const t0 = Date.now();
  await typeBursts(typePage, () => typePage.click('#ta'), 25);
  const typingWallMs = Date.now() - t0;

  const probeStats = await probePage.evaluate(() => window.__stats);
  console.log(`typing wall: ${typingWallMs} ms over 25 capture cycles`);
  console.log(`OTHER-TAB main-thread: blocked=${probeStats.blockedMs.toFixed(0)}ms maxGap=${probeStats.maxGapMs.toFixed(0)}ms longTasks=${probeStats.longTasks} (${probeStats.longTaskMs.toFixed(0)}ms total, max ${probeStats.maxLongTaskMs.toFixed(0)}ms)`);

  const RESULT = { mode: MODE, typingWallMs, probeStats };

  if (MODE === 'fixed') {
    const checks = [];
    const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

    // ---- migration
    const keyInfo = await sw.evaluate(async (legacyKey, indexKey, prefix) => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all);
      const index = all[indexKey];
      return {
        hasLegacy: keys.includes(legacyKey),
        domainKeys: keys.filter((k) => k.startsWith(prefix)).length,
        indexCount: index ? Object.keys(index.domains).length : 0,
        sampleOk: !!all[`${prefix}site37.example`]?.fields?.['id:field-1']?.records?.length,
        sampleRecords: all[`${prefix}site37.example`]?.fields?.['id:field-1']?.records?.length ?? 0,
      };
    }, LEGACY_KEY, INDEX_KEY, DOMAIN_PREFIX);
    check('migration removed legacy blob', !keyInfo.hasLegacy);
    check('migration created per-domain keys', keyInfo.domainKeys >= SEED_DOMAINS, `${keyInfo.domainKeys} keys`);
    check('index has all migrated domains', keyInfo.indexCount >= SEED_DOMAINS, `${keyInfo.indexCount} entries`);
    check('migrated records intact (site37/field-1)', keyInfo.sampleOk && keyInfo.sampleRecords === SEED_RECORDS, `${keyInfo.sampleRecords} records`);

    // ---- textarea capture (typed above) coalesced into one record
    const localhost = await sw.evaluate(async (prefix) => (await chrome.storage.local.get(`${prefix}127.0.0.1`))[`${prefix}127.0.0.1`], DOMAIN_PREFIX);
    const taField = localhost && Object.values(localhost.fields).find((f) => f.fieldKey === 'id:ta');
    check('textarea capture stored', !!taField, taField ? `${taField.records.length} record(s)` : 'missing');
    check('typing coalesced into one record', taField?.records.length === 1);
    check('captured value matches typed text', !!taField?.records[0]?.value.startsWith('word0 some text word1'));

    // ---- shadow DOM (event-driven discovery), nested shadow, contenteditable, select, password
    const sh = await typePage.evaluateHandle(() => window.__shadowInput());
    await sh.click();
    await typePage.keyboard.type('hello from shadow', { delay: 20 });
    const ns = await typePage.evaluateHandle(() => window.__nestedInput());
    await ns.click();
    await typePage.keyboard.type('nested shadow text', { delay: 20 });
    await typePage.click('#ce');
    await typePage.keyboard.type(' plus contenteditable', { delay: 20 });
    await typePage.click('#pw');
    await typePage.keyboard.type('SuperSecret123', { delay: 20 });
    await typePage.select('#sel', 'beta');
    await typePage.click('#ta'); // blur the others
    await new Promise((r) => setTimeout(r, 900));

    const fields2 = await sw.evaluate(async (prefix) => {
      const d = (await chrome.storage.local.get(`${prefix}127.0.0.1`))[`${prefix}127.0.0.1`];
      return d ? Object.fromEntries(Object.entries(d.fields).map(([k, f]) => [k, f.records.map((r) => r.value)])) : {};
    }, DOMAIN_PREFIX);
    const flat = JSON.stringify(fields2);
    check('shadow DOM input captured', !!fields2['id:shadow-input']?.some((v) => v.includes('hello from shadow')));
    check('nested shadow input captured', !!fields2['id:nested-input']?.some((v) => v.includes('nested shadow text')));
    check('contenteditable captured', flat.includes('plus contenteditable'));
    check('select change captured', !!fields2['id:sel']?.some((v) => v === 'beta'));
    check('password NOT captured', !flat.includes('SuperSecret123'));

    // ---- settings push: block 127.0.0.1, then type more; no new value may appear
    await sw.evaluate(async (msg) => {
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, msg)));
    }, { type: 'inputstash:settings-updated', settings: { historyLimit: 20, identityThreshold: 50, blockedDomains: ['127.0.0.1'], blockedFields: {}, colorScheme: 'auto' } });
    await typePage.click('#ta');
    await typePage.keyboard.type(' BLOCKEDMARKER', { delay: 20 });
    await new Promise((r) => setTimeout(r, 800));
    const afterBlock = await sw.evaluate(async (prefix) => JSON.stringify((await chrome.storage.local.get(`${prefix}127.0.0.1`))[`${prefix}127.0.0.1`] ?? {}), DOMAIN_PREFIX);
    check('settings push blocks new captures', !afterBlock.includes('BLOCKEDMARKER'));

    // ---- popup UI: lists domains from index, filter + select + records render
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
    await popup.waitForSelector('.domain-trigger', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 700));
    await popup.click('.domain-trigger');
    await popup.waitForSelector('.domain-menu input');
    const optionCount = await popup.evaluate(() => document.querySelectorAll('.domain-options button').length);
    await popup.type('.domain-menu input', 'site37.example');
    await new Promise((r) => setTimeout(r, 300));
    const filtered = await popup.evaluate(() => [...document.querySelectorAll('.domain-options button')].map((b) => b.textContent.trim()));
    check('popup lists migrated domains', optionCount >= SEED_DOMAINS, `${optionCount} options`);
    check('popup filter works', filtered.length === 1 && filtered[0].includes('site37.example'), JSON.stringify(filtered.map((f) => f.slice(0, 40))));
    await popup.click('.domain-options button');
    await new Promise((r) => setTimeout(r, 600));
    const bodyText = await popup.evaluate(() => document.body.innerText);
    check('popup renders migrated fields for selected domain', bodyText.includes('Field 1'), '');
    await popup.screenshot({ path: new URL('./popup.png', import.meta.url).pathname });

    RESULT.checks = checks;
    RESULT.failed = checks.filter((c) => !c.ok).length;
  }

  writeFileSync(new URL(`./result-${MODE}.json`, import.meta.url).pathname, JSON.stringify(RESULT, null, 2));
  await browser.close();
  server.close();
  if (RESULT.failed) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
