"""Tiny stdlib HTTP server behind ``whichllm ui``.

It never ranks models itself. It calls the real CLI (``whichllm --json``) in a
subprocess, caches the answer, and serves it to the static page. It binds to
127.0.0.1 only and never starts a download.
"""

from __future__ import annotations

import json
import mimetypes
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATIC_DIR = Path(__file__).parent / "static"
HOST = "127.0.0.1"
CACHE_TTL_SECONDS = 15 * 60
SCAN_TIMEOUT_SECONDS = 300

PROFILES = ("general", "coding", "vision", "math")
CONTEXTS = (4096, 8192, 16384, 32768, 65536, 131072)
FIT_MODES = ("any", "full-gpu")
TOP_MIN, TOP_MAX = 1, 40
GPU_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z .\-]{0,39}$")

# Curated list for the "what if" menu. Every name works with ``--gpu``.
SIMULATE_GPUS = (
    "RTX 3060",
    "RTX 4070",
    "RTX 3090",
    "RTX 4090",
    "RTX 5090",
    "2x RTX 3090",
    "RX 7900 XTX",
    "M4 Pro",
    "M3 Max",
    "M2 Ultra",
    "H100",
)

Key = tuple


class QueryError(ValueError):
    """Raised for bad query parameters."""


def parse_query(params: dict[str, list[str]]) -> dict:
    """Validate query parameters and return a clean dict."""

    def one(name: str, default: str) -> str:
        values = params.get(name)
        return values[0].strip() if values and values[0].strip() else default

    try:
        top = int(one("top", "10"))
        context = int(one("context", "4096"))
    except ValueError as exc:
        raise QueryError("top and context must be whole numbers") from exc
    if not TOP_MIN <= top <= TOP_MAX:
        raise QueryError(f"top must be between {TOP_MIN} and {TOP_MAX}")
    if context not in CONTEXTS:
        raise QueryError(f"context must be one of {', '.join(map(str, CONTEXTS))}")
    profile = one("profile", "general")
    if profile not in PROFILES:
        raise QueryError(f"profile must be one of {', '.join(PROFILES)}")
    fit = one("fit", "any")
    if fit not in FIT_MODES:
        raise QueryError(f"fit must be one of {', '.join(FIT_MODES)}")
    gpu = one("gpu", "")
    if gpu and not GPU_RE.match(gpu):
        raise QueryError("gpu name has characters that are not allowed")
    return {"top": top, "context": context, "profile": profile, "fit": fit, "gpu": gpu}


def build_command(q: dict, refresh: bool = False) -> list[str]:
    cmd = [
        sys.executable,
        "-m",
        "whichllm",
        "--json",
        "--top",
        str(q["top"]),
        "--context-length",
        str(q["context"]),
        "--profile",
        q["profile"],
    ]
    if q["fit"] != "any":
        cmd += ["--fit", q["fit"]]
    if q["gpu"]:
        cmd += ["--gpu", q["gpu"]]
    if refresh:
        cmd.append("--refresh")
    return cmd


def run_scan(q: dict, refresh: bool = False) -> dict:
    """Run the CLI once and return its parsed JSON."""
    proc = subprocess.run(
        build_command(q, refresh),
        capture_output=True,
        text=True,
        timeout=SCAN_TIMEOUT_SECONDS,
        stdin=subprocess.DEVNULL,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
        raise RuntimeError(" ".join(tail) or f"whichllm exited with {proc.returncode}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("whichllm did not return valid JSON") from exc


class ScanCache:
    """Thread-safe cache. A scan runs in the background; callers poll."""

    def __init__(self, scanner=run_scan, ttl: float = CACHE_TTL_SECONDS):
        self._scanner = scanner
        self._ttl = ttl
        self._lock = threading.Lock()
        self._entries: dict[Key, dict] = {}

    @staticmethod
    def _key(q: dict) -> Key:
        return tuple(sorted(q.items()))

    def get(self, q: dict, refresh: bool = False) -> dict:
        """Return {"status": "ready"|"loading"|"error", ...}."""
        key = self._key(q)
        with self._lock:
            entry = self._entries.get(key)
            fresh = entry and (time.time() - entry["at"] < self._ttl)
            if entry and entry["state"] == "loading":
                return {"status": "loading", "since": entry["started"]}
            if entry and entry["state"] == "ready" and fresh and not refresh:
                return {"status": "ready", "data": entry["data"], "age": time.time() - entry["at"]}
            if entry and entry["state"] == "error" and not refresh and time.time() - entry["at"] < 10:
                return {"status": "error", "error": entry["error"]}
            self._entries[key] = {
                "state": "loading",
                "started": time.time(),
                "at": time.time(),
                "stale": entry["data"] if entry and entry.get("data") else None,
            }
        threading.Thread(target=self._work, args=(key, q, refresh), daemon=True).start()
        return {"status": "loading", "since": time.time()}

    def _work(self, key: Key, q: dict, refresh: bool) -> None:
        started = time.time()
        try:
            data = self._scanner(q, refresh)
            result = {"state": "ready", "data": data, "at": time.time(), "took": time.time() - started}
        except Exception as exc:  # report to the page, keep the server alive
            result = {"state": "error", "error": str(exc), "at": time.time()}
        with self._lock:
            self._entries[key] = result


class Handler(BaseHTTPRequestHandler):
    server_version = "whichllm-ui"
    cache: ScanCache = ScanCache()

    def log_message(self, fmt, *args):  # keep the terminal quiet
        return

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        params = parse_qs(url.query)
        if url.path in ("/api/hardware", "/api/models"):
            self._api(url.path, params)
        elif url.path == "/api/options":
            self._json(
                200,
                {
                    "profiles": PROFILES,
                    "contexts": CONTEXTS,
                    "gpus": SIMULATE_GPUS,
                    "top": [TOP_MIN, TOP_MAX],
                },
            )
        else:
            self._static(url.path)

    def _api(self, path: str, params: dict) -> None:
        try:
            q = parse_query(params)
        except QueryError as exc:
            self._json(400, {"status": "error", "error": str(exc)})
            return
        if path == "/api/hardware":
            q = {"top": 1, "context": 4096, "profile": "general", "fit": "any", "gpu": q["gpu"]}
        refresh = params.get("refresh", ["0"])[0] == "1"
        res = self.cache.get(q, refresh=refresh)
        if res["status"] == "loading":
            self._json(202, {"status": "loading"})
        elif res["status"] == "error":
            self._json(500, {"status": "error", "error": res["error"]})
        else:
            data = res["data"]
            if path == "/api/hardware":
                payload = {"status": "ready", "hardware": data.get("hardware", {}), "simulated": bool(q["gpu"])}
            else:
                payload = {
                    "status": "ready",
                    "query": q,
                    "hardware": data.get("hardware", {}),
                    "models": data.get("models", []),
                    "age_seconds": round(res["age"]),
                }
            self._json(200, payload)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)


def make_server(port: int, cache: ScanCache | None = None) -> ThreadingHTTPServer:
    if cache is not None:
        handler = type("BoundHandler", (Handler,), {"cache": cache})
    else:
        handler = Handler
    return ThreadingHTTPServer((HOST, port), handler)


def serve(port: int = 8765, open_browser: bool = True) -> None:
    server = make_server(port)
    url = f"http://{HOST}:{port}/"
    # Start the first scan now so the page loads fast.
    default_q = {"top": 10, "context": 4096, "profile": "general", "fit": "any", "gpu": ""}
    Handler.cache.get(default_q)
    print(f"What LLM can you choose? is running at {url}  (Ctrl+C to stop)")
    if open_browser:
        import webbrowser

        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
