#!/usr/bin/env python3
"""Démo scraping : collecte titre / prix / lien / note depuis une source publique.

Source par défaut : https://books.toscrape.com (site d'entraînement conçu pour le
scraping, sans robots.txt restrictif). Chaque livre devient une ligne
`{ "titre": str, "prix": float, "lien": str, "note": float }` — exactement le
format lu par la page `demos/scraping/` du site.

Exemples :
    python scrape_prix.py                       # 2 premières pages du catalogue
    python scrape_prix.py --cible Travel        # une catégorie
    python scrape_prix.py --cible "python"      # filtre sur le titre
    python scrape_prix.py --cible https://books.toscrape.com/catalogue/category/books/mystery_3/index.html
    python scrape_prix.py --pages 3 --sortie ../data/prix.json

Résultats : `site-demo/data/prix.json` (tableau) et `site-demo/data/prix_meta.json`
(date, source, nombre de lignes). Publication optionnelle dans Google Sheets
si `GOOGLE_SERVICE_ACCOUNT_JSON` et `GOOGLE_SHEET_ID` sont définis.
"""
from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

import commun

SOURCE_URL = "https://books.toscrape.com/"
SOURCE_NOM = "Books to Scrape"
DOMAINES_AUTORISES = {"books.toscrape.com"}
NOTES_TEXTE = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
PAGES_MAX = 5  # garde-fou : 5 pages x 20 livres suffisent pour une démo


# --- parsing --------------------------------------------------------------
def parser_prix(texte: str) -> float | None:
    """'£51.77' -> 51.77 ; '1 299,90 €' -> 1299.9 ; texte vide -> None."""
    if not texte:
        return None
    brut = re.sub(r"[^\d,.\-]", "", texte.replace(" ", ""))
    if not brut:
        return None
    if "," in brut and "." in brut:
        # 1.299,90 (fr) ou 1,299.90 (en) : le dernier séparateur est le décimal
        if brut.rfind(",") > brut.rfind("."):
            brut = brut.replace(".", "").replace(",", ".")
        else:
            brut = brut.replace(",", "")
    elif "," in brut:
        brut = brut.replace(",", ".")
    try:
        return round(float(brut), 2)
    except ValueError:
        return None


def parser_note(classes) -> float:
    """['star-rating', 'Four'] -> 4.0 ; '3.5/5' -> 3.5 ; inconnu -> 0.0."""
    if classes is None:
        return 0.0
    if isinstance(classes, str):
        classes = classes.split()
    for c in classes:
        cle = str(c).strip().lower()
        if cle in NOTES_TEXTE:
            return float(NOTES_TEXTE[cle])
        m = re.fullmatch(r"(\d+(?:[.,]\d+)?)(?:/5)?", cle)
        if m:
            valeur = float(m.group(1).replace(",", "."))
            return max(0.0, min(5.0, round(valeur, 1)))
    return 0.0


def extraire_livres(html: str, url_page: str, source: str = SOURCE_NOM) -> list[dict]:
    """Extrait les produits d'une page de catalogue books.toscrape.com."""
    soup = BeautifulSoup(html, "html.parser")
    lignes = []
    for article in soup.select("article.product_pod"):
        a = article.select_one("h3 a")
        prix_el = article.select_one(".price_color")
        note_el = article.select_one(".star-rating")
        if not a or not prix_el:
            continue
        titre = (a.get("title") or a.get_text(strip=True)).strip()
        prix = parser_prix(prix_el.get_text())
        if prix is None:
            continue
        lignes.append(
            {
                "titre": f"{titre} — {source}",
                "prix": prix,
                "lien": urljoin(url_page, a.get("href", "")),
                "note": parser_note(note_el.get("class") if note_el else None),
            }
        )
    return lignes


def url_page_suivante(html: str, url_page: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    lien = soup.select_one("li.next a")
    return urljoin(url_page, lien["href"]) if lien and lien.get("href") else None


def trouver_categorie(html_accueil: str, nom: str) -> str | None:
    """Renvoie l'URL de la catégorie dont le nom correspond (insensible à la casse)."""
    soup = BeautifulSoup(html_accueil, "html.parser")
    voulu = nom.strip().lower()
    for a in soup.select(".side_categories a"):
        if a.get_text(strip=True).lower() == voulu:
            return urljoin(SOURCE_URL, a.get("href", ""))
    return None


# --- collecte -------------------------------------------------------------
def resoudre_cible(session: commun.SessionPolie, cible: str) -> tuple[str, str | None, str]:
    """Transforme la cible en (URL de départ, filtre texte, description).

    - URL sur un domaine autorisé -> on part de cette page.
    - Nom de catégorie -> page de la catégorie.
    - Autre texte -> catalogue complet + filtre sur le titre.
    - Vide -> catalogue complet.
    """
    cible = (cible or "").strip()
    if not cible:
        return SOURCE_URL, None, "catalogue"
    if cible.startswith(("http://", "https://")):
        hote = urlsplit(cible).netloc.lower()
        if hote in DOMAINES_AUTORISES:
            return cible, None, f"url:{cible}"
        commun.log.warning("Domaine %s non autorisé pour la démo : catalogue par défaut utilisé", hote)
        return SOURCE_URL, None, "catalogue (domaine non autorisé)"
    accueil = session.get(SOURCE_URL).text
    url_cat = trouver_categorie(accueil, cible)
    if url_cat:
        return url_cat, None, f"catégorie:{cible}"
    return SOURCE_URL, cible.lower(), f"recherche:{cible}"


def collecter(session: commun.SessionPolie, cible: str = "", pages: int = 2) -> tuple[list[dict], str]:
    pages = max(1, min(int(pages), PAGES_MAX))
    url, filtre, description = resoudre_cible(session, cible)
    resultats: list[dict] = []
    for i in range(pages):
        commun.log.info("Page %d/%d : %s", i + 1, pages, url)
        html = session.get(url).text
        resultats.extend(extraire_livres(html, url))
        url = url_page_suivante(html, url)
        if not url:
            break
    if filtre:
        filtres = [r for r in resultats if filtre in r["titre"].lower()]
        if filtres:
            resultats = filtres
        else:
            commun.log.info("Aucun titre ne contient « %s » : résultats non filtrés renvoyés", filtre)
            description += " (aucune correspondance)"
    # déduplication par lien, tri par prix croissant
    vus: set[str] = set()
    uniques = []
    for r in resultats:
        if r["lien"] not in vus:
            vus.add(r["lien"])
            uniques.append(r)
    uniques.sort(key=lambda r: r["prix"])
    return uniques, description


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cible", default="", help="catégorie, mot-clé ou URL books.toscrape.com (optionnel)")
    p.add_argument("--pages", type=int, default=2, help=f"nombre de pages à parcourir (max {PAGES_MAX})")
    p.add_argument("--sortie", default=str(commun.DATA_DIR / "prix.json"), help="fichier JSON de sortie")
    p.add_argument("--delai", type=float, default=commun.DELAI_SECONDES, help="délai entre requêtes (s)")
    p.add_argument("--taux", type=float, default=1.0, help="taux de conversion appliqué aux prix (ex. 1.17 GBP->EUR)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    commun.configurer_logs(args.verbose)

    session = commun.SessionPolie(delai=max(args.delai, commun.DELAI_SECONDES))
    try:
        lignes, description = collecter(session, args.cible, args.pages)
    except Exception as exc:  # réseau, robots.txt, HTML inattendu
        commun.log.error("Collecte impossible : %s", exc)
        return 1
    if args.taux != 1.0:
        for l in lignes:
            l["prix"] = round(l["prix"] * args.taux, 2)
    if not lignes:
        commun.log.error("Aucune ligne collectée : le fichier existant est conservé")
        return 2

    sortie = commun.ecrire_json(args.sortie, lignes)
    commun.ecrire_json(
        sortie.with_name("prix_meta.json"),
        {
            "derniere_execution": commun.maintenant_iso(),
            "source": SOURCE_NOM,
            "source_url": SOURCE_URL,
            "cible": description,
            "nb_lignes": len(lignes),
            "devise_source": "GBP",
            "taux_applique": args.taux,
        },
    )
    commun.publier_google_sheet("prix", lignes)
    commun.log.info("%d lignes collectées (%s)", len(lignes), description)
    return 0


if __name__ == "__main__":
    sys.exit(main())
