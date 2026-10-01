// Daily sourcing run (spec 6.2, S1-S9): discover -> pre-filter -> enrich -> gate -> freight -> vision -> price ->
// score -> caps -> workbook. Stops at the daily cap or stop_by, whichever first. Safe to re-run: products already
// checked are skipped and the workbook is rebuilt from state. Flags: --dry-run (state is not saved).
import fs from 'node:fs';
import yaml from 'js-yaml';
import * as src from './dsers.js'; // product data source; ./aliexpress.js once there is an Open Platform app
import { judge } from './vision.js';
import { evaluate, itemPriceCeiling, applyCaps, humanCheck, COUNTRIES } from './logic.js';
import { writeWorkbook } from './excel.js';

const DRY = process.argv.includes('--dry-run');
const STATE = 'state/state.json', DECISIONS = 'state/decisions.json';
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const cfg = yaml.load(fs.readFileSync('vourelle_bot_config.yaml', 'utf8'));
const tz = cfg.run.timezone;
const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(d);
const localHHMM = (d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const daysAgo = (date) => (Date.parse(localDate()) - Date.parse(date)) / 864e5;

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).map((l) => [...l.matchAll(/("([^"]*(?:""[^"]*)*)"|[^,]*)(,|$)/g)]
    .slice(0, -1).map((m) => (m[2] !== undefined ? m[2].replaceAll('""', '"') : m[1])));
  const [head, ...rows] = lines;
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const ROLE_ORDER = { Hero: 0, Core: 1, 'Add-on': 2 };
const taxonomy = parseCsv(fs.readFileSync('vourelle_taxonomy.csv', 'utf8'));
const rows = taxonomy.filter((r) => r.enabled === 'True').sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
const rowBySub = Object.fromEntries(taxonomy.map((r) => [r.subcategory, r]));

const today = localDate();
const state = readJson(STATE, { products: {}, runs: {} });
const decisions = readJson(DECISIONS, {}); // written by import.js on the laptop: id -> {decision, imported}
const run = state.runs[today] ??= { scanned: 0, prefiltered: 0, evaluated: 0, errors: 0, apiCalls: 0, gates: {}, countries: {} };
const started = Date.now();
const callsBefore = run.apiCalls;
const stopBy = (() => {
  const [h, m] = cfg.run.stop_by.split(':').map(Number);
  const nowMin = localHHMM().split(':').map(Number).reduce((a, b) => a * 60 + b);
  const left = h * 60 + m - nowMin;
  return started + (left > 0 ? left : cfg.run.max_runtime_minutes) * 60_000;
})();
const pastDeadline = () => Date.now() >= stopBy;

const SHOWN = ['APPROVED', 'REVIEW'];
const all = () => Object.values(state.products);
const shownToday = () => all().filter((r) => r.date === today && SHOWN.includes(r.status));
const tally = (list, key) => list.reduce((a, r) => ({ ...a, [r[key]]: (a[r[key]] ?? 0) + 1 }), {});
const counts = () => {
  const t = shownToday();
  return { total: t.length, byCat: tally(t, 'category'), bySub: tally(t, 'subcategory') };
};
const liveInSub = (sub) => all().filter((r) => r.subcategory === sub && decisions[r.id]?.imported).length;

const isSetupError = (e) => /Missing environment|IncompleteSignature|InvalidApiPath|AppKey|InvalidSession|session|access.?token/i.test(e.message);

function skip(id) {
  if (decisions[id]) return true;
  const r = state.products[id];
  if (!r) return false;
  if (['REJECTED', 'ERROR'].includes(r.status)) return daysAgo(r.date) < cfg.run.recheck_rejected_after_days;
  return true; // shown, queued or imported: never re-shown as new
}

function save() {
  if (DRY) return;
  const keep = cfg.output.keep_rejected_days;
  for (const [id, r] of Object.entries(state.products)) if (['REJECTED', 'ERROR'].includes(r.status) && daysAgo(r.date) > keep) delete state.products[id];
  for (const d of Object.keys(state.runs)) if (daysAgo(d) > keep) delete state.runs[d];
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state));
  fs.renameSync(STATE + '.tmp', STATE); // atomic: a crash mid-write never leaves half a file
}

// Enrich + gate one discovered product. Cheap gates first; freight and vision only for survivors (spec S4-S5).
async function check(disc, row) {
  const prev = state.products[disc.id];
  const p = await src.detail(disc, disc.ship ?? {});
  if (prev) p.previous = { title: prev.title, mainImage: prev.mainImage };
  let r = evaluate(p, row, cfg); // shipping quotes arrive with the product, so shipping gates run here too
  for (const c of COUNTRIES) run.countries[c] = run.countries[c] ?? { pass: 0, fail: 0 };
  for (const c of COUNTRIES) run.countries[c][r.reject.some((x) => x.endsWith(`_${c}`)) ? 'fail' : 'pass']++;
  if (r.status !== 'REJECTED') {
    p.vision = prev?.vision ?? await judge(p, cfg); // reuse an earlier verdict: photos rarely change
    r = evaluate(p, row, cfg);
  }
  for (const code of r.reject.length ? r.reject : [...r.flags, ...r.unverified]) run.gates[code] = (run.gates[code] ?? 0) + 1;
  const base = { id: p.id, url: p.url, title: p.title, mainImage: p.images[0], category: row.category, subcategory: row.subcategory, date: today, status: r.status, reasons: r.reject };
  if (r.status === 'REJECTED') return base; // kept small: rejects are only needed for the 30-day Rejected sheet
  return {
    ...base, role: row.role, googleCategory: row.google_product_category, date: today, checkedAt: new Date().toISOString(), disc,
    status: r.status, score: r.score, reasons: r.reject, flags: r.flags, unverified: r.unverified, human: humanCheck(r),
    orders: p.orders, rating: p.rating, reviews: p.reviews, store: p.store, composition: p.composition, claims: r.claims,
    priceLow: r.priceLow, priceHigh: r.priceHigh, ship: r.ship, pricing: r.pricing, paletteColours: r.paletteColours, offPalette: r.offPalette,
    unmappedColours: r.unmappedColours, sizes: r.sizes, stockTotal: r.stockTotal, minCoreStock: r.minCoreStock,
    vision: p.vision, whitelabel: r.whitelabel, listableSkus: r.listable?.map((s) => s.id),
  };
}

async function checkSafely(disc, row) {
  run.evaluated++;
  try { return await check(disc, row); } catch (e) {
    if (isSetupError(e)) throw e; // keys or token wrong: stop the run instead of rejecting everything
    run.errors++;
    console.warn(`ERROR ${disc.id}: ${e.message}`);
    return { id: disc.id, url: disc.url, title: disc.title, category: row.category, subcategory: row.subcategory, date: today, status: 'ERROR', reasons: ['ERROR'], disc };
  }
}

// Keep the best passers within the caps; the rest wait in the queue for tomorrow.
function accept(passers) {
  for (const r of applyCaps(passers, cfg, counts())) {
    state.products[r.id] = r;
  }
}

async function main() {
  const t = cfg.throughput;
  const full = () => counts().total >= t.max_new_approved_per_day;
  const rowOpen = (row) => {
    const c = counts();
    return (c.byCat[row.category] ?? 0) < t.max_per_category_per_day &&
      (c.bySub[row.subcategory] ?? 0) < t.max_per_subcategory_per_day && liveInSub(row.subcategory) < t.max_live_per_subcategory;
  };

  // Yesterday's queue first, best score first, re-checked with fresh data (spec: APPROVED_QUEUED carried over)
  const queued = all().filter((r) => r.status === 'APPROVED_QUEUED').sort((a, b) => b.score - a.score);
  for (const q of queued) {
    const row = rowBySub[q.subcategory];
    if (full() || pastDeadline()) break;
    if (!row || !rowOpen(row)) continue;
    const r = await checkSafely(q.disc, row);
    if (SHOWN.includes(r.status)) accept([r]); else state.products[r.id] = r;
    save();
  }

  for (const row of rows) {
    if (full() || pastDeadline()) break;
    if (!rowOpen(row)) continue;
    const passers = [];
    const ceiling = itemPriceCeiling(row, cfg);
    // Search each country: the US list is the candidates, the UK and Canada lists give their shipping quotes.
    const cursor = {}, quote = { US: {}, GB: {}, CA: {} };
    pages: for (let page = 1; page <= cfg.run.pages_per_keyword; page++) {
      try {
        for (const c of COUNTRIES) {
          if (page > 1 && !cursor[c]) continue;
          const res = await src.search(row.aliexpress_keywords, c, cfg.run.page_size, cursor[c]);
          cursor[c] = res.next;
          for (const i of res.items) quote[c][i.id] ??= { item: i, ship: i.shipCost };
        }
      } catch (e) {
        if (isSetupError(e)) throw e;
        run.errors++; console.warn(`search failed for ${row.subcategory}: ${e.message}`); break;
      }
      const found = Object.values(quote.US).map((q) => q.item).filter((d) => !d.seen);
      if (!found.length) break;
      for (const d of found) {
        d.seen = true;
        d.ship = Object.fromEntries(COUNTRIES.map((c) => [c, quote[c][d.id]?.ship]));
        if (pastDeadline()) break pages;
        run.scanned++;
        if (skip(d.id) || passers.some((p) => p.id === d.id)) continue;
        if (d.salePrice == null || d.salePrice > ceiling) continue; // S2 pre-filter; orders are gated on lifetime sales after detail
        run.prefiltered++;
        const r = await checkSafely(d, row);
        if (SHOWN.includes(r.status)) passers.push(r); // stored by accept(), after the caps
        else state.products[r.id] = r;
        if (passers.length >= cfg.run.candidates_per_subcategory) break pages;
      }
    }
    accept(passers);
    run.apiCalls = callsBefore + src.stats.calls;
    save();
    console.log(`${row.category} / ${row.subcategory}: ${passers.length} passed; ${counts().total}/${t.max_new_approved_per_day} today`);
  }
}

let failed = null;
try { await main(); } catch (e) { failed = e; console.error(`Run stopped: ${e.message}`); }
finally {
  run.finishedAt = new Date().toISOString();
  run.apiCalls = callsBefore + src.stats.calls;
  save();
  const shown = shownToday().map((r) => (decisions[r.id]?.imported ? { ...r, status: 'IMPORTED' } : r));
  const rejected = all().filter((r) => r.status === 'REJECTED' && daysAgo(r.date) <= cfg.output.keep_rejected_days);
  fs.mkdirSync(cfg.output.excel_dir, { recursive: true });
  const file = `${cfg.output.excel_dir}/${cfg.output.daily_file.replace('{date}', today)}`;
  await writeWorkbook(file, { date: today, shown, rejected, run, cfg, categories: [...new Set(taxonomy.map((r) => r.category))] });
  console.log(`Workbook: ${file} (${shown.length} products today)`);
}
if (failed || (run.evaluated > 20 && run.errors / run.evaluated > cfg.run.max_error_rate)) process.exitCode = 1; // GitHub emails on failure
