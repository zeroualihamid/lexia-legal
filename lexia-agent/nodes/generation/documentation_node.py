# nodes/generation/documentation_node.py
"""
Documentation Node
Adds or improves docstrings and inline comments in generated code.
"""
import ast
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class DocumentationResult:
    """Result of documentation enrichment"""
    documented_code: str
    original_code: str
    functions_documented: int = 0
    classes_documented: int = 0
    module_docstring_added: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            'functions_documented': self.functions_documented,
            'classes_documented': self.classes_documented,
            'module_docstring_added': self.module_docstring_added,
            'code_length_before': len(self.original_code),
            'code_length_after': len(self.documented_code),
        }


class DocumentationNode:
    """
    Adds docstrings and inline comments to generated code via LLM.

    Skips functions that already have docstrings.
    Falls back to original code if LLM call fails.

    Routes:
    - default: Always proceeds (documentation is best-effort)
    """

    def __init__(self):
        self.name = "Documentation"

    def prep(self, shared: Dict) -> Dict:
        return {
            'code': shared.get('last_generated_code', ''),
            'requirements': shared.get('step_requirements', {}),
            'config': shared.get('config'),
            'session_id': shared.get('session_id', ''),
        }

    def exec(self, prep_result: Dict) -> DocumentationResult:
        code = prep_result['code']

        if not code.strip():
            return DocumentationResult(documented_code='', original_code='')

        logger.info("Adding documentation...")

        # Quick analysis to check what already exists
        stats = self._analyze_existing_docs(code)

        # If code is already well-documented, skip LLM call
        if stats['coverage'] >= 0.9:
            logger.info("Documentation coverage already ≥ 90%, skipping LLM enrichment")
            return DocumentationResult(
                documented_code=code,
                original_code=code,
                functions_documented=stats['functions_with_docs'],
                classes_documented=stats['classes_with_docs'],
                module_docstring_added=False,
            )

        # Use LLM to add documentation
        documented = self._add_docs_via_llm(code, prep_result)

        return DocumentationResult(
            documented_code=documented,
            original_code=code,
            functions_documented=stats['total_functions'],
            classes_documented=stats['total_classes'],
            module_docstring_added=not code.strip().startswith('"""'),
        )

    def post(self, shared: Dict, prep_result: Dict, exec_result: DocumentationResult) -> str:
        code = exec_result.documented_code or exec_result.original_code
        shared['last_generated_code'] = code
        shared['documentation_result'] = exec_result.to_dict()
        logger.info(
            f"Documentation: {exec_result.functions_documented} functions, "
            f"{exec_result.classes_documented} classes"
        )
        return 'default'

    # -------------------------------------------------------------------------

    def _analyze_existing_docs(self, code: str) -> Dict:
        """Count how many functions/classes already have docstrings"""
        stats = {'total_functions': 0, 'functions_with_docs': 0,
                 'total_classes': 0, 'classes_with_docs': 0, 'coverage': 1.0}
        try:
            tree = ast.parse(code)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    stats['total_functions'] += 1
                    if (node.body and isinstance(node.body[0], ast.Expr)
                            and isinstance(node.body[0].value, ast.Constant)
                            and isinstance(node.body[0].value.value, str)):
                        stats['functions_with_docs'] += 1
                elif isinstance(node, ast.ClassDef):
                    stats['total_classes'] += 1
                    if (node.body and isinstance(node.body[0], ast.Expr)
                            and isinstance(node.body[0].value, ast.Constant)
                            and isinstance(node.body[0].value.value, str)):
                        stats['classes_with_docs'] += 1

            total = stats['total_functions'] + stats['total_classes']
            with_docs = stats['functions_with_docs'] + stats['classes_with_docs']
            stats['coverage'] = (with_docs / total) if total > 0 else 1.0
        except Exception:
            stats['coverage'] = 0.0
        return stats

    def _add_docs_via_llm(self, code: str, prep_result: Dict) -> str:
        """Call LLM to enrich documentation"""
        from prompt_loader import render_template
        description = prep_result['requirements'].get('description', '')
        prompt = render_template("generation", "documentation", description=description, code=code)
        try:
            from llm.llm_factory import create_llm_client
            client = create_llm_client(config=prep_result['config'])
            response = client.generate(prompt)
            return self._extract_code(response.content) or code
        except Exception as e:
            logger.warning(f"LLM documentation failed ({e}), keeping original")
            return code

    @staticmethod
    def _extract_code(text: str) -> str:
        import re
        m = re.search(r'```python\s*(.*?)```', text, re.DOTALL)
        if m:
            return m.group(1).strip()
        m = re.search(r'```\s*(.*?)```', text, re.DOTALL)
        if m:
            return m.group(1).strip()
        return ''
