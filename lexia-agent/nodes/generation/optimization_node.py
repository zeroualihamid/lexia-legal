# nodes/generation/optimization_node.py
"""
Optimization Node
Applies static performance improvements to generated code.
"""
import ast
import re
from typing import Dict, Any, List
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class OptimizationResult:
    """Result of code optimization"""
    optimized_code: str
    original_code: str
    optimizations_applied: List[str] = field(default_factory=list)
    skipped: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            'optimizations_applied': self.optimizations_applied,
            'num_optimizations': len(self.optimizations_applied),
            'skipped': self.skipped,
            'code_length_before': len(self.original_code),
            'code_length_after': len(self.optimized_code),
        }


class OptimizationNode:
    """
    Applies static code optimizations.

    Two-stage approach:
    1. Rule-based fixes (regex / AST patterns) — always applied
    2. LLM-based vectorization pass — applied for complex code

    Routes:
    - default: Always proceeds (optimization is best-effort)
    """

    # Pattern-based optimizations: (description, search_regex, replacement)
    REGEX_OPTIMIZATIONS = [
        (
            "Replace iterrows() with itertuples()",
            r'\.iterrows\(\)',
            '.itertuples()'
        ),
        (
            "Use f-strings instead of .format()",
            r'"([^"]*?)"\s*\.format\s*\(',
            None   # Too complex for simple replace; handled by LLM
        ),
    ]

    def __init__(self, use_llm: bool = True):
        self.use_llm = use_llm
        self.name = "Optimization"

    def prep(self, shared: Dict) -> Dict:
        requirements = shared.get('step_requirements', {})
        return {
            'code': shared.get('last_generated_code', ''),
            'complexity': requirements.get('complexity', 'moderate'),
            'requirements': requirements,
            'config': shared.get('config'),
            'session_id': shared.get('session_id', ''),
        }

    def exec(self, prep_result: Dict) -> OptimizationResult:
        code = prep_result['code']
        complexity = prep_result['complexity']

        if not code.strip():
            return OptimizationResult(optimized_code='', original_code='', skipped=True)

        logger.info(f"Running optimization (complexity={complexity})...")

        applied: List[str] = []
        optimized = code

        # Stage 1: Static/rule-based optimizations
        optimized, stage1 = self._apply_static_optimizations(optimized)
        applied.extend(stage1)

        # Stage 2: LLM-based optimization for complex code
        if self.use_llm and complexity in ('moderate', 'complex'):
            optimized, stage2 = self._apply_llm_optimization(optimized, prep_result)
            applied.extend(stage2)

        if applied:
            logger.info(f"Applied {len(applied)} optimizations: {applied}")
        else:
            logger.info("No optimizations applied — code already optimal")

        return OptimizationResult(
            optimized_code=optimized,
            original_code=code,
            optimizations_applied=applied,
        )

    def post(self, shared: Dict, prep_result: Dict, exec_result: OptimizationResult) -> str:
        code = exec_result.optimized_code or exec_result.original_code
        shared['last_generated_code'] = code
        shared['optimization_result'] = exec_result.to_dict()
        return 'default'

    # -------------------------------------------------------------------------

    def _apply_static_optimizations(self, code: str):
        applied = []

        # iterrows → itertuples
        if '.iterrows()' in code:
            code = code.replace('.iterrows()', '.itertuples()')
            applied.append("Replaced iterrows() with itertuples()")

        # Unnecessary list() around a generator in len()
        code, n = re.subn(r'len\(list\(([^)]+)\)\)', r'sum(1 for _ in \1)', code)
        if n:
            applied.append("Replaced len(list(gen)) with sum(1 for _ in gen)")

        # pd.concat inside loop anti-pattern warning
        if re.search(r'for .+:\n.*pd\.concat', code, re.MULTILINE):
            applied.append("⚠ pd.concat inside loop detected (consider collecting then concat)")

        # Add chunking hint for read_csv without chunksize on large description
        if 'read_csv' in code and 'chunksize' not in code:
            applied.append("ℹ Consider chunksize parameter for large CSV files")

        return code, applied

    def _apply_llm_optimization(self, code: str, prep_result: Dict):
        """Use LLM for vectorization and algorithmic improvements"""
        from prompt_loader import render_template
        prompt = render_template("generation", "optimization", code=code)
        try:
            from llm.llm_factory import create_llm_client
            client = create_llm_client(config=prep_result['config'])
            response = client.generate(prompt)

            # Extract applied changes
            changes = re.findall(r'CHANGE:\s*(.+)', response.content)

            # Extract code
            optimized = self._extract_code(response.content) or code

            return optimized, [f"LLM: {c}" for c in changes]

        except Exception as e:
            logger.warning(f"LLM optimization failed ({e}), skipping")
            return code, []

    @staticmethod
    def _extract_code(text: str) -> str:
        m = re.search(r'```python\s*(.*?)```', text, re.DOTALL)
        if m:
            return m.group(1).strip()
        m = re.search(r'```\s*(.*?)```', text, re.DOTALL)
        if m:
            return m.group(1).strip()
        return ''
