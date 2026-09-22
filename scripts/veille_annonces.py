#!/usr/bin/env python3
"""Démo veille : surveille un flux RSS/Atom public et détecte les nouveautés.

À chaque exécution, le script lit le flux, compare les identifiants d'entrées
avec ceux mémorisés dans `site-demo/data/veille_etat.json`, puis écrit
`site-demo/data/annonces.json` :

    {
      "flux": "...", "derniere_execution": "...",
      "nb_nouvelles": 3,
      "nouvelles": [ { "id", "titre", "lien", "date", "resume" }, ... ],
      "dernieres": [ ... 30 entrées les plus récentes du flux ... ]
    }

Exemples :
    python veille_annonces.py
    python veille_annonces.py --flux https://hnrss.org/newest?q=automation
    FLUX_RSS=https://exemple.fr/rss.xml python veille_annonces.py

Sans dépendance externe pour le parsing (xml.etree) : RSS 2.0 et Atom acceptés.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import os
import re
import sys
import xml.etree.ElementTree as ET

import commun

FLUX_DEFAUT = "https://hnrss.org/newest?q=automation&points=20"
NB_DERNIERES = 30
NB_VUS_MAX = 500  # taille maximale de la mémoire des identifiants déjà vus

NS = {"atom": "http://www.w3.org/2005/Atom", "content": "http://purl.org/rss/1.0/modules/content/"}


def _texte(el, *chemins: str) -> str:
    for chemin in chemins:
        trouve = el.find(chemin, NS)
        if trouve is not None:
            valeur = (trouve.text or "").strip()
            if not valeur and trouve.get("href"):
                valeur = trouve.get("href", "").strip()
            if valeur:
                return valeur
    return ""


def nettoyer_resume(texte: str, longueur: int = 240) -> str:
    sans_html = re.sub(r"<[^>]+>", " ", html.unescape(texte or ""))
    propre = re.sub(r"\s+", " ", sans_html).strip()
    return propre if len(propre) <= longueur else propre[: longueur - 1].rstrip() + "…"


def _identifiant(guid: str, lien: str, titre: str) -> str:
    base = guid or lien or titre
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def parser_flux(xml_texte: str) -> list[dict]:
    """Renvoie la liste des entrées du flux (RSS 2.0 ou Atom), ordre du flux conservé."""
    racine = ET.fromstring(xml_texte)
    entrees = []
    # RSS 2.0 : <rss><channel><item>
    for item in racine.iter("item"):
        titre = _texte(item, "title")
        lien = _texte(item, "link")
        entrees.append(
            {
                "id": _identifiant(_texte(item, "guid"), lien, titre),
                "titre": html.unescape(titre),
                "lien": lien,
                "date": _texte(item, "pubDate", "{http://purl.org/dc/elements/1.1/}date"),
                "resume": nettoyer_resume(_texte(item, "description", "content:encoded")),
            }
        )
    # Atom : <feed><entry>
    for entry in racine.iter(f"{{{NS['atom']}}}entry"):
        titre = _texte(entry, "atom:title")
        lien_el = entry.find("atom:link[@rel='alternate']", NS) or entry.find("atom:link", NS)
        lien = (lien_el.get("href", "") if lien_el is not None else "").strip()
        entrees.append(
            {
                "id": _identifiant(_texte(entry, "atom:id"), lien, titre),
                "titre": html.unescape(titre),
                "lien": lien,
                "date": _texte(entry, "atom:published", "atom:updated"),
                "resume": nettoyer_resume(_texte(entry, "atom:summary", "atom:content")),
            }
        )
    return [e for e in entrees if e["titre"] or e["lien"]]


def detecter_nouveautes(entrees: list[dict], etat: dict) -> tuple[list[dict], dict]:
    """Compare avec l'état précédent ; renvoie (nouvelles entrées, nouvel état).

    Première exécution (état vide) : rien n'est signalé comme nouveau, on
    mémorise simplement ce qui existe pour ne pas inonder la démo.
    """
    vus = list(etat.get("vus", []))
    premiere_fois = not vus
    connus = set(vus)
    nouvelles = [e for e in entrees if e["id"] not in connus]
    if premiere_fois:
        signalees: list[dict] = []
    else:
        signalees = nouvelles
    for e in nouvelles:
        vus.append(e["id"])
    vus = vus[-NB_VUS_MAX:]
    nouvel_etat = {
        "vus": vus,
        "derniere_execution": commun.maintenant_iso(),
        "nb_executions": int(etat.get("nb_executions", 0)) + 1,
    }
    return signalees, nouvel_etat


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--flux", default=os.environ.get("FLUX_RSS", FLUX_DEFAUT), help="URL du flux RSS/Atom")
    p.add_argument("--sortie", default=str(commun.DATA_DIR / "annonces.json"))
    p.add_argument("--etat", default=str(commun.DATA_DIR / "veille_etat.json"))
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    commun.configurer_logs(args.verbose)

    session = commun.SessionPolie()
    try:
        xml_texte = session.get(args.flux).text
        entrees = parser_flux(xml_texte)
    except Exception as exc:
        commun.log.error("Flux illisible (%s) : %s", args.flux, exc)
        return 1
    if not entrees:
        commun.log.error("Flux vide : fichiers existants conservés")
        return 2

    etat = commun.lire_json(args.etat, {})
    nouvelles, nouvel_etat = detecter_nouveautes(entrees, etat)
    commun.ecrire_json(args.etat, nouvel_etat)
    commun.ecrire_json(
        args.sortie,
        {
            "flux": args.flux,
            "derniere_execution": nouvel_etat["derniere_execution"],
            "nb_nouvelles": len(nouvelles),
            "nouvelles": nouvelles,
            "dernieres": entrees[:NB_DERNIERES],
        },
    )
    commun.publier_google_sheet("veille", entrees[:NB_DERNIERES])
    commun.log.info("%d entrées lues, %d nouveautés", len(entrees), len(nouvelles))
    return 0


if __name__ == "__main__":
    sys.exit(main())
