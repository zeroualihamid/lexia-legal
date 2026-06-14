"""Input nodes package.

This module also bootstraps import compatibility for environments where the
project root is not the current working directory.
"""

from pathlib import Path
import sys


# Ensure legacy absolute imports like `from nodes.base_node import BaseNode`
# resolve when importing from `nodes.input.*`.
_project_root = Path(__file__).resolve().parents[2]
_project_root_str = str(_project_root)
if _project_root_str not in sys.path:
    sys.path.insert(0, _project_root_str)

from .context_retrieval_node import ContextRetrievalNode
from .query_input_node import QueryInputNode
from .schema_loader_node import SchemaLoaderNode

__all__ = [
    "QueryInputNode",
    "ContextRetrievalNode",
    "SchemaLoaderNode",
]
