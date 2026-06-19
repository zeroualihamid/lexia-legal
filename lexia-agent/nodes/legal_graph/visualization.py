"""PNG rendering helpers for legal graph reasoning/discovery views."""

from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import networkx as nx
from PIL import Image, ImageDraw, ImageFont


def render_graph_png(
    graph: nx.MultiDiGraph,
    output_path: str | Path,
    *,
    mode: str = "reasoning",
    title: str = "Legal Graph",
) -> str:
    """Render a graph PNG.

    Modes:
      - reasoning: only ``reasoning_edge=True`` edges
      - discovery: only discovery edges
      - combined: both layers

    Styling:
      - blue edges: reasoning
      - grey dotted edges: metadata/structure discovery
      - green edges: semantic similarity
    """
    if mode not in {"reasoning", "discovery", "combined"}:
        raise ValueError("mode must be one of: reasoning, discovery, combined")

    edges = _filtered_edges(graph, mode)
    doc_groups: Dict[str, List[str]] = defaultdict(list)
    for node_id, attrs in graph.nodes(data=True):
        doc_groups[str(attrs.get("document_id") or "unknown")].append(str(node_id))
    for nodes in doc_groups.values():
        nodes.sort(key=lambda node_id: graph.nodes[node_id].get("paragraph_index") or 0)

    width = 1900
    row_gap = 210
    height = max(900, 220 + row_gap * max(1, len(doc_groups)))
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font_title, font, font_small = _fonts()

    draw.text((35, 28), title, fill="#111827", font=font_title)
    draw.text(
        (35, 70),
        f"Mode: {mode} | Nodes: {graph.number_of_nodes()} | Rendered edges: {len(edges)}",
        fill="#374151",
        font=font,
    )

    positions: Dict[str, Tuple[int, int]] = {}
    left, right = 90, 1450
    y = 190
    for index, (doc_id, node_ids) in enumerate(doc_groups.items(), start=1):
        draw.text((65, y - 42), f"{index}. {doc_id}", fill="#111827", font=font)
        for i, node_id in enumerate(node_ids):
            x = left + int((right - left) * i / max(1, len(node_ids) - 1))
            ny = y if i % 2 == 0 else y + 75
            positions[node_id] = (x, ny)
        y += row_gap

    for source, target, attrs in edges:
        if source not in positions or target not in positions:
            continue
        color, dotted = _edge_style(attrs)
        _arrow(draw, positions[source], positions[target], color, dotted=dotted)

    for node_id, (x, y) in positions.items():
        attrs = graph.nodes[node_id]
        role = str(attrs.get("section_type") or "unknown")
        fill = _node_fill(role)
        draw.rounded_rectangle((x - 80, y - 42, x + 80, y + 42), radius=12, fill=fill, outline="#4b5563", width=2)
        draw.text((x - 66, y - 29), f"C{attrs.get('paragraph_index', '?')}", fill="#111827", font=font)
        draw.text((x - 66, y - 6), role[:18], fill="#374151", font=font_small)
        draw.text((x - 66, y + 14), str(node_id)[:10], fill="#6b7280", font=font_small)

    _legend(draw, width - 360, 180, font, font_small)
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    return str(output)


def _filtered_edges(graph: nx.MultiDiGraph, mode: str) -> List[Tuple[str, str, dict]]:
    selected: List[Tuple[str, str, dict]] = []
    for source, target, _key, attrs in graph.edges(keys=True, data=True):
        is_reasoning = attrs.get("reasoning_edge") is True
        if mode == "reasoning" and not is_reasoning:
            continue
        if mode == "discovery" and is_reasoning:
            continue
        selected.append((str(source), str(target), dict(attrs)))
    return selected


def _edge_style(attrs: dict) -> Tuple[str, bool]:
    if attrs.get("reasoning_edge") is True:
        return "#2563eb", False
    if attrs.get("relation_type") == "similar_to":
        return "#16a34a", False
    return "#6b7280", True


def _node_fill(role: str) -> str:
    if role in {"final_decision", "decision", "ruling", "conclusion"}:
        return "#dcfce7"
    if role in {"applicable_rule", "precedent"}:
        return "#fef3c7"
    if role in {"court_reasoning", "legal_analysis"}:
        return "#ede9fe"
    if role in {"party_claim", "plaintiff_argument", "defendant_argument", "claim"}:
        return "#dbeafe"
    return "#f9fafb"


def _arrow(draw: ImageDraw.ImageDraw, start: Tuple[int, int], end: Tuple[int, int], color: str, *, dotted: bool) -> None:
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    dist = math.hypot(dx, dy) or 1.0
    ux, uy = dx / dist, dy / dist
    sx += int(82 * ux)
    sy += int(42 * uy)
    ex -= int(82 * ux)
    ey -= int(42 * uy)
    if dotted:
        step = 16
        gap = 8
        drawn = 0.0
        while drawn < dist:
            x1 = sx + ux * drawn
            y1 = sy + uy * drawn
            x2 = sx + ux * min(dist, drawn + step)
            y2 = sy + uy * min(dist, drawn + step)
            draw.line((x1, y1, x2, y2), fill=color, width=2)
            drawn += step + gap
    else:
        draw.line((sx, sy, ex, ey), fill=color, width=3)
    angle = math.atan2(dy, dx)
    arrow_size = 11
    p1 = (ex + arrow_size * math.cos(angle + math.pi * 0.82), ey + arrow_size * math.sin(angle + math.pi * 0.82))
    p2 = (ex + arrow_size * math.cos(angle - math.pi * 0.82), ey + arrow_size * math.sin(angle - math.pi * 0.82))
    draw.polygon([(ex, ey), p1, p2], fill=color)


def _legend(draw: ImageDraw.ImageDraw, x: int, y: int, font, font_small) -> None:
    draw.rounded_rectangle((x - 20, y - 25, x + 300, y + 150), radius=14, fill="#f9fafb", outline="#d1d5db")
    draw.text((x, y), "Legend", fill="#111827", font=font)
    items = [
        ("#2563eb", "reasoning edge", False),
        ("#16a34a", "semantic similarity", False),
        ("#6b7280", "metadata discovery", True),
    ]
    for i, (color, label, dotted) in enumerate(items, start=1):
        yy = y + i * 34
        if dotted:
            draw.line((x, yy + 10, x + 42, yy + 10), fill=color, width=2)
            draw.line((x + 54, yy + 10, x + 72, yy + 10), fill=color, width=2)
        else:
            draw.line((x, yy + 10, x + 72, yy + 10), fill=color, width=3)
        draw.text((x + 88, yy), label, fill="#374151", font=font_small)


def _fonts():
    try:
        return (
            ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 28),
            ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 18),
            ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 13),
        )
    except Exception:
        fallback = ImageFont.load_default()
        return fallback, fallback, fallback
