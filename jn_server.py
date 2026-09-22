#!/usr/bin/env python3
"""Patch Estimator static server + JobNimbus attach proxy.

Serves public-deploy/ and JobNimbus API:
  GET  /api/jobnimbus/jobs?q=…  — autocomplete job search
  POST /api/jobnimbus/send      — attach PDF to an existing JN job

API key: JOBNIMBUS_API_KEY env (cloud) or local secrets file — never logged
or returned to clients / PWA. One shared HTTPS URL for all phones (PWA).
"""

from __future__ import annotations

import base64
import json
import os
import re
import ssl
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8765"))
ROOT = Path(__file__).resolve().parent / "public-deploy"
API_KEY_PATH = Path("/home/box/.secrets/jobnimbus_api_key")
JN_BASE = "https://app.jobnimbus.com/api1/"
SEND_PATH = "/api/jobnimbus/send"
JOBS_PATH = "/api/jobnimbus/jobs"
# PDF base64 in JSON can be large
MAX_BODY_BYTES = 20 * 1024 * 1024  # 20 MB (>= 15 MB requirement
MAX_SEARCH_RESULTS = 15
# Allowed office tags in job name/class/workflow (hyphen or space)
ALLOWED_OFFICE_TOKENS = ("por-str", "por str", "por-mit", "por mit")


def is_allowed_office_job(job: dict | str | None) -> bool:
    """True if job is POR-STR or POR-MIT (case-insensitive; hyphen or space)."""
    if job is None:
        return False
    if isinstance(job, dict):
        name = str(job.get("name") or "")
        extras = []
        for key in ("class_name", "classname", "workflow_name", "workflow", "type_name", "job_type", "tags"):
            v = job.get(key)
            if isinstance(v, str):
                extras.append(v)
            elif isinstance(v, list):
                extras.extend(str(x) for x in v)
            elif isinstance(v, dict):
                extras.append(str(v.get("name") or ""))
        hay = " ".join([name] + extras)
    else:
        hay = str(job)
    h = hay.lower()
    return any(tok in h for tok in ALLOWED_OFFICE_TOKENS)


# Back-compat aliases used elsewhere in this file
def is_por_str_job(job: dict | str | None) -> bool:
    return is_allowed_office_job(job)


def require_por_str(job: dict) -> dict | None:
    """Return job if POR-STR or POR-MIT, else None."""
    if job and is_allowed_office_job(job):
        return job
    return None



def load_api_key() -> str:
    """Prefer env JOBNIMBUS_API_KEY; fall back to local secrets file. Never print key."""
    env_key = os.environ.get("JOBNIMBUS_API_KEY", "").strip()
    if env_key:
        return env_key
    try:
        key = API_KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError as e:
        raise RuntimeError(
            "JobNimbus API key missing: set JOBNIMBUS_API_KEY or provide local secrets file"
        ) from e
    if not key:
        raise RuntimeError("JobNimbus API key file is empty")
    return key


def jn_request(method: str, path: str, body: dict | None = None) -> tuple[int, object]:
    """Call JobNimbus API. Returns (status, parsed_json_or_text). Never exposes the key."""
    key = load_api_key()
    url = urllib.parse.urljoin(JN_BASE, path.lstrip("/"))
    data = None
    headers = {
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
        "User-Agent": "PatchEstimator-JNBridge/1.0",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
            raw = resp.read()
            status = resp.getcode()
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    except urllib.error.URLError as e:
        raise RuntimeError("JobNimbus network error: " + str(e.reason)) from e

    text = raw.decode("utf-8", errors="replace") if raw else ""
    if not text:
        return status, None
    try:
        return status, json.loads(text)
    except json.JSONDecodeError:
        return status, {"raw": text[:500]}


def escape_wildcard(s: str) -> str:
    return re.sub(r"([\\*?])", r"\\\1", s)


def _looks_numeric(q: str) -> bool:
    """True if query is mostly a job number (digits, maybe # or dashes)."""
    cleaned = q.strip().lstrip("#").replace("-", "").replace(" ", "")
    return bool(cleaned) and cleaned.isdigit()


def _job_address_line1(j: dict) -> str:
    for key in ("address_line1", "address_line_1", "street", "address1"):
        v = j.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    addr = j.get("address")
    if isinstance(addr, dict):
        for key in ("line1", "address_line1", "street", "address1"):
            v = addr.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    if isinstance(addr, str) and addr.strip():
        return addr.strip().split("\n", 1)[0].strip()
    return ""


def _job_status_name(j: dict) -> str:
    for key in ("status_name", "statusName"):
        v = j.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    status = j.get("status")
    if isinstance(status, dict):
        name = status.get("name") or status.get("status_name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    if isinstance(status, str) and status.strip() and not status.isdigit():
        return status.strip()
    return ""


def normalize_job(j: dict) -> dict | None:
    if not isinstance(j, dict):
        return None
    jnid = j.get("jnid") or j.get("id")
    if not jnid:
        return None
    out = {
        "jnid": str(jnid),
        "name": str(j.get("name") or ""),
        "number": str(j.get("number") or j.get("display_number") or ""),
    }
    status_name = _job_status_name(j)
    if status_name:
        out["status_name"] = status_name
    address_line1 = _job_address_line1(j)
    if address_line1:
        out["address_line1"] = address_line1
    return out


def _jn_jobs_query(filt: dict, size: int = 25) -> list[dict]:
    qs = urllib.parse.urlencode(
        {"size": str(size), "filter": json.dumps(filt, separators=(",", ":"))}
    )
    status, payload = jn_request("GET", "jobs?" + qs)
    if status >= 400:
        raise RuntimeError(f"JobNimbus job search failed (HTTP {status})")
    results = []
    if isinstance(payload, dict):
        results = payload.get("results") or payload.get("jobs") or []
    if not isinstance(results, list):
        results = []
    return [r for r in results if isinstance(r, dict)]


def search_jobs(query: str, *, for_autocomplete: bool = False) -> list[dict]:
    """Search JN jobs by name (wildcard contains). Optionally also by number.

    Only returns POR-STR or POR-MIT jobs (name/class/workflow).
    No server-side job list cache — every call hits JobNimbus live.
    Dedupes by jnid. When for_autocomplete, includes status_name / address_line1
    and sorts: exact name → starts-with → contains (then by name).
    """
    name = query.strip()
    if not name:
        return []

    escaped = escape_wildcard(name)
    by_id: dict[str, dict] = {}

    def ingest(raw_list: list[dict]) -> None:
        for j in raw_list:
            # Filter early using raw JN fields (class/workflow) + name
            if not is_por_str_job(j):
                continue
            norm = normalize_job(j)
            if not norm:
                continue
            if not is_por_str_job(norm):
                continue
            # Prefer richer record if we already have a stub
            prev = by_id.get(norm["jnid"])
            if prev is None or (
                (norm.get("status_name") or norm.get("address_line1"))
                and not (prev.get("status_name") or prev.get("address_line1"))
            ):
                by_id[norm["jnid"]] = norm
            elif prev is not None:
                # keep existing, fill missing fields
                for k in ("status_name", "address_line1", "number", "name"):
                    if not prev.get(k) and norm.get(k):
                        prev[k] = norm[k]

    # Primary: name contains query AND (POR-STR or POR-MIT)
    por_str_esc = escape_wildcard("POR-STR")
    por_mit_esc = escape_wildcard("POR-MIT")
    filt = {
        "must": [
            {"wildcard": {"name": f"*{escaped}*"}},
            {
                "bool": {
                    "should": [
                        {"wildcard": {"name": f"*{por_str_esc}*"}},
                        {"wildcard": {"name": f"*{por_mit_esc}*"}},
                    ],
                    "minimum_should_match": 1,
                }
            },
        ]
    }
    ingest(_jn_jobs_query(filt, size=25))

    # Case-folded retry if empty and letters present
    if not by_id and name != name.lower():
        filt2 = {
            "must": [
                {"wildcard": {"name": f"*{escape_wildcard(name.lower())}*"}},
                {
                    "bool": {
                        "should": [
                            {"wildcard": {"name": f"*{por_str_esc}*"}},
                            {"wildcard": {"name": f"*{por_mit_esc}*"}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            ]
        }
        ingest(_jn_jobs_query(filt2, size=25))

    # If still empty, broaden: query match then client-filter POR-STR/POR-MIT
    # (covers office tag living only in class/workflow, not name)
    if not by_id:
        filt3 = {"must": [{"wildcard": {"name": f"*{escaped}*"}}]}
        ingest(_jn_jobs_query(filt3, size=40))

    # Number match when query looks numeric
    if _looks_numeric(name):
        num = name.strip().lstrip("#").strip()
        num_esc = escape_wildcard(num)
        # try exact-ish and contains on number field
        for filt_n in (
            {"must": [{"term": {"number": num}}]},
            {"must": [{"wildcard": {"number": f"*{num_esc}*"}}]},
        ):
            try:
                ingest(_jn_jobs_query(filt_n, size=15))
            except RuntimeError:
                # term may not be supported the same way — continue
                continue

    jobs = [j for j in by_id.values() if is_por_str_job(j)]

    if for_autocomplete or True:
        needle_l = name.lower()

        def sort_key(j: dict) -> tuple:
            n = (j.get("name") or "").lower()
            num = (j.get("number") or "").lower()
            exact = 0 if n == needle_l else 1
            starts = 0 if n.startswith(needle_l) else 1
            # number exact boost when numeric query
            num_exact = 0 if num == needle_l or num == name.strip().lstrip("#").lower() else 1
            contains = 0 if needle_l in n else 1
            return (exact, starts, num_exact, contains, n)

        jobs.sort(key=sort_key)

    if for_autocomplete:
        jobs = jobs[:MAX_SEARCH_RESULTS]

    return jobs


def fetch_job(jnid: str) -> dict | None:
    """Fetch a single job by jnid for confirmation."""
    jnid = (jnid or "").strip()
    if not jnid:
        return None
    status, payload = jn_request("GET", "jobs/" + urllib.parse.quote(jnid, safe=""))
    if status >= 400:
        # Fallback: filter by jnid
        filt = {"must": [{"term": {"jnid": jnid}}]}
        try:
            qs = urllib.parse.urlencode(
                {"size": "1", "filter": json.dumps(filt, separators=(",", ":"))}
            )
            status2, payload2 = jn_request("GET", "jobs?" + qs)
            if status2 < 400 and isinstance(payload2, dict):
                results = payload2.get("results") or payload2.get("jobs") or []
                if isinstance(results, list) and results:
                    return normalize_job(results[0])
        except Exception:
            pass
        return None
    if isinstance(payload, dict):
        # Sometimes wrapped
        if "jnid" in payload or "id" in payload:
            return normalize_job(payload)
        inner = payload.get("job") or payload.get("data")
        if isinstance(inner, dict):
            return normalize_job(inner)
    return None


def resolve_job(job_name: str) -> dict:
    """Prefer exact case-insensitive match; else unique contains; else error dict."""
    needle = job_name.strip()
    needle_l = needle.lower()
    jobs = search_jobs(needle, for_autocomplete=False)
    if not jobs:
        return {
            "ok": False,
            "error": "not_found",
            "message": "No POR-STR / POR-MIT JobNimbus job found matching that name. Pick one from the list (e.g. Name (POR-STR) or Name (POR-MIT)).",
        }

    exact = [j for j in jobs if j["name"].lower() == needle_l]
    if len(exact) == 1:
        return {"ok": True, "job": exact[0]}
    if len(exact) > 1:
        return {
            "ok": False,
            "error": "multiple_jobs",
            "message": f"Multiple POR-STR / POR-MIT jobs named “{needle}”. Pick one from the autocomplete list.",
            "jobs": [{"jnid": j["jnid"], "name": j["name"], "number": j["number"]} for j in exact],
        }

    contains = [j for j in jobs if needle_l in j["name"].lower()]
    if len(contains) == 1:
        return {"ok": True, "job": contains[0]}
    if len(contains) == 0:
        if len(jobs) == 1:
            return {"ok": True, "job": jobs[0]}
        return {
            "ok": False,
            "error": "multiple_jobs",
            "message": "Multiple POR-STR / POR-MIT jobs matched. Pick one from the autocomplete list.",
            "jobs": [{"jnid": j["jnid"], "name": j["name"], "number": j["number"]} for j in jobs],
        }
    return {
        "ok": False,
        "error": "multiple_jobs",
        "message": f"Multiple POR-STR / POR-MIT jobs match “{needle}”. Pick one from the autocomplete list.",
        "jobs": [{"jnid": j["jnid"], "name": j["name"], "number": j["number"]} for j in contains],
    }


def attach_pdf(job: dict, filename: str, pdf_b64: str) -> dict:
    # Strip data-URL prefix if present
    b64 = pdf_b64.strip()
    if "," in b64 and b64.lower().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    # Validate base64 lightly
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception as e:
        raise ValueError("Invalid pdfBase64") from e
    if len(raw) < 5:
        raise ValueError("PDF payload too small")

    safe_name = filename.strip() or "Patch-Estimate.pdf"
    if not safe_name.lower().endswith(".pdf"):
        safe_name += ".pdf"
    # Keep filename filesystem-ish
    safe_name = re.sub(r"[^\w.\- ()]+", "_", safe_name)[:120]

    body = {
        "data": b64,
        "filename": safe_name,
        "description": "Patch estimate",
        "related": [job["jnid"]],
        "subtype": "job",
        "type": 1,
        "persist": True,
        "is_private": False,
    }
    status, payload = jn_request("POST", "files", body)
    if status >= 400:
        msg = "JobNimbus file upload failed"
        if isinstance(payload, dict):
            msg = str(payload.get("message") or payload.get("error") or msg)
        raise RuntimeError(f"{msg} (HTTP {status})")

    file_jnid = None
    if isinstance(payload, dict):
        file_jnid = payload.get("jnid") or payload.get("id")
        if not file_jnid and isinstance(payload.get("file"), dict):
            file_jnid = payload["file"].get("jnid")
    return {
        "ok": True,
        "job": {"jnid": job["jnid"], "name": job["name"], "number": job["number"]},
        "fileJnid": file_jnid,
    }


def err_message(error: str, fallback: str | None = None) -> str:
    messages = {
        "not_found": "No POR-STR / POR-MIT JobNimbus job found matching that name.",
        "multiple_jobs": "Multiple POR-STR / POR-MIT jobs matched. Pick one from the list.",
        "not_por_str": "Only POR-STR or POR-MIT jobs are allowed. Pick a job whose name includes POR-STR or POR-MIT.",
        "missing_job_name": "Enter a job name (or pick a job from the list).",
        "missing_pdf": "Missing PDF data.",
        "invalid_json": "Invalid request body.",
        "empty_body": "Empty request body.",
        "payload_too_large": "PDF payload is too large (max ~15–20 MB).",
        "invalid_pdf": "Invalid PDF data.",
        "job_not_found": "That JobNimbus job was not found (it may have been deleted).",
        "missing_job": "Provide a job name or select a job from the list.",
        "not_found_endpoint": "Unknown API endpoint.",
        "server_error": "Server error. Try again.",
        "jobnimbus_error": "JobNimbus request failed.",
        "q_too_short": "Type at least 2 characters to search.",
    }
    return messages.get(error) or fallback or error


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        # Avoid echoing request bodies / secrets
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, obj: dict) -> None:
        if not obj.get("message") and obj.get("error") and not obj.get("ok"):
            obj = dict(obj)
            obj["message"] = err_message(str(obj["error"]))
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        # Never cache job search / send responses — new POR-STR / POR-MIT jobs must appear live
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in (SEND_PATH, JOBS_PATH):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == JOBS_PATH:
            qs = urllib.parse.parse_qs(parsed.query)
            q = (qs.get("q") or [""])[0]
            if not isinstance(q, str):
                q = str(q)
            q = q.strip()
            if len(q) < 2:
                self._json(
                    400,
                    {
                        "ok": False,
                        "error": "q_too_short",
                        "message": err_message("q_too_short"),
                        "jobs": [],
                    },
                )
                return
            try:
                jobs = search_jobs(q, for_autocomplete=True)
                self._json(200, {"ok": True, "jobs": jobs})
            except RuntimeError as e:
                self._json(
                    502,
                    {
                        "ok": False,
                        "error": "jobnimbus_error",
                        "message": str(e),
                        "jobs": [],
                    },
                )
            except Exception:
                traceback.print_exc(file=sys.stderr)
                self._json(
                    500,
                    {
                        "ok": False,
                        "error": "server_error",
                        "message": err_message("server_error"),
                        "jobs": [],
                    },
                )
            return
        # Static files
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]

        # Optional POST search (same as GET)
        if path == JOBS_PATH:
            length = int(self.headers.get("Content-Length") or 0)
            q = ""
            if length > 0 and length <= 64 * 1024:
                try:
                    raw = self.rfile.read(length)
                    data = json.loads(raw.decode("utf-8"))
                    if isinstance(data, dict):
                        q = (data.get("q") or data.get("query") or "").strip()
                        if not isinstance(q, str):
                            q = str(q)
                except Exception:
                    self._json(
                        400,
                        {
                            "ok": False,
                            "error": "invalid_json",
                            "message": err_message("invalid_json"),
                            "jobs": [],
                        },
                    )
                    return
            else:
                # also allow ?q= on POST
                parsed = urllib.parse.urlparse(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
                q = (qs.get("q") or [""])[0]
            q = (q or "").strip()
            if len(q) < 2:
                self._json(
                    400,
                    {
                        "ok": False,
                        "error": "q_too_short",
                        "message": err_message("q_too_short"),
                        "jobs": [],
                    },
                )
                return
            try:
                jobs = search_jobs(q, for_autocomplete=True)
                self._json(200, {"ok": True, "jobs": jobs})
            except RuntimeError as e:
                self._json(
                    502,
                    {"ok": False, "error": "jobnimbus_error", "message": str(e), "jobs": []},
                )
            except Exception:
                traceback.print_exc(file=sys.stderr)
                self._json(
                    500,
                    {
                        "ok": False,
                        "error": "server_error",
                        "message": err_message("server_error"),
                        "jobs": [],
                    },
                )
            return

        if path != SEND_PATH:
            self._json(
                404,
                {
                    "ok": False,
                    "error": "not_found_endpoint",
                    "message": err_message("not_found_endpoint"),
                },
            )
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json(
                400,
                {"ok": False, "error": "empty_body", "message": err_message("empty_body")},
            )
            return
        if length > MAX_BODY_BYTES:
            self._json(
                413,
                {
                    "ok": False,
                    "error": "payload_too_large",
                    "message": err_message("payload_too_large"),
                },
            )
            return
        try:
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(
                400,
                {"ok": False, "error": "invalid_json", "message": err_message("invalid_json")},
            )
            return

        if not isinstance(data, dict):
            self._json(
                400,
                {"ok": False, "error": "invalid_json", "message": err_message("invalid_json")},
            )
            return

        job_name = (
            (data.get("jobName") or "").strip()
            if isinstance(data.get("jobName"), str)
            else ""
        )
        job_jnid = (
            (data.get("jobJnid") or data.get("jnid") or "").strip()
            if isinstance(data.get("jobJnid") or data.get("jnid"), str)
            else ""
        )
        pdf_b64 = data.get("pdfBase64") or ""
        if not isinstance(pdf_b64, str):
            pdf_b64 = ""
        filename = (
            data.get("filename")
            if isinstance(data.get("filename"), str)
            else "Patch-Estimate.pdf"
        )

        if not job_jnid and not job_name:
            self._json(
                400,
                {
                    "ok": False,
                    "error": "missing_job",
                    "message": err_message("missing_job"),
                },
            )
            return
        if not pdf_b64.strip():
            self._json(
                400,
                {"ok": False, "error": "missing_pdf", "message": err_message("missing_pdf")},
            )
            return

        try:
            if job_jnid:
                job = fetch_job(job_jnid)
                if not job:
                    self._json(
                        404,
                        {
                            "ok": False,
                            "error": "job_not_found",
                            "message": err_message("job_not_found"),
                        },
                    )
                    return
                # Prefer client-supplied name for display if fetch returned empty name
                if not job.get("name") and job_name:
                    job["name"] = job_name
                if not is_por_str_job(job):
                    self._json(
                        400,
                        {
                            "ok": False,
                            "error": "not_por_str",
                            "message": err_message("not_por_str"),
                        },
                    )
                    return
                result = attach_pdf(job, filename, pdf_b64)
                self._json(200, result)
                return

            resolved = resolve_job(job_name)
            if not resolved.get("ok"):
                code = 404 if resolved.get("error") == "not_found" else 409
                if not resolved.get("message"):
                    resolved = dict(resolved)
                    resolved["message"] = err_message(str(resolved.get("error") or ""))
                self._json(code, resolved)
                return
            result = attach_pdf(resolved["job"], filename, pdf_b64)
            self._json(200, result)
        except ValueError as e:
            self._json(
                400,
                {
                    "ok": False,
                    "error": "invalid_pdf",
                    "message": str(e) or err_message("invalid_pdf"),
                },
            )
        except RuntimeError as e:
            # Never include auth details
            self._json(
                502,
                {"ok": False, "error": "jobnimbus_error", "message": str(e)},
            )
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(
                500,
                {
                    "ok": False,
                    "error": "server_error",
                    "message": err_message("server_error"),
                },
            )


def main() -> None:
    if not ROOT.is_dir():
        print(f"Static root missing: {ROOT}", file=sys.stderr)
        sys.exit(1)
    # Fail fast if key missing (do not print key)
    try:
        load_api_key()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    # Allow large request bodies (default is fine; documented for operators)
    print(f"Patch Estimator + JN bridge on http://{HOST}:{PORT}/", flush=True)
    print(f"Static root: {ROOT}", flush=True)
    print(f"GET  {JOBS_PATH}?q=", flush=True)
    print(f"POST {SEND_PATH} (optional jobJnid)", flush=True)
    print(f"Max body: {MAX_BODY_BYTES} bytes", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
