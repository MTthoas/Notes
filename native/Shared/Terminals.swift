// Terminal SSH intégré à l'app : /usr/bin/ssh tourne dans un pseudo-terminal (openpty) sur ce Mac, la page
// affiche et saisit (émulateur VT dans src/lib/vt.ts). Mêmes garde-fous que Servers.swift : hôte et chemin
// validés, BatchMode (clé uniquement, jamais de mot de passe demandé), aucune clé vue ni stockée par Studio.
//
// La sortie est poussée à la page par window.carnet.term({ term, data }) (base64, regroupée toutes les ~15 ms),
// puis { term, exit } à la fin. La page écrit par { op: "term-write", term, data } et redimensionne par "term-resize".
import Foundation
#if os(macOS)
import Darwin

final class Terminals {
    static let shared = Terminals()
    /// Envoi vers la page, branché par Shell.swift.
    var emit: (([String: Any]) -> Void)?

    private final class Session {
        let id: String, project: String
        let process = Process()
        var master: Int32 = -1
        var source: DispatchSourceRead?
        var pending = Data()
        var flushing = false
        init(id: String, project: String) { self.id = id; self.project = project }
    }
    private var sessions: [String: Session] = [:]
    private let q = DispatchQueue(label: "studio.terminals")
    private let maxSessions = 8

    /// Ouvre un shell sur le serveur du projet, dans son dossier.
    func open(_ pid: String, cols: Int, rows: Int) -> [String: Any] {
        guard let c = Servers.shared.config(pid) else { return ["ok": false, "message": "Aucun serveur configuré."] }
        return q.sync {
            guard sessions.count < maxSessions else { return ["ok": false, "message": "Trop de terminaux ouverts : ferme-en un."] }
            var ws = winsize(ws_row: UInt16(max(4, min(rows, 500))), ws_col: UInt16(max(10, min(cols, 500))), ws_xpixel: 0, ws_ypixel: 0)
            var master: Int32 = -1, slave: Int32 = -1
            guard openpty(&master, &slave, nil, nil, &ws) == 0 else { return ["ok": false, "message": "Pseudo-terminal indisponible."] }
            let id = UUID().uuidString.lowercased()
            let s = Session(id: id, project: pid)
            s.master = master
            let remote = "cd \(Servers.qPath(c.path)) 2>/dev/null; exec \"${SHELL:-/bin/sh}\" -l"
            s.process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            s.process.arguments = ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", c.host, "--", remote]
            var env = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"]
            if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] { env["SSH_AUTH_SOCK"] = sock }
            s.process.environment = env
            let fh = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
            s.process.standardInput = fh; s.process.standardOutput = fh; s.process.standardError = fh
            s.process.terminationHandler = { [weak self] p in
                self?.q.asyncAfter(deadline: .now() + 0.1) { self?.finish(id, status: p.terminationStatus) }
            }
            do { try s.process.run() } catch {
                close(master); close(slave)
                return ["ok": false, "message": "SSH introuvable."]
            }
            close(slave)
            let src = DispatchSource.makeReadSource(fileDescriptor: master, queue: q)
            src.setEventHandler { [weak self, weak s] in
                guard let self, let s else { return }
                var buf = [UInt8](repeating: 0, count: 65536)
                let n = read(s.master, &buf, buf.count)
                if n <= 0 { s.source?.cancel(); s.source = nil; return }
                s.pending.append(buf, count: n)
                self.schedule(s)
            }
            src.setCancelHandler { [weak s] in if let s, s.master >= 0 { close(s.master); s.master = -1 } }
            s.source = src
            src.resume()
            sessions[id] = s
            return ["ok": true, "term": id, "host": c.host, "path": c.path]
        }
    }

    private func schedule(_ s: Session) {
        guard !s.flushing else { return }
        s.flushing = true
        q.asyncAfter(deadline: .now() + 0.015) { [weak self] in self?.flush(s) }
    }
    private func flush(_ s: Session) {
        s.flushing = false
        guard !s.pending.isEmpty else { return }
        let chunk = s.pending; s.pending = Data()
        emit?(["term": s.id, "data": chunk.base64EncodedString()])
    }
    private func finish(_ id: String, status: Int32) {
        guard let s = sessions.removeValue(forKey: id) else { return }
        // Dernières lignes (message d'erreur de ssh) avant la fin.
        if s.master >= 0 {
            var buf = [UInt8](repeating: 0, count: 65536)
            let flags = fcntl(s.master, F_GETFL); _ = fcntl(s.master, F_SETFL, flags | O_NONBLOCK)
            while true { let n = read(s.master, &buf, buf.count); if n <= 0 { break }; s.pending.append(buf, count: n) }
        }
        flush(s)
        if let src = s.source { s.source = nil; src.cancel() } else if s.master >= 0 { close(s.master); s.master = -1 }
        emit?(["term": id, "exit": Int(status)])
    }

    // Noms choisis pour ne pas masquer read/write/close de Darwin dans cette classe.
    func input(_ id: String, _ text: String) -> [String: Any] {
        guard let s = q.sync(execute: { sessions[id] }), s.master >= 0 else { return ["ok": false, "message": "Terminal fermé."] }
        let bytes = Array(text.utf8.prefix(1_000_000))
        // Écriture sur sa propre file : la lecture (file q) continue pendant un long collage, sinon tout se bloquerait.
        wq.async {
            var off = 0
            while off < bytes.count {
                let fd = s.master; if fd < 0 { return }
                let n = bytes[off...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
                if n <= 0 { if errno == EAGAIN || errno == EINTR { usleep(2000); continue }; return }
                off += n
            }
        }
        return ["ok": true]
    }
    private let wq = DispatchQueue(label: "studio.terminals.write")

    func resize(_ id: String, cols: Int, rows: Int) -> [String: Any] {
        q.sync {
            guard let s = sessions[id], s.master >= 0 else { return ["ok": false] }
            var ws = winsize(ws_row: UInt16(max(4, min(rows, 500))), ws_col: UInt16(max(10, min(cols, 500))), ws_xpixel: 0, ws_ypixel: 0)
            _ = ioctl(s.master, TIOCSWINSZ, &ws)
            // ssh n'a pas ce pseudo-terminal pour terminal de contrôle : on le prévient nous-mêmes.
            if s.process.isRunning { kill(s.process.processIdentifier, SIGWINCH) }
            return ["ok": true]
        }
    }

    func stop(_ id: String) -> [String: Any] {
        q.sync { if let s = sessions[id], s.process.isRunning { s.process.terminate() } }
        return ["ok": true]
    }

    /// Terminaux encore ouverts (la page les retrouve après un rechargement).
    func list(_ pid: String) -> [String: Any] {
        q.sync { ["ok": true, "terms": sessions.values.filter { $0.project == pid }.map { $0.id }] }
    }
}
#endif
