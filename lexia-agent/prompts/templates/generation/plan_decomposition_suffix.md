BEFORE the step list, you MUST output one JSON object between these exact tags:
<FILTER_TUPLES_JSON>
{ "filter_tuples": [ {"keyword": "...", "categorical_column": "...", "source_id": "..."} ] }
</FILTER_TUPLES_JSON>

Rules for filter_tuples:
- Only include terms that are actual user filter keywords (names, labels, free-text values, category values).
- For each keyword, choose the single best categorical/text column from the available schemas.
- source_id must be one of the listed datasources.
- If no filter keyword exists, return: {"filter_tuples": []}
- JSON must be valid and compact.

After this JSON block, output the plan steps using the required STEP format.
