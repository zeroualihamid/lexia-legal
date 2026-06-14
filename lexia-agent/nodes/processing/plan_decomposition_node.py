from pocketflow import Node
from llm.llm_factory import create_llm_client
from llm.prompts.task_decomposition import build_decomposition_prompt
from monitoring.logger import get_logger
import re
import unicodedata
import json
from typing import List, Dict, Any
from skill_registry import build_selected_skills_context, resolve_skill

logger = get_logger(__name__)

class PlanDecompositionNode(Node):
    """Break complex query into executable steps. Uses schemas from SchemaLoaderNode when present."""

    def prep(self, shared):
        query = shared.get('augmented_query') or shared.get('user_query', '')
        schemas = shared.get('schemas', {})

        return {
            'query': query,
            'config': shared['config'],
            'schemas': schemas,
            'datasources_metadata': shared.get('datasources_metadata', {}),
            'domain_system_prompt': shared.get('domain_system_prompt', ''),
            'selected_skills': shared.get('selected_skills', []),
        }

    def exec(self, prep_res):
        """Decompose into steps using LLM, with schema context from SchemaLoaderNode."""
        llm = create_llm_client(prep_res['config'])

        domain_preamble = prep_res.get('domain_system_prompt', '')
        selected_skill_defs = [
            skill for name in prep_res.get('selected_skills', [])
            if (skill := resolve_skill(name)) is not None
        ]

        prompt = build_decomposition_prompt(
            prep_res['query'],
            schemas=prep_res.get('schemas'),
            datasources_metadata=prep_res.get('datasources_metadata'),
            selected_skills_context=build_selected_skills_context(selected_skill_defs),
        )
        if domain_preamble:
            prompt = f"[DOMAIN CONTEXT]\n{domain_preamble}\n\n{prompt}"

        from prompt_loader import load_template
        prompt += "\n\n" + load_template("generation", "plan_decomposition_suffix")
        
        # LLM returns JSON with steps
        response = llm.generate(prompt)
        
        # Handle LLMResponse object or string
        if isinstance(response, str):
            response_text = response
        else:
            response_text = getattr(response, 'content', str(response))
        
        # Check if LLM returned a direct answer (no code needed)
        direct_answer = self._extract_direct_answer(response_text)
        if direct_answer:
            logger.info("LLM returned a direct answer (no data computation needed)")
            return {
                'steps': [],
                'keyword_filters': [],
                'direct_answer': direct_answer,
            }

        keyword_filters = self._extract_filter_tuples_from_llm(response_text)
        steps = self._parse_steps(response_text)
        
        return {
            'steps': steps,
            'keyword_filters': keyword_filters,
        }
    
    def post(self, shared, prep_res, exec_res):
        # Handle None or empty exec_res safely
        if not exec_res:
            logger.warning("Plan decomposition returned no steps")
            shared['plan_steps'] = []
            shared['current_step_index'] = 0
            shared['keyword_column_tuples'] = []
            shared['keyword_column_filters'] = []
            shared['embedding_search_filters'] = {}
            return 'default'

        # Direct answer path — no code generation needed
        direct_answer = exec_res.get('direct_answer') if isinstance(exec_res, dict) else None
        if direct_answer:
            shared['plan_steps'] = []
            shared['current_step_index'] = 0
            shared['direct_answer'] = direct_answer
            shared['keyword_column_tuples'] = []
            shared['keyword_column_filters'] = []
            shared['embedding_search_filters'] = {}
            logger.info("Routing to direct_answer (no data steps)")
            return 'direct_answer'

        steps = exec_res.get('steps', []) if isinstance(exec_res, dict) else []
        shared['plan_steps'] = steps
        shared['current_step_index'] = 0
        shared['selected_skills'] = shared.get('selected_skills', []) or prep_res.get('selected_skills', [])

        keyword_filters = exec_res.get('keyword_filters', []) if isinstance(exec_res, dict) else []
        keyword_filters = keyword_filters or []
        keyword_tuples = [(item['keyword'], item['column_name']) for item in keyword_filters]
        embedding_search_filters = self._to_embedding_search_filters(keyword_filters)

        shared['keyword_column_tuples'] = keyword_tuples
        shared['keyword_column_filters'] = keyword_filters
        shared['embedding_search_filters'] = embedding_search_filters

        if keyword_tuples:
            logger.info(
                "Extracted keyword/column filters: "
                f"{', '.join([f'({k}, {c})' for k, c in keyword_tuples])}"
            )
        logger.info(f"Plan created with {len(steps)} steps")
        return 'default'
    
    def _parse_steps(self, llm_response: str) -> List[Dict[str, Any]]:
        """
        Parse LLM response into structured steps.
        
        Expected format:
        STEP [number]: [title]
        Description: [description]
        Inputs: [inputs]
        Outputs: [outputs]
        Dependencies: [dependencies]
        """
        if not llm_response or not isinstance(llm_response, str):
            logger.warning("Empty or invalid LLM response for decomposition")
            return []
        
        steps = []
        
        # Split by STEP markers
        step_blocks = re.split(r'\n(?=STEP\s+\d+:)', llm_response)
        
        for block in step_blocks:
            if not block.strip() or not block.strip().startswith('STEP'):
                continue
            
            # Parse step number and title
            first_line_match = re.match(r'STEP\s+(\d+):\s*(.+)', block)
            if not first_line_match:
                continue
            
            step_num = int(first_line_match.group(1))
            title = first_line_match.group(2).strip()
            
            # Extract fields
            description = self._extract_field(block, 'Description')
            inputs = self._extract_field(block, 'Inputs')
            outputs = self._extract_field(block, 'Outputs')
            dependencies = self._extract_field(block, 'Dependencies')
            
            step = {
                'step_number': step_num,
                'title': title,
                'description': description or title,
                'inputs': self._parse_list_field(inputs),
                'outputs': self._parse_list_field(outputs),
                'dependencies': self._parse_dependencies(dependencies),
            }
            
            steps.append(step)
            logger.debug(f"Parsed step {step_num}: {title}")
        
        if not steps:
            logger.warning("Could not parse structured steps, creating single step")
            clean_desc = self._strip_metadata(llm_response)
            steps = [{
                'step_number': 1,
                'title': 'Execute query',
                'description': clean_desc,
                'inputs': [],
                'outputs': [],
                'dependencies': [],
            }]
        
        return steps
    
    def _extract_field(self, block: str, field_name: str) -> str:
        """Extract a field value from a step block."""
        pattern = rf'{field_name}:\s*(.+?)(?:\n[A-Z][a-z]+:|$)'
        match = re.search(pattern, block, re.IGNORECASE | re.DOTALL)
        return match.group(1).strip() if match else ''
    
    def _parse_list_field(self, text: str) -> List[str]:
        """Parse comma or newline-separated list."""
        if not text:
            return []
        # Split by comma or newline, clean up
        items = re.split(r'[,\n]', text)
        return [item.strip() for item in items if item.strip()]
    
    def _parse_dependencies(self, text: str) -> List[int]:
        """Parse dependency step numbers."""
        if not text or text.lower() in ('none', 'n/a', '-'):
            return []
        # Extract numbers
        nums = re.findall(r'\d+', text)
        return [int(n) for n in nums]

    def _extract_direct_answer(self, llm_response: str) -> str:
        """Extract a direct text answer from <DIRECT_ANSWER>...</DIRECT_ANSWER> block."""
        if not llm_response or not isinstance(llm_response, str):
            return ''
        match = re.search(
            r'<DIRECT_ANSWER>\s*(.*?)\s*</DIRECT_ANSWER>',
            llm_response,
            re.IGNORECASE | re.DOTALL,
        )
        return match.group(1).strip() if match else ''

    def _extract_filter_tuples_from_llm(self, llm_response: str) -> List[Dict[str, Any]]:
        """Extract filter tuples emitted by LLM in <FILTER_TUPLES_JSON> block."""
        if not llm_response or not isinstance(llm_response, str):
            return []

        match = re.search(
            r"<FILTER_TUPLES_JSON>\s*(\{.*?\})\s*</FILTER_TUPLES_JSON>",
            llm_response,
            re.IGNORECASE | re.DOTALL,
        )
        if not match:
            logger.info("No FILTER_TUPLES_JSON block found in decomposition response")
            return []

        try:
            payload = json.loads(match.group(1))
        except Exception as e:
            logger.warning(f"Invalid FILTER_TUPLES_JSON payload: {e}")
            return []

        tuples = payload.get("filter_tuples", [])
        if not isinstance(tuples, list):
            return []

        out: List[Dict[str, Any]] = []
        for item in tuples:
            if not isinstance(item, dict):
                continue
            keyword = self._normalize_text(item.get("keyword", ""))
            column_name = item.get("categorical_column") or item.get("column_name") or ""
            source_id = item.get("source_id", "")
            if not keyword or not column_name:
                continue
            out.append({
                "keyword": keyword,
                "column_name": str(column_name).strip(),
                "source_id": str(source_id).strip(),
                "score": 1.0,  # LLM-selected; keep a neutral score for downstream compatibility
            })

        return out

    def _to_embedding_search_filters(
        self,
        keyword_filters: List[Dict[str, Any]],
    ) -> Dict[str, List[str]]:
        """Convert keyword/column pairs into {column_name: [keywords...]}."""
        filters: Dict[str, List[str]] = {}
        for item in keyword_filters:
            column_name = item.get('column_name')
            keyword = item.get('keyword')
            if not column_name or not keyword:
                continue
            filters.setdefault(column_name, [])
            if keyword not in filters[column_name]:
                filters[column_name].append(keyword)
        return filters

    @staticmethod
    def _strip_metadata(text: str) -> str:
        """Remove LLM metadata blocks that shouldn't be in a step description."""
        text = re.sub(
            r"<FILTER_TUPLES_JSON>.*?</FILTER_TUPLES_JSON>",
            "",
            text,
            flags=re.DOTALL | re.IGNORECASE,
        )
        text = re.sub(
            r"<DIRECT_ANSWER>.*?</DIRECT_ANSWER>",
            "",
            text,
            flags=re.DOTALL | re.IGNORECASE,
        )
        text = text.strip()
        if len(text) > 2000:
            text = text[:2000]
        return text or "Execute the user query against the available data sources"

    def _normalize_text(self, text: str) -> str:
        if text is None:
            return ''
        if not isinstance(text, str):
            text = str(text)
        text = unicodedata.normalize('NFKD', text)
        text = ''.join(ch for ch in text if not unicodedata.combining(ch))
        return re.sub(r'\s+', ' ', text.strip().lower())
