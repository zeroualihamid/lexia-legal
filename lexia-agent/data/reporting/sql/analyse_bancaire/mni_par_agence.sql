-- CTE — mni_par_agence
-- Catalogue reporting (généré)

mni_par_agence AS (
SELECT "Client Agence" AS agence, SUM("%Capitaux_Cred_RC" * "%NbJour_Month" / 360 * 0.05) - SUM("%Capitaux_Deb_RC" * "%NbJour_Month" / 360 * 0.10) AS mni_estimee FROM pnb_par_periode GROUP BY "Client Agence"
)
