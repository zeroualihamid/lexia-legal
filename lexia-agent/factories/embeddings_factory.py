import logging
import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple, Union

from openai import OpenAI, AsyncOpenAI
from ollama import Client as OllamaClient
from ollama import AsyncClient as AsyncOllamaClient

# Add parent directory to path to allow importing config module
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config import EmbeddingConfig, get_settings

logger = logging.getLogger(__name__)

# Global cache for embeddings clients
_embeddings_clients_cache: Optional[Tuple[OpenAI, AsyncOpenAI]] = None


# ============================================================================
# Ollama Wrapper Classes (OpenAI-compatible interface)
# ============================================================================

@dataclass
class EmbeddingData:
    """Mimics OpenAI's embedding data structure."""
    embedding: List[float]
    index: int = 0
    object: str = "embedding"


@dataclass
class EmbeddingUsage:
    """Mimics OpenAI's usage structure."""
    prompt_tokens: int = 0
    total_tokens: int = 0


@dataclass
class CreateEmbeddingResponse:
    """Mimics OpenAI's CreateEmbeddingResponse structure."""
    data: List[EmbeddingData]
    model: str
    object: str = "list"
    usage: EmbeddingUsage = None
    
    def __post_init__(self):
        if self.usage is None:
            self.usage = EmbeddingUsage()


class OllamaEmbeddings:
    """Wrapper that provides OpenAI-compatible embeddings interface for Ollama."""
    
    def __init__(self, client: OllamaClient):
        self._client = client
    
    def create(
        self,
        input: Union[str, List[str]],
        model: str,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> CreateEmbeddingResponse:
        """
        Create embeddings using Ollama, with OpenAI-compatible interface.
        
        Args:
            input: Text or list of texts to embed
            model: Model name (e.g., 'bge-m3:latest')
            dimensions: Ignored for Ollama (model-dependent)
            **kwargs: Additional arguments (ignored)
        
        Returns:
            CreateEmbeddingResponse with OpenAI-compatible structure
        """
        # Ollama's embed() method
        response = self._client.embed(model=model, input=input)
        
        # Convert to OpenAI-compatible format
        embeddings_list = response.get("embeddings", [])
        data = [
            EmbeddingData(embedding=emb, index=i)
            for i, emb in enumerate(embeddings_list)
        ]
        
        return CreateEmbeddingResponse(data=data, model=model)


class AsyncOllamaEmbeddings:
    """Async wrapper that provides OpenAI-compatible embeddings interface for Ollama."""
    
    def __init__(self, client: AsyncOllamaClient):
        self._client = client
    
    async def create(
        self,
        input: Union[str, List[str]],
        model: str,
        dimensions: Optional[int] = None,
        **kwargs
    ) -> CreateEmbeddingResponse:
        """
        Create embeddings using Ollama asynchronously, with OpenAI-compatible interface.
        """
        response = await self._client.embed(model=model, input=input)
        
        embeddings_list = response.get("embeddings", [])
        data = [
            EmbeddingData(embedding=emb, index=i)
            for i, emb in enumerate(embeddings_list)
        ]
        
        return CreateEmbeddingResponse(data=data, model=model)


class OllamaOpenAIWrapper:
    """
    Wrapper class that makes Ollama client behave like OpenAI client.
    
    Usage:
        wrapper = OllamaOpenAIWrapper(ollama_client)
        response = wrapper.embeddings.create(input="text", model="bge-m3:latest")
        embedding = response.data[0].embedding
    """
    
    def __init__(self, client: OllamaClient):
        self._client = client
        self.embeddings = OllamaEmbeddings(client)


class AsyncOllamaOpenAIWrapper:
    """
    Async wrapper class that makes Ollama client behave like AsyncOpenAI client.
    """
    
    def __init__(self, client: AsyncOllamaClient):
        self._client = client
        self.embeddings = AsyncOllamaEmbeddings(client)


@lru_cache()
def get_embeddings(config: Optional[EmbeddingConfig] = None) -> Tuple[OpenAI, AsyncOpenAI]:
    """
    Get an embedding model instance.
    Uses LRU cache to maintain single instance per configuration.

    Args:
        provider: The embedding provider (openai, huggingface, huggingface-bge, cohere)
        model_name: The specific model to use
        **kwargs: Additional configuration parameters

    Returns:
        Embeddings instance

       """


    global _embeddings_clients_cache

    # Return cached clients if available and no custom config provided
    if _embeddings_clients_cache is not None and config is None:
        return _embeddings_clients_cache
    
    settings = get_settings()
    embedding_config = config if config else settings.embedding
    provider = embedding_config.provider.lower()

    try:
        if provider == "openai":
            api_key = os.getenv("OPENAI_API_KEY", "")
            sync_client = OpenAI(
                api_key=api_key,
                timeout=embedding_config.timeout,
                max_retries=embedding_config.max_retries
            )
            async_client = AsyncOpenAI(
                api_key=api_key,
                timeout=embedding_config.timeout,
                max_retries=embedding_config.max_retries
            )
            if config is None:
                _embeddings_clients_cache = (sync_client, async_client)
                
            return sync_client, async_client

        elif provider == "ollama":
            # Ollama Python client uses 'host' parameter (not 'base_url')
            # The client handles /api/embeddings endpoint internally
            host = embedding_config.base_url or "http://localhost:11434"
            host = host.rstrip('/')
            
            # Create native Ollama clients
            ollama_sync = OllamaClient(
                host=host,
                timeout=embedding_config.timeout
            )
            ollama_async = AsyncOllamaClient(
                host=host,
                timeout=embedding_config.timeout
            )
            
            # Wrap with OpenAI-compatible interface
            sync_client = OllamaOpenAIWrapper(ollama_sync)
            async_client = AsyncOllamaOpenAIWrapper(ollama_async)
            
            if config is None:
                _embeddings_clients_cache = (sync_client, async_client)
            return sync_client, async_client


    except Exception as e:
        logger.error(f"Error creating embeddings for provider {settings.embedding.provider}: {e}")
        raise


if __name__ == "__main__":
    import asyncio
    import traceback
    
    print("=" * 60)
    print("Testing Embeddings Factory")
    print("=" * 60)
    
    settings = get_settings()
    provider = settings.embedding.provider.lower()
    
    sync_client, async_client = get_embeddings()
    
    # Print client configuration
    print(f"\n✅ Client Configuration:")
    print(f"   Provider: {provider}")
    
    # Handle different client types
    if hasattr(sync_client, 'base_url'):
        # OpenAI client
        print(f"   Sync client base_url: {sync_client.base_url}")
        print(f"   Async client base_url: {async_client.base_url}")
    elif hasattr(sync_client, '_client'):
        # Ollama client
        print(f"   Ollama client initialized")
    
    # Test using unified OpenAI-compatible interface (works for both providers)
    print(f"\n{'='*60}")
    print(f"Testing sync client ({provider})...")
    print(f"{'='*60}")
    try:
        sync_response = sync_client.embeddings.create(
            input="Hello, world!", 
            model=settings.embedding.model,
            dimensions=settings.embedding.dimensions
        )
        if sync_response.data and len(sync_response.data) > 0:
            print(f"✅ Sync client works! Embedding dimensions: {len(sync_response.data[0].embedding)}")
            print(f"   Model: {sync_response.model}")
            print(f"   First 5 embedding values: {sync_response.data[0].embedding[:5]}")
        else:
            print(f"⚠️  Warning: Empty embedding array received")
    except Exception as e:
        print(f"❌ Sync client error: {e}")
        print(f"   Error type: {type(e).__name__}")
        traceback.print_exc()
    
    print(f"\n{'='*60}")
    print(f"Testing async client ({provider})...")
    print(f"{'='*60}")
    async def test_async():
        try:
            async_response = await async_client.embeddings.create(
                input="Hello, world!", 
                model=settings.embedding.model,
                dimensions=settings.embedding.dimensions
            )
            if async_response.data and len(async_response.data) > 0:
                print(f"✅ Async client works! Embedding dimensions: {len(async_response.data[0].embedding)}")
                print(f"   Model: {async_response.model}")
                print(f"   First 5 embedding values: {async_response.data[0].embedding[:5]}")
            else:
                print(f"⚠️  Warning: Empty embedding array received")
        except Exception as e:
            print(f"❌ Async client error: {e}")
            print(f"   Error type: {type(e).__name__}")
            traceback.print_exc()
    
    asyncio.run(test_async())
    
    print(f"\n{'='*60}")
    print("Test Complete")
    print(f"{'='*60}")