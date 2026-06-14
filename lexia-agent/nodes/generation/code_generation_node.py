# nodes/generation/code_generation_node.py
"""
Code Generation Node
Generates Python code using LLM based on step requirements.
"""
import re
from datetime import date
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from textwrap import dedent

try:
    from ..base_node import BaseNode
except ImportError:
    from nodes.base_node import BaseNode

try:
    from ...monitoring.logger import get_logger
except ImportError:
    from monitoring.logger import get_logger

from skill_registry import build_selected_skills_context, resolve_skill

logger = get_logger(__name__)

_ANALYTICAL_KEYWORDS = re.compile(
    r"(?i)\b("
    r"analyse|analyser|analytique|diagnostic|rapport|synthèse|synthese|audit"
    r"|bilan|plan comptable|PCM|états de synthèse|etats de synthese"
    r"|expert[- ]?comptab|professionnel|approfondi|détaillé|detaille"
    r"|recommandation|observation|anomalie|alerte|classe\s+\d"
    r"|rapprochement|réconciliation|reconciliation"
    r")\b"
)

# Queries matching these patterns are simple lookups/searches even if they mention
# data-source names like "grand livre" or "relevé".  They should NOT trigger
# analytical mode.
_SIMPLE_QUERY_PATTERN = re.compile(
    r"(?i)\b("
    r"recherche[rz]?|cherche[rz]?|trouver?|filtrer?|retrouver?"
    r"|montant|total\b|somme|solde\s+du\s+compte|donner?\s+le\s+total"
    r"|combien|quel\s+est|liste[rz]?"
    r"|écritures?\s+du\s+compte|compte\s+\d"
    r")\b"
)


@dataclass
class GeneratedCode:
    """Result of code generation"""
    code: str
    step_id: str
    attempt: int
    prompt_used: str
    model_used: str
    token_usage: Dict[str, int] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {k: v for k, v in self.__dict__.items()}


class CodeGenerationNode(BaseNode):
    """
    Generates Python code using LLM.

    Builds a detailed prompt from step requirements, calls the LLM,
    extracts the code block, and retries on failure.

    Routes:
    - default:          Code generated successfully
    - generation_failed: Max attempts reached with no valid code
    """

    MAX_ATTEMPTS = 3

    def __init__(self, **kwargs):
        super().__init__(name="CodeGeneration", **kwargs)
        self.logger = logger

    def prep(self, shared: Dict) -> Dict:
        # Use step_requirements from step_router/graph_search when set; otherwise derive from
        # current plan step so we always generate code according to PlanDecompositionNode steps
        requirements = shared.get('step_requirements')
        if not requirements and shared.get('plan_steps'):
            current_index = shared.get('current_step_index', 0)
            plan_steps = shared['plan_steps']
            if 0 <= current_index < len(plan_steps):
                from nodes.utils.step_requirements import plan_step_to_requirements
                requirements = plan_step_to_requirements(plan_steps[current_index], current_index)
                shared['step_requirements'] = requirements
                self.logger.info(
                    f"Derived step_requirements from plan step {current_index + 1}: "
                    f"{requirements.get('description', '')[:50]}..."
                )
        requirements = requirements or {}
        attempt = shared.get('generation_attempts', 0)
        feedback = shared.get('generation_feedback', None)
        config = shared.get('config')

        return {
            'requirements': requirements,
            'attempt': attempt,
            'feedback': feedback,
            'config': config,
            'session_id': shared.get('session_id', ''),
            'schemas': shared.get('schemas', {}),
            'datasources_metadata': shared.get('datasources_metadata', {}),
            'domain_code_prompt': shared.get('domain_code_prompt', ''),
            'domain_system_prompt': shared.get('domain_system_prompt', ''),
            'selected_skills': shared.get('selected_skills', []),
            'user_query': shared.get('user_query', ''),
            'augmented_query': shared.get('augmented_query', ''),
        }

    def exec(self, prep_result: Dict) -> Optional[GeneratedCode]:
        requirements = prep_result['requirements']
        attempt = prep_result['attempt']
        feedback = prep_result['feedback']
        config = prep_result['config']
        selected_skill_defs = [
            skill for name in prep_result.get('selected_skills', [])
            if (skill := resolve_skill(name)) is not None
        ]
        selected_skill_names = [skill.directory_name for skill in selected_skill_defs]

        step_id = requirements.get('step_id', 'step-0')
        description = requirements.get('description', '')
        is_analytical = bool(
            _ANALYTICAL_KEYWORDS.search(description)
            and not _SIMPLE_QUERY_PATTERN.search(description)
        )
        logger.info(
            f"Generating code for {step_id} (attempt {attempt + 1}/{self.MAX_ATTEMPTS})"
            f"{' [ANALYTICAL]' if is_analytical else ''}"
        )

        deterministic_code = self._maybe_generate_skill_code(
            requirements=requirements,
            selected_skills=selected_skill_defs,
            datasources_metadata=prep_result.get('datasources_metadata', {}),
            user_query=prep_result.get('user_query', ''),
            augmented_query=prep_result.get('augmented_query', ''),
            step_id=step_id,
            attempt=attempt,
        )
        if deterministic_code:
            return deterministic_code

        prompt = self._build_prompt(
            requirements, feedback,
            schemas=prep_result.get('schemas', {}),
            datasources_metadata=prep_result.get('datasources_metadata', {}),
            is_analytical=is_analytical,
            selected_skill_names=selected_skill_names,
            selected_skills_context=build_selected_skills_context(
                selected_skill_defs,
                include_full_content=True,
            ),
        )

        try:
            from llm.llm_factory import create_client_for_task
            client = create_client_for_task('code_generation', config=config)
            today = date.today().isoformat()

            domain_sys = prep_result.get('domain_system_prompt', '')
            domain_sys_prefix = f"{domain_sys}\n\n" if domain_sys else ""

            domain_code = prep_result.get('domain_code_prompt', '')
            if domain_code:
                prompt = f"{domain_code}\n\n{prompt}"

            system_prompt = self._build_system_prompt(
                today,
                domain_sys_prefix,
                is_analytical,
                dashboard_html_mode="dashboard_html" in selected_skill_names,
            )

            response = client.generate(prompt, system=system_prompt)

            raw = response.content
            if raw:
                preview = raw[:600].replace('\n', '\\n')
                logger.debug(f"LLM raw response (first 600 chars): {preview}")
            code = self._extract_code(raw)

            if not code:
                logger.warning(
                    f"LLM response contained no code block "
                    f"(response length: {len(raw) if raw else 0} chars, "
                    f"starts with: {repr(raw[:120]) if raw else 'empty'})"
                )
                return None

            return GeneratedCode(
                code=code,
                step_id=step_id,
                attempt=attempt + 1,
                prompt_used=prompt,
                model_used=response.model,
                token_usage=response.usage,
                metadata={'session_id': prep_result['session_id']}
            )

        except Exception as e:
            logger.error(f"Code generation failed: {e}")
            return None

    @staticmethod
    def _build_system_prompt(
        today: str,
        domain_prefix: str,
        is_analytical: bool,
        dashboard_html_mode: bool = False,
    ) -> str:
        from prompt_loader import render_template, load_template

        common = render_template(
            "generation", "code_generation_system",
            domain_prefix=domain_prefix,
            today=today,
        )

        if dashboard_html_mode:
            return common + " " + load_template("generation", "code_generation_system_dashboard")

        if is_analytical:
            return common + " " + load_template("generation", "code_generation_system_analytical")

        return common + " " + load_template("generation", "code_generation_system_simple")

    def post(self, shared: Dict, prep_result: Dict, exec_result: Optional[GeneratedCode]) -> str:
        attempt = prep_result['attempt'] + 1
        shared['generation_attempts'] = attempt

        if exec_result:
            shared['last_generated_code'] = exec_result.code
            shared['generated_code_meta'] = exec_result.to_dict()
            shared['generation_feedback'] = None
            logger.info(f"✓ Code generated ({len(exec_result.code)} chars)")

            return 'generated'

        if attempt >= self.MAX_ATTEMPTS:
            logger.error(f"Generation failed after {self.MAX_ATTEMPTS} attempts")
            return 'generation_failed'

        logger.warning(f"Attempt {attempt} failed, retrying...")
        return 'default'

    # -------------------------------------------------------------------------

    def _build_prompt(
        self,
        requirements: Dict,
        feedback: Optional[Dict],
        schemas: Optional[Dict] = None,
        datasources_metadata: Optional[Dict] = None,
        is_analytical: bool = False,
        selected_skill_names: Optional[List[str]] = None,
        selected_skills_context: str = "",
    ) -> str:
        description = requirements.get('description', '')
        title = requirements.get('title', '')
        inputs = requirements.get('inputs', [])
        outputs = requirements.get('outputs', [])
        constraints = requirements.get('constraints', [])
        libraries = requirements.get('libraries', [])
        complexity = requirements.get('complexity', 'moderate')

        inputs_text = '\n'.join(
            f"  - {i.get('name', '?')}: {i.get('type', 'Any')} "
            f"(from {i.get('source', 'caller')})"
            for i in inputs
        ) or "  - None declared"

        outputs_text = '\n'.join(
            f"  - {o.get('name', '?')}: {o.get('type', 'Any')}"
            for o in outputs
        ) or "  - Return result"

        constraints_text = '\n'.join(f"  - {c}" for c in constraints) or "  - None"
        libs_text = ', '.join(libraries) if libraries else 'standard library'
        dashboard_html_mode = "dashboard_html" in set(selected_skill_names or [])

        datasource_context = self._format_datasource_context(schemas or {}, datasources_metadata or {})

        task_header = f"Step: {title}\n\n" if title else ""
        prompt = f"""Generate Python code for the following task:

{task_header}TASK: {description}
COMPLEXITY: {complexity}
"""
        if datasource_context:
            prompt += f"""
AVAILABLE DATA SOURCES (from config/datasources.yaml — use ONLY these exact paths):
{datasource_context}

CRITICAL: Parquet paths are defined in config/datasources.yaml. Use the path values above verbatim.
Do NOT invent, guess, or construct paths. If a source is listed, use its path exactly as shown.
"""

        if selected_skills_context:
            prompt += f"""
SELECTED SKILL INSTRUCTIONS:
The user explicitly requested the following skill(s). Reuse their workflow, logic, and output structure.
{selected_skills_context}
"""

        prompt += f"""
INPUTS:
{inputs_text}

EXPECTED OUTPUTS:
{outputs_text}

CONSTRAINTS:
{constraints_text}

PREFERRED LIBRARIES: {libs_text}

AVAILABLE PYTHON LIBRARIES (ONLY use these — do NOT import anything else):
- pandas, numpy, matplotlib (with Agg backend), tabulate
- Standard library modules (os, sys, datetime, json, math, re, pathlib, etc.)

REQUIREMENTS:
1. Complete, executable Python code
2. Import all required libraries
3. Use the EXACT parquet paths from AVAILABLE DATA SOURCES above (from config/datasources.yaml)
4. ONLY use column names that are listed above — NEVER invent or guess column names
5. NEVER use single quotes inside f-string expressions that are delimited by single quotes — use double quotes or bracket notation
"""

        if dashboard_html_mode:
            prompt += """
HTML DASHBOARD ARTIFACT REQUIREMENTS:
- Generate a standalone HTML dashboard file, not only a stdout answer.
- Import and use `from prompts.skills.dashboard_html.report_builder import write_dashboard_html`.
- The visual structure MUST come from the BI templates in `brikz-agent/template/bi-dashboard-template.html` and `.css` via that helper.
- Organize the dashboard with a title, a short subtitle, KPI cards, at least one chart when the data supports it, and at least one table or insights block.
- Charts must be passed to the helper as JSON-serializable ECharts `option` dictionaries.
- Save the report under a deterministic local path such as `data/subagents/dashboard/html_reports/<slug>.html`.
- Print a concise French summary to stdout, then print a final line exactly formatted as:
  HTML_REPORT_PATH: /absolute/path/to/report.html
"""

        if is_analytical:
            prompt += """
ANALYTICAL REPORT REQUIREMENTS:
The user requests a comprehensive professional analysis. The code must produce a DETAILED, STRUCTURED report:

1. The output must be a MULTI-SECTION report with numbered sections, each containing:
   - A section title (e.g. "## 1. Cadre Général", "## 2. Analyse par Classe du PCM")
   - A formatted table (use tabulate with 'grid' or 'pipe' format, or manual | separators)
   - Professional observations, alerts, and remarks after each table
2. Account numbers must be mapped to their Plan Comptable Marocain (PCM) labels when applicable
3. Flag anomalies explicitly (negative cash, missing depreciation, unusual balances, fiscal risks)
4. End with a "Synthèse et Recommandations" section containing:
   - A summary KPI table (result net, ratios, key balances, risk indicators)
   - Numbered, actionable recommendations prioritized by importance
5. Use professional accounting terminology in French
6. DO NOT abbreviate or truncate — show ALL relevant data, ALL observations
7. Format amounts: "1 234 567,89 MAD" (space thousands, comma decimal)
8. The code may be long — that is expected and desired for thorough analysis
9. Use helper functions to keep the code organized (e.g. fmt_mad() for formatting, classify_account() for PCM class)

IF THE QUERY IS ABOUT ACCOUNTING ANALYSIS (grand livre, bilan):
- Cadre Général (period, entries, accounts, journals, balance verification)
- Analyse par Classe du PCM (classes 1-7: debit, credit, balance)
- Detail per class (accounts, labels, balances, observations)
- Alertes et Anomalies
- Synthèse et Recommandations

IF THE QUERY IS ABOUT BANK RECONCILIATION (rapprochement bancaire):
- Données Sources (overview: row counts, totals for bank statement and GL)
- Taux de Rapprochement (match by amount+date, report match rate %)
- Suspens Identifiés (unmatched operations in each direction, with date/amount/nature)
- État de Rapprochement Formel (bank balance → add/subtract suspens → GL balance → residual gap)
- Anomalies Détectées (critical issues with severity and recommendation)
- Synthèse et Recommandations
"""
        else:
            prompt += """
6. Print the final answer to stdout — not data exploration or debug output
7. Keep the code focused — load data, compute, print result
8. For markdown tables, use manual print with | separators OR df.to_markdown(index=False)

OUTPUT FORMATTING (MANDATORY):
- All monetary amounts MUST be in Moroccan Dirham (MAD). Format: "1 234 567,89 MAD" (space-separated thousands, comma decimal, MAD suffix)
- Use French for labels and headers (e.g. "Chiffre d'affaires", "Année", "Total HT", "Total TTC")
- Print results as a clean MARKDOWN TABLE when multiple rows (use | column | separators with header line)
- For single values, print a clear labeled line: "**Chiffre d'affaires 2025:** 1 234 567,89 MAD"
- Always include a short title/header line before the data
- If the query asks for yearly/monthly breakdown, ALWAYS sort by date ascending
"""

        if feedback:
            errors = '\n'.join(f"  - {e}" for e in feedback.get('errors', []))
            prompt += f"""
⚠ PREVIOUS ATTEMPT HAD ISSUES - FIX THESE:
{errors}
"""

        prompt += """
RESPOND WITH ONLY A ```python ... ``` CODE BLOCK. NO explanations, NO text outside the code block.
The code must be complete and executable. Start with imports, end with print statements.

```python
# Your complete Python code here
```"""
        return prompt

    def _maybe_generate_skill_code(
        self,
        requirements: Dict[str, Any],
        selected_skills: List[Any],
        datasources_metadata: Dict[str, Any],
        user_query: str,
        augmented_query: str,
        step_id: str,
        attempt: int,
    ) -> Optional[GeneratedCode]:
        skill_names = {skill.directory_name for skill in selected_skills}
        query_text = f"{user_query}\n{augmented_query}\n{requirements.get('description', '')}".lower()
        if "fiscaliste" not in skill_names:
            return None
        if "grand livre" not in query_text:
            return None
        if "cpc" not in query_text and "bilan" not in query_text and "compte de resultat" not in query_text:
            return None

        grand_livre_path = ""
        for source_id, metadata in (datasources_metadata or {}).items():
            if "grand_livre_nsfactory" in source_id:
                grand_livre_path = metadata.get("path", "")
                if grand_livre_path:
                    break
        if not grand_livre_path:
            grand_livre_path = "data/grand_livre_nsfactory_csv_data.parquet"

        code = dedent(
            f"""
            from prompts.skills.fiscaliste.analyse_grand_livre import generate_previsional_report_from_file

            if __name__ == "__main__":
                report = generate_previsional_report_from_file(
                    filepath="{grand_livre_path}",
                    company_label="NSFactory",
                )
                print(report)
            """
        ).strip()

        return GeneratedCode(
            code=code,
            step_id=step_id,
            attempt=attempt + 1,
            prompt_used="deterministic-fiscaliste-runtime",
            model_used="local-skill-runtime",
            token_usage={},
            metadata={"selected_skills": sorted(skill_names)},
        )

    def _format_datasource_context(self, schemas: Dict, datasources_metadata: Dict) -> str:
        """Format datasource paths, columns with descriptions for the code generation prompt."""
        if not datasources_metadata and not schemas:
            return ''

        source_ids = sorted(set(datasources_metadata.keys()) | set(schemas.keys()))
        sections = []
        for sid in source_ids:
            info = datasources_metadata.get(sid, {})
            path = info.get('path', '')
            desc = info.get('description', '')
            ctx = info.get('business_context', '')
            parts = [f"  {sid}:"]
            if path:
                parts.append(f"    path: {path}")
            if desc:
                parts.append(f"    description: {desc}")
            if ctx:
                parts.append(f"    context: {ctx}")
            schema_obj = schemas.get(sid)
            if schema_obj is not None:
                columns = getattr(schema_obj, 'columns', None)
                if columns:
                    parts.append("    columns:")
                    for c in columns:
                        name = getattr(c, 'column_name', getattr(c, 'name', str(c)))
                        typ = getattr(c, 'type', getattr(c, 'data_type', '?'))
                        col_desc = getattr(c, 'description', '')
                        if col_desc:
                            parts.append(f"      - {name} ({typ}): {col_desc}")
                        else:
                            parts.append(f"      - {name} ({typ})")
            sections.append('\n'.join(parts))
        return '\n'.join(sections)

    @staticmethod
    def build_prompts_for_user_request(
        user_request: str,
        schemas: Dict,
        datasources_metadata: Dict,
        domain_system_prompt: str = "",
        domain_code_prompt: str = "",
        is_analytical: bool = False,
        feedback: Optional[Dict] = None,
    ) -> tuple[str, str]:
        """
        Build (user_prompt, system_prompt) for a single user request (e.g. card creation).
        Uses the same logic as the main CodeGenerationNode so subagents respond like main chat.
        """
        from datetime import date

        requirements = {
            "step_id": "card-step-1",
            "description": user_request,
            "title": (user_request[:50] + "..." if len(user_request) > 50 else user_request),
            "inputs": [],
            "outputs": [{"name": "result", "type": "Any"}],
            "constraints": [],
            "libraries": ["pandas"],
            "complexity": "moderate",
        }
        node = CodeGenerationNode()
        prompt = node._build_prompt(
            requirements, feedback,
            schemas=schemas,
            datasources_metadata=datasources_metadata,
            is_analytical=is_analytical,
        )
        if domain_code_prompt:
            prompt = f"{domain_code_prompt}\n\n{prompt}"

        domain_sys_prefix = f"{domain_system_prompt}\n\n" if domain_system_prompt else ""
        system_prompt = CodeGenerationNode._build_system_prompt(
            date.today().isoformat(), domain_sys_prefix, is_analytical
        )
        return prompt, system_prompt

    def _extract_code(self, text: str) -> str:
        """Extract Python code from LLM response, trying multiple strategies."""
        if not text or not text.strip():
            return ''

        # Strategy 1: ```python ... ``` block
        match = re.search(r'```python\s*(.*?)```', text, re.DOTALL)
        if match and match.group(1).strip():
            return match.group(1).strip()

        # Strategy 2: ```py ... ``` block
        match = re.search(r'```py\s*(.*?)```', text, re.DOTALL)
        if match and match.group(1).strip():
            return match.group(1).strip()

        # Strategy 3: plain ``` ... ``` block containing Python-like code
        match = re.search(r'```\s*(.*?)```', text, re.DOTALL)
        if match:
            block = match.group(1).strip()
            if block and re.search(r'\b(import |from |print\(|pd\.|def |for |if )', block):
                return block

        # Strategy 4: whole response looks like code (starts with imports/comments)
        stripped = text.strip()
        if stripped.startswith(('import ', 'from ', 'def ', 'class ', '# ', '#!/')):
            return stripped

        # Strategy 5: extract the largest contiguous code-like block from the response
        # Look for lines that look like Python code (imports, assignments, function calls)
        lines = text.split('\n')
        code_lines = []
        in_code = False
        for line in lines:
            sline = line.strip()
            is_code_line = bool(re.match(
                r'^(import |from |def |class |if |elif |else:|for |while |try:|except |'
                r'with |return |print\(|#|[a-zA-Z_]\w*\s*[=\(]|'
                r'\s+(import |from |def |if |elif |else:|for |while |return |print|#|[a-zA-Z_]))',
                line
            )) or (in_code and (sline == '' or line.startswith((' ', '\t'))))
            if is_code_line:
                code_lines.append(line)
                in_code = True
            elif in_code and sline == '':
                code_lines.append(line)
            else:
                if len(code_lines) >= 5:
                    break
                if not code_lines or len(code_lines) < 3:
                    code_lines = []
                    in_code = False

        if len(code_lines) >= 5:
            code = '\n'.join(code_lines).strip()
            if re.search(r'\b(import |print\()', code):
                return code

        return ''
