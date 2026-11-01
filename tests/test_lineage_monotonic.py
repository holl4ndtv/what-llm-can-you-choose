"""Within one family and size, an older generation must not outscore a newer one."""

from whichllm.models.benchmark_lineage import _enforce_generation_order


def test_older_qwen_capped_below_newer_sibling():
    scores = {"Qwen/Qwen3.6-27B": 83.5, "Qwen/Qwen3.8-27B": 77.8}
    out = _enforce_generation_order(scores)
    assert out["Qwen/Qwen3.8-27B"] == 77.8
    assert out["Qwen/Qwen3.6-27B"] <= 77.8


def test_different_size_is_not_capped():
    scores = {"Qwen/Qwen3.6-35B-A3B": 80.0, "Qwen/Qwen3.8-27B": 77.8}
    assert _enforce_generation_order(scores) == scores


def test_older_already_lower_is_untouched():
    scores = {"Qwen/Qwen3.5-27B": 63.0, "Qwen/Qwen3.8-27B": 77.8}
    assert _enforce_generation_order(scores) == scores


def test_unknown_family_untouched():
    scores = {"acme/Foo-7B": 50.0, "acme/Foo-7B-v2": 40.0}
    assert _enforce_generation_order(scores) == scores


def test_reasoning_line_without_version_number_is_not_capped():
    scores = {"Qwen/QwQ-32B": 68.4, "Qwen/Qwen3-32B": 43.3}
    assert _enforce_generation_order(scores) == scores
