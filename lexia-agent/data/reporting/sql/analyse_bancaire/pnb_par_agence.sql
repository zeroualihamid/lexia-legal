-- CTE — pnb_par_agence
-- Catalogue reporting (généré)

pnb_par_agence AS (
SELECT "Client Agence" AS agence, COUNT(DISTINCT "Client_id") AS nb_clients, SUM("%Encours_RC") AS total_encours, SUM("%Capitaux_Cred_RC") AS total_capitaux_crediteurs, SUM("%Capitaux_Deb_RC") AS total_capitaux_debiteurs, SUM("%Encours_RC") * 0.05 + SUM("%Capitaux_Cred_RC") * 0.03 - ABS(SUM("%Capitaux_Deb_RC")) * 0.02 AS pnb_approx FROM "Analytics_Final" GROUP BY "Client Agence" ORDER BY pnb_approx DESC
)
