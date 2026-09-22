# Patch Estimator

Mobile patch estimator for **Cody Decker / 24 Hour Flood Pros**. It prices drywall-only and all-inclusive patches for **POR-STR** and **POR-MIT** jobs, builds a PDF on the phone, and attaches that PDF to the existing JobNimbus job.

The browser never sees the JobNimbus API key. `jn_server.py` holds the key and is the only thing that talks to JobNimbus.

## Price book

One sheet covers the whole estimate. Drywall and all-inclusive prices are never blended. Each patch is priced on its own (`each`), not per square foot, until it is over 100 SF.

| Size | Drywall only | All-inclusive |
| --- | ---: | ---: |
| Base (once) | $746.00 | $1,040.00 |
| Under 10 SF | $97.00 each | $146.00 each |
| 10–30 SF | $136.00 each | $202.00 each |
| 30–50 SF | $190.00 each | $279.00 each |
| 50–100 SF | $266.00 each | $385.00 each |
| Over 100 SF | Custom $ / SF | Custom $ / SF |

Size edges, so a patch lands in one bucket:

- Under 10: less than 10 SF
- 10–30: 10 through 30 SF
- 30–50: more than 30 through 50 SF
- 50–100: more than 50 through 100 SF
- Over 100: custom $ per SF

Patches at 100 SF and under use the inspect-locked each price. Over 100 SF has no inspect lock: the tech enters the $ per SF.

Manual add-ons use the same rates on either sheet:

- Skim coat: $7.80 / SF
- Paint: $3.16 / SF

## What the phone does

- Job search sits at the top. It asks the server for live JobNimbus matches (no cached job list), waits about 300ms after typing, and searches again when the field is focused.
- Only jobs with `POR-STR` or `POR-MIT` in the name, class, or workflow are shown. A hyphen, dash, or space between the parts is accepted.
- Download PDF uses the vendored jsPDF build. The job name is on the PDF and in the file name.
- Send to JobNimbus asks for confirmation, then posts the PDF. It does not create a job.

## JobNimbus behavior

`GET /api/jobnimbus/jobs?q=` requires at least 2 characters. The server searches JobNimbus with an Elasticsearch wildcard and then keeps only open POR-STR / POR-MIT jobs whose name, class, or workflow contains the query.

`POST /api/jobnimbus/send` accepts `{ jobName, filename, pdfBase64, jobJnid? }`.

- With `jobJnid`, the server loads that job, checks it is POR-STR or POR-MIT, and attaches the PDF.
- Without `jobJnid`, it resolves the name: one exact case-insensitive name match, otherwise one unique contains match.
- The PDF is attached with `POST /api1/files` (`type` 1 Document, `related` the job id, `subtype` `job`, `persist` true).
- Nothing in this app creates a JobNimbus job.

API responses send `Cache-Control: no-store`. Request bodies over 20 MB are rejected.

## Run locally

```bash
export JOBNIMBUS_API_KEY="your-key"
python jn_server.py
```

Open `http://127.0.0.1:8765`. The key is read from the environment only. The process listens on `0.0.0.0` and `PORT` (default `8765`).

Without the key, the estimator still loads. Job search and send return a clear error until the key is set.

```bash
python -m unittest discover -s tests -v
node tests/test_pricing.js
```

## Deploy

See [DEPLOY.md](DEPLOY.md) for the shared Render URL used by every phone, plus the Docker image.

## Security

- Do not commit `JOBNIMBUS_API_KEY`. `render.yaml` marks it `sync: false` so the value stays in the host dashboard.
- The server does not log or return the key.
- Share the field URL with the crew only. Anyone with the URL can search those jobs and attach a PDF. The key itself stays on the server.
