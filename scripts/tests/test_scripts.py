"""Tests des scripts de démo — 100 % hors ligne (fixtures locales, réseau simulé).

Lancement : `pytest -q` depuis `site-demo/scripts/` (ou n'importe où, le
chemin des scripts est ajouté à sys.path ci-dessous).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import commun  # noqa: E402
import rapport_kpi  # noqa: E402
import scrape_prix  # noqa: E402
import veille_annonces  # noqa: E402


# --- garde-fou : aucun appel réseau réel pendant les tests -----------------
@pytest.fixture(autouse=True)
def _pas_de_reseau(monkeypatch):
    def interdit(*args, **kwargs):
        raise AssertionError("appel réseau interdit dans les tests")

    monkeypatch.setattr("requests.sessions.Session.request", interdit)


class FausseReponse:
    def __init__(self, texte: str, status: int = 200):
        self.text = texte
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FausseSession(commun.SessionPolie):
    """SessionPolie sans réseau : sert des fixtures par URL et compte les appels."""

    def __init__(self, pages: dict[str, str]):
        super().__init__(delai=0, respecter_robots=False)
        self.pages = pages
        self.appels: list[str] = []

    def get(self, url, **kwargs):
        self.appels.append(url)
        if url not in self.pages:
            raise RuntimeError(f"URL inattendue dans le test : {url}")
        return FausseReponse(self.pages[url])


@pytest.fixture
def html_page1() -> str:
    return (FIXTURES / "books_page1.html").read_text(encoding="utf-8")


@pytest.fixture
def html_page2() -> str:
    return (FIXTURES / "books_page2.html").read_text(encoding="utf-8")


@pytest.fixture
def session_livres(html_page1, html_page2) -> FausseSession:
    base = scrape_prix.SOURCE_URL
    return FausseSession(
        {
            base: html_page1,
            base + "catalogue/page-2.html": html_page2,
            base + "catalogue/category/books/travel_2/index.html": html_page2,
        }
    )


# --- scrape_prix ----------------------------------------------------------
@pytest.mark.parametrize(
    "texte, attendu",
    [("£51.77", 51.77), ("1 299,90 €", 1299.9), ("1,299.90", 1299.9), ("1.299,90", 1299.9), ("gratuit", None), ("", None)],
)
def test_parser_prix(texte, attendu):
    assert scrape_prix.parser_prix(texte) == attendu


@pytest.mark.parametrize(
    "classes, attendu",
    [(["star-rating", "Four"], 4.0), ("star-rating Five", 5.0), (["3.5/5"], 3.5), (["7"], 5.0), (None, 0.0), (["inconnu"], 0.0)],
)
def test_parser_note(classes, attendu):
    assert scrape_prix.parser_note(classes) == attendu


def test_extraire_livres_format_page(html_page1):
    lignes = scrape_prix.extraire_livres(html_page1, scrape_prix.SOURCE_URL)
    assert len(lignes) == 4
    premier = lignes[0]
    assert set(premier) == {"titre", "prix", "lien", "note"}
    assert premier["titre"] == "A Light in the Attic — Books to Scrape"
    assert premier["prix"] == 51.77 and isinstance(premier["prix"], float)
    assert premier["note"] == 3.0 and isinstance(premier["note"], float)
    assert premier["lien"] == "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
    assert all(0 <= l["note"] <= 5 for l in lignes)


def test_url_page_suivante(html_page1, html_page2):
    assert scrape_prix.url_page_suivante(html_page1, scrape_prix.SOURCE_URL) == "https://books.toscrape.com/catalogue/page-2.html"
    assert scrape_prix.url_page_suivante(html_page2, "https://books.toscrape.com/catalogue/page-2.html") is None


def test_trouver_categorie(html_page1):
    assert scrape_prix.trouver_categorie(html_page1, "mystery") == "https://books.toscrape.com/catalogue/category/books/mystery_3/index.html"
    assert scrape_prix.trouver_categorie(html_page1, "inexistante") is None


def test_collecter_pagination_et_dedoublonnage(session_livres):
    lignes, description = scrape_prix.collecter(session_livres, cible="", pages=2)
    assert description == "catalogue"
    assert session_livres.appels == [scrape_prix.SOURCE_URL, "https://books.toscrape.com/catalogue/page-2.html"]
    # 4 + 2 livres dont un doublon (même lien) -> 5, triés par prix croissant
    assert len(lignes) == 5
    assert [l["prix"] for l in lignes] == sorted(l["prix"] for l in lignes)


def test_collecter_filtre_texte_et_categorie(session_livres):
    lignes, description = scrape_prix.collecter(session_livres, cible="python", pages=1)
    assert description == "recherche:python"
    assert [l["titre"] for l in lignes] == ["Python for Everyone — Books to Scrape"]

    lignes, description = scrape_prix.collecter(session_livres, cible="Travel", pages=1)
    assert description == "catégorie:Travel"
    assert len(lignes) == 2


def test_collecter_refuse_domaine_inconnu(session_livres):
    _, description = scrape_prix.collecter(session_livres, cible="https://site-inconnu.test/produits", pages=1)
    assert "domaine non autorisé" in description
    assert session_livres.appels[0] == scrape_prix.SOURCE_URL


def test_scrape_prix_main_ecrit_json_compatible_site(tmp_path, monkeypatch, session_livres):
    monkeypatch.setattr(scrape_prix.commun, "SessionPolie", lambda *a, **k: session_livres)
    sortie = tmp_path / "prix.json"
    assert scrape_prix.main(["--sortie", str(sortie), "--pages", "1", "--taux", "1.17"]) == 0
    data = json.loads(sortie.read_text(encoding="utf-8"))
    assert isinstance(data, list) and len(data) == 4
    for ligne in data:
        assert set(ligne) == {"titre", "prix", "lien", "note"}
        assert isinstance(ligne["prix"], float) and isinstance(ligne["note"], float)
    assert data[0]["prix"] == round(47.82 * 1.17, 2)
    meta = json.loads((tmp_path / "prix_meta.json").read_text(encoding="utf-8"))
    assert meta["nb_lignes"] == 4 and meta["taux_applique"] == 1.17


def test_session_polie_respecte_robots(monkeypatch):
    session = commun.SessionPolie(delai=0)
    monkeypatch.setattr(session, "_robots_pour", lambda url: _robots_interdisant())
    with pytest.raises(PermissionError):
        session.get("https://exemple.test/prive/page")


def _robots_interdisant():
    from urllib.robotparser import RobotFileParser

    rp = RobotFileParser()
    rp.parse(["User-agent: *", "Disallow: /prive/"])
    return rp


# --- veille_annonces ------------------------------------------------------
def test_parser_flux_rss():
    entrees = veille_annonces.parser_flux((FIXTURES / "flux_rss.xml").read_text(encoding="utf-8"))
    assert [e["titre"] for e in entrees] == ["Appartement T3 — Lyon 3e", "Studio meublé — Villeurbanne", "Maison 4 pièces avec jardin — Bron"]
    assert entrees[0]["lien"] == "https://exemple.test/annonces/t3-lyon-3"
    assert entrees[0]["resume"] == "Bel appartement lumineux de 68 m², proche métro. Disponible immédiatement."
    assert entrees[0]["date"].startswith("Mon, 21 Sep 2026")
    assert len({e["id"] for e in entrees}) == 3


def test_parser_flux_atom():
    entrees = veille_annonces.parser_flux((FIXTURES / "flux_atom.xml").read_text(encoding="utf-8"))
    assert len(entrees) == 2
    assert entrees[0]["lien"] == "https://exemple.test/blog/version-2"
    assert entrees[0]["resume"] == "La version 2.0 apporte trois nouveautés."
    assert entrees[1]["date"] == "2026-09-01T08:00:00Z"


def test_detecter_nouveautes_premiere_puis_seconde_execution():
    entrees = veille_annonces.parser_flux((FIXTURES / "flux_rss.xml").read_text(encoding="utf-8"))
    # 1re exécution : on mémorise sans signaler
    nouvelles, etat = veille_annonces.detecter_nouveautes(entrees, {})
    assert nouvelles == [] and len(etat["vus"]) == 3 and etat["nb_executions"] == 1
    # 2e exécution : rien de neuf
    nouvelles, etat = veille_annonces.detecter_nouveautes(entrees, etat)
    assert nouvelles == [] and etat["nb_executions"] == 2
    # 3e exécution : une entrée inédite apparaît
    inedite = {"id": "abc123", "titre": "Loft — Lyon 7e", "lien": "https://exemple.test/loft", "date": "", "resume": ""}
    nouvelles, etat = veille_annonces.detecter_nouveautes([inedite] + entrees, etat)
    assert [n["titre"] for n in nouvelles] == ["Loft — Lyon 7e"]
    assert "abc123" in etat["vus"] and len(etat["vus"]) == 4


def test_veille_main_ecrit_annonces_et_etat(tmp_path, monkeypatch):
    xml = (FIXTURES / "flux_rss.xml").read_text(encoding="utf-8")
    monkeypatch.setattr(veille_annonces.commun, "SessionPolie", lambda *a, **k: FausseSession({"https://exemple.test/rss": xml}))
    sortie, etat = tmp_path / "annonces.json", tmp_path / "veille_etat.json"
    args = ["--flux", "https://exemple.test/rss", "--sortie", str(sortie), "--etat", str(etat)]
    assert veille_annonces.main(args) == 0
    annonces = json.loads(sortie.read_text(encoding="utf-8"))
    assert annonces["nb_nouvelles"] == 0 and len(annonces["dernieres"]) == 3
    assert len(json.loads(etat.read_text(encoding="utf-8"))["vus"]) == 3
    assert veille_annonces.main(args) == 0  # seconde exécution : état relu sans erreur


# --- rapport_kpi ----------------------------------------------------------
CSV_TEST = """Date;Client;Produit;Quantité;Prix unitaire;Coût unitaire
2026-06-02;a@x.fr;Casque;1;100,00;60
2026-06-15;b@x.fr;Enceinte;2;50,00;30
2026-07-03;a@x.fr;Casque;1;100,00;60
2026-07-20;c@x.fr;Chargeur;4;25,00;10
"""


def test_charger_csv_tolerant(tmp_path):
    csv = tmp_path / "ventes.csv"
    csv.write_text(CSV_TEST, encoding="utf-8")
    df = rapport_kpi.charger_csv(csv)
    assert {"date", "client", "produit", "quantite", "prix_unitaire", "cout_unitaire"} <= set(df.columns)
    assert df["ca_ligne"].sum() == 400.0


def test_calculer_kpi(tmp_path):
    csv = tmp_path / "ventes.csv"
    csv.write_text(CSV_TEST, encoding="utf-8")
    kpi = rapport_kpi.calculer_kpi(rapport_kpi.charger_csv(csv))
    assert kpi["ca"] == 400.0 and kpi["depenses"] == 220.0 and kpi["marge"] == 180.0
    assert kpi["taux_marge_pct"] == 45.0
    assert kpi["clients"] == 3 and kpi["nb_commandes"] == 4 and kpi["panier_moyen"] == 100.0
    assert kpi["periode"] == {"debut": "2026-06-02", "fin": "2026-07-20"}
    assert kpi["top_produits"][0] == {"produit": "Casque", "ca": 200.0, "quantite": 2}
    assert [m["mois"] for m in kpi["ca_par_mois"]] == ["2026-06", "2026-07"]
    assert kpi["ca_par_mois"][0]["evolution_pct"] is None and kpi["ca_par_mois"][1]["evolution_pct"] == 0.0


def test_rapport_kpi_csv_exemple_du_site(tmp_path):
    sortie = tmp_path / "kpi.json"
    assert rapport_kpi.main(["--sortie", str(sortie)]) == 0
    kpi = json.loads(sortie.read_text(encoding="utf-8"))
    assert kpi["ca"] > 0 and kpi["clients"] == 9 and len(kpi["ca_par_mois"]) == 3
    assert kpi["source_csv"] == "ventes_exemple.csv"


def test_rapport_kpi_colonne_manquante(tmp_path):
    csv = tmp_path / "mauvais.csv"
    csv.write_text("date,montant\n2026-01-01,10\n", encoding="utf-8")
    assert rapport_kpi.main(["--csv", str(csv), "--sortie", str(tmp_path / "kpi.json")]) == 1


# --- commun ---------------------------------------------------------------
def test_publier_google_sheet_ignore_sans_secrets(monkeypatch):
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("GOOGLE_SHEET_ID", raising=False)
    assert commun.publier_google_sheet("prix", [{"a": 1}]) is False


def test_prix_json_du_site_reste_valide():
    data = json.loads((commun.DATA_DIR / "prix.json").read_text(encoding="utf-8"))
    assert isinstance(data, list) and data
    for ligne in data:
        assert set(ligne) == {"titre", "prix", "lien", "note"}
        assert isinstance(ligne["prix"], (int, float)) and 0 <= ligne["note"] <= 5
