# Studio

Notes Markdown reliées entre elles, stockées uniquement sur tes appareils. Pas de compte, pas de serveur, aucune dépendance à l'exécution. Écrit en TypeScript strict.

Connectées à Claude, OpenAI ou un modèle local, à Linear, à GitHub et à tes autres appareils — toujours sans backend, et chiffrées de bout en bout.

[![Build](https://github.com/MTthoas/Studio/actions/workflows/build.yml/badge.svg)](https://github.com/MTthoas/Studio/actions/workflows/build.yml) · Licence [MIT](LICENSE)

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

### Commande `studio`

```bash
ln -sf "$PWD/bin/studio" ~/.local/bin/studio   # une seule fois (un dossier présent dans le PATH)

studio           # ouvre l'app Mac (la construit et l'installe si elle manque)
studio web       # version web en local, reconstruite à chaque modification
studio update    # reconstruit l'app Mac depuis les sources et la réinstalle
```

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

Elle s'affiche en **liste** ou en **Kanban** (À faire, En cours, Terminées : glisser-déposer, ou boutons ‹ › au clavier et au doigt). Une tâche en cours s'écrit `- [/]` en Markdown. Avec Linear connecté, la même page montre **tes tickets** et chacune de tes **vues Linear enregistrées**, en liste ou en Kanban ; déplacer une carte change l'état du ticket dans Linear.

Les agents planifiés tournent tant que l'application est ouverte (rattrapage unique au retour).

## Projets

Un **projet** réunit son dossier sur le Mac, son ou ses dépôts GitHub, son projet Linear, ses tâches et ses notes. C'est une note qui contient un bloc :

```projet
nom: Studio
dépôts: MTthoas/Studio
linear: Studio
site: https://studio.exemple.com
```

- Une note ou une tâche y appartient avec le tag `#projet/studio` — posé par le bouton **Projet** de l'éditeur, le menu d'une tâche, ou en créant depuis la page du projet.
- Le **cockpit** du projet montre les PR ouvertes avec leur CI et leurs revues, l'activité du dépôt, les tickets Linear, les tâches et les notes ; il ouvre le dossier dans **VS Code**, le Finder ou le Terminal (app Mac).
- Le **dossier local** est choisi dans le sélecteur de macOS et reste dans les réglages de l'app Mac : il n'est jamais écrit dans une note ni synchronisé. L'app n'en lit l'état Git qu'en lecture seule.
- La page Tâches filtre par projet, en liste ou en Kanban.

Chaque projet a ses **sous-menus**, aussi listés dans la barre latérale :

| Onglet | Ce qu'on y trouve |
| --- | --- |
| Vue d'ensemble | Une carte par sous-menu : tâches ouvertes, PR et CI, flux, dernière session IA, état du site, notes |
| Code | Dossier local, branches locales (avance / retard), PR et activité, **revue IA** des changements en cours ou de la branche |
| Flux | Le parcours de chaque branche façon gitflow : en cours → PR ouverte → prête à fusionner → fusionnée → publiée (Release), avec CI et revues |
| Sessions IA | Les sessions **Claude Code** menées dans le dossier, en direct : ce qu'elles font, fichiers modifiés, tokens consommés, état de la limite d'utilisation |
| Tâches · Notes | Ce qui est tagué `#projet/<nom>` |
| Site | Le site du projet, vérifié depuis le Mac (en ligne, code, temps de réponse) |

- **Sessions IA** : l'app Mac lit les journaux locaux de Claude Code (`~/.claude/projects/…`), en lecture seule ; rien ne quitte la machine.
- **Revue IA** : le diff est lu en local, montré, puis envoyé à l'IA branchée seulement après ton clic ; la revue peut être enregistrée comme note du projet.
- **Consommation des clés API** (Réglages → IA) : tokens du mois par fournisseur et modèle, et ce qu'il reste sur le budget mensuel que tu fixes. L'utilisation de l'abonnement Claude est à part, dans la carte Claude Code.

## Claude Code (ton abonnement, sans clé API)

Sur Mac, Studio peut passer par le **Claude Code** installé sur la machine, connecté à ton abonnement Claude : Réglages → Intelligence artificielle → carte **Claude Code**. Studio le détecte, guide l'installation et la connexion si besoin, puis un clic sur **Utiliser Claude Code** en fait le fournisseur par défaut.

- Claude Code tourne **sans ses propres outils** (`--tools ""`), sans serveur MCP, sans tes réglages ni tes hooks, sans session enregistrée, dans un dossier vide propre à Studio. Il ne lance aucune commande et ne lit aucun fichier.
- Les automatisations gardent leurs outils (ranger une note, créer une tâche…) : Claude Code renvoie les appels sous forme structurée, Studio les exécute, avec ton accord pour toute modification.
- La consommation passe par les limites de ton abonnement : elle est comptée à part du budget des clés API.
- **Utilisation de l'abonnement** (dans la carte Claude Code) : les tokens consommés par Claude Code sur ce Mac (5 dernières heures, aujourd'hui, 7 jours, par modèle), lus dans ses journaux locaux, toutes sessions confondues. Sur demande (**Afficher mes limites**), la part utilisée de la session de 5 heures et de la semaine, comme `/usage` : Studio lit alors la connexion de Claude Code dans le trousseau (macOS demande ton accord) et interroge `api.anthropic.com`, en lecture seule. Le jeton ne quitte jamais l'app native et n'est jamais renouvelé par Studio.

## Piloter ses projets : Claude Code, serveurs, à distance

Chaque projet a un onglet **Claude Code** : tu écris une consigne, Claude Code travaille dans le dépôt du projet, et tu suis tout en direct.

- **Modifier** : Claude Code travaille dans une **copie isolée** du dépôt (worktree Git dans `.claude/worktrees/`, exclue de `git status`). Ton dossier n'est jamais touché. Ensuite : **Revue** IA, **VS Code**, **Publier** (commit, push, pull request en un clic) ou **Supprimer**. À la publication, Studio propose le type (`feat`, `fix`, `chore`…) et des titres au format des commits conventionnels, rédigés par l'IA à partir de la consigne, du compte rendu de l'agent et de la liste des fichiers modifiés.
- **Analyser** : lecture seule, Claude Code explore et propose.
- **Notes et tâches** : joins des notes du projet à une consigne (« Joindre une note »), ou confie directement une note (bouton **Claude Code** de l'éditeur, onglet Notes) ou une tâche (onglet Tâches). Le contenu des notes jointes accompagne la consigne ; les notes chiffrées ou `#privé` ne sont jamais envoyées.
- **Publier** : Studio propose le message de commit au format Conventional Commits (`feat`, `fix`, `chore`…, 1 à 2 lignes), rédigé par l'IA d'après le diff et dans le style des commits récents, puis un nom de branche assorti (`feat/…`). Le jeton GitHub a besoin de « Pull requests : lecture et écriture » pour ouvrir la PR ; sans ce droit, Studio ouvre la page de la PR sur GitHub, déjà remplie.
- **Garde-fous** : `--restricted` (fichiers confinés au dossier de travail), `--permission-mode dontAsk` et une liste explicite d'outils (lecture, écriture). Aucune commande ne s'exécute, sauf si tu coches **Tests npm** (`npm test`, `npm run …`). Pas de réglages, hooks ni serveurs MCP de l'utilisateur ; trois agents au plus, 90 minutes au plus.
- **Sessions** : toutes les sessions Claude Code du projet (y compris celles lancées hors de Studio), avec leur fil, les fichiers touchés, les tokens, la limite d'utilisation ; chacune peut être **reprise**.
- **Vue d'ensemble** : graphiques (commits par jour, tokens Claude Code par jour, santé de la CI, avancement des tâches), barre de consigne rapide et agents en cours.

**Serveur** (VPS, VM) : relie un hôte SSH (alias de `~/.ssh/config` ou `utilisateur@hôte`) et le dossier du projet sur ce serveur. Studio affiche son état (charge, mémoire, disque, dépôt, Claude Code), ouvre un terminal SSH, et y lance des agents Claude Code avec les mêmes garde-fous. Connexion par clé uniquement (`BatchMode`), commandes distantes fixes et protégées, configuration gardée dans l'app Mac.

**À distance** : depuis l'iPhone (ou un autre ordinateur) lié au Mac, tu suis les agents, lances une consigne, reprends ou arrêtes une session — via la liaison chiffrée de bout en bout. Sur le Mac, chaque appareil doit être autorisé (Réglages → Appareils → « Peut piloter Claude Code sur ce Mac ») ; seules ces actions passent, jamais les commandes ni la publication, et chacune est signalée sur le Mac. Studio doit rester ouvert sur le Mac.

## Plugins

Les fonctions de Studio se branchent sur un registre d'extensions (`src/plugins/registry.ts`) : panneaux de la page projet, actions sur une tâche. GitHub et Linear y sont déjà enregistrés comme plugins maison (`src/plugins/builtin.ts`). Prochaines étapes : plugins déclaratifs (modèles, thèmes), puis plugins avec code, isolés et soumis à permissions.

## Automatisations

Studio est pensé autour de l'automatisation : une **automatisation** est une consigne en langage naturel, écrite dans une note (bloc ` ```agent `), que l'IA exécute avec des outils — lire et ranger les notes, créer des tâches, lire l'activité Linear et GitHub, ouvrir des tickets.

- **Quand** : à la demande, à heure fixe (`planning: jours ouvrés 9h`), ou à chaque événement (`déclencheur: capture`, `linear`, `github`, `tâche`).
- **Sûreté** : toute écriture est soumise à ton accord ; le contenu des notes et des événements est transmis comme donnée, jamais comme consigne ; une note `#privé` n'est jamais envoyée.
- **Page Automatisations** : modèles prêts à l'emploi (revue du matin, tri des captures, notifications Linear changées en tâches, veille GitHub, bilan de la semaine), pause, et journal des exécutions.

La page **Aide** (touche `?`) explique la prise en main en cartes courtes ; l'accueil propose des **premiers pas** qui se cochent d'eux-mêmes.

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
    projects/         projets : modèle (bloc ```projet, tags) et page cockpit
    automations.ts, help.ts, onboarding.ts, board.ts
  integrations/     services extérieurs, appelés directement depuis l'app
    ai.ts             Claude, OpenAI, modèle local : boucle d'agent et outils
    link.ts           liaison et synchronisation entre appareils (WebRTC)
    linear/           api.ts (GraphQL typé), page.ts (tickets, projets, fiche), notifications.ts
    github/           api.ts (actualité des dépôts), page.ts
  lib/              outils sans état : markdown, calc, schema, graph, qr, fuzzy, diff, zip
  plugins/          registre d'extensions et plugins maison (GitHub, Linear)
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
