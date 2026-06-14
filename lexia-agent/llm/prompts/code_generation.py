# llm/prompts/code_generation.py

"""
Code Generation Prompts
========================

Prompts for generating Python code from requirements.
"""

from typing import Dict, Any, List, Optional


def build_generation_prompt(
    description: str,
    inputs: Optional[List[str]] = None,
    outputs: Optional[List[str]] = None,
    constraints: Optional[List[str]] = None,
    feedback: Optional[Dict] = None,
    attempt_number: int = 1
) -> str:
    """
    Build prompt for code generation
    
    Args:
        description: Task description
        inputs: Input parameters
        outputs: Expected outputs
        constraints: Constraints and requirements
        feedback: Feedback from previous attempts
        attempt_number: Current attempt number
        
    Returns:
        Code generation prompt
    """
    
    prompt = f"""You are an expert Python programmer. Generate clean, efficient, production-quality code.

Task:
{description}
"""
    
    # Add inputs
    if inputs:
        prompt += "\n\nInputs:\n"
        for inp in inputs:
            prompt += f"- {inp}\n"
    
    # Add outputs
    if outputs:
        prompt += "\n\nExpected Outputs:\n"
        for out in outputs:
            prompt += f"- {out}\n"
    
    # Add constraints
    if constraints:
        prompt += "\n\nConstraints:\n"
        for constraint in constraints:
            prompt += f"- {constraint}\n"
    
    # Add feedback from previous attempts
    if feedback and attempt_number > 1:
        prompt += f"\n\n⚠️ PREVIOUS ATTEMPT {attempt_number - 1} HAD ISSUES:\n"
        
        if feedback.get('syntax_errors'):
            prompt += "\nSyntax Errors:\n"
            for error in feedback['syntax_errors']:
                prompt += f"- {error}\n"
        
        if feedback.get('validation_errors'):
            prompt += "\nValidation Errors:\n"
            for error in feedback['validation_errors']:
                prompt += f"- {error}\n"
        
        prompt += "\nPlease fix these issues in your new implementation.\n"
    
    # Requirements
    prompt += """

Requirements:
1. Write complete, executable Python code
2. Include necessary imports
3. Use type hints for all functions
4. Add docstrings for functions
5. Include error handling
6. Use descriptive variable names
7. Follow PEP 8 style guidelines
8. Add a __main__ block for testing

Provide ONLY the Python code, no explanations or markdown.
"""
    
    return prompt


def build_fix_prompt(
    code: str,
    errors: List[str],
    error_type: str = 'syntax'
) -> str:
    """
    Build prompt for fixing code errors
    
    Args:
        code: Code with errors
        errors: List of error messages
        error_type: Type of errors ('syntax', 'runtime', 'validation')
        
    Returns:
        Fix prompt
    """
    
    errors_text = "\n".join(f"- {e}" for e in errors)
    
    prompt = f"""Fix the {error_type} errors in this code:

```python
{code}
```

Errors to fix:
{errors_text}

Requirements:
1. Fix ALL listed errors
2. Preserve the original functionality
3. Maintain code structure where possible
4. Keep good parts of the code unchanged
5. Add error handling if needed

Provide ONLY the corrected code, no explanations.
"""
    
    return prompt


def build_optimization_prompt(
    code: str,
    optimization_type: str = 'performance'
) -> str:
    """
    Build prompt for code optimization
    
    Args:
        code: Code to optimize
        optimization_type: 'performance', 'readability', or 'memory'
        
    Returns:
        Optimization prompt
    """
    
    optimization_guidance = {
        'performance': """
- Use vectorized operations instead of loops
- Leverage built-in functions
- Minimize redundant computations
- Use appropriate data structures
- Consider caching for expensive operations
""",
        'readability': """
- Simplify complex logic
- Extract functions for clarity
- Use meaningful variable names
- Add helpful comments
- Follow consistent formatting
""",
        'memory': """
- Use generators instead of lists where possible
- Delete large objects when done
- Use appropriate data types
- Avoid unnecessary copies
- Stream data when possible
"""
    }
    
    guidance = optimization_guidance.get(optimization_type, optimization_guidance['performance'])
    
    prompt = f"""Optimize this code for {optimization_type}:

```python
{code}
```

Optimization goals:
{guidance}

Requirements:
1. Maintain the same functionality
2. Keep the same inputs/outputs
3. Ensure correctness is not compromised
4. Make meaningful improvements

Provide the optimized code only.
"""
    
    return prompt


def build_function_generation_prompt(
    function_name: str,
    description: str,
    parameters: List[Dict[str, str]],
    return_type: str
) -> str:
    """
    Build prompt for generating a specific function
    
    Args:
        function_name: Name of function
        description: What function does
        parameters: List of {name, type, description}
        return_type: Return type
        
    Returns:
        Function generation prompt
    """
    
    params_text = "\n".join(
        f"- {p['name']} ({p['type']}): {p['description']}"
        for p in parameters
    )
    
    prompt = f"""Generate a Python function with this signature:

Function Name: {function_name}
Description: {description}

Parameters:
{params_text}

Returns: {return_type}

Requirements:
1. Include complete type hints
2. Add comprehensive docstring
3. Implement full functionality
4. Include error handling
5. Add input validation

Provide the complete function implementation.
"""
    
    return prompt


def build_test_generation_prompt(code: str) -> str:
    """
    Build prompt for generating unit tests
    
    Args:
        code: Code to test
        
    Returns:
        Test generation prompt
    """
    
    prompt = f"""Generate comprehensive unit tests for this code:

```python
{code}
```

Requirements:
1. Use pytest framework
2. Test normal cases
3. Test edge cases
4. Test error conditions
5. Aim for high coverage
6. Use descriptive test names
7. Include fixtures if needed

Provide complete test code.
"""
    
    return prompt


def build_code_explanation_prompt(code: str) -> str:
    """
    Build prompt for explaining code
    
    Args:
        code: Code to explain
        
    Returns:
        Explanation prompt
    """
    
    prompt = f"""Explain this code in detail:

```python
{code}
```

Provide:
1. High-level overview of what it does
2. Step-by-step explanation of the logic
3. Explanation of key functions/classes
4. Any important design decisions
5. Potential improvements

Format as clear, educational explanation.
"""
    
    return prompt
