"""
analyse_portefeuille.py
=======================
Boîte à outils Python pour l'analyse stratégique d'un portefeuille d'assurance
non-vie (principalement auto) basée sur la structure de données `ca_view_dto.py`.

Usage :
    from scripts.analyse_portefeuille import (
        charger_donnees, profilage, dq_checks,
        kpi_techniques, segmentation_pareto,
        analyse_retention, detection_anti_selection,
        simuler_choc_inflation, rapport_comex
    )

    df = charger_donnees("ca_view.csv")
    dq = dq_checks(df)
    kpis = kpi_techniques(df)
    seg = segmentation_pareto(df, axe="LIBEPROD")
    ...

Dépendances : pandas, numpy, matplotlib (optionnel).
"""

from __future__ import annotations
import pandas as pd
import numpy as np
from datetime import datetime
from typing import Optional


# ============================================================================
# 0. INGESTION
# ============================================================================

def charger_donnees(chemin: str, sep: str = ";", encoding: str = "utf-8-sig") -> pd.DataFrame:
    """Charge le fichier quittances et applique les conversions standard."""
    ext = chemin.split(".")[-1].lower()
    if ext == "csv":
        df = pd.read_csv(chemin, sep=sep, encoding=encoding, low_memory=False)
    elif ext in ("xlsx", "xls"):
        df = pd.read_excel(chemin)
    elif ext == "parquet":
        df = pd.read_parquet(chemin)
    else:
        raise ValueError(f"Extension non supportée : {ext}")

    # Conversion dates
    date_cols = ["DATEEFFE", "DATE_FIN", "DATECOMP", "DATESTAT", "DATE_MEC", "NAISCOND"]
    for c in date_cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], errors="coerce", dayfirst=True)

    # Conversion montants
    for c in ["PRIMNETT", "PRIM__RC", "COMMQUIT"]:
        if c in df.columns and df[c].dtype == "object":
            df[c] = pd.to_numeric(
                df[c].astype(str).str.replace(",", ".").str.replace(" ", ""),
                errors="coerce",
            )

    return df


# ============================================================================
# 1. PROFILAGE & QUALITÉ DES DONNÉES
# ============================================================================

def profilage(df: pd.DataFrame) -> dict:
    """Synthèse rapide du dataset."""
    res = {
        "nb_lignes": len(df),
        "nb_colonnes": df.shape[1],
        "periode_exersat": (int(df["EXERSTAT"].min()), int(df["EXERSTAT"].max()))
                            if "EXERSTAT" in df.columns else None,
        "nb_polices": df["NUMEPOLI"].nunique() if "NUMEPOLI" in df.columns else None,
        "nb_quittances": df["IDENQUIT"].nunique() if "IDENQUIT" in df.columns else None,
        "repartition_branche": df["LIBEBRAN"].value_counts().to_dict()
                                if "LIBEBRAN" in df.columns else None,
        "repartition_acte": df["LIBEACTE"].value_counts().to_dict()
                             if "LIBEACTE" in df.columns else None,
    }
    if "PRIMNETT" in df.columns:
        res["prime_totale"] = float(df["PRIMNETT"].sum())
        res["prime_moyenne"] = float(df["PRIMNETT"].mean())
    return res


def dq_checks(df: pd.DataFrame) -> pd.DataFrame:
    """Contrôles Data Quality. Retourne un DataFrame de résultats."""
    checks = []

    # 1. Cohérence dates
    if {"DATE_FIN", "DATEEFFE"}.issubset(df.columns):
        nb_ko = (df["DATE_FIN"] <= df["DATEEFFE"]).sum()
        checks.append(("Cohérence DATE_FIN > DATEEFFE", nb_ko, len(df)))

    # 2. Âge conducteur
    if {"DATEEFFE", "NAISCOND"}.issubset(df.columns):
        age = (df["DATEEFFE"] - df["NAISCOND"]).dt.days / 365.25
        nb_ko = ((age < 18) | (age > 100)).sum()
        checks.append(("Âge conducteur ∈ [18, 100]", nb_ko, len(df)))

    # 3. Âge véhicule
    if {"DATEEFFE", "DATE_MEC"}.issubset(df.columns):
        age_veh = (df["DATEEFFE"] - df["DATE_MEC"]).dt.days / 365.25
        nb_ko = ((age_veh < 0) | (age_veh > 50)).sum()
        checks.append(("Âge véhicule ∈ [0, 50]", nb_ko, len(df)))

    # 4. Prime nette positive sur actes de production
    if {"PRIMNETT", "LIBEACTE"}.issubset(df.columns):
        actes_prod = df["LIBEACTE"].isin(["Affaire Nouvelle", "Renouvellement"])
        nb_ko = ((df["PRIMNETT"] <= 0) & actes_prod).sum()
        checks.append(("Prime nette > 0 sur production", nb_ko, actes_prod.sum()))

    # 5. Unicité IDENQUIT
    if "IDENQUIT" in df.columns:
        nb_doublons = df["IDENQUIT"].duplicated().sum()
        checks.append(("Unicité IDENQUIT", nb_doublons, len(df)))

    # 6. Commission cohérente (8%-22%)
    if {"COMMQUIT", "PRIMNETT"}.issubset(df.columns):
        ratio = df["COMMQUIT"] / df["PRIMNETT"].replace(0, np.nan)
        nb_ko = ((ratio < 0.05) | (ratio > 0.25)).sum()
        checks.append(("Ratio commission ∈ [5%, 25%]", nb_ko, len(df)))

    # 7. Branche auto ⇒ marque véhicule
    if {"LIBEBRAN", "MARQVEHI"}.issubset(df.columns):
        auto = df["LIBEBRAN"].str.contains("auto", case=False, na=False)
        nb_ko = (auto & df["MARQVEHI"].isna()).sum()
        checks.append(("Auto ⇒ Marque renseignée", nb_ko, auto.sum()))

    res = pd.DataFrame(checks, columns=["Contrôle", "Anomalies", "Total"])
    res["Taux_anomalie_%"] = (res["Anomalies"] / res["Total"] * 100).round(2)
    return res


# ============================================================================
# 2. KPI TECHNIQUES
# ============================================================================

def kpi_techniques(df: pd.DataFrame, df_sinistres: Optional[pd.DataFrame] = None) -> dict:
    """
    Calcule les KPI techniques. Si `df_sinistres` est fourni (avec NUMEPOLI et
    CHARGE_SINISTRES), calcule le vrai S/P. Sinon, retourne les KPI primes uniquement.
    """
    kpis = {}

    # (a) Chiffre d'affaires
    kpis["prime_totale_nette"] = float(df["PRIMNETT"].sum())
    kpis["prime_moyenne"] = float(df["PRIMNETT"].mean())
    kpis["nb_quittances"] = len(df)
    kpis["nb_polices"] = df["NUMEPOLI"].nunique() if "NUMEPOLI" in df.columns else None

    # (b) Par type d'acte
    if "LIBEACTE" in df.columns:
        kpis["primes_par_acte"] = df.groupby("LIBEACTE")["PRIMNETT"].sum().to_dict()

    # (c) Prime moyenne par exercice
    if "EXERSTAT" in df.columns:
        kpis["prime_moyenne_par_exercice"] = df.groupby("EXERSTAT")["PRIMNETT"].mean().to_dict()
        kpis["prime_totale_par_exercice"] = df.groupby("EXERSTAT")["PRIMNETT"].sum().to_dict()

    # (d) Taux de commission
    if "COMMQUIT" in df.columns:
        total_comm = df["COMMQUIT"].sum()
        total_prim = df["PRIMNETT"].sum()
        kpis["taux_commission_moyen"] = float(total_comm / total_prim) if total_prim else None
        if "LIBTYPIN" in df.columns:
            kpis["taux_commission_par_type"] = (
                df.groupby("LIBTYPIN")
                  .apply(lambda g: g["COMMQUIT"].sum() / g["PRIMNETT"].sum() if g["PRIMNETT"].sum() else 0)
                  .to_dict()
            )

    # (e) S/P si sinistres fournis
    if df_sinistres is not None and "NUMEPOLI" in df_sinistres.columns:
        # Agrégation sinistres par police
        sin_par_police = df_sinistres.groupby("NUMEPOLI")["CHARGE_SINISTRES"].sum()
        primes_par_police = df.groupby("NUMEPOLI")["PRIMNETT"].sum()
        sp_global = sin_par_police.sum() / primes_par_police.sum()
        kpis["ratio_SP_global"] = float(sp_global)
    else:
        kpis["ratio_SP_global"] = "NON CALCULABLE (table sinistres non fournie)"

    return kpis


# ============================================================================
# 3. SEGMENTATION PARETO
# ============================================================================

def segmentation_pareto(df: pd.DataFrame, axe: str, top: int = 20) -> pd.DataFrame:
    """
    Segmentation Pareto du portefeuille par un axe donné.
    Retourne un DataFrame trié par CA décroissant avec le % cumulé.
    """
    if axe not in df.columns:
        raise KeyError(f"Colonne {axe} absente du dataset.")

    agg = df.groupby(axe).agg(
        nb_quittances=("PRIMNETT", "count"),
        prime_totale=("PRIMNETT", "sum"),
        prime_moyenne=("PRIMNETT", "mean"),
        nb_polices=("NUMEPOLI", "nunique") if "NUMEPOLI" in df.columns else ("PRIMNETT", "count"),
    ).sort_values("prime_totale", ascending=False)

    agg["part_pct"] = (agg["prime_totale"] / agg["prime_totale"].sum() * 100).round(2)
    agg["part_cumul_pct"] = agg["part_pct"].cumsum().round(2)
    return agg.head(top)


# ============================================================================
# 4. RÉTENTION / CHURN
# ============================================================================

def analyse_retention(df: pd.DataFrame) -> pd.DataFrame:
    """Taux de renouvellement année par année (exercice N ∩ N-1 / N-1)."""
    if not {"EXERSTAT", "NUMEPOLI"}.issubset(df.columns):
        raise KeyError("Colonnes EXERSTAT et NUMEPOLI requises.")

    exercices = sorted(df["EXERSTAT"].dropna().unique())
    res = []
    for i in range(1, len(exercices)):
        n_1 = set(df[df["EXERSTAT"] == exercices[i-1]]["NUMEPOLI"].unique())
        n = set(df[df["EXERSTAT"] == exercices[i]]["NUMEPOLI"].unique())
        if not n_1:
            continue
        taux = len(n_1 & n) / len(n_1)
        res.append({
            "exercice": exercices[i],
            "polices_N_1": len(n_1),
            "polices_N": len(n),
            "polices_conservees": len(n_1 & n),
            "taux_renouvellement": round(taux, 4),
            "taux_churn": round(1 - taux, 4),
        })
    return pd.DataFrame(res)


# ============================================================================
# 5. DÉTECTION D'ANTI-SÉLECTION
# ============================================================================

def detection_anti_selection(df: pd.DataFrame, segment_cols: list[str]) -> pd.DataFrame:
    """
    Détecte les segments où la prime moyenne est anormalement basse par rapport
    à la médiane portefeuille. À coupler avec les données de sinistralité pour
    une vraie anti-sélection.
    """
    prime_med = df["PRIMNETT"].median()
    agg = df.groupby(segment_cols).agg(
        nb=("PRIMNETT", "count"),
        prime_moy=("PRIMNETT", "mean"),
        prime_med=("PRIMNETT", "median"),
    )
    agg["ecart_vs_median_pct"] = ((agg["prime_moy"] - prime_med) / prime_med * 100).round(2)
    agg["flag_sous_tarification"] = agg["ecart_vs_median_pct"] < -20
    return agg.sort_values("ecart_vs_median_pct")


# ============================================================================
# 6. SIMULATION CHOC INFLATION
# ============================================================================

def simuler_choc_inflation(
    sp_actuel: float,
    inflation_sinistres_annuelle: float = 0.08,
    inflation_primes_annuelle: float = 0.03,
    horizon_annees: int = 3,
) -> pd.DataFrame:
    """
    Simule la dérive du S/P sous hypothèse de différentiel d'inflation.

    Exemple : sp_actuel=0.75, inflation_sinistres=0.08, inflation_primes=0.03, horizon=3
    """
    res = []
    sp = sp_actuel
    for t in range(0, horizon_annees + 1):
        res.append({
            "annee": t,
            "sp_projete": round(sp, 4),
            "derive_pts_vs_initial": round((sp - sp_actuel) * 100, 2),
        })
        sp = sp * (1 + inflation_sinistres_annuelle) / (1 + inflation_primes_annuelle)
    return pd.DataFrame(res)


# ============================================================================
# 7. CLV (Customer Lifetime Value) Simplifié
# ============================================================================

def calculer_clv(
    prime_moyenne: float,
    marge_technique: float = 0.05,
    taux_retention: float = 0.85,
    horizon: int = 10,
    taux_actualisation: float = 0.06,
) -> float:
    """
    CLV simplifié, actualisé.
    
    marge_technique : % marge sur la prime (ex. 0.05 = 5%)
    taux_retention : proba de renouvellement annuel
    """
    clv = 0
    for t in range(1, horizon + 1):
        clv += (prime_moyenne * marge_technique * taux_retention**t) / ((1 + taux_actualisation)**t)
    return round(clv, 2)


# ============================================================================
# 8. GÉNÉRATION RAPPORT COMEX
# ============================================================================

def rapport_comex(df: pd.DataFrame, df_sinistres: Optional[pd.DataFrame] = None) -> str:
    """
    Produit un rapport texte structuré de niveau COMEX.
    À enrichir avec les graphiques (matplotlib / plotly) dans un notebook.
    """
    prof = profilage(df)
    dq = dq_checks(df)
    kpis = kpi_techniques(df, df_sinistres)

    rapport = f"""
═══════════════════════════════════════════════════════════════════════════
SYNTHÈSE COMEX — ANALYSE DE PORTEFEUILLE ASSURANCE
Généré le : {datetime.now().strftime("%d/%m/%Y %H:%M")}
═══════════════════════════════════════════════════════════════════════════

1. PÉRIMÈTRE
   - Période couverte : {prof.get('periode_exersat')}
   - Nombre de polices : {prof.get('nb_polices'):,}
   - Nombre de quittances : {prof.get('nb_quittances'):,}
   - Prime totale nette : {prof.get('prime_totale', 0):,.0f}
   - Prime moyenne : {prof.get('prime_moyenne', 0):,.0f}

2. QUALITÉ DES DONNÉES
{dq.to_string(index=False)}

   ⚠ Taux d'anomalie maximal : {dq['Taux_anomalie_%'].max():.2f}%
   → Les conclusions suivantes sont à pondérer en fonction de ces contrôles.

3. KPI TECHNIQUES
   - Prime totale : {kpis.get('prime_totale_nette', 0):,.0f}
   - Taux de commission moyen : {float(kpis.get('taux_commission_moyen', 0) or 0) * 100:.2f} %
   - Ratio S/P : {kpis.get('ratio_SP_global')}

4. POINTS D'ATTENTION
   - [À compléter manuellement après revue des segmentations et des stress tests]

5. RECOMMANDATIONS PRIORITAIRES
   - [À compléter avec les recommandations chiffrées]

═══════════════════════════════════════════════════════════════════════════
"""
    return rapport


# ============================================================================
# Exemple d'utilisation
# ============================================================================

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage : python analyse_portefeuille.py <chemin_vers_ca_view.csv>")
        sys.exit(1)

    df = charger_donnees(sys.argv[1])
    print(rapport_comex(df))
