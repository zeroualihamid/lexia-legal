# llm/llm_factory.py

"""
LLM Factory
===========

Factory pattern for creating LLM clients.

- **config.yaml** is the single source of truth for *which provider* to use
  (default LLM + per-task routing).
- **llm_config.yaml** is a provider catalog: models, default_model, base_url,
  timeout, etc.
- API keys come from environment variables (OPENAI_API_KEY, GROQ_API_KEY, …).
"""

import functools
import os
import re
from typing import Optional, Dict, Any
import yaml
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

from llm.base_llm import BaseLLM, LLMConfig
from llm.anthropic_client import AnthropicClient
from llm.openai_client import OpenAIClient
from llm.groq_client import GroqClient
from monitoring.logger import get_logger

logger = get_logger(__name__)

# Maps provider name → env var holding its API key
_API_KEY_ENV_VARS: Dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "groq": "GROQ_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "vllm": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def _resolve_api_key(provider: str) -> Optional[str]:
    """Return the API key for *provider* from the environment."""
    env_var = _API_KEY_ENV_VARS.get(provider, f"{provider.upper()}_API_KEY")
    return os.getenv(env_var)


def _resolve_provider_config(provider: str) -> Dict[str, Any]:
    """
    Return merged provider config from llm_config.yaml:
    {default_model, base_url, timeout, max_retries, …}
    """
    cfg = _load_llm_yaml()
    pcfg = cfg.get("providers", {}).get(provider, {})
    settings = pcfg.get("settings", {})
    return {
        "default_model": pcfg.get("default_model"),
        "base_url": settings.get("base_url"),
        "timeout": settings.get("timeout"),
        "max_retries": settings.get("max_retries"),
    }


# ── Public API ────────────────────────────────────────────────────────────


def create_llm_client(
    config=None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    _tried: Optional[set] = None,
    **kwargs,
) -> BaseLLM:
    """
    Create an LLM client.

    Resolution order for every parameter:
      explicit arg  ➜  config.yaml (via get_settings().llm)  ➜  llm_config.yaml provider catalog  ➜  hard-coded default

    Args:
        config:   Settings object (default: get_settings()).
        provider: Override provider ('anthropic', 'openai', 'groq', 'vllm', 'deepseek').
        model:    Override model name.
        **kwargs: temperature, max_tokens, api_key, base_url, timeout, max_retries.
    """
    if config is None:
        from config import get_settings
        config = get_settings()

    if _tried is None:
        _tried = set()

    llm_cfg = getattr(config, "llm", None)

    final_provider = (
        provider
        or (getattr(llm_cfg, "provider", None) if llm_cfg else None)
        or getattr(config, "llm_provider", "openai")
    )

    pcfg = _resolve_provider_config(final_provider)

    final_model = (
        model
        or (getattr(llm_cfg, "model", None) if llm_cfg else None)
        or pcfg.get("default_model")
        or _get_default_model(final_provider)
    )

    temperature = kwargs.get(
        "temperature",
        getattr(llm_cfg, "temperature", None) if llm_cfg else None,
    )
    if temperature is None:
        temperature = 0.2

    max_tokens = kwargs.get(
        "max_tokens",
        getattr(llm_cfg, "max_tokens", None) if llm_cfg else None,
    )
    if max_tokens is None:
        max_tokens = 4096

    api_key = kwargs.get("api_key") or _resolve_api_key(final_provider)

    # When the provider was explicitly overridden (e.g. via task routing),
    # the provider catalog (pcfg) takes priority over the default llm block.
    provider_was_overridden = provider is not None

    base_url = (
        kwargs.get("base_url")
        or (pcfg.get("base_url") if provider_was_overridden else None)
        or (getattr(llm_cfg, "base_url", None) if llm_cfg else None)
        or pcfg.get("base_url")
    )
    # ``llm_cfg.base_url`` may still carry an unexpanded ``${VAR}`` (the settings
    # layer does not substitute llm_config.yaml), so resolve it here.
    base_url = _substitute_env_vars(base_url)

    timeout = kwargs.get(
        "timeout",
        (pcfg.get("timeout") if provider_was_overridden else None)
        or pcfg.get("timeout")
        or (getattr(llm_cfg, "timeout", None) if llm_cfg else None)
        or 180,
    )

    max_retries = kwargs.get(
        "max_retries",
        (pcfg.get("max_retries") if provider_was_overridden else None)
        or pcfg.get("max_retries")
        or (getattr(llm_cfg, "max_retries", None) if llm_cfg else None)
        or 3,
    )

    _tried.add(final_provider)

    llm_config = LLMConfig(
        provider=final_provider,
        model=final_model,
        temperature=temperature,
        max_tokens=max_tokens,
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        max_retries=max_retries,
    )

    logger.info(
        f"LLMConfig: provider={final_provider}, model={llm_config.model}, base_url={base_url!r}"
    )

    try:
        if final_provider == "anthropic":
            client = AnthropicClient(llm_config)
        elif final_provider in ("openai", "vllm", "openrouter", "deepseek"):
            client = OpenAIClient(llm_config)
        elif final_provider == "groq":
            client = GroqClient(llm_config)
        else:
            raise ValueError(f"Unsupported provider: {final_provider}")

        logger.info(f"Created {final_provider} client: {llm_config.model}")
        return client

    except Exception as e:
        logger.error(f"Failed to create {final_provider} client: {e}")

        fallback = _get_fallback_provider(final_provider)
        if fallback and fallback not in _tried:
            logger.info(f"Trying fallback: {fallback}")
            return create_llm_client(
                config=config, provider=fallback, _tried=_tried, **kwargs
            )

        raise


def create_client_for_task(task_type: str, config=None, **kwargs) -> BaseLLM:
    """
    Create an LLM client for a specific task.

    Reads ``task_routing`` from config.yaml to decide the *provider*.
    Model / base_url / timeout come from ``llm_config.yaml`` for that provider.
    Falls back to the default ``llm.provider`` if the task has no routing entry.

    Args:
        task_type: e.g. 'code_generation', 'card_generation', 'agent_proposal' …
        config:    Settings object (default: get_settings()).
    """
    if config is None:
        from config import get_settings
        config = get_settings()

    routing = getattr(config, "task_routing", {}) or {}
    task_provider = routing.get(task_type)

    if task_provider:
        pcfg = _resolve_provider_config(task_provider)
        task_model = pcfg.get("default_model")
        logger.info(
            f"Task '{task_type}' → provider={task_provider}, model={task_model} (from config.yaml routing)"
        )
        return create_llm_client(
            config=config, provider=task_provider, model=task_model, **kwargs
        )

    logger.info(f"Task '{task_type}': no routing entry, using default LLM provider")
    return create_llm_client(config=config, **kwargs)


# ── Multi-client helpers ──────────────────────────────────────────────────


def create_multiple_clients(providers: list, config=None) -> Dict[str, BaseLLM]:
    clients = {}
    for provider in providers:
        try:
            clients[provider] = create_llm_client(config=config, provider=provider)
        except Exception as e:
            logger.warning(f"Failed to create {provider}: {e}")
    return clients


class LLMClientPool:
    """Round-robin pool of LLM clients."""

    def __init__(self, providers: list, config=None):
        self.clients = create_multiple_clients(providers, config)
        self.current_index = 0

    def get_client(self, strategy: str = "round_robin") -> BaseLLM:
        if strategy == "round_robin":
            providers = list(self.clients.keys())
            if not providers:
                raise RuntimeError("No clients available")
            provider = providers[self.current_index % len(providers)]
            self.current_index += 1
            return self.clients[provider]
        return list(self.clients.values())[0]


# ── Internal helpers ──────────────────────────────────────────────────────


def _get_default_model(provider: str) -> str:
    defaults = {
        "anthropic": "claude-sonnet-4",
        "openai": "gpt-4-turbo",
        "groq": "llama-3.3-70b-versatile",
        "vllm": "openai/gpt-oss-120b",
        "deepseek": "deepseek-chat",
        "openrouter": "moonshotai/kimi-k2.5",
    }
    return defaults.get(provider, "gpt-4-turbo")


def _get_fallback_provider(provider: str) -> Optional[str]:
    fallbacks = {
        "anthropic": "groq",
        "openai": "groq",
        "groq": "anthropic",
        "vllm": "groq",
        "deepseek": "groq",
        "openrouter": "groq",
    }
    return fallbacks.get(provider)


def _substitute_env_vars(value: Any) -> Any:
    """Recursively replace ``${VAR}`` patterns with environment variable values.

    Mirrors ``config._substitute_env_vars``: unset variables are left intact so
    misconfiguration is visible rather than silently blanked.
    """
    if isinstance(value, dict):
        return {k: _substitute_env_vars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute_env_vars(v) for v in value]
    if isinstance(value, str):
        return re.sub(
            r"\$\{([^}]+)\}",
            lambda m: os.getenv(m.group(1), m.group(0)),
            value,
        )
    return value


@functools.lru_cache(maxsize=1)
def _load_llm_yaml() -> Dict:
    """Load and cache llm_config.yaml (provider catalog).

    Values support ``${VAR}`` environment substitution (e.g. ``base_url``) so
    that environment-specific endpoints stay out of the tracked config file.
    """
    config_path = Path("config/llm_config.yaml")
    if config_path.exists():
        try:
            with open(config_path) as f:
                return _substitute_env_vars(yaml.safe_load(f) or {})
        except Exception:
            pass
    return {}


# ── Legacy API (drop-in replacement for factories/llm_factory.py) ─────────

from typing import Tuple
from openai import OpenAI, AsyncOpenAI

_raw_clients_cache: Optional[Tuple[OpenAI, AsyncOpenAI]] = None


_OPENAI_COMPAT_PROVIDERS = frozenset({"openai", "vllm", "deepseek", "openrouter", "groq"})

_OPENAI_COMPAT_FALLBACK_ORDER = ["openrouter", "openai", "groq", "deepseek", "vllm"]


def _find_openai_compat_fallback(original_provider: str) -> Optional[str]:
    """Find the first OpenAI-compatible provider with a valid API key."""
    for candidate in _OPENAI_COMPAT_FALLBACK_ORDER:
        key = _resolve_api_key(candidate)
        if key:
            return candidate
    return None


def get_llm(config=None) -> Tuple[OpenAI, AsyncOpenAI]:
    """Return raw (sync, async) OpenAI-compatible SDK clients.

    This mirrors the old ``factories.llm_factory.get_llm()`` interface so that
    callers doing ``client, _ = get_llm()`` followed by
    ``client.chat.completions.create(...)`` keep working unchanged.

    When the configured default provider is NOT OpenAI-compatible (e.g.
    ``anthropic``), the function falls back to the first available
    OpenAI-compatible provider with a valid API key.
    """
    global _raw_clients_cache
    if _raw_clients_cache is not None and config is None:
        return _raw_clients_cache

    from config import get_settings as _gs

    settings = config or _gs()
    llm_cfg = getattr(settings, "llm", None)
    provider = (getattr(llm_cfg, "provider", None) if llm_cfg else None) or "openai"

    if provider not in _OPENAI_COMPAT_PROVIDERS:
        fallback = _find_openai_compat_fallback(provider)
        if fallback:
            logger.info(
                "get_llm(): provider '%s' is not OpenAI-compatible, "
                "falling back to '%s' for raw SDK calls",
                provider, fallback,
            )
            provider = fallback
        else:
            logger.warning(
                "get_llm(): provider '%s' is not OpenAI-compatible and no "
                "fallback found — the OpenAI SDK client may fail", provider,
            )

    pcfg = _resolve_provider_config(provider)

    model = (getattr(llm_cfg, "model", None) if llm_cfg else None) or pcfg.get("default_model") or _get_default_model(provider)
    base_url = (getattr(llm_cfg, "base_url", None) if llm_cfg else None) or pcfg.get("base_url")
    base_url = _substitute_env_vars(base_url)
    timeout = pcfg.get("timeout") or (getattr(llm_cfg, "timeout", None) if llm_cfg else None) or 120
    max_retries = pcfg.get("max_retries") or (getattr(llm_cfg, "max_retries", None) if llm_cfg else None) or 3

    api_key = _resolve_api_key(provider) or os.getenv("OPENAI_API_KEY", "")

    client_kwargs: Dict[str, Any] = {
        "api_key": api_key or "dummy",
        "timeout": timeout,
        "max_retries": max_retries,
    }
    if base_url:
        url = base_url.rstrip("/")
        if not url.endswith("/v1"):
            url = f"{url}/v1"
        client_kwargs["base_url"] = url

    sync_client = OpenAI(**client_kwargs)
    async_client = AsyncOpenAI(**client_kwargs)

    logger.info(f"Initialized {provider} LLM (model: {model}, temp: {getattr(llm_cfg, 'temperature', 0.2)})")
    if base_url:
        logger.info(f"OpenAI client initialized (base_url={client_kwargs.get('base_url')})")

    if config is None:
        _raw_clients_cache = (sync_client, async_client)

    return sync_client, async_client


def clear_llm_cache():
    """Clear cached LLM clients to force reinitialization."""
    global _raw_clients_cache
    _raw_clients_cache = None
    logger.info("LLM client cache cleared")


# ── Convenience shortcuts ─────────────────────────────────────────────────


def get_cheapest_client(config=None) -> BaseLLM:
    return create_llm_client(config=config, provider="groq")


def get_fastest_client(config=None) -> BaseLLM:
    return create_llm_client(config=config, provider="groq", model="llama-3.1-8b-instant")


def get_highest_quality_client(config=None) -> BaseLLM:
    try:
        return create_llm_client(config=config, provider="anthropic", model="claude-opus-4")
    except Exception:
        return create_llm_client(config=config, provider="anthropic")
