# llm/prompts/agent_challenger.py

"""
Challenger Agent Prompts
=========================

Prompts for the ChallengerAgent (Agent B) - finds issues and challenges proposals.
"""

from typing import Dict, Any, List, Optional


def build_challenge_prompt(
    code: str,
    proposal_context: Optional[Dict] = None,
    analysis_depth: str = 'thorough'
) -> str:
    """
    Build prompt for challenging a code proposal
    
    Args:
        code: Code to challenge
        proposal_context: Context about the proposal
        analysis_depth: 'thorough', 'balanced', or 'lenient'
        
    Returns:
        Challenge prompt
    """
    
    depth_instructions = {
        'thorough': """
ANALYSIS DEPTH: THOROUGH
- Find ALL issues, regardless of severity
- Check for edge cases extensively
- Scrutinize every aspect of the code
- Be highly critical and detailed
""",
        'balanced': """
ANALYSIS DEPTH: BALANCED
- Focus on significant issues
- Flag critical and major problems
- Skip minor style issues
- Be fair but thorough
""",
        'lenient': """
ANALYSIS DEPTH: LENIENT
- Focus ONLY on critical issues
- Flag only problems that would cause failures
- Skip minor and moderate issues
- Be constructive, not nitpicky
"""
    }
    
    instructions = depth_instructions.get(analysis_depth, depth_instructions['balanced'])
    
    prompt = f"""You are reviewing this code proposal with a critical eye:

```python
{code}
```

{instructions}

Analyze the code for issues in these categories:

1. CORRECTNESS:
   - Logic errors
   - Edge cases not handled
   - Incorrect assumptions
   - Missing validations

2. EFFICIENCY:
   - Performance bottlenecks
   - Inefficient algorithms
   - Unnecessary operations
   - Memory issues

3. SECURITY:
   - Unsafe operations
   - Input validation missing
   - Potential vulnerabilities
   - Dangerous patterns

4. BEST PRACTICES:
   - PEP 8 violations
   - Missing type hints
   - Poor naming
   - Lack of documentation

5. ROBUSTNESS:
   - Missing error handling
   - Uncaught exceptions
   - Fragile code
   - No input validation

For EACH issue found, provide:

ISSUE: [critical|major|minor] [description]

After listing all issues:

OVERALL_SEVERITY: [critical|major|minor]
TOTAL_ISSUES: [count]
RECOMMENDATION: [approve|revise|reject]
SUGGESTED_IMPROVEMENTS:
- [list key improvements needed]
"""
    
    return prompt


def build_issue_analysis_prompt(
    code: str,
    focus_area: str = 'all'
) -> str:
    """
    Build prompt for analyzing specific issue areas
    
    Args:
        code: Code to analyze
        focus_area: 'correctness', 'security', 'efficiency', or 'all'
        
    Returns:
        Issue analysis prompt
    """
    
    focus_guides = {
        'correctness': """
Focus on CORRECTNESS issues:

Check for:
- Will the code execute without errors?
- Does the logic produce correct results?
- Are all edge cases handled?
- Are there any bugs or logical errors?
- Is input validation sufficient?

List each correctness issue with:
ISSUE: [severity] [description]
IMPACT: [what goes wrong]
""",
        'security': """
Focus on SECURITY issues:

Check for:
- eval() or exec() usage
- SQL injection vulnerabilities
- Command injection risks
- Unsafe deserialization
- Missing input sanitization
- File system access without checks
- Credential exposure

List each security issue with:
ISSUE: [severity] [description]
EXPLOIT: [how it could be exploited]
""",
        'efficiency': """
Focus on EFFICIENCY issues:

Check for:
- O(n²) or worse algorithms
- Unnecessary loops
- Repeated calculations
- Inefficient data structures
- Memory leaks
- Excessive copying

List each efficiency issue with:
ISSUE: [severity] [description]
PERFORMANCE_IMPACT: [how bad is it]
""",
        'all': """
Comprehensive analysis across ALL areas:
- Correctness
- Security
- Efficiency
- Best practices
- Robustness
"""
    }
    
    guide = focus_guides.get(focus_area, focus_guides['all'])
    
    prompt = f"""Analyze this code for issues:

```python
{code}
```

{guide}

Provide detailed analysis with specific, actionable findings.
"""
    
    return prompt


def build_vulnerability_scan_prompt(code: str) -> str:
    """
    Build prompt for scanning security vulnerabilities
    
    Args:
        code: Code to scan
        
    Returns:
        Vulnerability scan prompt
    """
    
    prompt = f"""Perform a security vulnerability scan on this code:

```python
{code}
```

Check for:

DANGEROUS_FUNCTIONS:
- eval(), exec(), compile()
- os.system(), subprocess with shell=True
- pickle.loads() without validation

INJECTION_RISKS:
- SQL injection (string formatting in queries)
- Command injection (unvalidated shell commands)
- Path traversal (unvalidated file paths)

DATA_EXPOSURE:
- Hardcoded credentials
- Sensitive data in logs
- Unencrypted sensitive data

INPUT_VALIDATION:
- Missing input sanitization
- No type checking
- Unvalidated user input

For each vulnerability:
VULNERABILITY: [type]
SEVERITY: [critical|high|medium|low]
LOCATION: [where in code]
REMEDIATION: [how to fix]

Provide complete vulnerability report.
"""
    
    return prompt


def build_edge_case_analysis_prompt(code: str) -> str:
    """
    Build prompt for edge case analysis
    
    Args:
        code: Code to analyze
        
    Returns:
        Edge case analysis prompt
    """
    
    prompt = f"""Identify edge cases not handled by this code:

```python
{code}
```

Consider:

NULL/NONE VALUES:
- What happens with None inputs?
- Empty strings, lists, dicts?

BOUNDARY CONDITIONS:
- Zero values
- Negative numbers
- Very large numbers
- Empty data structures

TYPE MISMATCHES:
- Wrong input types
- Mixed types in collections

SPECIAL CASES:
- Missing files
- Network failures
- Invalid data formats

For each unhandled edge case:
EDGE_CASE: [description]
CURRENT_BEHAVIOR: [what happens now]
SHOULD_BE: [what should happen]
"""
    
    return prompt


def build_improvement_suggestions_prompt(
    code: str,
    issues: List[Dict]
) -> str:
    """
    Build prompt for generating improvement suggestions
    
    Args:
        code: Code with issues
        issues: Identified issues
        
    Returns:
        Improvement suggestions prompt
    """
    
    issues_text = "\n".join(
        f"- [{i.get('severity')}] {i.get('description')}"
        for i in issues
    )
    
    prompt = f"""Given this code with identified issues:

Code:
```python
{code}
```

Issues:
{issues_text}

Provide specific, actionable improvement suggestions.

For each major issue, suggest:
IMPROVEMENT [number]:
Issue: [which issue this addresses]
Suggestion: [specific fix or improvement]
Code Change: [show the fix if possible]
Priority: [high|medium|low]

Focus on the most impactful improvements first.
"""
    
    return prompt
