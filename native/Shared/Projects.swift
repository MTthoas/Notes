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
    private func git(_ args: [String], in dir: String, timeout: TimeInterval = 5, maxBytes: Int = 400_000) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir, "--no-pager"] + args
        p.environment = ["GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "PATH": "/usr/bin:/bin"]
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
    func diff(_ id: String, scope: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        if scope == "branch" {
            let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "origin/main"
            let stat = git(["diff", "--stat", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            let patch = git(["diff", "--unified=3", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            return ["ok": true, "base": base, "stat": stat, "patch": patch, "truncated": patch.utf8.count >= 400_000]
        }
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
    func open(_ id: String, with app: String) throws {
        guard let dir = path(id) else { throw Failure(message: "Choisis d'abord le dossier du projet.") }
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
