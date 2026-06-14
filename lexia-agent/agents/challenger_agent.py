# agents/challenger_agent.py

"""
Challenger Agent (Agent B)
Challenges proposals and identifies issues

The Challenger is responsible for:
- Analyzing proposed code for issues
- Identifying bugs, inefficiencies, and security problems
- Challenging proposals with specific concerns
- Suggesting improvements
- Ensuring code quality through critical review
"""

from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field

from agents.base_agent import BaseAgent, AgentResponse
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class Challenge(AgentResponse):
    """
    Challenge from Challenger agent
    
    Contains identified issues along with severity classification
    and suggested improvements.
    """
    issues: List[Dict[str, Any]]
    severity: str  # 'critical', 'major', 'minor'
    suggested_improvements: List[str]
    
    def to_dict(self) -> Dict:
        base = super().to_dict()
        base.update({
            'issues': self.issues,
            'severity': self.severity,
            'suggested_improvements': self.suggested_improvements
        })
        return base


# ============================================================================
# CHALLENGER AGENT
# ============================================================================

class ChallengerAgent(BaseAgent):
    """
    Challenger Agent - Finds issues and challenges proposals
    
    The Challenger acts as the critical reviewer, identifying
    potential problems and ensuring code quality.
    
    Strategies:
    - thorough: Deep analysis, finds all possible issues
    - balanced: Balance between thoroughness and speed
    - lenient: Only flags critical issues
    
    Example:
        challenger = ChallengerAgent(config, strategy='thorough')
        
        challenge = challenger.challenge(proposal)
        
        print(f"Found {len(challenge.issues)} issues")
        print(f"Severity: {challenge.severity}")
    """
    
    def __init__(self, config, llm_client=None, strategy='thorough'):
        """
        Initialize Challenger Agent
        
        Args:
            config: Configuration object
            llm_client: Optional LLM client
            strategy: 'thorough', 'balanced', or 'lenient'
        """
        super().__init__(config, llm_client)
        self.strategy = strategy
        
        logger.info(f"ChallengerAgent initialized with strategy: {strategy}")
    
    # ========================================================================
    # MAIN METHODS
    # ========================================================================
    
    def challenge(self, proposal) -> Challenge:
        """
        Challenge a proposal
        
        Args:
            proposal: Proposal object from ProposerAgent
            
        Returns:
            Challenge object with issues and improvements
        """
        
        code = proposal.code
        
        logger.info(f"Challenging proposal with strategy: {self.strategy}")
        
        # Find issues based on strategy
        if self.strategy == 'thorough':
            issues = self._thorough_analysis(code, proposal.metadata)
        elif self.strategy == 'lenient':
            issues = self._lenient_analysis(code, proposal.metadata)
        else:  # balanced
            issues = self._balanced_analysis(code, proposal.metadata)
        
        # Classify overall severity
        severity = self._classify_severity(issues)
        
        # Generate improvement suggestions
        improvements = self._suggest_improvements(issues)
        
        # Calculate confidence (inversely related to issues found)
        confidence = self._calculate_confidence(issues)
        
        # Build arguments from issues
        arguments = [issue['description'] for issue in issues]
        
        challenge = Challenge(
            confidence=confidence,
            arguments=arguments,
            metadata={
                'strategy': self.strategy,
                'num_issues': len(issues)
            },
            issues=issues,
            severity=severity,
            suggested_improvements=improvements
        )
        
        # Update history
        self.update_history('challenge', {
            'num_issues': len(issues),
            'severity': severity,
            'confidence': confidence
        })
        
        logger.info(
            f"Challenge created: {len(issues)} issues, severity={severity}, "
            f"confidence={confidence:.2%}"
        )
        
        return challenge
    
    # ========================================================================
    # ANALYSIS METHODS
    # ========================================================================
    
    def _thorough_analysis(self, code: str, metadata: Dict) -> List[Dict]:
        """
        Thorough analysis - find ALL possible issues
        
        Args:
            code: Code to analyze
            metadata: Context metadata
            
        Returns:
            List of issue dicts
        """
        
        logger.debug("Running thorough analysis")
        
        prompt = f"""Thoroughly analyze this Python code for ANY issues or potential problems:

```python
{code}
```

Check for:
1. Correctness - Logic errors, edge cases, bugs
2. Efficiency - Performance issues, inefficient algorithms
3. Security - Vulnerabilities, dangerous patterns
4. Best practices - PEP 8, naming conventions, documentation
5. Maintainability - Readability, modularity, complexity
6. Error handling - Missing try-except, validation
7. Type safety - Missing type hints, type mismatches

List EVERY issue found, no matter how minor.
Format each issue as:
ISSUE: [critical|major|minor] description
"""
        
        try:
            response = self._call_llm(prompt)
            issues = self._parse_issues(response)
            
            logger.debug(f"Thorough analysis found {len(issues)} issues")
            
            return issues
        
        except Exception as e:
            logger.error(f"Thorough analysis failed: {e}")
            return []
    
    def _balanced_analysis(self, code: str, metadata: Dict) -> List[Dict]:
        """
        Balanced analysis - significant issues only
        
        Args:
            code: Code to analyze
            metadata: Context metadata
            
        Returns:
            List of issue dicts
        """
        
        logger.debug("Running balanced analysis")
        
        prompt = f"""Analyze this Python code for significant issues:

```python
{code}
```

Focus on:
1. Critical bugs that would cause failures
2. Major performance or security issues
3. Important best practice violations

Only list critical and major issues. Skip minor style issues.
Format: ISSUE: [critical|major] description
"""
        
        try:
            response = self._call_llm(prompt)
            issues = self._parse_issues(response)
            
            logger.debug(f"Balanced analysis found {len(issues)} issues")
            
            return issues
        
        except Exception as e:
            logger.error(f"Balanced analysis failed: {e}")
            return []
    
    def _lenient_analysis(self, code: str, metadata: Dict) -> List[Dict]:
        """
        Lenient analysis - critical issues ONLY
        
        Args:
            code: Code to analyze
            metadata: Context metadata
            
        Returns:
            List of issue dicts
        """
        
        logger.debug("Running lenient analysis")
        
        prompt = f"""Analyze this Python code for CRITICAL issues ONLY:

```python
{code}
```

Only report issues that would:
- Cause the code to crash or fail
- Create severe security vulnerabilities
- Lead to completely incorrect results

Ignore minor issues, style problems, and optimizations.
Format: ISSUE: [critical] description
"""
        
        try:
            response = self._call_llm(prompt)
            issues = self._parse_issues(response)
            
            logger.debug(f"Lenient analysis found {len(issues)} issues")
            
            return issues
        
        except Exception as e:
            logger.error(f"Lenient analysis failed: {e}")
            return []
    
    def _parse_issues(self, llm_response: str) -> List[Dict]:
        """
        Parse issues from LLM response
        
        Args:
            llm_response: Raw LLM response
            
        Returns:
            List of parsed issue dicts
        """
        
        issues = []
        
        for line in llm_response.split('\n'):
            if 'ISSUE:' in line:
                try:
                    # Parse format: ISSUE: [severity] description
                    parts = line.split(']', 1)
                    severity = parts[0].split('[')[1].strip()
                    description = parts[1].strip()
                    
                    # Validate severity
                    if severity in ['critical', 'major', 'minor']:
                        issues.append({
                            'severity': severity,
                            'description': description
                        })
                    
                except (IndexError, ValueError):
                    # Skip malformed lines
                    continue
        
        return issues
    
    # ========================================================================
    # UTILITY METHODS
    # ========================================================================
    
    def _classify_severity(self, issues: List[Dict]) -> str:
        """
        Classify overall severity based on issues
        
        Args:
            issues: List of issues
            
        Returns:
            Overall severity ('critical', 'major', or 'minor')
        """
        
        if any(i['severity'] == 'critical' for i in issues):
            return 'critical'
        elif any(i['severity'] == 'major' for i in issues):
            return 'major'
        else:
            return 'minor'
    
    def _suggest_improvements(self, issues: List[Dict]) -> List[str]:
        """
        Generate improvement suggestions
        
        Args:
            issues: List of issues
            
        Returns:
            List of improvement suggestions
        """
        
        suggestions = []
        
        for issue in issues:
            # Only suggest fixes for critical and major issues
            if issue['severity'] in ['critical', 'major']:
                suggestion = f"Fix: {issue['description']}"
                suggestions.append(suggestion)
        
        return suggestions[:5]  # Max 5 suggestions
    
    def _calculate_confidence(self, issues: List[Dict]) -> float:
        """
        Calculate challenge confidence
        
        More issues found = higher confidence in challenge
        
        Args:
            issues: List of issues
            
        Returns:
            Confidence score (0.0-1.0)
        """
        
        if not issues:
            # No issues found = low confidence in challenge
            return 0.3
        
        # Base confidence
        base = 0.5
        
        # Bonus for each issue
        issue_bonus = min(0.4, len(issues) * 0.08)
        
        # Extra bonus for critical issues
        critical_count = sum(1 for i in issues if i['severity'] == 'critical')
        critical_bonus = min(0.2, critical_count * 0.1)
        
        confidence = base + issue_bonus + critical_bonus
        
        return min(0.95, confidence)
    
    # ========================================================================
    # ABSTRACT METHOD IMPLEMENTATIONS
    # ========================================================================
    
    def analyze_code(self, code: str, metadata: Optional[Dict] = None) -> AgentResponse:
        """
        Analyze code (implements BaseAgent abstract method)
        
        Args:
            code: Code to analyze
            metadata: Optional metadata
            
        Returns:
            AgentResponse with analysis
        """
        
        # Create a minimal proposal object for challenge
        class MinimalProposal:
            def __init__(self, code, metadata):
                self.code = code
                self.metadata = metadata or {}
        
        proposal = MinimalProposal(code, metadata)
        challenge = self.challenge(proposal)
        
        return AgentResponse(
            confidence=challenge.confidence,
            arguments=challenge.arguments,
            metadata=challenge.metadata
        )
    
    def generate_arguments(
        self,
        code: str,
        context: Dict[str, Any]
    ) -> List[str]:
        """
        Generate arguments (implements BaseAgent abstract method)
        
        Args:
            code: Code to argue about
            context: Context information
            
        Returns:
            List of argument strings
        """
        
        # Run analysis based on strategy
        if self.strategy == 'thorough':
            issues = self._thorough_analysis(code, context)
        elif self.strategy == 'lenient':
            issues = self._lenient_analysis(code, context)
        else:
            issues = self._balanced_analysis(code, context)
        
        return [issue['description'] for issue in issues]
    
    def respond_to_feedback(
        self,
        feedback: Dict[str, Any],
        previous_response: AgentResponse
    ) -> AgentResponse:
        """
        Respond to feedback (implements BaseAgent abstract method)
        
        For Challenger, this would re-evaluate if issues were addressed
        
        Args:
            feedback: Feedback data
            previous_response: Previous challenge
            
        Returns:
            Updated response
        """
        
        # Check if code was revised
        if feedback.get('revised_code'):
            # Re-analyze revised code
            return self.analyze_code(
                feedback['revised_code'],
                feedback.get('metadata')
            )
        else:
            # No revision, maintain position
            return previous_response


# ============================================================================
# FACTORY FUNCTION
# ============================================================================

def create_challenger_agent(config, llm_client=None, strategy='thorough'):
    """
    Create a Challenger agent
    
    Args:
        config: Configuration object
        llm_client: Optional LLM client
        strategy: Agent strategy ('thorough', 'balanced', or 'lenient')
        
    Returns:
        ChallengerAgent instance
    """
    return ChallengerAgent(config, llm_client, strategy)
