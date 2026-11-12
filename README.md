# Studio

Notes Markdown reliées entre elles, stockées uniquement dans le navigateur. Pas de compte, pas de serveur, pas de dépendance, pas d'étape de build.

Connectées à Claude, OpenAI ou un modèle local, à Linear et à tes autres appareils — toujours sans backend, et chiffrées de bout en bout.

## Applications Mac et iPhone

Studio existe aussi en applications natives qui embarquent leurs fichiers : rien n'est mis en ligne, aucun serveur.

- **Mac** : `./native/build-mac.sh --install` construit `Studio.app` (Apple Silicon et Intel, ~1 Mo) et l'installe dans `/Applications`. Seuls les outils en ligne de commande d'Apple sont nécessaires.
- **iPhone / iPad** : installer Xcode (App Store), puis `./native/ios.sh` génère le projet et l'ouvre ; choisir son identifiant Apple dans *Signing*, brancher l'iPhone et lancer (⌘R). Avec un identifiant Apple gratuit, Apple impose de réinstaller l'app tous les 7 jours.
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

- **Coffre** (Réglages → Sécurité, `⌘,`) : une clé maîtresse aléatoire de 256 bits chiffre (AES-GCM) chaque enregistrement IndexedDB — notes, historique — ainsi que les clés API et les appareils liés. Elle est emballée par une clé dérivée du mot de passe (PBKDF2, 600 000 itérations) et, en option, par une passkey Face ID / Touch ID (WebAuthn, extension PRF). Verrouillage automatique après inactivité.
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

| Fichier | Rôle |
|---|---|
| `js/app.js` | Interface : éditeur, palette, capture, historique, raccourcis |
| `js/store.js` | Données : notes, index des liens et tags, versions, chiffrement, import/export |
| `js/markdown.js` | Rendu Markdown et blocs intelligents |
| `js/calc.js` | Évaluateur des calculs inline (sans `eval`) |
| `js/graph.js` | Vue en graphe (canvas) |
| `js/kit.js` | Icônes, menus, fenêtres, toasts |
| `js/notifs.js` | Notifications Linear : interrogation directe de l’API toutes les minutes, page dédiée, pastille et notifications système |
| `js/todo.js` | Page Tâches : ajout en langage naturel, échéances, regroupement |
| `js/hub.js` | Interface des connexions, agents, blocs spéciaux, accueil en widgets |
| `js/vault.js` | Coffre : clé maîtresse, mot de passe, passkey, secrets |
| `js/ai.js` | Fournisseurs d'IA, boucle d'agent et outils, planification |
| `js/linear.js` | Client GraphQL Linear |
| `js/link.js` | Liaison et synchronisation entre appareils |
| `js/schema.js` | Lecture SQL / mini-langage, mise en page et rendu des schémas |
| `js/qr.js` | Générateur de QR code |
| `js/db.js`, `crypto.js`, `fuzzy.js`, `diff.js`, `zip.js` | IndexedDB, AES-GCM, recherche floue, diff, archive ZIP |
| `css/app.css` | Styles, thèmes clair et sombre |
| `sw.js` | Cache hors ligne |

Les données vivent dans IndexedDB (base `carnet`). Vider les données du site efface les notes : l'export JSON (palette → « Exporter tout en JSON ») sert de sauvegarde.
