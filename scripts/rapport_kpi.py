#!/usr/bin/env python3
"""Démo rapport : calcule des KPI simples à partir d'un CSV de ventes.

Colonnes attendues (en-tête, séparateur `,` ou `;` détecté automatiquement) :
    date, client, produit, quantite, prix_unitaire, cout_unitaire
`cout_unitaire` est optionnel (marge = 0 si absent). Les noms sont tolérants
(majuscules, accents, espaces).

Sortie `site-demo/data/kpi.json` :
    {
      "periode": {"debut": "2026-06-01", "fin": "2026-08-30"},
      "ca": 48200.0, "depenses": 31500.0, "clients": 37,   <- même vocabulaire que /api/rapport
      "marge": ..., "taux_marge_pct": ..., "nb_commandes": ..., "panier_moyen": ...,
      "top_produits": [ {"produit", "ca", "quantite"} ... ],
      "ca_par_mois": [ {"mois": "2026-06", "ca", "commandes", "evolution_pct"} ... ],
      "derniere_execution": "..."
    }

Exemples :
    python rapport_kpi.py                                  # data/ventes_exemple.csv
    python rapport_kpi.py --csv ventes.csv --sortie kpi.json
"""
from __future__ import annotations

import argparse
import sys
import unicodedata
from pathlib import Path

import pandas as pd

import commun

CSV_DEFAUT = commun.DATA_DIR / "ventes_exemple.csv"
COLONNES = {
    "date": ["date", "jour", "date_commande"],
    "client": ["client", "customer", "email", "nom_client"],
    "produit": ["produit", "product", "article", "reference"],
    "quantite": ["quantite", "qty", "qte", "quantity"],
    "prix_unitaire": ["prix_unitaire", "prix", "price", "unit_price", "montant"],
    "cout_unitaire": ["cout_unitaire", "cout", "cost", "unit_cost"],
}


def _normaliser(nom: str) -> str:
    sans_accent = unicodedata.normalize("NFKD", str(nom)).encode("ascii", "ignore").decode()
    return sans_accent.strip().lower().replace(" ", "_").replace("-", "_")


def charger_csv(chemin: Path) -> pd.DataFrame:
    """Lit le CSV, harmonise les noms de colonnes et les types."""
    df = pd.read_csv(chemin, sep=None, engine="python", encoding="utf-8-sig")
    df.columns = [_normaliser(c) for c in df.columns]
    renommage = {}
    for cible, alias in COLONNES.items():
        for a in alias:
            if a in df.columns and cible not in renommage.values():
                renommage[a] = cible
                break
    df = df.rename(columns=renommage)
    manquantes = {"date", "client", "produit", "prix_unitaire"} - set(df.columns)
    if manquantes:
        raise ValueError(f"colonnes manquantes dans le CSV : {', '.join(sorted(manquantes))}")
    if "quantite" not in df.columns:
        df["quantite"] = 1
    if "cout_unitaire" not in df.columns:
        df["cout_unitaire"] = 0.0
    df["date"] = pd.to_datetime(df["date"], errors="coerce", dayfirst=False)
    for col in ("quantite", "prix_unitaire", "cout_unitaire"):
        df[col] = pd.to_numeric(
            df[col].astype(str).str.replace(" ", "").str.replace(" ", "").str.replace(",", "."),
            errors="coerce",
        )
    df = df.dropna(subset=["date", "prix_unitaire"])
    df["quantite"] = df["quantite"].fillna(1)
    df["cout_unitaire"] = df["cout_unitaire"].fillna(0.0)
    df["ca_ligne"] = df["quantite"] * df["prix_unitaire"]
    df["cout_ligne"] = df["quantite"] * df["cout_unitaire"]
    return df


def calculer_kpi(df: pd.DataFrame, top: int = 5) -> dict:
    if df.empty:
        raise ValueError("aucune ligne exploitable")
    ca = float(df["ca_ligne"].sum())
    depenses = float(df["cout_ligne"].sum())
    marge = ca - depenses
    nb_commandes = int(len(df))
    clients = int(df["client"].nunique())

    par_mois = (
        df.assign(mois=df["date"].dt.to_period("M").astype(str))
        .groupby("mois")
        .agg(ca=("ca_ligne", "sum"), commandes=("ca_ligne", "size"))
        .sort_index()
    )
    ca_par_mois = []
    precedent = None
    for mois, ligne in par_mois.iterrows():
        ca_mois = round(float(ligne["ca"]), 2)
        evolution = None if not precedent else round((ca_mois - precedent) / precedent * 100, 1)
        ca_par_mois.append({"mois": mois, "ca": ca_mois, "commandes": int(ligne["commandes"]), "evolution_pct": evolution})
        precedent = ca_mois

    top_produits = (
        df.groupby("produit")
        .agg(ca=("ca_ligne", "sum"), quantite=("quantite", "sum"))
        .sort_values("ca", ascending=False)
        .head(top)
    )

    return {
        "periode": {"debut": df["date"].min().strftime("%Y-%m-%d"), "fin": df["date"].max().strftime("%Y-%m-%d")},
        "ca": round(ca, 2),
        "depenses": round(depenses, 2),
        "clients": clients,
        "marge": round(marge, 2),
        "taux_marge_pct": round(marge / ca * 100, 1) if ca else 0.0,
        "nb_commandes": nb_commandes,
        "panier_moyen": round(ca / nb_commandes, 2),
        "ca_par_client": round(ca / clients, 2) if clients else 0.0,
        "top_produits": [
            {"produit": str(p), "ca": round(float(l["ca"]), 2), "quantite": int(l["quantite"])}
            for p, l in top_produits.iterrows()
        ],
        "ca_par_mois": ca_par_mois,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", default=str(CSV_DEFAUT), help="fichier CSV de ventes")
    p.add_argument("--sortie", default=str(commun.DATA_DIR / "kpi.json"))
    p.add_argument("--top", type=int, default=5, help="nombre de produits dans le top")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    commun.configurer_logs(args.verbose)

    try:
        df = charger_csv(Path(args.csv))
        kpi = calculer_kpi(df, args.top)
    except Exception as exc:
        commun.log.error("Calcul impossible : %s", exc)
        return 1
    kpi["source_csv"] = Path(args.csv).name
    kpi["derniere_execution"] = commun.maintenant_iso()
    commun.ecrire_json(args.sortie, kpi)
    commun.publier_google_sheet("kpi_mois", kpi["ca_par_mois"])
    commun.log.info("CA %.2f, marge %.2f, %d clients, %d commandes", kpi["ca"], kpi["marge"], kpi["clients"], kpi["nb_commandes"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
