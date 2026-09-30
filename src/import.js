// S10 import (spec 8.1 option A): send the products you marked "approve" in the workbook to the DSers Import List.
// Runs on your laptop, only when you start it. Uses the DSers connector (@lofder/dsers-mcp-product, pinned) with the
// login you made once on DSers' own page; your password never passes through this code.
// Usage: node src/import.js [workbook.xlsx]   (default: the newest workbook in "My picks", else output/)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readDecisions } from './excel.js';

const DECISIONS = 'state/decisions.json';
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const newest = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^vourelle.*\.xlsx$/.test(f)).sort().map((f) => `${dir}/${f}`).at(-1) : null);
const file = process.argv[2] ?? newest('My picks') ?? newest('output');
if (!file) throw new Error('No workbook found in "My picks" or output/');

const state = readJson('state/state.json', { products: {} });
const decisions = readJson(DECISIONS, {});
const save = () => fs.writeFileSync(DECISIONS, JSON.stringify(decisions, null, 1));
const marked = (await readDecisions(file)).filter((d) => !decisions[d.id]?.imported);
console.log(`${file}: ${marked.filter((d) => d.decision === 'approve').length} to import, ${marked.filter((d) => d.decision === 'reject').length} rejected`);

for (const d of marked.filter((d) => d.decision === 'reject')) decisions[d.id] = { decision: 'reject', at: new Date().toISOString() };
save();

const toImport = marked.filter((d) => d.decision === 'approve');
if (toImport.length) {
  const bin = createRequire(import.meta.url).resolve('@lofder/dsers-mcp-product/dist/cli.js');
  const client = new Client({ name: 'vourelle-import', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: 'ignore' }));
  const importOne = (url, rules) => client.callTool({
    name: 'dsers_product_import',
    arguments: { source_url: url, country: 'US', visibility_mode: 'backend_only', rules_json: JSON.stringify(rules) },
  });
  let ok = 0;
  for (const { id } of toImport) {
    const r = state.products[id];
    const url = r?.url ?? `https://www.aliexpress.com/item/${id}.html`;
    // The bot owns the price (spec 8.2) and off-palette colours are not published (3.3)
    const rules = { ...(r?.pricing ? { pricing: { mode: 'fixed_price', fixed_price: r.pricing.priceUsd } } : {}) };
    const edits = (r?.offPalette ?? []).map((v) => ({ action: 'remove_value', option_name: 'Color', value_name: v }));
    let res = await importOne(url, { ...rules, ...(edits.length ? { option_edits: edits } : {}) });
    let note = '';
    if (res.isError && edits.length) {
      res = await importOne(url, rules);
      note = ` (delete these colours by hand in DSers: ${r.offPalette.join(', ')})`;
    }
    const text = res.content?.map((c) => c.text).join(' ') ?? '';
    if (res.isError) {
      console.log(`FAILED ${id} ${r?.title ?? ''}: ${text.slice(0, 300)}`);
      if (/login|auth|credential|token|unauthori[sz]ed/i.test(text)) { console.log('\nDSers login missing or expired: double-click "Setup - DSers login.cmd", then try again.'); break; }
      continue;
    }
    decisions[id] = { decision: 'approve', imported: true, at: new Date().toISOString(), subcategory: r?.subcategory };
    save(); // after every product, so a crash never imports the same product twice
    ok++;
    console.log(`Imported ${id} ${r?.title ?? ''} at $${r?.pricing?.priceUsd ?? '?'}${note}`);
  }
  await client.close();
  console.log(`\nDone: ${ok}/${toImport.length} imported to the DSers Import List. Review them there, then push to Shopify.`);
}
