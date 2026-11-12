# Studio

Notes Markdown reliées entre elles, stockées uniquement dans le navigateur. Pas de compte, pas de serveur, pas de dépendance, pas d'étape de build.

Connectées à Claude, OpenAI ou un modèle local, à Linear, à GitHub et à tes autres appareils — toujours sans backend, et chiffrées de bout en bout.

[![Build](https://github.com/MTthoas/Notes/actions/workflows/build.yml/badge.svg)](https://github.com/MTthoas/Notes/actions/workflows/build.yml) · Licence [MIT](LICENSE)

## Applications Mac et iPhone

Studio existe aussi en applications natives qui embarquent leurs fichiers : rien n'est mis en ligne, aucun serveur.

- **Mac** : `./native/build-mac.sh --install` construit `Studio.app` (Apple Silicon et Intel, ~1 Mo) et l'installe dans `/Applications`. Seuls les outils en ligne de commande d'Apple sont nécessaires. Chaque push produit aussi l'app dans l'onglet *Actions* de GitHub, et chaque tag `v…` la publie dans les *Releases*.
- **iPhone / iPad** : Xcode (App Store) avec la plateforme iOS (Xcode → Settings → Components), ton identifiant Apple ajouté dans Xcode → Settings → Accounts, l'iPhone branché, puis `./native/iphone.sh` compile et installe l'app sans ouvrir Xcode. Avec un identifiant Apple gratuit, Apple impose de réinstaller l'app tous les 7 jours.
- Les deux apps se relient ensuite par Réglages → Appareils.

Le dossier [`native/`](native/) contient la coquille Swift commune ([`Shared/Shell.swift`](native/Shared/Shell.swift)) : les fichiers sont servis par un schéma interne `carnet://`, les liens externes s'ouvrent dans le navigateur, et les exports passent par les panneaux du système.

## Lancer en local

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000. Un simple double-clic sur `index.html` ne suffit pas : les modules JavaScript et le chiffrement demandent `http://localhost` ou HTTPS.

## Publier sur GitHub Pages

Pousser ce dossier dans un dépôt, puis Settings → Pages → « Deploy from a branch » → branche `main`, dossier `/ (root)`. Tous les chemins sont relatifs, l'app fonctionne donc dans un sous-dossier.

Après une modification, incrémenter `CACHE` dans `sw.js` pour que les navigateurs récupèrent la nouvelle version.

## Sur Mac

- Safari : Fichier → « Ajouter au Dock ». Chrome : ⋮ → « Installer Studio ». L'app s'ouvre alors dans sa propre fenêtre et fonctionne hors ligne.
- Clic droit sur l'icône du Dock : Capture rapide, Nouvelle note, Aujourd'hui.

## Sécurité

- **Coffre** (Réglages → Sécurité, `⌘,`) : une clé maîtresse aléatoire de 256 bits chiffre (AES-GCM) chaque enregistrement IndexedDB — notes, historique — ainsi que les clés API et les appareils liés. Elle est emballée par une clé dérivée du mot de passe (PBKDF2, 600 000 itérations) et, en option, par une passkey Face ID / Touch ID dans un navigateur (WebAuthn, extension PRF) ou, dans les apps natives, par un secret aléatoire du trousseau du système que Touch ID / Face ID libère (le mot de passe n'est jamais stocké et reste toujours valable). Verrouillage automatique après inactivité.
- **Politique de sécurité (CSP)** dans `index.html` : le code ne peut joindre que `api.anthropic.com`, `api.openai.com`, `api.linear.app`, `ntfy.sh` et `localhost`. Une clé ne peut donc pas partir ailleurs, même en cas de faille. Aucune image distante n'est chargée.
- **IA** : appels directs du navigateur vers le fournisseur, avec ta clé. Les notes chiffrées et celles taguées `#privé` ne sont jamais envoyées. Toute action d'écriture d'un agent (créer une note, une issue…) demande ton accord.
- **Sauvegarde JSON** : chiffrée par mot de passe quand le coffre est actif.

## Liaison téléphone ↔ ordinateur

Réglages → Appareils → « Lier un appareil ». Un secret de 128 bits passe d'un écran à l'autre (QR code ou copier-coller via le presse-papiers universel). Il chiffre une courte poignée de main relayée par `ntfy.sh` — qui ne voit que du chiffré, non stocké — puis les notes passent en direct entre appareils (WebRTC), et en temps réel tant que les deux sont ouverts. Une note modifiée des deux côtés garde la version perdante dans l'historique. Sans réseau : « Paquet chiffré » (AirDrop, Messages…).

## Blocs spéciaux

| Bloc | Effet |
|---|---|
| ` ```sql ` / ` ```schema ` | Diagramme entité-association ; export SQL, Mermaid, SVG |
| ` ```agent ` | Agent IA (outils : `notes`, `linear`, `agents`), lançable ou planifié |
| ` ```linear ` | Liste d'issues Linear filtrée (assigné, état, équipe…) |

La page **Tâches** (⇧⌘T) réunit une liste dédiée — « Appeler Paul demain » crée une tâche avec échéance — et les cases à cocher de toutes les notes. Les tâches sont stockées dans une note Markdown « Tâches » : chiffrées, synchronisées et versionnées comme le reste.

Les agents planifiés tournent tant que l'application est ouverte (rattrapage unique au retour).

## Organisation

```
index.html, sw.js, manifest.webmanifest   page, cache hors ligne, installation
css/app.css                               styles, thèmes clair et sombre
js/
  app.js            interface : vues, éditeur, palette, raccourcis (point d'entrée)
  boot.js           thème appliqué avant le premier affichage
  core/             données et sécurité — aucun code d'interface
    store.js          notes, index des liens et tags, versions, import/export
    db.js             IndexedDB, chiffrement transparent des enregistrements
    crypto.js         AES-GCM, PBKDF2, HKDF
    vault.js          coffre : clé maîtresse, mot de passe, passkey, biométrie, secrets
    biometric.js      pont vers Touch ID / Face ID de l'app native
  features/         pages et fonctions de l'app
    home.js           accueil
    tasks.js          tâches, sous-tâches, échéances, tickets Linear
    voice.js          notes vocales (transcription sur l'appareil)
    hub.js            réglages, coffre, agents, blocs spéciaux, liaison d'appareils
  integrations/     services extérieurs, appelés directement depuis l'app
    ai.js             Claude, OpenAI, modèle local : boucle d'agent et outils
    link.js           liaison et synchronisation entre appareils (WebRTC)
    linear/           api.js (GraphQL), page.js (tickets, projets, fiche), notifications.js
    github/           api.js (actualité des dépôts), page.js
  lib/              outils sans état : markdown, calc, schema, graph, qr, fuzzy, diff, zip
  ui/               kit.js (icônes, menus, fenêtres), caret.js (curseur d'écriture)
native/             apps Mac et iPhone (Swift) et leurs scripts de build
scripts/check.mjs   vérifications lancées par la CI
```

Règle de dépendance : `lib/` et `core/` n'importent jamais `features/` ni `integrations/` ; seules les pages (`features/`, `integrations/*/page.js`) touchent à l'interface.

## Builds, licence et contributions

- **CI** ([`.github/workflows/build.yml`](.github/workflows/build.yml)) à chaque push et pull request : `node scripts/check.mjs` (syntaxe, imports, cache hors ligne complet, aucune clé d'API dans le code), build de l'app Mac, compilation de l'app iPhone. Les mêmes vérifications se lancent en local avec `node scripts/check.mjs`.
- **Publication** : `git tag v1.0.0 && git push --tags` publie `Studio-macOS.zip` dans les Releases.
- **Licence** : [MIT](LICENSE). Chacun peut lire, réutiliser et modifier le code.
- **Contributions** : les pull requests sont bienvenues ; seul le mainteneur peut les accepter ([`CODEOWNERS`](.github/CODEOWNERS)).

Les données vivent dans IndexedDB (base `carnet`). Vider les données du site efface les notes : l'export JSON (palette → « Exporter tout en JSON ») sert de sauvegarde.
