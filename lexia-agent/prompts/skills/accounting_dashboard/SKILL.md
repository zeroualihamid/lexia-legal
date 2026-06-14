---
name: insurance-production-dashboard
description: "Tableau de bord assurance / production de primes (catalogue CTE insurance_production, ca_view, PRIMNETT, branches, intermédiaires, auto, géographie, impayés)."
source_view: oracle_env_ca_view
parquet_source: data/parquet/oracle_env_ca_view.parquet
aliases:
  - tableau de bord assurance
  - dashboard production assurance
  - kpis primes
  - portefeuille assurance
  - insurance production
  - rapport comptable
  - dashboard finance
  - kpis compta
  - tableau de bord financier
  - chiffre d'affaires
  - chiffre d'affaire
  - chiffre d'affaires par an
  - ca par an
---

# Tableau de bord — production assurance (`insurance_production`)

## Vue d'ensemble

Cette skill oriente Brikz vers les **indicateurs de production d'assurance** (primes nettes,
branches, produits, intermédiaires, risque auto, impayés, coassurance, etc.) tels qu'ils sont
déclarés dans :

`brikz-agent/data/reporting/sql/insurance_production/index.yaml`

Chaque entrée a un **`name`**, un **`file`**.sql et une liste **`depends_on`** (DAG dans
`index.yaml`) : la logique métier est en SQL réutilisable avec `{{include: <nom_de_cte>}}`
(même convention que le reporting et expansion DuckDB avec merge du catalogue
`insurance_production`, voir `nodes/reporting/sql_helpers.py`).

**Entrée données** : le premier CTE, **`source_data`**, lit la vue DuckDB **`ca_view`**
(typically alimentée par le Parquet `ca_view` / source assurance selon `config/datasources.yaml`).
Tout le pipeline suppose des colonnes type PRIMNETT, LIBEBRAN, LIBECATE, LIBEPROD, etc.

> **À ne pas confondre** : ce skill ne concerne que **`insurance_production/`** (primes, `ca_view`).
> Les outils **`list_accounting_ctes`** / **`execute_accounting_cte`** listent le catalogue PCG
> sous **`accounting/`**, pas les CTE assurance. Les alias « compta / finance » ou le dossier
> skill **`accounting_dashboard`** peuvent induire cette erreur — voir **Boîte à outils** ci-dessous.

## Catalogue CTE (`insurance_production`)

Source de vérité : `data/reporting/sql/insurance_production/index.yaml` (`version: 1`). Le tableau
ci-dessous reprend **chaque CTE**, ses **`depends_on` exacts** (ordre libre dans le YAML) et un
résumé aligné sur les **`description`** du fichier.

| CTE | `depends_on` | Rôle (résumé) |
|-----|----------------|---------------|
| `source_data` | *(vide)* | Lecture brute `ca_view` |
| `cleaned_data` | `source_data` | Types, PRIMNETT, flag `new_vs_renewal` (CODEACTE P2/P13) |
| `enriched_data` | `cleaned_data` | Jointures dimensions + libellés (LIBEBRAN, LIBECATE, LIBEPROD, LIBTYPIN, RAISOCIN, TYPEMOTE, VILLASSU, …) |
| `period_metrics` | `enriched_data` | Agrégations mensuelles/annuelles, évolutions %, tendances |
| `branch_category_agg` | `enriched_data`, `period_metrics` | Somme prime nette par branche / catégorie |
| `top_products` | `enriched_data`, `branch_category_agg` | Top 10 LIBEPROD + marge |
| `renewal_analysis` | `enriched_data`, `top_products` | Nouvelles vs renouvellements, taux par branche/produit |
| `retention_rates` | `enriched_data`, `renewal_analysis` | Rétention 12 mois par branche et produit |
| `intermediary_distribution` | `enriched_data`, `retention_rates` | LIBTYPIN / RAISOCIN, Pareto 20–80 |
| `acquisition_costs` | `enriched_data`, `intermediary_distribution` | COMMQUIT / PRIMNETT par type intermédiaire et canal |
| `productivity_metrics` | `enriched_data`, `acquisition_costs` | Prime moyenne agent vs courtier |
| `auto_risk_profile` | `enriched_data`, `productivity_metrics` | NAISCOND, PUISVEHI, DATE_MEC |
| `pricing_consistency` | `enriched_data`, `auto_risk_profile` | PRIM__RC vs profil conducteur |
| `fuel_mix_evolution` | `enriched_data`, `pricing_consistency` | Diesel vs Essence (TYPEMOTE), ESG |
| `vehicle_brand_contrib` | `enriched_data`, `fuel_mix_evolution` | MARQVEHI vs primes nettes |
| `gender_ratio` | `enriched_data`, `vehicle_brand_contrib` | SEXECOND global et par branche |
| `geographic_concentration` | `enriched_data`, `gender_ratio` | VILLASSU, exposition / zones sous-exploitées |
| `unpaid_quitances` | `enriched_data`, `geographic_concentration` | STATQUIT, délai DATEEFFE → DATESTAT |
| `coinsurance_analysis` | `enriched_data`, `unpaid_quitances` | COAS_CIE, rentabilité |
| `conventions_volume` | `enriched_data`, `coinsurance_analysis` | CODECONV, partenariats |
| `strategic_mix` | `conventions_volume` **uniquement** | Mix produit idéal sur 3 ans (marges, contribution) — pas de `depends_on` direct vers `enriched_data` dans l’index |
| `segment_prioritization` | `enriched_data`, `strategic_mix` | Scoring segments (âge, sexe, type véhicule) |
| `commission_alignment` | `enriched_data`, `segment_prioritization` | COMMQUIT vs rentabilité par affaire |
| `anti_selection_signals` | `enriched_data`, `commission_alignment` | Anti-sélection 12 mois, branche / intermédiaire |

**Ordre d’analyse** : pour reconstruire ou exécuter une requête, respecter la **fermeture transitive**
des `depends_on` (ancêtres du CTE feuille choisi). Le dernier nom dans le fichier
(`anti_selection_signals`) est la fin de chaîne **catalogue**, pas forcément le bon CTE métier pour
chaque question — choisir la feuille selon le besoin (ex. `period_metrics` pour agrégats temporels,
`intermediary_distribution` pour le réseau).

## Boîte à outils — usage pour ce catalogue

| Action | Outil / méthode |
|--------|-----------------|
| Découvrir le catalogue PCG (**accounting/** uniquement) | `list_accounting_ctes` — **ne liste pas** `insurance_production` |
| Lire les définitions **assurance** | `read_file` sur `data/reporting/sql/insurance_production/index.yaml` et les `.sql` nécessaires |
| Exécuter une métrique assurance | **`sql_query`** : DuckDB avec `read_parquet(...)` / vues déjà décrites par `describe_table`, puis CTE `WITH` en réutilisant les corps SQL des fichiers (ou sous-requêtes équivalentes). Enchaîner les includes comme dans le reporting si l'environnement d'exécution les développe. |
| Rendu HTML rapport | `render_report_template` ; les blocs peuvent inclure `{{include: …}}` avec merge catalogue `insurance_production` (cf. API reporting / expansion SQL) |
| Brouillon CTE depuis l’UI reporting | `POST …/blocks/{block_id}/generate-insurance-production-cte` — squelette ancré sur un CTE feuille du catalogue et chaîne `depends_on` |
| Étendre le catalogue | Éditer `index.yaml` + nouveau `.sql` sous `insurance_production/` (revue CI) ; invalider caches graphe CTE si nécessaire |

Pour **`execute_accounting_cte(cte_name=...)`** : utiliser uniquement des noms présents dans
**`accounting/index.yaml`**. Pour un CTE **`insurance_production`**, passer plutôt un
**`sql=`** custom qui cite explicitement les sous-requêtes ou utiliser **`sql_query`**.

## Workflow recommandé

1. **Cadrage** — Confirmer que la question porte sur **primes / assurance / ca_view**, pas sur grand-livre PCG.
2. **Cartographie** — Ouvrir **`insurance_production/index.yaml`** pour choisir le **CTE feuille** pertinent et lister ses **`depends_on`** (et ancêtres) avant d’écrire le `WITH`.
3. **Données** — Vérifier que la vue **`ca_view`** (ou Parquet équivalent) est disponible (`list_tables` / `describe_table`, chemins sous `data/parquet/`).
4. **Exécution** — Construire un `WITH … SELECT …` cohérent avec les **`depends_on`** (ne pas référencer un CTE aval sans ses prérequis). Réutiliser les projections métier (LIBE*, PRIMNETT, COMMQUIT, etc.).
5. **Synthèse** — Tableaux Markdown par axe (temporel, branche/produit, intermédiaires, risques, impayés). **Libellés** : colonnes `LIBE*` / désignations pour l'utilisateur, pas seuls les codes.

## Règles métier (alignées catalogue)

1. **Prime** — Indicateur central **`PRIMNETT`** (nette).
2. **Nouveau vs renouvellement** — Dérivé de **`CODEACTE`** dans `cleaned_data` (`P2` / `P13` → renouvellement).
3. **Restitution** — Présenter **branche / catégorie / produit / intermédiaire** avec **`LIBEBRAN`**, **`LIBECATE`**, **`LIBEPROD`**, **`LIBTYPIN`**, **`RAISOCIN`**, pas seuls `CODE*` dans les réponses finales.
4. **Devise** — MAD pour montants monétaires si les données sont en MAD (cohérent avec les prompts agent).

## Format de sortie suggéré

```markdown
# Synthèse production assurance — <période ou périmètre>

## Vue d'ensemble
- Prime nette agrégée, tendance (réf. `period_metrics` si pertinent).

## Branches & produits
- Top segments (`branch_category_agg`, `top_products`).

## Intermédiaires & coûts
- Répartition, Pareto, coût d'acquisition (`intermediary_distribution`, `acquisition_costs`).

## Risque & parcours
- Auto, carburant, marques (`auto_risk_profile` → `vehicle_brand_contrib`).

## Géographie & portefeuille
- Villes, impayés, coassurance, conventions (`geographic_concentration`, `unpaid_quitances`, …).

## Signaux d'alerte
- Anti-sélection, alignement commission (`anti_selection_signals`, `commission_alignment`) — interpréter avec prudence.
```

Indiquer toujours les **hypothèses** (période filtrée, source `ca_view`, limites des jointures des `.sql`).
