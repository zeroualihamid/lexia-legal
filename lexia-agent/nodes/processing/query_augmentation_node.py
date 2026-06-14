from pocketflow import Node
from llm.llm_factory import create_llm_client
from llm.prompts.query_augmentation import build_augmentation_prompt
from monitoring.logger import get_logger
import re

logger = get_logger(__name__)

class QueryAugmentationNode(Node):
    """Enhance query with conversation context"""
    
    def prep(self, shared):
        """Retrieve conversation history and available datasource names."""
        history = shared.get('conversation_history', [])
        datasources_meta = shared.get('datasources_metadata', {})
        source_names = sorted(datasources_meta.keys()) if datasources_meta else []
        return {
            'query': shared['user_query'],
            'history': history,
            'config': shared['config'],
            'source_names': source_names,
            'selected_skills': shared.get('selected_skills', []),
        }
    
    def exec(self, prep_result):
        """Use LLM to augment query with context, including full conversation turns."""
        llm = create_llm_client(prep_result['config'])

        history = prep_result.get('history', [])
        context = None
        if history:
            conversation_turns = [
                {'role': msg.get('role', 'user'), 'content': msg.get('content', '')}
                for msg in history
                if self._is_context_message_eligible(msg)
            ]
            context = {'conversation_turns': conversation_turns}

        prompt = build_augmentation_prompt(
            query=prep_result['query'],
            context=context,
            source_names=prep_result.get('source_names'),
            selected_skills=prep_result.get('selected_skills'),
        )
        response = llm.generate(prompt)

        if isinstance(response, str):
            response_text = response
        else:
            response_text = getattr(response, 'content', str(response))

        augmented_query = self._extract_enhanced_query(response_text) or prep_result['query']

        return augmented_query
    
    def post(self, shared, prep_res, exec_res):
        shared['augmented_query'] = exec_res
        logger.info(f"Augmented query: {exec_res}")
        return 'default'

    def _extract_enhanced_query(self, response_text: str) -> str:
        """Extract the self-contained query from the augmentation response."""
        if not response_text or not isinstance(response_text, str):
            return ""

        # Try multiple formats the LLM might use:
        # 1. "ENHANCED_QUERY: ..."
        # 2. "**ENHANCED_QUERY**\n> ..."  (markdown bold + blockquote)
        # 3. "ENHANCED_QUERY\n..."
        patterns = [
            r"ENHANCED[_ ]?QUERY\s*[:：]\s*(.+?)(?:\n\s*(?:[A-Z_]{3,}[\s:*]|\*\*[A-Z])|\Z)",
            r"\*{0,2}ENHANCED[_ ]?QUERY\*{0,2}\s*\n+\s*>?\s*[«\"']?\s*(.+?)(?:\n\s*(?:[A-Z_]{3,}[\s:*]|\*[^*])|\Z)",
        ]
        for pattern in patterns:
            match = re.search(pattern, response_text, re.IGNORECASE | re.DOTALL)
            if match:
                text = match.group(1).strip()
                text = re.sub(r'^[>«"\'\s]+', '', text)
                text = re.sub(r'[»"\'\s]+$', '', text)
                text = re.sub(r'\n>\s*', '\n', text)
                if len(text) > 20:
                    return text

        return ""

    def _is_context_message_eligible(self, message: dict) -> bool:
        """Keep only user-facing chat turns; drop workflow artifacts and system noise."""
        if not message or not message.get('content'):
            return False

        role = message.get('role')
        if role not in {'user', 'assistant'}:
            return False

        metadata = message.get('metadata') or {}
        if metadata.get('step_detail'):
            return False
        if metadata.get('workflow_execution'):
            return False
        if metadata.get('workflow_artifact'):
            return False

        return True
