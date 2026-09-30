// Acceptance tests from spec section 11. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { priceProduct, evaluate, applyCaps, blocklistHits, claimsAllowed, mapColour, COUNTRIES } from '../src/logic.js';

const cfg = yaml.load(fs.readFileSync(new URL('../vourelle_bot_config.yaml', import.meta.url), 'utf8'));
const trousers = { category: 'Trousers', subcategory: 'Pleated wide-leg trousers', role: 'Core', enabled: 'True', price_band_min_usd: 68, price_band_max_usd: 98 };

// A product that passes every gate; tests change one thing at a time.
function good(over = {}) {
  const skus = [];
  for (const colour of ['Camel', 'Black', 'Navy']) for (const size of ['S', 'M', 'L', 'XL']) skus.push({ id: `${colour}-${size}`, price: 9.5, stock: 300 + skus.length, colour, size });
  return {
    title: 'Women high waist pleated wide leg trousers', orders: 5000, reviews: 800, rating: 4.8, photoReviews: 100,
    store: { dsr: [4.8, 4.8, 4.8], positive: 0.98, ageYears: 3 }, statusType: 'onSelling', processingDays: 2, brand: 'NoEnName_Null',
    attrsText: 'Material: 70% polyester 30% viscose', description: 'Size chart in cm: waist 66, length 100', composition: '70% polyester 30% viscose',
    images: ['a', 'b', 'c', 'd', 'e', 'f'], skus,
    freight: Object.fromEntries(COUNTRIES.map((c) => [c, [{ method: 'Choice', cost: 2, days: 6, tracked: true }]])),
    vision: { score: 5, fails: [], logo_or_text: false, images_consistent: true, on_model: true },
    ...over,
  };
}
const ship = (c, m) => ({ ...good().freight, [c]: m });

test('T-01 landed $16.58 in band $68-$98 prices at $88, margin ~10.6%', () => {
  const p = priceProduct(9.5, { US: 2.8, GB: 3.1, CA: 3.4 }, trousers, cfg);
  assert.equal(p.landed.US.toFixed(2), '16.58');
  assert.equal(p.pMin.toFixed(2), '85.66');
  assert.equal(p.priceUsd, 88);
  assert.equal(p.priceGbp, 80);
  assert.equal(p.priceCad, 125);
  assert.equal(p.netMargin.toFixed(3), '0.106');
  assert.equal(p.breakevenRoas.toFixed(2), '1.69');
});

test('T-02 landed $19.00 passes at $98; $19.10 is PRICE_OVER_BAND ($108)', () => {
  // US landed = item * 1.45 + ship, so pick an item price and US ship that land exactly there
  const a = priceProduct(10, { US: 4.5, GB: 0, CA: 0 }, trousers, cfg);
  assert.equal(a.landedMax.toFixed(2), '19.00');
  assert.equal(a.priceUsd, 98); assert.equal(a.overBand, false);
  const b = priceProduct(10, { US: 4.6, GB: 0, CA: 0 }, trousers, cfg);
  assert.equal(b.rounded, 108); assert.equal(b.overBand, true);
});

test('T-03 US shipping $5.00 rejects, $4.99 passes', () => {
  const m = (cost) => [{ method: 'x', cost, days: 6, tracked: true }];
  assert.ok(evaluate(good({ freight: ship('US', m(5.0)) }), trousers, cfg).reject.includes('SHIP_COST_US'));
  assert.ok(!evaluate(good({ freight: ship('US', m(4.99)) }), trousers, cfg).reject.includes('SHIP_COST_US'));
});

test('T-04 Canada 10 days rejects, 9 days passes', () => {
  const m = (days) => [{ method: 'x', cost: 2, days, tracked: true }];
  assert.ok(evaluate(good({ processingDays: 0, freight: ship('CA', m(10)) }), trousers, cfg).reject.includes('SHIP_SLOW_CA'));
  assert.ok(!evaluate(good({ processingDays: 0, freight: ship('CA', m(9)) }), trousers, cfg).reject.includes('SHIP_SLOW_CA'));
});

test('T-05 item $2.90 with UK shipping $3.20 is SHIP_GT_ITEM', () => {
  const skus = good().skus.map((s) => ({ ...s, price: 2.9 }));
  const r = evaluate(good({ skus, freight: ship('GB', [{ method: 'x', cost: 3.2, days: 6, tracked: true }]) }), trousers, cfg);
  assert.ok(r.reject.includes('SHIP_GT_ITEM'));
});

test('T-06 no freight method to Canada is SHIP_MISSING_CA', () => {
  assert.ok(evaluate(good({ freight: ship('CA', []) }), trousers, cfg).reject.includes('SHIP_MISSING_CA'));
});

test('T-07 every SKU stock 99999 flags F-01 and goes to REVIEW', () => {
  const r = evaluate(good({ skus: good().skus.map((s) => ({ ...s, stock: 99999 })) }), trousers, cfg);
  assert.ok(r.flags.includes('F-01'));
  assert.equal(r.status, 'REVIEW');
});

test('T-08 "Burberry style check scarf" rejects, "hunter green cable knit" passes', () => {
  assert.deepEqual(blocklistHits('Burberry style check scarf', cfg), ['burberry']);
  assert.deepEqual(blocklistHits('hunter green cable knit', cfg), []);
  assert.ok(evaluate(good({ title: 'Burberry style check trousers' }), trousers, cfg).reject.includes('DESIGN_COPY'));
});

test('T-09 20% wool may not be called wool; 30% may', () => {
  assert.equal(claimsAllowed('80% acrylic 20% wool').wool, false);
  assert.equal(claimsAllowed('70% acrylic 30% wool').wool, true);
  assert.equal(claimsAllowed('PU leather').leather, false);
});

test('T-10 caps: 25 qualifiers -> 10 kept (max 3 per category), rest queued', () => {
  const capCfg = { throughput: { max_new_approved_per_day: 10, max_per_category_per_day: 3 } };
  const rows = Array.from({ length: 25 }, (_, i) => ({ category: `C${i % 5}`, subcategory: `S${i}`, score: 100 - i, status: 'APPROVED' }));
  const out = applyCaps(rows, capCfg);
  assert.equal(out.filter((r) => r.status === 'APPROVED').length, 10);
  assert.equal(out.filter((r) => r.status === 'APPROVED_QUEUED').length, 15);
  for (const c of ['C0', 'C1', 'C2', 'C3', 'C4']) assert.ok(out.filter((r) => r.category === c && r.status === 'APPROVED').length <= 3);
});

test('T-13 the UK is GB in API calls', () => {
  assert.deepEqual(COUNTRIES, ['US', 'GB', 'CA']);
  assert.equal(cfg.markets.UK.iso, 'GB');
});

test('a fully verified product is APPROVED; missing photo-review data sends it to REVIEW', () => {
  assert.equal(evaluate(good(), trousers, cfg).status, 'APPROVED');
  const r = evaluate(good({ photoReviews: null }), trousers, cfg);
  assert.equal(r.status, 'REVIEW');
  assert.ok(r.unverified.includes('PHOTO_REVIEWS'));
});

test('off-palette colours are dropped, not published', () => {
  const skus = [...good().skus, { id: 'pink-S', price: 9.5, stock: 300, colour: 'Neon Pink', size: 'S' }];
  const r = evaluate(good({ skus }), trousers, cfg);
  assert.deepEqual(r.offPalette, ['Neon Pink']);
  assert.ok(!r.listable.some((s) => s.colour === 'Neon Pink'));
  assert.equal(mapColour('Khaki', cfg.palette), 'camel');
  assert.equal(mapColour('Wine Red', cfg.palette), 'burgundy');
});
