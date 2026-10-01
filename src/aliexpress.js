// AliExpress Open Platform client (spec 6.1, N-01: official APIs only, no page scraping).
// One "Drop Shipping" app covers search, detail and freight. Env: AE_APP_KEY, AE_APP_SECRET, AE_ACCESS_TOKEN.
// Field names follow the Open Platform docs (checked 2026-10-01). Confirm on live data with
// `node src/aliexpress.js probe "women camel coat"`: any field that comes back empty is UNVERIFIED, never a pass.
import crypto from 'node:crypto';
import fs from 'node:fs';

const SYNC = 'https://api-sg.aliexpress.com/sync';
const REST = 'https://api-sg.aliexpress.com/rest';
const env = (k) => process.env[k] || (() => { throw new Error(`Missing environment variable ${k}`); })();
export const stats = { calls: 0 };
let probeDir = null;

export function sign(params, secret, path = '') {
  const base = path + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex').toUpperCase();
}

// One signed call with backoff: up to 5 retries on network errors, 5xx and rate limits (spec 6.3).
export async function call(method, params, { token } = {}) {
  const rest = method.startsWith('/');
  const p = { ...params, app_key: env('AE_APP_KEY'), sign_method: 'sha256', timestamp: Date.now(), ...(rest ? {} : { method }), ...(token ? { session: token } : {}) };
  for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  p.sign = sign(p, env('AE_APP_SECRET'), rest ? method : '');
  const url = `${rest ? REST + method : SYNC}?${new URLSearchParams(p)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      stats.calls++;
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (res.status >= 500 || res.status === 429) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      const data = await res.json();
      if (probeDir) fs.writeFileSync(`${probeDir}/${method.replace(/\W+/g, '_')}.json`, JSON.stringify(data, null, 2));
      const err = data.error_response;
      if (err) throw Object.assign(new Error(`AliExpress ${method}: ${err.code} ${err.msg ?? ''}`), { retry: /limit|frequen|isp\.|timeout|busy/i.test(`${err.code} ${err.msg}`) });
      return rest ? data : data[`${method.replaceAll('.', '_')}_response`] ?? data;
    } catch (e) {
      const retry = e.retry ?? (e.name === 'TimeoutError' || e instanceof TypeError);
      if (!retry || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 1000));
    }
  }
}

// The APIs wrap lists as {thing: [...]} or {thing_d_t_o: [...]} depending on version; accept either.
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x).find(Array.isArray) ?? [] : []);
const num = (x) => {
  if (x == null || x === '') return null;
  const n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const bool = (x) => (x == null ? null : x === true || x === 'true');

// S1 discovery: keyword search, ship to US, most orders first.
export async function search(keywords, page, pageSize) {
  const res = await call('aliexpress.ds.text.search', {
    keyWord: keywords, local: 'en_US', countryCode: 'US', currency: 'USD', sortBy: 'orders,desc', pageSize, pageIndex: page,
  }, { token: env('AE_ACCESS_TOKEN') });
  const r = res.aliexpress_ds_text_search ?? res;
  if (r.code != null && !['0', '200'].includes(String(r.code))) throw new Error(`ds.text.search: ${r.code} ${r.msg ?? ''}`);
  return arr(r.data?.products).map((d) => ({
    id: String(d.itemId),
    title: d.title,
    url: `https://www.aliexpress.com/item/${d.itemId}.html`,
    salePrice: num(d.targetSalePrice ?? d.salePrice),
    originalPrice: num(d.targetOriginalPrice ?? d.originalPrice),
    image: d.itemMainPic,
  }));
}

// S3 enrich: full product detail (US). Returns the normalized product that logic.evaluate() reads.
export async function detail(disc) {
  const r = (await call('aliexpress.ds.product.get', {
    product_id: disc.id, ship_to_country: 'US', target_currency: 'USD', target_language: 'en',
  }, { token: env('AE_ACCESS_TOKEN') }))?.result ?? {};
  const base = r.ae_item_base_info_dto ?? {};
  const attrs = arr(r.ae_item_properties).map((a) => [a.attr_name, a.attr_value]);
  const attr = (re) => attrs.filter(([k]) => re.test(k ?? '')).map(([, v]) => v).join(', ') || null;
  const store = r.ae_store_info ?? {};
  const dsr = [store.item_as_described_rating, store.communication_rating, store.shipping_speed_rating]
    .map(num).map((v) => (v != null && v <= 5 ? v : null)); // a percentage here is a different metric: leave UNVERIFIED
  const skus = arr(r.ae_item_sku_info_dtos).map((s) => {
    const props = arr(s.ae_sku_property_dtos ?? s.aeop_s_k_u_propertys);
    const pick = (re) => { const q = props.find((x) => re.test(x.sku_property_name ?? '')); return q ? q.property_value_definition_name || q.sku_property_value : null; };
    return {
      id: String(s.sku_id ?? s.id), price: num(s.offer_sale_price ?? s.sku_price),
      stock: num(s.sku_available_stock ?? s.s_k_u_available_stock ?? s.ipm_sku_stock),
      colour: pick(/colou?r/i), size: pick(/size/i),
    };
  });
  return {
    id: disc.id, url: disc.url, title: base.subject ?? disc.title,
    orders: num(base.sales_count), salePrice: disc.salePrice, // lifetime sales; "1000+" reads as 1000 originalPrice: disc.originalPrice,
    rating: num(base.avg_evaluation_rating), reviews: num(base.evaluation_count), photoReviews: null,
    statusType: base.product_status_type ?? null,
    store: { id: store.store_id, name: store.store_name, dsr: dsr.some((v) => v == null) ? null : dsr, positive: null, ageYears: null },
    processingDays: num((arr(r.logistics_info_dto)[0] ?? r.logistics_info_dto)?.delivery_time),
    brand: attr(/^brand/i) ?? '',
    composition: attr(/material|composition|fabric/i),
    attrsText: attrs.map(([k, v]) => `${k}: ${v}`).join('\n'),
    description: String(base.detail ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    images: String(r.ae_multimedia_info_dto?.image_urls ?? '').split(';').filter(Boolean),
    skus,
  };
}

// Freight for one SKU to one country. [] = does not ship there; null = could not be read (UNVERIFIED).
export async function freight(productId, skuId, iso) {
  const r = (await call('aliexpress.ds.freight.query', {
    queryDeliveryReq: JSON.stringify({ quantity: 1, shipToCountry: iso, productId, selectedSkuId: skuId, language: 'en_US', currency: 'USD', locale: 'en_US' }),
  }, { token: env('AE_ACCESS_TOKEN') }))?.result;
  if (!r) return null;
  if (r.success === false || r.success === 'false') return /NOT_AVAILABLE/i.test(r.msg ?? '') ? [] : null;
  return arr(r.delivery_options).map((o) => ({
    method: o.company ?? o.code,
    // per the docs, shipping_fee_format is "US $2.99" and shipping_fee_cent is "2.99" despite its name
    cost: bool(o.free_shipping) ? 0 : num(o.shipping_fee_format) ?? num(o.shipping_fee_cent),
    days: num(o.max_delivery_days),
    tracked: bool(o.tracking),
    from: o.ship_from_country ?? null,
  }));
}

// One-time setup: exchange the ?code= from the AliExpress authorize page for an access token.
async function auth(code) {
  const r = await call('/auth/token/create', { code });
  const t = r.gopResponseBody ? JSON.parse(r.gopResponseBody) : r;
  if (!t.access_token) return console.log('No token returned:', JSON.stringify(r, null, 2));
  const when = (ms) => (ms ? new Date(+ms).toString() : 'unknown');
  console.log(`access_token: ${t.access_token}\n\nAccess token expires:  ${when(t.expire_time)}\nRefresh token expires: ${when(t.refresh_token_valid_time)}`);
  console.log('\nPaste the access_token into the GitHub secret AE_ACCESS_TOKEN. Repeat this step before it expires.');
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'auth') await auth(arg);
  else if (cmd === 'probe') {
    probeDir = 'probe'; fs.mkdirSync(probeDir, { recursive: true });
    const [d] = await search(arg || 'women camel coat', 1, 5);
    const p = await detail(d);
    await freight(d.id, p.skus[0]?.id, 'GB');
    console.log('Normalized product:\n', JSON.stringify({ ...p, description: p.description.slice(0, 200) }, null, 2));
    console.log('\nRaw responses saved in probe/. Check that no field above is null that the raw JSON actually has.');
  } else console.log('Usage: node src/aliexpress.js auth <code> | probe "<keywords>"');
}
