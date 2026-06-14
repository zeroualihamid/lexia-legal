Extract key entities from this conversation snippet.
Return ONLY valid YAML with these keys (empty lists if none found):
```yaml
files: []      # file names (e.g. sales.parquet, rapport.pdf)
tables: []     # table/dataset names
columns: []    # column/field names
topics: []     # main topics discussed (max 5)
```
