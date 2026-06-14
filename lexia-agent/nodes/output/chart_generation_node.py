"""
Chart Generation Node
Generates ECharts option JSON from tabular sandbox output using LLM.

Placed between SandboxExecutionNode and ConversationUpdateNode.
If successful execution produced a markdown table, this node asks the LLM
to create an ECharts visualization config. The result is stored in
shared['chart_data'] and emitted as an SSE chart_data event.

Non-blocking: if chart generation fails the workflow continues normally.
"""

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)

_TABLE_PATTERN = re.compile(r"\|.*\|.*\n\|[\s\-:|]+\|", re.MULTILINE)
_JS_FUNC_PATTERN = re.compile(
    r"^\s*(?:function\s*\(|(?:\([\w,\s]*\)|\w+)\s*=>)", re.MULTILINE
)


def _strip_js_functions(obj: Any) -> None:
    """Recursively remove string values that look like JS functions from a dict/list.
    ReactECharts cannot evaluate function strings — they render as literal text."""
    if isinstance(obj, dict):
        keys_to_delete = []
        for k, v in obj.items():
            if isinstance(v, str) and _JS_FUNC_PATTERN.search(v):
                keys_to_delete.append(k)
            else:
                _strip_js_functions(v)
        for k in keys_to_delete:
            del obj[k]
    elif isinstance(obj, list):
        for item in obj:
            _strip_js_functions(item)


def _has_markdown_table(text: str) -> bool:
    return bool(_TABLE_PATTERN.search(text))


def _find_tabular_stdout(step_results: List[Dict]) -> Optional[str]:
    """Return stdout from the last successful step that contains a markdown table."""
    for step in reversed(step_results):
        if not step.get("final_success", False):
            continue
        stdout = (step.get("stdout") or "").strip()
        if stdout and _has_markdown_table(stdout):
            return stdout
    return None


class ChartGenerationNode(BaseNode):
    """
    Generate an ECharts option from tabular execution output.

    Routes:
        default  – always (chart generation is best-effort)
    """

    def __init__(self, **kwargs):
        super().__init__(name="ChartGeneration", **kwargs)
        self.logger = logger

    def prep(self, shared: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self.log_entry(shared)

        step_results = shared.get("step_results", [])
        tabular_stdout = _find_tabular_stdout(step_results)

        if not tabular_stdout:
            self.logger.info("No tabular output found — skipping chart generation")
            return None

        return {
            "stdout": tabular_stdout,
            "user_query": shared.get("user_query", ""),
            "config": shared.get("config"),
        }

    def exec(self, prep_result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if prep_result is None:
            return None

        stdout = prep_result["stdout"]
        user_query = prep_result["user_query"]
        config = prep_result["config"]

        self.logger.info("Generating ECharts config from tabular output")

        try:
            from llm.llm_factory import create_client_for_task
            from llm.prompts.chart_generation import build_chart_prompt, CHART_SYSTEM_PROMPT

            client = create_client_for_task("code_generation", config=config)
            prompt = build_chart_prompt(stdout, user_query)
            response = client.generate(prompt, system=CHART_SYSTEM_PROMPT)
            raw = response.content.strip()

            # Strip markdown fences if the LLM wrapped the JSON
            if raw.startswith("```"):
                raw = re.sub(r"^```\w*\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)

            chart_obj = json.loads(raw)

            chart_type = chart_obj.get("chartType", "bar")
            option = chart_obj.get("option")
            if not option or not isinstance(option, dict):
                self.logger.warning("LLM returned JSON without a valid 'option' key")
                return None

            _strip_js_functions(option)

            self.logger.info(f"Chart generated: type={chart_type}")
            return {
                "chartType": chart_type,
                "option": option,
                "query": user_query,
            }

        except json.JSONDecodeError as e:
            self.logger.warning(f"Chart generation returned invalid JSON: {e}")
            return None
        except Exception as e:
            self.logger.warning(f"Chart generation failed (non-blocking): {e}")
            return None

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Any,
        exec_result: Optional[Dict[str, Any]],
    ) -> str:
        if exec_result:
            chart_id = f"chart-{uuid.uuid4().hex[:8]}"
            shared["chart_data"] = {
                "chartId": chart_id,
                "chartType": exec_result["chartType"],
                "option": exec_result["option"],
                "query": exec_result["query"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            self.logger.info(f"Stored chart_data with id={chart_id}")
        else:
            self.logger.info("No chart data produced — continuing without chart")

        self.log_exit("default")
        return "default"
