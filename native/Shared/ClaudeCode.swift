// Claude Code comme moteur d'IA de Studio (Mac uniquement) : l'app lance le Claude Code installé
// sur ce Mac, connecté à l'abonnement de l'utilisateur, en mode non interactif.
//
// Garde-fous :
// - le programme est cherché à des emplacements fixes (jamais le PATH, jamais un chemin fourni par la page) ;
// - aucun shell : arguments passés tels quels, consigne envoyée sur l'entrée standard ;
// - aucun outil de Claude Code (--tools ""), aucun serveur MCP, aucun réglage ni hook de l'utilisateur,
//   aucune session enregistrée, dossier de travail vide et dédié ;
// - délai maximal, taille de sortie bornée, deux exécutions à la fois au plus, annulation possible.
import Foundation
#if os(macOS)

final class ClaudeCode {
    static let shared = ClaudeCode()
    private let queue = DispatchQueue(label: "studio.claudecode", attributes: .concurrent)
    private let lock = NSLock()
    private var running: [String: Process] = [:]
    private let maxRuns = 2

    // MARK: Programme

    /// Emplacements connus de Claude Code, du plus courant au moins courant.
    private func candidates() -> [String] {
        let fm = FileManager.default, home = fm.homeDirectoryForCurrentUser.path
        var list = ["\(home)/.local/bin/claude", "\(home)/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
        // Binaire fourni par l'extension VS Code (ou Cursor) : la version la plus récente.
        for editor in [".vscode", ".cursor", ".vscode-insiders"] {
            let ext = "\(home)/\(editor)/extensions"
            let dirs = ((try? fm.contentsOfDirectory(atPath: ext)) ?? []).filter { $0.hasPrefix("anthropic.claude-code-") }
                .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            list += dirs.map { "\(ext)/\($0)/resources/native-binary/claude" }
        }
        return list
    }

    func binary() -> String? {
        let fm = FileManager.default
        for p in candidates() {
            let real = (try? fm.destinationOfSymbolicLink(atPath: p)).map { $0.hasPrefix("/") ? $0 : (p as NSString).deletingLastPathComponent + "/" + $0 } ?? p
            var dir: ObjCBool = false
            if fm.fileExists(atPath: real, isDirectory: &dir), !dir.boolValue, fm.isExecutableFile(atPath: real) { return p }
        }
        return nil
    }

    /// Dossier de travail vide, propre à Studio : Claude Code n'y trouve ni CLAUDE.md ni réglages de projet.
    private lazy var workDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Studio/claude-code", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

    // MARK: Exécution

    private struct Output { var status: Int32; var stdout: Data; var timedOut: Bool; var cancelled: Bool }

    private func exec(_ args: [String], stdin: Data? = nil, timeout: TimeInterval, runId: String? = nil, maxBytes: Int = 4_000_000) -> Output? {
        guard let bin = binary() else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        p.currentDirectoryURL = workDir
        var env = ProcessInfo.processInfo.environment
        env["DISABLE_AUTOUPDATER"] = "1"
        env["NO_COLOR"] = "1"
        // Pas d'appels au modèle pour l'accessoire, sauf réglage contraire (Réglages → Consignes et contexte).
        if AgentTuning.lean { env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] = "1" }
        p.environment = env
        let out = Pipe(), input = Pipe()
        p.standardOutput = out; p.standardError = FileHandle.nullDevice
        p.standardInput = stdin == nil ? FileHandle.nullDevice : input
        var data = Data(); let dataLock = NSLock(); let reading = DispatchGroup()
        reading.enter()
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = out.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                dataLock.lock(); if data.count < maxBytes { data.append(chunk) }; dataLock.unlock()
            }
            reading.leave()
        }
        do { try p.run() } catch { return nil }
        if let runId { lock.lock(); running[runId] = p; lock.unlock() }
        if let stdin {
            DispatchQueue.global(qos: .utility).async {
                try? input.fileHandleForWriting.write(contentsOf: stdin)
                try? input.fileHandleForWriting.close()
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        let timedOut = p.isRunning
        if timedOut { p.terminate() }
        p.waitUntilExit()
        var cancelled = false
        if let runId { lock.lock(); cancelled = running.removeValue(forKey: runId) == nil; lock.unlock() }
        _ = reading.wait(timeout: .now() + 2)
        dataLock.lock(); defer { dataLock.unlock() }
        return Output(status: p.terminationStatus, stdout: data, timedOut: timedOut, cancelled: cancelled && !timedOut)
    }

    private static func json(_ d: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    // MARK: Actions

    /// Installé ? connecté ? avec quelle offre ? (jamais l'adresse e-mail ni l'organisation)
    func status(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let bin = self.binary() else { return done(["ok": true, "installed": false]) }
            let version = self.exec(["--version"], timeout: 15).flatMap { String(data: $0.stdout, encoding: .utf8) }?
                .split(separator: " ").first.map(String.init) ?? ""
            let auth = self.exec(["auth", "status"], timeout: 15).flatMap { Self.json($0.stdout) } ?? [:]
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let source = bin.contains("/extensions/anthropic.claude-code-") ? "extension" : "cli"
            done(["ok": true, "installed": true, "version": version, "source": source,
                  "path": bin.hasPrefix(home) ? "~" + bin.dropFirst(home.count) : bin,
                  "loggedIn": auth["loggedIn"] as? Bool ?? false,
                  "authMethod": auth["authMethod"] as? String ?? "",
                  "plan": auth["subscriptionType"] as? String ?? auth["planTier"] as? String ?? ""])
        }
    }

    /// Connexion à l'abonnement : Claude Code ouvre la page de connexion dans le navigateur.
    func login(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard self.binary() != nil else { return done(["ok": false, "message": "Claude Code n'est pas installé sur ce Mac."]) }
            let r = self.exec(["auth", "login", "--claudeai"], timeout: 300, runId: "login")
            if r?.timedOut == true { return done(["ok": false, "message": "Connexion non terminée (délai dépassé)."]) }
            self.status(done: done)
        }
    }

    private static let modelRe = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9.\\-]{0,40}$")
    private static func valid(_ s: String, _ re: NSRegularExpression) -> Bool { re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
    private static let efforts: Set<String> = ["low", "medium", "high", "xhigh", "max"]
    /// Réponse structurée imposée quand l'automatisation a des outils : appels d'outils ou compte rendu final.
    private static let toolSchema = #"{"type":"object","additionalProperties":false,"properties":{"actions":{"type":"array","maxItems":12,"items":{"type":"object","additionalProperties":false,"properties":{"outil":{"type":"string"},"entree":{"type":"object"}},"required":["outil","entree"]}},"reponse":{"type":"string"}},"required":["actions","reponse"]}"#

    func run(_ body: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let runId = String((body["run"] as? String ?? UUID().uuidString).prefix(64))
        let system = body["system"] as? String ?? "", prompt = body["prompt"] as? String ?? ""
        let model = body["model"] as? String ?? "", effort = body["effort"] as? String ?? ""
        let structured = body["tools"] as? Bool ?? false
        guard !prompt.isEmpty, prompt.utf8.count <= 2_000_000, system.utf8.count <= 200_000 else { return done(["ok": false, "message": "Demande vide ou trop longue."]) }
        lock.lock(); let busy = running.count >= maxRuns; lock.unlock()
        if busy { return done(["ok": false, "message": "Claude Code est déjà occupé par deux demandes ; réessaie dans un instant."]) }
        var args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config",
                    "--setting-sources", "", "--disable-slash-commands", "--system-prompt", system]
        if !model.isEmpty && Self.valid(model, Self.modelRe) { args += ["--model", model] }
        if Self.efforts.contains(effort) { args += ["--effort", effort] }
        if structured { args += ["--json-schema", Self.toolSchema] }
        queue.async {
            guard let r = self.exec(args, stdin: Data(prompt.utf8), timeout: 600, runId: runId) else {
                return done(["ok": false, "message": "Claude Code est introuvable sur ce Mac."])
            }
            if r.cancelled { return done(["ok": false, "cancelled": true, "message": "Arrêté."]) }
            if r.timedOut { return done(["ok": false, "message": "Claude Code n'a pas répondu en 10 minutes."]) }
            guard let j = Self.json(r.stdout) else { return done(["ok": false, "message": "Réponse illisible de Claude Code (code \(r.status))."]) }
            let isError = j["is_error"] as? Bool ?? false
            let text = j["result"] as? String ?? ""
            var out: [String: Any] = ["ok": !isError, "text": text, "usage": j["usage"] ?? [:],
                                      "models": Array((j["modelUsage"] as? [String: Any] ?? [:]).keys),
                                      "durationMs": j["duration_ms"] ?? 0]
            if let s = j["structured_output"] { out["structured"] = s }
            if isError {
                let low = text.lowercased()
                out["message"] = low.contains("not logged in") || low.contains("/login") ? "Claude Code n'est pas connecté à ton abonnement."
                    : low.contains("limit") ? "Limite d'utilisation de ton abonnement atteinte : \(text)" : (text.isEmpty ? "Erreur de Claude Code." : text)
            }
            done(out)
        }
    }

    func cancel(_ runId: String) {
        lock.lock(); let p = running.removeValue(forKey: runId); lock.unlock()
        p?.terminate()
    }
}
#endif
