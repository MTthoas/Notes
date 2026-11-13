// Agents Claude Code lancés depuis un projet Studio (Mac uniquement).
//
// Une consigne part dans le dossier du projet choisi sur ce Mac :
// - « analyse » : lecture seule (Read, Glob, Grep) dans le dossier du projet ;
// - « modifier » : dans une copie isolée du dépôt (worktree créé par Claude Code dans .claude/worktrees/),
//   avec lecture et écriture de fichiers seulement, confinées à cette copie ;
// - option « tests » : autorise en plus `npm test` et `npm run …` (le code du projet peut alors s'exécuter).
//
// Garde-fous : programme à un emplacement connu, aucun shell, --restricted (outils de fichiers confinés au
// dossier de travail), --permission-mode dontAsk (tout ce qui n'est pas listé est refusé, sans question),
// aucun réglage, hook ni serveur MCP de l'utilisateur, trois agents à la fois au plus, 90 minutes au plus.
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

    private static let readTools = ["Read", "Glob", "Grep"]
    private static let editTools = ["Read", "Glob", "Grep", "Edit", "Write"]
    private static let testCommands = ["Bash(npm test)", "Bash(npm run test)", "Bash(npm run *)"]
    /// Consignes des agents qui modifient : pas de commit, conflits, et le message de commit qu'ils proposent.
    private static let editRules = """
        Tu travailles dans une copie isolée du dépôt ; ne fais pas de commit, l'utilisateur relira tes changements. \
        Si un fichier contient des marqueurs de conflit (<<<<<<< ======= >>>>>>>), c'est que ta copie a été remise sur la dernière \
        version de la branche principale : fusionne les deux côtés à la main en gardant leurs intentions, et retire tous les marqueurs. \
        Quand tu as modifié des fichiers, termine ton compte rendu par une dernière ligne, seule, de la forme \
        « Commit: type(portée): résumé » au format Conventional Commits (feat, fix, refactor, docs, test, chore, perf, style, build, ci ; \
        72 caractères au plus ; à l'impératif ; en anglais sauf si le dépôt est rédigé dans une autre langue ; sans point final). \
        Elle décrit l'ensemble des changements présents dans la copie, jamais la demande elle-même (pas de « résout le conflit »).
        """
    private static let modelRe = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9.\\-]{0,40}$")

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
        return ["ok": true, "runs": mine.map(summary)]
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
        let prompt = (body["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.utf8.count <= 100_000 else { return done(["ok": false, "message": "Consigne vide ou trop longue."]) }
        lock.lock(); let busy = runs.values.filter { $0.status == "running" || $0.status == "starting" }.count >= maxRunning; lock.unlock()
        if busy { return done(["ok": false, "message": "Trois agents tournent déjà : attends qu'un se termine ou arrête-en un."]) }

        let resume = body["session"] as? String ?? ""
        var cwd = dir, mode = body["mode"] as? String == "edit" ? "edit" : "read", newWorktree = ""
        var args = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--permission-mode", "dontAsk",
                    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
        if !resume.isEmpty {
            // Reprise : même dossier que la session d'origine, qui doit appartenir au projet.
            let known: String? = onServer ? { lock.lock(); defer { lock.unlock() }; return runs.values.first { $0.session == resume && $0.machine == "server" && $0.project == pid }?.cwd }() : ClaudeSessions.shared.cwd(project: dir, session: resume)
            guard let c = known, c == dir || c.hasPrefix(dir + "/.claude/worktrees/") || onServer else { return done(["ok": false, "message": "Session introuvable pour ce projet."]) }
            cwd = c; mode = c.contains("/.claude/worktrees/") ? "edit" : "read"
            args += ["--resume", resume]
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
        let tests = mode == "edit" && body["tests"] as? Bool == true && !onServer
        let tools = (mode == "edit" ? Self.editTools : Self.readTools) + (tests ? ["Bash"] : [])
        args += ["--tools", tools.joined(separator: ",")]
        if let model = body["model"] as? String, !model.isEmpty,
           Self.modelRe.firstMatch(in: model, range: NSRange(model.startIndex..., in: model)) != nil { args += ["--model", model] }
        args += ["--append-system-prompt", """
            Tu es lancé depuis Studio. L'utilisateur lit tes messages dans un fil de discussion et peut te répondre ensuite \
            en reprenant la session, mais personne ne répond pendant que tu travailles. \
            \(mode == "edit" ? Self.editRules : "Tu es en lecture seule : analyse et propose, sans modifier de fichier.") \
            Si l'utilisateur demande une tâche précise, mène-la de façon autonome jusqu'au bout, puis termine par un compte rendu \
            court en Markdown : ce qui a été fait, les fichiers touchés, ce qui reste à décider. \
            S'il veut au contraire réfléchir, discuter, comparer des options ou avoir ton avis, ne te lance pas dans la réalisation : \
            réponds comme dans une conversation, donne ton analyse et ta recommandation, pose tes questions, et attends sa réponse \
            avant de modifier quoi que ce soit.
            """]
        args += ["--allowedTools"] + tools.filter { $0 != "Bash" } + (tests ? Self.testCommands : [])

        let run = Run(id: UUID().uuidString, project: pid, mode: mode, prompt: String(prompt.prefix(500)))
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
                    + "git worktree add -q -b \(Servers.q("worktree-" + newWorktree)) \(Servers.q(wt)) \"$B\" && cd \(Servers.q(wt)) && "
            }
            // Première ligne du flux : le numéro du processus distant (exec le conserve), pour pouvoir l'arrêter.
            let remote = "cd \(Servers.qPath(cwd)) && \(prep)echo \"{\\\"type\\\":\\\"studio_pid\\\",\\\"pid\\\":$$}\" && PATH=\"$HOME/.local/bin:$HOME/.claude/local:$PATH\" exec claude " + args.map(Servers.q).joined(separator: " ")
            p.arguments = Servers.shared.sshArgs(server.host, remote)
            p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        } else {
            p.arguments = args
            p.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        var env = ProcessInfo.processInfo.environment
        env["DISABLE_AUTOUPDATER"] = "1"; env["NO_COLOR"] = "1"
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
            self.lock.unlock()
            answerOnce(["ok": false, "message": run.result.isEmpty ? "Claude Code s'est arrêté avant de démarrer." : run.result])
        }
        do { try p.run() } catch { return done(["ok": false, "message": "Impossible de lancer Claude Code."]) }
        lock.lock(); runs[run.id] = run; lock.unlock()
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
#endif
