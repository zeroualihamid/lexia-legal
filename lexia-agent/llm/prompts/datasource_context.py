"""
Datasource Context Prompt Builder

Builds comprehensive LLM prompts describing available datasources with their schemas.
This provides the LLM with full context about available data sources, columns,
types, and business context for generating accurate queries.
"""

from typing import Dict, Any, Optional


def build_datasource_context_prompt(shared: Dict[str, Any]) -> str:
    """
    Build a comprehensive prompt section describing available datasources.
    
    Uses schemas and metadata from shared state to create LLM context about
    all available data sources, their columns, types, and business purpose.
    
    Args:
        shared: Shared state containing 'schemas' and 'datasources_metadata'
    
    Returns:
        Formatted markdown prompt text describing all datasources
        
    Example output:
        # AVAILABLE DATASOURCES
        
        You have access to the following data sources for analysis:
        
        ## commande_entete
        **File:** data/sql_bambinos_db_commande_entete.parquet
        **Purpose:** Contains sales orders with header information...
        
        **Columns:**
        - `CodeBC` (string): Order code
        - `Client` (string, categorical): Client name
        - `DateDoc` (datetime): Document date
        ...
    """
    
    schemas = shared.get('schemas', {})
    metadata = shared.get('datasources_metadata', {})
    
    if not schemas:
        return "No datasources available."
    
    prompt_sections = [
        "# AVAILABLE DATASOURCES",
        "",
        "You have access to the following data sources for analysis:",
        ""
    ]
    
    for source_id, columns_classes in schemas.items():
        ds_meta = metadata.get(source_id, {})
        
        # Header with source ID
        prompt_sections.append(f"## {source_id}")
        
        # File path
        file_path = ds_meta.get('path', 'N/A')
        prompt_sections.append(f"**File:** {file_path}")
        
        # Business context (preferred) or description
        purpose = ds_meta.get('business_context', ds_meta.get('description', 'N/A'))
        prompt_sections.append(f"**Purpose:** {purpose}")
        prompt_sections.append("")
        
        # Column definitions
        prompt_sections.append("**Columns:**")
        for col in columns_classes.columns:
            # Add categorical marker if applicable
            categorical_marker = " (categorical)" if col.is_categorical else ""
            
            # Format: - `column_name` (type[, categorical]): description
            prompt_sections.append(
                f"- `{col.column_name}` ({col.type}{categorical_marker}): {col.description}"
            )
        
        prompt_sections.append("")
    
    return "\n".join(prompt_sections)


def build_query_with_datasource_context(
    query: str, 
    shared: Dict[str, Any],
    additional_instructions: Optional[str] = None
) -> str:
    """
    Build a full prompt combining user query with datasource context.
    
    This creates a complete LLM prompt that includes:
    1. Role definition (financial data analyst)
    2. Full datasource context with all columns and types
    3. User's natural language query
    4. Instructions for processing the query
    
    Args:
        query: User's natural language query
        shared: Shared state with schemas and metadata
        additional_instructions: Optional additional instructions to append
    
    Returns:
        Complete prompt with datasource context + user query + instructions
        
    Example:
        >>> prompt = build_query_with_datasource_context(
        ...     "Donne moi le chiffre d'affaire par ans et reparti par mois",
        ...     shared
        ... )
    """
    
    datasource_context = build_datasource_context_prompt(shared)
    
    prompt_parts = [
        "You are a financial data analyst assistant. The user has asked a question about their business data.",
        "",
        datasource_context,
        "",
        "# USER QUERY",
        query,
        "",
        "# INSTRUCTIONS",
        "1. Identify which datasource(s) are needed to answer the query",
        "2. Determine which columns are required",
        "3. Explain your reasoning step by step",
        "4. Consider the following guidance for common queries:",
        "",
        "**For revenue/sales queries (chiffre d'affaire):**",
        "- Use 'commande_entete' datasource for order-level revenue",
        "- Extract year and month from 'DateDoc' column",
        "- Sum 'TotalHT' (excluding tax) or 'TotalTTC' (including tax)",
        "- Group by extracted year and month",
        "",
        "**For detailed product analysis:**",
        "- Use 'commande_lignes' for line-item details",
        "- Join with 'article_vente' for product names",
        "- Analyze quantities, unit prices, and amounts",
        "",
        "**For cash flow/bank analysis:**",
        "- Use 'releve_nsmobili' for nsMobili transactions",
        "- Use 'releve_nsfactory' for nsFactory transactions",
        "- Analyze 'Montant Débit' and 'Montant Crédit' columns",
        "- Filter by 'Date Opération' for time-based analysis",
        "",
        "**For expense analysis:**",
        "- Use 'charges' datasource",
        "- Columns '1' through '12' represent months (January=1, December=12)",
        "- 'Total' column contains annual sums",
    ]
    
    if additional_instructions:
        prompt_parts.extend(["", additional_instructions])
    
    return "\n".join(prompt_parts)


def get_datasource_summary(shared: Dict[str, Any]) -> Dict[str, Any]:
    """
    Get a summary of available datasources for logging or debugging.
    
    Args:
        shared: Shared state containing schemas and metadata
        
    Returns:
        Dictionary with datasource summary information:
            - total_datasources: int
            - datasource_names: List[str]
            - total_columns: int
            - datasources_detail: List[Dict]
    """
    schemas = shared.get('schemas', {})
    metadata = shared.get('datasources_metadata', {})
    
    datasources_detail = []
    total_columns = 0
    
    for source_id, columns_classes in schemas.items():
        ds_meta = metadata.get(source_id, {})
        column_count = len(columns_classes.columns)
        total_columns += column_count
        
        datasources_detail.append({
            'source_id': source_id,
            'path': ds_meta.get('path', 'N/A'),
            'column_count': column_count,
            'description': ds_meta.get('description', 'N/A')
        })
    
    return {
        'total_datasources': len(schemas),
        'datasource_names': list(schemas.keys()),
        'total_columns': total_columns,
        'datasources_detail': datasources_detail
    }


def build_schema_aware_prompt(
    query: str,
    shared: Dict[str, Any],
    task_type: str = "general"
) -> str:
    """
    Build a schema-aware prompt tailored to specific task types.
    
    Args:
        query: User's natural language query
        shared: Shared state with schemas and metadata
        task_type: Type of task - "general", "code_generation", "planning", "validation"
        
    Returns:
        Task-specific prompt with datasource context
    """
    datasource_context = build_datasource_context_prompt(shared)
    
    if task_type == "code_generation":
        prompt = f"""You are generating Python code to analyze financial data.

{datasource_context}

# TASK
Generate Python code (pandas) to answer: {query}

# CODE REQUIREMENTS
1. Use pd.read_parquet() to load data from the file paths shown above
2. Use exact column names as specified in the schema
3. Handle datetime conversions appropriately
4. Include error handling
5. Output results in a clear format

Generate the code now:"""
        
    elif task_type == "planning":
        prompt = f"""You are planning how to answer a financial data query.

{datasource_context}

# QUERY
{query}

# PLANNING TASK
Create a step-by-step plan that:
1. Identifies required datasources
2. Lists necessary columns
3. Outlines data transformations
4. Specifies grouping/aggregation logic
5. Defines expected output format

Provide your plan:"""
        
    elif task_type == "validation":
        prompt = f"""You are validating if a query can be answered with available data.

{datasource_context}

# QUERY TO VALIDATE
{query}

# VALIDATION TASK
Determine:
1. Can this query be answered with available datasources? (yes/no)
2. Which datasources are needed?
3. Are all required columns available?
4. Are there any ambiguities or missing information?

Provide your validation:"""
        
    else:  # general
        prompt = build_query_with_datasource_context(query, shared)
    
    return prompt


if __name__ == "__main__":
    """Test the datasource context prompt builder."""
    
    # Mock shared state for testing
    from classes.dtos.commande_entete_dto import get_commande_entete_columns_descriptions
    from classes.dtos.releve_bancaire_dto import get_releve_bancaire_columns_descriptions
    
    shared = {
        'schemas': {
            'commande_entete': get_commande_entete_columns_descriptions(),
            'releve_nsmobili': get_releve_bancaire_columns_descriptions()
        },
        'datasources_metadata': {
            'commande_entete': {
                'path': 'data/sql_bambinos_db_commande_entete.parquet',
                'description': 'Sales order headers',
                'business_context': 'Contains sales orders with totals and dates',
                'type': 'parquet'
            },
            'releve_nsmobili': {
                'path': 'data/releve_nsmobili_data.parquet',
                'description': 'Bank statements for nsMobili',
                'business_context': 'Bank transaction history for nsMobili',
                'type': 'parquet'
            }
        }
    }
    
    print("=" * 80)
    print("DATASOURCE CONTEXT PROMPT")
    print("=" * 80)
    prompt = build_datasource_context_prompt(shared)
    print(prompt)
    
    print("\n" + "=" * 80)
    print("QUERY WITH DATASOURCE CONTEXT")
    print("=" * 80)
    query = "Donne moi le chiffre d'affaire par ans et reparti par mois"
    full_prompt = build_query_with_datasource_context(query, shared)
    print(full_prompt)
    
    print("\n" + "=" * 80)
    print("DATASOURCE SUMMARY")
    print("=" * 80)
    summary = get_datasource_summary(shared)
    print(f"Total datasources: {summary['total_datasources']}")
    print(f"Datasource names: {', '.join(summary['datasource_names'])}")
    print(f"Total columns: {summary['total_columns']}")
    print("\nDetails:")
    for ds in summary['datasources_detail']:
        print(f"  - {ds['source_id']}: {ds['column_count']} columns")
