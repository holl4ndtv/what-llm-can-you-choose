"""Lineage-aware recency demotion for frozen benchmark scores."""

from __future__ import annotations

import re

_LINEAGE_DEMOTION_REGEX = None


def _build_lineage_regex():
    """Compile MODEL_LINEAGE_VERSIONS once into (family, [(re, idx)]) form."""
    global _LINEAGE_DEMOTION_REGEX
    if _LINEAGE_DEMOTION_REGEX is not None:
        return _LINEAGE_DEMOTION_REGEX
    from whichllm.constants import MODEL_LINEAGE_VERSIONS

    out = {}
    for family, entries in MODEL_LINEAGE_VERSIONS.items():
        compiled = [(re.compile(pat), idx) for pat, idx in entries]
        max_idx = max(idx for _, idx in entries)
        out[family] = (compiled, max_idx)
    _LINEAGE_DEMOTION_REGEX = out
    return out


def _lineage_recency_factor(model_id: str) -> float:
    """Return a multiplicative recency factor for frozen-only scores.

    Newest generation in a known family -> 1.0 (no demotion). Each generation
    older -> another 12% off. Unknown families -> 1.0.
    """
    if not model_id:
        return 1.0
    lower = model_id.lower()
    families = _build_lineage_regex()
    best_factor = 1.0
    for family, (patterns, max_idx) in families.items():
        for regex, idx in patterns:
            if regex.search(lower):
                gens_old = max(0, max_idx - idx)
                factor = max(0.55, 1.0 - 0.12 * gens_old)
                if factor < best_factor:
                    best_factor = factor
                break
    return best_factor


def _apply_lineage_recency_demotion(
    combined: dict[str, float],
    frozen: dict[str, float],
    current: dict[str, float],
) -> dict[str, float]:
    """Multiply frozen-only entries by a lineage-derived recency factor."""
    if not combined:
        return combined
    out: dict[str, float] = {}
    for k, v in combined.items():
        if k in current:
            out[k] = v
            continue
        factor = _lineage_recency_factor(k)
        out[k] = round(v * factor, 1)
    return out


def _lineage_key(model_id: str) -> tuple[str, str, int] | None:
    """Return (family, id with the version token blanked, generation) or None."""
    lower = model_id.lower()
    for family, (patterns, _max_idx) in _build_lineage_regex().items():
        for regex, idx in patterns:
            m = regex.search(lower)
            if m and any(ch.isdigit() for ch in m.group()):
                return family, lower[: m.start()] + "<v>" + lower[m.end() :], idx
    return None


def _enforce_generation_order(scores: dict[str, float]) -> dict[str, float]:
    """Cap an older generation at the score of its newer sibling.

    Sources use different scales and cover different models, so a model that
    only one source knows (for example LiveBench) can look better than its
    newer sibling that only another source knows. Same family, same size and
    a newer generation with a score: the older one may not score higher.
    """
    best_newer: dict[tuple[str, str], list[tuple[int, float]]] = {}
    keys = {k: _lineage_key(k) for k in scores}
    for model_id, key in keys.items():
        if key:
            best_newer.setdefault(key[:2], []).append((key[2], scores[model_id]))
    out = dict(scores)
    for model_id, key in keys.items():
        if not key:
            continue
        newer = [s for idx, s in best_newer[key[:2]] if idx > key[2]]
        if newer and out[model_id] > max(newer):
            out[model_id] = max(newer)
    return out
