# Vourelle sourcing bot

Every day, in GitHub's cloud (your laptop can be off), the bot:

1. searches AliExpress for every enabled row in `vourelle_taxonomy.csv`, Hero rows first;
2. checks each product against the spec's gates, red flags, palette, blocklist and pricing formula (`docs/Vourelle_Sourcing_Bot_Spec.pdf`);
3. stops at **50 products a day** (the count resets at 23:59 Singapore time), or at 18:30, whichever comes first;
4. writes `output/vourelle_candidates_YYYY-MM-DD.xlsx`: one tab per category, in your sheet's layout.

It never imports anything by itself. You decide what goes to DSers.

## Your daily routine (about 2 minutes per product)

1. From 19:00, double-click **Open today's picks.cmd**. Today's workbook opens.
2. In each category tab, read the **What to check** column, open the link, and set **Decision** to `approve` or `reject`.
3. Save and close Excel, then double-click **Import approved to DSers.cmd**. Approved pieces go to the DSers Import List as drafts, at the bot's price, with off-palette colours removed.
4. In DSers, review the drafts and push them to Shopify.

Most rows will say REVIEW, not APPROVED. The AliExpress API doesn't return photo-review counts, store age or store positive feedback, and the spec (N-02) says an unknown value is never a pass. That's why **What to check** lists them.

## One-time setup

**1. AliExpress Open Platform** (official API; the spec forbids scraping the site because a ban would also stop DSers orders)
- Sign in at https://openservice.aliexpress.com with your AliExpress account (the one linked to DSers). Register as a developer, create an app, and apply for the **Affiliate API** and **Dropshipping API**. Approval can take a few days.
- Note the **App Key** and **App Secret**. Get a **tracking ID** at https://portals.aliexpress.com.
- Authorize the app: open `https://api-sg.aliexpress.com/oauth/authorize?response_type=code&force_auth=true&client_id=APP_KEY&redirect_uri=YOUR_APP_CALLBACK_URL`, log in, then copy the `code=` value from the page you land on. In PowerShell, in this folder:
  ```powershell
  $env:AE_APP_KEY="..."; $env:AE_APP_SECRET="..."; $env:AE_TRACKING_ID="..."
  node src/aliexpress.js auth THE_CODE
  ```
  This prints `access_token`. When it expires, repeat this step and update the secret.
- Check the field mapping once: `$env:AE_ACCESS_TOKEN="..."; node src/aliexpress.js probe "women camel coat"`. If a value prints as `null` but appears in `probe/*.json`, tell Claude Code which field it is.

**2. Claude API key (optional, recommended)**: https://console.anthropic.com. This runs the premium-look photo check (spec 3.5). Without it, every product goes to REVIEW and you judge the photos yourself. To cut cost, set `vision_model: claude-haiku-4-5` in the config.

**3. GitHub** (runs the bot while your laptop is off)
- Create a free account and a **private** repository, then push this folder to it.
- Go to Settings > Secrets and variables > Actions, and add: `AE_APP_KEY`, `AE_APP_SECRET`, `AE_TRACKING_ID`, `AE_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`.
- Go to the Actions tab > Daily sourcing > **Run workflow** for a first test. After that it runs every day at 15:00 Singapore time. GitHub emails you if a run fails.

**4. DSers**: double-click **Setup - DSers login.cmd**. It opens DSers' own login page. Your password goes only to DSers, and the session is saved encrypted on this laptop. Then, in DSers settings, turn price overwriting off (the bot owns prices) and turn stock sync on (spec 8.2).

## Settings

Every number is in `vourelle_bot_config.yaml`: the daily cap (`throughput`), stop time and time zone (`run`), and the margin, ROAS, shipping and gate thresholds. Change a value there and the next run uses it. The cloud start time is the `cron` line in `.github/workflows/daily.yml`, in UTC.

## Not built yet (spec sections)

- S6 duplicate clustering and backup suppliers (F-03, DSers backup mapping)
- S8 Vourelle titles and copy, and 8.3 Shopify enrichment. You edit titles in DSers for now.
- S11 twice-daily monitoring of live products

`npm test` runs the spec's acceptance tests (section 11). `docs/sample_workbook_FAKE_DATA.xlsx` shows the workbook layout filled with made-up data.
