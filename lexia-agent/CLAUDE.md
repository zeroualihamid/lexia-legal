# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

brikz-agent is a financial data analysis system that accepts natural language queries, decomposes them into executable steps, generates Python code via LLMs, runs it in a sandbox, and returns formatted results. It combines PocketFlow-based workflow orchestration, a NetworkX knowledge graph for code reuse, and multi-source data connectors (SQL Server, CSV, QVD, Oracle).

## Commands

```bash
# Run dev server (port 6002, auto-reload)
python main.py

# Run with uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 6002 --reload

# Install dependencies (uses uv)
uv sync

# Run tests
python -m pytest tests/
```

## Architecture

### Flow-Based Workflow (PocketFlow)

The core pipeline is a DAG defined in `flows/main_workflow.py`. Each node implements `prep()`, `exec()`, `post()` methods and communicates via a shared state dictionary. The main flow:

```
QueryInput → ContextRetrieval → QueryAugmentation → PlanDecomposition → StepRouter
  ├─[has_steps_and_try_reuse]→ GraphSearch ─[found_similar]→ StepRouter
  │                            └─[no_match]→ CodeGeneration → StepRouter
  ├─[has_steps_and_need_generate]→ CodeGeneration → StepRouter
  └─[no_more_steps]→ ConversationUpdate → ResponseFormatter
```

Nodes are organized by function under `nodes/`:
- `input/` — query intake and context retrieval
- `processing/` — query augmentation, plan decomposition, step routing
- `generation/` — LLM-based code generation
- `graph/` — knowledge graph search for reusable code
- `execution/` — code writing, sandbox execution, result handling
- `output/` — conversation update and response formatting
- `agents/` — proposer/challenger/consensus debate nodes

### Knowledge Graph (`graph/`)

NetworkX-backed graph with FAISS vector search for finding similar prior code executions. Edge types: `LEADS_TO`, `SIMILAR_TO`, `REFINES`, `DEPENDS_ON`, `ALTERNATIVE_TO`. Persisted to disk.

### Multi-Source Data Connectors (`services/connectors/`)

Factory pattern in `main.py:_create_connector()`. Each connector type (QVD, SQLServer, CSV, Oracle) implements a common interface. `ConnectorManager` handles registration, caching (Parquet-based), embeddings, and lifecycle. `RefreshScheduler` polls sources with `polling` refresh policy.

### LLM Integration (`llm/`)

Factory pattern via `llm/llm_factory.py` supporting OpenAI, Anthropic, Groq, DeepSeek, and Kimi providers. Streaming, retry with backoff, and token counting built in.

### Adversarial Agent System (`agents/`)

Proposer-challenger-consensus architecture for code quality refinement, orchestrated by `flows/debate_flow.py`.

## Configuration

- `config/config.yaml` — LLM, embedding, codegen, chart, performance settings
- `config/datasources.yaml` — Data source definitions (parquet paths, SQL tables, QVD, CSV)
- `.env` — API keys (OpenAI, Anthropic, Groq, DeepSeek, Kimi) and database credentials
- `config.py` — Pydantic settings that merge YAML config with environment variable substitution (`${VAR}` syntax in YAML)
- Data source column schemas defined as DTOs in `classes/dtos/`

## Key Conventions

- Python 3.12+, dependency management with `uv` (lock file: `uv.lock`)
- PocketFlow nodes return action strings from `post()` to control graph routing
- Shared state dict is the communication mechanism between nodes — not function returns
- Generated code is saved to `data/outputs/` and executed via `sandbox.py` (subprocess isolation)
- Embeddings use Ollama with `bge-m3` model; vector search uses FAISS
- Prompts are modular templates under `prompts/` and `llm/prompts/`
- FastAPI app exposes `/chat/` (streaming) and `/data/` route groups, plus `/health`
