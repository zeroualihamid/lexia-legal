# nodes/generation/final_validation_node.py
"""
Final Validation Node
Last gate before code is approved for sandbox execution.
Aggregates all previous validation signals into a single decision.
"""
from typing import Dict, Any, List
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class FinalValidationResult:
    """Aggregated final validation decision"""
    approved: bool
    overall_score: float       # 0.0 – 1.0
    gate_results: Dict[str, bool] = field(default_factory=dict)
    issues: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    recommendation: str = ""   # 'approve' | 'approve_with_warnings' | 'reject'

    def to_dict(self) -> Dict:
        return {
            'approved': self.approved,
            'overall_score': round(self.overall_score, 3),
            'gate_results': self.gate_results,
            'issues': self.issues,
            'warnings': self.warnings,
            'recommendation': self.recommendation,
        }


class FinalValidationNode:
    """
    Aggregates all previous validation results into a final decision.

    Gates checked:
    ✓ Syntax validation passed
    ✓ Security check passed
    ✓ Code is non-empty
    ✓ Required libraries present
    ✓ Outputs match requirements

    Routes:
    - approved:            All gates passed — send to debate/execution
    - approved_with_warnings: Passed but has warnings — proceed cautiously
    - rejected:            One or more hard gates failed — regenerate
    """

    # Scoring weights for overall_score
    WEIGHTS = {
        'syntax': 0.30,
        'security': 0.30,
        'non_empty': 0.15,
        'libraries_present': 0.15,
        'outputs_declared': 0.10,
    }

    def __init__(self):
        self.name = "FinalValidation"

    def prep(self, shared: Dict) -> Dict:
        return {
            'code': shared.get('last_generated_code', ''),
            'syntax_result': shared.get('syntax_validation_result', {}),
            'security_result': shared.get('security_check_result', {}),
            'requirements': shared.get('step_requirements', {}),
            'optimization_result': shared.get('optimization_result', {}),
            'documentation_result': shared.get('documentation_result', {}),
            'generation_attempts': shared.get('generation_attempts', 0),
        }

    def exec(self, prep_result: Dict) -> FinalValidationResult:
        code = prep_result['code']
        syntax = prep_result['syntax_result']
        security = prep_result['security_result']
        requirements = prep_result['requirements']

        logger.info("Running final validation...")

        gates: Dict[str, bool] = {}
        issues: List[str] = []
        warnings: List[str] = []

        # Gate 1: Non-empty code
        gates['non_empty'] = bool(code and code.strip())
        if not gates['non_empty']:
            issues.append("Code is empty")

        # Gate 2: Syntax passed
        gates['syntax'] = syntax.get('is_valid', False)
        if not gates['syntax']:
            for err in syntax.get('errors', []):
                issues.append(f"Syntax: {err}")
        for w in syntax.get('warnings', []):
            warnings.append(f"Syntax: {w}")

        # Gate 3: Security passed
        gates['security'] = security.get('passed', False)
        if not gates['security']:
            for v in security.get('violations', []):
                issues.append(f"Security: {v.get('message', str(v))}")
        for w in security.get('warnings', []):
            warnings.append(f"Security: {w}")

        # Gate 4: Required libraries present in code
        required_libs = requirements.get('libraries', [])
        if required_libs:
            missing = [lib for lib in required_libs if lib not in code]
            gates['libraries_present'] = len(missing) == 0
            if missing:
                warnings.append(f"Expected libraries not imported: {missing}")
        else:
            gates['libraries_present'] = True

        # Gate 5: At least one output declared
        outputs = requirements.get('outputs', [])
        if outputs:
            output_names = [o.get('name', '') for o in outputs if isinstance(o, dict)]
            gates['outputs_declared'] = any(n in code for n in output_names if n)
        else:
            gates['outputs_declared'] = True

        if not gates.get('outputs_declared', True):
            warnings.append("Expected output variables not found in code")

        # Compute weighted score
        score = sum(
            self.WEIGHTS.get(gate, 0) * (1.0 if passed else 0.0)
            for gate, passed in gates.items()
        )

        # Hard gates (must pass)
        hard_gates = ['non_empty', 'syntax', 'security']
        hard_failed = [g for g in hard_gates if not gates.get(g, False)]

        if hard_failed:
            recommendation = 'reject'
            approved = False
        elif warnings:
            recommendation = 'approve_with_warnings'
            approved = True
        else:
            recommendation = 'approve'
            approved = True

        result = FinalValidationResult(
            approved=approved,
            overall_score=score,
            gate_results=gates,
            issues=issues,
            warnings=warnings,
            recommendation=recommendation,
        )

        status = "✓ APPROVED" if approved else "✗ REJECTED"
        logger.info(
            f"Final validation {status} | score={score:.2f} | "
            f"issues={len(issues)} | warnings={len(warnings)}"
        )
        return result

    def post(self, shared: Dict, prep_result: Dict, exec_result: FinalValidationResult) -> str:
        shared['final_validation_result'] = exec_result.to_dict()

        rec = exec_result.recommendation

        if rec == 'approve':
            shared['approved_code'] = prep_result['code']
            logger.info("Code approved — proceeding to debate/execution")
            return 'approved'

        elif rec == 'approve_with_warnings':
            shared['approved_code'] = prep_result['code']
            logger.warning(f"Code approved with {len(exec_result.warnings)} warnings")
            return 'approved_with_warnings'

        else:
            logger.error(f"Code rejected: {exec_result.issues}")
            # Reset attempts so generation can try again
            shared['generation_feedback'] = {
                'errors': exec_result.issues,
                'type': 'final_validation'
            }
            return 'rejected'
