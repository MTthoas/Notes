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
- **Réglages** : `src/features/hub.ts`. `TABS` liste les onglets, `TAB_BODY` leur contenu, `hub.openConnections('<onglet>')` en ouvre un. Onglets : `coffre`, `ia`, `consignes`, `linear`, `github`, `extensions`, `appareils`, `apparence`, `donnees`, `maj`.
- **Plugins** : `src/plugins/registry.ts` (types `Plugin`, `PluginAPI`, activation, cycle de vie, clics `data-plug="<id>:<action>"`), enregistrés dans `builtin.ts`. Optionnels : `spotify.ts`, `n8n.ts`, `figma.ts`. Un plugin peut rendre des blocs ```<langage> (`fences`, appelés par `hub.fenceFor` après les blocs maison). Leur page de réglages (onglet `extensions`) est générée par `src/features/plugins.ts` ; le bloc de barre latérale est `#plug-side`, redessiné seul par `registry.refresh()`. Événements délégués depuis `src/app.ts` : clic `data-plug`, formulaire `data-plug-form`, `change` `data-plug-change` (curseurs).
- **Spotify, autorisations** : le jeton garde ses `scope` ; ajouter un scope à `SCOPE` n'affecte pas les connexions existantes, d'où les tests du type `canVolume` et l'invitation à se reconnecter.
- **Mises à jour de l'app Mac** : `src/core/update.ts` (état, automatismes) parle à `native/Shared/Updater.swift` (Releases GitHub, téléchargement, remplacement). L'onglet est `tabUpdate` dans `hub.ts` ; la fenêtre « version prête » et les nouveautés sont dans `src/features/news.ts`.
- **Pont web ↔ natif** : `native.call(type, action, …)` dans `src/core/native.ts` ; côté Swift, `userContentController` de `native/Shared/Shell.swift` aiguille selon `type`, et répond par `window.carnet.reply`. La page sait où elle tourne par `document.documentElement.dataset.native` (`mac`, `ios`, absent dans un navigateur).
- **Consignes envoyées à l'IA** : `src/integrations/tuning.ts` pour les automatisations, les tâches de fond et les limites de contexte. Celles des agents Claude Code vivent sur le Mac : `AgentTuning`, en bas de `native/Shared/Agents.swift`.
- **Autorisations des agents** (outils par mode, commandes de la case « Commandes », web, PATH) : `AgentPermissions`, en bas de `native/Shared/Agents.swift`, gardé dans UserDefaults ; action de pont `agent.permissions` (`Shell.swift`), page `src/features/permissions.ts` (onglet `autorisations`). Le formulaire de consigne lit `permissions.commandsInRead()` pour activer la case en mode Analyser.
- **Agents Claude Code** : lancement et arguments de `claude` dans `native/Shared/Agents.swift` ; copies isolées dans `.claude/worktrees/studio-…` (`Projects.swift`) ; publication en pull request dans `Orchestrator.swift` ; l'interface dans `src/features/projects/sessions.ts`.
- **Périmètres de l'IA** (cloisonnement par projet) : `src/integrations/scope.ts`. Toute exécution reçoit `ctx.scope` (projet ou `GENERAL` par défaut) et `toolset` dans `ai.ts` filtre chaque outil avec `noteIn`/`taskIn`/`repoIn`/`needLinear`. Linear n'existe qu'avec un projet dont le champ `linear:` désigne un projet Linear au nom exact (`projectByName`). Les automatisations prennent le leur avec `projet:` ; les événements portent une `origin` (`core/events.ts`) et `hub.onEvent` ne les livre qu'au bon périmètre. Tout nouvel outil ou toute nouvelle source de données pour l'IA doit passer par ce filtre.
- **Page Claude** (toujours dans un projet, fixé à la création, `Chat.project` ; volontairement absente de la barre latérale et de la palette, on y entre par `chat.startIn` depuis la fiche projet) : `src/features/chat.ts`, vue `claude` ; conversations dans le magasin IndexedDB `chats` (`db.ts`) ; consigne `auto.chat` et limite `ctx.chat` dans `src/integrations/tuning.ts` ; `ai.run({ chat: true })`.
- **Couleur d'un projet** : `src/features/projects/page.ts` pose `--c:var(--c-<hue>)` sur `.pj-head` et `.pj-card` ; tout ce qui est dedans peut s'en teinter en CSS.
- **Journal** : `src/features/journal.ts` (rendu `dayPage`, `promptRow`, `sessionBlock`) ; ses styles sont les classes `jr-*` en fin de `css/app.css`. Les classes `hm-*` sont partagées avec l'Accueil : ne les retouche pas pour le seul journal.
- **Tags des notes** : jamais stockés, recalculés depuis le texte par `analyze` (`src/lib/markdown.ts`, via `store.meta`) ; la règle est `TAG_RE` + `notTag`, partagée par le rendu (`inline`). La capture rapide (`parseCapture`, `src/app.ts`) a sa propre expression.
- **Icônes** : table en tête de `src/ui/kit.ts` (`icon('nom')`).
- **Commande `studio`** : `bin/studio` (sh POSIX), qui appelle `native/build-mac.sh`, lequel appelle `native/copy-web.sh` (build web puis copie dans l'app).

## Recettes

- **Ajouter une consigne d'agent** : dans `AgentTuning`, une clé dans `textKeys`, sa valeur dans `defaults`, sa place dans `prompt()` ; puis le champ dans `AGENT_ITEMS` et `AGENT_PROMPT` de `src/features/tuning.ts`.
- **Ajouter une autorisation d’agent** : une propriété et sa clé (`flags` pour un booléen) dans `AgentPermissions`, son effet dans `tools()` ou `allowed()`, sa valeur d’origine dans `state()` ; puis le champ dans `bodyHTML()` de `src/features/permissions.ts`. Garder les valeurs d’origine identiques aux garde-fous existants.
- **Ajouter une consigne ou une limite côté web** : une entrée dans `DEFS` de `src/integrations/tuning.ts` suffit, la page de réglages se construit dessus.
- **Ajouter un plugin optionnel** : un fichier `src/plugins/<id>.ts` exportant un `Plugin` (`optional: true`, `settings`, `hosts`, `start`, `sidebar`, `commands`, `actions`), un `registry.register` dans `builtin.ts`, et ses domaines dans `connect-src` de `index.html` (sinon la CSP bloque ses requêtes) ; le README les liste.
- **Annoncer une fonction visible** : une entrée en tête de `NEWS` dans `src/features/news.ts` (identifiant stable), et le README.
- **Conflit sur `NEWS`** (chaque PR ajoute son entrée en tête, donc les fusions avec `main` s'y heurtent souvent) : garder les entrées des deux côtés, la plus récente en tête, sans en perdre ni en dupliquer. Vérifier ensuite que chaque `id` présent sur `origin/main` l'est encore.
- **Vérifier** : `npm run verify` (types, build, cache hors ligne, aucun secret). C'est ce que lance la CI.

## Build et versions

- L'app Mac embarque ses fichiers web : un changement dans `src/` n'y apparaît qu'après reconstruction (`studio update`) ou installation d'une Release.
- `native/build-mac.sh` inscrit `StudioCommit` et `StudioBuilt` dans l'`Info.plist` ; l'updater et `studio version` s'en servent.
- La CI (`.github/workflows/build.yml`) publie une Release à chaque push sur `main`, avec `Studio-macOS.zip`. Les pull requests sont fusionnées sur GitHub : le dossier local ne les reçoit pas tout seul.
- `studio update` avance donc d'abord `main` jusqu'à GitHub (avance simple), puis construit ; `studio update --local` construit tel quel ; `studio version` compare app installée, dossier et GitHub.

## Pièges

- **Anciens noms gardés exprès** : identifiant de bundle `app.carnet.notes`, schéma `carnet://`, pont `window.carnet`, base IndexedDB `carnet`. Les renommer ferait perdre les données des apps installées.
- **Un agent lancé par Studio est confiné** : `--restricted`, pas de terminal (sauf les commandes permises dans Réglages → Autorisations quand « Commandes » est cochée), aucun accès hors de sa copie. Il ne peut ni lancer `git`, ni lire l'app installée, ni compiler le Swift. Pour un diagnostic sur la machine, demande à l'utilisateur le résultat de `studio version` ; signale dans le compte rendu ce qui n'a pas pu être exécuté.
- **Updater, « plus récente »** : une Release n'est proposée que si son commit diffère de celui de l'app **et** qu'elle a été publiée après le build. Une app reconstruite aujourd'hui depuis de vieilles sources se croit donc à jour.
- **Fermeture de l'app** : elle répond « plus tard » à la demande de quitter (enregistrement en cours, 2 s au plus), puis installe un paquet déjà téléchargé (`applyOnQuit`). Tout script qui remplace l'app doit attendre la vraie fin du processus.
- **Pas de serveur, et l'app native ne reçoit pas de lien** : le schéma `carnet` n'est pas déclaré au système, donc un retour OAuth ne peut pas rouvrir l'app (Spotify passe par une adresse locale à recopier). Un domaine choisi par l'utilisateur (n8n auto-hébergé) reste bloqué par la CSP tant qu'il n'est pas dans `connect-src`.
- **Trousseau et signature ad hoc** : l’app est signée `--sign -`, donc chaque reconstruction annule les « Toujours autoriser ». Les éléments d’autres outils (jeton de Claude Code) se lisent par `/usr/bin/security`, déjà autorisé, pas par `SecItemCopyMatching` (voir `keychainItem` dans `ClaudeUsage.swift`).
- **Cadres (iframe)** : il faut deux autorisations. `frame-src` dans `index.html`, et côté natif `framable` dans `Shell.swift` : sinon `decidePolicyFor` ouvre l’adresse du cadre dans le navigateur et le cadre reste vide. L’aperçu est rendu à nouveau à chaque frappe, ce qui recharge tout cadre placé dans une note : on l’ouvre donc dans une fenêtre (`modal`).
- **« Load failed »** : c’est l’échec réseau brut de WebKit (CORS, hors ligne, délai). `post` dans `ai.ts` le traduit (`NetworkError`) ; l’autotest de `native/macOS/main.swift` vérifie que `api.anthropic.com` reste joignable depuis la page.
- **Dépendances** : `lib/` et `core/` n'importent jamais `features/` ni `integrations/`.
- **Textes d'interface** : apostrophe typographique `’` dans les chaînes TypeScript, et `esc()` sur toute donnée insérée dans du HTML.
