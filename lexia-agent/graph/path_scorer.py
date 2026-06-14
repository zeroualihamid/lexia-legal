# graph/path_scorer.py

"""
Path Scorer
===========

Scores and ranks ReasoningPath objects using multiple weighted criteria.

Scoring components:
    quality_score    – mean quality_score of nodes in the path
    success_rate     – mean execution success_rate across nodes
    execution_count  – log-normalised total executions (proven = better)
    recency          – how recently nodes were last used
    path_length      – mild penalty for very long paths
    edge_coherence   – bonus when edge types are consistent (clean workflow)

Usage:
    from graph.path_scorer import PathScorer

    scorer = PathScorer(config)

    # Score + sort a list of paths
    ranked = scorer.score_paths(paths)
    best   = ranked[0]

    # Explain a single path's score
    breakdown = scorer.explain(best)
    print(breakdown)

    # Customise weights at runtime
    scorer.weights['recency'] = 0.0   # ignore recency
    scorer.weights['quality_score'] = 0.5
    scorer.normalise_weights()        # keep sum == 1.0
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from graph.path_finder import ReasoningPath
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Score breakdown (for explainability)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ScoreBreakdown:
    """Per-component score explanation for a single ReasoningPath."""
    total:           float
    quality_score:   float
    success_rate:    float
    execution_count: float
    recency:         float
    path_length:     float
    edge_coherence:  float
    weights_used:    Dict[str, float] = field(default_factory=dict)

    def __str__(self) -> str:
        lines = [f"  Total score   : {self.total:.4f}"]
        components = [
            ("quality_score",   self.quality_score),
            ("success_rate",    self.success_rate),
            ("execution_count", self.execution_count),
            ("recency",         self.recency),
            ("path_length",     self.path_length),
            ("edge_coherence",  self.edge_coherence),
        ]
        for name, raw in components:
            w = self.weights_used.get(name, 0.0)
            lines.append(f"  {name:<18}: raw={raw:.4f}  weight={w:.2f}  "
                         f"contribution={raw * w:.4f}")
        return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# PathScorer
# ─────────────────────────────────────────────────────────────────────────────

class PathScorer:
    """
    Scores and ranks ReasoningPath objects.

    Config keys read:
        scorer_weight_quality        (default: 0.35)
        scorer_weight_success_rate   (default: 0.25)
        scorer_weight_exec_count     (default: 0.15)
        scorer_weight_recency        (default: 0.10)
        scorer_weight_path_length    (default: 0.05)
        scorer_weight_edge_coherence (default: 0.10)
        scorer_recency_half_life_days (default: 30)
        scorer_ideal_path_length      (default: 3)
    """

    def __init__(self, config=None):
        if config is None:
            from config.settings import settings
            config = settings

        self.weights: Dict[str, float] = {
            "quality_score":   getattr(config, "scorer_weight_quality",        0.35),
            "success_rate":    getattr(config, "scorer_weight_success_rate",   0.25),
            "execution_count": getattr(config, "scorer_weight_exec_count",     0.15),
            "recency":         getattr(config, "scorer_weight_recency",        0.10),
            "path_length":     getattr(config, "scorer_weight_path_length",    0.05),
            "edge_coherence":  getattr(config, "scorer_weight_edge_coherence", 0.10),
        }

        # Recency decay: score = 0.5 after this many days
        self._half_life_days  = getattr(config, "scorer_recency_half_life_days", 30)
        # Ideal path length (longer/shorter paths are penalised)
        self._ideal_length    = getattr(config, "scorer_ideal_path_length",       3)

        logger.info(f"PathScorer ready — weights={self.weights}")

    # =========================================================================
    # Public API
    # =========================================================================

    def score_paths(self, paths: List[ReasoningPath]) -> List[ReasoningPath]:
        """
        Score every path and return them sorted best-first.

        Mutates path.total_score in place and stores the breakdown
        in path.metadata['score_breakdown'].

        Args:
            paths: unsorted list of ReasoningPath objects

        Returns:
            Same list, sorted by total_score descending
        """
        if not paths:
            return []

        t0 = time.perf_counter()

        for path in paths:
            breakdown          = self._score(path)
            path.total_score   = breakdown.total
            path.metadata["score_breakdown"] = breakdown.__dict__

        paths.sort(key=lambda p: p.total_score, reverse=True)

        elapsed = (time.perf_counter() - t0) * 1000
        logger.info(
            f"Scored {len(paths)} paths in {elapsed:.1f} ms — "
            f"best={paths[0].total_score:.4f}"
        )
        return paths

    def score_one(self, path: ReasoningPath) -> float:
        """Score a single path and return its total score."""
        breakdown        = self._score(path)
        path.total_score = breakdown.total
        return breakdown.total

    def explain(self, path: ReasoningPath) -> str:
        """
        Return a human-readable score breakdown for a path.

        Example output:
            Path: load → filter → aggregate  (3 nodes, score=0.7821)
              Total score   : 0.7821
              quality_score : raw=0.8100  weight=0.35  contribution=0.2835
              success_rate  : raw=0.9000  weight=0.25  contribution=0.2250
              ...
        """
        breakdown = self._score(path)
        header    = (
            f"Path: {path.summary()}\n"
            f"  ({len(path)} nodes, type={path.path_type})"
        )
        return f"{header}\n{breakdown}"

    def normalise_weights(self) -> None:
        """Rescale weights so they sum to exactly 1.0."""
        total = sum(self.weights.values()) or 1.0
        for k in self.weights:
            self.weights[k] = self.weights[k] / total

    def set_preset(self, preset: str) -> None:
        """
        Apply a named weight preset.

        Presets:
            'quality_first'  – prioritise proven, high-quality nodes
            'speed_first'    – prioritise fast-executing paths
            'recency_first'  – prioritise recently used patterns
            'balanced'       – default balanced weights
        """
        presets = {
            "quality_first": {
                "quality_score": 0.50, "success_rate": 0.30,
                "execution_count": 0.10, "recency": 0.00,
                "path_length": 0.05, "edge_coherence": 0.05,
            },
            "speed_first": {
                "quality_score": 0.20, "success_rate": 0.20,
                "execution_count": 0.30, "recency": 0.20,
                "path_length": 0.05, "edge_coherence": 0.05,
            },
            "recency_first": {
                "quality_score": 0.20, "success_rate": 0.20,
                "execution_count": 0.10, "recency": 0.40,
                "path_length": 0.05, "edge_coherence": 0.05,
            },
            "balanced": {
                "quality_score": 0.35, "success_rate": 0.25,
                "execution_count": 0.15, "recency": 0.10,
                "path_length": 0.05, "edge_coherence": 0.10,
            },
        }
        if preset not in presets:
            raise ValueError(f"Unknown preset '{preset}'. "
                             f"Choose from: {list(presets)}")
        self.weights.update(presets[preset])
        logger.info(f"PathScorer preset applied: '{preset}'")

    # =========================================================================
    # Scoring internals
    # =========================================================================

    def _score(self, path: ReasoningPath) -> ScoreBreakdown:
        """Compute all components and return a ScoreBreakdown."""
        if not path.nodes:
            return ScoreBreakdown(
                total=0.0, quality_score=0.0, success_rate=0.0,
                execution_count=0.0, recency=0.0,
                path_length=0.0, edge_coherence=0.0,
                weights_used=self.weights.copy(),
            )

        q   = self._component_quality(path)
        sr  = self._component_success_rate(path)
        ec  = self._component_execution_count(path)
        rec = self._component_recency(path)
        pl  = self._component_path_length(path)
        coh = self._component_edge_coherence(path)

        total = (
            q   * self.weights["quality_score"]   +
            sr  * self.weights["success_rate"]    +
            ec  * self.weights["execution_count"] +
            rec * self.weights["recency"]         +
            pl  * self.weights["path_length"]     +
            coh * self.weights["edge_coherence"]
        )

        return ScoreBreakdown(
            total           = round(min(1.0, max(0.0, total)), 6),
            quality_score   = round(q,   4),
            success_rate    = round(sr,  4),
            execution_count = round(ec,  4),
            recency         = round(rec, 4),
            path_length     = round(pl,  4),
            edge_coherence  = round(coh, 4),
            weights_used    = self.weights.copy(),
        )

    # ── Components [0.0 – 1.0] ───────────────────────────────────────────────

    def _component_quality(self, path: ReasoningPath) -> float:
        """Mean quality_score of all nodes."""
        scores = [n.get("quality_score", 0.0) for n in path.nodes]
        return sum(scores) / len(scores)

    def _component_success_rate(self, path: ReasoningPath) -> float:
        """Mean success_rate of all nodes (weighted by execution count)."""
        total_execs = sum(n.get("total_executions", 0) for n in path.nodes)
        if total_execs == 0:
            # No executions yet — use quality as proxy
            return self._component_quality(path)

        weighted = sum(
            n.get("success_rate", 0.0) * n.get("total_executions", 0)
            for n in path.nodes
        )
        return weighted / total_execs

    def _component_execution_count(self, path: ReasoningPath) -> float:
        """
        Log-normalised total executions across all nodes.

        Rationale: 1 execution → 0.10, 10 → 0.50, 100 → 0.77, 1000 → 1.0
        """
        total = sum(n.get("total_executions", 0) for n in path.nodes)
        if total == 0:
            return 0.0
        # log10(1000) ≈ 3 → normalise to [0, 1] over 3 decades
        return min(1.0, math.log10(total + 1) / 3.0)

    def _component_recency(self, path: ReasoningPath) -> float:
        """
        Exponential decay based on the most recently updated node.

        score = 0.5 ^ (days_since_update / half_life_days)
        → 1.0 if used today, 0.5 at half_life_days, ~0 asymptotically
        """
        now       = time.time()
        half_life = self._half_life_days * 86400   # convert to seconds

        best_score = 0.0
        for node in path.nodes:
            updated_at = node.get("updated_at")
            if not updated_at:
                continue
            try:
                if isinstance(updated_at, str):
                    dt = datetime.fromisoformat(updated_at)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    ts = dt.timestamp()
                else:
                    ts = float(updated_at)

                age     = max(0.0, now - ts)
                score   = 0.5 ** (age / half_life)
                best_score = max(best_score, score)

            except (ValueError, TypeError, OSError):
                pass

        # If no timestamps available, return neutral mid-value
        return best_score if best_score > 0.0 else 0.5

    def _component_path_length(self, path: ReasoningPath) -> float:
        """
        Gaussian bell centred at ideal_length.

        Ideal length gets 1.0; each step away reduces the score.
        Prevents both trivially short (1 node) and bloated (6+ node) paths.
        """
        n     = len(path)
        ideal = self._ideal_length
        sigma = 1.5                                # std dev in #nodes
        return math.exp(-0.5 * ((n - ideal) / sigma) ** 2)

    def _component_edge_coherence(self, path: ReasoningPath) -> float:
        """
        Bonus when all edges share the same type (coherent workflow).

        All LEADS_TO         → 1.0  (clean sequential workflow)
        Mixed types          → proportional to majority fraction
        Single-node path     → 1.0  (no edges to evaluate)
        """
        if len(path.edge_types) == 0:
            return 1.0

        if not path.edge_types:
            return 1.0

        from collections import Counter
        counts       = Counter(path.edge_types)
        most_common  = counts.most_common(1)[0][1]
        return most_common / len(path.edge_types)
