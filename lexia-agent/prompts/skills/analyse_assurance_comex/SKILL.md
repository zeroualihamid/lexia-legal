---
name: analyse-assurance-comex
description: 'Skill d’expert qui fournit aux membres du COMEX des indicateurs clés
  de performance (KPI) complets pour analyser la rentabilité, la sinistralité et l’évolution
  des produits d’assurance à partir des données de sinistres, de contrats et de primes.

  '
aliases:
- analyse comex
- kpi assurance
- performance assurance
- indicateurs sinistres
- tableau de bord assurance
---

# Analyse Assurance – Tableau de bord COMEX

## Vue d'ensemble
Ce skill agit comme un analyste senior spécialisé dans le secteur de l’assurance.  
Il agrège, calcule et interprète les principaux indicateurs de performance (KPI) afin de
permettre aux dirigeants du COMEX de :

* Suivre la rentabilité globale et par produit.
* Identifier les tendances de sinistralité (fréquence, gravité, évolution temporelle).
* Comparer les performances entre différents types d’intervenants, marques de véhicules,
  garanties et canaux de distribution.
* Détecter rapidement les anomalies ou dérives (hausse du taux de sinistres, baisse de la marge, etc.).
* Produire un tableau de bord synthétique (tableau Markdown) accompagné d’une courte analyse
  textuelle et, si souhaité, de suggestions de visualisations (barres, lignes, camembert).

---

## Scope data et axes analytiques
### Données attendues (au minimum)

| Champ | Description | Type attendu |
|-------|-------------|--------------|
| `type_sinistre` | Libellé du type de sinistre ou d'événement (ex. Automobile, Incendie) | texte |
| `type_garantie` | Libellé du type d'événement ou de garantie (ex. RC Autres Véhicules) | texte |
| `produit` | Libellé du produit, indiquant le type de véhicule (ex. Véhicule Divers) | texte |
| `categorie_produit` | Catégorie de produit d'assurance (ex. tourisme, 2‑3 roues) | texte |
| `type_intervenant` | Type d’intervenant (ex. Agent, Courtier) | texte |
| `raison_sociale` | Nom de la raison sociale (ex. assurance, client, fournisseur) | texte |
| `type_acte` | Type d’acte ou d’opération (ex. Affaire Nouvelle, Renouvellement) | texte |
| `marque_vehicule` | Marque du véhicule (ex. DACIA, VOLKSWAGEN) | texte |
| `date_sinistre` | Date à laquelle le sinistre a été déclaré | date |
| `montant_sinistre` | Montant réglé ou à régler pour le sinistre | numérique |
| `prime` | Prime perçue pour le contrat concerné | numérique |
| `date_contrat` | Date de souscription du contrat | date |
| `statut_contrat` | Statut du contrat (actif, résilié, suspendu) | texte |
| `region` | Région géographique du contrat ou du sinistre | texte |
| `client_id` | Identifiant unique du client | texte/numerique |
| `nbr_contrats` | Nombre de contrats (pour les agrégations) | numérique (calculé) |

> **Remarque** : Si certains champs (ex. `prime`, `date_contrat`, `statut_contrat`) ne sont pas présents dans votre source, le skill les ignorera et ajustera les KPI en conséquence.

### Axes d’analyse fréquents
* **Par type de sinistre** (Automobile, Incendie, Accident de Travail, …)
* **Par produit / catégorie de produit**
* **Par marque de véhicule**
* **Par type d’intervenant** (Agent, Courtier)
* **Par canal d’acte** (Nouvelle affaire, Renouvellement, Résiliation)
* **Par région géographique**
* **Par période** (mois, trimestre, année, glissement Y‑Y)

---

## Règles métier
1. **Filtrage standard**  
   - Exclure les sinistres dont `montant_sinistre` < 100 MAD (bruit statistique).  
   - Ne retenir que les contrats dont `statut_contrat = 'actif'` pour les KPI de rentabilité.  
   - Option `include_resiliated` permet d’inclure les contrats résiliés si l’utilisateur le demande.

2. **Périodes de référence**  
   - `periode_courante` : mois/trimestre/année en cours selon la requête.  
   - `periode_précédente` : même période N‑1 ou période glissante immédiatement précédente.  
   - Les comparaisons `%` sont calculées uniquement si les deux périodes contiennent au moins 30 enregistrements.

3. **Gestion des valeurs manquantes**  
   - `montant_sinistre` ou `prime` manquants sont traités comme 0 dans les agrégations.  
   - Les champs texte vides sont regroupés sous la catégorie « Inconnu ».

4. **Normalisation des libellés**  
   - Les libellés sont convertis en majuscules et les espaces superflus sont supprimés afin d’assurer une agrégation cohérente (ex. « Automobile », « AUTOMOBILE » → même groupe).

5. **Sécurité / confidentialité**  
   - Aucun identifiant personnel (`client_id`) n’est exposé dans la sortie.  
   - Les agrégations sont toujours au niveau de groupe (type, produit, région, période).

---

## Formules de calcul (KPI)

| KPI | Formule | Description |
|-----|---------|-------------|
| **Fréquence des sinistres (FS)** | `FS = NbSinistres / NbContrats` | Nombre moyen de sinistres par contrat. |
| **Sévérité moyenne (SM)** | `SM = SommeMontantSinistre / NbSinistres` | Montant moyen d’un sinistre. |
| **Loss Ratio (LR)** | `LR = SommeMontantSinistre / SommePrime` | Ratio perte / prime (indicateur de rentabilité). |
| **Combined Ratio (CR)** | `CR = (SommeMontantSinistre + FraisGestion) / SommePrime` | Ratio combiné (pertes + frais) / primes. |
| **Marge brute (MB)** | `MB = (SommePrime - SommeMontantSinistre) / SommePrime` | Part de la prime restant après paiement des sinistres. |
| **Taux de renouvellement (TR)** | `TR = NbRenouvellements / NbContratsFinPériode` | Proportion de contrats renouvelés. |
| **Churn (CH)** | `CH = NbRésiliations / NbContratsDébutPériode` | Taux de perte de clients. |
| **Evolution % (Δ%)** | `Δ% = (ValeurPériodeCourante - ValeurPériodePrécédente) / ValeurPériodePrécédente * 100` | Variation d’un KPI entre deux périodes. |
| **Délai moyen de règlement (DMR)** | `DMR = AVG(DateRèglement - DateSinistre)` | Temps moyen (en jours) entre déclaration et paiement. |
| **Ratio sinistres par type d’intervenant (RSI)** | `RSI = NbSinistres_Intervenant / NbContrats_Intervenant` | Fréquence selon Agent, Courtier, etc. |
| **Part de marché par produit (PMP)** | `PMP = NbContrats_Produit / NbContrats_Total` | Contribution du produit à l’ensemble du portefeuille. |
| **Indice de concentration (IC)** | `IC = Σ (PMP_i)^2` | Mesure de la concentration du portefeuille (plus proche de 1 = concentration forte). |
| **Prime moyenne par contrat (PMC)** | `PMC = SommePrime / NbContrats` | Valeur moyenne d’une prime. |
| **Ratio sinistres catastrophiques (RSC)** | `RSC = SommeMontantCatastrophe / SommePrime` | Impact des événements catastrophiques. |

> **Note** : `FraisGestion` représente les coûts opérationnels liés à la gestion du contrat (si disponible). S’il n’est pas présent, le KPI `Combined Ratio` se base uniquement sur les sinistres.

---

## Format de sortie attendu
1. **En‑tête** – rappel du périmètre (période, filtres appliqués).  
2. **Tableau Markdown** contenant les KPI demandés, avec deux colonnes : *Valeur* et *Variation %* (si comparaison possible).  
3. **Analyse textuelle** : 2‑3 phrases d’interprétation (ex. : “Le loss ratio a augmenté de 4 % ; la sévérité des sinistres automobile reste la plus élevée”).  
4. **Suggestions de visualisation** (optionnelles) :  
   * Barres – répartition du loss ratio par produit.  
   * Ligne – évolution mensuelle du nombre de sinistres.  
   * Camembert – part de marché par catégorie de produit.  

**Exemple de réponse** :