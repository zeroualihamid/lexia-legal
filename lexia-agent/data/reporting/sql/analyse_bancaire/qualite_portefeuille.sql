-- CTE — qualite_portefeuille
-- Catalogue reporting (généré)

qualite_portefeuille AS (
SELECT "Client Agence" AS agence, SUM(CASE WHEN "%Encours_RC" >= 0 THEN "%Encours_RC" ELSE 0 END) AS encours_sains, SUM(CASE WHEN "%Encours_RC" < 0 THEN "%Encours_RC" ELSE 0 END) AS encours_douteux FROM structure_financiere GROUP BY "Client Agence"
)
