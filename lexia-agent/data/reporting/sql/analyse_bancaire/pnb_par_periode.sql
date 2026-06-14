-- CTE — pnb_par_periode
-- Catalogue reporting (généré)

pnb_par_periode AS (
SELECT "Year", "MonthName", SUM("%Encours_RC") * 0.05 + SUM("%Capitaux_Cred_RC") * 0.03 - ABS(SUM("%Capitaux_Deb_RC")) * 0.02 AS pnb_approx FROM pnb_par_agence GROUP BY "Year", "MonthName"
)
