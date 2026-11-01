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


def _harness_data():
    from pathlib import Path

    p = Path(ui.__file__).parent / "static" / "harnesses.json"
    return json.loads(p.read_text(encoding="utf-8"))


def _all_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from _all_strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _all_strings(v)


def test_harnesses_json_parses_and_runner_ids_exist():
    data = _harness_data()
    assert data["checked"] and data["context_rule"]["plain"]
    runner_ids = {r["id"] for r in data["runners"]}
    assert len(runner_ids) == len(data["runners"])
    assert runner_ids == {"ollama", "lmstudio", "llamacpp", "mlx", "vllm"}
    for h in data["harnesses"]:
        assert set(h["works_with_runners"]) <= runner_ids, h["id"]


def test_every_harness_has_plain_connect_and_source():
    for h in _harness_data()["harnesses"]:
        for key in ("plain", "connect", "source", "install", "name"):
            assert isinstance(h.get(key), str) and h[key].strip(), (h["id"], key)
        assert h["source"].startswith("https://"), h["id"]
        assert h["kind"] in {"chat-app", "server-ui", "editor-addon", "terminal-agent"}


def test_harnesses_json_has_no_em_or_en_dash():
    for s in _all_strings(_harness_data()):
        assert "—" not in s and "–" not in s, s


def test_server_serves_harnesses_json(base_url):
    url, _, _ = base_url
    status, body = _get(url + "/harnesses.json")
    assert status == 200
    assert json.loads(body) == _harness_data()
