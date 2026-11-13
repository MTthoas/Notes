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
        init(id: String, project: String, mode: String, prompt: String) { self.id = id; self.project = project; self.mode = mode; self.prompt = prompt }
    }
    private var runs: [String: Run] = [:]
    private let lock = NSLock()
    private let maxRunning = 3
    private let maxDuration: TimeInterval = 90 * 60

    private static let readTools = ["Read", "Glob", "Grep"]
    private static let editTools = ["Read", "Glob", "Grep", "Edit", "Write"]
    private static let testCommands = ["Bash(npm test)", "Bash(npm run test)", "Bash(npm run *)"]
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
                "quota": r.quota ?? NSNull()]
    }

    func list(project: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let mine = runs.values.filter { $0.project == project }.sorted { $0.started > $1.started }.prefix(20)
        return ["ok": true, "runs": mine.map(summary)]
    }

    func stop(_ id: String) -> [String: Any] {
        lock.lock(); let r = runs[id]; lock.unlock()
        guard let r, let p = r.process, p.isRunning else { return ["ok": false, "message": "Cet agent ne tourne plus."] }
        r.status = "stopped"; p.terminate()
        return ["ok": true]
    }

    /// Lance une consigne (nouvelle session) ou reprend une session existante (`session`).
    /// `done` est appelé dès que la session est créée (ou en cas d'échec), l'agent continue ensuite seul.
    func start(project pid: String, body: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let folders = ProjectFolders.shared
        guard let dir = folders.path(pid) else { return done(["ok": false, "message": "Choisis d'abord le dossier du projet sur ce Mac."]) }
        guard let bin = ClaudeCode.shared.binary() else { return done(["ok": false, "message": "Claude Code n'est pas installé sur ce Mac."]) }
        let prompt = (body["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.utf8.count <= 100_000 else { return done(["ok": false, "message": "Consigne vide ou trop longue."]) }
        lock.lock(); let busy = runs.values.filter { $0.status == "running" || $0.status == "starting" }.count >= maxRunning; lock.unlock()
        if busy { return done(["ok": false, "message": "Trois agents tournent déjà : attends qu'un se termine ou arrête-en un."]) }

        let resume = body["session"] as? String ?? ""
        var cwd = dir, mode = body["mode"] as? String == "edit" ? "edit" : "read"
        var args = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--permission-mode", "dontAsk",
                    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
        if !resume.isEmpty {
            // Reprise : même dossier que la session d'origine, qui doit appartenir au projet.
            guard let c = ClaudeSessions.shared.cwd(project: dir, session: resume) else { return done(["ok": false, "message": "Session introuvable pour ce projet."]) }
            cwd = c; mode = c == dir ? "read" : "edit"
            args += ["--resume", resume]
        } else if mode == "edit" {
            guard folders.isRepo(dir) else { return done(["ok": false, "message": "Le mode « modifier » demande un dépôt Git : il travaille dans une copie isolée."]) }
            folders.excludeWorktrees(dir)
            let stamp = DateFormatter(); stamp.dateFormat = "MMdd-HHmm"
            let base = Self.slug(body["name"] as? String ?? prompt)
            let name = "studio-" + (base.isEmpty ? "agent" : base) + "-" + stamp.string(from: Date())
            args += ["--worktree", name]
        }
        let tests = mode == "edit" && body["tests"] as? Bool == true
        let tools = (mode == "edit" ? Self.editTools : Self.readTools) + (tests ? ["Bash"] : [])
        args += ["--tools", tools.joined(separator: ",")]
        if let model = body["model"] as? String, !model.isEmpty,
           Self.modelRe.firstMatch(in: model, range: NSRange(model.startIndex..., in: model)) != nil { args += ["--model", model] }
        args += ["--append-system-prompt", """
            Tu es lancé depuis Studio, sans personne pour répondre à tes questions : travaille de façon autonome jusqu'au bout. \
            \(mode == "edit" ? "Tu travailles dans une copie isolée du dépôt ; ne fais pas de commit, l'utilisateur relira tes changements." : "Tu es en lecture seule : analyse et propose, sans modifier de fichier.") \
            Termine par un compte rendu court en Markdown : ce qui a été fait, les fichiers touchés, ce qui reste à décider.
            """]
        args += ["--allowedTools"] + tools.filter { $0 != "Bash" } + (tests ? Self.testCommands : [])

        let run = Run(id: UUID().uuidString, project: pid, mode: mode, prompt: String(prompt.prefix(500)))
        if !resume.isEmpty { run.session = resume; run.cwd = cwd; run.worktree = cwd.range(of: "/.claude/worktrees/").map { String(cwd[$0.upperBound...]) } ?? "" }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
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
            if let m = e["message"] as? [String: Any] {
                for b in m["content"] as? [[String: Any]] ?? [] where b["type"] as? String == "text" {
                    if let t = b["text"] as? String, !t.isEmpty { run.lastText = String(t.prefix(300)) }
                }
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
