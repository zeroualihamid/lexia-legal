# brikz-agent

AI-powered financial data analysis system that accepts natural language queries, decomposes them into executable steps, generates Python code via LLMs, runs it in a sandbox, and returns formatted results.

## Features

- **Natural language to code** — Ask questions in plain language; the system generates and executes Python (pandas, etc.)
- **PocketFlow workflow** — DAG-based orchestration with nodes for query intake, plan decomposition, code generation, reuse search, execution, and response formatting
- **Knowledge graph** — NetworkX + FAISS for finding similar prior executions and reusing code
- **Multi-source connectors** — SQL Server, CSV, QVD, Oracle, Supabase via a unified connector interface
- **Parquet caching** — Data and embeddings cached in `data/` for fast repeated access
- **Streaming API** — FastAPI with SSE streaming for chat and workflow execution

## Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) for dependency management

## Quick Start

```bash
# Install dependencies
uv sync

# Run tests
python -m pytest tests/

# Run dev server (port 6002, auto-reload)
python main.py

# Or with uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 6002 --reload
```

## Configuration

| File | Purpose |
|------|---------|
| `.env` | API keys (OpenAI, Anthropic, Groq, DeepSeek, Kimi), DB credentials, Supabase |
| `config/config.yaml` | LLM, embedding, codegen, chart, performance settings |
| `config/datasources.yaml` | Data source definitions (parquet paths, SQL tables, QVD, CSV) |
| `config/llm_config.yaml` | LLM providers and models |
| `config/loader_config.yaml` | Dataloader refresh settings |
| `config/graph_config.yaml` | Knowledge graph settings |
| `config/agents_config.yaml` | Agent (proposer/challenger) settings |

## Project Structure

```
brikz-agent/
├── main.py              # FastAPI app entry point
├── config/              # YAML configs
├── flows/               # PocketFlow workflows
│   ├── main_workflow.py # Main chat pipeline
│   ├── dataloader_flow.py
│   ├── code_generation_flow.py
│   └── ...
├── nodes/               # Workflow nodes
│   ├── input/           # Query intake, schema loading, context retrieval
│   ├── processing/      # Augmentation, plan decomposition, step routing
│   ├── generation/      # Code generation, validation
│   ├── graph/          # Knowledge graph search
│   ├── execution/      # Code writer, sandbox, result handler
│   ├── dataloader/     # Connectors, cache, embeddings
│   └── output/         # Response formatting, conversation update
├── services/           # Connectors, cache, embeddings
├── graph/              # Reasoning graph, similarity search
├── llm/                # LLM clients, prompts
├── agents/             # Domain agents, card orchestration
├── sandbox.py          # Subprocess execution sandbox
└── data/               # Parquet cache, outputs, QVD files
```

## Main Workflow

```
QueryInput → ContextRetrieval → QueryAugmentation → PlanDecomposition → StepRouter
  ├─[has_steps_and_try_reuse]→ GraphSearch ─[found_similar]→ StepRouter
  │                            └─[no_match]→ CodeGeneration → StepRouter
  ├─[has_steps_and_need_generate]→ CodeGeneration → StepRouter
  └─[no_more_steps]→ ConversationUpdate → ResponseFormatter
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /chat/stream` | Streaming chat (SSE) |
| `GET /api/v1/chat` | Submit chat (returns task ID) |
| `GET /api/v1/stream/{taskId}` | Stream task results |
| `GET /api/v1/tasks/{taskId}` | Poll task status |
| `GET /parquet/*` | Parquet sources, cache, embeddings |
| `GET /health` | Health check |
| `/docs` | OpenAPI (Swagger) UI |

## Data Flow

1. **Data sources** — Defined in `config/datasources.yaml` (SQL, CSV, QVD, etc.)
2. **Connectors** — Fetch data in `services/connectors/`; cache to Parquet in `data/`
3. **Embeddings** — Column embeddings cached as `data/{source_id}_embeddings.parquet`
4. **Generated code** — Saved to `data/outputs/` and executed in sandbox

## Key Conventions

- PocketFlow nodes use `prep()` → `exec()` → `post()`; return action strings from `post()` for routing
- Shared state dict is the communication mechanism between nodes
- Generated code runs in sandboxed subprocess (see `sandbox.py`)

## Optional Dependencies

```bash
# Oracle connector
uv sync --extra oracle
```
