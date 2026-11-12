# Studio

Notes Markdown reliées entre elles, stockées uniquement sur tes appareils. Pas de compte, pas de serveur, aucune dépendance à l'exécution. Écrit en TypeScript strict.

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
npm install          # TypeScript et esbuild (outils de développement uniquement)
npm run serve        # build en continu + http://localhost:8000
```

Les modules JavaScript et le chiffrement demandent `http://localhost` ou HTTPS : ouvrir `index.html` directement ne suffit pas.

| Commande | Rôle |
|---|---|
| `npm run build` | Compile `src/` dans `dist/` : un seul `app.js` minifié, CSS minifié, service worker avec la liste des fichiers et une version de cache calculée sur leur contenu |
| `npm run typecheck` | Vérifie les types (TypeScript strict, sans aucun `any` implicite) |
| `npm run check` | Vérifie le build : fichiers cités présents, cache hors ligne complet, aucune clé d'API dans le dépôt |
| `npm run verify` | Les trois à la suite (ce que lance la CI) |

## Publier sur GitHub Pages

Servir le dossier `dist/` produit par `npm run build` (chaque Release contient aussi `Studio-web.zip`). Tous les chemins sont relatifs : l'app fonctionne dans un sous-dossier. La version du cache hors ligne change d'elle-même à chaque build.

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
index.html, manifest.webmanifest   page et installation (copiés dans dist/ au build)
css/app.css                        styles, thèmes clair et sombre
src/                               TypeScript strict
  app.ts            interface : vues, éditeur, palette, raccourcis (point d'entrée)
  boot.ts           thème appliqué avant le premier affichage
  types.ts          types du domaine : Note, Version, vues, API de l'application
  env.d.ts          pont vers l'app native (Touch ID, notes vocales, notifications)
  core/             données et sécurité — aucun code d'interface
    store.ts          notes, index des liens et tags, versions, import/export, fusion entre appareils
    db.ts             IndexedDB, chiffrement transparent des enregistrements
    crypto.ts         AES-GCM, PBKDF2, HKDF
    vault.ts          coffre : clé maîtresse, mot de passe, passkey, biométrie, secrets
    biometric.ts      pont vers Touch ID / Face ID de l'app native
  features/         pages et fonctions de l'app
    home.ts           accueil
    tasks.ts          tâches, sous-tâches, échéances, tickets Linear
    voice.ts          notes vocales (transcription sur l'appareil)
    hub.ts            réglages, coffre, agents, blocs spéciaux, liaison d'appareils
  integrations/     services extérieurs, appelés directement depuis l'app
    ai.ts             Claude, OpenAI, modèle local : boucle d'agent et outils
    link.ts           liaison et synchronisation entre appareils (WebRTC)
    linear/           api.ts (GraphQL typé), page.ts (tickets, projets, fiche), notifications.ts
    github/           api.ts (actualité des dépôts), page.ts
  lib/              outils sans état : markdown, calc, schema, graph, qr, fuzzy, diff, zip
  ui/               kit.ts (icônes, menus, fenêtres), caret.ts (curseur d'écriture)
  sw/sw.ts          service worker (compilé avec les types « worker »)
native/             apps Mac et iPhone (Swift) et leurs scripts de build
scripts/            build.ts (esbuild) et check.ts, exécutés directement par Node
```

Règles : `lib/` et `core/` n'importent jamais `features/` ni `integrations/` ; seules les pages touchent à l'interface. Toute donnée venue de l'extérieur (sauvegarde, autre appareil, API) est validée avant usage ; un élément d'interface manquant lève une erreur explicite (`need()`) plutôt qu'un plantage obscur.

## Builds, licence et contributions

- **CI** ([`.github/workflows/build.yml`](.github/workflows/build.yml)) à chaque push et pull request : types TypeScript stricts, build, vérifications (cache hors ligne complet, aucune clé d'API dans le code), build de l'app Mac, compilation de l'app iPhone. En local : `npm run verify`.
- **Publication** : chaque push sur `main` publie une Release (`v1.0.<n>`) avec `Studio-macOS.zip` et `Studio-web.zip`. Un tag `v…` fait de même avec son propre nom.
- **Licence** : [MIT](LICENSE). Chacun peut lire, réutiliser et modifier le code.
- **Contributions** : les pull requests sont bienvenues ; seul le mainteneur peut les accepter ([`CODEOWNERS`](.github/CODEOWNERS)).

Les données vivent dans IndexedDB (base `carnet`). Vider les données du site efface les notes : l'export JSON (palette → « Exporter tout en JSON ») sert de sauvegarde.
