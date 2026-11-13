# Contexte du dépôt

Mémoire du dépôt pour les agents : à lire **en premier**, avant toute recherche, pour ne pas réexplorer le code à chaque demande. Studio l'impose à chaque agent Claude Code (consignes « Mémoire du dépôt », Réglages → Consignes et contexte).

**L'entretenir** — à la fin d'un travail, ajoute ici ce que tu as appris de durable et qui t'aurait fait gagner du temps : une ou deux lignes, dans la bonne section. Corrige ou retire ce qui est devenu faux. Pas de journal, pas d'état d'avancement, rien que le code dise déjà en clair. Désigne le code par fichier et nom de fonction, jamais par numéro de ligne. Si le code contredit ce fichier, c'est le code qui a raison : corrige le fichier.

## En bref

- Studio : notes, tâches, projets, agents Claude Code. Une app web en TypeScript strict (`src/` → `dist/` par esbuild, sans framework), embarquée telle quelle dans une coquille Swift pour Mac et iPhone (`native/`).
- La carte complète des fichiers est dans `README.md`, section « Architecture » : ne la recopie pas ici, lis-la au besoin.
- Tout est rédigé en français : interface (tutoiement), commentaires, README, messages des scripts. Les commits sont en anglais, au format Conventional Commits.

## Où trouver quoi

- **Barre latérale et menu « Studio ▾ »** (dans la fenêtre) : `src/app.ts`, `workspaceMenu` et le rendu de la barre juste au-dessus. À ne pas confondre avec le menu **Studio** de la barre de menus macOS : `buildMenu` dans `native/macOS/main.swift`.
- **Clics** : une seule écoute déléguée, `onClick` dans `src/app.ts`, qui lit `data-act`, `data-open-conn`…
- **Réglages** : `src/features/hub.ts`. `TABS` liste les onglets, `TAB_BODY` leur contenu, `hub.openConnections('<onglet>')` en ouvre un. Onglets : `coffre`, `ia`, `consignes`, `linear`, `github`, `appareils`, `apparence`, `donnees`, `maj`.
- **Mises à jour de l'app Mac** : `src/core/update.ts` (état, automatismes) parle à `native/Shared/Updater.swift` (Releases GitHub, téléchargement, remplacement). L'onglet est `tabUpdate` dans `hub.ts` ; la fenêtre « version prête » et les nouveautés sont dans `src/features/news.ts`.
- **Pont web ↔ natif** : `native.call(type, action, …)` dans `src/core/native.ts` ; côté Swift, `userContentController` de `native/Shared/Shell.swift` aiguille selon `type`, et répond par `window.carnet.reply`. La page sait où elle tourne par `document.documentElement.dataset.native` (`mac`, `ios`, absent dans un navigateur).
- **Consignes envoyées à l'IA** : `src/integrations/tuning.ts` pour les automatisations, les tâches de fond et les limites de contexte. Celles des agents Claude Code vivent sur le Mac : `AgentTuning`, en bas de `native/Shared/Agents.swift`.
- **Agents Claude Code** : lancement et arguments de `claude` dans `native/Shared/Agents.swift` ; copies isolées dans `.claude/worktrees/studio-…` (`Projects.swift`) ; publication en pull request dans `Orchestrator.swift` ; l'interface dans `src/features/projects/sessions.ts`.
- **Icônes** : table en tête de `src/ui/kit.ts` (`icon('nom')`).
- **Commande `studio`** : `bin/studio` (sh POSIX), qui appelle `native/build-mac.sh`, lequel appelle `native/copy-web.sh` (build web puis copie dans l'app).

## Recettes

- **Ajouter une consigne d'agent** : dans `AgentTuning`, une clé dans `textKeys`, sa valeur dans `defaults`, sa place dans `prompt()` ; puis le champ dans `AGENT_ITEMS` et `AGENT_PROMPT` de `src/features/tuning.ts`.
- **Ajouter une consigne ou une limite côté web** : une entrée dans `DEFS` de `src/integrations/tuning.ts` suffit, la page de réglages se construit dessus.
- **Annoncer une fonction visible** : une entrée en tête de `NEWS` dans `src/features/news.ts` (identifiant stable), et le README.
- **Vérifier** : `npm run verify` (types, build, cache hors ligne, aucun secret). C'est ce que lance la CI.

## Build et versions

- L'app Mac embarque ses fichiers web : un changement dans `src/` n'y apparaît qu'après reconstruction (`studio update`) ou installation d'une Release.
- `native/build-mac.sh` inscrit `StudioCommit` et `StudioBuilt` dans l'`Info.plist` ; l'updater et `studio version` s'en servent.
- La CI (`.github/workflows/build.yml`) publie une Release à chaque push sur `main`, avec `Studio-macOS.zip`. Les pull requests sont fusionnées sur GitHub : le dossier local ne les reçoit pas tout seul.
- `studio update` avance donc d'abord `main` jusqu'à GitHub (avance simple), puis construit ; `studio update --local` construit tel quel ; `studio version` compare app installée, dossier et GitHub.

## Pièges

- **Anciens noms gardés exprès** : identifiant de bundle `app.carnet.notes`, schéma `carnet://`, pont `window.carnet`, base IndexedDB `carnet`. Les renommer ferait perdre les données des apps installées.
- **Un agent lancé par Studio est confiné** : `--restricted`, pas de terminal (sauf « Tests npm »), aucun accès hors de sa copie. Il ne peut ni lancer `git`, ni lire l'app installée, ni compiler le Swift. Pour un diagnostic sur la machine, demande à l'utilisateur le résultat de `studio version` ; signale dans le compte rendu ce qui n'a pas pu être exécuté.
- **Updater, « plus récente »** : une Release n'est proposée que si son commit diffère de celui de l'app **et** qu'elle a été publiée après le build. Une app reconstruite aujourd'hui depuis de vieilles sources se croit donc à jour.
- **Fermeture de l'app** : elle répond « plus tard » à la demande de quitter (enregistrement en cours, 2 s au plus), puis installe un paquet déjà téléchargé (`applyOnQuit`). Tout script qui remplace l'app doit attendre la vraie fin du processus.
- **Dépendances** : `lib/` et `core/` n'importent jamais `features/` ni `integrations/`.
- **Textes d'interface** : apostrophe typographique `’` dans les chaînes TypeScript, et `esc()` sur toute donnée insérée dans du HTML.
