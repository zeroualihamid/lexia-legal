-- CTE — evolution_temporelle
-- Catalogue reporting (généré)

evolution_temporelle AS (
SELECT "Year", "Quarter", "MonthName", SUM("%Encours_RC") AS encours, SUM("%Capitaux_Cred_RC") AS depots FROM repartition_geographique GROUP BY "Year", "Quarter", "MonthName" ORDER BY "Year", "MonthName"
)
