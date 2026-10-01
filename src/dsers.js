// DSers product data (search + detail) for the cloud run, used while there is no AliExpress Open Platform app.
// Reads the same DSers catalogue the DSers web app shows, with an OAuth login made on DSers' own page.
// The cloud has its OWN login (separate from the laptop's import login), because DSers replaces the refresh
// token on every renewal: two machines sharing one login would lock each other out.
//   node src/dsers.js cloud-login     one-time: log in, then paste dsers-cloud-login.txt into the GitHub secret
//   node src/dsers.js laptop-login    one-time: the login "Import approved to DSers" uses
//   node src/dsers.js probe "women camel coat"   save raw search + detail replies in probe/ to check field names
import fs from 'node:fs';
import { authorizeWithPKCE, refreshAccessToken } from '@lofder/dsers-mcp-product/dist/auth/oauth.js';

const BFF = 'https://bff-api-gw.dsers.com';
const ALIEXPRESS = '159831080'; // DSers' supplier id for AliExpress
const TOKEN_FILE = process.env.DSERS_TOKEN_FILE || '.dsers-token.json'; // gitignored; kept between runs by the Actions cache
export const stats = { calls: 0 };
let probeDir = null;

// Newest of: the cached token file, or the bootstrap secret (newer after you redo cloud-login).
function loadToken() {
  const cached = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null;
  const boot = process.env.DSERS_TOKEN_BOOTSTRAP ? JSON.parse(process.env.DSERS_TOKEN_BOOTSTRAP) : null;
  const t = [cached, boot].filter(Boolean).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
  if (!t) throw new Error('Missing environment variable DSERS_TOKEN_BOOTSTRAP (run: node src/dsers.js cloud-login)');
  return t;
}
const saveToken = (t) => fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), { mode: 0o600 });

let token = null;
async function accessToken(force = false) {
  token ??= loadToken();
  if (force || Date.now() >= (token.expires_at ?? 0)) {
    try {
      token = { ...token, ...(await refreshAccessToken(token.refresh_token, token.client_id, token.oauth_base)), ts: Date.now() };
    } catch (e) {
      throw new Error(`DSers session expired, redo cloud-login (node src/dsers.js cloud-login): ${e.message}`);
    }
    saveToken(token); // at once: the old refresh token is now dead
  }
  return token.access_token;
}

// GET with backoff: up to 5 retries on network errors, 429 and 5xx (spec 6.3); one re-login on 401.
async function get(path, params, name = path) {
  const url = `${BFF}${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))}`;
  for (let attempt = 0, renewed = false; ; attempt++) {
    try {
      stats.calls++;
      const t = await accessToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${t}`, Cookie: `sessionId=${t}; state=` }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 401 && !renewed) { renewed = true; await accessToken(true); continue; }
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`DSers HTTP ${res.status}`), { retry: true });
      const body = await res.json();
      if (probeDir) fs.writeFileSync(`${probeDir}/${name}.json`, JSON.stringify(body, null, 2));
      if (res.status >= 400) throw new Error(`DSers ${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      return body?.data ?? body;
    } catch (e) {
      const retry = e.retry ?? (e.name === 'TimeoutError' || e instanceof TypeError);
      if (!retry || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 1000));
    }
  }
}

export const searchRaw = (keyword, shipTo, limit, searchAfter) => get('/dsers-product-bff/find-suppliers/products',
  { supplyAppId: ALIEXPRESS, language: 'en-US', keyword, shipTo, limit, searchAfter, sort: 0 }, `search_${shipTo}`);
export const detailRaw = (productId, shipTo) => get('/dsers-product-bff/product-pool/product/detail',
  { productId, appId: ALIEXPRESS, shipTo }, `detail_${shipTo}`);

// Field names come from the DSers connector's own parsers (find-product.js, sku-mapping.js). Anything DSers
// does not return stays null, which the gates treat as UNVERIFIED (spec N-02), never as a pass.
const num = (x) => {
  if (x == null || x === '') return null;
  const n = parseFloat(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const cents = (x) => (num(x) == null ? null : num(x) / 100); // search prices come in cents

// S1 discovery, one page. Returns { items, next } where next is the cursor for the following page.
export async function search(keyword, shipTo, limit, cursor) {
  const d = await searchRaw(keyword, shipTo, limit, cursor);
  const items = (Array.isArray(d?.productPool) ? d.productPool : []).map((p) => ({
    id: String(p.productId),
    title: p.title,
    url: `https://www.aliexpress.com/item/${p.productId}.html`,
    salePrice: cents(p.minPrice),
    priceMax: cents(p.maxPrice),
    orders: num(p.orders),
    rating: num(p.rating),
    shipCost: cents(p.logisticsCost),
    image: p.mainImgUrl,
  }));
  return { items, next: d?.searchAfter || null };
}

// S3 enrich. ship: { US: cost, GB: cost, CA: cost } from the per-country searches (undefined = not seen there).
export async function detail(disc, ship) {
  const d = await detailRaw(disc.id, 'US');
  const variants = Array.isArray(d?.variants) ? d.variants : [];
  // Variant prices: dollars or cents is not documented, so calibrate against the search price (known cents).
  const raw = variants.map((v) => num(v.price ?? v.cost)).filter((x) => x != null).sort((a, b) => a - b);
  const scale = raw.length && disc.salePrice && raw[0] / disc.salePrice > 20 ? 0.01 : 1;
  const opt = (v, re) => (Array.isArray(v.options) ? v.options : []).find((o) => re.test(o.optionName ?? ''))?.valueName ?? null;
  const store = num(d?.storeInfo?.totalRating);
  return {
    id: disc.id, url: disc.url, title: d?.title ?? disc.title,
    orders: disc.orders, salePrice: disc.salePrice, originalPrice: null,
    rating: num(d?.rating) ?? disc.rating, reviews: null, photoReviews: null,
    statusType: variants.length ? 'onSelling' : null,
    store: { id: d?.storeInfo?.storeId ?? null, name: d?.storeInfo?.storeName ?? null, dsr: store != null && store <= 5 ? [store] : null, positive: null, ageYears: null },
    processingDays: null, brand: '', composition: null, attrsText: '', description: '',
    images: (Array.isArray(d?.medias) ? d.medias : []).map((m) => (typeof m === 'string' ? m : m?.url)).filter(Boolean),
    skus: variants.map((v) => ({
      id: String(v.variantId ?? v.sku ?? ''), price: num(v.price ?? v.cost) == null ? null : num(v.price ?? v.cost) * scale,
      stock: num(v.stock), colour: opt(v, /colou?r/i), size: opt(v, /size/i),
    })),
    // DSers quotes a cost per country but no delivery days or tracking: those stay UNVERIFIED.
    freight: Object.fromEntries(['US', 'GB', 'CA'].map((c) => [c, ship[c] == null ? null : [{ method: 'DSers quote', cost: ship[c], days: null, tracked: null }]])),
  };
}

// Login helpers for DSers' OAuth page, used by cloud-login and the laptop's import login:
// - the connector opens the link with `cmd /c start`, which cuts it at the first "&" on Windows, so print it and open it intact;
// - DSers' token endpoint can answer 429 for a while, so wait and retry instead of losing the login.
async function fixLoginHelpers() {
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const spawn = cp.spawnSync;
  cp.spawnSync = (cmd, args, o) => {
    const url = args.at(-1);
    console.log(`\nLog in to DSers here (opening it now):\n${url}\n`);
    return process.platform === 'win32' ? spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${url}'`], o) : spawn(cmd, args, o);
  };
  syncBuiltinESMExports();
  const fetchOnce = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    for (let a = 0; ; a++) {
      const res = await fetchOnce(url, init);
      if (res.status !== 429 || a >= 6) return res;
      console.log(`DSers is busy, retrying in ${2 ** a * 10}s...`);
      await new Promise((r) => setTimeout(r, 2 ** a * 10_000));
    }
  };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'cloud-login') {
    await fixLoginHelpers();
    // A fresh client registration, so this login is independent of the laptop's import login.
    const t = await authorizeWithPKCE((m) => console.log(m), null);
    fs.writeFileSync('dsers-cloud-login.txt', JSON.stringify(t));
    console.log('\nSaved dsers-cloud-login.txt. Paste its whole content into the GitHub secret DSERS_TOKEN_BOOTSTRAP, then delete the file.');
    saveToken(t); // also lets you run the probe on this laptop
  } else if (cmd === 'laptop-login') {
    // The connector's own login (saved encrypted in your user folder), used by "Import approved to DSers".
    await fixLoginHelpers();
    process.argv = [process.argv[0], 'dsers-mcp-product', 'login'];
    await import('@lofder/dsers-mcp-product/dist/cli.js');
  } else if (cmd === 'probe') {
    probeDir = 'probe'; fs.mkdirSync(probeDir, { recursive: true });
    const s = await searchRaw(arg || 'women camel coat', 'US', 5);
    const first = s?.productPool?.[0];
    if (!first) throw new Error(`No search results: ${JSON.stringify(s).slice(0, 300)}`);
    for (const c of ['US', 'GB', 'CA']) await detailRaw(first.productId, c);
    await searchRaw(arg || 'women camel coat', 'CA', 5);
    console.log(`Saved raw replies for product ${first.productId} in probe/. No tokens are written there.`);
  } else console.log('Usage: node src/dsers.js cloud-login | laptop-login | probe "<keywords>"');
}
