Patch Estimator PWA — upload this folder to Netlify Drop (index.html at root).
Local (with JobNimbus attach):
  python3 /workspace/patch-estimator/jn_server.py
  Open http://127.0.0.1:8765/
Static-only fallback: python3 -m http.server 8080 (no JN API)

Pricing: two separate sheets (Drywall only / All-inclusive). Primary counters match
price-sheet SF tiers (Under 10, 10–30, 30–50, 50–100, Over 100). Each count = that
many individual patches priced each at the sheet rate + base once per job.
Over 100 SF: enter SF + custom $ per patch (no Inspect lock). Sheets never blend.
Paint add-on only on drywall sheet; skim on both.
Skim & retexture and Paint use independent typed SF fields ($7.80/SF and $3.16/SF).
Suggested patch SF from tier midpoints can fill both. All-inclusive: skim always; paint SF is optional extra.

PDF: tap Download PDF for a .pdf (Patch-Estimate-YYYY-MM-DD.pdf) to attach in JobNimbus.

JobNimbus: enter Job name, tap Send to JobNimbus — PDF attaches to that job's Files.
Does not create jobs. API key stays on the server only.
