# Carnet

Notes Markdown reliées entre elles, stockées uniquement dans le navigateur. Pas de compte, pas de serveur, pas de dépendance, pas d'étape de build.

## Lancer en local

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000. Un simple double-clic sur `index.html` ne suffit pas : les modules JavaScript et le chiffrement demandent `http://localhost` ou HTTPS.

## Publier sur GitHub Pages

Pousser ce dossier dans un dépôt, puis Settings → Pages → « Deploy from a branch » → branche `main`, dossier `/ (root)`. Tous les chemins sont relatifs, l'app fonctionne donc dans un sous-dossier.

Après une modification, incrémenter `CACHE` dans `sw.js` pour que les navigateurs récupèrent la nouvelle version.

## Sur Mac

- Safari : Fichier → « Ajouter au Dock ». Chrome : ⋮ → « Installer Carnet ». L'app s'ouvre alors dans sa propre fenêtre et fonctionne hors ligne.
- Clic droit sur l'icône du Dock : Capture rapide, Nouvelle note, Aujourd'hui.

## Organisation

| Fichier | Rôle |
|---|---|
| `js/app.js` | Interface : éditeur, palette, capture, historique, raccourcis |
| `js/store.js` | Données : notes, index des liens et tags, versions, chiffrement, import/export |
| `js/markdown.js` | Rendu Markdown et blocs intelligents |
| `js/calc.js` | Évaluateur des calculs inline (sans `eval`) |
| `js/graph.js` | Vue en graphe (canvas) |
| `js/kit.js` | Icônes, menus, fenêtres, toasts |
| `js/db.js`, `crypto.js`, `fuzzy.js`, `diff.js`, `zip.js` | IndexedDB, AES-GCM, recherche floue, diff, archive ZIP |
| `css/app.css` | Styles, thèmes clair et sombre |
| `sw.js` | Cache hors ligne |

Les données vivent dans IndexedDB (base `carnet`). Vider les données du site efface les notes : l'export JSON (palette → « Exporter tout en JSON ») sert de sauvegarde.
