# llm/prompts/query_augmentation.py

"""
Query Augmentation Prompts
===========================

Prompts for enhancing and clarifying user queries.
"""

from typing import Dict, Any, List, Optional


def build_augmentation_prompt(
    query: str,
    context: Optional[Dict[str, Any]] = None,
    source_names: Optional[List[str]] = None,
    selected_skills: Optional[List[str]] = None,
) -> str:
    """
    Build prompt for query augmentation.

    Includes full conversation history (user queries + assistant results)
    so the LLM can resolve references in follow-up questions.
    """

    prompt = f"""You are an expert at understanding Moroccan financial data queries.

Original Query:
"{query}"
"""

    if source_names:
        prompt += "\n\nAVAILABLE DATA SOURCES (parquet files — ONLY reference these):\n"
        for name in source_names:
            prompt += f"- {name}\n"

    if selected_skills:
        prompt += "\n\nREQUESTED SKILLS (preserve these exact names if relevant):\n"
        for skill in selected_skills:
            prompt += f"- {skill}\n"

    if context:
        conversation_turns = context.get('conversation_turns', [])
        if conversation_turns:
            prompt += "\n\nCONVERSATION HISTORY (most recent last):\n"
            for turn in conversation_turns[-5:]:
                role = turn.get('role', 'user').upper()
                content = turn.get('content', '')
                if len(content) > 400:
                    content = content[:400] + "..."
                prompt += f"[{role}]: {content}\n"

        if not conversation_turns and context.get('previous_queries'):
            prompt += "\n\nPrevious queries in this session:\n"
            for prev in context['previous_queries'][-3:]:
                prompt += f"- {prev}\n"

    prompt += """

Your task:
1. Resolve any pronouns or follow-up references using conversation history
2. Produce a clear, self-contained ENHANCED_QUERY

CRITICAL RULES:
- The ENHANCED_QUERY must be a SHORT, actionable sentence (1-3 sentences MAX)
- ONLY reference data sources from the AVAILABLE DATA SOURCES list above — NEVER invent file names
- Do NOT add requirements the user did not ask for (no Excel export, no extra analyses)
- Do NOT ask clarification questions — just enhance what was asked
- Keep it close to the original query — only add context from conversation history if needed
- If the user explicitly requested a skill, keep that skill name verbatim in the ENHANCED_QUERY
- All amounts in MAD, all text in French

Respond with ONLY this format (nothing else):

ENHANCED_QUERY: [Rewritten query — short, self-contained, grounded in available data sources]
"""

    return prompt


def build_clarification_prompt(
    query: str,
    ambiguities: List[str]
) -> str:
    """
    Build prompt for generating clarification questions
    
    Args:
        query: Original query
        ambiguities: List of identified ambiguities
        
    Returns:
        Clarification prompt
    """
    
    ambiguities_text = "\n".join(f"- {a}" for a in ambiguities)
    
    prompt = f"""Given this user query:
"{query}"

We identified these ambiguities:
{ambiguities_text}

Generate 2-3 focused clarification questions to resolve these ambiguities.

Format each question as:
Q: [question]
Options: [option1 / option2 / option3]

Make questions specific and actionable.
"""
    
    return prompt


def build_intent_classification_prompt(query: str) -> str:
    """
    Build prompt for classifying query intent
    
    Args:
        query: User query
        
    Returns:
        Classification prompt
    """
    
    prompt = f"""Classify the intent of this query:
"{query}"

Categories:
- data_loading: Load/read data from files
- data_processing: Transform, filter, aggregate data
- computation: Perform calculations
- visualization: Create charts/graphs
- analysis: Statistical analysis, insights
- ml_training: Train machine learning models
- automation: Automate tasks/workflows

Output format:
CATEGORY: [primary category]
CONFIDENCE: [0.0-1.0]
SUBCATEGORY: [more specific classification if applicable]
"""
    
    return prompt


def build_requirement_extraction_prompt(query: str) -> str:
    """
    Build prompt for extracting requirements
    
    Args:
        query: User query
        
    Returns:
        Extraction prompt
    """
    
    prompt = f"""Extract structured requirements from this query:
"{query}"

Identify:

DATA_SOURCES:
- File: [filename or description]
- Format: [parquet/csv/json/etc]
- Columns: [expected columns if mentioned]

OPERATIONS:
- [List each operation to perform]

OUTPUTS:
- Type: [dataframe/file/visualization/etc]
- Format: [format of output]
- Destination: [where to save, if specified]

CONSTRAINTS:
- Performance: [any performance requirements]
- Quality: [accuracy, completeness requirements]
- Other: [any other constraints]

Extract ONLY what is explicitly stated or clearly implied.
Use "Not specified" for unclear items.
"""
    
    return prompt


def build_context_integration_prompt(
    query: str,
    conversation_history: List[Dict]
) -> str:
    """
    Build prompt for integrating conversation context
    
    Args:
        query: Current query
        conversation_history: Previous conversation
        
    Returns:
        Context integration prompt
    """
    
    history_text = "\n\n".join(
        f"User: {msg['user']}\nAssistant: {msg['assistant']}"
        for msg in conversation_history[-3:]
    )
    
    prompt = f"""Given this conversation history:

{history_text}

Current query:
"{query}"

Resolve any pronouns, references, or implicit context from history.

Output:
RESOLVED_QUERY: [Query with all references resolved]
CONTEXT_USED: [What context from history was used]
DEPENDENCIES: [Any dependencies on previous results]
"""
    
    return prompt
