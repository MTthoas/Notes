// Dossiers de projet (Mac uniquement). La page ne fournit jamais de chemin : elle désigne un projet par
// son identifiant, et le dossier a été choisi par la personne dans le sélecteur de macOS.
// Les chemins restent dans les réglages de l'app, sur ce Mac : ils ne sont ni dans les notes ni synchronisés.
import Foundation
#if os(macOS)
import AppKit

final class ProjectFolders {
    static let shared = ProjectFolders()
    private let key = "studio.projectFolders"
    struct Failure: Error { let message: String }

    private var folders: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
    /// Identifiant de projet : celui d'une note (UUID ou hexadécimal), rien d'autre.
    private func valid(_ id: String) -> Bool { !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" } }

    func path(_ id: String) -> String? {
        guard valid(id), let p = folders[id], FileManager.default.fileExists(atPath: p) else { return nil }
        return p
    }

    func pick(_ id: String, done: @escaping (String?) -> Void) {
        guard valid(id) else { return done(nil) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choisir ce dossier"
        panel.message = "Dossier du projet sur ce Mac (souvent le dépôt Git)"
        if let p = path(id) { panel.directoryURL = URL(fileURLWithPath: p) }
        panel.begin { r in
            guard r == .OK, let url = panel.url else { return done(nil) }
            var f = self.folders; f[id] = url.path; self.folders = f
            done(url.path)
        }
    }

    func forget(_ id: String) { var f = folders; f.removeValue(forKey: id); folders = f }

    /// Lance git en lecture seule, sans shell, avec un délai et une taille de sortie maximaux.
    /// La sortie est lue pendant l'exécution : une sortie volumineuse ne peut pas bloquer le processus.
    func git(_ args: [String], in dir: String, timeout: TimeInterval = 5, maxBytes: Int = 400_000) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir, "--no-pager"] + args
        // HOME : configuration Git de l'utilisateur (identité, gestionnaire d'identifiants) ; agent SSH s'il existe.
        var env = ["GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] { env["SSH_AUTH_SOCK"] = sock }
        p.environment = env
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        var data = Data(); let lock = NSLock(); let reading = DispatchGroup()
        reading.enter()
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = out.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                lock.lock(); if data.count < maxBytes { data.append(chunk) }; lock.unlock()
            }
            reading.leave()
        }
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return nil }
        _ = reading.wait(timeout: .now() + 2)
        guard p.terminationStatus == 0 else { return nil }
        lock.lock(); defer { lock.unlock() }
        return String(decoding: data.prefix(maxBytes), as: UTF8.self)
    }

    /// Changements à relire : non commités (par rapport à HEAD) ou ceux de la branche (par rapport à la branche principale).
    func diff(_ id: String, scope: String, worktree: String? = nil) -> [String: Any] {
        guard let dir = worktree.map({ worktreeDir(id, $0) }) ?? path(id) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        if scope == "branch" {
            let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "origin/main"
            let stat = git(["diff", "--stat", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            let patch = git(["diff", "--unified=3", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            return ["ok": true, "base": base, "stat": stat, "patch": patch, "truncated": patch.utf8.count >= 400_000]
        }
        // Copie d'agent : les fichiers créés sont marqués « à ajouter » pour apparaître dans le diff (index de la copie seulement).
        if worktree != nil { _ = git(["add", "--intent-to-add", "-A"], in: dir, timeout: 15) }
        let stat = git(["diff", "--stat", "HEAD"], in: dir, timeout: 15) ?? ""
        let patch = git(["diff", "--unified=3", "HEAD"], in: dir, timeout: 15) ?? ""
        let untracked = git(["ls-files", "--others", "--exclude-standard"], in: dir) ?? ""
        return ["ok": true, "base": "HEAD", "stat": stat, "patch": patch, "untracked": untracked, "truncated": patch.utf8.count >= 400_000]
    }

    /// Branches locales et leur position par rapport à la branche principale (pour le suivi du flux).
    func branches(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "branches": []] }
        let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "origin/main"
        let raw = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(upstream:short)", "refs/heads/"], in: dir) ?? ""
        var out: [[String: Any]] = []
        for line in raw.split(separator: "\n").prefix(25) {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let name = f.first else { continue }
            let counts = git(["rev-list", "--left-right", "--count", "\(base)...\(name)"], in: dir)?.split(whereSeparator: { $0 == "\t" || $0 == " " || $0 == "\n" }).compactMap { Int($0) } ?? []
            out.append(["name": name, "date": f.count > 1 ? f[1] : "", "upstream": f.count > 2 ? f[2] : "", "behind": counts.first ?? 0, "ahead": counts.count > 1 ? counts[1] : 0])
        }
        return ["ok": true, "base": base, "branches": out]
    }

    // MARK: Copies isolées (worktrees) créées par les agents

    /// Nom de copie isolée accepté : minuscules, chiffres et tirets (jamais un chemin).
    static func validWorktree(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 64 && name.first != "-" && name.allSatisfy { ($0.isLowercase && $0.isASCII) || $0.isNumber || $0 == "-" }
    }
    func worktreeDir(_ id: String, _ name: String) -> String? {
        guard Self.validWorktree(name), let dir = path(id) else { return nil }
        let wt = dir + "/.claude/worktrees/" + name
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: wt, isDirectory: &isDir) && isDir.boolValue ? wt : nil
    }
    /// Les copies isolées n'apparaissent pas dans `git status` du dépôt (exclusion locale, jamais commitée).
    func excludeWorktrees(_ dir: String) {
        guard let gitDir = git(["rev-parse", "--git-common-dir"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines), !gitDir.isEmpty else { return }
        let base = gitDir.hasPrefix("/") ? gitDir : dir + "/" + gitDir
        let file = base + "/info/exclude", line = ".claude/worktrees/"
        let cur = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        if cur.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == line }) { return }
        try? FileManager.default.createDirectory(atPath: base + "/info", withIntermediateDirectories: true)
        try? (cur + (cur.isEmpty || cur.hasSuffix("\n") ? "" : "\n") + line + "\n").write(toFile: file, atomically: true, encoding: .utf8)
    }
    func isRepo(_ dir: String) -> Bool { git(["rev-parse", "--is-inside-work-tree"], in: dir)?.hasPrefix("true") == true }

    /// Copies isolées du projet : branche, changements, commits d'avance sur la branche principale.
    func worktrees(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "worktrees": []] }
        let raw = git(["worktree", "list", "--porcelain"], in: dir) ?? ""
        let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "HEAD"
        var out: [[String: Any]] = []
        for block in raw.components(separatedBy: "\n\n") {
            var wtPath = "", branch = ""
            for l in block.split(separator: "\n") {
                if l.hasPrefix("worktree ") { wtPath = String(l.dropFirst(9)) }
                if l.hasPrefix("branch ") { branch = String(l.dropFirst(7)).replacingOccurrences(of: "refs/heads/", with: "") }
            }
            guard wtPath.hasPrefix(dir + "/.claude/worktrees/") else { continue }
            let name = (wtPath as NSString).lastPathComponent
            guard Self.validWorktree(name) else { continue }
            let changes = (git(["status", "--porcelain"], in: wtPath) ?? "").split(separator: "\n").count
            let ahead = Int(git(["rev-list", "--count", "\(base)..HEAD"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
            let upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            out.append(["name": name, "branch": branch, "changes": changes, "ahead": ahead, "pushed": !upstream.isEmpty])
        }
        return ["ok": true, "worktrees": out, "base": base]
    }

    /// Valide les changements d'une copie isolée et pousse sa branche (identifiants Git habituels de l'utilisateur).
    func commitPush(_ id: String, name: String, message: String) -> [String: Any] {
        guard let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        let msg = String(message.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        if !(git(["status", "--porcelain"], in: wt) ?? "").isEmpty {
            guard !msg.isEmpty else { return ["ok": false, "message": "Message de commit vide."] }
            guard git(["add", "-A"], in: wt, timeout: 30) != nil, git(["commit", "-q", "-m", msg], in: wt, timeout: 30) != nil else {
                return ["ok": false, "message": "Le commit a échoué (identité Git configurée ?)."]
            }
        }
        guard let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty, branch != "HEAD" else {
            return ["ok": false, "message": "Branche introuvable."]
        }
        guard git(["push", "-u", "origin", branch], in: wt, timeout: 90) != nil else {
            return ["ok": false, "message": "Le push a échoué : vérifie tes identifiants Git pour ce dépôt."]
        }
        return ["ok": true, "branch": branch]
    }

    /// Supprime une copie isolée et sa branche locale (la branche poussée sur GitHub reste).
    func removeWorktree(_ id: String, name: String) -> [String: Any] {
        guard let dir = path(id), let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        _ = git(["worktree", "unlock", wt], in: dir)
        guard git(["worktree", "remove", "--force", wt], in: dir, timeout: 30) != nil else { return ["ok": false, "message": "Suppression impossible."] }
        if branch.hasPrefix("worktree-studio-") { _ = git(["branch", "-D", branch], in: dir) }
        return ["ok": true]
    }

    /// Commits par jour sur les `days` derniers jours (toutes branches), pour les graphiques.
    func commits(_ id: String, days: Int) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "days": [:], "found": false] }
        let raw = git(["log", "--all", "--since=\(max(1, min(days, 365))).days", "--format=%cs"], in: dir, timeout: 15) ?? ""
        var out: [String: Int] = [:]
        for d in raw.split(separator: "\n") { out[String(d), default: 0] += 1 }
        return ["ok": true, "days": out, "found": true]
    }

    /// État du dépôt : branche, avance/retard, fichiers modifiés, dépôt GitHub d'origine.
    func info(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "path": NSNull()] }
        var r: [String: Any] = ["ok": true, "path": dir, "name": (dir as NSString).lastPathComponent, "git": false]
        if let s = git(["status", "--porcelain=v1", "--branch"], in: dir) {
            let lines = s.split(separator: "\n").map(String.init)
            r["git"] = true
            if let head = lines.first, head.hasPrefix("## ") {
                let h = String(head.dropFirst(3))
                r["branch"] = String(h.split(separator: ".").first ?? Substring(h)).replacingOccurrences(of: "No commits yet on ", with: "")
                if let a = h.range(of: #"ahead (\d+)"#, options: .regularExpression) { r["ahead"] = Int(h[a].split(separator: " ").last ?? "0") ?? 0 }
                if let b = h.range(of: #"behind (\d+)"#, options: .regularExpression) { r["behind"] = Int(h[b].split(separator: " ").last ?? "0") ?? 0 }
            }
            r["changes"] = lines.dropFirst().filter { !$0.isEmpty }.count
        }
        if let url = git(["remote", "get-url", "origin"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines),
           let m = url.range(of: #"github\.com[:/]([\w.-]+/[\w.-]+?)(\.git)?$"#, options: .regularExpression) {
            r["remote"] = String(url[m]).replacingOccurrences(of: #"^github\.com[:/]"#, with: "", options: .regularExpression).replacingOccurrences(of: ".git", with: "")
        }
        return r
    }

    /// Ouvre le dossier dans le Finder, VS Code ou le Terminal.
    func open(_ id: String, with app: String, worktree: String? = nil) throws {
        guard let dir = worktree.map({ worktreeDir(id, $0) }) ?? path(id) else { throw Failure(message: "Choisis d'abord le dossier du projet.") }
        let url = URL(fileURLWithPath: dir, isDirectory: true)
        let ws = NSWorkspace.shared
        switch app {
        case "finder":
            ws.activateFileViewerSelecting([url])
        case "vscode":
            let ids = ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.vscodium"]
            guard let appURL = ids.lazy.compactMap({ ws.urlForApplication(withBundleIdentifier: $0) }).first else {
                throw Failure(message: "VS Code n'est pas installé sur ce Mac.")
            }
            ws.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
        case "terminal":
            guard let term = ws.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { throw Failure(message: "Terminal introuvable.") }
            ws.open([url], withApplicationAt: term, configuration: NSWorkspace.OpenConfiguration())
        default:
            throw Failure(message: "Application inconnue.")
        }
    }
}
#endif

#if os(macOS)
/// Vérifie qu'un site répond (HTTPS public uniquement, sans cookies) : code, temps de réponse, adresse finale.
enum SiteCheck {
    static func isPublicHTTPS(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".internal") { return false }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4 {
            if parts[0] == 10 || parts[0] == 127 || parts[0] == 0 || (parts[0] == 169 && parts[1] == 254) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1])) { return false }
        }
        return !host.contains(":")
    }
    static func run(_ raw: String, done: @escaping ([String: Any]) -> Void) {
        guard let url = URL(string: raw), isPublicHTTPS(url) else { return done(["ok": false, "message": "Adresse invalide : seul un site public en https:// est vérifié."]) }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.httpCookieStorage = nil
        var req = URLRequest(url: url); req.httpMethod = "GET"; req.setValue("Studio (vérification du site)", forHTTPHeaderField: "User-Agent")
        let start = Date()
        let session = URLSession(configuration: cfg, delegate: Redirects(), delegateQueue: nil)
        session.dataTask(with: req) { _, resp, err in
            session.finishTasksAndInvalidate()
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            if let err { return done(["ok": true, "up": false, "ms": ms, "message": err.localizedDescription]) }
            let http = resp as? HTTPURLResponse
            done(["ok": true, "up": (200..<400).contains(http?.statusCode ?? 0), "status": http?.statusCode ?? 0, "ms": ms, "final": http?.url?.absoluteString ?? raw])
        }.resume()
    }
    /// Une redirection ne suit que vers un autre site public en https (jamais vers le réseau local).
    private final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url.map(SiteCheck.isPublicHTTPS) == true ? request : nil)
        }
    }
}
#endif
