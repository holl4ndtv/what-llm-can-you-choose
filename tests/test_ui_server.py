"""Tests for the local web UI server (JSON shape, validation, binding)."""

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from whichllm.ui import server as ui


FAKE = {
    "hardware": {
        "gpus": [
            {
                "name": "Apple M4 Max",
                "vram_bytes": 1,
                "usable_vram_bytes": 1,
                "memory_bandwidth_gbps": 546.0,
                "shared_memory": True,
            }
        ],
        "cpu": "Apple M4 Max",
        "cpu_cores": 16,
        "ram_bytes": 1,
    },
    "models": [
        {
            "rank": 1,
            "model_id": "a/b",
            "quant_type": "Q4_K_M",
            "file_size_bytes": 1,
            "vram_required_bytes": 2,
            "vram_available_bytes": 3,
            "estimated_tok_per_sec": 5.0,
            "quality_score": 80.0,
        }
    ],
}


@pytest.fixture()
def base_url():
    calls = []

    def scanner(q, refresh):
        calls.append(q)
        return FAKE

    srv = ui.make_server(0, cache=ui.ScanCache(scanner=scanner))
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", srv, calls
    srv.shutdown()
    srv.server_close()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _get_ready(url):
    for _ in range(50):
        status, body = _get(url)
        if status != 202:
            return status, json.loads(body)
        time.sleep(0.05)
    raise AssertionError("scan never finished")


def test_binds_localhost_only(base_url):
    _, srv, _ = base_url
    assert srv.server_address[0] == "127.0.0.1"


def test_models_json_shape_and_cache(base_url):
    url, _, calls = base_url
    status, data = _get_ready(url + "/api/models?top=5")
    assert status == 200 and data["status"] == "ready"
    assert {"query", "hardware", "models"} <= set(data)
    assert data["models"][0]["model_id"] == "a/b"
    _get_ready(url + "/api/models?top=5")
    assert len(calls) == 1  # second request served from cache


def test_hardware_endpoint(base_url):
    url, _, _ = base_url
    status, data = _get_ready(url + "/api/hardware")
    assert status == 200 and data["hardware"]["cpu"] == "Apple M4 Max"
    assert data["simulated"] is False


@pytest.mark.parametrize(
    "qs", ["top=0", "top=999", "context=123", "profile=nope", "gpu=%3Brm"]
)
def test_bad_query_is_rejected(base_url, qs):
    url, _, _ = base_url
    status, body = _get(url + "/api/models?" + qs)
    assert status == 400 and json.loads(body)["status"] == "error"


def test_build_command_passes_gpu_and_context():
    q = ui.parse_query({"gpu": ["RTX 4090"], "context": ["8192"], "fit": ["full-gpu"]})
    cmd = ui.build_command(q)
    assert "--gpu" in cmd and "RTX 4090" in cmd
    assert "8192" in cmd and "full-gpu" in cmd


def test_static_files_and_no_path_escape(base_url):
    url, _, _ = base_url
    assert _get(url + "/")[0] == 200
    assert _get(url + "/app.js")[0] == 200
    assert _get(url + "/%2e%2e/server.py")[0] == 404


def test_every_simulated_gpu_has_plain_label():
    from pathlib import Path

    js = (Path(ui.__file__).parent / "static" / "app.js").read_text(encoding="utf-8")
    for g in ui.SIMULATE_GPUS:
        assert '"' + g + '":' in js, g
