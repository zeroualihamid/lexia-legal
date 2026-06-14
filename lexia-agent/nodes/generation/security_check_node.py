# nodes/generation/security_check_node.py
"""
Security Check Node
Scans generated code for dangerous patterns before execution.
"""
import ast
import re
from typing import Dict, List, Tuple
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class SecurityCheckResult:
    """Result of security check"""
    passed: bool
    risk_level: str = "none"   # none | low | medium | high | critical
    violations: List[Dict] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return {
            'passed': self.passed,
            'risk_level': self.risk_level,
            'violations': self.violations,
            'warnings': self.warnings,
        }


# Patterns that are always blocked
CRITICAL_PATTERNS: List[Tuple[str, str]] = [
    (r'\beval\s*\(', "eval() is dangerous — arbitrary code execution"),
    (r'\bexec\s*\(', "exec() is dangerous — arbitrary code execution"),
    (r'__import__\s*\(', "__import__() can bypass import controls"),
    (r'os\.system\s*\(', "os.system() allows shell command injection"),
    (r'subprocess\.call\s*\(.*shell\s*=\s*True', "subprocess with shell=True is unsafe"),
    (r'subprocess\.Popen\s*\(.*shell\s*=\s*True', "subprocess.Popen with shell=True is unsafe"),
    (r'pickle\.loads?\s*\(', "pickle deserialization is unsafe with untrusted data"),
    (r'marshal\.loads?\s*\(', "marshal deserialization is unsafe"),
]

# Patterns that raise warnings (not blocked)
WARNING_PATTERNS: List[Tuple[str, str]] = [
    (r'open\s*\(.*["\']w["\']', "Writing to files — verify path is safe"),
    (r'shutil\.rmtree\s*\(', "Recursive directory deletion — verify target"),
    (r'os\.remove\s*\(', "File deletion — verify path"),
    (r'glob\.glob\s*\(', "File globbing — ensure patterns are bounded"),
    (r'requests\.get\s*\(', "HTTP request — network access detected"),
]

# Blocked imports
BLOCKED_IMPORTS = {
    'os': ['system', 'popen', 'execvp', 'execv', 'execve'],
    'subprocess': ['call', 'Popen', 'run'],
    'ctypes': None,  # entire module
    'socket': None,
}


class SecurityCheckNode:
    """
    Scans code for dangerous patterns.

    Uses both regex scanning and AST analysis to find
    policy violations before code reaches the sandbox.

    Routes:
    - passed:  No critical issues, safe to continue
    - blocked: Critical violation found, abort generation
    """

    def __init__(self, strict: bool = True):
        self.strict = strict
        self.name = "SecurityCheck"

    def prep(self, shared: Dict) -> Dict:
        return {
            'code': shared.get('last_generated_code', ''),
            'step_requirements': shared.get('step_requirements', {}),
            'strict': self.strict,
        }

    def exec(self, prep_result: Dict) -> SecurityCheckResult:
        code = prep_result['code']

        if not code.strip():
            return SecurityCheckResult(passed=False, risk_level='critical',
                                       violations=[{'msg': 'Empty code'}])

        logger.info("Running security check...")

        violations = []
        warnings = []

        # 1. Regex-based critical pattern scan
        for pattern, message in CRITICAL_PATTERNS:
            if re.search(pattern, code):
                violations.append({'pattern': pattern, 'message': message, 'severity': 'critical'})

        # 2. Regex-based warning scan
        for pattern, message in WARNING_PATTERNS:
            if re.search(pattern, code):
                warnings.append(message)

        # 3. AST-based import analysis
        try:
            tree = ast.parse(code)
            import_violations = self._check_imports(tree)
            violations.extend(import_violations)
        except SyntaxError:
            pass  # Syntax node will catch this

        # Determine risk level
        risk_level = self._determine_risk(violations, warnings)
        passed = len(violations) == 0

        if violations:
            logger.warning(f"Security violations: {len(violations)}, risk={risk_level}")
        else:
            logger.info(f"✓ Security check passed (risk={risk_level})")

        return SecurityCheckResult(
            passed=passed,
            risk_level=risk_level,
            violations=violations,
            warnings=warnings
        )

    def post(self, shared: Dict, prep_result: Dict, exec_result: SecurityCheckResult) -> str:
        shared['security_check_result'] = exec_result.to_dict()

        if exec_result.passed:
            return 'passed'

        logger.error(f"Security check BLOCKED code: {exec_result.violations}")
        shared['generation_feedback'] = {
            'errors': [v['message'] for v in exec_result.violations],
            'type': 'security'
        }
        return 'blocked'

    def _check_imports(self, tree: ast.AST) -> List[Dict]:
        violations = []

        for node in ast.walk(tree):
            # import ctypes  →  entire blocked module
            if isinstance(node, ast.Import):
                for alias in node.names:
                    base = alias.name.split('.')[0]
                    if base in BLOCKED_IMPORTS and BLOCKED_IMPORTS[base] is None:
                        violations.append({
                            'pattern': f'import {base}',
                            'message': f"Blocked module: {base}",
                            'severity': 'critical'
                        })

            # from os import system
            elif isinstance(node, ast.ImportFrom):
                module = (node.module or '').split('.')[0]
                if module in BLOCKED_IMPORTS:
                    blocked_names = BLOCKED_IMPORTS[module]
                    if blocked_names is None:
                        violations.append({
                            'pattern': f'from {module} import ...',
                            'message': f"Blocked module: {module}",
                            'severity': 'critical'
                        })
                    else:
                        for alias in node.names:
                            if alias.name in blocked_names:
                                violations.append({
                                    'pattern': f'from {module} import {alias.name}',
                                    'message': f"Blocked: {module}.{alias.name}",
                                    'severity': 'critical'
                                })

        return violations

    @staticmethod
    def _determine_risk(violations: List[Dict], warnings: List[str]) -> str:
        if any(v.get('severity') == 'critical' for v in violations):
            return 'critical'
        if violations:
            return 'high'
        if len(warnings) >= 3:
            return 'medium'
        if warnings:
            return 'low'
        return 'none'
