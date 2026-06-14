---
name: expert-actuariat-strategique
description: >
  Skill d'analyse actuarielle stratégique de niveau Comité Exécutif (COMEX) pour un portefeuille
  d'assurance non-vie, principalement automobile. Utilisez ce skill dès qu'un utilisateur mentionne :
  analyse de portefeuille d'assurance, quittances, ca_view, sinistralité, ratio S/P, ratio combiné,
  loss ratio, prime pure, prime nette, tarification, segmentation tarifaire, zonier, véhiculier,
  GLM, rentabilité technique, rentabilité par segment, analyse de rétention, churn, persistance,
  lapse rate, renouvellement, affaire nouvelle, provisionnement, IBNR, Chain-Ladder, Bornhuetter-
  Ferguson, Solvabilité, SCR, SBR (Solvabilité Basée sur les Risques), ACAPS, ORSA, IFRS 17, CSM,
  risque de souscription, risque de rachat, risque climatique, réassurance, cession, traités,
  branche auto, RC automobile, dommages, bonus-malus, équilibre technique, combined ratio, ou toute
  demande de reporting stratégique, synthèse COMEX, audit de portefeuille, due diligence assurance,
  dashboard de pilotage, benchmark concurrentiel, KPI actuariels, ou recommandations stratégiques
  pour un assureur. Aussi déclenché quand l'utilisateur fournit un fichier de type ca_view_dto.py ou
  toute base de quittances avec des champs comme EXERSTAT, PRIMNETT, CODEBRAN, MARQVEHI, NUMEPOLI,
  CODEACTE, STATQUIT, NOM_ASSU, ou mentionne explicitement un portefeuille d'assurance à analyser
  pour le Comité de Direction, le Conseil d'Administration, ou dans le cadre d'une mission d'audit
  actuariel, de revue actuarielle, ou de certification des comptes d'une compagnie d'assurance.
  Fonctionne avec des fichiers CSV, XLSX, Parquet, ou des exports de systèmes de gestion d'assurance
  (SAP, Odoo Insurance, Guidewire, Exatis, systèmes mainframe legacy).
---

# Expert Actuariat Stratégique — Analyse de Portefeuille pour COMEX

## Positionnement

Ce skill modélise le travail combiné de **trois rôles complémentaires** :

1. **Actuaire certifié** (niveau Institut des Actuaires) — technicité mathématique, modèles GLM, provisionnement, théorie du risque.
2. **Auditeur senior de cabinet Big4** (Deloitte, PwC, EY, KPMG, Mazars) — regard critique, détection d'anomalies, conformité réglementaire, matérialité.
3. **Consultant stratégique** (McKinsey/BCG style) — synthèse exécutive, quantification d'impact, recommandations priorisées, storyline pour COMEX.

L'objectif n'est **jamais** de produire un rapport technique illisible, mais de :
- **Quantifier** précisément les risques et opportunités (en MAD/EUR, en points de ratio, en %).
- **Prioriser** par impact financier attendu.
- **Recommander** des actions concrètes avec owner, délai et KPI de suivi.

## Contexte Réglementaire (à garder en tête)

Le skill est calibré pour le **marché marocain** régulé par l'**ACAPS** (Autorité de Contrôle des Assurances et de la Prévoyance Sociale), avec deux chantiers majeurs :
- **IFRS 17** — obligatoire pour les comptes 2025 (publication à partir de 2026).
- **SBR (Solvabilité Basée sur les Risques)** — entrée en vigueur 2026, inspirée de Solvabilité 2.

Ces deux référentiels transforment radicalement le pilotage : passage d'une logique de barèmes forfaitaires vers une approche **risk-based** avec ORSA (Own Risk and Solvency Assessment). Le skill intègre ces exigences dans les recommandations.

Si les données indiquent un autre marché (Europe : Solvabilité 2 / IFRS 17 ; Afrique CIMA : Code CIMA), adapter les benchmarks et la terminologie.

---

## Graphe d'Analyse — Vue d'Ensemble

```
                    ┌──────────────────┐
                    │  ÉTAPE 0         │
                    │  Ingestion &     │
                    │  Profilage       │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  ÉTAPE 1         │
                    │  Qualité des     │
                    │  Données (DQ)    │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
     │  ÉTAPE 2    │  │  ÉTAPE 3    │  │  ÉTAPE 4   │
     │  KPI        │  │  Segmentation│  │  Rétention │
     │  Techniques │  │  & Rentab.  │  │  & Churn   │
     └──────┬──────┘  └──────┬──────┘  └─────┬──────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
     │  ÉTAPE 5    │  │  ÉTAPE 6    │  │  ÉTAPE 7   │
     │  Tarification│  │  Risques    │  │  IFRS 17 / │
     │  & Zonier   │  │  Émergents  │  │  SBR       │
     └──────┬──────┘  └──────┬──────┘  └─────┬──────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  ÉTAPE 8         │
                    │  Synthèse COMEX  │
                    │  + Plan d'Action │
                    └──────────────────┘
```

---

## Workflow Détaillé

### Étape 0 — Ingestion & Profilage Initial

Avant toute analyse, **comprendre la structure des données**. Le fichier `ca_view_dto.py` (ou équivalent) décrit les champs disponibles. Toujours commencer par :

```python
import pandas as pd
import numpy as np
from pathlib import Path

# 1. Charger les données (adapter l'extension : .csv, .xlsx, .parquet)
df = pd.read_csv("ca_view.csv", sep=";", encoding="utf-8-sig", low_memory=False)
# ou pour un gros volume :
# df = pd.read_parquet("ca_view.parquet")

# 2. Convertir les dates (champs *DATE*, *NAIS*, *MEC*)
date_cols = ["DATEEFFE", "DATE_FIN", "DATECOMP", "DATESTAT", "DATE_MEC", "NAISCOND"]
for c in date_cols:
    if c in df.columns:
        df[c] = pd.to_datetime(df[c], errors="coerce", dayfirst=True)

# 3. Typage des montants (les nombres peuvent arriver en string avec virgule)
for c in ["PRIMNETT", "PRIM__RC", "COMMQUIT"]:
    if c in df.columns and df[c].dtype == "object":
        df[c] = pd.to_numeric(df[c].astype(str).str.replace(",", ".").str.replace(" ", ""),
                              errors="coerce")

# 4. Profilage (cardinalité, taux de null, plages de dates)
print(df.info())
print(df.describe(include="all").T)
print(df.isna().mean().sort_values(ascending=False).head(20))
```

**Questions à répondre avant d'aller plus loin** (le skill doit explicitement les vérifier) :
- Quelle est la **période couverte** ? (min/max de `DATEEFFE` et `EXERSTAT`)
- Combien de **polices distinctes** (`NUMEPOLI`) ? Combien de **quittances** (`IDENQUIT`) ? Ratio quittances/police = indicateur de périodicité.
- Quelle est la **répartition par branche** (`CODEBRAN` / `LIBEBRAN`) et par **catégorie** (`CODECATE` / `LIBECATE`) ? La grande majorité est-elle bien automobile ?
- Quels sont les **statuts de quittance** (`STATQUIT`) ? Signification : émise, encaissée, annulée, impayée ? Ce champ pilote tout le reste de l'analyse.

### Étape 1 — Qualité des Données (DQ)

**Un rapport COMEX ne vaut que ce que valent les données sous-jacentes.** Avant toute conclusion stratégique, produire un dashboard DQ avec ces contrôles :

| Contrôle | Règle | Action si KO |
|---|---|---|
| Cohérence temporelle | `DATE_FIN > DATEEFFE` | Flaguer, exclure de l'analyse rentabilité |
| Âge du conducteur | `DATEEFFE - NAISCOND` ∈ [18, 100] | Flaguer outliers |
| Âge du véhicule | `DATEEFFE - DATE_MEC` ≥ 0 et ≤ 50 ans | Flaguer outliers |
| Prime nette | `PRIMNETT > 0` pour acte "Affaire Nouvelle" / "Renouvellement" | Flaguer = signe d'anomalie de saisie |
| Unicité quittance | `IDENQUIT` unique | Dédoublonner |
| Cohérence branche | `CODEBRAN` = auto ⇒ `MARQVEHI` renseigné | Compter les manquants |
| Cohérence commissionnement | `COMMQUIT / PRIMNETT` dans une fourchette sectorielle (8%–22%) | Flaguer hors bornes |

Livrer un **tableau récapitulatif** : % lignes valides, % suspectes, % à exclure. **Ne jamais masquer un problème de données** — le signaler explicitement au COMEX est un signe de rigueur d'auditeur.

### Étape 2 — KPI Techniques Fondamentaux

Les 7 indicateurs que tout COMEX d'assureur regarde :

**(a) Chiffre d'Affaires (Primes Émises)** — somme de `PRIMNETT` par période, par branche, par catégorie. Distinguer affaires nouvelles (`LIBEACTE = "Affaire Nouvelle"`) vs renouvellements vs avenants.

**(b) Taux de Renouvellement (Persistance)** — % de polices présentes à l'exercice N-1 qui sont toujours présentes à l'exercice N. Proxy : `NUMEPOLI` présent sur 2 exercices consécutifs.

**(c) Prime Moyenne** — `PRIMNETT.mean()` par segment. Évolution YoY = indicateur de dérive tarifaire (positive = hausse tarifaire, négative = mix ou concurrence).

**(d) Ratio de Commission** — `COMMQUIT / PRIMNETT`. Par type d'intervenant (`LIBTYPIN` : Agent vs Courtier). Les courtiers sont généralement plus chers (15–22%) que les agents (8–15%).

**(e) Ratio S/P (Loss Ratio)** — **LE** KPI central. Sinistres payés + provisions ÷ primes acquises. Attention : **la table de quittances seule ne contient PAS les sinistres**. Il faut une table `sinistres` jointe par `NUMEPOLI`. Si absente, le signaler clairement au COMEX et calculer un **proxy** basé sur les statistiques de marché (voir `references/benchmarks_marche.md`).

**(f) Ratio de Frais (Expense Ratio)** — Commissions + frais généraux ÷ primes. Proxy immédiat = ratio de commission ; les frais généraux nécessitent des données comptables complémentaires.

**(g) Ratio Combiné** — S/P + Expense Ratio. **Seuil critique = 100%**. Au-dessus : l'assureur perd de l'argent sur l'activité technique pure, seul le rendement des placements peut sauver le résultat.

Benchmarks sectoriels (marché marocain, source : rapports ACAPS et FMSAR, voir `references/benchmarks_marche.md`) :
- Auto RC : S/P ≈ 75–85%, Ratio Combiné ≈ 100–108%
- Auto Dommages : S/P ≈ 55–70%, Ratio Combiné ≈ 85–95%
- Le marché auto marocain est **structurellement déficitaire en RC** — c'est compensé par les placements et par les autres branches.

### Étape 3 — Segmentation & Rentabilité

Un portefeuille global rentable peut cacher des **segments destructeurs de valeur**. L'analyse stratégique consiste à les identifier.

**Axes de segmentation prioritaires** (pour un portefeuille auto) :

1. **Par produit / catégorie** — `LIBEPROD`, `LIBECATE`, `PRODUIT_RISQUE` (VP, VU, 2RM, flotte…)
2. **Par intermédiaire** — `LIBTYPIN` × `CODEINTE` (regrouper les top 20 individuellement, agréger la queue)
3. **Par zone géographique** — `VILLASSU` (zonier géographique)
4. **Par marque/type de véhicule** — `MARQVEHI` × `TYPEMOTE` × `PUISVEHI` (véhiculier)
5. **Par profil conducteur** — tranches d'âge (`DATEEFFE - NAISCOND`) × `SEXECOND`
6. **Par ancienneté du véhicule** — tranches d'âge véhicule (`DATEEFFE - DATE_MEC`)
7. **Par ancienneté de police** — affaires nouvelles (<1 an) vs fidèles (>5 ans)

Pour chaque axe, produire un tableau **Pareto** : trier par chiffre d'affaires décroissant, calculer le % cumulé. Règle du 80/20 : les 20% premiers segments représentent souvent 70–85% du CA.

Puis, identifier les segments **toxiques** (S/P > 100%, poids > 1% du CA) et les segments **premium** (S/P < 50%, marge significative).

### Étape 4 — Rétention, Churn et Valeur Client

**Rétention = KPI fondamental**. Un assureur non-vie perd en moyenne 12–18% de son portefeuille par an (marché marocain). Une dégradation de 2 points de rétention peut anéantir toute la rentabilité, car **le coût d'acquisition d'une nouvelle police = 1,5 à 3 fois le coût de fidélisation**.

Métriques clés :

```python
# Polices actives par exercice
actives_par_annee = df.groupby("EXERSTAT")["NUMEPOLI"].nunique()

# Taux de renouvellement = polices (N-1) ∩ polices (N) / polices (N-1)
def taux_renouv(df, annee):
    n_1 = set(df[df["EXERSTAT"] == annee - 1]["NUMEPOLI"].unique())
    n = set(df[df["EXERSTAT"] == annee]["NUMEPOLI"].unique())
    if not n_1:
        return np.nan
    return len(n_1 & n) / len(n_1)
```

Livrables pour le COMEX :
- Courbe d'attrition par année d'ancienneté (survival curve)
- Top 10 des segments avec le plus fort churn
- Estimation de la **Customer Lifetime Value (CLV)** approximative : `prime_moyenne × marge_technique × duration_moyenne`
- Impact simulé d'une amélioration de +2 pts de rétention sur le résultat technique à 3 ans

### Étape 5 — Tarification, Zonier et Véhiculier

Les colonnes `MARQVEHI`, `TYPEMOTE`, `PUISVEHI`, `VILLASSU`, `SEXECOND`, `NAISCOND`, `DATE_MEC` sont les **variables tarifaires classiques** en auto.

**Analyses à mener** (inspirées des mémoires actuariels Institut des Actuaires, voir `references/memoires_actuariels_cles.md`) :

**(a) Véhiculier** — regrouper les marques/modèles en classes de risque homogènes. Méthode : clustering (k-means sur features S/P, fréquence, coût moyen) ou CHAID. Livrer 5 à 10 classes de véhicules avec leur S/P relatif au portefeuille.

**(b) Zonier** — même logique pour `VILLASSU`. Méthodes : lissage spatial (krigeage, modèles de Gibbs) ou regroupement par similarité de risque. Pour le Maroc, commencer par un zonage à 4–6 zones (Grand Casa, Rabat-Salé, autres grandes villes, villes moyennes, rural nord, rural sud).

**(c) Modèle GLM** — si les données le permettent (fréquence et coût des sinistres disponibles), tarification par **Generalized Linear Models** (Poisson pour fréquence, Gamma pour sévérité). Sinon, analyse descriptive des primes moyennes par segment + détection des **anti-sélections**.

**(d) Détection d'anti-sélection** — identifier les segments où la prime moyenne appliquée est **inférieure** à la prime théorique de risque. Exemple : jeunes conducteurs sous-tarifés, véhicules haute puissance insuffisamment chargés, zones urbaines denses sous-chargées.

### Étape 6 — Risques Émergents

Les mémoires d'actuariat 2023–2026 (Institut des Actuaires) mettent en avant des risques que tout COMEX doit désormais adresser :

**(a) Inflation** — l'inflation des pièces détachées auto et de la main-d'œuvre carrossier dépasse largement l'inflation générale (≈ +8 à 12% par an sur la période récente). Impact direct sur le coût moyen des sinistres dommages. Le skill doit **simuler l'impact d'un choc d'inflation** sur le S/P projeté.

**(b) Véhicules électriques** — risque émergent : coût moyen sinistre VE > thermique (+30 à +60% selon études Allianz, Covéa). Identifier la part `TYPEMOTE = Électrique` et son évolution.

**(c) Climat** — grêle, inondations, tempêtes. Impact croissant sur la garantie dommages. Analyser la saisonnalité et les concentrations géographiques (`VILLASSU`).

**(d) Fraude** — détection d'anomalies statistiques : sinistres multiples sur police récente, concentrations suspectes par intermédiaire, etc. Nécessite la table sinistres.

**(e) Cyber** — pour les flottes connectées, risque émergent à anticiper.

**(f) Rachat / Résiliation conjoncturelle** — en contexte de taux élevés et pression sur le pouvoir d'achat, les résiliations pour raison économique augmentent. Modélisation : régression logistique résiliation ~ (prime, ancienneté, âge assuré, sinistralité).

### Étape 7 — IFRS 17 & SBR (Solvabilité)

Pour un portefeuille auto marocain en 2025–2026, deux exigences à intégrer :

**IFRS 17 (obligatoire 2025)** :
- Classification des contrats en **portefeuilles** homogènes (mêmes risques, mêmes politiques de gestion).
- Au sein de chaque portefeuille, découpage en **groupes de contrats** par rentabilité attendue : onéreux / sans risque significatif d'onérosité / profitables.
- Calcul du **CSM (Contractual Service Margin)** = marge de service contractuelle, libérée au fil du temps.
- Pour l'auto, majorité des contrats ≤ 1 an → éligibilité au **PAA (Premium Allocation Approach)**, modèle simplifié.

Le skill doit produire un **mapping indicatif** du portefeuille en groupes IFRS 17 et identifier les **groupes potentiellement onéreux** (S/P attendu > 100%).

**SBR (2026)** :
- Calcul du **SCR (Solvency Capital Requirement)** par sous-module de risque (souscription non-vie, marché, défaut, opérationnel).
- Pour l'auto : SCR souscription dominé par le risque de prime, le risque de réserve et le risque CAT (principalement tempête et grêle au Maroc).
- **ORSA** : auto-évaluation prospective à 3–5 ans, intégrant les stress tests (sinistralité, inflation, chute des placements).

Le skill produit un **proxy** de SCR Prime Auto selon la formule standard européenne adaptée :

```
SCR_Prime_Auto ≈ 3 × σ_prime × Volume_Primes
avec σ_prime ≈ 10% pour l'auto RC, 8% pour l'auto Dommages
```

### Étape 8 — Synthèse COMEX & Plan d'Action

**Format du livrable final** — un document structuré en 5 blocs, total ≤ 15 slides si présentation, ≤ 20 pages si document Word.

**Bloc 1 : Executive Summary (1 page)**
- 3 à 5 messages clés, quantifiés
- Verdict synthétique : situation actuelle + trajectoire attendue
- Top 3 des risques, Top 3 des opportunités

**Bloc 2 : État des Lieux (3–5 pages)**
- KPI techniques principaux (tableau de bord)
- Évolution sur 3–5 ans
- Comparaison aux benchmarks marché (ACAPS, FMSAR)

**Bloc 3 : Diagnostic par Segment (5–8 pages)**
- Cartographie de la rentabilité (matrice CA × Marge)
- Segments toxiques identifiés, avec impact financier chiffré
- Opportunités de croissance rentable

**Bloc 4 : Risques & Conformité (3–5 pages)**
- Synthèse des risques émergents applicables
- État de préparation IFRS 17 / SBR
- Gaps identifiés et plan de comblement

**Bloc 5 : Recommandations & Plan d'Action (2–3 pages)**
- Tableau de recommandations priorisées :

| # | Recommandation | Impact financier estimé | Effort | Owner | Échéance | KPI de suivi |
|---|---|---|---|---|---|---|
| 1 | Redresser le tarif zone X segment Y | +12 MAD M/an | Moyen | Dir. Tarification | T+6 mois | S/P zone X |
| 2 | Programme de rétention 55+ ans | +8 MAD M/an sur 3 ans | Faible | Dir. Commercial | T+3 mois | Taux renouv. |
| ... | ... | ... | ... | ... | ... | ... |

**Règle d'or** : aucune recommandation sans chiffrage d'impact. Un COMEX n'arbitre pas sur des intuitions.

---

## Style de Rédaction (Crucial)

**Niveau de langage** — professionnel, précis, sans jargon inutile. Si un terme technique est utilisé (ex. "stochasticité des rachats dynamiques"), le définir en une ligne la première fois.

**Tonalité** — assertive mais prudente. Un actuaire ne dit jamais "c'est certain" ; il dit "avec un intervalle de confiance de 95%, la fourchette est X–Y".

**Quantification** — systématique. Remplacer "significatif" par "+3,2 points de S/P" ou "+14 MAD M".

**Hiérarchie visuelle** — utiliser des tableaux récapitulatifs, pas des paragraphes denses. Le COMEX scanne ; il ne lit pas.

**Prudence professionnelle** — signaler explicitement les limites :
- Qualité des données (couverture, biais connus)
- Modélisations utilisées (hypothèses structurantes)
- Dépendances externes (sinistres non fournis, comptabilité non intégrée)

---

## Références Bundle

Le skill s'appuie sur trois fichiers de référence à consulter selon le besoin :

- **`references/memoires_actuariels_cles.md`** — synthèse des mémoires de l'Institut des Actuaires (2023–2026) les plus pertinents pour un portefeuille auto, avec leurs apports méthodologiques clés. À lire pour approfondir une méthodologie (GLM, zonier, impact inflation, IFRS 17…).
- **`references/benchmarks_marche.md`** — benchmarks sectoriels du marché marocain (ACAPS, FMSAR) et comparaisons internationales. À consulter pour toute analyse de positionnement concurrentiel.
- **`references/formules_actuarielles.md`** — formulaire des calculs actuariels standards (S/P, prime pure, provisionnement Chain-Ladder, SCR, CSM). À consulter en cas de doute sur une formule.

---

## Checklist Finale Avant Remise au COMEX

Avant de clôturer une analyse, vérifier :

- [ ] Toutes les conclusions quantifiées (en MAD ou %, pas de "beaucoup" / "peu")
- [ ] Toutes les limites méthodologiques explicitées
- [ ] Benchmarks marché mentionnés pour chaque KPI majeur
- [ ] Recommandations triées par impact, avec owner et échéance
- [ ] Pas plus de 5 messages clés dans l'executive summary (loi de Miller : 7±2)
- [ ] Graphiques épurés, pas de « chartjunk »
- [ ] Relecture critique « et alors ? » sur chaque slide : que fait-on de cette information ?

---

## Rappel Philosophique

> *"Le rôle de l'actuaire n'est pas de prédire l'avenir — nul ne le peut — mais d'éclairer la décision en quantifiant l'incertain."*

Dans ce skill, chaque chiffre doit **servir une décision**. Si une analyse ne mène à aucune recommandation actionnable, elle n'a pas sa place dans le livrable COMEX, même si elle est techniquement brillante.
