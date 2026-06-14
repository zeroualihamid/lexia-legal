# Mémoires d'Actuariat — Synthèse des Sources Pertinentes

Source principale : [Institut des Actuaires — Mémoires d'Actuariat](https://www.institutdesactuaires.com/se-documenter/memoires/memoires-d-actuariat-4651).

Ce document regroupe les mémoires les plus pertinents pour l'analyse d'un portefeuille d'assurance non-vie, principalement automobile. Les mémoires sont classés par thématique.

---

## 1. Tarification Automobile & Segmentation

| Auteur | Année | Société | Titre (résumé) | Apport clé |
|---|---|---|---|---|
| ABIDA S. | 2025 | Generali France | Tarification traité de réassurance auto RC | Modélisation de la sévérité extrême, théorie des valeurs extrêmes appliquée à la RC auto |
| BEDOUI S. | 2025 | Covéa | Construction d'un zonier grêle en auto | Méthodes de lissage spatial, agrégation de zones homogènes |
| GUETTOUCHE K. | 2025 | Pacifica | Construction d'un véhiculier | Clustering de marques/modèles, classes de risque |
| DOMAVO T. | 2025 | Generali France | Véhiculier + Machine Learning interprétable | SHAP values, GAM, intégration explicabilité |
| BITAR R. | 2025 | Finactys | Intégration mobilité dans tarification auto | Nouvelles variables : usage, télématique |
| BONNART E. | 2025 | Addactis | Machine Learning pour tempête MRH | Transfert auto : détection zones à risque |
| CLEMENT O. | 2025 | AXA France IARD | Fréquence sinistralité MRH par ML | Gradient Boosting, validation croisée |
| BEN HASSINE O. | 2025 | Allianz France | Prime pure a posteriori sinistres graves flottes | Méthodes robustes pour queue de distribution |

**Méthodologie recommandée pour un zonier auto** (synthèse) :
1. Agréger les sinistres par commune/ville sur 3–5 ans (lisser la volatilité).
2. Calculer le S/P relatif par zone (rapport au S/P portefeuille).
3. Lisser spatialement (krigeage, modèles CAR de Besag).
4. Clustering hiérarchique pour regrouper en 5–10 zones homogènes.
5. Valider la stabilité par bootstrap.

---

## 2. Impact de l'Inflation

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| AZIEZE R. | 2025 | SeaBird Conseil | Impact de l'inflation sur un portefeuille auto | **Mémoire central pour le contexte 2023–2026** |
| BROU Y. | 2025 | Aprecialis | Inflation & rentabilité construction IFRS 17 | Transposition méthodologique utile |
| CHAUVEAU P. | 2025 | Forvis Mazars | Conjoncture économique & assureur crédit | Choc macro sur primes et sinistres |

**Points clés à retenir pour un portefeuille auto** :
- L'inflation des **pièces détachées** (+10 à 15% en 2022–2024) impacte directement le coût moyen des sinistres dommages matériels.
- L'inflation de la **main-d'œuvre carrossier** suit l'inflation salariale (+5 à 8%).
- L'inflation **médicale** impacte les indemnités corporelles RC (+6 à 10%).
- Les **primes**, elles, sont encadrées réglementairement et par la concurrence — leur hausse est plus lente.
- Résultat : **érosion mécanique du S/P** si aucune action tarifaire.

**Formule d'impact simplifiée** :
```
ΔS/P = (1 + inflation_sinistres)^n / (1 + inflation_primes)^n − 1
```
Pour n=3 ans, inflation_sinistres=8%, inflation_primes=3% → ΔS/P ≈ +15 points.

---

## 3. Rentabilité, Persistance et Rétention

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| BEAUPOIL M. (archive) | 2017 | AXA France | Stratégie de hausses tarifaires à l'échéance anniversaire | Modélisation conjointe tarif × résiliation |
| DÉSERT V. (archive) | ~2015 | MMA IARD | Rentabilité des intermédiaires | Modèle de ratio combiné par agent, volatilité |
| JALABERT T. | 2025 | Swiss Life France | Rachats conjoncturels en assurance-vie | Transposable aux résiliations non-vie |
| KADDOURI Y. | 2025 | Generali France | Rachats dynamiques en contexte taux hauts | Modèle logistique sensibilité prix |

**Concept clé : Expected Loss Ratio (ELR)** — prime pure / prime vendue. Si ELR > seuil de rentabilité (typiquement 60–70% en auto selon les chargements), le segment est structurellement perdant.

**Modélisation rétention** :
```python
import statsmodels.api as sm
# Variables : hausse_tarif_pct, anciennete_annees, age_assure, sinistralite_3ans
features = ["hausse_tarif_pct", "anciennete", "age", "sinistralite"]
X = sm.add_constant(df[features])
y = df["resilie"]  # 1 = résilié, 0 = renouvelé
model = sm.Logit(y, X).fit()
print(model.summary())
```

---

## 4. Provisionnement (IBNR, Chain-Ladder, Alternatives)

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| EL BOUDAATI B. | 2025 | Sogecap | Provisions IBNR en prévoyance (méthodo) | Transposable non-vie |
| ESSANGA ANGAH J. | 2025 | France Mutuelle | Provisionnement sans triangle en santé | Méthodes bayésiennes, utiles si historique court |
| ALAMEDDINE K. | 2025 | Groupama | Chroniques S/P par LoB sous Solvabilité 2 | Modélisation stochastique |
| GAUDIN J. | 2025 | CCR Re | Sévérité extrême en réassurance | GPD, Peaks-Over-Threshold |

**Méthodes classiques** (dans l'ordre de sophistication croissante) :
1. **Chain-Ladder déterministe** — standard, simple, mais ne donne pas d'intervalle de confiance.
2. **Bornhuetter-Ferguson (BF)** — meilleur pour les années récentes avec peu de recul.
3. **Mack (stochastique)** — intervalle de confiance analytique.
4. **Bootstrap / GLM ODP** — simulation complète de la distribution.
5. **Méthodes bayésiennes** — intégration de jugement d'expert, adaptées si historique court.

---

## 5. IFRS 17 & Solvabilité

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| CHAOUACHI A. | 2025 | Groupama | Correction effet Bow Wave en IFRS 17 | Détails techniques CSM |
| DIALLO M. | 2025 | CNP Assurances | Bow Wave pour Business Plan IFRS 17 | Projection CSM multi-années |
| DAVID V. | 2025 | Addactis | Gestion multi-devise en IFRS 17 | Pertinent pour groupes internationaux |
| DOBRESCO L. | 2025 | Mazars Actuariat | Stress test climatique ORSA | Méthodologie ORSA climat |
| ABLET A. | 2025 | Fractales | Transition énergétique & SCR | Scénarios de transition |
| DEGASNE M. | 2025 | AGPM | Marge de risque & simplifications | Règlement délégué S2 |

**Mapping IFRS 17 simplifié pour un portefeuille auto** :

```
Portefeuille d'Assurance Auto
  ├── Groupe 1 : Contrats onéreux à la souscription
  ├── Groupe 2 : Contrats sans risque significatif d'onérosité
  └── Groupe 3 : Contrats profitables
  
Cohortes annuelles (une par exercice de souscription)
Modèle applicable : PAA (Premium Allocation Approach), éligible si durée ≤ 1 an.
```

**SCR Souscription Non-Vie — Sous-modules clés** (formule standard européenne) :
- Risque de prime et de réserve (volume × σ)
- Risque de catastrophe (tempête, grêle, inondation pour auto)
- Risque de rachat (faible en auto)

---

## 6. Risques Émergents : Climat, Véhicules Électriques, Cyber

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| CURABE J. | 2025 | Allianz | Risque VE vs thermique | **Crucial : +30 à 60% sur sinistre moyen** |
| ATTIEN E. | 2025 | Direct Assurances | Modélisation dommages grêle | Agrégation des risques climatiques |
| AUGER A. | 2025 | Accenture | Inondations & changement climatique | Scénarios RCP, projection 2050 |
| BELEM I. | 2025 | Generali | Modélisation climatique MRH | Transposable auto dommages |
| BLANC L. | 2025 | Groupama RAA | Tempête-Grêle | Expérience locale précieuse |
| DELELIS-FANIEN A. | 2025 | SeaBird | Tarification cyber micro-économique | Pour flottes connectées |
| GOUDEAU L. | 2025 | Relyens | Cyber assurance collectivités | Questionnaire de risque |
| GANOU VOUTSA R. | 2025 | Linkpact | Température & mortalité | Pour la partie vie, complément |

**Points clés véhicules électriques** (CURABE 2025) :
- Coût moyen sinistre VE > thermique de +30 à +60%.
- Causes : batterie (30–50% du prix du véhicule), technicité des réparations, coût des pièces électroniques, faible densité du réseau de réparateurs agréés.
- Fréquence de sinistres similaire à thermique, voire légèrement supérieure (voiture puissante, silencieuse).
- **Implication tarifaire** : si pas de surprime VE, c'est une anti-sélection massive qui se met en place.

---

## 7. Machine Learning en Assurance Non-Vie

| Auteur | Année | Société | Titre | Apport clé |
|---|---|---|---|---|
| CHAHWANE G. | 2025 | AXA France | Provisionnement par apprentissage | Comparaison ML vs méthodes classiques |
| CLEMENT O. | 2025 | AXA France IARD | Fréquence MRH par ML | Interprétabilité (SHAP) |
| CHOUSSAT T. | 2025 | SMA BTP | LLM pour gestion financière | Cas d'usage émergents |
| EZ-ZIANI N. | 2025 | Addactis | IA & bases publiques pour tarification | Enrichissement de données |
| DOUMBIA F. | 2025 | Generali | LLM pour risque tempête MRH | Processing de données non structurées |

**Recommandations pratiques** :
- **Gradient Boosting** (XGBoost, LightGBM) : très efficace pour la fréquence et la sévérité, avec des gains de 5–15% d'AUC vs GLM.
- **Interprétabilité obligatoire** (contraintes réglementaires AMF/ACAPS) : utiliser SHAP ou LIME.
- **Validation** : bien stratifier, éviter le data leakage, toujours comparer au GLM de référence.
- **Production** : monitoring de dérive (PSI, CSI, stabilité des prédictions).

---

## Comment Utiliser cette Référence

Pour approfondir une méthodologie dans le cadre d'une mission :
1. Identifier le thème dans les sections ci-dessus.
2. Rechercher le mémoire sur [institutdesactuaires.com/se-documenter/memoires/memoires-d-actuariat-4651](https://www.institutdesactuaires.com/se-documenter/memoires/memoires-d-actuariat-4651) par auteur.
3. Les mémoires sont librement consultables (PDF), sous réserve d'inscription pour certains.
4. Citer la source dans le livrable final (bibliographie).
