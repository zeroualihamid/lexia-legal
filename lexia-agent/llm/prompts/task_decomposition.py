# llm/prompts/task_decomposition.py

"""
Task Decomposition Prompts
===========================

Prompts for breaking down complex tasks into manageable steps.
"""

from datetime import date
from typing import Dict, Any, List, Optional


def _format_schema_context(
    schemas: Dict[str, Any],
    datasources_metadata: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Format parquet paths, descriptions, and (when available) column schemas from SchemaLoaderNode.
    Uses datasources_metadata so every parquet in datasources.yaml is listed with path and description.
    Includes column descriptions so the LLM can pick the right columns for the task.
    """
    meta = datasources_metadata or {}
    if not meta and not schemas:
        return ""

    # Use metadata as source of truth for which parquet files exist; schemas add column details
    source_ids = sorted(set(meta.keys()) | set(schemas.keys()))
    lines = []
    for source_id in source_ids:
        info = meta.get(source_id, {})
        path = info.get("path", "")
        desc = info.get("description", "")
        ctx = info.get("business_context", "")
        parts = [f"Datasource: {source_id}"]
        if path:
            parts.append(f"  Parquet path: {path}")
        if desc:
            parts.append(f"  Description: {desc}")
        if ctx:
            parts.append(f"  Context: {ctx}")
        schema_obj = schemas.get(source_id)
        if schema_obj is not None:
            columns = getattr(schema_obj, "columns", None)
            if columns:
                parts.append("  Columns:")
                for c in columns:
                    name = getattr(c, "column_name", getattr(c, "name", str(c)))
                    typ = getattr(c, "type", getattr(c, "data_type", "?"))
                    col_desc = getattr(c, "description", "")
                    if col_desc:
                        parts.append(f"    - {name} ({typ}): {col_desc}")
                    else:
                        parts.append(f"    - {name} ({typ})")
        lines.append("\n".join(parts))
    return "\n\n".join(lines)


def build_decomposition_prompt(
    query: str,
    requirements: Optional[Dict] = None,
    schemas: Optional[Dict[str, Any]] = None,
    datasources_metadata: Optional[Dict[str, Any]] = None,
    selected_skills_context: str = "",
) -> str:
    """
    Build prompt for task decomposition.

    Uses schema/datasource context from SchemaLoaderNode when provided so steps
    can reference real tables and columns.
    """
    today = date.today().isoformat()
    prompt = f"""You are a Moroccan financial data analyst planning how to answer a user query using local parquet files.
Today's date is {today}. The parquet files contain historical data up to recent dates — years like 2024 and 2025 are in the PAST and their data exists in the files.
All monetary values are in Moroccan Dirham (MAD). Output must use French labels (e.g. "Chiffre d'affaires", "Année").

USER QUERY:
"{query}"
"""
    schema_context = _format_schema_context(schemas or {}, datasources_metadata)
    if schema_context:
        prompt += f"""
AVAILABLE DATA (from config/datasources.yaml — these are the ONLY data sources; parquet paths are authoritative):
{schema_context}
"""

    if selected_skills_context:
        prompt += f"""
SELECTED SKILL CONTEXT:
{selected_skills_context}
"""

    if requirements:
        prompt += "\nAdditional requirements:\n"
        for key, value in requirements.items():
            if value:
                prompt += f"- {key}: {value}\n"

    prompt += """
FIRST, decide if this query requires data computation or is a conversational/reasoning question:

- If the query asks for numbers, reports, calculations, charts, or anything that requires reading the parquet files → produce STEP(s) as described below.
- If the query is conversational, asks for explanations, methodology advice, definitions, comparisons of approaches, or anything that does NOT require reading data → respond with a DIRECT_ANSWER block instead of steps.

FORMAT FOR DIRECT ANSWERS (no data needed):
<DIRECT_ANSWER>
Your complete answer in Markdown format here. Use French when the user writes in French.
</DIRECT_ANSWER>

FORMAT FOR DATA STEPS (data computation needed):
Follow the STEP format below.

CRITICAL RULES (for data steps only):
1. Use the FEWEST steps possible. Most queries need only 1-2 steps. Never exceed 4 steps.
2. Each step becomes a standalone Python script — so combine loading, filtering, computing, and printing into ONE step when they operate on the same data.
3. Every step MUST be concretely executable as Python code. Do NOT create abstract/methodology steps like "Clarify approach" or "Select model" or "Validate with external data".
4. ONLY use the data sources listed above. Use the EXACT Parquet path from each Datasource entry (from config/datasources.yaml). Never invent paths or assume external data.
5. ONLY reference column names that exist in the schema above. Never invent column names.
6. Each step must print its result to stdout.
7. All monetary outputs MUST be formatted in Moroccan Dirham (MAD) with French labels.
8. When the result is a table (yearly breakdown, monthly data, etc.), the code must print a MARKDOWN TABLE (with | separators and header line).
9. If a skill is explicitly requested, the step description MUST reflect that skill's workflow and required deliverables.

PLANNING APPROACH:
- **For simple lookups/searches** (rechercher un montant, trouver des écritures, total d'un compte, filtrer par compte): use 1 step with MINIMAL code — just load, filter, print. Do NOT add reconciliation, analysis sections, anomaly detection, or recommendations. The code should be short and focused.
- For simple queries (revenue, totals, counts, filtering): use 1 step that loads the relevant parquet, computes the answer, and prints it.
- **For queries needing data from multiple sources: use exactly 1 step** that loads ALL relevant parquet files, computes/filters/aggregates from each, merges or combines the results, and prints a single unified output (table or report). NEVER split multi-source queries into separate steps per source — always combine everything in one step. If the query is a simple search across multiple sources, keep the code simple — do NOT turn it into a reconciliation or analytical report.
- Never split "load" and "compute" into separate steps when they use the same file.
- **For analytical/audit queries** (analyse comptable, diagnostic, rapport, bilan, etc.): use exactly 1 step. The step description MUST include the word "analyse" and specify that the code should produce a comprehensive multi-section professional report covering all account classes, observations, anomalies, and recommendations. DO NOT split an analytical report into multiple steps.
- If the user explicitly asks for CPC, bilan prévisionnel, fiscal analysis, or a named skill like fiscaliste, the single analytical step must explicitly mention those outputs in the Description.

IMPORTANT — MATCH RESPONSE COMPLEXITY TO QUERY COMPLEXITY:
- A search/lookup query ("recherche le montant X", "trouve les écritures du compte Y", "total du compte Z") needs SIMPLE code: load → filter → print results. Nothing more.
- An analytical query ("analyse comptable", "diagnostic", "rapport de rapprochement") needs comprehensive code with multiple sections.
- NEVER over-engineer a simple query into an analytical report. If the user asks to FIND something, just find it and show it.

Format each step as:

STEP [number]: [brief title]
Description: [what the code does — be specific about which parquet file, which columns, which filters]
Inputs: [parquet file paths and any parameters]
Outputs: [what gets printed to stdout — specify markdown table if multiple rows]
Dependencies: [step numbers this depends on, or 'none']

Example 1 — for "Quel est le chiffre d'affaires par année?":

STEP 1: Compute annual revenue from sales orders
Description: Load data/sql_bambinos_db_commande_entete.parquet, extract year from DateDoc, group by year, sum TotalHT and TotalTTC. Print result as a markdown table with columns Année, CA HT (MAD), CA TTC (MAD), sorted by year ascending. Format amounts with space thousands separator and MAD suffix.
Inputs: data/sql_bambinos_db_commande_entete.parquet
Outputs: Markdown table with annual revenue in MAD
Dependencies: none

Example 2 — for "Donne moi une analyse comptable du grand livre selon le plan comptable marocain":

STEP 1: Analyse comptable complète du grand livre selon le PCM
Description: Load the grand livre parquet file. Produce a comprehensive professional accounting analysis report with: (1) Cadre Général — period, number of entries, accounts, journals, balance verification; (2) Analyse par Classe du PCM — group accounts by leading digit 1-7, compute debit/credit/balance per class; (3) Détail par Classe — for each class list accounts with PCM labels, balances, and professional observations; (4) Alertes et Anomalies — flag issues like negative cash, missing depreciation, high advances, fiscal penalties; (5) Synthèse et Recommandations — summary KPIs and numbered action items. Use tabulate for formatted tables. All amounts in MAD.
Inputs: grand livre parquet file
Outputs: Multi-section professional accounting report printed to stdout
Dependencies: none

Example 3 — for "Effectue un rapprochement entre les relevés bancaires et le grand livre de nsfactory":

STEP 1: Rapprochement bancaire complet entre relevés et grand livre nsfactory
Description: Load both the releve bancaire parquet file and the grand livre nsfactory parquet file. Produce a comprehensive bank reconciliation report with: (1) Données Sources — overview table with row counts, total debits, total credits, and balance for each source; (2) Taux de Rapprochement — match operations between the two sources by amount and date proximity, report match rate percentage; (3) Suspens Identifiés — list operations present in bank statement but absent from GL, and vice versa, showing date, amount, nature, and impact; (4) État de Rapprochement Formel — start from bank statement balance, add/subtract unmatched items to arrive at GL balance, compute residual gap; (5) Anomalies Détectées — flag critical issues with severity level and specific recommendation for each; (6) Synthèse et Recommandations — summary KPIs and numbered action items. Use tabulate for formatted tables. All amounts in MAD.
Inputs: releve nsfactory parquet file, grand livre nsfactory parquet file
Outputs: Multi-section professional bank reconciliation report printed to stdout
Dependencies: none

Example 4 — for "Analyse des ventes vs paiements par chèques sur nsfactory et nsmobili pour 2025" (MULTI-SOURCE — all in 1 step):

STEP 1: Analyse croisée ventes et chèques NSFactory/NSMobili 2025
Description: Load ALL relevant parquet files in a single script: (1) Load commande_entete parquet, filter year 2025, group by month to get Ventes TTC; (2) Load commande_lignes parquet, join with commande_entete on order key, filter 2025, compute Nb Articles and Surface MDF per month; (3) Load releve nsfactory parquet, filter 2025 cheque operations (Libellé contains 'cheque' or 'chq' or 'remise'), group by month to get total cheques NSFactory; (4) Load releve nsmobili parquet, same cheque filter, group by month to get total cheques NSMobili; (5) Merge all 4 results on month into a single DataFrame; (6) Print as a markdown table with columns: Mois, Ventes TTC (MAD), Chèques NSFactory (MAD), Chèques NSMobili (MAD), Nb Articles, Surface MDF. All amounts formatted in MAD.
Inputs: commande_entete parquet, commande_lignes parquet, releve nsfactory parquet, releve nsmobili parquet
Outputs: Markdown table with monthly breakdown of sales vs cheques across both entities
Dependencies: none

Example 5 — for "Recherche dans le relevé et grand livre nsfactory le montant 15029" (SIMPLE LOOKUP across 2 sources — keep it simple):

STEP 1: Rechercher le montant 15029 dans le relevé et grand livre nsfactory
Description: Load data/releve_nsfactory_data.parquet and data/grand_livre_nsfactory_csv_data.parquet. For each source, search for the value 15029 in all numeric columns (Débit, Crédit, Montant Débit, Montant Crédit). Print matching rows with their source, date, libellé, and amounts as a markdown table. Keep the code short and focused — no reconciliation, no analysis sections, no recommendations.
Inputs: data/releve_nsfactory_data.parquet, data/grand_livre_nsfactory_csv_data.parquet
Outputs: Markdown table of matching rows with source indication
Dependencies: none

Example 6 — for "Donne le total du compte 44410000 en utilisant le grand livre nsfactory" (SIMPLE TOTAL — keep it simple):

STEP 1: Calculer le total du compte 44410000 du grand livre nsfactory
Description: Load data/grand_livre_nsfactory_csv_data.parquet. Filter rows where "Numéro de compte" == 44410000. Convert Débit and Crédit to numeric. Compute total Débit, total Crédit, and solde final. Print a summary line and list all matching entries as a markdown table. Keep the code short — no PCM analysis, no anomaly detection.
Inputs: data/grand_livre_nsfactory_csv_data.parquet
Outputs: Total débit, total crédit, solde, and detail table
Dependencies: none

Now decompose the given task into the minimum number of steps:
"""

    return prompt


def build_dependency_prompt(steps: List[Dict]) -> str:
    """
    Build prompt for analyzing step dependencies
    
    Args:
        steps: List of step descriptions
        
    Returns:
        Dependency analysis prompt
    """
    
    steps_text = "\n\n".join(
        f"STEP {i+1}: {step['description']}\n"
        f"Inputs: {', '.join(step.get('inputs', []))}\n"
        f"Outputs: {', '.join(step.get('outputs', []))}"
        for i, step in enumerate(steps)
    )
    
    prompt = f"""Analyze dependencies between these steps:

{steps_text}

For each step, identify:
1. Which previous steps it depends on (based on inputs/outputs)
2. Whether it can be parallelized with other steps
3. Critical path dependencies

Format:

STEP [number] depends on: [list of step numbers or 'none']
Can parallelize with: [list of step numbers or 'none']
On critical path: [yes/no]

Provide complete dependency analysis.
"""
    
    return prompt


def build_step_validation_prompt(
    step: Dict,
    context: Optional[Dict] = None
) -> str:
    """
    Build prompt for validating a step
    
    Args:
        step: Step to validate
        context: Optional context about the overall task
        
    Returns:
        Validation prompt
    """
    
    prompt = f"""Validate this task step:

Step Description: {step.get('description')}
Inputs: {', '.join(step.get('inputs', []))}
Outputs: {', '.join(step.get('outputs', []))}
"""
    
    if context:
        prompt += f"\nOverall Task: {context.get('original_query', '')}\n"
    
    prompt += """

Check:
1. Is the description clear and specific?
2. Are all inputs clearly defined?
3. Are outputs well-specified?
4. Is this step atomic (not too complex)?
5. Is it executable as a single code unit?
6. Are there any implicit dependencies?

Respond with:
VALID: [yes/no]
ISSUES: [list any problems found]
SUGGESTIONS: [improvements if needed]
"""
    
    return prompt


def build_step_merging_prompt(steps: List[Dict]) -> str:
    """
    Build prompt for identifying steps that can be merged
    
    Args:
        steps: List of steps
        
    Returns:
        Merging analysis prompt
    """
    
    steps_text = "\n\n".join(
        f"STEP {i+1}: {step['description']}"
        for i, step in enumerate(steps)
    )
    
    prompt = f"""Analyze these steps for potential merging:

{steps_text}

Identify steps that:
1. Operate on the same data
2. Have minimal intermediate outputs
3. Would be more efficient combined
4. Form a logical unit

Format:
MERGE: Steps [X, Y, Z] → [new combined description]
REASON: [why merging makes sense]

Suggest merges only when they improve clarity or efficiency.
"""
    
    return prompt


def build_complexity_estimation_prompt(
    step: Dict
) -> str:
    """
    Build prompt for estimating step complexity
    
    Args:
        step: Step to analyze
        
    Returns:
        Complexity estimation prompt
    """
    
    prompt = f"""Estimate the complexity of implementing this step:

Description: {step.get('description')}
Inputs: {', '.join(step.get('inputs', []))}
Outputs: {', '.join(step.get('outputs', []))}

Assess:
1. Code complexity: [simple/moderate/complex]
2. Data volume impact: [low/medium/high]
3. Computation intensity: [light/moderate/heavy]
4. Error-prone areas: [list any risky aspects]
5. Estimated lines of code: [range]

Format:
COMPLEXITY: [overall rating: simple/moderate/complex/very-complex]
CODE_SIZE: [estimated lines]
RISKS: [potential challenges]
EFFORT: [low/medium/high]
"""
    
    return prompt
