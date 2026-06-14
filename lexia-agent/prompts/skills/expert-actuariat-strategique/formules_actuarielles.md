# Formulaire Actuariel — Référence Technique

Ce document rassemble les formules standard utilisées dans l'analyse d'un portefeuille d'assurance non-vie. À consulter lors de la rédaction du livrable COMEX.

---

## 1. Ratios Techniques Fondamentaux

### 1.1 Ratio Sinistres à Primes (Loss Ratio, S/P)

```
S/P = (Sinistres payés + ΔProvisions techniques) / Primes acquises
```

- **Primes acquises** ≠ Primes émises. Les primes sont acquises au prorata temporis sur la durée du contrat.
  ```
  Primes acquises (exercice N) = Primes émises (N) 
                                + Provision Primes Non Acquises (PNA) (N-1) 
                                − PNA (N)
  ```
- **Sinistres** incluent les sinistres survenus pendant l'exercice (payés + provisionnés).
- Exprimé en %.

### 1.2 Ratio de Frais (Expense Ratio)

```
Expense Ratio = (Commissions + Frais généraux d'acquisition + Frais de gestion) / Primes émises
```

Distinction :
- **Frais d'acquisition** : commissions, marketing, souscription.
- **Frais d'administration** : gestion des contrats.
- **Frais de règlement des sinistres** (souvent intégrés au S/P).

### 1.3 Ratio Combiné (Combined Ratio)

```
Combined Ratio (CR) = Loss Ratio + Expense Ratio
```

- **CR < 100%** : bénéfice technique (hors financier).
- **CR > 100%** : perte technique, à compenser par le rendement des placements.
- **Règle d'or** : CR stable à 95–98% pendant plusieurs années = assureur en excellente santé.

### 1.4 Ratio Opérationnel

```
Operating Ratio = Combined Ratio − (Rendement financier / Primes)
```

Inclut l'effet positif du rendement des placements.

---

## 2. Prime Pure et Prime Commerciale

### 2.1 Décomposition de la Prime

```
Prime Commerciale = Prime Pure 
                  + Chargements de sécurité 
                  + Chargements de gestion 
                  + Commissions 
                  + Taxes (ex. taxe d'assurance au Maroc)
```

### 2.2 Prime Pure

```
Prime Pure = Fréquence × Coût Moyen
         = (Nombre de sinistres / Exposition) × (Charge totale sinistres / Nombre de sinistres)
```

où **Exposition** est mesurée en police-années (1 police assurée 6 mois = 0,5 police-année).

### 2.3 Expected Loss Ratio (ELR)

```
ELR = Prime Pure / Prime Vendue (ou commerciale)
```

Benchmark auto : ELR ~ 60–70% est le niveau cible (après chargements et marge).

---

## 3. Modèles de Tarification (GLM)

### 3.1 Modèle de Fréquence (Poisson)

```
log(E[N_i]) = β_0 + Σ_j β_j × X_ij + log(exposition_i)
```

- `N_i` = nombre de sinistres du contrat i.
- `X_ij` = variables tarifaires (âge, puissance, zone…).
- `log(exposition_i)` = offset.

En Python (statsmodels) :
```python
import statsmodels.formula.api as smf
model_freq = smf.glm("nb_sinistres ~ age + puissance + C(zone)", 
                     data=df, 
                     family=sm.families.Poisson(),
                     offset=np.log(df["exposition"])).fit()
```

### 3.2 Modèle de Sévérité (Gamma ou Log-Normale)

```
log(E[Y_i | N_i > 0]) = γ_0 + Σ_j γ_j × X_ij
```

où `Y_i` est le coût moyen des sinistres du contrat i.

```python
model_sev = smf.glm("cout_moyen ~ age + puissance + C(zone)",
                    data=df[df["nb_sinistres"] > 0],
                    family=sm.families.Gamma(link=sm.families.links.log())).fit()
```

### 3.3 Prime Pure Tarifaire

```
Prime Pure Tarifaire_i = E[N_i] × E[Y_i | N_i > 0]
```

---

## 4. Provisionnement (Chain-Ladder & Variantes)

### 4.1 Chain-Ladder Déterministe

Notation : `C_{i,j}` = charge cumulée de l'année de survenance `i` à l'âge de développement `j`.

**Facteurs de développement** :
```
f_j = Σ_i C_{i,j+1} / Σ_i C_{i,j}
```

**Projection** :
```
C_{i,J} = C_{i,I-i} × Π_{k=I-i}^{J-1} f_k
```

où `J` est l'âge ultime et `I` la dernière année de survenance.

**IBNR (Incurred But Not Reported)** :
```
IBNR_i = C_{i,J} − C_{i,I-i}
```

### 4.2 Bornhuetter-Ferguson (BF)

Mélange Chain-Ladder et a priori (ELR expert) :
```
IBNR_i (BF) = Prime_i × ELR_i × (1 − 1/CDF_{I-i})
```

où `CDF_{I-i} = Π_k f_k` est le facteur de développement cumulé.

Utile quand les années récentes ont peu de recul.

### 4.3 Mack (Intervalle de Confiance)

Fournit une estimation analytique de l'erreur de prédiction (mean squared error), basée sur les hypothèses :
- Indépendance des années de survenance.
- Linéarité : `E[C_{i,j+1} | C_{i,j}] = f_j × C_{i,j}`.
- Variance proportionnelle : `Var(C_{i,j+1} | C_{i,j}) = σ_j² × C_{i,j}`.

Package Python : `chainladder`.

### 4.4 Code type

```python
import chainladder as cl
triangle = cl.Triangle(df, origin="annee_survenance", development="annee_dev", values="charge")
cl_model = cl.Chainladder().fit(triangle)
print(cl_model.ultimate_)
print(cl_model.ibnr_)
```

---

## 5. Solvabilité — SCR Formule Standard (Proxy Solvabilité 2 / SBR)

### 5.1 SCR Souscription Non-Vie (Non-Life Underwriting Risk)

Agrégation des sous-modules :

```
SCR_NL = sqrt( SCR_Prime_Réserve² + SCR_CAT² + 2 × ρ × SCR_Prime_Réserve × SCR_CAT )
```

avec ρ = 0,25 (coefficient de corrélation Solvabilité 2).

### 5.2 SCR Prime et Réserve

```
SCR_PR = 3 × σ × V
```

où :
- `V` = volume (primes acquises futures + provisions sinistres).
- `σ` = écart-type combiné :

```
σ² = (σ_prime × V_prime)² + (σ_res × V_res)² + 2 × ρ × σ_prime × V_prime × σ_res × V_res
V = V_prime + V_res
σ = (σ_prime × V_prime + σ_res × V_res) / V  [approximation simplifiée]
```

**Valeurs standard pour l'auto** (Solvabilité 2, annexe II) :
- σ_prime Auto RC ≈ 10%
- σ_prime Auto Dommages ≈ 8%
- σ_res Auto ≈ 9%
- ρ_prime_res ≈ 0,5

### 5.3 SCR Catastrophe Auto

Principalement tempête et grêle au Maroc.
Formule standard CAT Auto = somme calibrée par pays (pour le Maroc, adapter avec les calibrages ACAPS SBR).

### 5.4 Ratio de Couverture

```
Ratio SCR = Fonds Propres Éligibles / SCR
```

- **≥ 100%** : conforme.
- **≥ 150%** : confortable.
- **≥ 200%** : très solide, marge de manœuvre stratégique.

---

## 6. IFRS 17 — Formules Clés

### 6.1 Approche Générale (BBA — Building Block Approach)

```
LRC (Liability for Remaining Coverage) = PV(Flux futurs) + RA + CSM
```

où :
- **PV(Flux futurs)** = valeur actuelle probable des flux de trésorerie futurs.
- **RA (Risk Adjustment)** = ajustement pour risque non-financier.
- **CSM (Contractual Service Margin)** = marge de service contractuelle (profit non encore reconnu).

### 6.2 Approche PAA (Premium Allocation Approach) — Applicable à l'Auto

Simplifiée pour les contrats de durée ≤ 1 an :

```
LRC_PAA = Primes Non Acquises − Frais d'acquisition non amortis
```

Le LIC (Liability for Incurred Claims) reste évalué selon BBA.

### 6.3 Test d'Onérosité

Un groupe de contrats est **onéreux** si :
```
PV(Flux futurs) + RA > 0 à la date de souscription
```

Dans ce cas, la perte est reconnue immédiatement (pas de CSM).

### 6.4 Amortissement du CSM

Libéré sur la durée du contrat selon les **coverage units** (généralement proportionnel aux primes ou à la charge de travail).

---

## 7. Customer Lifetime Value (CLV)

Formule simplifiée :
```
CLV = Prime Moyenne × Marge Technique × (1 − (1−r)^n) / r
```

où :
- `r` = taux de rétention annuel (ex. 85% ⇒ `r` = 0,85, mais dans la formule `r` = taux d'attrition = 1 − 0,85 = 0,15).
- `n` = horizon d'analyse (typiquement 5–10 ans).

Version actualisée :
```
CLV = Σ_{t=1}^{n} [Prime × Marge × r^t] / (1 + d)^t
```

où `d` est le taux d'actualisation (typiquement WACC ou taux sans risque + prime).

---

## 8. Bonus-Malus (CRM — Coefficient de Réduction Majoration)

### 8.1 Formule France (à titre de comparaison)

```
CRM_{t+1} = CRM_t × 0,95^{1 si pas de sinistre responsable} × 1,25^{n sinistres responsables}
Plancher : 0,50 ; Plafond : 3,50
```

### 8.2 Maroc

Le Maroc n'a pas de Bonus-Malus **obligatoire** de type français, mais chaque assureur peut appliquer sa propre majoration après sinistralité. Vérifier les règles contractuelles internes.

---

## 9. Agrégation des Risques — Copules et Corrélations

Pour agréger des risques dépendants (nécessaire pour SCR) :

### 9.1 Approche Solvabilité 2 (Matrice de Corrélation)

```
SCR_agrégé = sqrt( Σ_i Σ_j ρ_{ij} × SCR_i × SCR_j )
```

Matrices de corrélation données par Solvabilité 2 (annexe IV).

### 9.2 Copules (Modèle Interne)

Pour une modélisation plus fine, utiliser des copules (gaussienne, Student, archimédienne) sur les rangs des pertes simulées.

---

## 10. Stress Tests ORSA — Scénarios Types

**Scénario 1 — Choc inflation** :
- Hypothèse : +5 points d'inflation des sinistres pendant 3 ans.
- Impact sur S/P, sur BEL (Best Estimate Liabilities), sur SCR.

**Scénario 2 — Choc sinistralité** :
- Hypothèse : +30% de sinistralité (ex. année catastrophique).
- Impact sur capital et sur continuité de l'activité.

**Scénario 3 — Choc marché** :
- Hypothèse : baisse des taux d'intérêt de 100 bps + chute actions de 30%.
- Impact sur rendement financier et sur valeur des placements.

**Scénario 4 — Choc combiné** (stress test sévère) :
- Combinaison des scénarios 1+2+3.
- Test du ratio SCR après choc.

---

## Rappel Méthodologique

**Toujours vérifier** :
- La **cohérence des périmètres** (primes acquises ≠ primes émises, sinistres survenus ≠ sinistres payés).
- Le **traitement des affaires cédées** (réassurance) : ratios bruts vs nets.
- La **normalisation temporelle** (lissage sur 3–5 ans pour neutraliser les années atypiques).

**Pour aller plus loin** :
- Norme Solvabilité 2 : Règlement délégué 2015/35.
- Norme IFRS 17 : IASB IFRS 17 Insurance Contracts (mai 2017, amendé 2020).
- Calibration SBR marocaine : instructions ACAPS (à consulter régulièrement).
