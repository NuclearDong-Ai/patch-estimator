# Deploy the Patch Estimator

This is the field app for 24 Hour Flood Pros. One public URL serves every phone. Techs can install it as a home-screen app. The JobNimbus key stays on the host.

## Render free web service

1. Push this repo and open [Render](https://render.com).
2. **New → Blueprint** and select the repo. Render reads `render.yaml`.
   - Service name: `patch-estimator`
   - Plan: **free**
   - Start command: `python jn_server.py`
3. When Render asks for `JOBNIMBUS_API_KEY`, paste the JobNimbus key. `sync: false` means the key is **not** in the repo and is not overwritten by later blueprint syncs.
4. Deploy. Render assigns a URL such as `https://patch-estimator.onrender.com`.

That URL is the one every phone uses. You do not deploy a copy per person.

### Connect the repo without the blueprint

- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `python jn_server.py`
- Instance type: Free
- Environment: `JOBNIMBUS_API_KEY` = the JobNimbus key
- Health check path: `/`

`requirements.txt` is intentionally empty. The server uses the Python standard library only. `PYTHON_VERSION` in the blueprint is `3.12.8`; change that value if Render no longer offers that patch release.

`Procfile` is the same start command (`web: python jn_server.py`) for hosts that read a Procfile instead of `render.yaml`.

## Free-tier behavior

Render free web services sleep after a stretch of no traffic. The first phone to open the URL after sleep can wait about a minute while the service wakes. Later phones hit the same awake URL. There is no disk to keep and no job cache: each search calls JobNimbus live.

## Install on phones

Send the Render URL to the crew.

**iPhone:** open the URL in Safari → Share → Add to Home Screen. The icon is Patch Estimator. Pricing and a saved draft work from the home screen; search and send need a connection.

**Android:** open the URL in Chrome → menu → Install app or Add to Home screen.

The service worker caches the estimator shell so a dead spot does not wipe the page. `/api/` is never cached.

## What the crew does

1. Search the job (POR-STR or POR-MIT) and pick it.
2. Choose Drywall only or All-inclusive. Do not expect the two sheets to mix.
3. Enter each patch. 100 SF and under is inspect-locked. Over 100 SF needs a custom $ per SF.
4. Add skim and paint square feet when they apply.
5. Download PDF, or Send to JobNimbus and confirm. The job name is on the PDF and in the file name. Send attaches the file to the existing job and does not create one.

## Docker

```bash
docker build -t patch-estimator .
docker run --rm -p 8765:8765 -e JOBNIMBUS_API_KEY="your-key" -e PORT=8765 patch-estimator
```

The image is `python:3.12-slim` and runs as a non-root user. Pass the key at run time. Do not bake it into the image.

Render's blueprint uses the native Python runtime, which fits the free plan. Use the Docker image when the host should run the container instead.

## Keep the key out of git

Do not put the key in `render.yaml`, the Dockerfile, a commit, or the browser. If a host log ever echoes an upstream error, the server redacts the key before it is written or returned.

The shared URL is a tool, not a public page. Anyone who has it can look up POR-STR / POR-MIT jobs and attach a PDF. Send it to the crew, not to a marketing page or a search index (`robots.txt` already disallows crawlers).
