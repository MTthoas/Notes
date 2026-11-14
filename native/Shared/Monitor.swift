// Monitoring en direct du serveur d'un projet : une seule connexion SSH par projet, qui lit /proc toutes les
// 3 secondes (Linux) et renvoie un bloc par mesure. Le Mac en tire processeur, mémoire, réseau, disque, charge et
// processus les plus gourmands, et garde les 10 dernières minutes. La page interroge { op: "monitor" } : la
// connexion démarre à la première demande et s'arrête seule une minute après la dernière.
import Foundation
#if os(macOS)

final class Monitors {
    static let shared = Monitors()
    static let interval = 3
    private static let keep = 200

    private final class Probe {
        let host: String, path: String
        var process: Process?
        var buffer = ""
        var samples: [[String: Any]] = []
        var procs: [[String: Any]] = []
        var disk: [String: Any] = [:]
        var tasks = ""
        var error = ""
        var lastPoll = Date(), lastExit: Date?
        var prevCPU: (total: Double, idle: Double)?
        var prevNet: (rx: Double, tx: Double, at: Date)?
        init(host: String, path: String) { self.host = host; self.path = path }
    }
    private var probes: [String: Probe] = [:]
    private let lock = NSLock()
    private var watchdog: Timer?

    private static func script(_ dir: String) -> String {
        "export LC_ALL=C; while :; do head -n 1 /proc/stat; echo @; cat /proc/loadavg; echo @; "
        + "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; echo @; tail -n +3 /proc/net/dev; echo @; "
        + "df -kP \(dir) 2>/dev/null | tail -n 1; echo @; ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 8; "
        + "echo @@@; sleep \(interval); done"
    }

    /// Dernières mesures (plus récentes que `since`, en ms) ; lance la connexion au besoin.
    func poll(_ pid: String, since: Double) -> [String: Any] {
        guard let c = Servers.shared.config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        lock.lock(); defer { lock.unlock() }
        var p = probes[pid]
        if p == nil || p!.host != c.host || p!.path != c.path { p?.process?.terminate(); p = Probe(host: c.host, path: c.path); probes[pid] = p }
        let probe = p!
        probe.lastPoll = Date()
        // Relance après une coupure, sans marteler un serveur injoignable.
        if probe.process == nil, Date().timeIntervalSince(probe.lastExit ?? .distantPast) > 15 { start(probe) }
        armWatchdog()
        return ["ok": true, "running": probe.process != nil, "error": probe.error, "interval": Self.interval,
                "samples": probe.samples.filter { ($0["t"] as? Double ?? 0) > since },
                "procs": probe.procs, "disk": probe.disk, "tasks": probe.tasks]
    }

    func stop(_ pid: String) {
        lock.lock(); defer { lock.unlock() }
        probes[pid]?.process?.terminate(); probes.removeValue(forKey: pid)
    }

    private func armWatchdog() {
        guard watchdog == nil else { return }
        DispatchQueue.main.async {
            guard self.watchdog == nil else { return }
            self.watchdog = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.sweep() }
        }
    }
    private func sweep() {
        lock.lock(); defer { lock.unlock() }
        for (_, p) in probes where Date().timeIntervalSince(p.lastPoll) > 60 { p.process?.terminate() }
        probes = probes.filter { Date().timeIntervalSince($0.value.lastPoll) <= 60 }
        if probes.isEmpty { watchdog?.invalidate(); watchdog = nil }
    }

    // Appelé sous verrou.
    private func start(_ probe: Probe) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        p.arguments = Servers.shared.sshArgs(probe.host, Self.script(Servers.qPath(probe.path)))
        var env = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "LC_ALL": "C"]
        if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] { env["SSH_AUTH_SOCK"] = sock }
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
        probe.buffer = ""; probe.prevCPU = nil; probe.prevNet = nil
        out.fileHandleForReading.readabilityHandler = { [weak self, weak probe] h in
            let d = h.availableData
            guard let self, let probe, !d.isEmpty else { h.readabilityHandler = nil; return }
            self.lock.lock(); defer { self.lock.unlock() }
            probe.buffer += String(decoding: d, as: UTF8.self)
            while let r = probe.buffer.range(of: "@@@\n") {
                let frame = String(probe.buffer[..<r.lowerBound])
                probe.buffer.removeSubrange(..<r.upperBound)
                self.parse(frame, into: probe)
            }
            if probe.buffer.count > 200_000 { probe.buffer = "" }
        }
        var errText = ""
        err.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else if errText.count < 2000 { errText += String(decoding: d, as: UTF8.self) }
        }
        p.terminationHandler = { [weak self, weak probe] proc in
            guard let self, let probe else { return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
                self.lock.lock(); defer { self.lock.unlock() }
                guard probe.process === proc else { return }
                probe.process = nil; probe.lastExit = Date()
                let last = errText.split(separator: "\n").last.map(String.init) ?? ""
                if proc.terminationReason == .exit { probe.error = String((last.isEmpty ? "La connexion SSH s’est arrêtée." : last).prefix(200)) }
            }
        }
        do { try p.run(); probe.process = p; probe.error = "" } catch { probe.error = "SSH introuvable."; probe.lastExit = Date() }
    }

    // Appelé sous verrou.
    private func parse(_ frame: String, into probe: Probe) {
        // Sections séparées par une ligne « @ » (une section peut être vide).
        var parts = [""]
        for line in frame.split(separator: "\n", omittingEmptySubsequences: false) {
            if line == "@" { parts.append("") } else { parts[parts.count - 1] += (parts[parts.count - 1].isEmpty ? "" : "\n") + line }
        }
        parts = parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard parts.count >= 6 else { return }
        let words = { (s: Substring) in s.split(whereSeparator: { $0 == " " || $0 == "\t" }) }
        guard parts[0].hasPrefix("cpu") else { probe.error = "Le monitoring en direct lit /proc : il demande un serveur Linux."; return }
        let now = Date()
        var s: [String: Any] = ["t": (now.timeIntervalSince1970 * 1000).rounded()]

        // Processeur : part du temps non inactif depuis la mesure précédente.
        let cpu = words(Substring(parts[0])).dropFirst().prefix(8).map { Double($0) ?? 0 }
        if cpu.count >= 5 {
            let total = cpu.reduce(0, +), idle = cpu[3] + cpu[4]
            if let prev = probe.prevCPU, total > prev.total { s["cpu"] = max(0, min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100)) }
            probe.prevCPU = (total, idle)
        }
        // Charge : 1, 5, 15 minutes, puis « en cours/total » processus.
        let la = words(Substring(parts[1]))
        if la.count >= 4 { s["load"] = la.prefix(3).map { Double($0) ?? 0 }; probe.tasks = String(la[3]) }
        // Mémoire (kB) : utilisée = totale − disponible.
        var mem: [String: Double] = [:]
        for line in parts[2].split(separator: "\n") { let w = words(line); if w.count >= 2 { mem[String(w[0].dropLast())] = Double(w[1]) } }
        if let total = mem["MemTotal"], let avail = mem["MemAvailable"], total > 0 {
            s["memUsed"] = ((total - avail) / 1024).rounded(); s["memTotal"] = (total / 1024).rounded()
            s["mem"] = (total - avail) / total * 100
        }
        if let st = mem["SwapTotal"], let sf = mem["SwapFree"], st > 0 { s["swap"] = (st - sf) / st * 100 }
        // Réseau : octets reçus et envoyés par seconde, toutes interfaces sauf lo.
        var rx = 0.0, tx = 0.0
        for line in parts[3].split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            if line[..<colon].trimmingCharacters(in: .whitespaces) == "lo" { continue }
            let w = words(line[line.index(after: colon)...])
            if w.count >= 9 { rx += Double(w[0]) ?? 0; tx += Double(w[8]) ?? 0 }
        }
        if let prev = probe.prevNet, rx >= prev.rx, tx >= prev.tx {
            let dt = max(0.5, now.timeIntervalSince(prev.at))
            s["rx"] = ((rx - prev.rx) / dt).rounded(); s["tx"] = ((tx - prev.tx) / dt).rounded()
        }
        probe.prevNet = (rx, tx, now)
        // Disque du dossier du projet (kB).
        let df = words(Substring(parts[4]))
        if df.count >= 5 {
            let pct = Double(df[4].replacingOccurrences(of: "%", with: "")) ?? 0
            s["disk"] = pct
            probe.disk = ["size": (Double(df[1]) ?? 0) * 1024, "used": (Double(df[2]) ?? 0) * 1024, "free": (Double(df[3]) ?? 0) * 1024, "pct": pct]
        }
        // Processus les plus gourmands.
        probe.procs = parts[5].split(separator: "\n").compactMap { line -> [String: Any]? in
            let w = words(line); guard w.count >= 4 else { return nil }
            return ["pid": Int(w[0]) ?? 0, "cpu": Double(w[1]) ?? 0, "mem": Double(w[2]) ?? 0, "name": String(w[3...].joined(separator: " ").prefix(60))]
        }
        probe.error = ""
        probe.samples.append(s)
        if probe.samples.count > Self.keep { probe.samples.removeFirst(probe.samples.count - Self.keep) }
    }
}
#endif
