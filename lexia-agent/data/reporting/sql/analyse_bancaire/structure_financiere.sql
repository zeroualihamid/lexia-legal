-- CTE — structure_financiere
-- Catalogue reporting (généré)

structure_financiere AS (
SELECT SUM("%Capitaux_Cred_RC") AS capitaux_crediteurs, SUM("%Capitaux_Deb_RC") AS capitaux_debiteurs, SUM("%Encours_RC") AS encours_total, SUM("%Solde_RC") AS solde_net FROM mni_par_agence
)
