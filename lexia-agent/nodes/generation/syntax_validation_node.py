# nodes/generation/syntax_validation_node.py
"""
Syntax Validation Node
Validates generated code syntax using Python's AST parser.
"""
import ast
import textwrap
from typing import Dict, Any, List
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class SyntaxValidationResult:
    """Result of syntax validation"""
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    line_count: int = 0
    has_imports: bool = False
    has_functions: bool = False
    has_main_block: bool = False
    tree: Any = None  # AST tree (not serialized)

    def to_dict(self) -> Dict:
        return {
            'is_valid': self.is_valid,
            'errors': self.errors,
            'warnings': self.warnings,
            'line_count': self.line_count,
            'has_imports': self.has_imports,
            'has_functions': self.has_functions,
            'has_main_block': self.has_main_block,
        }


class SyntaxValidationNode:
    """
    Validates generated code syntax.

    Runs AST parsing, checks for common structural issues,
    and populates shared state with validation result.

    Routes:
    - valid:          Syntax is correct, proceed
    - invalid_retry:  Syntax errors found, retry generation
    - invalid_give_up: Too many retries, give up
    """

    MAX_RETRIES = 3

    def __init__(self):
        self.name = "SyntaxValidation"

    def prep(self, shared: Dict) -> Dict:
        return {
            'code': shared.get('last_generated_code', ''),
            'step_requirements': shared.get('step_requirements', {}),
            'validation_attempts': shared.get('syntax_validation_attempts', 0),
        }

    def exec(self, prep_result: Dict) -> SyntaxValidationResult:
        code = prep_result['code']

        if not code or not code.strip():
            return SyntaxValidationResult(
                is_valid=False,
                errors=["No code provided"]
            )

        logger.info("Running syntax validation...")

        errors = []
        warnings = []
        tree = None

        # --- AST parse ---
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            errors.append(f"SyntaxError at line {e.lineno}: {e.msg}")
            return SyntaxValidationResult(is_valid=False, errors=errors)
        except Exception as e:
            errors.append(f"Parse error: {e}")
            return SyntaxValidationResult(is_valid=False, errors=errors)

        # --- Structural checks ---
        has_imports = any(
            isinstance(n, (ast.Import, ast.ImportFrom)) for n in ast.walk(tree)
        )
        has_functions = any(
            isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) for n in ast.walk(tree)
        )
        has_main_block = self._has_main_block(tree)
        line_count = len(code.splitlines())

        # Warnings (non-blocking)
        if not has_imports:
            warnings.append("No import statements found")
        if not has_functions:
            warnings.append("No function definitions found")
        if not has_main_block:
            warnings.append("No __main__ block found")
        if line_count < 5:
            warnings.append(f"Code is very short ({line_count} lines)")

        # Check for bare except
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                warnings.append(
                    f"Bare 'except:' at line {node.lineno} — use specific exceptions"
                )

        return SyntaxValidationResult(
            is_valid=True,
            errors=errors,
            warnings=warnings,
            line_count=line_count,
            has_imports=has_imports,
            has_functions=has_functions,
            has_main_block=has_main_block,
            tree=tree
        )

    def post(self, shared: Dict, prep_result: Dict, exec_result: SyntaxValidationResult) -> str:
        attempts = prep_result['validation_attempts'] + 1
        shared['syntax_validation_attempts'] = attempts
        shared['syntax_validation_result'] = exec_result.to_dict()

        if exec_result.is_valid:
            if exec_result.warnings:
                logger.warning(f"Syntax OK with {len(exec_result.warnings)} warnings")
            else:
                logger.info("✓ Syntax validation passed")
            return 'valid'

        logger.warning(f"Syntax invalid: {exec_result.errors}")

        # Populate feedback for re-generation
        shared['generation_feedback'] = {
            'errors': exec_result.errors,
            'type': 'syntax'
        }

        if attempts >= self.MAX_RETRIES:
            logger.error(f"Syntax still invalid after {self.MAX_RETRIES} retries")
            return 'invalid_give_up'

        return 'invalid_retry'

    @staticmethod
    def _has_main_block(tree: ast.AST) -> bool:
        """Check for: if __name__ == '__main__':"""
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if (isinstance(test, ast.Compare)
                    and isinstance(test.left, ast.Name)
                    and test.left.id == '__name__'
                    and len(test.comparators) == 1
                    and isinstance(test.comparators[0], ast.Constant)
                    and test.comparators[0].value == '__main__'):
                return True
        return False
