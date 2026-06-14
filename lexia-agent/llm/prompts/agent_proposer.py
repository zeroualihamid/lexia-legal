# llm/prompts/agent_proposer.py

"""
Proposer Agent Prompts
=======================

Prompts for the ProposerAgent (Agent A) - creates and defends proposals.
"""

from typing import Dict, Any, List, Optional


def build_proposal_prompt(
    code: str,
    proposal_type: str,
    metadata: Optional[Dict] = None
) -> str:
    """
    Build prompt for creating a code proposal
    
    Args:
        code: Code to propose
        proposal_type: 'reuse' or 'new'
        metadata: Additional context
        
    Returns:
        Proposal creation prompt
    """
    
    if proposal_type == 'reuse':
        context = f"""This code has been successfully used before:
- Total executions: {metadata.get('total_executions', 'N/A')}
- Success rate: {metadata.get('success_rate', 'N/A')}
- Average duration: {metadata.get('avg_duration', 'N/A')}s
"""
    else:
        context = "This is newly generated code optimized for the current requirements."
    
    prompt = f"""You are proposing this code solution for review:

```python
{code}
```

Context:
{context}

Your task: Make a strong case for this code.

Analyze the code and provide:

STRENGTHS:
[List 3-5 key strengths - be specific and technical]
- 

RATIONALE:
[Explain why this solution is appropriate]

QUALITY_INDICATORS:
- Correctness: [assessment]
- Efficiency: [assessment]
- Maintainability: [assessment]
- Robustness: [assessment]

CONFIDENCE: [0.0-1.0 score]

Be thorough but honest in your assessment.
"""
    
    return prompt


def build_defense_prompt(
    code: str,
    challenges: List[Dict],
    proposal_context: Optional[Dict] = None
) -> str:
    """
    Build prompt for defending code against challenges
    
    Args:
        code: Original code
        challenges: List of challenges/issues raised
        proposal_context: Original proposal context
        
    Returns:
        Defense prompt
    """
    
    challenges_text = "\n\n".join(
        f"CHALLENGE {i+1} [{c.get('severity', 'unknown')}]:\n{c.get('description', '')}"
        for i, c in enumerate(challenges)
    )
    
    prompt = f"""You proposed this code:

```python
{code}
```

The challenger raised these concerns:

{challenges_text}

Your task: Defend your proposal or revise the code.

For each challenge, decide:
1. Accept: The challenge is valid - revise code to address it
2. Rebut: The challenge is not valid - explain why

Provide your response:

RESPONSE_TO_CHALLENGES:

For each challenge:
Challenge [number]: [ACCEPT or REBUT]
Reasoning: [explanation]

REVISED_CODE:
[If accepting any challenges, provide revised code]
[If no revisions needed, write "NO_CHANGES"]

UPDATED_CONFIDENCE: [0.0-1.0]

DEFENSE_SUMMARY:
[Brief summary of your defense]
"""
    
    return prompt


def build_strengths_analysis_prompt(code: str) -> str:
    """
    Build prompt for analyzing code strengths
    
    Args:
        code: Code to analyze
        
    Returns:
        Strengths analysis prompt
    """
    
    prompt = f"""Analyze the strengths of this code objectively:

```python
{code}
```

Identify specific, technical strengths in these areas:

CODE_QUALITY:
- [What makes this code well-written?]

CORRECTNESS:
- [Evidence that this code works correctly]

EFFICIENCY:
- [Performance advantages]

BEST_PRACTICES:
- [What best practices are followed?]

ROBUSTNESS:
- [How does it handle edge cases/errors?]

List 3-5 strongest points.
Format each as: STRENGTH: [description]
Be specific and technical.
"""
    
    return prompt


def build_revision_prompt(
    original_code: str,
    issues_to_address: List[Dict]
) -> str:
    """
    Build prompt for revising code to address issues
    
    Args:
        original_code: Code to revise
        issues_to_address: Issues that need fixing
        
    Returns:
        Revision prompt
    """
    
    issues_text = "\n".join(
        f"- [{i.get('severity')}] {i.get('description')}"
        for i in issues_to_address
    )
    
    prompt = f"""Revise this code to address the following issues:

Original code:
```python
{original_code}
```

Issues to fix:
{issues_text}

Requirements:
1. Fix all listed issues
2. Maintain core functionality
3. Preserve good aspects of original code
4. Ensure improvements are meaningful
5. Keep code clean and readable

Provide:
REVISED_CODE:
[complete revised code]

CHANGES_MADE:
- [list each change]

CONFIDENCE: [0.0-1.0 after revisions]
"""
    
    return prompt


def build_confidence_assessment_prompt(
    code: str,
    strengths: List[str],
    context: Optional[Dict] = None
) -> str:
    """
    Build prompt for assessing confidence in proposal
    
    Args:
        code: Code being proposed
        strengths: Identified strengths
        context: Additional context
        
    Returns:
        Confidence assessment prompt
    """
    
    strengths_text = "\n".join(f"- {s}" for s in strengths)
    
    prompt = f"""Assess your confidence in this code proposal:

Code:
```python
{code}
```

Identified strengths:
{strengths_text}
"""
    
    if context:
        prompt += f"\nAdditional context:\n{context}\n"
    
    prompt += """

Consider:
1. Code correctness - will it work as intended?
2. Edge cases - are all cases handled?
3. Error handling - are errors managed properly?
4. Best practices - does it follow Python conventions?
5. Completeness - is anything missing?

Provide:
CONFIDENCE_SCORE: [0.0-1.0]
REASONING: [Why this confidence level?]
AREAS_OF_CONCERN: [Any doubts or uncertainties]
"""
    
    return prompt
