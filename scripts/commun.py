"""Utilitaires partagés par les scripts de démo.

- Localisation du dossier `site-demo/data/` quel que soit le répertoire courant.
- Session HTTP avec User-Agent identifié, respect de robots.txt, délai entre requêtes.
- Écriture JSON (UTF-8, indenté) et publication optionnelle dans un Google Sheet.

Aucun secret n'est écrit ici : tout passe par des variables d'environnement
(`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID`) fournies par GitHub Secrets.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests

SCRIPTS_DIR = Path(__file__).resolve().parent
SITE_DIR = SCRIPTS_DIR.parent
DATA_DIR = SITE_DIR / "data"

USER_AGENT = (
    "DemoScraperHajer/1.0 (+https://github.com/hajer-demo; script de démonstration, "
    "1 requête toutes les 2 s, contact via le site)"
)
DELAI_SECONDES = 2.0  # délai minimum entre deux requêtes vers un même site
TIMEOUT = 20

log = logging.getLogger("demo")


def configurer_logs(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def maintenant_iso() -> str:
    """Horodatage UTC au format ISO 8601 (secondes)."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ecrire_json(chemin: Path, contenu) -> Path:
    chemin = Path(chemin)
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", encoding="utf-8") as f:
        json.dump(contenu, f, ensure_ascii=False, indent=2)
        f.write("\n")
    log.info("Écrit : %s", chemin)
    return chemin


def lire_json(chemin: Path, defaut):
    chemin = Path(chemin)
    if not chemin.exists():
        return defaut
    try:
        with chemin.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Fichier %s illisible (%s), valeur par défaut utilisée", chemin, exc)
        return defaut


class SessionPolie(requests.Session):
    """Session HTTP qui s'identifie, vérifie robots.txt et attend entre deux requêtes."""

    def __init__(self, delai: float = DELAI_SECONDES, respecter_robots: bool = True):
        super().__init__()
        self.headers["User-Agent"] = USER_AGENT
        self.headers["Accept-Language"] = "fr-FR,fr;q=0.9,en;q=0.7"
        self.delai = delai
        self.respecter_robots = respecter_robots
        self._derniere_requete: dict[str, float] = {}
        self._robots: dict[str, RobotFileParser | None] = {}

    # --- robots.txt -------------------------------------------------------
    def _robots_pour(self, url: str) -> RobotFileParser | None:
        parts = urlsplit(url)
        racine = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
        if racine in self._robots:
            return self._robots[racine]
        rp: RobotFileParser | None = RobotFileParser()
        try:
            self._attendre(racine + "/robots.txt")  # la lecture de robots.txt compte aussi dans le délai
            rep = super().get(racine + "/robots.txt", timeout=TIMEOUT)
            if rep.status_code == 200:
                rp.parse(rep.text.splitlines())
            else:  # pas de robots.txt : tout est autorisé par convention
                rp = None
        except requests.RequestException as exc:
            log.warning("robots.txt injoignable pour %s (%s) : accès autorisé par défaut", racine, exc)
            rp = None
        self._robots[racine] = rp
        return rp

    def autorise(self, url: str) -> bool:
        if not self.respecter_robots:
            return True
        rp = self._robots_pour(url)
        return True if rp is None else rp.can_fetch(USER_AGENT, url)

    # --- délai ------------------------------------------------------------
    def _attendre(self, url: str) -> None:
        hote = urlsplit(url).netloc
        precedent = self._derniere_requete.get(hote)
        if precedent is not None:
            reste = self.delai - (time.monotonic() - precedent)
            if reste > 0:
                time.sleep(reste)
        self._derniere_requete[hote] = time.monotonic()

    def get(self, url, **kwargs):  # type: ignore[override]
        if not self.autorise(url):
            raise PermissionError(f"robots.txt interdit l'accès à {url}")
        self._attendre(url)
        kwargs.setdefault("timeout", TIMEOUT)
        rep = super().get(url, **kwargs)
        rep.raise_for_status()
        return rep


# --- Google Sheets (optionnel) -------------------------------------------
def publier_google_sheet(onglet: str, lignes: list[dict]) -> bool:
    """Écrit `lignes` dans l'onglet `onglet` du Google Sheet configuré.

    Ne fait rien (et renvoie False) si `GOOGLE_SERVICE_ACCOUNT_JSON` ou
    `GOOGLE_SHEET_ID` sont absents, ou si `gspread` n'est pas installé.
    """
    cle = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    sheet_id = os.environ.get("GOOGLE_SHEET_ID")
    if not cle or not sheet_id:
        log.info("Google Sheet non configuré (secrets absents) : étape ignorée")
        return False
    try:
        import gspread  # import différé : dépendance optionnelle
    except ImportError:
        log.warning("gspread non installé : `pip install gspread` pour publier dans Google Sheets")
        return False
    if not lignes:
        return False
    client = gspread.service_account_from_dict(json.loads(cle))
    classeur = client.open_by_key(sheet_id)
    try:
        feuille = classeur.worksheet(onglet)
    except gspread.WorksheetNotFound:
        feuille = classeur.add_worksheet(title=onglet, rows=max(100, len(lignes) + 1), cols=20)
    colonnes = list(lignes[0].keys())
    valeurs = [colonnes] + [[str(l.get(c, "")) for c in colonnes] for l in lignes]
    feuille.clear()
    feuille.update(range_name="A1", values=valeurs)
    log.info("Google Sheet mis à jour : onglet %s, %d lignes", onglet, len(lignes))
    return True
