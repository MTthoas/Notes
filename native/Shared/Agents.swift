// Agents Claude Code lancés depuis un projet Studio (Mac uniquement).
//
// Une consigne part dans le dossier du projet choisi sur ce Mac :
// - « analyse » : lecture seule (Read, Glob, Grep) dans le dossier du projet ;
// - « modifier » : dans une copie isolée du dépôt (worktree créé par Claude Code dans .claude/worktrees/),
//   avec lecture et écriture de fichiers seulement, confinées à cette copie ;
// - option « Commandes » (case du formulaire, champ `tests`) : autorise en plus les commandes réglées dans
//   Réglages → Autorisations (par défaut `npm test` et `npm run …`) ; le code du projet peut alors s'exécuter.
//
// Ce que chaque mode a le droit de faire se règle dans Réglages → Autorisations (AgentPermissions, en bas de ce
// fichier) : accès au web, liste des commandes, commandes aussi en mode Analyser, dossiers ajoutés au PATH.
//
// Garde-fous : programme à un emplacement connu, aucun shell, --restricted (outils de fichiers confinés au
// dossier de travail), --permission-mode dontAsk (tout ce qui n'est pas listé est refusé, sans question),
// aucun réglage, hook ni serveur MCP de l'utilisateur, trois agents à la fois au plus, 90 minutes au plus.
// Un appareil lié ne peut jamais demander les commandes (voir link.ts), ni changer les autorisations.
import Foundation
#if os(macOS)

final class Agents {
    static let shared = Agents()

    final class Run {
        let id: String, project: String, mode: String, prompt: String, started = Date()
        var process: Process?
        var session = "", cwd = "", worktree = ""
        var status = "starting"            // starting | running | done | error | stopped
        var result = "", lastText = "", cost = 0.0, turns = 0, denials: [String] = []
        var finished: Date?
        var quota: [String: Any]?
        var machine = "mac", host = ""
        /// Modèle et niveau d'effort de ce tour ("" : ceux de Claude Code par défaut).
        var model = "", effort = ""
        /// Commandes autorisées pour ce tour (case « Commandes ») : une réponse dans la discussion les garde.
        var commands = false
        /// Numéro du processus Claude Code sur le serveur (pour pouvoir l'arrêter là-bas).
        var remotePid = 0
        /// Étapes reçues du flux (pour suivre un agent qui tourne sur un serveur).
        var actions: [[String: String]] = []
        init(id: String, project: String, mode: String, prompt: String) { self.id = id; self.project = project; self.mode = mode; self.prompt = prompt }
    }
    private var runs: [String: Run] = [:]
    private let lock = NSLock()
    private let maxRunning = 3
    private let maxDuration: TimeInterval = 90 * 60

    /// Messages secondaires : écrits pendant que l'agent d'une discussion travaille (clé : projet|session).
    /// Claude Code (mode -p) ne lit rien en plein tour, et l'interrompre lui ferait perdre le fil : ils lui sont
    /// remis ensemble, en une seule consigne, dès qu'il a fini son tour proprement.
    private struct Queued { let id: String, session: String, text: String, at: Date, machine: String }
    private var queues: [String: [Queued]] = [:]
    private let maxQueued = 10
    /// Les remises de messages se font une à une (deux fins d'agent simultanées ne relancent pas deux fois la même discussion).
    private let flushQueue = DispatchQueue(label: "studio.agents.queue")

    // Outils de chaque mode, et ce qui s'y ajoute selon les réglages : voir AgentPermissions, en bas de ce fichier.
    // Les consignes ajoutées à celle de Claude Code et les réglages de contexte : voir AgentTuning, en bas de ce fichier.
    private static let modelRe = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9.\\-]{0,40}$")
    private static let efforts: Set<String> = ["low", "medium", "high", "xhigh", "max"]

    private static func slug(_ s: String) -> String {
        let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        let mapped = String(folded.map { ($0.isLetter && $0.isASCII) || $0.isNumber ? $0 : "-" })
        let parts = mapped.split(separator: "-").prefix(5).joined(separator: "-")
        return String(parts.prefix(32))
    }

    private func summary(_ r: Run) -> [String: Any] {
        let f = ISO8601DateFormatter()
        return ["run": r.id, "project": r.project, "mode": r.mode, "prompt": r.prompt, "status": r.status, "session": r.session,
                "worktree": r.worktree, "started": f.string(from: r.started), "finished": r.finished.map { f.string(from: $0) } ?? "",
                "result": r.result, "lastText": r.lastText, "cost": r.cost, "turns": r.turns, "denials": r.denials,
                "quota": r.quota ?? NSNull(), "machine": r.machine, "host": r.host]
    }

    /// Un agent et ses dernières étapes.
    func detail(_ id: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let r = runs[id] else { return ["ok": false, "message": "Agent introuvable."] }
        var s = summary(r); s["ok"] = true; s["actions"] = r.actions.suffix(80); return s
    }

    func list(project: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let mine = runs.values.filter { $0.project == project }.sorted { $0.started > $1.started }.prefix(20)
        let f = ISO8601DateFormatter()
        let queued = queues.filter { $0.key.hasPrefix(project + "|") }.values.flatMap { $0 }.sorted { $0.at < $1.at }
            .map { ["id": $0.id, "session": $0.session, "text": String($0.text.prefix(4000)), "at": f.string(from: $0.at)] }
        return ["ok": true, "runs": mine.map(summary), "queued": queued]
    }

    /// Met un message en attente pour la discussion dont l'agent travaille encore.
    private func enqueue(project: String, session: String, text: String, machine: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let key = project + "|" + session
        var q = queues[key] ?? []
        guard q.count < maxQueued else { return ["ok": false, "message": "Déjà \(maxQueued) messages en attente : attends que Claude finisse son tour."] }
        q.append(Queued(id: UUID().uuidString, session: session, text: text, at: Date(), machine: machine))
        queues[key] = q
        return ["ok": true, "queued": q.count, "session": session]
    }

    /// Retire un message en attente (l'utilisateur a changé d'avis).
    func unqueue(project: String, id: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        for (key, q) in queues where key.hasPrefix(project + "|") && q.contains(where: { $0.id == id }) {
            let left = q.filter { $0.id != id }
            queues[key] = left.isEmpty ? nil : left
            return ["ok": true]
        }
        return ["ok": false, "message": "Ce message a déjà été transmis."]
    }

    /// Une seule consigne pour tous les messages en attente : l'ordre est gardé, chaque message est délimité,
    /// et la règle en cas de contradiction est explicite (le plus récent l'emporte).
    static func combine(_ queued: [String], _ prompt: String) -> String {
        let all = queued + (prompt.isEmpty ? [] : [prompt])
        guard all.count > 1 else { return all.first ?? "" }
        let blocks = all.enumerated().map { "<message n=\"\($0.offset + 1)\">\n\($0.element)\n</message>" }.joined(separator: "\n\n")
        return """
            L'utilisateur t'a écrit \(all.count) messages pendant ton dernier tour. Les voici, du plus ancien au plus récent :

            \(blocks)

            Lis-les tous avant d'agir, et traite-les comme une seule demande : si deux messages se contredisent, \
            le plus récent l'emporte ; ne refais pas ce qui est déjà fait.
            """
    }

    /// Remet leurs messages en attente aux discussions dont l'agent a fini son tour proprement.
    /// Après un arrêt ou une erreur, ils restent en attente : l'utilisateur les envoie quand il veut.
    func flushQueues() {
        flushQueue.async {
            self.lock.lock()
            let ready: [(project: String, session: String, machine: String)] = self.queues.compactMap { key, q in
                guard let first = q.first else { return nil }
                let mine = self.runs.values.filter { $0.project + "|" + $0.session == key }
                guard !mine.contains(where: { $0.status == "running" || $0.status == "starting" }),
                      mine.max(by: { $0.started < $1.started })?.status == "done" else { return nil }
                return (String(key.prefix { $0 != "|" }), first.session, first.machine)
            }
            self.lock.unlock()
            for r in ready {
                let sem = DispatchSemaphore(value: 0)
                self.start(project: r.project, body: ["session": r.session, "prompt": "", "machine": r.machine]) { _ in sem.signal() }
                _ = sem.wait(timeout: .now() + 60)
            }
        }
    }

    /// Arrête un agent : Claude Code et tout ce qu'il a lancé (tests…), sur le Mac ou sur le serveur.
    func stop(_ id: String) -> [String: Any] {
        lock.lock(); let r = runs[id]; let p = r?.process
        guard let r, let p, p.isRunning else { lock.unlock(); return ["ok": false, "message": "Cet agent ne tourne plus."] }
        r.status = "stopped"; if r.result.isEmpty { r.result = "Arrêté à ta demande." }
        let remotePid = r.remotePid, host = r.host, onServer = r.machine == "server"
        lock.unlock()
        if onServer, remotePid > 0 {
            let k = Process(); k.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            k.arguments = Servers.shared.sshArgs(host, "pkill -TERM -P \(remotePid) 2>/dev/null; kill -TERM \(remotePid) 2>/dev/null; true")
            k.standardOutput = FileHandle.nullDevice; k.standardError = FileHandle.nullDevice
            try? k.run()
        } else {
            Self.signalTree(p.processIdentifier, SIGTERM)
        }
        p.terminate()
        // Toujours là après 5 secondes : arrêt forcé.
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak p] in
            guard let p, p.isRunning else { return }
            if !onServer { Self.signalTree(p.processIdentifier, SIGKILL) }
            kill(p.processIdentifier, SIGKILL)
        }
        return ["ok": true]
    }

    /// Envoie un signal à tous les descendants d'un processus (les plus profonds d'abord).
    private static func signalTree(_ pid: pid_t, _ sig: Int32) {
        func children(_ of: pid_t) -> [pid_t] {
            let q = Process(); q.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); q.arguments = ["-P", String(of)]
            let out = Pipe(); q.standardOutput = out; q.standardError = FileHandle.nullDevice
            guard (try? q.run()) != nil else { return [] }
            let data = out.fileHandleForReading.readDataToEndOfFile(); q.waitUntilExit()
            return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
        }
        var all: [pid_t] = [], todo = children(pid)
        while let c = todo.popLast(), all.count < 200 { all.append(c); todo += children(c) }
        for c in all.reversed() { kill(c, sig) }
    }

    /// Un agent travaille-t-il encore dans cette copie ?
    func busy(project: String, worktree: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return runs.values.contains { $0.project == project && $0.worktree == worktree && ($0.status == "running" || $0.status == "starting") }
    }

    /// Un agent travaille-t-il encore dans cette session ?
    func busy(project: String, session: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !session.isEmpty && runs.values.contains { $0.project == project && $0.session == session && ($0.status == "running" || $0.status == "starting") }
    }

    /// Oublie les agents terminés d'une session que l'utilisateur supprime. Renvoie leur nombre.
    func forget(project: String, session: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard !session.isEmpty else { return 0 }
        let ids = runs.filter { $0.value.project == project && $0.value.session == session && $0.value.status != "running" && $0.value.status != "starting" }.map { $0.key }
        for id in ids { runs[id] = nil }
        return ids.count
    }

    /// Attend la fin d'un agent (pour l'orchestrateur). Renvoie son état final.
    func wait(_ id: String, timeout: TimeInterval) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock(); let r = runs[id]; let st = r?.status ?? ""; lock.unlock()
            if r == nil { return ["ok": false, "status": "unknown"] }
            if st != "running" && st != "starting" { return withOk(r!) }
            usleep(500_000)
        }
        return ["ok": false, "status": "timeout"]
    }

    /// Lance une consigne (nouvelle session) ou reprend une session existante (`session`).
    /// `done` est appelé dès que la session est créée (ou en cas d'échec), l'agent continue ensuite seul.
    func start(project pid: String, body: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let folders = ProjectFolders.shared
        let onServer = body["machine"] as? String == "server"
        let server = onServer ? Servers.shared.config(pid) : nil
        if onServer && server == nil { return done(["ok": false, "message": "Aucun serveur configuré pour ce projet (onglet Serveur)."]) }
        guard let dir = onServer ? server?.path : folders.path(pid) else { return done(["ok": false, "message": "Choisis d'abord le dossier du projet sur ce Mac."]) }
        let bin = onServer ? "/usr/bin/ssh" : (ClaudeCode.shared.binary() ?? "")
        if bin.isEmpty { return done(["ok": false, "message": "Claude Code n'est pas installé sur ce Mac."]) }
        var prompt = (body["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resume = body["session"] as? String ?? ""
        // Messages secondaires : pendant que l'agent de la discussion travaille, le message attend la fin de son tour ;
        // à la reprise suivante, tous les messages en attente partent avec la consigne, en une seule fois.
        // Les reprises lancées par l'orchestrateur (résolution de conflits) n'y touchent pas.
        var taken: [String] = []
        if !resume.isEmpty && body["internal"] as? Bool != true {
            if self.busy(project: pid, session: resume) {
                guard !prompt.isEmpty, prompt.utf8.count <= 100_000 else { return done(["ok": false, "message": "Message vide ou trop long."]) }
                return done(enqueue(project: pid, session: resume, text: prompt, machine: onServer ? "server" : "mac"))
            }
            lock.lock(); let q = queues[pid + "|" + resume] ?? []; lock.unlock()
            taken = q.map(\.id)
            prompt = Self.combine(q.map(\.text), prompt)
        }
        guard !prompt.isEmpty, prompt.utf8.count <= 100_000 else { return done(["ok": false, "message": "Consigne vide ou trop longue."]) }
        lock.lock(); let full = runs.values.filter { $0.status == "running" || $0.status == "starting" }.count >= maxRunning; lock.unlock()
        if full { return done(["ok": false, "message": "Trois agents tournent déjà : attends qu'un se termine ou arrête-en un."]) }

        var cwd = dir, mode = body["mode"] as? String == "edit" ? "edit" : "read", newWorktree = ""
        var args = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--permission-mode", "dontAsk",
                    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
        if !resume.isEmpty {
            // Reprise : même dossier que la session d'origine, qui doit appartenir au projet.
            let known: String? = onServer ? { lock.lock(); defer { lock.unlock() }; return runs.values.first { $0.session == resume && $0.machine == "server" && $0.project == pid }?.cwd }() : ClaudeSessions.shared.cwd(project: dir, session: resume)
            guard let c = known, c == dir || c.hasPrefix(dir + "/.claude/worktrees/") || onServer else { return done(["ok": false, "message": "Session introuvable pour ce projet."]) }
            cwd = c; mode = c.contains("/.claude/worktrees/") ? "edit" : "read"
            args += ["--resume", resume]
            // Le travail précédent de la discussion a été fusionné : l'agent repart de la dernière version de la branche
            // principale, sur une nouvelle branche (une même discussion peut ainsi livrer plusieurs branches).
            if !onServer, mode == "edit", let r = c.range(of: "/.claude/worktrees/") {
                let name = String(c[r.upperBound...])
                if !Orchestrator.shared.busy(project: pid, worktree: name) && !self.busy(project: pid, worktree: name) { folders.recycleIfDelivered(c, fetch: true) }
            }
        } else if mode == "edit" {
            // Copie isolée créée par Studio à partir de la dernière version de la branche principale distante
            // (et non par « claude --worktree », qui part de la branche où se trouve ton dossier).
            let stamp = DateFormatter(); stamp.dateFormat = "MMdd-HHmm"
            let base = Self.slug(body["name"] as? String ?? prompt)
            newWorktree = "studio-" + (base.isEmpty ? "agent" : base) + "-" + stamp.string(from: Date())
            if !onServer {
                guard folders.isRepo(dir) else { return done(["ok": false, "message": "Le mode « modifier » demande un dépôt Git : il travaille dans une copie isolée."]) }
                let made = folders.createWorktree(dir, name: newWorktree)
                guard let path = made.path else { return done(["ok": false, "message": made.error]) }
                cwd = path
            }
        }
        // Modèle, effort et commandes : ceux de la demande. Une reprise qui n'en précise pas (réponse dans la discussion,
        // messages en attente, orchestrateur) garde ceux du dernier tour de la discussion, tant que Studio s'en souvient.
        var model = body["model"] as? String, effort = body["effort"] as? String, asked = body["tests"] as? Bool
        if !resume.isEmpty && (model == nil || effort == nil || asked == nil) {
            lock.lock()
            let last = runs.values.filter { $0.project == pid && $0.session == resume }.max { $0.started < $1.started }
            lock.unlock()
            model = model ?? last?.model
            effort = effort ?? last?.effort
            // L'orchestrateur (résolution de conflits) ne reprend jamais les commandes d'un tour précédent.
            if body["internal"] as? Bool != true { asked = asked ?? last?.commands }
        }
        // Commandes : demandées par la case du formulaire, permises dans ce mode par les réglages, jamais sur un serveur.
        let tests = asked == true && !onServer && AgentPermissions.commandsAllowed(mode: mode)
        let tools = AgentPermissions.tools(mode: mode, commands: tests)
        args += ["--tools", tools.joined(separator: ",")]
        let useModel = model ?? "", useEffort = effort ?? ""
        let modelOK = !useModel.isEmpty && Self.modelRe.firstMatch(in: useModel, range: NSRange(useModel.startIndex..., in: useModel)) != nil
        let effortOK = Self.efforts.contains(useEffort)
        if modelOK { args += ["--model", useModel] }
        if effortOK { args += ["--effort", useEffort] }
        let added = AgentTuning.prompt(mode: mode, tests: tests)
        if !added.isEmpty { args += ["--append-system-prompt", added] }
        args += ["--allowedTools"] + AgentPermissions.allowed(tools: tools, commands: tests)

        let run = Run(id: UUID().uuidString, project: pid, mode: mode, prompt: String(prompt.prefix(500)))
        run.model = modelOK ? useModel : ""; run.effort = effortOK ? useEffort : ""; run.commands = tests
        if !resume.isEmpty || !newWorktree.isEmpty { run.session = resume; run.cwd = cwd; run.worktree = cwd.range(of: "/.claude/worktrees/").map { String(cwd[$0.upperBound...]) } ?? newWorktree }
        run.actions.append(["at": ISO8601DateFormatter().string(from: Date()), "kind": "prompt", "text": String(prompt.prefix(4000))])
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        if let server {
            // Sur le serveur : modèle de commande fixe, chaque argument protégé, Claude Code cherché aux emplacements usuels.
            run.machine = "server"; run.host = server.host
            var prep = ""
            if !newWorktree.isEmpty {
                // Même règle que sur le Mac : copie isolée partant de la dernière version de la branche principale distante.
                let wt = ".claude/worktrees/" + newWorktree
                prep = "(grep -qxF '.claude/worktrees/' .git/info/exclude 2>/dev/null || echo '.claude/worktrees/' >> .git/info/exclude) 2>/dev/null; "
                    + "git fetch -q origin 2>/dev/null; B=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo HEAD); "
                    + "git worktree add -q --no-track -b \(Servers.q("worktree-" + newWorktree)) \(Servers.q(wt)) \"$B\" && cd \(Servers.q(wt)) && "
            }
            // Première ligne du flux : le numéro du processus distant (exec le conserve), pour pouvoir l'arrêter.
            let remote = "cd \(Servers.qPath(cwd)) && \(prep)echo \"{\\\"type\\\":\\\"studio_pid\\\",\\\"pid\\\":$$}\" && PATH=\"$HOME/.local/bin:$HOME/.claude/local:$PATH\" "
                + AgentTuning.env().sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value) " }.joined() + "exec claude " + args.map(Servers.q).joined(separator: " ")
            p.arguments = Servers.shared.sshArgs(server.host, remote)
            p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        } else {
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        var env = ProcessInfo.processInfo.environment
        env["DISABLE_AUTOUPDATER"] = "1"; env["NO_COLOR"] = "1"
        for (k, v) in AgentTuning.env() { env[k] = v }
        // Ouverte depuis le Dock, l'app n'a qu'un PATH minimal : les dossiers réglés passent devant (cargo, Homebrew…).
        if !onServer, !AgentPermissions.path.isEmpty {
            env["PATH"] = (AgentPermissions.path + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
        }
        p.environment = env
        let out = Pipe(), input = Pipe()
        p.standardOutput = out; p.standardError = FileHandle.nullDevice; p.standardInput = input
        run.process = p

        var answered = false
        let answerOnce: ([String: Any]) -> Void = { r in
            self.lock.lock(); let first = !answered; answered = true; self.lock.unlock()
            if first { done(r) }
        }
        p.terminationHandler = { proc in
            self.lock.lock()
            if run.status == "running" || run.status == "starting" { run.status = proc.terminationStatus == 0 && !run.result.isEmpty ? "done" : "error" }
            run.finished = Date(); run.process = nil
            let wt = run.machine == "mac" && run.mode == "edit" && !run.worktree.isEmpty ? run.cwd : "", name = run.worktree
            self.lock.unlock()
            // Fin du tour, dans cet ordre : 1. si le travail de la copie a été fusionné entre-temps et que l'agent n'a rien
            // changé, la copie repart de la branche principale (elle ne sera plus proposée à la publication) ;
            // 2. les messages écrits pendant ce tour sont remis à l'agent (le flux a eu le temps de livrer son résultat).
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                if !wt.isEmpty && wt.contains("/.claude/worktrees/")
                    && !Orchestrator.shared.busy(project: run.project, worktree: name) && !self.busy(project: run.project, worktree: name) {
                    ProjectFolders.shared.recycleIfDelivered(wt, fetch: true)
                }
                self.flushQueues()
            }
            answerOnce(["ok": false, "message": run.result.isEmpty ? "Claude Code s'est arrêté avant de démarrer." : run.result])
        }
        do { try p.run() } catch { return done(["ok": false, "message": "Impossible de lancer Claude Code."]) }
        lock.lock(); runs[run.id] = run
        // Messages en attente transmis : ils sortent de la file (ceux arrivés entre-temps y restent pour le tour suivant).
        if !taken.isEmpty {
            let key = pid + "|" + resume, left = (queues[key] ?? []).filter { !taken.contains($0.id) }
            queues[key] = left.isEmpty ? nil : left
        }
        lock.unlock()
        DispatchQueue.global(qos: .utility).async {
            try? input.fileHandleForWriting.write(contentsOf: Data(prompt.utf8)); try? input.fileHandleForWriting.close()
        }
        // Lecture du flux d'événements (une ligne JSON par événement).
        DispatchQueue.global(qos: .utility).async {
            var buffer = Data()
            while true {
                let chunk = out.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<nl]; buffer.removeSubrange(buffer.startIndex...nl)
                    guard let e = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                    self.ingest(e, run, answerOnce)
                }
            }
        }
        // Délai maximal.
        DispatchQueue.global().asyncAfter(deadline: .now() + maxDuration) { [weak p] in
            if let p, p.isRunning { run.status = "stopped"; run.result = "Arrêté : 90 minutes dépassées."; p.terminate() }
        }
        // Si la session ne s'annonce pas, on répond quand même.
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) { answerOnce(self.withOk(run)) }
    }

    private func withOk(_ r: Run) -> [String: Any] { lock.lock(); defer { lock.unlock() }; var s = summary(r); s["ok"] = true; return s }

    private func ingest(_ e: [String: Any], _ run: Run, _ answer: ([String: Any]) -> Void) {
        switch e["type"] as? String ?? "" {
        case "studio_pid":
            lock.lock(); run.remotePid = e["pid"] as? Int ?? 0; lock.unlock()
        case "system" where e["subtype"] as? String == "init":
            lock.lock()
            run.session = e["session_id"] as? String ?? run.session
            run.cwd = e["cwd"] as? String ?? run.cwd
            if let r = run.cwd.range(of: "/.claude/worktrees/") { run.worktree = String(run.cwd[r.upperBound...]) }
            run.status = "running"
            lock.unlock()
            answer(withOk(run))
        case "assistant":
            lock.lock(); run.turns += 1
            let now = ISO8601DateFormatter().string(from: Date())
            if let m = e["message"] as? [String: Any] {
                for b in m["content"] as? [[String: Any]] ?? [] {
                    if b["type"] as? String == "text", let t = b["text"] as? String, !t.isEmpty {
                        run.lastText = String(t.prefix(300)); run.actions.append(["at": now, "kind": "text", "text": String(t.prefix(16000))])
                    }
                    if b["type"] as? String == "tool_use", let name = b["name"] as? String {
                        let input = b["input"] as? [String: Any] ?? [:]
                        let detail = input["file_path"] as? String ?? input["path"] as? String ?? input["pattern"] as? String ?? input["command"] as? String ?? ""
                        run.actions.append(["at": now, "kind": "tool:" + name, "text": String(detail.prefix(240))])
                    }
                }
                if run.actions.count > 150 { run.actions.removeFirst(run.actions.count - 150) }
            }
            lock.unlock()
        case "rate_limit_event":
            lock.lock(); run.quota = e["rate_limit_info"] as? [String: Any] ?? e; lock.unlock()
        case "result":
            lock.lock()
            run.result = String((e["result"] as? String ?? "").prefix(8000))
            run.cost = e["total_cost_usd"] as? Double ?? 0
            run.denials = (e["permission_denials"] as? [[String: Any]] ?? []).compactMap { d in
                let input = d["tool_input"] as? [String: Any] ?? [:]
                return "\(d["tool_name"] as? String ?? "?") \(input["command"] as? String ?? input["file_path"] as? String ?? "")".trimmingCharacters(in: .whitespaces)
            }
            if run.status != "stopped" { run.status = (e["is_error"] as? Bool ?? false) ? "error" : "done" }
            lock.unlock()
        default: break
        }
    }
}

/// Consignes ajoutées à celle de Claude Code pour chaque agent, et réglages qui bornent son contexte.
/// Modifiables dans Réglages → Consignes et contexte (app Mac) ; seules les valeurs modifiées sont gardées
/// (UserDefaults), les autres suivent les valeurs d'origine ci-dessous. Elles sont lues à chaque lancement,
/// y compris ceux de l'orchestrateur, des messages en attente et des appareils liés.
enum AgentTuning {
    private static let store = "studio.agents.tuning"
    private static let textKeys = ["intro", "edit", "read", "context", "contextEdit", "economy", "tests", "behavior", "extra"]

    static let defaults: [String: Any] = [
        "intro": """
            Tu es lancé depuis Studio. L'utilisateur lit tes messages dans un fil de discussion et peut te répondre ensuite \
            en reprenant la session, mais personne ne répond pendant que tu travailles : ce qu'il t'écrit pendant ton tour \
            t'est remis d'un bloc à la fin de celui-ci.
            """,
        // Agents qui modifient : pas de commit, conflits, et le message de commit qu'ils proposent (Studio relit la ligne « Commit: »).
        "edit": """
            Tu travailles dans une copie isolée du dépôt ; ne fais pas de commit, l'utilisateur relira tes changements. \
            Si un fichier contient des marqueurs de conflit (<<<<<<< ======= >>>>>>>), c'est que ta copie a été remise sur la dernière \
            version de la branche principale : fusionne les deux côtés à la main en gardant leurs intentions, et retire tous les marqueurs. \
            Quand ton travail précédent a été fusionné dans la branche principale, Studio remet ta copie sur sa dernière version, \
            sur une nouvelle branche : ce travail y est déjà, ne le refais pas et ne le propose plus. \
            Quand tu as modifié des fichiers, termine ton compte rendu par une dernière ligne, seule, de la forme \
            « Commit: type(portée): résumé » au format Conventional Commits (feat, fix, refactor, docs, test, chore, perf, style, build, ci ; \
            72 caractères au plus ; à l'impératif ; en anglais sauf si le dépôt est rédigé dans une autre langue ; sans point final). \
            Elle décrit l'ensemble des changements présents dans la copie, jamais la demande elle-même (pas de « résout le conflit »). \
            Modifie avec Edit plutôt que de réécrire un fichier entier avec Write.
            """,
        "read": "Tu es en lecture seule : analyse et propose, sans modifier de fichier.",
        // Mémoire du dépôt : chaque agent repart de zéro et passait ses premiers tours à retrouver où sont les choses.
        // contexte.md le lui dit d'emblée ; les agents qui modifient le tiennent à jour (« contextEdit »).
        "context": """
            Avant toute recherche, lis contexte.md à la racine du dépôt s'il existe (et celui du dossier où tu travailles, s'il y en a un) : \
            il dit où se trouve chaque chose, les conventions et les pièges déjà rencontrés. Pars de là au lieu de réexplorer le dépôt, \
            et ne vérifie dans le code que ce dont ta tâche dépend ; si le code le contredit, c'est le code qui a raison.
            """,
        "contextEdit": """
            À la fin de ton travail, tiens contexte.md à jour, dans la même copie : ajoute en une ou deux lignes, dans la bonne section, \
            ce que tu as appris de durable et qui t'aurait fait gagner du temps (où se trouve une fonction, comment les pièces se parlent, \
            une convention, un piège) ; corrige ou retire ce qui est devenu faux ; s'il n'existe pas, crée-le avec ce que tu as appris. \
            N'y mets ni journal de ce que tu as fait, ni état d'avancement, ni rien que le code dise déjà en clair, et garde-le court : \
            il est lu en entier par chaque agent. Si tu n'as rien appris de durable, n'y touche pas.
            """,
        // Un agent relit tout son contexte à chaque appel d'outil : ce qu'il y fait entrer (fichiers entiers, relectures,
        // dossiers générés, copies des autres agents) se paie à chaque tour suivant.
        "economy": """
            Économise ton contexte, il est relu en entier à chaque tour : cherche avec Grep ou Glob avant de lire, puis ne lis \
            que la partie utile des gros fichiers (offset et limit) ; ne relis pas un fichier déjà lu ou que tu viens de modifier ; \
            lance dans le même tour les recherches et les lectures indépendantes ; laisse de côté node_modules, dist, build, \
            les fichiers générés ou minifiés, les verrous de dépendances et les autres copies du dépôt sous .claude/worktrees/ ; \
            ne commente pas chaque étape et ne recopie pas de code dans ton compte rendu.
            """,
        "tests": "Lance les tests les plus ciblés possible, une fois tes changements faits plutôt qu'après chaque modification.",
        "behavior": """
            Si l'utilisateur demande une tâche précise, mène-la de façon autonome jusqu'au bout, puis termine par un compte rendu \
            court en Markdown : ce qui a été fait, les fichiers touchés, ce qui reste à décider. \
            S'il veut au contraire réfléchir, discuter, comparer des options ou avoir ton avis, ne te lance pas dans la réalisation : \
            réponds comme dans une conversation, donne ton analyse et ta recommandation, pose tes questions, et attends sa réponse \
            avant de modifier quoi que ce soit.
            """,
        "extra": "",
        // Le contexte est résumé dès ce nombre de tokens, même avec un modèle qui en accepte un million : une longue
        // conversation ne fait pas relire des centaines de milliers de tokens à chaque appel d'outil. 0 : réglage de Claude Code.
        "compactWindow": 200_000,
        // Pas d'appels au modèle pour l'accessoire (textes d'attente, suggestions).
        "lean": true,
    ]

    private static var saved: [String: Any] { UserDefaults.standard.dictionary(forKey: store) ?? [:] }

    static func text(_ key: String) -> String {
        (saved[key] as? String ?? defaults[key] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static var compactWindow: Int { saved["compactWindow"] as? Int ?? 200_000 }
    static var lean: Bool { saved["lean"] as? Bool ?? true }

    /// Texte ajouté à la consigne système de Claude Code, selon le mode de l'agent.
    static func prompt(mode: String, tests: Bool) -> String {
        [text("intro"), text(mode == "edit" ? "edit" : "read"), text("context"), mode == "edit" ? text("contextEdit") : "",
         text("economy"), tests ? text("tests") : "", tests ? AgentPermissions.promptLine : "", text("behavior"), text("extra")]
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Réglages passés à Claude Code par son environnement (une variable inconnue de la version installée est ignorée).
    static func env() -> [String: String] {
        var e: [String: String] = [:]
        if compactWindow > 0 { e["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = String(compactWindow) }
        if lean { e["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] = "1" }
        return e
    }

    /// Valeurs en vigueur, valeurs d'origine, et clés modifiées (pour la page de réglages).
    static func state() -> [String: Any] {
        var values = defaults
        for k in textKeys { values[k] = saved[k] as? String ?? defaults[k] as? String ?? "" }
        values["compactWindow"] = compactWindow
        values["lean"] = lean
        var changed = textKeys.filter { (values[$0] as? String) != (defaults[$0] as? String) }
        if compactWindow != 200_000 { changed.append("compactWindow") }
        if !lean { changed.append("lean") }
        return ["ok": true, "values": values, "defaults": defaults, "changed": changed]
    }

    /// Applique une demande de la page de réglages : `set` (clé → valeur) et `reset` (une clé, ou « all »).
    static func apply(_ body: [String: Any]) {
        var s = saved
        if let r = body["reset"] as? String { if r == "all" { s = [:] } else { s[r] = nil } }
        for (k, v) in body["set"] as? [String: Any] ?? [:] {
            if textKeys.contains(k) {
                if let t = v as? String, t.utf8.count <= 12_000 { s[k] = t }
            } else if k == "compactWindow" {
                // 0 : laisser Claude Code décider ; sinon borné, pour qu'une faute de frappe ne résume pas tout à chaque tour.
                if let n = (v as? NSNumber)?.intValue { s[k] = n <= 0 ? 0 : min(2_000_000, max(50_000, n)) }
            } else if k == "lean" {
                if let b = v as? Bool { s[k] = b }
            }
        }
        UserDefaults.standard.set(s, forKey: store)
    }
}

/// Ce que les agents ont le droit de faire, au-delà de lire (et d'écrire, en mode Modifier) dans leur dossier de travail.
/// Réglé dans Réglages → Autorisations (app Mac) ; seules les valeurs modifiées sont gardées (UserDefaults), les autres
/// suivent les valeurs d'origine, qui reproduisent les garde-fous d'avant ce réglage. Lu à chaque lancement, y compris
/// pour l'orchestrateur, les messages en attente et les appareils liés — qui ne peuvent ni le lire ni le modifier
/// (« agent.permissions » n'est pas dans REMOTE_ALLOWED, link.ts), ni demander les commandes.
enum AgentPermissions {
    private static let store = "studio.agents.permissions"
    static let readTools = ["Read", "Glob", "Grep"]
    static let editTools = ["Read", "Glob", "Grep", "Edit", "Write"]
    static let webTools = ["WebSearch", "WebFetch"]
    static let defaultCommands = ["npm test", "npm run test", "npm run *"]
    private static let maxCommands = 60, maxDirs = 20
    private static let flags = ["web", "anyCommand", "commandsInRead"]

    private static var saved: [String: Any] { UserDefaults.standard.dictionary(forKey: store) ?? [:] }
    /// Recherche et lecture de pages web (WebSearch, WebFetch), dans les deux modes.
    static var web: Bool { saved["web"] as? Bool ?? false }
    /// Toutes les commandes, sans liste : Bash sans restriction quand la case « Commandes » est cochée.
    static var anyCommand: Bool { saved["anyCommand"] as? Bool ?? false }
    /// La case « Commandes » vaut aussi en mode Analyser (qui travaille dans le dossier du projet, pas dans une copie).
    static var commandsInRead: Bool { saved["commandsInRead"] as? Bool ?? false }
    /// Commandes permises, au format des règles de Claude Code (`npm run *` : tout ce qui commence par `npm run `).
    static var commands: [String] { (saved["commands"] as? [String])?.compactMap(command) ?? defaultCommands }
    /// Dossiers placés en tête du PATH des agents lancés sur ce Mac.
    static var path: [String] { (saved["path"] as? [String] ?? []).compactMap(dir) }

    /// Une commande retenue telle quelle, ou nil : une ligne, sans parenthèse (elle romprait la règle « Bash(…) »).
    private static func command(_ s: String) -> String? {
        let c = s.trimmingCharacters(in: .whitespaces)
        guard !c.isEmpty, c.utf8.count <= 200, c.rangeOfCharacter(from: CharacterSet(charactersIn: "()").union(.controlCharacters)) == nil else { return nil }
        return c
    }
    /// Un dossier absolu (« ~ » accepté), sans « : » qui couperait le PATH, ou nil.
    private static func dir(_ s: String) -> String? {
        var d = s.trimmingCharacters(in: .whitespaces)
        if d == "~" || d.hasPrefix("~/") { d = NSHomeDirectory() + d.dropFirst() }
        guard d.hasPrefix("/"), d.utf8.count <= 500, !d.contains(":"), d.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return d
    }

    static func commandsAllowed(mode: String) -> Bool { (mode == "edit" || commandsInRead) && (anyCommand || !commands.isEmpty) }

    /// --tools : ce que l'agent voit.
    static func tools(mode: String, commands: Bool) -> [String] {
        (mode == "edit" ? editTools : readTools) + (web ? webTools : []) + (commands ? ["Bash"] : [])
    }
    /// --allowedTools : ce qui passe sans question (le reste est refusé par dontAsk). Bash n'y est permis que pour
    /// les commandes listées, ou en entier si « toutes les commandes » est choisi.
    static func allowed(tools: [String], commands: Bool) -> [String] {
        tools.filter { $0 != "Bash" } + (commands ? bashRules : [])
    }
    private static var bashRules: [String] { anyCommand ? ["Bash"] : commands.map { "Bash(\($0))" } }

    /// Ajouté à la consigne quand les commandes sont permises : l'agent sait d'emblée ce qu'il peut lancer.
    static var promptLine: String {
        anyCommand ? "Tu peux lancer des commandes dans le terminal ; ne lance rien de destructeur ni hors de ton dossier de travail."
            : "Seules ces commandes te sont permises, les autres seront refusées : " + commands.map { "`\($0)`" }.joined(separator: ", ") + "."
    }

    /// Valeurs en vigueur, valeurs d'origine, clés modifiées, et ce que reçoit Claude Code dans chaque mode.
    static func state(rejected: [String] = []) -> [String: Any] {
        let values: [String: Any] = ["web": web, "anyCommand": anyCommand, "commandsInRead": commandsInRead, "commands": commands, "path": path]
        let defaults: [String: Any] = ["web": false, "anyCommand": false, "commandsInRead": false, "commands": defaultCommands, "path": [String]()]
        let s = saved
        let changed = (flags + ["commands", "path"]).filter { s[$0] != nil }
        let preview: [String: Any] = [
            "read": tools(mode: "read", commands: false), "readCommands": commandsAllowed(mode: "read") ? bashRules : [],
            "edit": tools(mode: "edit", commands: false), "editCommands": commandsAllowed(mode: "edit") ? bashRules : [],
        ]
        return ["ok": true, "values": values, "defaults": defaults, "changed": changed, "preview": preview, "rejected": rejected]
    }

    /// Applique une demande de la page de réglages : `set` (clé → valeur) et `reset` (une clé, ou « all »).
    /// Les listes arrivent en tableau ou en texte (une entrée par ligne) ; les entrées refusées sont renvoyées.
    static func apply(_ body: [String: Any]) -> [String: Any] {
        var s = saved, rejected: [String] = []
        if let r = body["reset"] as? String { if r == "all" { s = [:] } else { s[r] = nil } }
        let lines: (Any) -> [String] = { v in
            (v as? [String] ?? (v as? String)?.components(separatedBy: .newlines) ?? [])
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        for (k, v) in body["set"] as? [String: Any] ?? [:] {
            if flags.contains(k) { if let b = v as? Bool { s[k] = b } }
            else if k == "commands" || k == "path" {
                var kept: [String] = []
                for l in lines(v) {
                    if let c = k == "commands" ? command(l) : dir(l) { if !kept.contains(c) { kept.append(c) } } else { rejected.append(l) }
                }
                let cap = k == "commands" ? maxCommands : maxDirs
                if kept.count > cap { rejected += kept[cap...]; kept = Array(kept.prefix(cap)) }
                s[k] = kept
            }
        }
        // Une valeur revenue à l'origine n'est plus « modifiée ».
        for k in flags where s[k] as? Bool == false { s[k] = nil }
        if s["commands"] as? [String] == defaultCommands { s["commands"] = nil }
        if (s["path"] as? [String])?.isEmpty == true { s["path"] = nil }
        UserDefaults.standard.set(s, forKey: store)
        return state(rejected: rejected)
    }
}
#endif
