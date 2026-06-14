-- CTE — productivite_clients
-- Catalogue reporting (généré)

productivite_clients AS (
SELECT "Client Agence" AS agence, COUNT(DISTINCT "Client_id") AS nb_clients, COUNT(DISTINCT CASE WHEN "Client Actif" = 1 THEN "Client_id" END) AS clients_actifs, SUM("%Encours_RC") / NULLIF(COUNT(DISTINCT "Client_id"), 0) AS encours_moyen_client FROM qualite_portefeuille GROUP BY "Client Agence"
)
