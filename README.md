# Vourelle sourcing bot

Every day, in GitHub's cloud (your laptop can be off), the bot:

1. searches the AliExpress catalogue (through your DSers account) for every enabled row in `vourelle_taxonomy.csv`, Hero rows first;
2. checks each product against the spec's gates, red flags, palette, blocklist and pricing formula (`docs/Vourelle_Sourcing_Bot_Spec.pdf`);
3. stops at **50 products a day** (the count resets at 23:59 Singapore time), or at 18:30, whichever comes first;
4. writes `output/vourelle_candidates_YYYY-MM-DD.xlsx`: one tab per category, in your sheet's layout.

It never imports anything by itself. You decide what goes to DSers.

## Your daily routine (about 2 minutes per product)

1. From 19:00, double-click **Open today's picks.cmd**. Today's workbook opens.
2. The **README** tab lists the checks that apply to every product. In each category tab, open the link, do those checks plus anything in **What to check**, and set **Decision** to `approve` or `reject`.
3. Save and close Excel, then double-click **Import approved to DSers.cmd**. Approved pieces go to the DSers Import List as drafts, at the bot's price, with off-palette colours removed.
4. In DSers, review the drafts and push them to Shopify.

Every row will say REVIEW, not APPROVED. DSers' data has prices, colours, sizes, stock, ratings, photos and a shipping cost per country, but no delivery days, review counts, store age or fabric. The spec (N-02) says an unknown value is never a pass, so you check those by hand.

## Where the product data comes from

The bot reads the catalogue through DSers (the same data the DSers web app shows), using a DSers login you approve on DSers' own page. It does not scrape AliExpress (spec N-01). The official AliExpress Open Platform API (`src/aliexpress.js`, already built) gives fuller data, including delivery days, fabric and review counts, but it needs a registered business. To switch once you have one, change the import at the top of `src/run.js` and follow the "AliExpress Open Platform" steps in the git history of this README.

## One-time setup

**1. DSers login for the cloud** (separate from the laptop's, because DSers replaces the login on every renewal)
- In PowerShell, in this folder: `node src/dsers.js cloud-login`. Log in on the DSers page that opens and approve access.
- It writes `dsers-cloud-login.txt`. On GitHub, go to Settings > Secrets and variables > Actions > **New repository secret**, name it `DSERS_TOKEN_BOOTSTRAP`, paste the file's whole content, then delete the file.
- The cloud renews this login on every run and keeps the newest copy in GitHub's private Actions cache. If a run ever fails with "DSers session expired", repeat this step.

**2. DSers login for importing**: double-click **Setup - DSers login.cmd** and log in the same way. Then, in DSers settings, turn price overwriting off (the bot owns prices) and turn stock sync on (spec 8.2).

**3. Claude API key (optional, recommended)**: https://console.anthropic.com. Add it as the secret `ANTHROPIC_API_KEY`. This runs the premium-look photo check (spec 3.5); without it you judge the photos yourself. To cut cost, set `vision_model: claude-haiku-4-5` in the config.

**4. First run**: Actions tab > Daily sourcing > **Run workflow**. After that it runs every day at 15:00 Singapore time, and GitHub emails you if a run fails. The code lives in https://github.com/ybkjstrategies-commits/vourelle (keep it **private**).

## Settings

Every number is in `vourelle_bot_config.yaml`: the daily cap (`throughput`), stop time and time zone (`run`), and the margin, ROAS, shipping and gate thresholds. Change a value there and the next run uses it. The cloud start time is the `cron` line in `.github/workflows/daily.yml`, in UTC.

## Not built yet (spec sections)

- S6 duplicate clustering and backup suppliers (F-03, DSers backup mapping)
- S8 Vourelle titles and copy, and 8.3 Shopify enrichment. You edit titles in DSers for now.
- S11 twice-daily monitoring of live products

`npm test` runs the spec's acceptance tests (section 11). `docs/sample_workbook_FAKE_DATA.xlsx` shows the workbook layout filled with made-up data.
