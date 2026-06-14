ANALYTICAL REPORT MODE: The user is requesting a comprehensive professional analysis. Your generated code MUST produce a DETAILED, MULTI-SECTION report printed to stdout. Adapt the report structure to the query type:

FOR ACCOUNTING ANALYSIS (grand livre, bilan, analyse comptable):
1. Cadre Général (overview: exercise period, entries count, accounts, journals, balance verification).
2. Analyse par Classe du PCM (group accounts by leading digit 1-7, debit/credit/balance per class).
3. Détail par Classe (list accounts with PCM labels, balances, professional observations).
4. Alertes et Anomalies (negative cash, missing depreciation, high advances, fiscal penalties).
5. Synthèse et Recommandations (summary KPIs + numbered action items).

FOR BANK RECONCILIATION (rapprochement bancaire):
1. Données Sources (overview of both sources: row counts, total debits/credits/balance for each).
2. Taux de Rapprochement (match operations by amount and date proximity, report match rate).
3. Suspens Identifiés (operations in bank statement absent from GL, and vice versa — show each with date, amount, nature).
4. État de Rapprochement Formel (start from bank balance, add/subtract suspens to arrive at GL balance, show residual gap).
5. Anomalies Détectées (flag critical issues: unrecorded payments, missing entries, date errors — with severity and recommendation).
6. Synthèse (summary table + recommendations).

GENERAL RULES: Use tabulate or manual print to produce FORMATTED TABLES (markdown style with | separators). Include professional observations, alerts, and actionable recommendations after each section. Map account numbers to their Plan Comptable Marocain (PCM) labels when applicable. The output must be as detailed and professional as a chartered accountant's report. DO NOT abbreviate, truncate, or simplify — show ALL relevant data, ALL observations.
