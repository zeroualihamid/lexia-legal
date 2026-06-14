# nodes/generation/code_validation_node.py

"""
Code Validation Node
Validates generated code for syntax, security, and correctness

This node:
- Performs syntax validation (AST parsing)
- Checks for security issues
- Validates against requirements
- Provides detailed error feedback
- Routes to retry or proceed based on validation
"""

from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass
import ast
import re

from nodes.base_node import ValidationNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class ValidationResult:
    """Result of code validation"""
    is_valid: bool
    syntax_valid: bool
    security_passed: bool
    requirements_met: bool
    errors: List[str]
    warnings: List[str]
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        return {
            'is_valid': self.is_valid,
            'syntax_valid': self.syntax_valid,
            'security_passed': self.security_passed,
            'requirements_met': self.requirements_met,
            'errors': self.errors,
            'warnings': self.warnings,
            'metadata': self.metadata
        }


class CodeValidationNode(ValidationNode):
    """
    Code Validation Node - Comprehensive code validation
    
    Validation Steps:
    1. Syntax validation (AST parsing)
    2. Security validation (dangerous patterns)
    3. Import validation (allowed libraries only)
    4. Requirements validation (meets specifications)
    5. Quality checks (basic code quality)
    
    Routes:
    - valid → Proceed to next step
    - invalid_retry → Return to generation with feedback
    - invalid_give_up → Too many attempts, fail workflow
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        strict_mode: bool = False
    ):
        super().__init__(name or "CodeValidation")
        self.strict_mode = strict_mode
        
        # Validators
        self.syntax_validator = SyntaxValidator()
        self.security_validator = SecurityValidator()
        self.import_validator = ImportValidator()
        self.requirements_validator = RequirementsValidator()
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare for validation"""
        self.log_entry(shared)
        
        # Get generated code
        generated_code_data = shared.get('generated_code', {})
        code = generated_code_data.get('code') or shared.get('last_generated_code', '')
        
        if not code:
            raise ValueError("No code to validate")
        
        # Get requirements
        requirements = shared.get('analyzed_requirements', {})
        
        # Get current step for context
        plan_steps = shared.get('plan_steps', [])
        current_index = shared.get('current_step_index', 0)
        current_step = plan_steps[current_index] if current_index < len(plan_steps) else {}
        
        # Get attempt count
        attempt_number = shared.get('generation_attempts', 1)
        
        self.logger.info(f"Validating generated code (attempt {attempt_number})")
        
        return {
            'code': code,
            'requirements': requirements,
            'step': current_step,
            'attempt_number': attempt_number,
            'strict_mode': self.strict_mode
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> ValidationResult:
        """
        Validate the code
        
        Runs all validation checks and combines results
        """
        
        code = prep_result['code']
        requirements = prep_result['requirements']
        strict = prep_result['strict_mode']
        
        errors = []
        warnings = []
        
        # 1. Syntax validation
        self.logger.debug("Running syntax validation")
        syntax_valid, syntax_errors = self.syntax_validator.validate(code)
        
        if not syntax_valid:
            errors.extend([f"Syntax: {e}" for e in syntax_errors])
            self.logger.warning(f"Syntax validation failed: {syntax_errors}")
        else:
            self.logger.debug("✓ Syntax valid")
        
        # 2. Security validation
        self.logger.debug("Running security validation")
        security_passed, security_issues = self.security_validator.validate(code)
        
        if not security_passed:
            if strict:
                errors.extend([f"Security: {i}" for i in security_issues])
            else:
                warnings.extend([f"Security: {i}" for i in security_issues])
            self.logger.warning(f"Security issues found: {security_issues}")
        else:
            self.logger.debug("✓ Security checks passed")
        
        # 3. Import validation
        self.logger.debug("Running import validation")
        imports_valid, import_issues = self.import_validator.validate(code)
        
        if not imports_valid:
            if strict:
                errors.extend([f"Import: {i}" for i in import_issues])
            else:
                warnings.extend([f"Import: {i}" for i in import_issues])
            self.logger.warning(f"Import issues: {import_issues}")
        else:
            self.logger.debug("✓ Imports valid")
        
        # 4. Requirements validation
        self.logger.debug("Running requirements validation")
        reqs_met, req_issues = self.requirements_validator.validate(code, requirements)
        
        if not reqs_met:
            warnings.extend([f"Requirement: {i}" for i in req_issues])
            self.logger.debug(f"Requirements not fully met: {req_issues}")
        else:
            self.logger.debug("✓ Requirements met")
        
        # Overall validation result
        is_valid = (
            syntax_valid and
            (security_passed or not strict) and
            (imports_valid or not strict)
        )
        
        if is_valid:
            self.logger.info("✓ Code validation passed")
        else:
            self.logger.warning(f"✗ Code validation failed: {len(errors)} errors")
        
        return ValidationResult(
            is_valid=is_valid,
            syntax_valid=syntax_valid,
            security_passed=security_passed,
            requirements_met=reqs_met,
            errors=errors,
            warnings=warnings,
            metadata={
                'code_lines': len(code.split('\n')),
                'strict_mode': strict
            }
        )
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: ValidationResult
    ) -> str:
        """Store validation results and route"""
        
        # Store validation results
        shared['validation_result'] = exec_result.to_dict()
        shared['validation_errors'] = exec_result.errors
        shared['validation_warnings'] = exec_result.warnings
        
        # Use base class validation routing
        return self.validate_and_route(
            shared=shared,
            is_valid=exec_result.is_valid,
            errors=exec_result.errors,
            valid_route='valid',
            invalid_retry_route='invalid_retry',
            invalid_give_up_route='invalid_give_up',
            attempt_key='generation_attempts',
            max_attempts=3
        )


# ============================================================================
# INDIVIDUAL VALIDATORS
# ============================================================================

class SyntaxValidator:
    """Validate Python syntax using AST"""
    
    def validate(self, code: str) -> Tuple[bool, List[str]]:
        """
        Validate Python syntax
        
        Returns:
            (is_valid, list_of_errors)
        """
        
        errors = []
        
        try:
            ast.parse(code)
            return True, []
        
        except SyntaxError as e:
            error_msg = f"Line {e.lineno}: {e.msg}"
            if e.text:
                error_msg += f" (near: '{e.text.strip()}')"
            errors.append(error_msg)
        
        except Exception as e:
            errors.append(f"Parse error: {str(e)}")
        
        return False, errors


class SecurityValidator:
    """Validate code security"""
    
    # Dangerous patterns to check for
    DANGEROUS_PATTERNS = [
        (r'\beval\s*\(', 'Use of eval() is dangerous'),
        (r'\bexec\s*\(', 'Use of exec() is dangerous'),
        (r'os\.system\s*\(', 'Use of os.system() is dangerous'),
        (r'subprocess\.call\s*\(', 'Use of subprocess without shell=False'),
        (r'__import__\s*\(', 'Dynamic imports can be dangerous'),
        (r'open\s*\([^)]*[\'"]w', 'File write operations need review'),
        (r'pickle\.loads?\s*\(', 'Pickle deserialization can be unsafe'),
    ]
    
    def validate(self, code: str) -> Tuple[bool, List[str]]:
        """
        Check for security issues
        
        Returns:
            (is_safe, list_of_issues)
        """
        
        issues = []
        
        for pattern, message in self.DANGEROUS_PATTERNS:
            if re.search(pattern, code):
                issues.append(message)
        
        # Check for SQL injection patterns (basic)
        if 'execute(' in code or 'executemany(' in code:
            if '%s' in code or '.format(' in code:
                issues.append('Potential SQL injection with string formatting')
        
        is_safe = len(issues) == 0
        
        return is_safe, issues


class ImportValidator:
    """Validate that only allowed libraries are imported"""
    
    # Allowed imports
    ALLOWED_IMPORTS = {
        'pandas', 'numpy', 'pyarrow', 'pathlib', 'datetime',
        'typing', 'dataclasses', 'json', 'csv', 're',
        'collections', 'itertools', 'functools', 'math',
        'statistics', 'decimal'
    }
    
    # Explicitly forbidden
    FORBIDDEN_IMPORTS = {
        'os', 'sys', 'subprocess', 'socket', 'requests',
        'urllib', 'pickle', 'shelve'
    }
    
    def validate(self, code: str) -> Tuple[bool, List[str]]:
        """
        Validate imports
        
        Returns:
            (is_valid, list_of_issues)
        """
        
        issues = []
        
        # Parse imports
        try:
            tree = ast.parse(code)
            
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        module = alias.name.split('.')[0]
                        
                        if module in self.FORBIDDEN_IMPORTS:
                            issues.append(f"Forbidden import: {module}")
                        elif module not in self.ALLOWED_IMPORTS:
                            issues.append(f"Unrecognized import: {module}")
                
                elif isinstance(node, ast.ImportFrom):
                    if node.module:
                        module = node.module.split('.')[0]
                        
                        if module in self.FORBIDDEN_IMPORTS:
                            issues.append(f"Forbidden import: {module}")
                        elif module not in self.ALLOWED_IMPORTS:
                            issues.append(f"Unrecognized import: {module}")
        
        except:
            # If we can't parse, let syntax validator handle it
            pass
        
        is_valid = len(issues) == 0
        
        return is_valid, issues


class RequirementsValidator:
    """Validate that code meets requirements"""
    
    def validate(
        self,
        code: str,
        requirements: Dict[str, Any]
    ) -> Tuple[bool, List[str]]:
        """
        Check if code meets requirements
        
        This is a basic heuristic check. Full validation requires execution.
        
        Returns:
            (requirements_met, list_of_issues)
        """
        
        issues = []
        
        # Check for expected inputs (function parameters)
        expected_inputs = requirements.get('inputs', [])
        if expected_inputs:
            # Simple check: are parameter names mentioned in code?
            for input_spec in expected_inputs:
                # Extract parameter name (e.g., "file_path: str" → "file_path")
                param_name = input_spec.split(':')[0].strip()
                
                if param_name not in code:
                    issues.append(f"Expected input '{param_name}' not found in code")
        
        # Check for expected operations
        description = requirements.get('description', '').lower()
        
        # Data loading indicators
        if any(word in description for word in ['load', 'read', 'import']):
            if not any(word in code.lower() for word in ['read', 'load', 'open']):
                issues.append("Expected data loading operation not found")
        
        # Computation indicators
        if any(word in description for word in ['calculate', 'compute', 'sum']):
            if not any(word in code.lower() for word in ['sum', 'mean', 'calculate', '=']):
                issues.append("Expected computation not found")
        
        # Check for function definition if required
        if 'def ' not in code:
            issues.append("No function definition found (code should be in a function)")
        
        requirements_met = len(issues) == 0
        
        return requirements_met, issues


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def quick_validate(code: str) -> bool:
    """
    Quick validation check
    
    Returns:
        bool: True if code passes basic checks
    """
    
    validator = SyntaxValidator()
    is_valid, _ = validator.validate(code)
    
    return is_valid


def get_validation_summary(result: ValidationResult) -> str:
    """
    Get human-readable validation summary
    
    Returns:
        str: Formatted summary
    """
    
    lines = []
    
    if result.is_valid:
        lines.append("✓ Validation PASSED")
    else:
        lines.append("✗ Validation FAILED")
    
    lines.append(f"  Syntax: {'✓' if result.syntax_valid else '✗'}")
    lines.append(f"  Security: {'✓' if result.security_passed else '✗'}")
    lines.append(f"  Requirements: {'✓' if result.requirements_met else '✗'}")
    
    if result.errors:
        lines.append(f"\nErrors ({len(result.errors)}):")
        for error in result.errors:
            lines.append(f"  - {error}")
    
    if result.warnings:
        lines.append(f"\nWarnings ({len(result.warnings)}):")
        for warning in result.warnings:
            lines.append(f"  - {warning}")
    
    return '\n'.join(lines)
