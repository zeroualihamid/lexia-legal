"""Claude Code CLI wrapper for legal graph reasoning.

This module intentionally avoids Anthropic/OpenAI SDKs. It shells out to the
Claude Code CLI with ``CLAUDE_CODE_OAUTH_TOKEN`` / ``ANTHROPIC_AUTH_TOKEN`` and
returns structured JSON where possible. Callers must treat every method as
best-effort; graph writes and persistence should never depend on the LLM being
available.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from monitoring.logger import get_logger
from nodes.legal_graph.models import REASONING_RELATION_TYPES

logger = get_logger(__name__)


class ClaudeCodeClient:
    """Small, retrying Claude Code CLI abstraction."""

    def __init__(
        self,
        *,
        token: Optional[str] = None,
        binary: Optional[str] = None,
        timeout_seconds: int = 90,
        max_retries: int = 1,
        require_token: bool = False,
        cwd: Optional[str] = None,
    ) -> None:
        self.token = (
            token
            or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN")
            or None
        )
        self.binary = binary or os.environ.get("CLAUDE_BIN", "claude")
        self.timeout_seconds = timeout_seconds
        self.max_retries = max(0, max_retries)
        self.cwd = cwd or os.getcwd()
        self.binary_path = shutil.which(self.binary)
        self.available = bool(self.token and self.binary_path)
        if require_token and not self.token:
            raise RuntimeError("CLAUDE_CODE_OAUTH_TOKEN is required for LegalGraphAgent")
        if not self.token:
            logger.warning("Claude Code OAuth token is missing; legal graph LLM steps will degrade gracefully")
        if not self.binary_path:
            logger.warning("Claude Code binary not found on PATH; legal graph LLM steps will degrade gracefully")

    def validate_available(self) -> bool:
        """Return whether Claude Code can be spawned with an OAuth token."""
        return self.available

    def infer_relationship(
        self,
        *,
        source_node: Dict[str, Any],
        target_node: Dict[str, Any],
        query: str = "",
    ) -> Optional[Dict[str, Any]]:
        prompt = f"""
You are inferring one legal relationship between two Moroccan legal document chunks.
Use only the supplied chunks. Return JSON only.

Allowed relation_type values:
{sorted(REASONING_RELATION_TYPES)}

Prefer one of: applies_rule, supports, contradicts, explains, leads_to, resolves, rejects, grants, denies, based_on, proves, cites_article, cites_case.
Return null if no useful legal relationship exists.

Question:
{query}

Source chunk:
{self._compact_node(source_node)}

Target chunk:
{self._compact_node(target_node)}

JSON schema:
{{
  "relation_type": "supports",
  "confidence": 0.0,
  "explanation": "short explanation",
  "evidence": ["short quoted or paraphrased evidence"]
}}
"""
        data = self._invoke_json(prompt)
        if not isinstance(data, dict):
            return None
        relation_type = data.get("relation_type")
        if relation_type not in REASONING_RELATION_TYPES:
            return None
        confidence = self._float(data.get("confidence"), default=0.0)
        if confidence < 0.5:
            return None
        return {
            "relation_type": relation_type,
            "confidence": confidence,
            "explanation": str(data.get("explanation") or ""),
            "evidence": self._list(data.get("evidence")),
        }

    def classify_node_type(self, *, text: str, metadata: Dict[str, Any]) -> Optional[str]:
        prompt = f"""
Classify this Moroccan legal chunk for a reasoning graph. Return JSON only.

Allowed node_type values:
facts, procedure, party_claim, defendant_argument, plaintiff_argument,
evidence, legal_issue, applicable_rule, precedent, court_reasoning,
legal_analysis, final_decision, damages, costs, jurisdiction, admissibility,
party_definition, object, obligation, payment_clause, delivery_clause,
termination_clause, liability_clause, confidentiality_clause,
dispute_resolution, governing_law, signature, annex, unknown

Metadata:
{json.dumps(metadata, ensure_ascii=False, default=str)[:6000]}

Text:
{text[:6000]}

JSON schema:
{{"node_type": "court_reasoning", "confidence": 0.0, "explanation": "short"}}
"""
        data = self._invoke_json(prompt)
        if not isinstance(data, dict):
            return None
        node_type = str(data.get("node_type") or "").strip()
        if node_type in {
            "facts",
            "procedure",
            "party_claim",
            "defendant_argument",
            "plaintiff_argument",
            "evidence",
            "legal_issue",
            "applicable_rule",
            "precedent",
            "court_reasoning",
            "legal_analysis",
            "final_decision",
            "damages",
            "costs",
            "jurisdiction",
            "admissibility",
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
        }:
            return node_type
        return None

    def explain_reasoning_path(
        self,
        *,
        query: str,
        path_steps: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        prompt = f"""
Explain how this path answers a Moroccan legal question. Return JSON only.

Question:
{query}

Path:
{json.dumps(path_steps, ensure_ascii=False, default=str)[:16000]}

JSON schema:
{{
  "summary": "short explanation",
  "confidence_score": 0.0,
  "key_steps": ["..."]
}}
"""
        data = self._invoke_json(prompt)
        return data if isinstance(data, dict) else None

    def generate_legal_answer(
        self,
        *,
        query: str,
        path_steps: List[Dict[str, Any]],
        supporting_chunks: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        prompt = f"""
You are Lexia Legal's Moroccan legal reasoning agent.
Answer only from the supplied chunks. If the chunks do not support a conclusion,
say so. Do not answer without citing chunk ids.

The final answer must include:
1. direct answer
2. supporting chunks
3. reasoning path
4. confidence score from 0 to 1
5. citations formatted exactly:
[source_pdf_path, page X, section "SECTION_TITLE", chunk_id "CHUNK_ID"]

Question:
{query}

Reasoning path:
{json.dumps(path_steps, ensure_ascii=False, default=str)[:22000]}

Supporting chunks:
{json.dumps(supporting_chunks, ensure_ascii=False, default=str)[:22000]}

Return JSON only:
{{
  "answer": "Arabic or source-language answer",
  "supporting_chunks": ["chunk-id"],
  "reasoning_path": [{{"chunk_id": "id", "role": "claim/support/rule/reasoning/decision", "summary": "..."}}],
  "confidence_score": 0.0,
  "citations": ["[source.pdf, page 1, section \\"...\\"", "chunk_id \\"...\\"]"]
}}
"""
        data = self._invoke_json(prompt)
        return data if isinstance(data, dict) else None

    def _invoke_json(self, prompt: str) -> Optional[Any]:
        if not self.available:
            return None

        last_error: Optional[str] = None
        for attempt in range(self.max_retries + 1):
            try:
                raw = self._run_claude(prompt)
                parsed = self._extract_json(raw)
                if parsed is not None:
                    return parsed
                last_error = "Claude output did not contain valid JSON"
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                logger.warning("Claude Code call failed on attempt %s: %s", attempt + 1, exc)
            if attempt < self.max_retries:
                time.sleep(1.0 + attempt)
        if last_error:
            logger.warning("Claude Code JSON call degraded: %s", last_error)
        return None

    def _run_claude(self, prompt: str) -> str:
        assert self.binary_path is not None
        env = os.environ.copy()
        env.pop("ANTHROPIC_API_KEY", None)
        env["CLAUDE_CODE_OAUTH_TOKEN"] = str(self.token)
        env["ANTHROPIC_AUTH_TOKEN"] = str(self.token)

        base_dir = Path(os.environ.get("LEGAL_GRAPH_CLAUDE_HOME", "/tmp/lexia-legal-claude-code"))
        home_dir = base_dir / "home"
        config_dir = base_dir / "config"
        home_dir.mkdir(parents=True, exist_ok=True)
        config_dir.mkdir(parents=True, exist_ok=True)
        env["HOME"] = str(home_dir)
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)

        args = [
            self.binary_path,
            "--print",
            "--permission-mode",
            "dontAsk",
            "--tools",
            "",
            "--no-session-persistence",
        ]
        result = subprocess.run(
            args,
            input=prompt,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=self.timeout_seconds,
            cwd=self.cwd,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()[-1500:]
            raise RuntimeError(f"claude exited {result.returncode}: {stderr}")
        return result.stdout or ""

    @staticmethod
    def _extract_json(raw: str) -> Optional[Any]:
        text = (raw or "").strip()
        if not text:
            return None
        for candidate in _json_candidates(text):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
        return None

    @staticmethod
    def _compact_node(node: Dict[str, Any]) -> str:
        payload = {
            "node_id": node.get("qdrant_point_id") or node.get("chunk_id"),
            "chunk_id": node.get("chunk_id"),
            "document_id": node.get("document_id"),
            "judgment_id": node.get("judgment_id"),
            "section_title": node.get("section_title"),
            "section_type": node.get("section_type"),
            "page_number": node.get("page_number"),
            "text_preview": node.get("text_preview") or node.get("text", "")[:1200],
            "cited_articles": node.get("cited_articles") or [],
        }
        return json.dumps(payload, ensure_ascii=False, default=str)

    @staticmethod
    def _float(value: Any, *, default: float) -> float:
        try:
            return float(value)
        except Exception:
            return default

    @staticmethod
    def _list(value: Any) -> List[str]:
        if isinstance(value, list):
            return [str(item) for item in value]
        if value in (None, ""):
            return []
        return [str(value)]


def _json_candidates(text: str) -> List[str]:
    candidates: List[str] = []
    fenced = re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    candidates.extend(block.strip() for block in fenced if block.strip())
    candidates.append(text)
    first_obj = text.find("{")
    last_obj = text.rfind("}")
    if first_obj >= 0 and last_obj > first_obj:
        candidates.append(text[first_obj : last_obj + 1])
    first_arr = text.find("[")
    last_arr = text.rfind("]")
    if first_arr >= 0 and last_arr > first_arr:
        candidates.append(text[first_arr : last_arr + 1])
    return candidates
