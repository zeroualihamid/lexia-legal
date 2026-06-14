"""
Pydantic models for the Thinking Agent.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Configuration ──────────────────────────────────────────────


class LLMProvider(str, Enum):
    OPENCODE = "opencode"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    DEEPSEEK = "deepseek"
    GROQ = "groq"
    KIMI = "kimi"


class AgentConfig(BaseModel):
    """Top-level configuration for the agent."""

    # LLM
    llm_provider: LLMProvider = LLMProvider.OPENAI
    llm_base_url: str = "http://localhost:4096"
    llm_api_key: Optional[str] = None
    llm_model: str = "o3-mini"  # thinking model
    llm_temperature: float = 1.0  # thinking models usually want temperature=1

    # Paths
    skills_dir: Path = Path("skills")
    prompts_dir: Path = Path("prompts")
    data_dir: Path = Path("python-data-analyser/data")
    output_dir: Path = Path("agent-analyst/generated")

    # Agent behaviour
    max_iterations: int = 5
    sandbox_timeout: int = 30


# ── Skill ──────────────────────────────────────────────────────


class Skill(BaseModel):
    """A loaded skill definition."""

    name: str
    description: str
    triggers: list[str] = Field(default_factory=list)
    readme: str = ""  # Full SKILL.md content
    scripts: dict[str, str] = Field(default_factory=dict)  # filename -> content
    references: dict[str, str] = Field(default_factory=dict)  # filename -> content


# ── Plan ───────────────────────────────────────────────────────


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class PlanStep(BaseModel):
    """A single step in the execution plan."""

    id: int
    description: str
    skill: Optional[str] = None  # which skill to use (e.g. "parquet-reader")
    tables: list[str] = Field(default_factory=list)  # relevant tables / files
    code: Optional[str] = None  # generated Python code
    script_path: Optional[str] = None  # path to saved script file
    output: Optional[str] = None  # stdout from execution
    result: Any = None  # parsed result value
    error: Optional[str] = None
    status: StepStatus = StepStatus.PENDING


class Plan(BaseModel):
    """An execution plan produced by the thinking phase."""

    query: str
    reasoning: str = ""  # LLM chain-of-thought
    steps: list[PlanStep] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.now)


# ── Execution ──────────────────────────────────────────────────


class ExecutionResult(BaseModel):
    """Result of running a generated script."""

    success: bool
    output: str = ""
    error: Optional[str] = None
    result: Any = None


class AgentResponse(BaseModel):
    """Final agent response returned to the caller."""

    query: str
    plan: Plan
    answer: str = ""
    iterations: int = 0
    scripts_generated: list[str] = Field(default_factory=list)
    timestamp: datetime = Field(default_factory=datetime.now)
