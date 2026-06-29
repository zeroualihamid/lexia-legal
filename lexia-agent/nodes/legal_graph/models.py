"""Typed models for the legal graph flow."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


REASONING_RELATION_TYPES = {
    "supports",
    "applies_rule",
    "cites_article",
    "cites_case",
    "explains",
    "depends_on",
    "leads_to",
    "resolves",
    "rejects",
    "grants",
    "denies",
    "based_on",
    "proves",
    "contradicts",
    "follows_precedent",
}

DISCOVERY_RELATION_TYPES = {
    "same_document",
    "same_judgment",
    "same_source_pdf",
    "same_section",
    "same_page",
    "next_paragraph",
    "previous_paragraph",
    "similar_to",
}

LEGAL_RELATION_TYPES = REASONING_RELATION_TYPES | DISCOVERY_RELATION_TYPES | {
    # Backward-compatible legacy relation. New code should classify terms through
    # node types, not create reasoning paths through defines_term.
    "defines_term",
}

JUDGMENT_NODE_TYPES = {
    "facts",
    "procedure",
    "party_claim",
    "defendant_argument",
    "plaintiff_argument",
    "evidence",
    "legal_issue",
    "cites_article",
    "applies_rule",
    "applicable_rule",
    "precedent",
    "court_reasoning",
    "legal_analysis",
    "final_decision",
    "damages",
    "costs",
    "jurisdiction",
    "admissibility",
    # Legacy aliases that may exist in already persisted graphs.
    "claim",
    "supporting_fact",
    "decision",
    "ruling",
    "conclusion",
    "reasoning",
}

CONTRACT_NODE_TYPES = {
    "party_definition",
    "object",
    "obligation",
    "payment_clause",
    "delivery_clause",
    "termination_clause",
    "liability_clause",
    "confidentiality_clause",
    "dispute_resolution",
    "governing_law",
    "signature",
    "annex",
    "unknown",
}

DOCUMENT_TYPES = {
    "judgment",
    "contract",
    "statute",
    "unknown",
}

EXTRACTION_METHODS = {
    "metadata",
    "semantic_similarity",
    "llm_inference",
    "citation_parser",
}

DEFAULT_RELATION_WEIGHTS = {
    "cites_article": 1.0,
    "cites_case": 1.0,
    "supports": 1.0,
    "applies_rule": 1.0,
    "explains": 1.2,
    "leads_to": 1.3,
    "depends_on": 1.2,
    "resolves": 1.0,
    "rejects": 1.0,
    "grants": 1.0,
    "denies": 1.0,
    "based_on": 1.0,
    "proves": 1.0,
    "same_section": 10.0,
    "same_page": 10.0,
    "same_document": 10.0,
    "same_judgment": 10.0,
    "same_source_pdf": 10.0,
    "contradicts": 3.0,
    "follows_precedent": 1.1,
    "defines_term": 1.4,
    "next_paragraph": 10.0,
    "previous_paragraph": 10.0,
    "similar_to": 10.0,
}

GOAL_SECTION_TYPES = {
    "final_decision",
    "final_ruling",
    "decision",
    "ruling",
    "conclusion",
    "court_reasoning",
    "legal_analysis",
    "reasoning",
}

NODE_TYPE_PRIORITY = {
    "party_claim": 0.3,
    "claim": 0.3,
    "facts": 0.25,
    "supporting_fact": 0.25,
    "evidence": 0.22,
    "legal_issue": 0.2,
    "applicable_rule": 0.2,
    "precedent": 0.2,
    "court_reasoning": 0.1,
    "legal_analysis": 0.1,
    "reasoning": 0.1,
    "final_decision": 0.0,
    "final_ruling": 0.0,
    "decision": 0.0,
    "ruling": 0.0,
    "conclusion": 0.0,
}


class LegalGraphConfig(BaseModel):
    """Runtime knobs for the legal graph flow."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    graph_file_path: Path = Field(
        default_factory=lambda: Path(
            os.getenv("LEGAL_GRAPH_FILE_PATH", "data/legal_graph.pkl")
        )
    )
    graphml_file_path: Optional[Path] = Field(
        default_factory=lambda: (
            Path(os.getenv("LEGAL_GRAPH_GRAPHML_PATH"))
            if os.getenv("LEGAL_GRAPH_GRAPHML_PATH")
            else Path("data/legal_graph.graphml")
        )
    )
    qdrant_url: str = Field(
        default_factory=lambda: os.getenv("QDRANT_URL")
        or f"http://{os.getenv('QDRANT_HOST', 'localhost')}:{os.getenv('QDRANT_PORT', '6333')}"
    )
    qdrant_api_key: Optional[str] = Field(
        default_factory=lambda: os.getenv("QDRANT_API_KEY") or None
    )
    qdrant_collections: List[str] = Field(default_factory=list)
    query_embed_model: str = Field(
        default_factory=lambda: os.getenv(
            "LEGAL_GRAPH_QUERY_EMBED_MODEL",
            os.getenv("LEXIA_DOC_EMBED_MODEL", "intfloat/multilingual-e5-large"),
        )
    )
    top_k: int = Field(default_factory=lambda: int(os.getenv("LEGAL_GRAPH_TOP_K", "100")))
    max_candidates_per_node: int = Field(
        default_factory=lambda: int(os.getenv("LEGAL_GRAPH_MAX_CANDIDATES", "30"))
    )
    semantic_similarity_threshold: float = Field(
        default_factory=lambda: float(os.getenv("LEGAL_GRAPH_SIMILARITY_THRESHOLD", "0.78"))
    )
    llm_edge_limit: int = Field(
        default_factory=lambda: int(os.getenv("LEGAL_GRAPH_LLM_EDGE_LIMIT", "12"))
    )
    judgments_only: bool = Field(
        default_factory=lambda: os.getenv("LEGAL_GRAPH_JUDGMENTS_ONLY", "").lower()
        in {"1", "true", "yes"}
    )
    cross_case: bool = Field(
        default_factory=lambda: os.getenv("LEGAL_GRAPH_CROSS_CASE", "").lower()
        in {"1", "true", "yes"}
    )
    claude_timeout_seconds: int = Field(
        default_factory=lambda: int(os.getenv("LEGAL_GRAPH_CLAUDE_TIMEOUT_SECONDS", "90"))
    )
    require_claude_token: bool = Field(
        default_factory=lambda: os.getenv("LEGAL_GRAPH_REQUIRE_CLAUDE", "").lower()
        in {"1", "true", "yes"}
    )

    @field_validator("qdrant_collections", mode="before")
    @classmethod
    def _collections_from_env(cls, value: Any) -> List[str]:
        if value:
            if isinstance(value, str):
                return [part.strip() for part in value.split(",") if part.strip()]
            return list(value)
        raw = (
            os.getenv("LEGAL_GRAPH_QDRANT_COLLECTIONS")
            or os.getenv("LEGAL_GRAPH_QDRANT_COLLECTION")
            or os.getenv("LEXIA_USER_DOCS_COLLECTION")
            or "lexia_user_docs"
        )
        return [part.strip() for part in raw.split(",") if part.strip()]


class RetrievedChunk(BaseModel):
    """A Qdrant chunk with enough source metadata to become a graph node."""

    model_config = ConfigDict(extra="allow", arbitrary_types_allowed=True)

    qdrant_point_id: str
    chunk_id: Optional[str] = None
    document_id: Optional[str] = None
    judgment_id: Optional[str] = None
    source_pdf_id: Optional[str] = None
    source_pdf_path: Optional[str] = None
    qdrant_collection: str
    page_number: Optional[int] = None
    paragraph_index: Optional[int] = None
    section_title: Optional[str] = None
    section_type: Optional[str] = None
    text: str = ""
    text_preview: str = ""
    legal_entities: List[str] = Field(default_factory=list)
    cited_articles: List[str] = Field(default_factory=list)
    cited_cases: List[str] = Field(default_factory=list)
    qdrant_score: Optional[float] = None
    vector: Optional[Any] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class EdgeSpec(BaseModel):
    """Relationship metadata for a NetworkX edge."""

    source: str
    target: str
    relation_type: str
    weight: float
    confidence: float = 1.0
    explanation: str = ""
    evidence: List[str] = Field(default_factory=list)
    extraction_method: str
    edge_layer: Literal["reasoning", "discovery"] = "discovery"
    reasoning_edge: bool = False

    @field_validator("relation_type")
    @classmethod
    def _valid_relation(cls, value: str) -> str:
        if value not in LEGAL_RELATION_TYPES:
            raise ValueError(f"unsupported relation_type: {value}")
        return value

    @field_validator("extraction_method")
    @classmethod
    def _valid_method(cls, value: str) -> str:
        if value not in EXTRACTION_METHODS:
            raise ValueError(f"unsupported extraction_method: {value}")
        return value


class ReasoningPathStep(BaseModel):
    """One node in the answer reasoning path."""

    node_id: str
    chunk_id: Optional[str] = None
    section_type: Optional[str] = None
    section_title: Optional[str] = None
    text_preview: str = ""
    relation_to_next: Optional[str] = None
    edge_explanation: Optional[str] = None
    source: Dict[str, Any] = Field(default_factory=dict)


class FinalAnswer(BaseModel):
    """Structured output returned by GenerateAnswerNode."""

    answer: str
    supporting_chunks: List[str] = Field(default_factory=list)
    reasoning_path: List[Dict[str, Any]] = Field(default_factory=list)
    confidence_score: float = 0.0
    citations: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    raw_llm_output: Optional[str] = None
