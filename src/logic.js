// Pure rules from the spec: pricing (s1), gates G-01..G-20 and flags F-01..F-12 (s2), claims and palette (s3),
// scoring and status (s4). No I/O here, so every rule is testable. Every threshold comes from cfg.

export const CORE_SIZES = ['S', 'M', 'L'];
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const ONE_SIZE_CATEGORIES = ['Scarves & Gloves', 'Hats & Hair', 'Bags & Belts', 'Jewelry'];
const GENERIC_BRANDS = ['', 'none', 'noenname_null', 'oem', 'other', 'no brand', 'unbranded', 'generic'];
export const COUNTRIES = ['US', 'GB', 'CA']; // spec: the UK is GB in every API call

// ---------- pricing (spec section 1) ----------
export function kShare(e) {
  return 1 - e.refund_rate - 1 / e.target_roas - e.payment_fee_rate - e.overhead_rate - e.target_net_margin * (1 - e.refund_rate);
}
export const minPrice = (landed, e) => (landed + e.payment_fee_fixed_usd) / kShare(e);
export function roundUpToEnding(x, digit = 8) {
  const n = Math.ceil((x - digit) / 10 - 1e-9) * 10 + digit;
  return Math.max(n, digit);
}
// GBP and CAD: round up to a price ending in 0, 5 or 8
export function roundUpLocal(x) {
  for (let n = Math.ceil(x - 1e-9); ; n++) if ([0, 5, 8].includes(n % 10)) return n;
}
export function netMargin(price, landed, e) {
  const net = price * (1 - e.refund_rate - 1 / e.target_roas - e.payment_fee_rate - e.overhead_rate) - e.payment_fee_fixed_usd - landed;
  return net / (price * (1 - e.refund_rate));
}
export function breakevenRoas(price, landed, e) {
  return price / (price * (1 - e.refund_rate - e.payment_fee_rate - e.overhead_rate) - e.payment_fee_fixed_usd - landed);
}
export function dutyClass(category) {
  if (category === 'Jewelry') return 'jewelry';
  if (category === 'Boots & Shoes') return 'footwear';
  if (category === 'Bags & Belts' || category === 'Hats & Hair') return 'bag_belt_hat';
  return 'garment';
}
export function dutyRate(market, category) {
  const r = market.duty_rate;
  if (typeof r === 'number') return r;
  const cls = dutyClass(category);
  return r[cls] ?? r.other ?? r.garment;
}
// S2 pre-filter: the most an item can cost and still fit under band_max
export function itemPriceCeiling(row, cfg) {
  const e = cfg.economics;
  return (row.price_band_max_usd * kShare(e) - e.payment_fee_fixed_usd - cfg.shipping.max_ship_cost_usd) /
    (1 + dutyRate(cfg.markets.US, row.category));
}
export function priceProduct(itemPrice, shipByCountry, row, cfg) {
  const e = cfg.economics;
  const landed = {};
  for (const [key, m] of Object.entries(cfg.markets)) {
    landed[m.iso] = itemPrice + shipByCountry[m.iso] + itemPrice * dutyRate(m, row.category);
  }
  const L = Math.max(...Object.values(landed));
  const pMin = minPrice(L, e);
  const rounded = roundUpToEnding(pMin, e.price_ending_digit);
  const bandMax = +row.price_band_max_usd;
  const priceUsd = Math.max(rounded, +row.price_band_min_usd);
  return {
    landed, landedMax: L, pMin, rounded,
    overBand: rounded > bandMax,
    priceUsd,
    priceGbp: roundUpLocal(priceUsd * cfg.markets.UK.fx_per_usd * (1 + (cfg.markets.UK.prices_include_vat ? cfg.markets.UK.vat_rate : 0))),
    priceCad: roundUpLocal(priceUsd * cfg.markets.CA.fx_per_usd),
    markup: priceUsd / L,
    netMargin: netMargin(priceUsd, L, e),
    breakevenRoas: breakevenRoas(priceUsd, L, e),
    headroom: (bandMax - pMin) / bandMax,
  };
}

// ---------- palette (spec 3.3) ----------
const SYNONYMS = {
  khaki: 'camel', apricot: 'camel', caramel: 'camel', 'light camel': 'camel',
  'wine red': 'burgundy', 'red wine': 'burgundy', claret: 'burgundy', 'dark red': 'burgundy', maroon: 'burgundy', 'jujube red': 'burgundy',
  coffee: 'chocolate', 'dark brown': 'chocolate', 'light brown': 'tan', mocha: 'brown',
  gray: 'grey', 'light gray': 'grey', 'light grey': 'grey', 'dark gray': 'charcoal', 'dark grey': 'charcoal', 'deep gray': 'charcoal',
  'off white': 'ivory', 'off-white': 'ivory', 'milk white': 'cream', 'beige white': 'cream', 'creamy white': 'cream', 'creamy-white': 'cream',
  'army green': 'olive', 'dark green': 'bottle green', 'blackish green': 'bottle green', 'forest green': 'hunter green',
  'light blue': 'pale blue', 'sky blue': 'pale blue', 'baby blue': 'pale blue', 'navy blue': 'navy', 'dark blue': 'navy', 'royal navy': 'navy',
  'oat': 'oatmeal', 'nude': 'beige', 'silver gray': 'grey',
};
export function mapColour(name, palette) {
  if (!name) return null;
  const n = String(name).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (palette.includes(n)) return n;
  if (SYNONYMS[n]) return SYNONYMS[n];
  // longest synonym or palette term contained as whole words, e.g. "Khaki Coat" -> camel
  const terms = [...Object.keys(SYNONYMS), ...palette].sort((a, b) => b.length - a.length);
  for (const t of terms) {
    if (new RegExp(`(^|[^a-z])${t.replace(/[-]/g, '[- ]')}([^a-z]|$)`).test(n)) return SYNONYMS[t] ?? t;
  }
  return null;
}
export function normSize(s) {
  if (!s) return null;
  const m = String(s).toUpperCase().match(/^\s*(XXXL|3XL|XXL|2XL|XL|XXS|XS|S|M|L)(?![A-Z])/);
  if (!m) return null;
  return { '2XL': 'XXL', '3XL': 'XXXL' }[m[1]] ?? m[1];
}

// ---------- blocklist and claims (spec 3.2, 3.4) ----------
export function blocklistHits(text, cfg) {
  let t = ` ${String(text || '').toLowerCase()} `;
  for (const w of cfg.blocklist_whitelist_phrases) t = t.replaceAll(w.toLowerCase(), ' ');
  return cfg.blocklist_terms.filter((w) => new RegExp(`(^|[^a-z])${w.toLowerCase()}([^a-z]|$)`).test(t));
}
export function claimsAllowed(composition) {
  const c = String(composition || '').toLowerCase();
  const woolPct = Math.max(0, ...[...c.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:merino\s+)?wool/g)].map((m) => +m[1]),
    ...[...c.matchAll(/wool\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*%/g)].map((m) => +m[1]));
  const real = (w) => new RegExp(`\\b${w}\\b`).test(c) && !new RegExp(`\\b(faux|pu|imitation|artificial|synthetic|vegan)\\s+${w}`).test(c);
  return { wool: woolPct >= 30, cashmere: real('cashmere'), silk: real('silk'), leather: real('leather'), suede: real('suede') };
}
const REAL_FUR = /\b(real|genuine|natural)\s+(fox\s+|mink\s+|rabbit\s+|raccoon\s+)?fur\b/i;

// ---------- evaluation ----------
// p: normalized product (see aliexpress.js). p.freight / p.vision: undefined = not fetched yet (skip those gates),
// null = could not be read (UNVERIFIED). Returns a result; call again after fetching freight and vision.
export function evaluate(p, row, cfg) {
  const reject = [], flags = [], unverified = [];
  const role = row.role;
  const tier = cfg.supplier_gates[role === 'Hero' ? 'hero' : role === 'Add-on' ? 'addon' : 'standard'];
  const oneSize = ONE_SIZE_CATEGORIES.includes(row.category);
  const out = { reject, flags, unverified };

  // G-20 category enabled
  if (String(row.enabled) !== 'True') return finish(out, ['HOLD_CATEGORY'], cfg, 'SKIPPED');
  // G-19 listing live
  if (p.statusType == null) unverified.push('LISTING_STATUS');
  else if (!/onselling/i.test(p.statusType)) reject.push('OFFLINE');
  // G-06 orders (lifetime sales_count from product detail)
  if (p.orders == null) unverified.push('ORDERS');
  else if (p.orders < tier.min_orders) reject.push('LOW_ORDERS');
  // G-07 reviews and rating
  if (p.reviews == null) unverified.push('REVIEWS'); else if (p.reviews < tier.min_reviews) reject.push('LOW_REVIEWS');
  if (p.rating == null) unverified.push('RATING'); else if (p.rating < tier.min_rating) reject.push('LOW_RATING');
  // G-08 photo reviews: not returned by the Open Platform APIs
  if (p.photoReviews == null) unverified.push('PHOTO_REVIEWS'); else if (p.photoReviews < tier.min_photo_reviews) reject.push('LOW_PHOTO_REVIEWS');
  // G-09 store health
  const g = cfg.supplier_gates;
  if (!p.store?.dsr?.length || p.store.dsr.some((v) => v == null)) unverified.push('STORE_DSR');
  else if (Math.min(...p.store.dsr) < g.store_min_dsr) reject.push('STORE_DSR');
  if (p.store?.positive == null) unverified.push('STORE_POSITIVE_FEEDBACK'); else if (p.store.positive < g.store_min_positive_feedback) reject.push('STORE_FEEDBACK');
  if (p.store?.ageYears == null) unverified.push('STORE_AGE'); else if (p.store.ageYears < g.store_min_age_years) reject.push('STORE_AGE');

  // G-10 / G-11 variants: keep on-palette colours in allowed sizes, then drop SKUs >15% dearer than the cheapest
  const va = cfg.variants[oneSize ? 'one_size' : 'apparel'];
  const skus = (p.skus || []).map((s) => ({ ...s, pal: mapColour(s.colour, cfg.palette), sz: normSize(s.size) }));
  const allColours = new Set(skus.map((s) => s.colour).filter(Boolean));
  out.unmappedColours = [...new Set(skus.filter((s) => s.colour && !s.pal).map((s) => s.colour))];
  let listable = skus.filter((s) => (s.pal || (!s.colour && oneSize)) && (oneSize || SIZE_ORDER.includes(s.sz)) && s.price != null);
  const cheapest = Math.min(...listable.map((s) => s.price));
  const spread = cfg.variants.apparel.max_variant_price_spread;
  listable = listable.filter((s) => s.price <= cheapest * (1 + spread) + 1e-9);
  const palColours = new Set(listable.map((s) => s.pal).filter(Boolean));
  const sizes = new Set(listable.map((s) => s.sz).filter(Boolean));
  Object.assign(out, {
    listable, coloursTotal: allColours.size || (oneSize ? 1 : 0), paletteColours: [...palColours],
    sizes: SIZE_ORDER.filter((s) => sizes.has(s)),
    offPalette: [...allColours].filter((c) => !mapColour(c, cfg.palette)),
    priceLow: listable.length ? cheapest : null,
    priceHigh: listable.length ? Math.max(...listable.map((s) => s.price)) : null,
  });
  if (out.coloursTotal < va.min_colours) reject.push('FEW_VARIANTS');
  if (palColours.size < va.min_palette_colours && !(oneSize && !allColours.size)) reject.push('OFF_PALETTE');
  if (!oneSize) {
    if (va.required_sizes.some((s) => !sizes.has(s))) reject.push('SIZE_GAP');
    if (listable.length < va.min_skus) reject.push('FEW_VARIANTS');
  }
  // G-12 inventory
  const inv = cfg.inventory[oneSize ? 'one_size' : 'apparel'];
  if (listable.some((s) => s.stock == null)) unverified.push('STOCK');
  else {
    out.stockTotal = listable.reduce((a, s) => a + s.stock, 0);
    if (out.stockTotal < inv.min_total_stock) reject.push('LOW_STOCK');
    if (!oneSize) {
      const perCore = [...palColours].flatMap((c) => CORE_SIZES.map((sz) =>
        listable.filter((s) => s.pal === c && s.sz === sz).reduce((a, s) => a + s.stock, 0)));
      out.minCoreStock = perCore.length ? Math.min(...perCore) : 0;
      if (out.minCoreStock < inv.min_stock_per_core_size) reject.push('LOW_STOCK');
    }
    // F-01 placeholder stock
    const st = listable.map((s) => s.stock);
    if (st.some((v) => cfg.inventory.placeholder_stock_values.includes(v)) ||
        (st.length > 1 && st.every((v) => v === st[0] && v > 0 && v % 100 === 0))) flags.push('F-01');
  }

  // G-15 design and trademark; G-18 composition; G-14 text part (brand attribute)
  const text = [p.title, p.attrsText, p.description].join(' \n ');
  out.blocklist = blocklistHits(text, cfg);
  if (out.blocklist.length) reject.push('DESIGN_COPY');
  if (REAL_FUR.test(text)) reject.push('PROHIBITED');
  if (!p.composition) unverified.push('FIBRE');
  out.claims = claimsAllowed(p.composition);
  const brandGeneric = GENERIC_BRANDS.includes(String(p.brand ?? '').trim().toLowerCase());
  if (!brandGeneric) flags.push('F-10');
  if (/\b(logo|brand label|custom label|printed brand|private label)\b/i.test(p.description || '')) flags.push('F-10');
  // G-16 image count
  if ((p.images?.length ?? 0) < cfg.quality.min_images) reject.push('FEW_IMAGES');

  // F-02 review/order mismatch. ponytail: only the 4.9+ half; sales_count is bucketed ("1000+"), so
  // "more reviews than orders" would misfire. Add it back if an exact order count turns up.
  if (p.rating >= 4.9 && p.reviews != null && p.orders && p.reviews < 0.02 * p.orders) flags.push('F-02');
  // F-04 inflated original price
  if (p.originalPrice && p.salePrice && p.originalPrice > 3 * p.salePrice) flags.push('F-04');
  // F-07 listing changed since the last snapshot
  if (p.previous && (p.previous.title !== p.title || p.previous.mainImage !== p.images?.[0])) flags.push('F-07');
  // F-08 slow processing
  if (p.processingDays == null) unverified.push('PROCESSING_TIME');
  else if (p.processingDays > 3) flags.push('F-08');
  // F-09 size chart
  if (!oneSize && !(/\bcm\b/i.test(text) && /(bust|waist|length)/i.test(text))) flags.push('F-09');

  // G-01..G-05 shipping, G-13 price band
  if (p.freight !== undefined) {
    out.ship = {};
    const maxDays = cfg.shipping.max_delivery_days, maxCost = cfg.shipping.max_ship_cost_usd;
    for (const c of COUNTRIES) {
      const methods = p.freight?.[c];
      if (!methods) { unverified.push(`FREIGHT_${c}`); continue; }
      if (!methods.length) { reject.push(`SHIP_MISSING_${c}`); continue; }
      const tracked = cfg.shipping.require_tracking ? methods.filter((m) => m.tracked !== false) : methods;
      if (!tracked.length) { reject.push('SHIP_UNTRACKED'); continue; }
      const total = (m) => (m.days == null ? null : m.days + (p.processingDays ?? 0));
      const fast = tracked.filter((m) => total(m) != null && total(m) <= maxDays && m.cost != null);
      // A quote with a cost but no delivery days (DSers data) still prices the product; days stay UNVERIFIED.
      const undated = tracked.filter((m) => total(m) == null && m.cost != null);
      if (!fast.length && undated.length) unverified.push(`DELIVERY_${c}`);
      const pool = fast.length ? fast : undated;
      if (!pool.length) {
        if (tracked.some((m) => total(m) == null || m.cost == null)) unverified.push(`FREIGHT_${c}`);
        else reject.push(`SHIP_SLOW_${c}`);
        continue;
      }
      const best = pool.reduce((a, m) => (m.cost < a.cost ? m : a));
      out.ship[c] = { ...best, totalDays: total(best) };
      if (best.tracked == null) unverified.push(`TRACKING_${c}`);
      if (best.cost > maxCost + 1e-9) reject.push(`SHIP_COST_${c}`);
      if (cfg.shipping.reject_if_ship_cost_gt_item_price && out.priceHigh != null && best.cost > out.priceHigh) reject.push('SHIP_GT_ITEM');
    }
    const costs = Object.values(out.ship).map((s) => s.cost);
    if (costs.length > 1 && Math.max(...costs) - Math.min(...costs) > cfg.shipping.freight_outlier_usd) flags.push('F-11');
    // A country with no quote (already UNVERIFIED above) is priced at the dearest known quote, so the price stays safe.
    if (costs.length && out.priceHigh != null) {
      out.pricing = priceProduct(out.priceHigh, Object.fromEntries(COUNTRIES.map((c) => [c, out.ship[c]?.cost ?? Math.max(...costs)])), row, cfg);
      if (out.pricing.overBand) reject.push('PRICE_OVER_BAND');
    }
  }

  // Vision: G-14 (logos), G-16 (watermark, on-model), G-17 (premium look), F-06 (images differ)
  if (p.vision !== undefined) {
    const v = p.vision;
    if (!v) unverified.push('PREMIUM_LOOK', 'WHITE_LABEL', 'ON_MODEL');
    else {
      if (v.logo_or_text) reject.push('BRANDED');
      if (!v.images_consistent) reject.push('IMAGE_MISMATCH');
      if (!v.on_model) reject.push('FEW_IMAGES');
      if (v.score < cfg.quality.min_premium_look_score) reject.push('OFF_BRAND_STYLE');
      if (v.fails?.length) reject.push('OFF_BRAND_STYLE');
    }
    out.whitelabel = !v ? 'UNVERIFIED' : v.logo_or_text ? 'FAIL' : role === 'Hero' || !brandGeneric ? 'UNVERIFIED' : 'PASS';
    if (out.whitelabel === 'UNVERIFIED' && v) unverified.push('WHITE_LABEL');
  }
  return finish(out, [], cfg, null, p, row);
}

function finish(out, extraReject, cfg, forced, p, row) {
  out.reject = [...new Set([...out.reject, ...extraReject])];
  out.flags = [...new Set(out.flags)];
  out.unverified = [...new Set(out.unverified)];
  if (forced) return { ...out, status: forced, score: 0 };
  if (out.reject.length) return { ...out, status: 'REJECTED', score: 0 };
  if (p.freight === undefined || p.vision === undefined) return { ...out, status: 'PENDING', score: null }; // score once all data is in
  out.score = score(p, out, cfg);
  const s = cfg.scoring;
  out.status = out.score < s.review_min_score ? 'REJECTED'
    : out.flags.length || out.unverified.length || out.score < s.approve_min_score ? 'REVIEW' : 'APPROVED';
  if (out.status === 'REJECTED') out.reject.push('LOW_SCORE');
  return out;
}

const clamp = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
// Spec section 4. Unknown inputs score 0, except a missing vision score counts as the pass mark (4) so products
// are not all rejected when vision is off; UNVERIFIED still sends them to REVIEW.
export function score(p, out, cfg) {
  const w = cfg.scoring.weights;
  const ships = Object.values(out.ship || {});
  const vision = p.vision?.score ?? cfg.quality.min_premium_look_score;
  const parts = {
    margin_headroom: out.pricing ? out.pricing.headroom / 0.30 : 0,
    social_proof: (p.rating == null ? 0 : 0.5 * clamp((p.rating - 4.5) / 0.4)) + (p.reviews ? 0.5 * clamp(Math.log10(p.reviews) / Math.log10(2000)) : 0),
    sales_velocity: p.orders ? Math.log10(p.orders) / Math.log10(10000) : 0,
    premium_look: (vision - 3) / 2,
    delivery_speed: ships.length ? (9 - ships.reduce((a, s) => a + s.totalDays, 0) / ships.length) / 5 : 0,
    variants_palette: 0.5 * Math.min(1, out.paletteColours.length / 5) + 0.5 * (out.sizes.length / SIZE_ORDER.length),
    shipping_cost: ships.length ? (5 - Math.max(...ships.map((s) => s.cost))) / 5 : 0,
  };
  return Math.round(Object.entries(parts).reduce((a, [k, v]) => a + w[k] * clamp(v), 0));
}

// Throughput caps (spec 4): best score first; over-cap rows become APPROVED_QUEUED.
export function applyCaps(rows, cfg, counts = { total: 0, byCat: {}, bySub: {} }) {
  const t = cfg.throughput;
  const byCat = { ...counts.byCat }, bySub = { ...counts.bySub };
  let total = counts.total;
  return [...rows].sort((a, b) => b.score - a.score).map((r) => {
    const ok = total < t.max_new_approved_per_day && (byCat[r.category] ?? 0) < t.max_per_category_per_day &&
      (bySub[r.subcategory] ?? 0) < (t.max_per_subcategory_per_day ?? Infinity);
    if (!ok) return { ...r, status: 'APPROVED_QUEUED', queuedFrom: r.status };
    total++; byCat[r.category] = (byCat[r.category] ?? 0) + 1; bySub[r.subcategory] = (bySub[r.subcategory] ?? 0) + 1;
    return r;
  });
}

// Plain-English meaning of every code (Reason_Codes sheet and the "What to check" column)
export const CODES = {
  SHIP_MISSING_US: 'No tracked shipping method to the US', SHIP_MISSING_GB: 'No shipping to the UK', SHIP_MISSING_CA: 'No shipping to Canada',
  SHIP_SLOW_US: 'US delivery over 9 days', SHIP_SLOW_GB: 'UK delivery over 9 days', SHIP_SLOW_CA: 'Canada delivery over 9 days',
  SHIP_COST_US: 'US shipping over $4.99', SHIP_COST_GB: 'UK shipping over $4.99', SHIP_COST_CA: 'Canada shipping over $4.99',
  SHIP_GT_ITEM: 'Shipping costs more than the item', SHIP_UNTRACKED: 'No tracked shipping method',
  LOW_ORDERS: 'Too few orders for its tier', LOW_REVIEWS: 'Too few reviews', LOW_RATING: 'Rating below tier minimum',
  LOW_PHOTO_REVIEWS: 'Too few photo reviews', STORE_DSR: 'Store ratings below 4.6', STORE_FEEDBACK: 'Store positive feedback below 95%', STORE_AGE: 'Store open less than a year',
  FEW_VARIANTS: 'Not enough colours or SKUs', OFF_PALETTE: 'Fewer than 2 Vourelle palette colours', SIZE_GAP: 'Missing one of S, M, L, XL',
  PRICE_SPREAD: 'SKU prices vary more than 15%', LOW_STOCK: 'Stock too low', PRICE_OVER_BAND: 'Cannot hit 10% margin inside the price band',
  BRANDED: 'Visible logo, label or store branding', DESIGN_COPY: 'Brand name or designer copy term', FEW_IMAGES: 'Under 5 images or no on-model shot',
  WATERMARK: 'Watermark on images', OFF_BRAND_STYLE: 'Does not look premium enough', PROHIBITED: 'Real fur', OFFLINE: 'Listing not on sale',
  HOLD_CATEGORY: 'Category on hold', IMAGE_MISMATCH: 'Images show different garments or colours', LOW_SCORE: 'Score under 55', ERROR: 'API error after retries',
  'F-01': 'Stock looks like a placeholder number: ask the supplier for real stock', 'F-02': 'Rating is 4.9+ but few reviews versus orders: read the reviews',
  'F-03': 'Much cheaper than identical listings', 'F-04': 'Original price over 3x the sale price', 'F-05': 'Supplier price moved over 10% in 14 days',
  'F-06': 'Images do not match each other', 'F-07': 'Title or main image changed since last check', 'F-08': 'Supplier processing over 3 days',
  'F-09': 'No size chart in cm: check measurements exist', 'F-10': 'Brand name or logo hints: check photos for labels',
  'F-11': 'One country ships much dearer than the others', 'F-12': 'Store sells unrelated goods',
  ORDERS: 'Order count unreadable', REVIEWS: 'Review count unreadable', RATING: 'Rating unreadable',
  PHOTO_REVIEWS: 'Photo reviews not in the API: open the listing and check there are enough customer photos',
  STORE_DSR: 'Store ratings unreadable: check the store page', STORE_POSITIVE_FEEDBACK: 'Check store positive feedback is 95%+',
  STORE_AGE: 'Check the store has been open 1 year+', STOCK: 'Stock unreadable', FIBRE: 'No fabric composition listed: confirm it before writing copy',
  LISTING_STATUS: 'Listing status unreadable', PROCESSING_TIME: 'Processing time unknown: delivery days may be understated',
  FREIGHT_US: 'No US shipping quote found: check the listing ships to the US', FREIGHT_GB: 'No UK shipping quote found: check the listing ships to the UK', FREIGHT_CA: 'No Canada shipping quote found: check the listing ships to Canada',
  DELIVERY_US: 'Check US delivery is 9 days or less', DELIVERY_GB: 'Check UK delivery is 9 days or less', DELIVERY_CA: 'Check Canada delivery is 9 days or less',
  TRACKING_US: 'Check US method is tracked', TRACKING_GB: 'Check UK method is tracked', TRACKING_CA: 'Check Canada method is tracked',
  PREMIUM_LOOK: 'Vision check did not run: judge the photos yourself', WHITE_LABEL: 'Labels not visible in photos: confirm no branding (sample for Heroes)',
  ON_MODEL: 'Check there is an on-model photo',
  APPROVED: 'All gates passed, score 70+', APPROVED_QUEUED: 'Would be approved; daily cap reached', REVIEW: 'Passed gates; needs your check',
  REJECTED: 'Failed a gate or scored under 55', IMPORTED: 'Sent to DSers',
};
export const humanCheck = (r) => [...r.flags, ...r.unverified].map((c) => CODES[c] ?? c).join('; ');
