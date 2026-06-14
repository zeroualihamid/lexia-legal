"""
Card Generation Prompt
=======================

Prompt template that instructs the LLM to analyse domain data and
produce structured KPI + analysis cards as YAML output.

The custom-card pipeline is two-phase:
  Phase 1 — Code generation: LLM writes Python that queries parquet files
  Phase 2 — Card formatting: code stdout is fed to a second LLM call that
            produces the final YAML card structure.
"""

from datetime import date


CARD_SYSTEM_PROMPT = (
    "Tu es un analyste financier senior au Maroc spécialisé dans la création de "
    "tableaux de bord interactifs. Tu analyses des données financières et produis "
    "des fiches de synthèse (cards) structurées en YAML.\n\n"
    "RÈGLES STRICTES :\n"
    "- Montants en MAD avec séparateur de milliers espace (ex: 1 234 567 MAD).\n"
    "- Tous les textes en français.\n"
    "- Les deltas expriment la variation vs période précédente (mois ou année).\n"
    "- Les valeurs doivent être des chaînes de caractères prêtes à afficher.\n"
    "- Pas de code JavaScript ou Python dans la sortie.\n"
    "- Tu ne produis QUE le bloc YAML demandé, rien d'autre."
)

CARD_CODE_SYSTEM_PROMPT = (
    "Tu es un expert Python / data analyst marocain. "
    f"Aujourd'hui : {date.today().isoformat()}. "
    "Tu écris du code Python concis qui lit des fichiers Parquet avec pandas, "
    "effectue les calculs demandés, et imprime UNIQUEMENT le résultat final sur stdout. "
    "Utilise UNIQUEMENT les chemins Parquet fournis (config/datasources.yaml) — ne les invente pas. "
    "JAMAIS d'exploration, de debug, de row counts, ni de profiling. "
    "Utilise pd.to_numeric(col, errors='coerce') avant toute arithmétique. "
    "Montants en MAD, format français (espace milliers, virgule décimale). "
    "Retourne le code dans un bloc ```python."
)


def build_card_generation_prompt(
    domain_name: str,
    domain_system_prompt: str,
    data_summary: str,
    schemas_description: str,
) -> str:
    """Build the prompt that asks the LLM to generate cards for a domain."""

    return f"""{domain_system_prompt}

Tu dois analyser les données ci-dessous et produire des fiches (cards) pour le domaine « {domain_name} ».

## DONNÉES DISPONIBLES

### Schémas des sources
{schemas_description}

### Résumé statistique des données
{data_summary}

## FORMAT DE SORTIE

Produis EXACTEMENT un bloc YAML entre balises ```yaml et ``` avec la structure suivante :

```yaml
kpi_cards:
  - title: "Titre du KPI"
    value: "1 234 567 MAD"
    delta: "+12.3%"
    delta_direction: "up"
    color: "green"
    label: "vs mois précédent"
    prompt: "Afficher le chiffre d'affaires total en MAD avec variation vs mois précédent"

  - title: "Autre KPI"
    value: "890 000 MAD"
    delta: "-5.1%"
    delta_direction: "down"
    color: "red"
    label: "vs année précédente"
    prompt: "Afficher le total des charges en MAD avec variation vs année précédente"

analysis_cards:
  - title: "Titre de l'analyse"
    tag: "GROUPE"
    tag_type: "g"
    prompt: "Analyser les tendances principales du groupe avec points clés et recommandations"
    markdown: |
      **Constat principal** : description en français.

      - Point clé 1
      - Point clé 2
      - Recommandation

  - title: "Deuxième analyse"
    tag: "FACTORY"
    tag_type: "f"
    prompt: "Analyser la performance de production avec indicateurs détaillés"
    markdown: |
      Analyse détaillée...
```

## INSTRUCTIONS

1. Produis entre 4 et 6 **kpi_cards** avec les métriques les plus importantes pour ce domaine.
2. Produis entre 2 et 3 **analysis_cards** avec des insights, tendances et recommandations.
3. Les couleurs possibles pour les KPI : "green", "red", "blue", "orange", "purple", "accent".
4. Les tag_type possibles : "f" (Factory/bleu), "m" (Mobili/orange), "g" (Groupe/accent), "gr" (vert), "r" (rouge), "p" (violet).
5. delta_direction : "up", "down", ou "neutral".
6. Base tes calculs UNIQUEMENT sur les données fournies. Ne fabrique pas de chiffres.
7. Si une donnée est insuffisante, indique-le dans l'analyse au lieu d'inventer.
8. **OBLIGATOIRE** : Chaque carte (KPI et analysis) doit inclure un champ `prompt` décrivant en 1-2 phrases ce que la carte affiche. Ce prompt sera visible à l'utilisateur qui pourra le modifier pour régénérer la carte.
"""


def build_custom_card_prompt(
    domain_name: str,
    domain_system_prompt: str,
    user_request: str,
    data_summary: str,
    schemas_description: str,
    card_type: str = "analysis",
) -> str:
    """Build prompt for a user-requested custom card."""

    if card_type == "kpi":
        format_block = """```yaml
card_type: "kpi"
title: "Titre du KPI"
prompt: "Description courte de ce que la carte affiche"
value: "1 234 567 MAD"
delta: "+12.3%"
delta_direction: "up"
color: "green"
label: "vs mois précédent"
```

Les couleurs possibles : "green", "red", "blue", "orange", "purple", "accent".
delta_direction : "up", "down", ou "neutral".
La valeur doit être une chaîne prête à afficher (montants en MAD, pourcentages, etc.)."""
    else:
        format_block = """```yaml
card_type: "analysis"
title: "Titre de l'analyse"
prompt: "Description courte de ce que la carte affiche"
tag: "TAG"
tag_type: "g"
markdown: |
  **Constat principal** : description détaillée en français.

  | Colonne 1 | Colonne 2 | Colonne 3 |
  |-----------|-----------|-----------|
  | val1      | val2      | val3      |

  - Point clé 1 avec données chiffrées
  - Point clé 2 avec comparaison
  - Recommandation actionnable

  > **Conclusion** : synthèse et perspective.
```

Les tag_type possibles : "f" (Factory/bleu), "m" (Mobili/orange), "g" (Groupe/accent), "gr" (vert), "r" (rouge), "p" (violet).
Le champ `markdown` doit contenir une analyse détaillée et structurée avec tableaux, listes et mise en forme."""

    return f"""{domain_system_prompt}

L'utilisateur demande une fiche de type **{card_type}** pour le domaine « {domain_name} » :

> {user_request}

## DONNÉES DISPONIBLES

### Schémas
{schemas_description}

### Résumé
{data_summary}

## FORMAT DE SORTIE

Produis EXACTEMENT un bloc YAML entre balises ```yaml et ``` :

{format_block}

Produis UNE SEULE fiche de type **{card_type}** correspondant exactement à la demande.
Le champ `prompt` doit décrire en 1-2 phrases ce que la carte affiche.
Base tes calculs UNIQUEMENT sur les données fournies. Ne fabrique pas de chiffres.
"""


# ═══════════════════════════════════════════════════════════════════════════
# Phase 1 — Code generation for custom cards
# ═══════════════════════════════════════════════════════════════════════════

def build_card_code_prompt(
    domain_name: str,
    domain_system_prompt: str,
    domain_code_prompt: str,
    user_request: str,
    schemas_description: str,
) -> str:
    """Build prompt that asks the LLM to write Python code to answer the user request."""

    return f"""{domain_system_prompt}

{domain_code_prompt}

L'utilisateur demande pour le domaine « {domain_name} » :

> {user_request}

## SOURCES DE DONNÉES (config/datasources.yaml — utilise ces chemins EXACTS)

{schemas_description}

## CONSIGNES

1. Lis les fichiers Parquet avec `pd.read_parquet("chemin")`.
2. Utilise `pd.to_numeric(col, errors='coerce')` avant toute opération arithmétique.
3. Effectue les filtres, agrégations ou calculs nécessaires pour répondre à la demande.
4. Imprime UNIQUEMENT le résultat final sur stdout :
   - Pour un chiffre unique : une ligne « **Label:** valeur MAD »
   - Pour des données tabulaires : un tableau Markdown avec | séparateurs
5. Montants en MAD, format espace milliers (ex: 1 234 567,89 MAD).
6. Labels en français.
7. Trie par date ascendante si pertinent.
8. NE PAS faire d'exploration, de profiling, ni de print de métadonnées.

Retourne UNIQUEMENT le code Python dans un bloc ```python.
"""


# ═══════════════════════════════════════════════════════════════════════════
# Phase 2 — Format code output into card YAML
# ═══════════════════════════════════════════════════════════════════════════

def build_card_format_prompt(
    user_request: str,
    code_output: str,
    card_type: str = "analysis",
) -> str:
    """Take the stdout of executed code and format it as a card YAML."""

    if card_type == "kpi":
        format_instructions = """Produis un bloc YAML avec la structure EXACTE suivante :

```yaml
card_type: "kpi"
title: "Titre court du KPI"
prompt: "Description courte de ce que la carte affiche"
value: "1 234 567 MAD"
delta: "+12.3%"
delta_direction: "up"
color: "green"
label: "vs mois précédent"
```

RÈGLES KPI :
- `value` : la valeur principale extraite des résultats. Chaîne prête à afficher.
- `delta` : variation vs période précédente si calculable, sinon "".
- `delta_direction` : "up", "down", ou "neutral".
- `color` : "green" (positif), "red" (négatif), "blue", "orange", "purple", "accent".
- `label` : légende courte du delta (ex: "vs mois précédent").
- IMPORTANT : utilise UNIQUEMENT les données des résultats ci-dessous. Ne fabrique rien."""
    else:
        format_instructions = """Produis un bloc YAML avec la structure EXACTE suivante :

```yaml
card_type: "analysis"
title: "Titre de l'analyse"
prompt: "Description courte de ce que la carte affiche"
tag: "TAG"
tag_type: "g"
markdown: |
  **Constat principal** : résumé en 1-2 lignes.

  | Colonne 1 | Colonne 2 | Colonne 3 |
  |-----------|-----------|-----------|
  | val1      | val2      | val3      |

  - Point clé 1 avec données chiffrées
  - Point clé 2 avec comparaison
  - Recommandation actionnable

  > **Conclusion** : synthèse et perspective.
```

RÈGLES ANALYSE :
- `markdown` : analyse COMPLÈTE et DÉTAILLÉE avec les données des résultats ci-dessous.
- Inclure les tableaux de données si pertinent.
- Lister les points clés avec des chiffres réels.
- Ajouter une conclusion/recommandation.
- tag_type : "f" (Factory/bleu), "m" (Mobili/orange), "g" (Groupe/accent), "gr" (vert), "r" (rouge), "p" (violet).
- IMPORTANT : utilise UNIQUEMENT les données des résultats ci-dessous. Ne fabrique rien."""

    return f"""L'utilisateur a demandé :

> {user_request}

## RÉSULTATS DU CALCUL (données réelles extraites des fichiers)

{code_output}

## FORMAT DE SORTIE

{format_instructions}

Produis UNE SEULE fiche de type **{card_type}** basée EXCLUSIVEMENT sur les résultats ci-dessus.
"""
