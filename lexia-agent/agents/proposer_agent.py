# agents/proposer_agent.py

"""
Proposer Agent (Agent A)
Creates proposals and defends them in adversarial debates

The Proposer is responsible for:
- Creating initial proposals for code solutions
- Analyzing code strengths and rationale
- Defending proposals against challenges
- Revising code to address critical issues
- Maintaining confidence through debate rounds
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
class Proposal(AgentResponse):
    """Proposal from Proposer agent"""
    code: str
    proposal_type: str  # 'reuse' or 'new'
    rationale: str
    strengths: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict:
        base = super().to_dict()
        base.update({
            'code': self.code,
            'proposal_type': self.proposal_type,
            'rationale': self.rationale,
            'strengths': self.strengths
        })
        return base


@dataclass
class Defense(AgentResponse):
    """Defense response from Proposer"""
    revised_code: Optional[str] = None
    addressed_issues: List[str] = field(default_factory=list)
    rebuttal_points: List[str] = field(default_factory=list)


class ProposerAgent(BaseAgent):
    """
    Proposer Agent - Creates and defends code proposals
    
    Strategies:
    - reuse_first: Strongly prefer reusing proven code
    - balanced: Balance between reuse and innovation
    - innovative: Prefer generating fresh solutions
    """
    
    def __init__(self, config, llm_client=None, strategy='reuse_first'):
        super().__init__(config, llm_client)
        self.strategy = strategy
        logger.info(f"ProposerAgent initialized with strategy: {strategy}")
    
    def create_proposal(
        self,
        code: str,
        proposal_type: str = 'new',
        metadata: Optional[Dict] = None
    ) -> Proposal:
        """Create initial proposal for code"""
        
        logger.info(f"Creating {proposal_type} proposal")
        
        strengths = self._analyze_strengths(code)
        rationale = self._generate_rationale(code, proposal_type, metadata)
        confidence = self._calculate_confidence(code, proposal_type, strengths)
        arguments = self._build_arguments(code, strengths, proposal_type)
        
        proposal = Proposal(
            code=code,
            proposal_type=proposal_type,
            rationale=rationale,
            strengths=strengths,
            confidence=confidence,
            arguments=arguments,
            metadata=metadata or {}
        )
        
        logger.info(f"Proposal created with confidence {confidence:.2%}")
        return proposal
    
    def defend(self, proposal: Proposal, challenge) -> Defense:
        """Defend proposal against challenge"""
        
        logger.info(f"Defending against challenge with {len(challenge.issues)} issues")
        
        critical_issues = [i for i in challenge.issues if i['severity'] == 'critical']
        major_issues = [i for i in challenge.issues if i['severity'] == 'major']
        
        should_revise = len(critical_issues) > 0 or len(major_issues) >= 2
        
        if should_revise:
            revised_code = self._revise_code(proposal.code, critical_issues + major_issues)
            addressed = [i['description'] for i in (critical_issues + major_issues)]
            confidence = min(0.95, proposal.confidence + 0.15)
            arguments = [f"Revised to address: {issue}" for issue in addressed[:3]]
            rebuttal_points = ["Code has been improved based on feedback"]
        else:
            revised_code = None
            addressed = []
            confidence = min(0.98, proposal.confidence + 0.05)
            arguments = ["No significant issues identified"]
            rebuttal_points = ["Code meets all critical requirements"]
        
        return Defense(
            confidence=confidence,
            arguments=arguments,
            metadata={'revised': bool(revised_code)},
            revised_code=revised_code,
            addressed_issues=addressed,
            rebuttal_points=rebuttal_points
        )
    
    def _analyze_strengths(self, code: str) -> List[str]:
        """Analyze code strengths using LLM"""
        
        prompt = f"""Analyze the strengths of this Python code:

```python
{code}
```

List 3-5 key strengths.
Format: STRENGTH: description
"""
        
        try:
            response = self._call_llm(prompt)
            strengths = []
            for line in response.split('\n'):
                if 'STRENGTH:' in line:
                    strength = line.split('STRENGTH:', 1)[1].strip()
                    if strength:
                        strengths.append(strength)
            return strengths[:5] if strengths else ["Code is syntactically valid"]
        except:
            return ["Code provided for analysis"]
    
    def _generate_rationale(self, code: str, proposal_type: str, metadata: Optional[Dict]) -> str:
        """Generate rationale for proposal"""
        
        if proposal_type == 'reuse':
            executions = metadata.get('total_executions', 0) if metadata else 0
            success_rate = metadata.get('success_rate', 0.0) if metadata else 0.0
            return f"Reusing proven code with {executions} executions and {success_rate:.0%} success rate"
        else:
            return "Generated fresh solution optimized for current requirements"
    
    def _calculate_confidence(self, code: str, proposal_type: str, strengths: List[str]) -> float:
        """Calculate proposal confidence"""
        
        base_confidence = 0.75 if proposal_type == 'reuse' else 0.70
        strength_bonus = min(0.2, len(strengths) * 0.04)
        quality_bonus = 0.0
        
        if 'def ' in code:
            quality_bonus += 0.02
        if '"""' in code or "'''" in code:
            quality_bonus += 0.02
        
        return max(0.5, min(1.0, base_confidence + strength_bonus + quality_bonus))
    
    def _build_arguments(self, code: str, strengths: List[str], proposal_type: str) -> List[str]:
        """Build supporting arguments"""
        
        arguments = [f"Strength: {s}" for s in strengths[:3]]
        
        if proposal_type == 'reuse':
            arguments.append("Proven solution with track record")
        else:
            arguments.append("Optimized for current requirements")
        
        return arguments
    
    def _revise_code(self, code: str, issues: List[Dict]) -> str:
        """Revise code to address issues"""
        
        issue_descriptions = '\n'.join(f"- [{i['severity']}] {i['description']}" for i in issues)
        
        prompt = f"""Revise this code to fix these issues:

Issues:
{issue_descriptions}

Code:
```python
{code}
```

Provide ONLY the revised code.
"""
        
        try:
            response = self._call_llm(prompt)
            if '```python' in response:
                code_part = response.split('```python')[1].split('```')[0]
            elif '```' in response:
                code_part = response.split('```')[1].split('```')[0]
            else:
                code_part = response
            return code_part.strip()
        except:
            return code
    
    def analyze_code(self, code: str, metadata: Optional[Dict] = None) -> AgentResponse:
        """Implement abstract method"""
        proposal = self.create_proposal(code, metadata=metadata)
        return AgentResponse(
            confidence=proposal.confidence,
            arguments=proposal.arguments,
            metadata=proposal.metadata
        )
    
    def generate_arguments(self, code: str, context: Dict[str, Any]) -> List[str]:
        """Generate arguments"""
        strengths = self._analyze_strengths(code)
        return self._build_arguments(code, strengths, context.get('type', 'new'))
    
    def respond_to_feedback(self, feedback: Dict[str, Any], previous_response: AgentResponse) -> AgentResponse:
        """Respond to feedback"""
        return previous_response


def create_proposer_agent(config, llm_client=None, strategy='reuse_first'):
    """Factory function"""
    return ProposerAgent(config, llm_client, strategy)
