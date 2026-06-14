"""
Chart Generation Prompts
=========================

Prompts for generating ECharts option JSON from tabular data.
"""

from typing import Optional


CHART_SYSTEM_PROMPT = (
    "You are a data visualization expert for Moroccan financial data. "
    "You generate ECharts option JSON configurations from tabular data. "
    "Rules: "
    "- Output ONLY valid JSON — no markdown fences, no explanation, no trailing commas. "
    "- Use French labels (e.g. Chiffre d'affaires, Année, Mois, Total). "
    "- Format monetary values with space thousands separator and 2 decimals (1 234 567,89 MAD). "
    "- Choose chart type based on data: time series → line, categories → bar, proportions → pie. "
    "- Use a professional color palette: ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4']. "
    "- Always include: title, tooltip, legend (if multiple series), xAxis/yAxis (for bar/line), series."
)


def build_chart_prompt(
    stdout: str,
    user_query: str,
    chart_hint: Optional[str] = None,
) -> str:
    """
    Build prompt for ECharts option generation from tabular stdout.

    Args:
        stdout: Markdown table output from sandbox execution
        user_query: Original user query for context
        chart_hint: Optional hint for chart type (bar, line, pie)

    Returns:
        Prompt string
    """
    hint_line = ""
    if chart_hint:
        hint_line = f"\nPreferred chart type: {chart_hint}\n"

    return f"""The user asked: "{user_query}"

The computation produced this data:
{stdout}
{hint_line}
Generate an ECharts option JSON object to visualize this data.

CRITICAL RULES:
1. The JSON must be directly usable by ReactECharts option prop — pure JSON, NO JavaScript functions.
2. NEVER use arrow functions, callback functions, or any JS code in the JSON. They will render as literal text.
3. For yAxis labels: DO NOT use a formatter function. Instead, just set yAxis.axisLabel to {{}}.  ECharts will auto-format numbers.
4. For tooltip: use simple string format like {{"trigger": "axis"}} — no formatter functions.
5. Store numeric values as raw numbers in series data (e.g. 3390628.33), NOT as formatted strings.
6. Include a concise French title summarizing the chart.
7. For bar/line charts: xAxis with category data, yAxis with value axis, series array.
8. For pie charts: series with data array of {{name, value}} objects.
9. Use the color palette: ["#5470c6","#91cc75","#fac858","#ee6666","#73c0de","#3ba272","#fc8452","#9a60b4"].
10. Wrap your answer in a JSON object with two keys: "chartType" (string: "bar", "line", or "pie") and "option" (the ECharts option object).

Output ONLY the JSON object. No markdown, no explanation."""
