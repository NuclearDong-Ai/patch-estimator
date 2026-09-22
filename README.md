# Patch Estimator

Mobile patch estimator for **Cody Decker / 24 Hour Flood Pros**. It prices drywall-only and all-inclusive patches for **POR-STR** and **POR-MIT** jobs, builds a PDF on the phone, and attaches that PDF to the existing JobNimbus job.

The browser never sees the JobNimbus API key. `jn_server.py` holds the key and is the only thing that talks to JobNimbus.

## Price book

One sheet covers the whole estimate. Drywall and all-inclusive prices are never blended. Patches are counted with sheet-tier steppers and priced **each**, not as freeform square-foot rows.

| Tier | Drywall only | All-inclusive |
| --- | ---: | ---: |
| Base (once, when there is at least one patch) | $746.00 | $1,040.00 |
| Under 10 SF | $97.00 each | $146.00 each |
| 10–30 SF | $136.00 each | $202.00 each |
| 30–50 SF | $190.00 each | $279.00 each |
| 50–100 SF | $266.00 each | $385.00 each |
| Over 100 SF | Custom $ and SF, per patch | Custom $ and SF, per patch |

There is no inspect lock. The dollar total always calculates (`inspect: false`), including while an Over 100 row is still missing SF or a custom dollar amount. That incomplete row adds a soft note so the tech can finish it; it does not block the total.

Manual add-ons use the same rates on either sheet. Type the square feet; they are not derived from the tier counters:

- Skim & retexture: $7.80 / SF
- Paint: $3.16 / SF

## What the phone does

- Job search sits at the top. It asks the server for live JobNimbus matches (no cached job list), waits about 300ms after typing, and searches again when the field is focused.
- Sheet toggle is **Drywall only** or **All-inclusive**. Switching sheets replaces every tier rate. The two sheets are never mixed on one quote.
- Counts use steppers: Under 10, 10–30, 30–50, 50–100, and Over 100. Over 100 opens one SF + custom $ row per counted patch.
- Download PDF uses the vendored jsPDF build. The job name is on the PDF and in the file name (`Patch-Estimate-<job>-YYYY-MM-DD.pdf`).
- Send to JobNimbus asks for confirmation, then posts the PDF. It does not create a job.

## JobNimbus behavior

`GET /api/jobnimbus/jobs?q=` requires at least 2 characters. Every search calls JobNimbus live (no job-list cache) and keeps POR-STR / POR-MIT jobs. Responses send `Cache-Control: no-store`.

`POST /api/jobnimbus/send` accepts `{ jobName, filename, pdfBase64, jobJnid? }`.

- With `jobJnid`, the server loads that job, checks it is POR-STR or POR-MIT, and attaches the PDF.
- Without `jobJnid`, it resolves the name: one exact case-insensitive name match, otherwise one unique contains match.
- The PDF is attached with `POST /api1/files` (`type` 1 Document, `related` the job id, `subtype` `job`, `persist` true).
- Nothing in this app creates a JobNimbus job.

Request bodies over 20 MB are rejected. The process listens on `0.0.0.0` and `PORT` (default `8765`). The key is read from `JOBNIMBUS_API_KEY`, or from the local secrets file the server already checks. The key is not written into the repo.

## Run locally

```bash
export JOBNIMBUS_API_KEY="your-key"
python jn_server.py
```

Open `http://127.0.0.1:8765`. The server exits at startup if the key is missing, so the field URL and the JobNimbus routes come up together.

```bash
python -m unittest discover -s tests -v
node tests/test_pricing.js
```

## Deploy

See [DEPLOY.md](DEPLOY.md) for the shared Render URL used by every phone, plus the Docker image.

## Security

- Do not commit `JOBNIMBUS_API_KEY`. `render.yaml` marks it `sync: false` so the value stays in the host dashboard.
- The server does not log the key.
- Share the field URL with the crew only. Anyone with the URL can search those jobs and attach a PDF. The key itself stays on the server.
