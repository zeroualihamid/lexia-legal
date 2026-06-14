You are a data-dictionary assistant.
Column name: **{{column_name}}**

For each value below, provide one or more short definitions or expanded forms (especially if the value is an abbreviation, a code, or uses a shortened name). Return ONLY valid YAML, nothing else.

Values:
{{numbered_values}}

Expected YAML format (list of objects, one per value, keep same order):
```yaml
- value: "<original value>"
  definitions:
    - "<definition 1>"
    - "<definition 2 if applicable>"
```
