-- CTE — repartition_geographique
-- Catalogue reporting (généré)

repartition_geographique AS (
SELECT "Reseau_DirectionRegional", "Reseau_Ville", SUM("%Encours_RC") AS encours, SUM("%Capitaux_Cred_RC") AS depots FROM productivite_clients GROUP BY "Reseau_DirectionRegional", "Reseau_Ville"
)
