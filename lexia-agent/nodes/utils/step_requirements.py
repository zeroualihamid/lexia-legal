"""
Convert plan steps (from PlanDecompositionNode) to step_requirements format
expected by CodeGenerationNode and other generation nodes.
"""

from typing import Dict, Any, List


def plan_step_to_requirements(step: Dict[str, Any], step_index: int = 0) -> Dict[str, Any]:
    """
    Convert a plan step from PlanDecompositionNode to step_requirements format.

    Plan step has: step_number, title, description, inputs (list of strings),
    outputs (list of strings), dependencies.
    step_requirements needs: step_id, description, inputs ([{name, type, source}]),
    outputs ([{name, type}]), constraints, libraries, complexity.
    """
    if not step:
        return _empty_requirements(step_index)

    inputs_raw = step.get("inputs") or []
    outputs_raw = step.get("outputs") or []

    inputs: List[Dict[str, Any]] = []
    for i in inputs_raw:
        if isinstance(i, str):
            inputs.append({"name": i, "type": "Any", "source": "caller"})
        elif isinstance(i, dict):
            inputs.append({**{"type": "Any", "source": "caller"}, **i})

    outputs: List[Dict[str, Any]] = []
    for o in outputs_raw:
        if isinstance(o, str):
            outputs.append({"name": o, "type": "Any"})
        elif isinstance(o, dict):
            outputs.append({**{"type": "Any"}, **o})

    description = step.get("description") or step.get("title") or ""
    desc_lower = description.lower()
    libraries: List[str] = []
    if any(
        x in desc_lower
        for x in ("data", "load", "dataframe", "revenue", "aggregate", "parquet", "pandas")
    ):
        libraries = ["pandas"]

    step_id = step.get("id") or f"step-{step.get('step_number', step_index + 1)}"

    return {
        "step_id": step_id,
        "description": description,
        "title": step.get("title", ""),
        "inputs": inputs,
        "outputs": outputs,
        "constraints": [],
        "libraries": libraries,
        "complexity": "moderate",
        "metadata": {"dependencies": step.get("dependencies", [])},
    }


def _empty_requirements(step_index: int) -> Dict[str, Any]:
    return {
        "step_id": f"step-{step_index + 1}",
        "description": "",
        "title": "",
        "inputs": [],
        "outputs": [],
        "constraints": [],
        "libraries": [],
        "complexity": "moderate",
        "metadata": {},
    }
