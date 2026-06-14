# llm/prompts/code_improvement.py

"""
Code Improvement Prompts
=========================

Prompts for refining, refactoring, and improving code.
"""

from typing import Dict, Any, List, Optional


def build_refactoring_prompt(
    code: str,
    refactoring_type: str = 'general'
) -> str:
    """
    Build prompt for code refactoring
    
    Args:
        code: Code to refactor
        refactoring_type: 'general', 'extract_functions', 'simplify', 'modernize'
        
    Returns:
        Refactoring prompt
    """
    
    refactoring_guides = {
        'general': """
General refactoring to improve code quality:
- Extract complex logic into functions
- Remove code duplication
- Improve naming
- Simplify complex expressions
- Add type hints
- Improve structure
""",
        'extract_functions': """
Extract functions refactoring:
- Identify logical units
- Create well-named functions
- Keep functions focused (single responsibility)
- Extract repeated code
- Reduce main code complexity
""",
        'simplify': """
Simplification refactoring:
- Reduce nesting
- Simplify boolean logic
- Remove unnecessary code
- Use built-in functions
- Replace complex patterns with simpler ones
""",
        'modernize': """
Modernization refactoring:
- Use f-strings instead of .format()
- Use pathlib instead of os.path
- Use type hints throughout
- Use dataclasses where appropriate
- Use walrus operator where helpful
- Use match statements (Python 3.10+)
"""
    }
    
    guide = refactoring_guides.get(refactoring_type, refactoring_guides['general'])
    
    prompt = f"""Refactor this code:

```python
{code}
```

{guide}

Requirements:
1. Maintain exact same functionality
2. Keep same inputs/outputs
3. Improve code quality significantly
4. Make code more maintainable

Provide:
REFACTORED_CODE:
[complete refactored code]

IMPROVEMENTS_MADE:
- [list each improvement]
"""
    
    return prompt


def build_documentation_prompt(
    code: str,
    documentation_level: str = 'comprehensive'
) -> str:
    """
    Build prompt for adding documentation
    
    Args:
        code: Code to document
        documentation_level: 'basic', 'comprehensive', or 'extensive'
        
    Returns:
        Documentation prompt
    """
    
    level_guides = {
        'basic': """
Add basic documentation:
- Module docstring
- Function docstrings (one-line)
- Key variable comments
""",
        'comprehensive': """
Add comprehensive documentation:
- Module docstring with overview
- Function docstrings with Args, Returns, Raises
- Class docstrings
- Important logic comments
- Type hints for all functions
""",
        'extensive': """
Add extensive documentation:
- Module docstring with full description and examples
- Function docstrings with detailed Args, Returns, Raises, Examples
- Class docstrings with attributes and examples
- Inline comments for complex logic
- Type hints everywhere
- Usage examples in docstrings
"""
    }
    
    guide = level_guides.get(documentation_level, level_guides['comprehensive'])
    
    prompt = f"""Add documentation to this code:

```python
{code}
```

{guide}

Use Google-style docstrings.

Example format:
def function(arg1: str, arg2: int) -> bool:
    '''
    Brief description.
    
    Longer description if needed.
    
    Args:
        arg1: Description of arg1
        arg2: Description of arg2
        
    Returns:
        Description of return value
        
    Raises:
        ValueError: When validation fails
        
    Example:
        >>> function("test", 5)
        True
    '''

Provide the fully documented code.
"""
    
    return prompt


def build_performance_optimization_prompt(code: str) -> str:
    """
    Build prompt for performance optimization
    
    Args:
        code: Code to optimize
        
    Returns:
        Performance optimization prompt
    """
    
    prompt = f"""Optimize this code for performance:

```python
{code}
```

Focus on:

ALGORITHMIC_IMPROVEMENTS:
- Use better algorithms/data structures
- Reduce time complexity
- Avoid unnecessary iterations

PANDAS_OPTIMIZATIONS (if applicable):
- Use vectorized operations
- Avoid iterrows()
- Use efficient groupby operations
- Leverage built-in functions

PYTHON_OPTIMIZATIONS:
- Use list comprehensions
- Use generators for large data
- Leverage built-ins
- Minimize function calls in loops

CACHING:
- Cache expensive computations
- Memoize repeated calculations

Provide:
OPTIMIZED_CODE:
[performance-optimized code]

OPTIMIZATIONS_APPLIED:
- [each optimization with expected impact]

EXPECTED_SPEEDUP:
[estimated performance improvement]
"""
    
    return prompt


def build_error_handling_prompt(code: str) -> str:
    """
    Build prompt for adding error handling
    
    Args:
        code: Code needing error handling
        
    Returns:
        Error handling prompt
    """
    
    prompt = f"""Add comprehensive error handling to this code:

```python
{code}
```

Add handling for:

FILE_OPERATIONS:
- FileNotFoundError
- PermissionError
- IOError

DATA_OPERATIONS:
- ValueError (invalid data)
- KeyError (missing keys)
- IndexError (out of bounds)
- TypeError (wrong types)

EXTERNAL_DEPENDENCIES:
- Import errors
- Connection errors
- API failures

VALIDATION:
- Input validation
- Data validation
- Precondition checks

Best practices:
1. Use specific exception types
2. Provide helpful error messages
3. Clean up resources (use context managers)
4. Log errors appropriately
5. Don't catch and hide exceptions unnecessarily

Provide code with proper error handling.
"""
    
    return prompt


def build_type_hints_prompt(code: str) -> str:
    """
    Build prompt for adding type hints
    
    Args:
        code: Code needing type hints
        
    Returns:
        Type hints prompt
    """
    
    prompt = f"""Add complete type hints to this code:

```python
{code}
```

Requirements:
1. Add type hints to all function parameters
2. Add return type hints
3. Use appropriate types from typing module
4. Use Optional[] for nullable values
5. Use Union[] for multiple possible types
6. Use List[], Dict[], etc. for collections
7. Consider using TypedDict for dict structures
8. Add variable annotations where helpful

Example:
from typing import List, Dict, Optional, Union

def process_data(
    data: List[Dict[str, Union[str, int]]],
    filter_key: Optional[str] = None
) -> Dict[str, int]:
    ...

Provide the code with complete type hints.
"""
    
    return prompt


def build_code_cleanup_prompt(code: str) -> str:
    """
    Build prompt for general code cleanup
    
    Args:
        code: Code to clean up
        
    Returns:
        Cleanup prompt
    """
    
    prompt = f"""Clean up this code:

```python
{code}
```

Remove/Fix:
- Unused imports
- Unused variables
- Dead code
- Debug print statements
- TODO comments
- Commented-out code
- Trailing whitespace
- Inconsistent formatting

Improve:
- Variable naming
- Formatting consistency
- Import organization
- Blank line usage

Follow PEP 8 strictly.

Provide cleaned code.
"""
    
    return prompt
