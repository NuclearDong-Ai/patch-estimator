#!/usr/bin/env python3
"""Patch Estimator server for 24 Hour Flood Pros.

Serves the public-deploy PWA and proxies JobNimbus job search plus PDF
attach. This process never creates jobs. The API key is read from the
JOBNIMBUS_API_KEY environment variable and is never logged or returned.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8765"))

JN_BASE = "https://app.jobnimbus.com/api1/"
MAX_BODY = 20 * 1024 * 1024
JN_TIMEOUT = 20
ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public-deploy")

# Hyphen, space, or dash. STR/MIT must end at a word boundary so POR-STRATEGY does not match.
POR_RE = re.compile("por[\\s\\-\u2010-\u2015]+(str|mit)\\b", re.IGNORECASE)
JNID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
IDENTITY_KEYS = (
    "name",
    "class",
    "class_name",
    "workflow",
    "workflow_name",
    "record_type_name",
)
SEARCH_FIELDS = ("name", "class_name", "record_type_name")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}


class AppError(Exception):
    def __init__(self, status: int, message: str, upstream: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.upstream = upstream


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


OPENER = urllib.request.build_opener(_NoRedirect)


def redact(text: str) -> str:
    if not text:
        return text
    key = os.environ.get("JOBNIMBUS_API_KEY", "").strip()
    if key:
        text = text.replace(key, "[redacted]")
    return text


def api_key() -> str:
    key = os.environ.get("JOBNIMBUS_API_KEY", "").strip()
    if not key:
        raise AppError(
            503,
            "JobNimbus is not configured. Set JOBNIMBUS_API_KEY on the server.",
        )
    return key


def _strings_from(value, depth: int = 0):
    if depth > 4 or value is None:
        return
    if isinstance(value, str):
        text = value.strip()
        if text:
            yield text
        return
    if isinstance(value, dict):
        for key in ("name", "workflow_name", "class_name", "label", "title", "value"):
            if key in value:
                yield from _strings_from(value.get(key), depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            yield from _strings_from(item, depth + 1)


def identity_texts(job: dict) -> list[str]:
    texts: list[str] = []
    for key in IDENTITY_KEYS:
        texts.extend(_strings_from(job.get(key)))
    return texts


def job_is_allowed(job: dict) -> bool:
    return any(POR_RE.search(text) for text in identity_texts(job))


def job_is_open(job: dict) -> bool:
    if job.get("is_archived") is True:
        return False
    if job.get("is_active") is False:
        return False
    return True


def first_text(job: dict, *keys: str) -> str:
    for key in keys:
        value = job.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def class_name(job: dict) -> str:
    for key in ("class_name", "class"):
        for text in _strings_from(job.get(key)):
            return text
    return ""


def workflow_name(job: dict) -> str:
    for key in ("workflow_name", "record_type_name", "workflow"):
        for text in _strings_from(job.get(key)):
            return text
    return ""


def format_address(job: dict) -> str:
    line1 = first_text(job, "address_line1", "address_line_1")
    city = first_text(job, "city")
    state = first_text(job, "state_text", "state")
    zip_code = first_text(job, "zip")
    city_line = " ".join(part for part in (city, state) if part)
    if zip_code:
        city_line = (city_line + " " + zip_code).strip()
    return ", ".join(part for part in (line1, city_line) if part)


def public_job(job: dict) -> dict:
    number = job.get("number")
    return {
        "jnid": str(job.get("jnid") or ""),
        "name": first_text(job, "name"),
        "number": "" if number is None else str(number),
        "className": class_name(job),
        "workflowName": workflow_name(job),
        "statusName": first_text(job, "status_name"),
        "address": format_address(job),
    }


def query_matches(job: dict, query: str) -> bool:
    needle = query.casefold()
    return any(needle in text.casefold() for text in identity_texts(job))


def escape_wildcard(text: str) -> str:
    return text.replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")


def wildcard_variants(query: str) -> list[str]:
    variants: list[str] = []
    for candidate in (query, query.casefold(), query.upper()):
        if candidate not in variants:
            variants.append(candidate)
    return variants


def wildcard_filter(query: str, fields: tuple[str, ...] = SEARCH_FIELDS) -> dict:
    should = []
    for variant in wildcard_variants(query):
        pattern = "*" + escape_wildcard(variant) + "*"
        for field in fields:
            should.append({"wildcard": {field: pattern}})
    return {"must": [{"bool": {"should": should, "minimum_should_match": 1}}]}


def http_open(req: urllib.request.Request, timeout: int = JN_TIMEOUT):
    return OPENER.open(req, timeout=timeout)


def jn_request(method: str, path: str, query: dict | None = None, payload: dict | None = None):
    key = api_key()
    url = JN_BASE + path.lstrip("/")
    if query:
        url += "?" + urllib.parse.urlencode(query, quote_via=urllib.parse.quote)
    data = None
    headers = {
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
        "User-Agent": "PatchEstimator/1.0",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with http_open(request) as response:
            raw = response.read()
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp is not None else b""
        status = exc.code
        if status in (301, 302, 303, 307, 308):
            raise AppError(502, "JobNimbus redirected the request, so nothing was changed.", status)
        text = redact(raw.decode("utf-8", "replace"))
        raise AppError(502, human_jn_error(status, text), status)
    except urllib.error.URLError:
        raise AppError(502, "Could not reach JobNimbus. Check the connection and try again.")
    except TimeoutError:
        raise AppError(504, "JobNimbus took too long to answer. Try again.")
    if status < 200 or status >= 300:
        text = redact(raw.decode("utf-8", "replace"))
        raise AppError(502, human_jn_error(status, text), status)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        raise AppError(502, "JobNimbus returned a response that was not JSON.")


def human_jn_error(status: int, body_text: str) -> str:
    message = ""
    try:
        payload = json.loads(body_text) if body_text else {}
    except json.JSONDecodeError:
        payload = {}
    if isinstance(payload, dict):
        for key in ("message", "error", "detail", "Message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                message = value.strip()
                break
    if status == 401:
        return "JobNimbus rejected the API key. Check JOBNIMBUS_API_KEY on the server."
    if status == 403:
        return "JobNimbus refused this request. The API key may not be allowed to read jobs or attach files."
    if status == 404:
        return "JobNimbus could not find that record."
    if status == 429:
        return "JobNimbus is busy right now. Wait a moment and try again."
    if message:
        return "JobNimbus: " + redact(message)[:300]
    return "JobNimbus returned an error (%s)." % status


def extract_jobs(payload) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("results", "jobs"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        if payload.get("jnid") and (payload.get("name") is not None or payload.get("record_type_name") is not None):
            return [payload]
    return []


def extract_file(payload) -> dict:
    candidate = None
    if isinstance(payload, dict):
        files = payload.get("files")
        if isinstance(files, list) and files and isinstance(files[0], dict):
            candidate = files[0]
        elif payload.get("jnid") and payload.get("filename"):
            candidate = payload
    if not candidate:
        return {"jnid": "", "filename": ""}
    return {
        "jnid": str(candidate.get("jnid") or ""),
        "filename": str(candidate.get("filename") or ""),
    }


def _search_page(query_text: str, filt: dict, size: int, offset: int) -> list[dict]:
    payload = jn_request(
        "GET",
        "jobs",
        query={
            "size": str(size),
            "from": str(offset),
            "sort_field": "date_updated",
            "sort_direction": "desc",
            "filter": json.dumps(filt, separators=(",", ":")),
        },
    )
    return extract_jobs(payload)


def search_jobs_raw(query_text: str, size: int = 25, pages: int = 1) -> list[dict]:
    filters = [wildcard_filter(query_text)]
    collected: list[dict] = []
    seen: set[str] = set()

    def absorb(batch: list[dict]) -> None:
        for job in batch:
            jnid = str(job.get("jnid") or "")
            if jnid and jnid in seen:
                continue
            if jnid:
                seen.add(jnid)
            collected.append(job)

    try:
        for page in range(pages):
            batch = _search_page(query_text, filters[0], size, page * size)
            absorb(batch)
            if len(batch) < size:
                break
        return collected
    except AppError as exc:
        if exc.upstream != 400:
            raise
        collected.clear()
        seen.clear()

    for field in SEARCH_FIELDS:
        simple = wildcard_filter(query_text, (field,))
        try:
            batch = _search_page(query_text, simple, size, 0)
        except AppError as exc:
            if exc.upstream == 400 and field != SEARCH_FIELDS[-1] and not collected:
                continue
            if collected:
                break
            raise
        absorb(batch)
    return collected


def search_jobs_public(query_text: str) -> list[dict]:
    query_text = query_text.strip()
    if len(query_text) < 2:
        raise AppError(400, "Type at least 2 characters to search jobs.")
    if len(query_text) > 80:
        raise AppError(400, "That search is too long. Use a shorter job name.")
    if any(ord(ch) < 32 for ch in query_text):
        raise AppError(400, "That search has characters that cannot be used.")
    public = []
    for job in search_jobs_raw(query_text, size=25, pages=1):
        if not job_is_open(job) or not job_is_allowed(job) or not query_matches(job, query_text):
            continue
        item = public_job(job)
        if not item["jnid"] or not item["name"]:
            continue
        public.append(item)
        if len(public) >= 20:
            break
    return public


def fetch_job(jnid: str) -> dict:
    payload = jn_request("GET", "jobs/" + urllib.parse.quote(jnid, safe=""))
    jobs = extract_jobs(payload)
    if isinstance(payload, dict) and payload.get("jnid") and not jobs:
        return payload
    if not jobs:
        raise AppError(404, "JobNimbus could not find that job.")
    return jobs[0]


def resolve_job_by_name(job_name: str) -> dict:
    found = search_jobs_raw(job_name, size=50, pages=3)
    allowed = []
    seen: set[str] = set()
    for job in found:
        if not job_is_open(job) or not job_is_allowed(job):
            continue
        jnid = str(job.get("jnid") or "")
        if jnid and jnid in seen:
            continue
        if jnid:
            seen.add(jnid)
        allowed.append(job)
    target = job_name.strip().casefold()
    exact = [job for job in allowed if first_text(job, "name").casefold() == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise AppError(
            409,
            "More than one POR-STR or POR-MIT job has that exact name. Pick the job from the list.",
        )
    contains = [job for job in allowed if target in first_text(job, "name").casefold()]
    if len(contains) == 1:
        return contains[0]
    if not contains:
        raise AppError(
            404,
            "No POR-STR or POR-MIT job matches that name. A job was not created.",
        )
    raise AppError(
        409,
        "Several POR-STR or POR-MIT jobs contain that name. Pick the job from the list.",
    )


def decode_pdf(pdf_base64: str) -> bytes:
    raw = pdf_base64.strip()
    if raw.lower().startswith("data:"):
        raw = raw.split(",", 1)[-1]
    raw = re.sub(r"\s+", "", raw)
    try:
        data = base64.b64decode(raw, validate=True)
    except Exception:
        raise AppError(400, "The PDF data is not valid base64.")
    if not data.startswith(b"%PDF"):
        raise AppError(400, "That file is not a PDF.")
    if len(data) > 15 * 1024 * 1024:
        raise AppError(413, "The PDF is too large to attach. Keep it under about 15 MB.")
    return data


def safe_filename(filename: str) -> str:
    base = os.path.basename(filename or "").replace("\x00", "")
    base = re.sub(r"[^\w.\- ()]+", "", base, flags=re.UNICODE)
    base = re.sub(r"\s+", " ", base).strip(" .")
    if not base:
        raise AppError(400, "Give the PDF a file name.")
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    if len(base) > 140:
        stem = base[:-4]
        base = stem[:130].rstrip() + ".pdf"
    return base


def attach_pdf(job: dict, filename: str, pdf_bytes: bytes, job_name: str) -> dict:
    jnid = str(job.get("jnid") or "")
    if not jnid:
        raise AppError(502, "JobNimbus did not return an id for that job.")
    payload = {
        "data": base64.b64encode(pdf_bytes).decode("ascii"),
        "filename": filename,
        "type": 1,
        "related": [jnid],
        "subtype": "job",
        "persist": True,
        "is_private": False,
        "description": "Patch estimate for %s" % (first_text(job, "name") or job_name),
        "date": int(time.time()),
    }
    # Files are attached to an existing job. There is no create-job call.
    result = jn_request("POST", "files", payload=payload)
    return extract_file(result)


def send_estimate(body: dict) -> dict:
    if not isinstance(body, dict):
        raise AppError(400, "The request was not a JSON object.")
    job_name = str(body.get("jobName") or "").strip()
    filename = str(body.get("filename") or "").strip()
    pdf_base64 = body.get("pdfBase64")
    job_jnid = str(body.get("jobJnid") or "").strip()
    if not job_name:
        raise AppError(400, "Enter a job name before sending.")
    if not filename:
        raise AppError(400, "Give the PDF a file name.")
    if not isinstance(pdf_base64, str) or not pdf_base64.strip():
        raise AppError(400, "The PDF was empty. Create it again, then send.")
    pdf_bytes = decode_pdf(pdf_base64)
    filename = safe_filename(filename)
    if job_jnid:
        if not JNID_RE.match(job_jnid):
            raise AppError(400, "That job id is not valid. Pick the job from the list again.")
        job = fetch_job(job_jnid)
        if not job_is_allowed(job):
            raise AppError(
                403,
                "That job is not a POR-STR or POR-MIT job, so the PDF was not attached.",
            )
    else:
        job = resolve_job_by_name(job_name)
    attached = attach_pdf(job, filename, pdf_bytes, job_name)
    canonical = first_text(job, "name") or job_name
    return {
        "ok": True,
        "message": "Attached %s to %s in JobNimbus." % (filename, canonical),
        "job": {"jnid": str(job.get("jnid") or ""), "name": canonical},
        "file": attached,
    }


def resolve_public(url_path: str) -> str | None:
    path = urllib.parse.unquote(url_path.split("?", 1)[0])
    if path in ("", "/"):
        path = "/index.html"
    if "\x00" in path:
        return None
    path = path.lstrip("/")
    if path.endswith("/"):
        path += "index.html"
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    full = os.path.normpath(os.path.join(PUBLIC_DIR, *parts))
    public_root = os.path.normpath(PUBLIC_DIR)
    if full != public_root and not full.startswith(public_root + os.sep):
        return None
    if os.path.isfile(full):
        return full
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "PatchEstimator/1.0"

    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else "-"
        path = urllib.parse.urlparse(self.path).path
        sys.stderr.write("%s %s %s\n" % (self.command, path, code))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("X-Content-Type-Options", "nosniff")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, full_path: str):
        ext = os.path.splitext(full_path)[1].lower()
        mime = MIME.get(ext, "application/octet-stream")
        with open(full_path, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", mime)
        if os.path.basename(full_path) == "sw.js":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/jobnimbus/jobs":
                params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                query = (params.get("q") or [""])[0]
                jobs = search_jobs_public(query)
                self.send_json(200, {"ok": True, "jobs": jobs})
                return
            if parsed.path.startswith("/api/"):
                self.send_json(404, {"ok": False, "error": "That API path does not exist."})
                return
            full = resolve_public(parsed.path)
            if not full:
                self.send_json(404, {"ok": False, "error": "That file was not found."})
                return
            self.send_file(full)
        except AppError as exc:
            self.send_json(exc.status, {"ok": False, "error": redact(exc.message)})
        except Exception:
            sys.stderr.write(redact(traceback.format_exc()))
            self.send_json(500, {"ok": False, "error": "Something went wrong on the server. Try again."})

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/api/jobnimbus/send":
                self.send_json(404, {"ok": False, "error": "That API path does not exist."})
                return
            length_header = self.headers.get("Content-Length")
            if length_header is None:
                raw = self.rfile.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    self.close_connection = True
                    self.send_json(
                        413,
                        {"ok": False, "error": "The upload is over the 20 MB limit. Use a smaller PDF."},
                    )
                    return
            else:
                try:
                    length = int(length_header)
                except ValueError:
                    raise AppError(400, "The request size was not valid.")
                if length < 0:
                    raise AppError(400, "The request size was not valid.")
                if length > MAX_BODY:
                    self.close_connection = True
                    self.send_json(
                        413,
                        {"ok": False, "error": "The upload is over the 20 MB limit. Use a smaller PDF."},
                    )
                    return
                raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AppError(400, "The request was not valid JSON.")
            self.send_json(200, send_estimate(body))
        except AppError as exc:
            self.send_json(exc.status, {"ok": False, "error": redact(exc.message)})
        except Exception:
            sys.stderr.write(redact(traceback.format_exc()))
            self.send_json(500, {"ok": False, "error": "Something went wrong on the server. Try again."})

    def do_PUT(self):
        self.send_json(405, {"ok": False, "error": "That method is not supported."})

    def do_DELETE(self):
        self.send_json(405, {"ok": False, "error": "That method is not supported."})


def main():
    if not os.environ.get("JOBNIMBUS_API_KEY", "").strip():
        print(
            "JOBNIMBUS_API_KEY is not set. The estimator will load, but JobNimbus calls fail until it is set.",
            file=sys.stderr,
        )
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Patch Estimator listening on %s:%s" % (HOST, PORT), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
