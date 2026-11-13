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

    /// Lance git en lecture seule, sans shell, avec un délai maximal.
    private func git(_ args: [String], in dir: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return nil }
        guard p.terminationStatus == 0 else { return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
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
