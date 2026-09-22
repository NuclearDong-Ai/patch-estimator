# Deploy Patch Estimator (shared HTTPS for all phones)

One permanent HTTPS URL. Any tech opens it and uses **Add to Home Screen**.
No per-device install beyond the PWA. JobNimbus API key stays **server-side only**
(never in the PWA / browser).

The phone UI is the counter app: **Drywall only** or **All-inclusive** (never blended), with steppers for Under 10, 10–30, 30–50, 50–100, and Over 100. There is no inspect lock. The dollar total always works. Over 100 asks for SF and a custom dollar amount per patch, and a soft note appears if those fields are still empty. Skim is typed SF at $7.80 and paint is typed SF at $3.16.

## Render (free Web Service)

`render.yaml` is a free web service named `patch-estimator`. `JOBNIMBUS_API_KEY` is `sync: false` — paste it in the Render dashboard. Do not put the key in git.

1. Push this repo (or connect the folder) to GitHub/GitLab.
2. In [Render](https://render.com): **New → Blueprint** and select the repo, or **New → Web Service**.
3. Settings if you create the service by hand:
   - **Root Directory:** leave blank when the repo root is this folder
   - **Runtime:** Python
   - **Plan:** Free
   - **Build Command:** leave empty (no build step)
   - **Start Command:** `python jn_server.py`
4. Environment:
   - `JOBNIMBUS_API_KEY` = your JobNimbus API key (required; never commit it)
5. Deploy. Render assigns a stable HTTPS URL like `https://patch-estimator-xxxx.onrender.com`.
6. Share that URL with every tech. On each phone: open in Safari/Chrome → **Add to Home Screen**.

`Procfile` is the same start command (`web: python jn_server.py`) for hosts that read a Procfile instead of `render.yaml`.

### Notes

- Free tier may sleep after idle; first open can be slow, then fine.
- The server requires the key at startup (`JOBNIMBUS_API_KEY`, or the local secrets file it already reads). It serves `public-deploy/` at `/` and JobNimbus under `/api/jobnimbus/*`.
- Job search is live. There is no job-list cache on the server or in the phone app.

## What the crew does

1. Search the job (POR-STR or POR-MIT) at the top and pick it. Search waits about 300ms and runs again when the field is focused.
2. Choose Drywall only (base $746) or All-inclusive (base $1,040). The other sheet’s rates do not stay on the quote.
3. Count patches in each tier. Over 100 SF needs SF and a custom $ on that row. The total still shows if a custom field is blank.
4. Type skim SF ($7.80) and paint SF ($3.16) when they apply.
5. Download PDF, or Send to JobNimbus and confirm. The job name is on the PDF and in the file name. Send attaches the file to the existing job and does not create one.

## Docker (optional)

```bash
docker build -t patch-estimator .
docker run -p 8765:8765 -e JOBNIMBUS_API_KEY=your_key patch-estimator
```

The image is `python:3.12-slim`. Pass the key at run time. Do not bake it into the image.

## Keep the key out of git

Do not put the key in `render.yaml`, the Dockerfile, a commit, or the browser. `sync: false` keeps a later blueprint sync from overwriting the dashboard value.
