"""
Redis Client Factory

Provides a singleton Redis client with connection pooling for RAG caching.
Supports graceful degradation when Redis is unavailable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger(__name__)

# Singleton instances
_redis_client: Optional[Any] = None
_redis_available: Optional[bool] = None


def get_redis_client() -> Optional[Any]:
    """
    Get or create a singleton Redis client with connection pooling.
    
    Returns:
        Redis client instance or None if Redis is unavailable.
    """
    global _redis_client, _redis_available
    
    # If we already know Redis is unavailable, return None immediately
    if _redis_available is False:
        return None
    
    # If we already have a client, return it
    if _redis_client is not None:
        return _redis_client
    
    # Try to create a new client
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        logger.warning("REDIS_URL not set - Redis caching disabled")
        _redis_available = False
        return None
    
    try:
        import redis
        from redis import ConnectionPool
        
        # Create connection pool for better performance
        pool = ConnectionPool.from_url(
            redis_url,
            max_connections=20,
            decode_responses=False,  # We handle encoding ourselves for binary data
            socket_timeout=5.0,
            socket_connect_timeout=5.0,
            retry_on_timeout=True,
        )
        
        _redis_client = redis.Redis(connection_pool=pool)
        
        # Test connection
        _redis_client.ping()
        
        _redis_available = True
        logger.info("✅ Redis client initialized successfully")
        return _redis_client
        
    except ImportError:
        logger.warning("redis package not installed - Redis caching disabled")
        _redis_available = False
        return None
    except Exception as e:
        logger.warning(f"Failed to connect to Redis: {e} - Redis caching disabled")
        _redis_available = False
        return None


def is_redis_available() -> bool:
    """Check if Redis is available."""
    global _redis_available
    if _redis_available is None:
        get_redis_client()
    return _redis_available or False


def redis_get(key: str) -> Optional[bytes]:
    """
    Get a value from Redis.
    
    Args:
        key: Redis key
        
    Returns:
        Value as bytes or None if not found/error
    """
    client = get_redis_client()
    if not client:
        return None
    
    try:
        return client.get(key)
    except Exception as e:
        logger.debug(f"Redis GET error for {key}: {e}")
        return None


def redis_set(
    key: str,
    value: Union[str, bytes],
    ttl_seconds: int = 3600
) -> bool:
    """
    Set a value in Redis with TTL.
    
    Args:
        key: Redis key
        value: Value to store
        ttl_seconds: Time to live in seconds (default 1 hour)
        
    Returns:
        True if successful, False otherwise
    """
    client = get_redis_client()
    if not client:
        return False
    
    try:
        if isinstance(value, str):
            value = value.encode('utf-8')
        client.setex(key, ttl_seconds, value)
        return True
    except Exception as e:
        logger.debug(f"Redis SET error for {key}: {e}")
        return False


def redis_get_json(key: str) -> Optional[Dict[str, Any]]:
    """
    Get a JSON value from Redis.
    
    Args:
        key: Redis key
        
    Returns:
        Parsed JSON dict or None if not found/error
    """
    data = redis_get(key)
    if data is None:
        return None
    
    try:
        return json.loads(data.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        logger.debug(f"Redis JSON decode error for {key}: {e}")
        return None


def redis_set_json(
    key: str,
    value: Dict[str, Any],
    ttl_seconds: int = 3600
) -> bool:
    """
    Set a JSON value in Redis with TTL.
    
    Args:
        key: Redis key
        value: Dict to store as JSON
        ttl_seconds: Time to live in seconds
        
    Returns:
        True if successful, False otherwise
    """
    try:
        json_str = json.dumps(value, ensure_ascii=False)
        return redis_set(key, json_str, ttl_seconds)
    except (TypeError, ValueError) as e:
        logger.debug(f"Redis JSON encode error for {key}: {e}")
        return False


def redis_get_embedding(key: str) -> Optional[List[float]]:
    """
    Get an embedding vector from Redis.
    
    Args:
        key: Redis key
        
    Returns:
        Embedding as list of floats or None
    """
    data = redis_get(key)
    if data is None:
        return None
    
    try:
        return json.loads(data.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def redis_set_embedding(
    key: str,
    embedding: List[float],
    ttl_seconds: int = 86400  # 24 hours default
) -> bool:
    """
    Store an embedding vector in Redis.
    
    Args:
        key: Redis key
        embedding: Embedding vector
        ttl_seconds: Time to live in seconds (default 24 hours)
        
    Returns:
        True if successful
    """
    try:
        json_str = json.dumps(embedding)
        return redis_set(key, json_str, ttl_seconds)
    except (TypeError, ValueError):
        return False


def redis_delete(key: str) -> bool:
    """
    Delete a key from Redis.
    
    Args:
        key: Redis key
        
    Returns:
        True if deleted, False otherwise
    """
    client = get_redis_client()
    if not client:
        return False
    
    try:
        client.delete(key)
        return True
    except Exception as e:
        logger.debug(f"Redis DELETE error for {key}: {e}")
        return False


def redis_delete_pattern(pattern: str) -> int:
    """
    Delete all keys matching a pattern.
    
    Args:
        pattern: Key pattern (e.g., "rag:query:*")
        
    Returns:
        Number of keys deleted
    """
    client = get_redis_client()
    if not client:
        return 0
    
    try:
        keys = list(client.scan_iter(match=pattern, count=1000))
        if keys:
            return client.delete(*keys)
        return 0
    except Exception as e:
        logger.debug(f"Redis DELETE pattern error for {pattern}: {e}")
        return 0


def redis_exists(key: str) -> bool:
    """
    Check if a key exists in Redis.
    
    Args:
        key: Redis key
        
    Returns:
        True if exists
    """
    client = get_redis_client()
    if not client:
        return False
    
    try:
        return client.exists(key) > 0
    except Exception:
        return False


def make_cache_key(*parts: str) -> str:
    """
    Create a cache key from parts.
    
    Args:
        parts: Key components
        
    Returns:
        Colon-separated key string
    """
    return ":".join(str(p) for p in parts if p)


def hash_text(text: str) -> str:
    """
    Create a SHA256 hash of text for use as cache key.
    
    Args:
        text: Text to hash
        
    Returns:
        Hex digest of hash
    """
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def hash_text_short(text: str, length: int = 16) -> str:
    """
    Create a short hash of text for use as cache key prefix.
    
    Args:
        text: Text to hash
        length: Number of characters to return
        
    Returns:
        Truncated hex digest
    """
    return hash_text(text)[:length]


# Cache key prefixes
CACHE_PREFIX_QUERY = "rag:query"
CACHE_PREFIX_SEMANTIC = "rag:semantic"
CACHE_PREFIX_EMBEDDING = "rag:emb"
CACHE_PREFIX_CLAUSES = "rag:clauses"
CACHE_PREFIX_PRODUCTS = "rag:products"


def get_cache_stats() -> Dict[str, Any]:
    """
    Get cache statistics.
    
    Returns:
        Dict with cache stats or empty dict if unavailable
    """
    client = get_redis_client()
    if not client:
        return {"available": False}
    
    try:
        info = client.info("memory")
        keyspace = client.info("keyspace")
        
        # Count RAG-specific keys
        query_keys = len(list(client.scan_iter(match=f"{CACHE_PREFIX_QUERY}:*", count=100)))
        emb_keys = len(list(client.scan_iter(match=f"{CACHE_PREFIX_EMBEDDING}:*", count=100)))
        clause_keys = len(list(client.scan_iter(match=f"{CACHE_PREFIX_CLAUSES}:*", count=100)))
        
        return {
            "available": True,
            "used_memory_human": info.get("used_memory_human", "unknown"),
            "connected_clients": info.get("connected_clients", 0),
            "rag_query_keys": query_keys,
            "rag_embedding_keys": emb_keys,
            "rag_clause_keys": clause_keys,
            "keyspace": keyspace,
        }
    except Exception as e:
        return {"available": True, "error": str(e)}


def flush_rag_cache() -> Dict[str, int]:
    """
    Flush all RAG-related cache entries.
    
    Returns:
        Dict with count of deleted keys per prefix
    """
    results = {}
    for prefix in [CACHE_PREFIX_QUERY, CACHE_PREFIX_SEMANTIC, 
                   CACHE_PREFIX_EMBEDDING, CACHE_PREFIX_CLAUSES, CACHE_PREFIX_PRODUCTS]:
        count = redis_delete_pattern(f"{prefix}:*")
        results[prefix] = count
    
    total = sum(results.values())
    logger.info(f"🗑️ Flushed {total} RAG cache entries")
    return results

