# agents/consensus_builder.py

"""
Consensus Builder
Builds and validates consensus from adversarial debate outcomes

The Consensus Builder is responsible for:
- Evaluating debate outcomes
- Determining if genuine consensus was reached
- Analyzing debate quality and trajectory
- Assessing agent responsiveness
- Providing final recommendations
"""

from typing import Dict, Any, List, Optional
from dataclasses import dataclass

from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class ConsensusEvaluation:
    """
    Evaluation of consensus from debate
    
    Contains assessment of whether genuine consensus was reached
    and quality metrics for the debate process.
    """
    consensus_reached: bool
    quality: str  # 'high', 'medium', 'low'
    confidence: float
    rounds: int
    improving: bool
    responsive: bool
    recommendation: str  # 'approve', 'approve_with_caution', 'reject', 'continue_debate'
    details: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        return {
            'consensus_reached': self.consensus_reached,
            'quality': self.quality,
            'confidence': self.confidence,
            'rounds': self.rounds,
            'improving': self.improving,
            'responsive': self.responsive,
            'recommendation': self.recommendation,
            'details': self.details
        }


# ============================================================================
# CONSENSUS BUILDER
# ============================================================================

class ConsensusBuilder:
    """
    Builds consensus from adversarial debate outcomes
    
    Analyzes the debate history to determine if genuine consensus
    was reached or if the debate should continue/be rejected.
    
    Key Criteria:
    1. Confidence threshold met
    2. Improving trajectory over rounds
    3. Responsive to feedback
    4. Issues adequately addressed
    
    Example:
        builder = ConsensusBuilder(config)
        
        evaluation = builder.evaluate(debate_result)
        
        if evaluation.recommendation == 'approve':
            use_code(debate_result.approved_code)
        elif evaluation.recommendation == 'continue_debate':
            continue_debating()
        else:
            reject_code()
    """
    
    def __init__(self, config):
        """
        Initialize Consensus Builder
        
        Args:
            config: Configuration object
        """
        self.config = config
        
        # Thresholds
        self.min_confidence = getattr(config, 'consensus_threshold', 0.9)
        self.min_improvement = 0.05  # Minimum confidence improvement
        
        logger.info(
            f"ConsensusBuilder initialized (threshold: {self.min_confidence:.2%})"
        )
    
    # ========================================================================
    # MAIN EVALUATION
    # ========================================================================
    
    def evaluate(self, debate_result) -> ConsensusEvaluation:
        """
        Evaluate debate outcome for consensus
        
        Args:
            debate_result: DebateResult object from DebateManager
            
        Returns:
            ConsensusEvaluation with assessment and recommendation
        """
        
        logger.info(
            f"Evaluating consensus from {debate_result.rounds}-round debate "
            f"(confidence: {debate_result.final_confidence:.2%})"
        )
        
        # Extract key metrics
        confidence = debate_result.final_confidence
        rounds = debate_result.rounds
        history = debate_result.debate_history
        
        # Check confidence threshold
        meets_threshold = self._check_confidence_threshold(confidence)
        
        # Check improvement trajectory
        improving = self._check_improvement_trajectory(history)
        
        # Check responsiveness to challenges
        responsive = self._check_responsiveness(history)
        
        # Check issue resolution
        issues_addressed = self._check_issue_resolution(history)
        
        # Determine overall quality
        quality = self._assess_quality(
            meets_threshold,
            improving,
            responsive,
            issues_addressed,
            rounds
        )
        
        # Generate recommendation
        recommendation = self._generate_recommendation(
            meets_threshold,
            quality,
            improving,
            responsive,
            rounds
        )
        
        # Build details
        details = {
            'meets_threshold': meets_threshold,
            'threshold': self.min_confidence,
            'improving_trajectory': improving,
            'responsive_to_challenges': responsive,
            'issues_addressed': issues_addressed,
            'quality_factors': {
                'confidence': confidence,
                'rounds': rounds,
                'improving': improving,
                'responsive': responsive
            }
        }
        
        evaluation = ConsensusEvaluation(
            consensus_reached=meets_threshold,
            quality=quality,
            confidence=confidence,
            rounds=rounds,
            improving=improving,
            responsive=responsive,
            recommendation=recommendation,
            details=details
        )
        
        logger.info(
            f"Consensus evaluation: {recommendation} "
            f"(quality: {quality}, consensus: {meets_threshold})"
        )
        
        return evaluation
    
    # ========================================================================
    # EVALUATION CRITERIA
    # ========================================================================
    
    def _check_confidence_threshold(self, confidence: float) -> bool:
        """
        Check if confidence meets minimum threshold
        
        Args:
            confidence: Final confidence score
            
        Returns:
            True if threshold met
        """
        
        meets = confidence >= self.min_confidence
        
        logger.debug(
            f"Confidence check: {confidence:.2%} {'≥' if meets else '<'} "
            f"{self.min_confidence:.2%} → {meets}"
        )
        
        return meets
    
    def _check_improvement_trajectory(self, history: List[Dict]) -> bool:
        """
        Check if confidence improved over debate rounds
        
        Args:
            history: Debate history
            
        Returns:
            True if improving
        """
        
        # Extract defense confidences
        defenses = [h for h in history if h.get('action') == 'defense']
        
        if len(defenses) < 2:
            # Single round, no trajectory to analyze
            logger.debug("Improvement check: single round, assuming improving")
            return True
        
        # Check if latest confidence >= initial confidence
        initial_confidence = defenses[0].get('confidence', 0.0)
        final_confidence = defenses[-1].get('confidence', 0.0)
        
        improvement = final_confidence - initial_confidence
        improving = improvement >= -0.05  # Allow slight decrease
        
        logger.debug(
            f"Improvement check: {initial_confidence:.2%} → "
            f"{final_confidence:.2%} (Δ{improvement:+.2%}) → {improving}"
        )
        
        return improving
    
    def _check_responsiveness(self, history: List[Dict]) -> bool:
        """
        Check if proposer was responsive to challenges
        
        Args:
            history: Debate history
            
        Returns:
            True if responsive
        """
        
        # Extract challenges and defenses
        challenges = [h for h in history if h.get('action') == 'challenge']
        defenses = [h for h in history if h.get('action') == 'defense']
        
        if not challenges:
            # No challenges, can't evaluate responsiveness
            logger.debug("Responsiveness check: no challenges")
            return True
        
        # Check if any defenses included revisions
        revisions = [d for d in defenses if d.get('revised')]
        
        # Check if critical challenges were addressed
        critical_challenges = [
            c for c in challenges 
            if c.get('severity') == 'critical' or c.get('issues', 0) > 3
        ]
        
        if critical_challenges:
            # If there were critical challenges, expect at least one revision
            responsive = len(revisions) > 0
            logger.debug(
                f"Responsiveness check: {len(critical_challenges)} critical challenges, "
                f"{len(revisions)} revisions → {responsive}"
            )
        else:
            # No critical challenges, responsive by default
            responsive = True
            logger.debug("Responsiveness check: no critical challenges")
        
        return responsive
    
    def _check_issue_resolution(self, history: List[Dict]) -> bool:
        """
        Check if issues were adequately addressed
        
        Args:
            history: Debate history
            
        Returns:
            True if issues resolved
        """
        
        # Get first and last challenge
        challenges = [h for h in history if h.get('action') == 'challenge']
        
        if not challenges:
            logger.debug("Issue resolution check: no challenges")
            return True
        
        first_challenge = challenges[0]
        last_challenge = challenges[-1]
        
        # Check if number of issues decreased
        initial_issues = first_challenge.get('issues', 0)
        final_issues = last_challenge.get('issues', 0)
        
        # Check if severity decreased
        initial_severity = first_challenge.get('severity', 'minor')
        final_severity = last_challenge.get('severity', 'minor')
        
        severity_order = {'minor': 0, 'major': 1, 'critical': 2}
        severity_improved = (
            severity_order.get(final_severity, 0) <= 
            severity_order.get(initial_severity, 0)
        )
        
        issues_reduced = final_issues <= initial_issues
        
        resolved = issues_reduced and severity_improved
        
        logger.debug(
            f"Issue resolution check: {initial_issues} → {final_issues} issues, "
            f"{initial_severity} → {final_severity} severity → {resolved}"
        )
        
        return resolved
    
    # ========================================================================
    # QUALITY ASSESSMENT
    # ========================================================================
    
    def _assess_quality(
        self,
        meets_threshold: bool,
        improving: bool,
        responsive: bool,
        issues_addressed: bool,
        rounds: int
    ) -> str:
        """
        Assess overall consensus quality
        
        Args:
            meets_threshold: Confidence threshold met
            improving: Improving trajectory
            responsive: Responsive to challenges
            issues_addressed: Issues were addressed
            rounds: Number of rounds
            
        Returns:
            Quality level ('high', 'medium', 'low')
        """
        
        # High quality: all criteria met
        if meets_threshold and improving and responsive and issues_addressed:
            return 'high'
        
        # Medium quality: threshold met, some criteria met
        elif meets_threshold and (improving or responsive):
            return 'medium'
        
        # Low quality: threshold not met or multiple criteria failed
        else:
            return 'low'
    
    def _generate_recommendation(
        self,
        meets_threshold: bool,
        quality: str,
        improving: bool,
        responsive: bool,
        rounds: int
    ) -> str:
        """
        Generate final recommendation
        
        Args:
            meets_threshold: Confidence threshold met
            quality: Quality assessment
            improving: Improving trajectory
            responsive: Responsive to challenges
            rounds: Number of rounds
            
        Returns:
            Recommendation ('approve', 'approve_with_caution', 'reject', 'continue_debate')
        """
        
        max_rounds = getattr(self.config, 'max_debate_rounds', 4)
        
        # High quality + threshold = approve
        if quality == 'high' and meets_threshold:
            logger.debug("Recommendation: approve (high quality, threshold met)")
            return 'approve'
        
        # Medium quality + threshold = approve with caution
        elif quality == 'medium' and meets_threshold:
            logger.debug("Recommendation: approve_with_caution (medium quality)")
            return 'approve_with_caution'
        
        # Threshold met but low quality
        elif meets_threshold and quality == 'low':
            logger.debug("Recommendation: approve_with_caution (low quality)")
            return 'approve_with_caution'
        
        # Not at max rounds and improving = continue
        elif rounds < max_rounds and improving:
            logger.debug(f"Recommendation: continue_debate (round {rounds}/{max_rounds})")
            return 'continue_debate'
        
        # Max rounds reached or not improving = reject
        else:
            logger.debug("Recommendation: reject (max rounds or not improving)")
            return 'reject'
    
    # ========================================================================
    # UTILITY METHODS
    # ========================================================================
    
    def get_consensus_summary(self, evaluation: ConsensusEvaluation) -> str:
        """
        Get human-readable summary of consensus evaluation
        
        Args:
            evaluation: ConsensusEvaluation object
            
        Returns:
            Formatted summary string
        """
        
        lines = []
        
        lines.append("=" * 60)
        lines.append("CONSENSUS EVALUATION")
        lines.append("=" * 60)
        
        # Status
        status = "✓ REACHED" if evaluation.consensus_reached else "✗ NOT REACHED"
        lines.append(f"Consensus: {status}")
        lines.append(f"Quality: {evaluation.quality.upper()}")
        lines.append(f"Confidence: {evaluation.confidence:.2%}")
        lines.append(f"Rounds: {evaluation.rounds}")
        
        # Factors
        lines.append("\nFactors:")
        lines.append(f"  Improving: {'✓' if evaluation.improving else '✗'}")
        lines.append(f"  Responsive: {'✓' if evaluation.responsive else '✗'}")
        
        # Recommendation
        lines.append(f"\nRecommendation: {evaluation.recommendation.upper()}")
        
        lines.append("=" * 60)
        
        return '\n'.join(lines)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def quick_consensus_check(debate_result, threshold: float = 0.9) -> bool:
    """
    Quick consensus check
    
    Simple check if confidence meets threshold.
    
    Args:
        debate_result: DebateResult object
        threshold: Minimum confidence threshold
        
    Returns:
        True if consensus reached
    """
    
    return debate_result.final_confidence >= threshold


def get_consensus_metrics(debate_result) -> Dict[str, Any]:
    """
    Get consensus metrics from debate result
    
    Args:
        debate_result: DebateResult object
        
    Returns:
        Dict with consensus metrics
    """
    
    history = debate_result.debate_history
    
    # Extract metrics
    challenges = [h for h in history if h.get('action') == 'challenge']
    defenses = [h for h in history if h.get('action') == 'defense']
    
    total_issues = sum(c.get('issues', 0) for c in challenges)
    revisions = sum(1 for d in defenses if d.get('revised'))
    
    return {
        'final_confidence': debate_result.final_confidence,
        'rounds': debate_result.rounds,
        'total_challenges': len(challenges),
        'total_issues_raised': total_issues,
        'total_revisions': revisions,
        'consensus_reached': debate_result.consensus_reached
    }


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of ConsensusBuilder
    """
    
    from config.settings import settings
    
    # Create builder
    builder = ConsensusBuilder(settings)
    
    # Simulate debate result
    class MockDebateResult:
        def __init__(self):
            self.consensus_reached = True
            self.final_confidence = 0.92
            self.rounds = 2
            self.approved_code = "..."
            self.debate_history = [
                {'round': 0, 'action': 'proposal', 'confidence': 0.85},
                {'round': 1, 'action': 'challenge', 'issues': 3, 'severity': 'major'},
                {'round': 1, 'action': 'defense', 'confidence': 0.88, 'revised': True},
                {'round': 2, 'action': 'challenge', 'issues': 1, 'severity': 'minor'},
                {'round': 2, 'action': 'defense', 'confidence': 0.92, 'revised': False}
            ]
    
    debate_result = MockDebateResult()
    
    # Evaluate
    evaluation = builder.evaluate(debate_result)
    
    # Display
    print(builder.get_consensus_summary(evaluation))
    
    # Check recommendation
    if evaluation.recommendation == 'approve':
        print("\n✓ Code approved for use")
    elif evaluation.recommendation == 'approve_with_caution':
        print("\n⚠ Code approved with caution")
    elif evaluation.recommendation == 'continue_debate':
        print("\n→ Continue debate")
    else:
        print("\n✗ Code rejected")
