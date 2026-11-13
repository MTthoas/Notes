# Studio

[![Build](https://github.com/MTthoas/Studio/actions/workflows/build.yml/badge.svg)](https://github.com/MTthoas/Studio/actions/workflows/build.yml)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Notes, tâches, Linear, GitHub et Claude Code au même endroit — chiffrés, sans compte ni serveur.**

Studio est un carnet de notes Markdown reliées entre elles, stockées uniquement sur tes appareils. Il se connecte à Claude, OpenAI ou un modèle local, à Linear, à GitHub et à tes autres appareils, toujours sans backend et chiffré de bout en bout. Il existe en application web installable, en app Mac et en app iPhone / iPad.

- **Écrire** : des notes en texte simple, reliées par `[[liens]]` et rangées par `#tags`, comme un wiki personnel.
- **Centraliser** : tâches, tickets Linear, pull requests et CI GitHub à côté de tes notes, regroupés par projet.
- **Automatiser** : une consigne en langage naturel, exécutée par l'IA à la demande, à heure fixe ou à chaque événement.
- **Piloter** : des agents Claude Code qui travaillent dans tes dépôts, suivis en direct depuis le Mac ou l'iPhone.
- **Garder la main** : aucune dépendance à l'exécution, TypeScript strict, données chiffrées, toute écriture d'une IA soumise à ton accord.

## Sommaire

- [Démarrage rapide](#démarrage-rapide)
- [Installer](#installer)
- [Écrire](#écrire)
- [Tâches](#tâches)
- [Projets](#projets)
- [Claude Code](#claude-code)
- [Automatisations](#automatisations)
- [Liaison entre appareils](#liaison-entre-appareils)
- [Sécurité](#sécurité)
- [Développement](#développement)
- [Licence et contributions](#licence-et-contributions)

## Démarrage rapide

Prérequis : Node.js ≥ 22.18 (outils de développement uniquement : TypeScript et esbuild).

```bash
git clone https://github.com/MTthoas/Studio.git && cd Studio
npm install
npm run serve        # build en continu + http://localhost:8000
```

Sur Mac, pour l'application native plutôt que le navigateur :

```bash
./native/build-mac.sh --install   # construit Studio.app et l'installe dans /Applications
```

Sans rien compiler : chaque [Release](https://github.com/MTthoas/Studio/releases) contient `Studio-macOS.zip` (l'app Mac) et `Studio-web.zip` (l'app web, à servir telle quelle).

Dans l'app, la page **Aide** (touche `?`) explique la prise en main en cartes courtes, et l'accueil propose des **premiers pas** qui se cochent d'eux-mêmes.

## Installer

### Mac

`./native/build-mac.sh --install` construit `Studio.app` (Apple Silicon et Intel, ~1 Mo, macOS 13 ou plus récent) et l'installe dans `/Applications`. Seuls les outils en ligne de commande d'Apple sont nécessaires.

La commande `studio` évite de retenir les scripts :

```bash
ln -sf "$PWD/bin/studio" ~/.local/bin/studio   # une seule fois (un dossier présent dans le PATH)

studio           # ouvre l'app Mac (la construit et l'installe si elle manque)
studio web       # version web en local, reconstruite à chaque modification
studio update    # reconstruit l'app Mac depuis les sources et la réinstalle
studio help      # rappel des commandes
```

### iPhone et iPad

1. Installe Xcode (App Store) et la plateforme iOS (Xcode → Settings → Components).
2. Ajoute ton identifiant Apple dans Xcode → Settings → Accounts.
3. Branche l'iPhone, puis lance `./native/iphone.sh` : l'app est compilée et installée sans ouvrir Xcode.

Avec un identifiant Apple gratuit, Apple impose de réinstaller l'app tous les 7 jours (relancer `./native/iphone.sh`). Pour passer par Xcode à la place, `./native/ios.sh` génère et ouvre le projet.

### Navigateur

L'app web s'installe comme une application et fonctionne hors ligne :

- **Safari** : Fichier → « Ajouter au Dock ». **Chrome** : ⋮ → « Installer Studio ».
- Clic droit sur l'icône du Dock : Capture rapide, Nouvelle note, Aujourd'hui.

Les modules JavaScript et le chiffrement demandent `http://localhost` ou HTTPS : ouvrir `index.html` directement ne suffit pas.

### Héberger l'app web

Sers le dossier `dist/` produit par `npm run build`, par exemple sur GitHub Pages. Tous les chemins sont relatifs : l'app fonctionne dans un sous-dossier. La version du cache hors ligne change d'elle-même à chaque build.

## Écrire

Du Markdown, plus quelques écritures qui donnent vie à une note :

| Écriture | Effet |
|---|---|
| `[[Titre d'une note]]` | Lien vers une autre note, même si elle n'existe pas encore ; chaque note montre qui la cite, et le graphe dessine l'ensemble |
| `#idée`, `#projet/studio` | Range la note, sans dossier à choisir ; une capture sans tag va dans la boîte de réception |
| `#privé` | La note n'est jamais envoyée à une IA |
| `- [ ]`, `- [/]`, `- [x]` | Tâche à faire, en cours, terminée — retrouvée dans la page Tâches |
| `` `= 1200 * 12` `` | Calcul affiché dans la note |
| `[timer 25m]` | Minuteur dans la note |
| ` ```sql ` / ` ```schema ` | Diagramme entité-association ; export SQL, Mermaid, SVG |
| ` ```linear ` | Liste d'issues Linear filtrée (assigné, état, équipe…), toujours à jour |
| ` ```agent ` | [Automatisation](#automatisations) : agent IA lançable, planifié ou déclenché par un événement |
| ` ```projet ` | Fait de la note un [projet](#projets) |

Les tableaux Markdown sont triables, chaque note garde son historique de versions, et sur iPhone le bouton micro transforme ta voix en note (transcription sur l'appareil).

### Raccourcis à retenir

`⌘` sur Mac, `Ctrl` ailleurs. La liste complète est dans la page Aide.

| Raccourci | Action |
|---|---|
| `⌘K` | Palette de commandes : tout trouver, tout lancer |
| `⌘J` | Capture rapide |
| `⌥⌘N` | Nouvelle note |
| `⇧⌘T` | Tâches |
| `⇧⌘D` | Note du jour |
| `⌘,` | Réglages |
| `?` | Aide |

## Tâches

La page **Tâches** (`⇧⌘T`) réunit une liste dédiée — « Appeler Paul demain » crée une tâche avec échéance — et les cases à cocher de toutes les notes. Les tâches sont stockées dans une note Markdown « Tâches » : chiffrées, synchronisées et versionnées comme le reste.

Elle s'affiche en **liste** ou en **Kanban** (À faire, En cours, Terminées : glisser-déposer, ou boutons ‹ › au clavier et au doigt), et se filtre par projet.

Avec Linear connecté, la même page montre **tes tickets** et chacune de tes **vues Linear enregistrées**, en liste ou en Kanban ; déplacer une carte change l'état du ticket dans Linear.

## Projets

Un **projet** réunit son dossier sur le Mac, son ou ses dépôts GitHub, son projet Linear, ses tâches et ses notes. C'est une note qui contient un bloc :

````markdown
```projet
nom: Studio
dépôts: MTthoas/Studio
linear: Studio
site: https://studio.exemple.com
```
````

- Une note ou une tâche y appartient avec le tag `#projet/studio` — posé par le bouton **Projet** de l'éditeur, le menu d'une tâche, ou en créant depuis la page du projet.
- Le **dossier local** est choisi dans le sélecteur de macOS et reste dans les réglages de l'app Mac : il n'est jamais écrit dans une note ni synchronisé. L'app n'en lit l'état Git qu'en lecture seule.
- Depuis le projet, le dossier s'ouvre dans **VS Code**, le Finder ou le Terminal (app Mac).

Chaque projet a ses onglets, aussi listés dans la barre latérale :

| Onglet | Ce qu'on y trouve |
|---|---|
| Vue d'ensemble | Une carte par onglet (tâches ouvertes, PR et CI, flux, dernière session IA, état du site, notes), des graphiques (commits par jour, tokens Claude Code par jour, santé de la CI, avancement des tâches), une barre de consigne rapide et les agents en cours |
| Claude Code | Les agents lancés sur le projet et toutes ses sessions, en direct ([détails](#agents-dans-un-projet)) |
| Code | Dossier local, branches locales (avance / retard), PR et activité, **revue IA** des changements en cours ou de la branche |
| Flux | Le parcours de chaque branche façon gitflow : en cours → PR ouverte → prête à fusionner → fusionnée → publiée (Release), avec CI et revues |
| Serveur | L'hôte SSH du projet : état, terminal, agents distants ([détails](#sur-un-serveur)) |
| Tâches · Notes | Ce qui est tagué `#projet/<nom>` |
| Site | Le site du projet, vérifié depuis le Mac (en ligne, code, temps de réponse) |

- **Revue IA** : le diff est lu en local, montré, puis envoyé à l'IA branchée seulement après ton clic ; la revue peut être enregistrée comme note du projet.
- **Consommation des clés API** (Réglages → IA) : tokens du mois par fournisseur et modèle, et ce qu'il reste sur le budget mensuel que tu fixes.

## Claude Code

### Ton abonnement comme fournisseur d'IA

Sur Mac, Studio peut passer par le **Claude Code** installé sur la machine, connecté à ton abonnement Claude, sans clé API : Réglages → Intelligence artificielle → carte **Claude Code**. Studio le détecte, guide l'installation et la connexion si besoin, puis un clic sur **Utiliser Claude Code** en fait le fournisseur par défaut.

- Dans ce rôle, Claude Code tourne **sans ses propres outils** (`--tools ""`), sans serveur MCP, sans tes réglages ni tes hooks, sans session enregistrée, dans un dossier vide propre à Studio. Il ne lance aucune commande et ne lit aucun fichier.
- Les automatisations gardent leurs outils (ranger une note, créer une tâche…) : Claude Code renvoie les appels sous forme structurée, Studio les exécute, avec ton accord pour toute modification.
- La consommation passe par les limites de ton abonnement : elle est comptée à part du budget des clés API.
- **Utilisation de l'abonnement** (dans la carte Claude Code) : les tokens consommés par Claude Code sur ce Mac (5 dernières heures, aujourd'hui, 7 jours, par modèle), lus dans ses journaux locaux, toutes sessions confondues. Sur demande (**Afficher mes limites**), la part utilisée de la session de 5 heures et de la semaine, comme `/usage` : Studio lit alors la connexion de Claude Code dans le trousseau (macOS demande ton accord) et interroge `api.anthropic.com`, en lecture seule. Le jeton ne quitte jamais l'app native et n'est jamais renouvelé par Studio.

### Agents dans un projet

Dans l'onglet **Claude Code** d'un projet, tu écris une consigne, Claude Code travaille dans le dépôt, et tu suis tout en direct.

- **Modifier** : Claude Code travaille dans une **copie isolée** du dépôt (worktree Git dans `.claude/worktrees/`, exclue de `git status`). Ton dossier n'est jamais touché. Ensuite : **Revue** IA, **VS Code**, **Publier** ou **Supprimer**.
- **Analyser** : lecture seule, Claude Code explore et propose.
- **Notes et tâches** : joins des notes du projet à une consigne (« Joindre une note »), ou confie directement une note (bouton **Claude Code** de l'éditeur, onglet Notes) ou une tâche (onglet Tâches). Le contenu des notes jointes accompagne la consigne ; les notes chiffrées ou `#privé` ne sont jamais envoyées.
- **Publier** : commit, push et pull request en un clic. Studio propose le message de commit au format Conventional Commits (`feat`, `fix`, `chore`…, 1 à 2 lignes), rédigé par l'IA d'après la consigne, le compte rendu de l'agent et le diff, dans le style des commits récents, puis un nom de branche assorti (`feat/…`). Le jeton GitHub a besoin de « Pull requests : lecture et écriture » pour ouvrir la PR ; sans ce droit, Studio ouvre la page de la PR sur GitHub, déjà remplie.
- **Sessions** : toutes les sessions Claude Code du projet, y compris celles lancées hors de Studio, avec leur fil, les fichiers touchés, les tokens et la limite d'utilisation ; chacune peut être **reprise**. L'app Mac lit les journaux locaux de Claude Code (`~/.claude/projects/…`) en lecture seule ; rien ne quitte la machine.
- **Garde-fous** : `--restricted` (fichiers confinés au dossier de travail), `--permission-mode dontAsk` et une liste explicite d'outils (lecture, écriture). Aucune commande ne s'exécute, sauf si tu coches **Tests npm** (`npm test`, `npm run …`). Pas de réglages, hooks ni serveurs MCP de l'utilisateur ; trois agents au plus, 90 minutes au plus.

### Sur un serveur

Relie un hôte SSH (alias de `~/.ssh/config` ou `utilisateur@hôte`) et le dossier du projet sur ce serveur (VPS, VM). Studio affiche son état (charge, mémoire, disque, dépôt, Claude Code), ouvre un terminal SSH, et y lance des agents Claude Code avec les mêmes garde-fous. Connexion par clé uniquement (`BatchMode`), commandes distantes fixes et protégées, configuration gardée dans l'app Mac.

### À distance

Depuis l'iPhone (ou un autre ordinateur) lié au Mac, tu suis les agents, lances une consigne, reprends ou arrêtes une session — via la liaison chiffrée de bout en bout. Sur le Mac, chaque appareil doit être autorisé (Réglages → Appareils → « Peut piloter Claude Code sur ce Mac ») ; seules ces actions passent, jamais les commandes ni la publication, et chacune est signalée sur le Mac. Studio doit rester ouvert sur le Mac.

## Automatisations

Une **automatisation** est une consigne en langage naturel, écrite dans une note, que l'IA exécute avec des outils — lire et ranger les notes, créer des tâches, lire l'activité Linear et GitHub, ouvrir des tickets.

````markdown
```agent
nom: Tri des captures
outils: notes
déclencheur: capture
---
Range la capture sous les bons tags
et ajoute les actions à mes tâches.
```
````

- **Quand** : à la demande, à heure fixe (`planning: jours ouvrés 9h`, `vendredi 17h`, `toutes les 2h`), ou à chaque événement (`déclencheur: capture`, `linear`, `github`, `tâche`).
- **Sûreté** : toute écriture est soumise à ton accord ; le contenu des notes et des événements est transmis comme donnée, jamais comme consigne ; une note `#privé` n'est jamais envoyée.
- **Page Automatisations** : modèles prêts à l'emploi (revue du matin, tri des captures, notifications Linear changées en tâches, veille GitHub, bilan de la semaine), pause, et journal des exécutions.
- **Limite** : les automatisations planifiées tournent tant que l'application est ouverte, avec un rattrapage unique au retour.

## Liaison entre appareils

Réglages → Appareils → « Lier un appareil ». Un secret de 128 bits passe d'un écran à l'autre (QR code ou copier-coller via le presse-papiers universel). Il chiffre une courte poignée de main relayée par `ntfy.sh` — qui ne voit que du chiffré, non stocké — puis les notes passent en direct entre appareils (WebRTC), et en temps réel tant que les deux sont ouverts.

- Une note modifiée des deux côtés garde la version perdante dans l'historique.
- Sans réseau : « Paquet chiffré », à envoyer par AirDrop, Messages…

## Sécurité

- **Coffre** (Réglages → Sécurité, `⌘,`) : une clé maîtresse aléatoire de 256 bits chiffre (AES-GCM) chaque enregistrement IndexedDB — notes, historique — ainsi que les clés API et les appareils liés. Elle est emballée par une clé dérivée du mot de passe (PBKDF2, 600 000 itérations) et, en option, par une passkey Face ID / Touch ID dans un navigateur (WebAuthn, extension PRF) ou, dans les apps natives, par un secret aléatoire du trousseau du système que Touch ID / Face ID libère. Le mot de passe n'est jamais stocké et reste toujours valable. Verrouillage automatique après inactivité.
- **Politique de sécurité (CSP)** dans `index.html` : le code ne peut joindre que `api.anthropic.com`, `api.openai.com`, `api.linear.app`, `api.github.com`, `ntfy.sh` et `localhost`. Une clé ne peut donc pas partir ailleurs, même en cas de faille. Aucune image distante n'est chargée.
- **IA** : appels directs de l'app vers le fournisseur, avec ta clé. Les notes chiffrées et celles taguées `#privé` ne sont jamais envoyées. Toute action d'écriture d'un agent (créer une note, une issue…) demande ton accord.
- **Apps natives** : les fichiers sont embarqués et servis par un schéma interne `carnet://` ; rien n'est mis en ligne.
- **Sauvegarde** : les données vivent dans IndexedDB (base `carnet`). Vider les données du site efface les notes : l'export JSON (palette → « Exporter tout en JSON ») sert de sauvegarde, chiffrée par mot de passe quand le coffre est actif.

## Développement

### Commandes

| Commande | Rôle |
|---|---|
| `npm run serve` | Build en continu, servi sur `http://localhost:8000` |
| `npm run watch` | Build en continu, sans serveur |
| `npm run build` | Compile `src/` dans `dist/` : un seul `app.js` minifié, CSS minifié, service worker avec la liste des fichiers et une version de cache calculée sur leur contenu |
| `npm run typecheck` | Vérifie les types (TypeScript strict, sans aucun `any` implicite) |
| `npm run check` | Vérifie le build : fichiers cités présents, cache hors ligne complet, aucune clé d'API dans le dépôt |
| `npm run verify` | Les trois à la suite (ce que lance la CI) |

Les scripts de `scripts/` sont du TypeScript exécuté directement par Node, sans étape de compilation.

### Organisation

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
    native.ts         pont générique vers l'app native (demandes numérotées, réponses)
    events.ts         bus d'événements qui déclenche les automatisations
  features/         pages et fonctions de l'app
    home.ts           accueil
    tasks.ts          tâches, sous-tâches, échéances, tickets Linear
    board.ts          Kanban générique (glisser-déposer, clavier, doigt)
    voice.ts          notes vocales (transcription sur l'appareil)
    hub.ts            réglages, coffre, agents, blocs spéciaux, liaison d'appareils
    automations.ts    page Automatisations : modèles, pause, journal
    help.ts, onboarding.ts   aide et premiers pas
    projects/         model.ts (bloc ```projet, tags), page.ts (cockpit et onglets),
                      flux.ts (parcours des branches), review.ts (revue IA), sessions.ts (Claude Code)
  integrations/     services extérieurs, appelés directement depuis l'app
    ai.ts             Claude, OpenAI, modèle local : boucle d'agent et outils
    usage.ts          consommation de tokens par mois, fournisseur et modèle
    link.ts           liaison et synchronisation entre appareils (WebRTC)
    remote.ts         agents Claude Code sur ce Mac ou via un Mac lié
    linear/           api.ts (GraphQL typé), page.ts, render.ts (tickets), notifications.ts
    github/           api.ts (actualité des dépôts), page.ts
  lib/              outils sans état : markdown, calc, schema, graph, qr, fuzzy, diff, zip
  plugins/          registre d'extensions et plugins maison (GitHub, Linear)
  ui/               kit.ts (icônes, menus, fenêtres), caret.ts (curseur d'écriture), chart.ts (graphiques)
  sw/sw.ts          service worker (compilé avec les types « worker »)
native/             apps Mac et iPhone (Swift) et leurs scripts de build
  Shared/             coquille commune : Shell.swift, agents, projets, sessions, serveurs, biométrie, dictée
  macOS/, iOS/        point d'entrée de chaque app
bin/studio          commande de lancement
scripts/            build.ts (esbuild) et check.ts
```

Règles :

- `lib/` et `core/` n'importent jamais `features/` ni `integrations/` ; seules les pages touchent à l'interface.
- Toute donnée venue de l'extérieur (sauvegarde, autre appareil, API) est validée avant usage.
- Un élément d'interface manquant lève une erreur explicite (`need()`) plutôt qu'un plantage obscur.

### Apps natives

Le dossier [`native/`](native/) contient la coquille Swift commune ([`Shared/Shell.swift`](native/Shared/Shell.swift)) : une vue web qui sert les fichiers embarqués par le schéma `carnet://`, ouvre les liens externes dans le navigateur et passe les exports par les panneaux du système. Le reste de `Shared/` donne à l'app web ce qu'un navigateur ne peut pas faire : Git et dossiers locaux, Claude Code, SSH, trousseau, Touch ID / Face ID, dictée, notifications.

### Plugins

Les fonctions de Studio se branchent sur un registre d'extensions ([`src/plugins/registry.ts`](src/plugins/registry.ts)) : panneaux de la page projet, actions sur une tâche. GitHub et Linear y sont déjà enregistrés comme plugins maison ([`src/plugins/builtin.ts`](src/plugins/builtin.ts)). Prochaines étapes : plugins déclaratifs (modèles, thèmes), puis plugins avec code, isolés et soumis à permissions.

### CI et publication

- **CI** ([`.github/workflows/build.yml`](.github/workflows/build.yml)) à chaque push et pull request : types TypeScript stricts, build, vérifications (cache hors ligne complet, aucune clé d'API dans le code), build de l'app Mac, compilation de l'app iPhone. En local : `npm run verify`.
- **Publication** : chaque push sur `main` publie une Release (`v1.0.<n>`) avec `Studio-macOS.zip` et `Studio-web.zip`, ainsi que le paquet `@mtthoas/studio` (app web compilée) dans GitHub Packages. Un tag `v…` fait de même avec son propre nom.

## Licence et contributions

- **Licence** : [MIT](LICENSE). Chacun peut lire, réutiliser et modifier le code.
- **Contributions** : les pull requests sont bienvenues ; seul le mainteneur peut les accepter ([`CODEOWNERS`](.github/CODEOWNERS)).
