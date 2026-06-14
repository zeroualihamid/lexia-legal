"""
Domain Card Data Models
========================

Defines the card structure that domain subagents produce and
that the frontend renders as KPI tiles and analysis panels.
"""

import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


@dataclass
class DomainCard:
    card_id: str
    domain: str
    card_type: str              # "kpi" | "analysis" | "chart"
    title: str
    content: Dict[str, Any]
    order: int
    created_at: str
    updated_at: str
    pinned: bool = False
    source: str = "auto"        # "auto" (agent-generated) | "user" (chat-created)
    prompt: str = ""            # The LLM prompt that produced this card (user-editable)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DomainCard":
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)

    @classmethod
    def new_kpi(
        cls,
        domain: str,
        title: str,
        value: str,
        *,
        delta: str = "",
        delta_direction: str = "neutral",
        color: str = "accent",
        label: str = "",
        order: int = 0,
        source: str = "auto",
        prompt: str = "",
    ) -> "DomainCard":
        now = datetime.now(timezone.utc).isoformat()
        return cls(
            card_id=str(uuid.uuid4()),
            domain=domain,
            card_type="kpi",
            title=title,
            content={
                "value": value,
                "delta": delta,
                "delta_direction": delta_direction,
                "color": color,
                "label": label,
            },
            order=order,
            created_at=now,
            updated_at=now,
            source=source,
            prompt=prompt,
        )

    @classmethod
    def new_analysis(
        cls,
        domain: str,
        title: str,
        markdown: str,
        *,
        tag: str = "",
        tag_type: str = "g",
        echarts_option: Optional[Dict[str, Any]] = None,
        order: int = 100,
        source: str = "auto",
        prompt: str = "",
    ) -> "DomainCard":
        now = datetime.now(timezone.utc).isoformat()
        return cls(
            card_id=str(uuid.uuid4()),
            domain=domain,
            card_type="analysis",
            title=title,
            content={
                "markdown": markdown,
                "tag": tag,
                "tag_type": tag_type,
                "echarts_option": echarts_option,
            },
            order=order,
            created_at=now,
            updated_at=now,
            source=source,
            prompt=prompt,
        )

    @classmethod
    def new_chart(
        cls,
        domain: str,
        title: str,
        echarts_option: Dict[str, Any],
        *,
        query: str = "",
        order: int = 200,
        source: str = "auto",
        prompt: str = "",
    ) -> "DomainCard":
        now = datetime.now(timezone.utc).isoformat()
        return cls(
            card_id=str(uuid.uuid4()),
            domain=domain,
            card_type="chart",
            title=title,
            content={
                "echarts_option": echarts_option,
                "query": query,
            },
            order=order,
            created_at=now,
            updated_at=now,
            source=source,
            prompt=prompt,
        )
