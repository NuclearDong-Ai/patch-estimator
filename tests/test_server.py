import base64
import io
import json
import os
import socket
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import jn_server

KEY = "super-secret-jn-key-xyz"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def b64_pdf():
    return base64.b64encode(PDF).decode("ascii")


JOBS = [
    {
        "jnid": "job-exact",
        "name": "POR-STR 123 Main",
        "number": "1042",
        "class_name": "Residential",
        "record_type_name": "POR-STR",
        "status_name": "Production",
        "address_line1": "123 Main St",
        "city": "Eugene",
        "state_text": "OR",
        "zip": "97401",
        "is_active": True,
        "is_archived": False,
    },
    {
        "jnid": "job-contains",
        "name": "Smith POR STR kitchen",
        "number": "1043",
        "class_name": "POR STR",
        "record_type_name": "Mitigation",
        "is_active": True,
    },
    {
        "jnid": "job-mit",
        "name": "River House",
        "class_name": {"name": "POR-MIT"},
        "record_type_name": "Rebuild",
        "is_active": True,
    },
    {
        "jnid": "job-workflow",
        "name": "Cedar Lane",
        "workflow_name": "POR - MIT",
        "is_active": True,
    },
    {
        "jnid": "job-other",
        "name": "POR-STR 123 Main extra",
        "record_type_name": "POR-STR",
        "is_active": True,
    },
    {
        "jnid": "job-closed",
        "name": "POR-STR Closed",
        "record_type_name": "POR-STR",
        "is_archived": True,
        "is_active": True,
    },
    {
        "jnid": "job-no",
        "name": "Regular remodel",
        "record_type_name": "Retail",
        "class_name": "Interior",
        "is_active": True,
    },
    {
        "jnid": "job-strategy",
        "name": "POR-STRATEGY plan",
        "record_type_name": "Retail",
        "is_active": True,
    },
]


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), jn_server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        self.calls = []
        self.mode = "ok"
        os.environ["JOBNIMBUS_API_KEY"] = KEY
        self.patcher = mock.patch("jn_server.http_open", self._open)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        os.environ.pop("JOBNIMBUS_API_KEY", None)

    def _open(self, req, timeout=20):
        self.calls.append(req)
        method = req.get_method()
        url = req.full_url
        if method == "POST" and "/jobs" in url and "/files" not in url:
            raise AssertionError("server tried to create a job: %s" % url)
        if self.mode == "401":
            body = json.dumps({"message": "rejected " + KEY}).encode()
            raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(body))
        if self.mode == "500":
            body = json.dumps({"message": "failed " + KEY}).encode()
            raise urllib.error.HTTPError(url, 500, "Error", {}, io.BytesIO(body))
        if method == "GET" and "/jobs/" in url:
            jnid = url.rstrip("/").split("/jobs/")[1].split("?")[0]
            for job in JOBS:
                if job["jnid"] == jnid:
                    return FakeResponse(job)
            raise urllib.error.HTTPError(url, 404, "Missing", {}, io.BytesIO(b'{"message":"missing"}'))
        if method == "GET" and url.split("?")[0].rstrip("/").endswith("/jobs"):
            self.assertIn("wildcard", url)
            return FakeResponse({"count": len(JOBS), "results": JOBS})
        if method == "POST" and url.rstrip("/").endswith("/files"):
            payload = json.loads(req.data.decode())
            return FakeResponse({"count": 1, "files": [{"jnid": "file-1", "filename": payload["filename"]}]})
        raise AssertionError("unexpected JobNimbus call %s %s" % (method, url))

    def request(self, method, path, body=None, timeout=5):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request("http://127.0.0.1:%s%s" % (self.port, path), data=data, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read().decode()
                return response.status, dict(response.headers), raw
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            return exc.code, dict(exc.headers), raw

    def test_allows_por_tokens_only(self):
        self.assertTrue(jn_server.job_is_allowed({"name": "POR-STR Smith"}))
        self.assertTrue(jn_server.job_is_allowed({"name": "por str smith"}))
        self.assertTrue(jn_server.job_is_allowed({"class_name": "POR-MIT"}))
        self.assertTrue(jn_server.job_is_allowed({"record_type_name": "POR - MIT"}))
        self.assertTrue(jn_server.job_is_allowed({"workflow": {"name": "POR\u2013STR"}}))
        self.assertFalse(jn_server.job_is_allowed({"name": "PORSTR compacted"}))
        self.assertFalse(jn_server.job_is_allowed({"name": "POR-STRATEGY plan"}))
        self.assertFalse(jn_server.job_is_allowed({"name": "Regular remodel"}))

    def test_short_query_does_not_call_jobnimbus(self):
        status, headers, raw = self.request("GET", "/api/jobnimbus/jobs?q=p")
        self.assertEqual(status, 400)
        self.assertIn("at least 2", raw)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(self.calls, [])
        self.assertNotIn(KEY, raw)

    def test_autocomplete_filters_and_uses_wildcard(self):
        status, headers, raw = self.request("GET", "/api/jobnimbus/jobs?q=Main")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        payload = json.loads(raw)
        names = [job["name"] for job in payload["jobs"]]
        self.assertEqual(names, ["POR-STR 123 Main", "POR-STR 123 Main extra"])
        self.assertNotIn("phone", raw.lower())
        query = urllib.request.urlparse(self.calls[0].full_url)
        filt = json.loads(urllib.parse.parse_qs(query.query)["filter"][0])
        self.assertIn("wildcard", json.dumps(filt))
        self.assertIn("*Main*", json.dumps(filt))
        auth = self.calls[0].get_header("Authorization")
        self.assertEqual(auth, "Bearer " + KEY)
        self.assertNotIn(KEY, raw)

    def test_class_search(self):
        status, _, raw = self.request("GET", "/api/jobnimbus/jobs?q=River")
        self.assertEqual(status, 200)
        jobs = json.loads(raw)["jobs"]
        self.assertEqual(jobs[0]["jnid"], "job-mit")
        self.assertEqual(jobs[0]["className"], "POR-MIT")

    def test_missing_key(self):
        os.environ.pop("JOBNIMBUS_API_KEY", None)
        status, _, raw = self.request("GET", "/api/jobnimbus/jobs?q=Main")
        self.assertEqual(status, 503)
        self.assertIn("JOBNIMBUS_API_KEY", raw)
        self.assertNotIn(KEY, raw)
        self.assertEqual(self.calls, [])

    def test_upstream_error_redacts_key(self):
        self.mode = "401"
        status, _, raw = self.request("GET", "/api/jobnimbus/jobs?q=Main")
        self.assertEqual(status, 502)
        self.assertNotIn(KEY, raw)
        self.assertIn("API key", raw)
        self.mode = "500"
        status, _, raw = self.request("GET", "/api/jobnimbus/jobs?q=Main")
        self.assertNotIn(KEY, raw)
        self.assertIn("[redacted]", raw)

    def test_send_by_jnid_attaches_document(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "POR-STR 123 Main",
            "filename": "POR-STR 123 Main Patch Estimate.pdf",
            "pdfBase64": b64_pdf(),
            "jobJnid": "job-exact",
        })
        self.assertEqual(status, 200, raw)
        body = json.loads(raw)
        self.assertTrue(body["ok"])
        self.assertEqual(body["file"]["jnid"], "file-1")
        self.assertEqual(self.calls[0].get_method(), "GET")
        self.assertTrue(self.calls[0].full_url.endswith("/jobs/job-exact"))
        self.assertEqual(self.calls[1].get_method(), "POST")
        self.assertTrue(self.calls[1].full_url.endswith("/files"))
        payload = json.loads(self.calls[1].data.decode())
        self.assertEqual(payload["type"], 1)
        self.assertEqual(payload["related"], ["job-exact"])
        self.assertEqual(payload["subtype"], "job")
        self.assertIs(payload["persist"], True)
        self.assertTrue(base64.b64decode(payload["data"]).startswith(b"%PDF"))
        self.assertNotIn(KEY, raw)
        self.assertTrue(all("/jobs" not in call.full_url or call.get_method() == "GET" for call in self.calls))

    def test_send_resolves_exact_name_before_contains(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "POR-STR 123 Main",
            "filename": "POR-STR 123 Main Patch Estimate.pdf",
            "pdfBase64": "data:application/pdf;base64," + b64_pdf(),
        })
        self.assertEqual(status, 200, raw)
        payload = json.loads(self.calls[-1].data.decode())
        self.assertEqual(payload["related"], ["job-exact"])

    def test_send_unique_contains(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "kitchen",
            "filename": "kitchen Patch Estimate.pdf",
            "pdfBase64": b64_pdf(),
        })
        self.assertEqual(status, 200, raw)
        payload = json.loads(self.calls[-1].data.decode())
        self.assertEqual(payload["related"], ["job-contains"])

    def test_send_ambiguous(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "POR-STR",
            "filename": "POR-STR Patch Estimate.pdf",
            "pdfBase64": b64_pdf(),
        })
        self.assertEqual(status, 409)
        self.assertIn("Pick the job", raw)
        self.assertTrue(all(call.get_method() != "POST" for call in self.calls))

    def test_send_rejects_non_por_jnid(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "Regular remodel",
            "filename": "Regular remodel Patch Estimate.pdf",
            "pdfBase64": b64_pdf(),
            "jobJnid": "job-no",
        })
        self.assertEqual(status, 403)
        self.assertIn("POR-STR or POR-MIT", raw)
        self.assertTrue(all(not call.full_url.endswith("/files") for call in self.calls))

    def test_send_rejects_non_pdf(self):
        status, _, raw = self.request("POST", "/api/jobnimbus/send", {
            "jobName": "POR-STR 123 Main",
            "filename": "note.pdf",
            "pdfBase64": base64.b64encode(b"hello").decode(),
            "jobJnid": "job-exact",
        })
        self.assertEqual(status, 400)
        self.assertIn("not a PDF", raw)
        self.assertEqual(self.calls, [])

    def test_static_and_traversal(self):
        status, headers, raw = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Patch Estimator", raw)
        self.assertIn("text/html", headers["Content-Type"])
        status, _, raw = self.request("GET", "/pricing.js")
        self.assertIn("74600", raw)
        status, _, raw = self.request("GET", "/../jn_server.py")
        self.assertEqual(status, 404)
        status, _, raw = self.request("GET", "/icons/%2e%2e/%2e%2e/jn_server.py")
        self.assertEqual(status, 404)
        self.assertNotIn("JOBNIMBUS", raw)

    def test_cors_preflight(self):
        status, headers, _ = self.request("OPTIONS", "/api/jobnimbus/send")
        self.assertEqual(status, 204)
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_body_limit(self):
        sock = socket.create_connection(("127.0.0.1", self.port), 3)
        try:
            request = (
                "POST /api/jobnimbus/send HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Content-Type: application/json\r\n"
                "Content-Length: %d\r\n"
                "Connection: close\r\n\r\n" % (jn_server.MAX_BODY + 1)
            )
            sock.sendall(request.encode())
            sock.settimeout(3)
            raw = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                raw += chunk
        finally:
            sock.close()
        text = raw.decode("utf-8", "replace")
        self.assertIn("413", text.split("\r\n", 1)[0])
        self.assertIn("20 MB", text)
        self.assertNotIn(KEY, text)


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


if __name__ == "__main__":
    unittest.main()
