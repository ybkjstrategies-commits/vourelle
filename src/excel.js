// S9 output (spec 7). One tab per category in the founder's sheet layout (Product / Cost / Shipping / Delivery /
// Past Sale), with the Vourelle check columns to the right, plus README, Pass_Rates, Rejected, Reason_Codes, Config_Snapshot.
import ExcelJS from 'exceljs';
import { CODES } from './logic.js';

const FILL = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const STATUS_FILL = { APPROVED: 'FFC6EFCE', REVIEW: 'FFFFEB9C', REJECTED: 'FFFFC7CE', IMPORTED: 'FFBDD7EE' };
const WHITE_BOLD = { bold: true, color: { argb: 'FFFFFFFF' } };
const NAVY = 'FF1F2A44', IVORY = 'FFFAF7F0';

// [group label, group colour, [column header, width, value fn, number format]]
const GROUPS = (cat) => [
  [cat, 'FF000000', [['#', 5, (r, i) => i + 1], ['Product Name', 45, (r) => r.title]]],
  ['Product', 'FF000000', [['Source', 12, () => 'Ali Express'], ['Listed Website', 55, (r) => ({ text: r.url, hyperlink: r.url })]]],
  ['Cost ($USD)', 'FFE03C31', [['Low (USD)', 11, (r) => r.priceLow, '$0.00'], ['High (USD)', 11, (r) => r.priceHigh, '$0.00']]],
  ['Shipping ($USD)', 'FF4F7A28', [['US', 9, (r) => r.ship?.US?.cost, '$0.00'], ['UK', 9, (r) => r.ship?.GB?.cost, '$0.00'], ['Canada', 9, (r) => r.ship?.CA?.cost, '$0.00']]],
  ['Delivery (Days)', 'FFB8962E', [['US', 8, (r) => r.ship?.US?.totalDays], ['UK', 8, (r) => r.ship?.GB?.totalDays], ['Canada', 8, (r) => r.ship?.CA?.totalDays]]],
  ['Past Sale', 'FF000000', [['Orders', 10, (r) => r.orders]]],
  ['Vourelle checks', NAVY, [
    ['Subcategory', 26, (r) => r.subcategory], ['Role', 8, (r) => r.role], ['Status', 11, (r) => r.status], ['Score', 7, (r) => r.score],
    ['Price USD', 10, (r) => r.pricing?.priceUsd, '$0'], ['Price GBP', 10, (r) => r.pricing?.priceGbp, '£0'], ['Price CAD', 10, (r) => r.pricing?.priceCad, '"C$"0'],
    ['Markup', 8, (r) => r.pricing?.markup, '0.00"x"'], ['Net margin', 10, (r) => r.pricing?.netMargin, '0.0%'], ['Headroom', 10, (r) => r.pricing?.headroom, '0.0%'],
    ['Palette colours', 22, (r) => r.paletteColours?.join(', ')], ['Dropped colours', 20, (r) => r.offPalette?.join(', ')], ['Sizes', 16, (r) => r.sizes?.join(', ')],
    ['Rating', 7, (r) => r.rating ?? 'UNVERIFIED'], ['Reviews', 8, (r) => r.reviews ?? 'UNVERIFIED'], ['Photo reviews', 9, () => 'UNVERIFIED'],
    ['Store', 20, (r) => r.store?.name], ['Stock', 9, (r) => r.stockTotal ?? 'UNVERIFIED'],
    ['Premium look', 9, (r) => r.vision?.score ?? 'UNVERIFIED'], ['White-label', 11, (r) => r.whitelabel], ['Composition', 24, (r) => r.composition],
    ['Claims allowed', 30, (r) => r.claims && Object.entries(r.claims).map(([k, v]) => `${k}:${v ? 'yes' : 'no'}`).join(' ')],
    ['Google category', 30, (r) => r.googleCategory], ['Flags', 14, (r) => [...(r.flags ?? []), ...(r.unverified ?? [])].join(', ')],
    ['What to check', 60, (r) => r.human], ['Decision', 11, () => null], ['Product ID', 18, (r) => r.id],
  ]],
];

function categorySheet(wb, cat, rows) {
  const ws = wb.addWorksheet(cat.slice(0, 31));
  const groups = GROUPS(cat);
  let col = 1;
  for (const [label, colour, cols] of groups) {
    const end = col + cols.length - 1;
    if (end > col) ws.mergeCells(1, col, 1, end);
    Object.assign(ws.getCell(1, col), { value: label, fill: FILL(colour), font: { ...WHITE_BOLD, size: 12 }, alignment: { horizontal: 'center' } });
    cols.forEach(([header, width, , fmt], i) => {
      const c = ws.getCell(2, col + i);
      Object.assign(c, { value: header, fill: FILL(colour), font: WHITE_BOLD, alignment: { horizontal: 'center', wrapText: true } });
      ws.getColumn(col + i).width = width;
      if (fmt) ws.getColumn(col + i).numFmt = fmt;
    });
    col = end + 1;
  }
  const flat = groups.flatMap(([, , cols]) => cols);
  const statusCol = flat.findIndex(([h]) => h === 'Status') + 1;
  const decisionCol = flat.findIndex(([h]) => h === 'Decision') + 1;
  rows.forEach((r, i) => {
    const row = ws.addRow(flat.map(([, , fn]) => fn(r, i) ?? null));
    const link = row.getCell(4);
    if (link.value?.hyperlink) link.font = { color: { argb: 'FF1155CC' }, underline: true };
    row.getCell(statusCol).fill = FILL(STATUS_FILL[r.status] ?? 'FFFFFFFF');
    row.getCell(decisionCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"approve,reject"'] };
    row.getCell(decisionCol).fill = FILL('FFFFF2CC');
  });
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 2 }];
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: flat.length } };
}

function simpleSheet(wb, name, headers, rows) {
  const ws = wb.addWorksheet(name);
  ws.addRow(headers).eachCell((c) => Object.assign(c, { fill: FILL(IVORY), font: { bold: true, color: { argb: NAVY } } }));
  rows.forEach((r) => ws.addRow(r));
  headers.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(12, Math.min(60, h.length + 4, ...rows.map((r) => String(r[i] ?? '').length + 2))); });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return ws;
}

const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, Array.isArray(v) ? v.join(', ') : v]]);

// shown: today's APPROVED/REVIEW records; rejected: last 30 days; run: today's stats
export async function writeWorkbook(file, { date, shown, rejected, run, cfg, categories }) {
  const wb = new ExcelJS.Workbook();
  const counts = {};
  for (const r of [...shown, ...rejected.filter((r) => r.date === date)]) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const readme = simpleSheet(wb, 'README', ['Item', 'Value'], [
    ['Run date', date], ['Finished', run.finishedAt ?? ''], ['Config version', cfg.version],
    ...Object.entries(counts).map(([s, n]) => [`${s} today`, n]),
    ['Products scanned', run.scanned], ['Passed pre-filter', run.prefiltered], ['Fully checked', run.evaluated], ['API errors', run.errors], ['AliExpress API calls', run.apiCalls],
    ['How to import', 'In each category tab pick "approve" in the Decision column, save, close Excel, then double-click "Import approved to DSers".'],
    ['Why most rows say REVIEW', 'The AliExpress API does not give photo-review counts or store age, so the spec treats those as unverified. The "What to check" column says what to look at.'],
  ]);
  readme.getColumn(2).width = 90;

  const byCat = Object.groupBy(shown, (r) => r.category);
  for (const cat of categories) {
    const rows = (byCat[cat] ?? []).sort((a, b) => a.subcategory.localeCompare(b.subcategory) || b.score - a.score);
    if (rows.length) categorySheet(wb, cat, rows);
  }

  const gateRows = Object.entries(run.gates ?? {}).sort((a, b) => b[1] - a[1]).map(([code, n]) => [code, CODES[code] ?? '', n]);
  simpleSheet(wb, 'Pass_Rates', ['Gate or flag', 'Meaning', 'Products stopped'], [
    ...gateRows, [], ['Country', 'Passed shipping gates', 'Failed shipping gates'],
    ...['US', 'GB', 'CA'].map((c) => [c, run.countries?.[c]?.pass ?? 0, run.countries?.[c]?.fail ?? 0]),
  ]);
  simpleSheet(wb, 'Rejected', ['Date', 'Category', 'Subcategory', 'Product', 'Reasons', 'Product ID', 'URL'],
    rejected.sort((a, b) => b.date.localeCompare(a.date)).map((r) => [r.date, r.category, r.subcategory, r.title, (r.reasons ?? []).join(', '), r.id, r.url]));
  simpleSheet(wb, 'Reason_Codes', ['Code', 'Meaning'], Object.entries(CODES));
  simpleSheet(wb, 'Config_Snapshot', ['Key', 'Value'], flatten(cfg));
  await wb.xlsx.writeFile(file);
}

// Import reads the Decision column back: [{id, decision}]
export async function readDecisions(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out = [];
  wb.eachSheet((ws) => {
    const headers = ws.getRow(2).values;
    const d = headers.indexOf('Decision'), id = headers.indexOf('Product ID');
    if (d < 0 || id < 0) return;
    ws.eachRow((row, n) => {
      const decision = String(row.getCell(d).value ?? '').trim().toLowerCase();
      if (n > 2 && ['approve', 'reject'].includes(decision)) out.push({ id: String(row.getCell(id).value), decision });
    });
  });
  return out;
}
