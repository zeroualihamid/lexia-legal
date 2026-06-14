# config/settings.py

"""
Application Settings and Configuration
Centralized configuration management using Pydantic Settings

Configuration sources (in order of precedence):
1. Environment variables
2. .env file
3. Default values

All settings can be overridden via environment variables.
"""

from pydantic_settings import BaseSettings
from pydantic import Field, validator
from pathlib import Path
from typing import Optional, List
import os


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables and .env file
    
    Usage:
        from config.settings import settings
        
        # Access settings
        api_key = settings.anthropic_api_key
        log_level = settings.log_level
    """
    
    # ========================================================================
    # APPLICATION SETTINGS
    # ========================================================================
    
    app_env: str = Field(
        default="development",
        description="Application environment (development, staging, production)"
    )
    
    app_name: str = Field(
        default="coding-workflow-system",
        description="Application name"
    )
    
    app_version: str = Field(
        default="0.1.0",
        description="Application version"
    )
    
    debug: bool = Field(
        default=False,
        description="Enable debug mode"
    )
    
    # ========================================================================
    # LOGGING SETTINGS
    # ========================================================================
    
    log_level: str = Field(
        default="INFO",
        description="Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)"
    )
    
    log_format: str = Field(
        default="colored",
        description="Log format (colored, json, simple)"
    )
    
    log_file: Optional[str] = Field(
        default=None,
        description="Path to log file (optional)"
    )
    
    log_console: bool = Field(
        default=True,
        description="Enable console logging"
    )
    
    log_file_enable: bool = Field(
        default=False,
        description="Enable file logging"
    )
    
    # ========================================================================
    # LLM SETTINGS
    # ========================================================================
    
    llm_provider: str = Field(
        default="vllm",
        description="LLM provider (anthropic, openai, groq, vllm, local)"
    )
    
    llm_model: str = Field(
        default="openai/gpt-oss-120b",
        description="LLM model name"
    )
    
    llm_temperature: float = Field(
        default=0.0,
        ge=0.0,
        le=2.0,
        description="LLM temperature (0.0-2.0)"
    )
    
    llm_max_tokens: int = Field(
        default=4096,
        ge=100,
        le=200000,
        description="Maximum tokens per LLM request"
    )
    
    llm_timeout: int = Field(
        default=180,
        ge=1,
        le=600,
        description="LLM request timeout in seconds"
    )
    
    llm_max_retries: int = Field(
        default=3,
        ge=0,
        le=10,
        description="LLM max retries on failure"
    )
    
    llm_base_url: Optional[str] = Field(
        default="http://172.24.10.14:30876",
        description="LLM API base URL (for vllm and other OpenAI-compatible endpoints)"
    )
    
    # API Keys
    anthropic_api_key: Optional[str] = Field(
        default=None,
        description="Anthropic API key"
    )
    
    openai_api_key: Optional[str] = Field(
        default=None,
        description="OpenAI API key"
    )
    
    # Local LLM settings
    local_model_path: Optional[str] = Field(
        default=None,
        description="Path to local LLM model"
    )
    
    # ========================================================================
    # PATHS AND DIRECTORIES
    # ========================================================================
    
    base_dir: Path = Field(
        default=Path("."),
        description="Base directory for the application"
    )
    
    output_dir: Path = Field(
        default=Path("./data/outputs"),
        description="Directory for generated code outputs"
    )
    
    conversation_dir: Path = Field(
        default=Path("./data/conversations"),
        description="Directory for conversation storage"
    )
    
    graph_dir: Path = Field(
        default=Path("./data/graphs"),
        description="Directory for reasoning graph storage"
    )
    
    embedding_cache_dir: Path = Field(
        default=Path("./data/embeddings"),
        description="Directory for cached embeddings"
    )

    parquet_cache_dir: Path = Field(
        default=Path("./data/parquet"),
        description="Directory for parquet cache files (*.parquet)"
    )
    
    log_dir: Path = Field(
        default=Path("./logs"),
        description="Directory for log files"
    )
    
    # ========================================================================
    # DATABASE SETTINGS
    # ========================================================================
    
    database_url: str = Field(
        default="sqlite:///./data/workflow.db",
        description="Database connection URL"
    )
    
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL"
    )
    
    # Neo4j (Optional)
    neo4j_uri: Optional[str] = Field(
        default=None,
        description="Neo4j connection URI"
    )
    
    neo4j_user: Optional[str] = Field(
        default=None,
        description="Neo4j username"
    )
    
    neo4j_password: Optional[str] = Field(
        default=None,
        description="Neo4j password"
    )
    
    # ========================================================================
    # SANDBOX SETTINGS
    # ========================================================================
    
    sandbox_type: str = Field(
        default="docker",
        description="Sandbox type (docker, subprocess)"
    )
    
    sandbox_timeout: int = Field(
        default=30,
        ge=1,
        le=300,
        description="Sandbox execution timeout in seconds"
    )
    
    sandbox_max_memory_mb: int = Field(
        default=512,
        ge=128,
        le=4096,
        description="Maximum memory for sandbox in MB"
    )
    
    sandbox_max_cpu_cores: int = Field(
        default=1,
        ge=1,
        le=8,
        description="Maximum CPU cores for sandbox"
    )
    
    sandbox_use_docker: bool = Field(
        default=True,
        description="Use Docker for sandboxing (vs subprocess)"
    )
    
    # ========================================================================
    # GRAPH SETTINGS
    # ========================================================================
    
    graph_backend: str = Field(
        default="networkx",
        description="Graph storage backend (networkx, neo4j)"
    )
    
    embedding_model: str = Field(
        default="sentence-transformer",
        description="Model for code embeddings"
    )
    
    embedding_dimension: int = Field(
        default=768,
        description="Embedding vector dimension"
    )
    
    similarity_threshold: float = Field(
        default=0.75,
        ge=0.0,
        le=1.0,
        description="Minimum similarity for code reuse"
    )
    
    edge_threshold: float = Field(
        default=0.65,
        ge=0.0,
        le=1.0,
        description="Minimum similarity for graph edges"
    )
    
    max_path_length: int = Field(
        default=10,
        ge=1,
        le=50,
        description="Maximum reasoning path length"
    )
    
    use_faiss: bool = Field(
        default=False,
        description="Use FAISS for fast similarity search"
    )
    
    # ========================================================================
    # AGENT SETTINGS
    # ========================================================================
    
    max_debate_rounds: int = Field(
        default=4,
        ge=1,
        le=10,
        description="Maximum adversarial debate rounds"
    )
    
    consensus_threshold: float = Field(
        default=0.9,
        ge=0.5,
        le=1.0,
        description="Required consensus score (0-1)"
    )
    
    proposer_strategy: str = Field(
        default="reuse_first",
        description="Proposer agent strategy (reuse_first, balanced, innovative)"
    )
    
    challenger_strategy: str = Field(
        default="thorough",
        description="Challenger agent strategy (thorough, balanced, lenient)"
    )
    
    # ========================================================================
    # WORKFLOW SETTINGS
    # ========================================================================
    
    max_workflow_steps: int = Field(
        default=20,
        ge=1,
        le=100,
        description="Maximum steps per workflow"
    )
    
    max_generation_attempts: int = Field(
        default=3,
        ge=1,
        le=10,
        description="Maximum code generation attempts"
    )
    
    enable_code_reuse: bool = Field(
        default=True,
        description="Enable code reuse from graph"
    )
    
    enable_adversarial_validation: bool = Field(
        default=True,
        description="Enable adversarial agent validation"
    )
    
    # ========================================================================
    # API SETTINGS
    # ========================================================================
    
    api_host: str = Field(
        default="0.0.0.0",
        description="API server host"
    )
    
    api_port: int = Field(
        default=8000,
        ge=1000,
        le=65535,
        description="API server port"
    )
    
    api_workers: int = Field(
        default=4,
        ge=1,
        le=32,
        description="Number of API workers"
    )
    
    enable_cors: bool = Field(
        default=True,
        description="Enable CORS"
    )
    
    cors_origins: str = Field(
        default="http://localhost:3000,http://localhost:8080",
        description="Allowed CORS origins (comma-separated)"
    )
    
    api_rate_limit: Optional[str] = Field(
        default="100/minute",
        description="API rate limit (requests/timeframe)"
    )
    
    # ========================================================================
    # MONITORING SETTINGS
    # ========================================================================
    
    enable_metrics: bool = Field(
        default=True,
        description="Enable Prometheus metrics"
    )
    
    metrics_port: int = Field(
        default=9090,
        ge=1000,
        le=65535,
        description="Prometheus metrics port"
    )
    
    metrics_interval: int = Field(
        default=60,
        ge=10,
        le=300,
        description="Metrics collection interval in seconds"
    )
    
    enable_tracing: bool = Field(
        default=False,
        description="Enable distributed tracing"
    )
    
    # ========================================================================
    # SECURITY SETTINGS
    # ========================================================================
    
    secret_key: str = Field(
        default="change-this-in-production-please",
        description="Secret key for encryption"
    )
    
    jwt_algorithm: str = Field(
        default="HS256",
        description="JWT signing algorithm"
    )
    
    jwt_expiration_hours: int = Field(
        default=24,
        ge=1,
        le=720,
        description="JWT token expiration in hours"
    )
    
    allowed_file_extensions: List[str] = Field(
        default=["parquet", "csv", "xlsx", "json", "txt"],
        description="Allowed file extensions for upload"
    )
    
    max_upload_size_mb: int = Field(
        default=100,
        ge=1,
        le=1000,
        description="Maximum file upload size in MB"
    )
    
    # ========================================================================
    # FEATURE FLAGS
    # ========================================================================
    
    enable_web_search: bool = Field(
        default=False,
        description="Enable web search capability"
    )
    
    enable_semantic_search: bool = Field(
        default=True,
        description="Enable semantic search in conversations"
    )
    
    enable_code_optimization: bool = Field(
        default=True,
        description="Enable code optimization step"
    )
    
    enable_auto_documentation: bool = Field(
        default=True,
        description="Enable automatic code documentation"
    )
    
    # ========================================================================
    # PERFORMANCE SETTINGS
    # ========================================================================
    
    cache_enabled: bool = Field(
        default=True,
        description="Enable caching"
    )
    
    cache_ttl: int = Field(
        default=3600,
        ge=60,
        le=86400,
        description="Cache TTL in seconds"
    )
    
    max_concurrent_executions: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum concurrent workflow executions"
    )
    
    # ========================================================================
    # VALIDATORS
    # ========================================================================
    
    @validator('log_level')
    def validate_log_level(cls, v):
        """Validate log level"""
        valid_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
        if v.upper() not in valid_levels:
            raise ValueError(f"log_level must be one of {valid_levels}")
        return v.upper()
    
    @validator('llm_provider')
    def validate_llm_provider(cls, v):
        """Validate LLM provider"""
        valid_providers = ['anthropic', 'openai', 'groq', 'vllm', 'local']
        if v.lower() not in valid_providers:
            raise ValueError(f"llm_provider must be one of {valid_providers}")
        return v.lower()
    
    @validator('sandbox_type')
    def validate_sandbox_type(cls, v):
        """Validate sandbox type"""
        valid_types = ['docker', 'subprocess']
        if v.lower() not in valid_types:
            raise ValueError(f"sandbox_type must be one of {valid_types}")
        return v.lower()
    
    @validator('graph_backend')
    def validate_graph_backend(cls, v):
        """Validate graph backend"""
        valid_backends = ['networkx', 'neo4j']
        if v.lower() not in valid_backends:
            raise ValueError(f"graph_backend must be one of {valid_backends}")
        return v.lower()
    
    @validator('secret_key')
    def validate_secret_key(cls, v):
        """Warn if using default secret key"""
        if v == "change-this-in-production-please":
            import warnings
            warnings.warn(
                "Using default secret_key! Change this in production!",
                UserWarning
            )
        return v
    
    # ========================================================================
    # COMPUTED PROPERTIES
    # ========================================================================
    
    @property
    def is_production(self) -> bool:
        """Check if running in production"""
        return self.app_env.lower() == "production"
    
    @property
    def is_development(self) -> bool:
        """Check if running in development"""
        return self.app_env.lower() == "development"
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Get CORS origins as list"""
        return [origin.strip() for origin in self.cors_origins.split(",")]
    
    # ========================================================================
    # PYDANTIC CONFIG
    # ========================================================================
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        
        # Allow extra fields (for forward compatibility)
        extra = "allow"


# ============================================================================
# GLOBAL SETTINGS INSTANCE
# ============================================================================

# Create global settings instance
# This will automatically load from .env file and environment variables
settings = Settings()


# ============================================================================
# INITIALIZATION HELPERS
# ============================================================================

def ensure_directories():
    """
    Ensure all required directories exist
    
    Call this at application startup
    """
    directories = [
        settings.output_dir,
        settings.conversation_dir,
        settings.graph_dir,
        settings.embedding_cache_dir,
        settings.log_dir,
    ]
    
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
    
    print(f"✓ All directories created/verified")


def validate_configuration():
    """
    Validate configuration and warn about potential issues
    
    Call this at application startup
    """
    issues = []
    
    # Check API keys
    if settings.llm_provider == "anthropic" and not settings.anthropic_api_key:
        issues.append("⚠ Anthropic API key not set (ANTHROPIC_API_KEY)")
    
    if settings.llm_provider == "openai" and not settings.openai_api_key:
        issues.append("⚠ OpenAI API key not set (OPENAI_API_KEY)")
    
    # Check production settings
    if settings.is_production:
        if settings.secret_key == "change-this-in-production-please":
            issues.append("⚠ Using default secret_key in production!")
        
        if settings.debug:
            issues.append("⚠ Debug mode enabled in production!")
        
        if settings.log_level == "DEBUG":
            issues.append("⚠ Debug logging in production may impact performance")
    
    # Check resource limits
    if settings.sandbox_max_memory_mb < 256:
        issues.append("⚠ Sandbox memory very low, may cause execution failures")
    
    # Print issues
    if issues:
        print("Configuration Issues:")
        for issue in issues:
            print(f"  {issue}")
    else:
        print("✓ Configuration validated successfully")
    
    return len(issues) == 0


def print_configuration_summary():
    """
    Print a summary of current configuration
    
    Useful for debugging and verification
    """
    print("=" * 70)
    print("CONFIGURATION SUMMARY")
    print("=" * 70)
    
    print(f"\nApplication:")
    print(f"  Environment: {settings.app_env}")
    print(f"  Version: {settings.app_version}")
    print(f"  Debug: {settings.debug}")
    
    print(f"\nLLM:")
    print(f"  Provider: {settings.llm_provider}")
    print(f"  Model: {settings.llm_model}")
    print(f"  Temperature: {settings.llm_temperature}")
    print(f"  Max Tokens: {settings.llm_max_tokens}")
    
    print(f"\nSandbox:")
    print(f"  Type: {settings.sandbox_type}")
    print(f"  Timeout: {settings.sandbox_timeout}s")
    print(f"  Memory: {settings.sandbox_max_memory_mb}MB")
    print(f"  CPU Cores: {settings.sandbox_max_cpu_cores}")
    
    print(f"\nGraph:")
    print(f"  Backend: {settings.graph_backend}")
    print(f"  Embedding Model: {settings.embedding_model}")
    print(f"  Similarity Threshold: {settings.similarity_threshold}")
    
    print(f"\nAgents:")
    print(f"  Max Debate Rounds: {settings.max_debate_rounds}")
    print(f"  Consensus Threshold: {settings.consensus_threshold}")
    print(f"  Proposer Strategy: {settings.proposer_strategy}")
    
    print(f"\nAPI:")
    print(f"  Host: {settings.api_host}")
    print(f"  Port: {settings.api_port}")
    print(f"  Workers: {settings.api_workers}")
    print(f"  CORS Enabled: {settings.enable_cors}")
    
    print(f"\nDirectories:")
    print(f"  Output: {settings.output_dir}")
    print(f"  Conversations: {settings.conversation_dir}")
    print(f"  Graphs: {settings.graph_dir}")
    print(f"  Logs: {settings.log_dir}")
    
    print(f"\nFeature Flags:")
    print(f"  Code Reuse: {settings.enable_code_reuse}")
    print(f"  Adversarial Validation: {settings.enable_adversarial_validation}")
    print(f"  Semantic Search: {settings.enable_semantic_search}")
    print(f"  Code Optimization: {settings.enable_code_optimization}")
    
    print("=" * 70)


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage and validation
    """
    
    # Print configuration
    print_configuration_summary()
    
    # Ensure directories exist
    ensure_directories()
    
    # Validate configuration
    validate_configuration()
    
    # Access settings
    print(f"\nExample access:")
    print(f"  LLM Provider: {settings.llm_provider}")
    print(f"  Is Production: {settings.is_production}")
    print(f"  CORS Origins: {settings.cors_origins_list}")
