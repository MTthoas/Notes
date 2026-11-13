// Serveur d'un projet (VPS, VM) joint en SSH depuis le Mac, avec la configuration SSH de l'utilisateur
// (~/.ssh/config, agent SSH, clés) : Studio ne stocke ni ne voit aucune clé.
//
// Garde-fous : /usr/bin/ssh sans shell local, BatchMode (jamais de mot de passe demandé), délai de connexion court ;
// l'hôte est un alias de ~/.ssh/config ou « utilisateur@hôte » validé, le chemin distant est validé caractère par caractère,
// et les commandes distantes sont des modèles fixes dont chaque argument est protégé (guillemets simples).
// La configuration (hôte, chemin) reste dans les réglages de l'app Mac, jamais dans une note.
import Foundation
#if os(macOS)
import AppKit

final class Servers {
    static let shared = Servers()
    private let key = "studio.projectServers"
    private var all: [String: [String: String]] {
        get { UserDefaults.standard.dictionary(forKey: key) as? [String: [String: String]] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    static func validHost(_ h: String) -> Bool {
        !h.isEmpty && h.count <= 120 && h.first != "-" && h.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "._-@".contains($0) }
    }
    static func validPath(_ p: String) -> Bool {
        !p.isEmpty && p.count <= 300 && (p.hasPrefix("/") || p.hasPrefix("~")) && !p.contains("..") && p.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "/._~-".contains($0) }
    }
    /// Protège un argument pour le shell distant : 'a'\''b'.
    static func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    /// Chemin distant : « ~/x » reste interprété par le shell distant, le reste est protégé.
    static func qPath(_ p: String) -> String { p == "~" ? "~" : p.hasPrefix("~/") ? "~/" + q(String(p.dropFirst(2))) : q(p) }

    func config(_ pid: String) -> (host: String, path: String)? {
        guard let c = all[pid], let h = c["host"], let p = c["path"], Self.validHost(h), Self.validPath(p) else { return nil }
        return (h, p)
    }

    /// Alias déclarés dans ~/.ssh/config (sans les motifs génériques).
    func hosts() -> [String: Any] {
        let file = NSHomeDirectory() + "/.ssh/config"
        let text = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        var out: [[String: String]] = [], cur: [String] = []
        var names: [String: String] = [:]
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" || $0 == "=" }).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else { continue }
            switch parts[0].lowercased() {
            case "host": cur = parts[1].split(separator: " ").map(String.init).filter { !$0.contains("*") && !$0.contains("?") && Self.validHost($0) }
                cur.forEach { names[$0] = "" }
            case "hostname": cur.forEach { names[$0] = parts[1] }
            default: break
            }
        }
        for (k, v) in names.sorted(by: { $0.key < $1.key }) { out.append(["alias": k, "hostname": v]) }
        return ["ok": true, "hosts": out]
    }

    func set(_ pid: String, host: String, path: String) -> [String: Any] {
        guard !pid.isEmpty, pid.count <= 64 else { return ["ok": false, "message": "Projet invalide."] }
        guard Self.validHost(host) else { return ["ok": false, "message": "Hôte invalide : un alias de ~/.ssh/config ou utilisateur@hôte."] }
        guard Self.validPath(path) else { return ["ok": false, "message": "Chemin invalide : absolu (/srv/app) ou depuis ~ (~/app), sans espace ni caractère spécial."] }
        var a = all; a[pid] = ["host": host, "path": path]; all = a
        return ["ok": true, "host": host, "path": path]
    }
    func forget(_ pid: String) { var a = all; a.removeValue(forKey: pid); all = a }

    /// Arguments de /usr/bin/ssh pour exécuter `command` (déjà protégée) sur le serveur du projet.
    func sshArgs(_ host: String, _ command: String) -> [String] {
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-T", host, "--", command]
    }

    private func run(_ host: String, _ command: String, timeout: TimeInterval = 20) -> (status: Int32, out: String, ms: Int)? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        p.arguments = sshArgs(host, command)
        var env = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "LC_ALL": "C"]
        if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] { env["SSH_AUTH_SOCK"] = sock }
        p.environment = env
        let out = Pipe(); p.standardOutput = out; p.standardError = out; p.standardInput = FileHandle.nullDevice
        var data = Data(); let lock = NSLock(); let g = DispatchGroup(); g.enter()
        DispatchQueue.global(qos: .utility).async {
            while true { let c = out.fileHandleForReading.availableData; if c.isEmpty { break }; lock.lock(); if data.count < 200_000 { data.append(c) }; lock.unlock() }
            g.leave()
        }
        let start = Date()
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(30_000) }
        if p.isRunning { p.terminate() }
        p.waitUntilExit(); _ = g.wait(timeout: .now() + 2)
        lock.lock(); defer { lock.unlock() }
        return (p.terminationStatus, String(decoding: data, as: UTF8.self), Int(Date().timeIntervalSince(start) * 1000))
    }

    /// État du serveur : joignable, latence, charge, disque, mémoire, dépôt Git, Claude Code.
    func status(_ pid: String) -> [String: Any] {
        guard let c = config(pid) else { return ["ok": true, "configured": false] }
        let dir = Self.qPath(c.path)
        let cmd = "uptime; echo @@; df -hP \(dir) 2>/dev/null | tail -1; echo @@; (free -m 2>/dev/null | sed -n 2p) || true; echo @@; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null; echo @@; cd \(dir) 2>/dev/null && git status -sb 2>/dev/null | head -1; echo @@; (command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | head -1) || true; echo @@; uname -sr"
        guard let r = run(c.host, cmd) else { return ["ok": false, "message": "SSH introuvable."] }
        var base: [String: Any] = ["ok": true, "configured": true, "host": c.host, "path": c.path, "ms": r.ms]
        guard r.status == 0 || r.out.contains("@@") else {
            base["online"] = false
            base["error"] = String(r.out.split(separator: "\n").last ?? "Connexion refusée").prefix(200)
            return base
        }
        let s = r.out.components(separatedBy: "@@").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        func at(_ i: Int) -> String { i < s.count ? s[i] : "" }
        base["online"] = true
        if let r = at(0).range(of: #"load averages?: ([\d.,]+)[, ]+([\d.,]+)[, ]+([\d.,]+)"#, options: .regularExpression) {
            let nums = at(0)[r].replacingOccurrences(of: #"load averages?: "#, with: "", options: .regularExpression)
                .split(whereSeparator: { $0 == " " }).map { Double($0.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: CharacterSet(charactersIn: ","))) ?? 0 }
            base["load"] = nums
        }
        if let up = at(0).range(of: #"up [^,]+(, [^,]*\d+:\d+)?"#, options: .regularExpression) { base["uptime"] = String(at(0)[up].dropFirst(3)) }
        let df = at(1).split(whereSeparator: { $0 == " " }).map(String.init)
        if df.count >= 5 { base["disk"] = ["size": df[1], "used": df[2], "free": df[3], "pct": Int(df[4].replacingOccurrences(of: "%", with: "")) ?? 0] }
        let mem = at(2).split(whereSeparator: { $0 == " " }).map(String.init)
        if mem.count >= 3, let total = Int(mem[1]), let used = Int(mem[2]) { base["mem"] = ["total": total, "used": used] }
        base["cpus"] = Int(at(3)) ?? 0
        base["git"] = at(4)
        base["claude"] = at(5)
        base["os"] = at(6)
        return base
    }

    /// Ouvre un terminal SSH sur le serveur du projet (Terminal de macOS, URL ssh://).
    func terminal(_ pid: String) -> [String: Any] {
        guard let c = config(pid), let url = URL(string: "ssh://" + c.host) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        NSWorkspace.shared.open(url)
        return ["ok": true]
    }
}
#endif
