"""French audit specification for the ``contrats`` table (LLM input)."""

CONTRATS_AUDIT_SQL_PROMPT = """Tu es un expert SQL spécialisé en audit financier et comptable.
Je dispose d'une table nommée `contrats` avec la structure suivante (chaque colonne est décrite) :

- EXERSTAT : année d'exercice comptable (AAAA)
- MOISSTAT : mois de l'exercice (1 à 12)
- CODEBRAN : code branche d'activité
- LIBEBRAN : libellé branche
- CODECATE : code catégorie risque
- LIBECATE : libellé catégorie
- CODEPROD : code produit
- LIBEPROD : libellé produit
- PRODRISQ : code produit risque
- PRODUIT_RISQUE : libellé produit risque
- CODTYPIN : code type intervenant (A, D, C…)
- LIBTYPIN : libellé type intervenant (Agent, Courtier…)
- CODEINTE : code assureur/intermédiaire
- RAISOCIN : raison sociale
- CODEACTE : code acte d'assurance
- LIBEACTE : libellé acte
- FLAGSOCI : indicateur type société (P, S)
- IDENQUIT : identifiant unique quittance
- DATEEFFE : date d'effet
- DATE_FIN : date fin garantie
- DATECOMP : date comptabilisation
- CODECOMP : code commission/comptabilité
- STATQUIT : statut quittance (numérique)
- DATESTAT : date mise à jour statut
- PRIMNETT : prime nette (en devise)
- COAS_CIE : indicateur COAS
- NUMEPOLI : numéro de police
- NOM_ASSU : nom assuré
- VILLASSU : code ville assuré
- VILLINTE : code ville intermédiaire
- CODECONV : code convention
- TYPECONT : type contrat (1,2…)
- CODEPERI : périodicité (TRIM, ANN, SEMS, MENS)
- PRIM__RC : prime responsabilité civile
- MARQVEHI : marque véhicule
- TYPEMOTE : type moteur (Essence, Diesel)
- PUISVEHI : puissance véhicule
- SEXECOND : sexe assuré
- REDUSAHA : réduction (O/N)
- DATE_MEC : date mise en circulation
- NAISCOND : date naissance conducteur
- COMMQUIT : commission (pourcentage)

Je souhaite que tu génères des **Common Table Expressions (CTEs) reliées en chaîne linéaire** pour répondre aux questions de contrôle suivantes (posées par un expert-comptable) :

1. La prime nette (`PRIMNETT`) est-elle systématiquement positive et cohérente avec la prime RC (`PRIM__RC`) ? (PRIMNETT >= PRIM__RC)
2. Y a-t-il des quittances avec prime non nulle mais commission à zéro ? Est-ce justifié ?
3. La commission est-elle cohérente avec le type d'intervenant (détecter les taux anormalement élevés ou faibles) ?
4. Existe-t-il des incohérences temporelles : date fin < date effet ?
5. Des statuts modifiés avant la date d'effet (`DATESTAT < DATEEFFE`) ?
6. Quelles branches/produits génèrent les primes les plus élevées avec commissions les plus basses ?
7. Concentration des primes par type d'intervenant (risque de dépendance) ?
8. Y a-t-il des IDENQUIT en double ?
9. Le numéro de police (`NUMEPOLI`) suit-il un format standard (ex: codeinter.produit.serial) ?
10. Y a-t-il des pics de souscription en fin d'exercice (MOISSTAT=12) ?
11. Variation annuelle des primes par branche > 20% ?
12. Pour l'automobile : des véhicules puissants avec prime anormalement basse ?
13. Conducteur mineur à la date de mise en circulation (NAISCOND trop jeune par rapport à DATE_MEC) ?
14. Réduction (`REDUSAHA`='O') accordée à un conducteur de moins de 25 ans ?
15. Champs obligatoires manquants (CODECATE, CODEINTE, DATEEFFE, PRIMNETT) ?
16. Exercice comptable incohérent avec l'année de DATECOMP ?
17. Quittances comptabilisées très tardivement par rapport à la date d'effet (délai > 30 jours) ?

## Chaîne d'exécution obligatoire (graphe de dépendances et optimisation)

- La **première** CTE du WITH doit s'appeler par exemple `contrats_base` et être **la seule** à lire directement la table `contrats` : `SELECT … FROM contrats` (conserve toutes les colonnes nécessaires aux contrôles suivants, typiquement `SELECT *` ou projection large).
- Chaque CTE suivante (une par question ci-dessus, dans le **même ordre** dans la clause `WITH`) doit obligatoirement prendre sa source **uniquement** dans la CTE **immédiatement précédente** dans la liste : utilise `FROM <nom_cte_precedent>` (alias autorisé). **Interdit** de réécrire `FROM contrats` après `contrats_base`.
- Pour les agrégations ou filtres qui ne concernent qu'un sous-ensemble, pars toujours de la CTE précédente (`FROM prev AS p`) ; tu peux utiliser des sous-requêtes ou `CROSS JOIN` si besoin, tant que le nom de la CTE précédente apparaît dans le corps SQL pour créer la dépendance.
- Noms de CTE explicites (ex. `incoherent_primes`, `zero_commission`, …) dans l'ordre 1→17 ; la dépendance linéaire prime sur le libellé : `incoherent_primes` dépend de `contrats_base`, la suivante dépend de `incoherent_primes`, etc.

Pour chaque question, la CTE correspondante inclut les colonnes pertinentes pour l'analyse (IDENQUIT, NUMEPOLI, et les champs incriminés).
Ajoute des commentaires en français expliquant le but.
Utilise une syntaxe SQL standard (compatible PostgreSQL/MySQL 8+).
Enfin, propose un exemple d'utilisation combinée de toutes les CTEs feuilles ou des résultats d'anomalie (UNION ALL) pour lister les anomalies en une seule requête.

Génère uniquement le code SQL, sans texte superflu."""
