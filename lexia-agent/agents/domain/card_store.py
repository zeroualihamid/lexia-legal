"""
Card Store — File-based JSON persistence per domain
=====================================================

Each domain keeps its cards in ``data/subagents/{domain}/cards.json``.
Reads are instant (no LLM call), writes are atomic (tmp + rename).
Paths are resolved relative to project root so persistence works regardless of cwd.
"""

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from agents.domain.card_models import DomainCard
from monitoring.logger import get_logger

logger = get_logger(__name__)

_lock = threading.Lock()

# Resolve project root (agents/domain/card_store.py -> project root)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _cards_path(domain: str) -> Path:
    base = _PROJECT_ROOT / "data" / "subagents" / domain
    base.mkdir(parents=True, exist_ok=True)
    return base / "cards.json"


def _status_path(domain: str) -> Path:
    base = _PROJECT_ROOT / "data" / "subagents" / domain
    base.mkdir(parents=True, exist_ok=True)
    return base / "status.json"


# ── Read ──────────────────────────────────────────────────────────────────

def load_cards(domain: str) -> List[DomainCard]:
    path = _cards_path(domain)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [DomainCard.from_dict(c) for c in raw]
    except Exception as e:
        logger.error(f"[card_store] Failed to load cards for {domain}: {e}")
        return []


def load_status(domain: str) -> Dict:
    path = _status_path(domain)
    if not path.exists():
        return {"last_refresh": None, "is_running": False, "error": None}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"last_refresh": None, "is_running": False, "error": None}


# ── Write (atomic) ────────────────────────────────────────────────────────

def save_cards(domain: str, cards: List[DomainCard]) -> None:
    path = _cards_path(domain)
    tmp = path.with_suffix(".tmp")
    with _lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump([c.to_dict() for c in cards], f, ensure_ascii=False, indent=2)
            os.replace(str(tmp), str(path))
        except Exception as e:
            logger.error(f"[card_store] Failed to save cards for {domain}: {e}")
            if tmp.exists():
                tmp.unlink(missing_ok=True)


def save_status(domain: str, **fields) -> None:
    path = _status_path(domain)
    current = load_status(domain)
    current.update(fields)
    tmp = path.with_suffix(".tmp")
    with _lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(current, f, ensure_ascii=False, indent=2)
            os.replace(str(tmp), str(path))
        except Exception as e:
            logger.error(f"[card_store] Failed to save status for {domain}: {e}")
            if tmp.exists():
                tmp.unlink(missing_ok=True)


# ── Mutations ─────────────────────────────────────────────────────────────

def add_card(domain: str, card: DomainCard) -> List[DomainCard]:
    cards = load_cards(domain)
    cards.append(card)
    save_cards(domain, cards)
    return cards


def remove_card(domain: str, card_id: str) -> List[DomainCard]:
    cards = load_cards(domain)
    cards = [c for c in cards if c.card_id != card_id]
    save_cards(domain, cards)
    return cards


def reorder_cards(domain: str, card_ids: List[str]) -> List[DomainCard]:
    cards = load_cards(domain)
    id_map = {c.card_id: c for c in cards}
    ordered: List[DomainCard] = []
    for idx, cid in enumerate(card_ids):
        if cid in id_map:
            id_map[cid].order = idx
            id_map[cid].updated_at = datetime.now(timezone.utc).isoformat()
            ordered.append(id_map[cid])
            del id_map[cid]
    for leftover in id_map.values():
        leftover.order = len(ordered)
        ordered.append(leftover)
    save_cards(domain, ordered)
    return ordered


def replace_auto_cards(domain: str, new_cards: List[DomainCard]) -> List[DomainCard]:
    """Replace all auto-generated cards while preserving user-pinned and user-created cards."""
    existing = load_cards(domain)
    preserved = [c for c in existing if c.pinned or c.source == "user"]
    max_order = max((c.order for c in preserved), default=-1)
    for i, card in enumerate(new_cards):
        card.order = max_order + 1 + i
    merged = preserved + new_cards
    merged.sort(key=lambda c: c.order)
    save_cards(domain, merged)
    return merged
