# Reporting `definitions.yaml` schema

One file per HTML template, committed at
`data/reporting/templates/<template_id>/definitions.yaml`. The file is
versioned, hot-reloaded by the API, and consumed by the render flow.

## Top-level keys

| Key            | Type                  | Description                                                                  |
| -------------- | --------------------- | ---------------------------------------------------------------------------- |
| `template_id`  | `string` (required)   | Stable identifier matching the folder name (e.g. `model1`).                  |
| `version`      | `int`    (required)   | Bumped on every persist. Used by the audit log.                              |
| `parameters`   | `list[Parameter]`     | Render-time inputs (CLIENT_NAME, YEAR, …). **Never backed by SQL.**          |
| `sources`      | `list[SourceBinding]` | DuckDB views registered for this template (multi-source reports).            |
| `blocks`       | `list[Block]`         | All div-tagged blocks (replaces the old `fields`). CTE-backed.               |
| `metadata`     | `dict`                | Optional: created_at, last_bootstrap_at, etc.                                |

## Parameter

```yaml
- id: CLIENT_NAME      # uppercase identifier
  type: string         # one of: string, int, float, date
  default: ''          # optional render-time fallback
  description: ''      # optional, surfaced to the agent
```

## Source binding

```yaml
- name: pnl                              # alias used inside CTEs
  source_id: balance_2023_11_15_2024_12_31_xlsx
```

`source_id` matches a registered ConnectorManager source. The render flow
opens one DuckDB connection per render and registers each `(name, source_id)`
pair as a `CREATE OR REPLACE VIEW <name> AS SELECT * FROM read_parquet(...)`
view, so block SQL refers to `pnl`, `banque`, … instead of generic `src`.

## Block

A **block** is a `<div data-block="<name>">` (or any element carrying the
`data-block` attribute) in the template HTML. Every DSL marker
(`{{TOKEN}}`, `<!-- BEGIN/END:section -->`, `<!-- IF/ENDIF:flag -->`,
`<!-- NARRATIVE:name -->`) must live inside a tagged block; the closest
ancestor with `data-block` wins for nested cases.

```yaml
- id: pnl_score_card_global       # snake_case, must match data-block in HTML
  goal: |
    Carte principale de fiabilité globale. Renvoie le score (0-100), la
    classe CSS du niveau et son libellé. Calculé sur la période courante
    depuis le ledger filtré.
  kind: scalar                    # scalar | section | condition | narrative | mixed
  tokens: [SCORE_GLOBAL, SCORE_LEVEL, SCORE_LEVEL_LABEL]   # tokens directly in this block
  mapping:                        # optional; defaults to lowercased token name
    SCORE_LEVEL: level_class
  cte_ref: null                   # OR "<name>" to reuse a row from sql/fragment_library/index.yaml
  sql: |                          # required when cte_ref is null
    WITH
    {{include: period_filtered_ledger}},
    score AS ( ... )
    SELECT
      ROUND(100 * final_score) AS score_global,
      score_level              AS level_class,
      level_label              AS score_level_label
    FROM score;
  status: validated               # draft | validated | invalid | live | deprecated
```

### Block kinds

The kind is inferred from the DSL markers contained in the tagged
element:

| kind        | Inner DSL                                      | CTE projection contract                                                  |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `scalar`    | only `{{TOKEN}}` markers                       | exactly **one row**, one column per token (matched by `mapping` or lowercased name) |
| `section`   | exactly one `<!-- BEGIN/END:name -->` pair     | **N rows**, one column per token inside the section                      |
| `condition` | exactly one `<!-- IF/ENDIF:flag -->` pair      | exactly **one row**, one boolean column aliased `value`                  |
| `narrative` | exactly one `<!-- NARRATIVE:name -->` marker   | exactly **one row**, one column per `grounding_fields` entry             |
| `mixed`     | any combination of the above                   | one CTE per logical sub-output (see "Mixed blocks" below)                |

### Mixed blocks

A block whose tagged element contains more than one structural marker
(e.g. a P&L `<div class="table-scroll">` with two `BEGIN/END` sections,
an `IF/ENDIF` and a cluster of scalars) is `kind: mixed`. Its YAML
provides a `ctes:` list instead of a single `sql:`:

```yaml
- id: pnl_table
  goal: |
    Le tableau du compte de résultat (produits, charges, résultats) avec
    libellés et montants par période.
  kind: mixed
  ctes:
    - id: scalars                    # synthetic name: the cluster of bare {{TOKENS}}
      kind: scalar
      tokens: [CURRENT_PERIOD_LABEL, PRIOR_PERIOD_LABEL,
               TOTAL_PRODUITS_N, TOTAL_PRODUITS_N1,
               TOTAL_CHARGES_N,  TOTAL_CHARGES_N1,
               RESULTAT_N, RESULTAT_N1, RESULTAT_NET_N, RESULTAT_NET_N1,
               PNL_FOOTNOTE]
      sql: |
        WITH ... SELECT ... AS current_period_label, ... FROM ...;
    - id: pnl_produits               # matches BEGIN:pnl_produits
      kind: section
      tokens: [LINE_LABEL, AMOUNT_N, AMOUNT_N1]
      sql: |
        WITH {{include: revenue_total}}, ...
        SELECT line_label, amount_n, amount_n1 FROM produits ORDER BY ...;
    - id: pnl_charges
      kind: section
      tokens: [LINE_LABEL, AMOUNT_N, AMOUNT_N1]
      sql: |
        WITH ... SELECT line_label, amount_n, amount_n1 FROM charges;
    - id: has_pnl_footnote           # matches IF:has_pnl_footnote
      kind: condition
      sql: |
        WITH ... SELECT (...) AS value FROM ...;
  status: validated
```

For `mixed` blocks the validator enforces each sub-CTE's contract
according to its individual `kind`.

### CTE reuse: `cte_ref` vs `sql`

A block can either inline its CTE (`sql:`) or reference a reusable
catalog entry from
[data/reporting/sql/fragment_library/index.yaml](sql/fragment_library/index.yaml):

```yaml
- id: pnl_score_card_global
  cte_ref: score_card_global   # name in sql/fragment_library/index.yaml
  sql: null                    # mutually exclusive with cte_ref
```

The block library lives at `data/reporting/sql/fragment_library/`:
- `index.yaml` — LLM-facing catalog (each entry: `name`, `description`,
  `kind`, `projects`, `depends_on`, `parameters`).
- `<name>.sql` — one file per saved block CTE (full CTE chain ending
  with the SELECT that satisfies the kind's projection contract).

The agent saves a fresh inline CTE to the library by:
1. writing `data/reporting/sql/fragment_library/<new_name>.sql` and
2. appending an entry to `data/reporting/sql/fragment_library/index.yaml`.

Subsequent blocks (in the same or any other template) can then set
`cte_ref: <new_name>` instead of re-authoring the SQL.

### Hard invariants (enforced by `BlockValidatorNode`)

1. **Exactly one of `sql:` or `cte_ref:` is set** for every leaf block
   (or every entry inside a `mixed` block's `ctes:` list).
2. **`sql:` is CTE-shaped**: starts with `WITH … AS (…)` (one or more
   named CTEs, chained with commas) and ends with a single
   `SELECT … FROM …`. No bare `SELECT`, no DDL, no DML, no procedural
   code.
3. **The final `SELECT` projection matches the block kind's contract**
   (see table above). Section column aliases must equal the section's
   inner tokens (lowercased). Condition CTEs alias `value:bool`.
   Narrative CTEs alias the `grounding_fields` list.
4. **`{{include: <name>}}`** references the shared accounting library
   (`data/reporting/sql/accounting/*.sql`); the validator inlines the
   named atom into the block's `WITH …` chain. Cycles / unknown
   includes / self-references fail loudly.
5. **`mapping:`** if present must cover every token in the block's
   inner DSL. Implicit mapping is `TOKEN → lowercase(TOKEN)` for any
   token not explicitly mapped.

## Status lifecycle

```
            +--> validated <--+
   draft ---+                 |
            +--> invalid -----+   (re-drafted by agent)
                              |
            live <-- ack ----+    (manually marked production-ready)
            deprecated              (data-block tag removed from template)
```

`status: live` is reserved for blocks a human reviewer has explicitly
acknowledged; bootstrap drafts land as `validated`. `deprecated: true`
blocks are kept in the YAML for history but never executed; this is set
automatically when the scanner detects that a previously-tagged
`data-block="<name>"` no longer exists in the template HTML.

## Lifecycle: add / delete blocks

The user controls block granularity by editing the template HTML:
- adding `data-block="<new_name>"` to a `<div>` (or any element) → the
  scanner emits a *skeleton* block on the next rescan, ready for the
  agent to define;
- removing a `data-block` attribute → the corresponding YAML entry
  flips to `deprecated: true` and is kept for history only.

## On-disk layout

```
data/reporting/
├── SCHEMA.md                              ← this file
├── sql/
│   ├── accounting/                        ← shared atom CTE library
│   │   ├── index.yaml                     ← LLM-facing catalog of atoms
│   │   ├── FORMULAS.md                    ← canonical accounting formulas
│   │   ├── base_ledger.sql                ← one named CTE per file
│   │   ├── period_filtered_ledger.sql
│   │   └── …
│   └── fragment_library/                  ← reusable block / DTO CTE fragments
│       ├── index.yaml                     ← catalog (dto_*, materialized blocks)
│       └── <name>.sql                     ← one block CTE per file
└── templates/<template_id>/
    ├── report-template.html               ← the DSL source-of-truth (with data-block markers)
    ├── report.css
    ├── definitions.yaml                   ← THE schema described above
    └── definitions.history.jsonl          ← append-only audit log
```
