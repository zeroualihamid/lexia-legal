---
name: analyse-comptable-risque-opportunite
description: 'Agent IA expert‑comptable capable d’analyser les fichiers .parquet du
  grand‑livre et de la balance d’une entreprise, de détecter risques et opportunités,
  puis de proposer des stratégies d’amélioration basées sur les formules comptables
  et d’ingénierie financière.

  '
aliases:
- analyse comptable
- détection risque
- optimisation financière
- audit grand livre
- stratégie finance
---

# Analyse Comptable – Risques, Opportunités & Stratégies d’Amélioration

## Vue d'ensemble
Cette compétence permet à Brikz d’ingérer les fichiers **.parquet** contenant le
grand‑livre et la balance d’une société, de calculer l’ensemble des indicateurs
financiers classiques (liquidité, solvabilité, rentabilité, cash‑conversion‑cycle,
etc.) ainsi que des indicateurs avancés (DuPont, EBITDA, DSO/DPO, etc.).  
Sur la base de ces indicateurs, l’agent :

* identifie les **risques** (liquidité, endettement, conformité, fraude) ;
* met en lumière les **opportunités** d’optimisation (fonds de roulement,
  marges, coûts) ;
* génère des **recommandations stratégiques** (scénarios optimiste, réaliste,
  pessimiste) en s’appuyant sur des formules d’ingénierie financière.

## Scope data et axes analytiques
| Source | Format | Champs indispensables |
|--------|--------|------------------------|
| Grand‑livre | .parquet | `compte`, `date`, `débit`, `crédit`, `centre_cout`, `devise` |
| Balance | .parquet | `compte`, `solde`, `période`, `devise` |

**Axes d’analyse** (calculés automatiquement) :
- **Liquidité** : ratio courant, liquidité immédiate, cash‑conversion‑cycle, DSO, DPO.  
- **Solvabilité** : ratio d’endettement, couverture des intérêts, ratio de fonds propres.  
- **Rentabilité** : marge brute, marge opérationnelle, ROE, ROA, EBITDA.  
- **Efficacité opérationnelle** : rotation des stocks, rotation des créances, rotation des fournisseurs.  
- **Analyse DuPont** : décomposition du ROE.  
- **Analyse de variance** : écarts budgétaires, évolution YOY, tendance trimestrielle.  

## Règles métier
1. **Seuils d’alerte standard** (modifiable par l’utilisateur) :  
   - Liquidité courante < **1,5** → *Risque de liquidité* (sévérité : élevée).  
   - Ratio d’endettement > **60 %** → *Risque d’endettement* (sévérité : moyenne).  
   - DSO > **60 jours** → *Risque de recouvrement* (sévérité : élevée).  
   - Marge opérationnelle < **5 %** → *Opportunité d’amélioration de rentabilité*.  
2. **Détection de comptes anormaux** : variation > **30 %** d’un mois à l’autre sans justification → alerte possible fraude ou erreur de saisie.  
3. **Formules appliquées** :  
   - `CashConversionCycle = DSO + DIO - DPO`  
   - `DuPont_ROE = (Marge_Nette) × (Rotation_Actif) × (Levier_Financier)`  
   - `EBITDA = Résultat_Exploitation + Amortissements + Provisions`  
4. **Scénarios de recommandation** :  
   - **Optimiste** : amélioration de 10 % du cash‑conversion‑cycle, réduction de 5 % du DSO.  
   - **Réaliste** : amélioration de 5 % du cash‑conversion‑cycle, réduction de 2 % du DSO.  
   - **Pessimiste** : maintien des niveaux actuels avec mise en place de contrôles renforcés.  

## Format de sortie attendu
Le résultat est un **rapport Markdown** structuré comme suit :