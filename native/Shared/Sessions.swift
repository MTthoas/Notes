// Sessions Claude Code d'un projet (Mac uniquement), lues en local depuis ~/.claude/projects/.
// Lecture seule et incrémentale : seules les lignes ajoutées depuis la dernière lecture sont analysées.
// N'est accessible que pour le dossier choisi pour un projet (jamais un chemin fourni par la page).
import Foundation
#if os(macOS)

final class ClaudeSessions {
    static let shared = ClaudeSessions()

    struct Action { let at: String; let kind: String; let text: String }
    final class State {
        var offset: UInt64 = 0
        var title = ""; var branch = ""; var started = ""; var updated = ""; var lastPrompt = ""
        var models = Set<String>(); var seen = Set<String>()
        var tokIn = 0, tokOut = 0, tokCacheRead = 0, tokCacheWrite = 0, prompts = 0
        var tools: [String: Int] = [:]; var files: [String] = []
        var actions: [Action] = []
        var quota: [String: Any]?
        var cwd = ""
        /// Tokens écrits par jour (AAAA-MM-JJ), pour les graphiques du projet.
        var daily: [String: Int] = [:]
    }
    private var states: [String: State] = [:]
    private let queue = DispatchQueue(label: "studio.sessions")

    /// Dossiers des sessions de Claude Code pour un dossier de projet : le dossier lui-même
    /// et ses copies isolées (worktrees créés par Claude Code dans .claude/worktrees/).
    private func dirs(for project: String) -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects", isDirectory: true)
        let encoded = String(project.map { $0.isLetter || $0.isNumber ? $0 : "-" })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: home.path)) ?? []
        return names.filter { $0 == encoded || $0.hasPrefix(encoded + "--claude-worktrees-") }
            .map { home.appendingPathComponent($0, isDirectory: true) }
    }
    private func files(for project: String, maxAge: TimeInterval? = nil) -> [URL] {
        let limit = maxAge.map { Date().addingTimeInterval(-$0) } ?? .distantPast
        return dirs(for: project).flatMap { (try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] }
            .filter { $0.pathExtension == "jsonl" && self.mtime($0) > limit }
            .sorted { self.mtime($0) > self.mtime($1) }
    }
    private func mtime(_ u: URL) -> Date { (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
    private func file(_ project: String, _ session: String) -> URL? {
        guard !session.isEmpty, session.count <= 64, session.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return dirs(for: project).map { $0.appendingPathComponent(session + ".jsonl") }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

    private func ingest(_ e: [String: Any], into st: State) {
        let ts = e["timestamp"] as? String ?? ""
        if !ts.isEmpty { if st.started.isEmpty { st.started = ts }; st.updated = ts }
        if let b = e["gitBranch"] as? String, !b.isEmpty { st.branch = b }
        if let q = e["quotaLimits"] as? [String: Any] { st.quota = q }
        if st.cwd.isEmpty, let c = e["cwd"] as? String { st.cwd = c }
        switch e["type"] as? String ?? "" {
        case "ai-title": if let t = e["aiTitle"] as? String { st.title = t }
        case "user":
            guard (e["isMeta"] as? Bool) != true, let m = e["message"] as? [String: Any], let c = m["content"] as? String else { return }
            let text = c.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, !text.hasPrefix("<") else { return }
            st.prompts += 1; st.lastPrompt = clip(text, 300)
            push(st, Action(at: ts, kind: "prompt", text: clip(text, 4000)))
        case "assistant":
            guard let m = e["message"] as? [String: Any] else { return }
            let id = m["id"] as? String ?? UUID().uuidString
            if let model = m["model"] as? String, !model.hasPrefix("<") { st.models.insert(model) }
            if !st.seen.contains(id), let u = m["usage"] as? [String: Any] {
                st.seen.insert(id)
                st.tokIn += u["input_tokens"] as? Int ?? 0; st.tokOut += u["output_tokens"] as? Int ?? 0
                st.tokCacheRead += u["cache_read_input_tokens"] as? Int ?? 0; st.tokCacheWrite += u["cache_creation_input_tokens"] as? Int ?? 0
                if ts.count >= 10 { st.daily[String(ts.prefix(10)), default: 0] += u["output_tokens"] as? Int ?? 0 }
            }
            for b in m["content"] as? [[String: Any]] ?? [] {
                if b["type"] as? String == "text", let t = b["text"] as? String, !t.isEmpty { push(st, Action(at: ts, kind: "text", text: clip(t, 16000))) }
                if b["type"] as? String == "tool_use", let name = b["name"] as? String {
                    st.tools[name, default: 0] += 1
                    let input = b["input"] as? [String: Any] ?? [:]
                    let path = input["file_path"] as? String ?? input["path"] as? String ?? ""
                    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(name), !path.isEmpty {
                        st.files.removeAll { $0 == path }; st.files.insert(path, at: 0); if st.files.count > 40 { st.files.removeLast() }
                    }
                    let detail = path.isEmpty ? (input["description"] as? String ?? input["command"] as? String ?? input["pattern"] as? String ?? "") : path
                    push(st, Action(at: ts, kind: "tool:" + name, text: clip(detail, 240)))
                }
            }
        default: break
        }
    }
    private func push(_ st: State, _ a: Action) { st.actions.append(a); if st.actions.count > 120 { st.actions.removeFirst(st.actions.count - 120) } }

    /// Met à jour l'état d'une session en lisant seulement la fin ajoutée du fichier.
    private func refresh(_ url: URL) -> State? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let st = states[url.path] ?? State()
        let size = (try? h.seekToEnd()) ?? 0
        if size < st.offset { states[url.path] = State(); return refresh(url) } // fichier réécrit : on repart de zéro
        if size == st.offset { states[url.path] = st; return st }
        try? h.seek(toOffset: st.offset)
        let data = h.readDataToEndOfFile()
        guard let lastNL = data.lastIndex(of: 0x0A) else { states[url.path] = st; return st } // ligne incomplète : on attend
        let chunk = data[data.startIndex...lastNL]
        for line in chunk.split(separator: 0x0A) {
            if let e = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] { ingest(e, into: st) }
        }
        st.offset += UInt64(chunk.count)
        states[url.path] = st
        return st
    }

    private func summary(_ url: URL, _ st: State) -> [String: Any] {
        let mtime = self.mtime(url)
        let worktree = st.cwd.range(of: "/.claude/worktrees/").map { String(st.cwd[$0.upperBound...]) } ?? ""
        return ["id": url.deletingPathExtension().lastPathComponent, "worktree": worktree, "title": st.title.isEmpty ? (st.lastPrompt.isEmpty ? "Session" : clip(st.lastPrompt, 80)) : st.title,
                "branch": st.branch, "started": st.started, "updated": st.updated, "live": Date().timeIntervalSince(mtime) < 45,
                "models": Array(st.models).sorted(), "prompts": st.prompts, "lastPrompt": st.lastPrompt,
                "tokens": ["input": st.tokIn, "output": st.tokOut, "cacheRead": st.tokCacheRead, "cacheWrite": st.tokCacheWrite],
                "tools": st.tools, "files": Array(st.files.prefix(15))]
    }

    /// Sessions du dossier, les plus récentes d'abord, et l'état de la limite d'utilisation de Claude Code.
    func list(project folder: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            let files = self.files(for: folder).prefix(25)
            if files.isEmpty { return done(["ok": true, "sessions": [], "found": false]) }
            var out: [[String: Any]] = [], quota: [String: Any]? = nil
            // L'état de la limite n'est écrit que lorsqu'elle est atteinte : on ignore celui dont l'heure de réinitialisation est passée.
            let now = Date().timeIntervalSince1970
            for f in files {
                guard let st = self.refresh(f) else { continue }
                out.append(self.summary(f, st))
                if quota == nil, let q = st.quota, ((q["resetsAt"] as? Double) ?? (q["resetsAt"] as? Int).map(Double.init) ?? 0) > now { quota = q }
            }
            done(["ok": true, "found": true, "sessions": out, "quota": quota ?? NSNull()])
        }
    }

    /// Fil d'une session : ses dernières actions (prompts, réponses, outils).
    func detail(project folder: String, session: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let f = self.file(folder, session), let st = self.refresh(f) else { return done(["ok": false, "message": "Session introuvable."]) }
            var r = self.summary(f, st)
            r["ok"] = true
            r["actions"] = st.actions.suffix(80).map { ["at": $0.at, "kind": $0.kind, "text": $0.text] }
            done(r)
        }
    }

    /// Tokens écrits par jour sur les `days` derniers jours, toutes sessions du projet confondues.
    func daily(project folder: String, days: Int, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            var sum: [String: Int] = [:], sessions: [String: Int] = [:]
            for f in self.files(for: folder, maxAge: TimeInterval(days + 1) * 86400) {
                guard let st = self.refresh(f) else { continue }
                for (d, n) in st.daily { sum[d, default: 0] += n }
                if let d = st.started.split(separator: "T").first { sessions[String(d), default: 0] += 1 }
            }
            done(["ok": true, "tokens": sum, "sessions": sessions])
        }
    }

    /// Dernière session ouverte dans une copie isolée (pour y relancer l'agent qui l'a écrite).
    func latest(project folder: String, worktree name: String) -> String? {
        queue.sync {
            let suffix = "/.claude/worktrees/" + name
            for f in self.files(for: folder) {
                guard let st = self.refresh(f), st.cwd.hasSuffix(suffix) else { continue }
                return f.deletingPathExtension().lastPathComponent
            }
            return nil
        }
    }

    /// Dossier de travail d'une session (pour la reprendre au même endroit), s'il appartient bien au projet.
    func cwd(project folder: String, session: String) -> String? {
        queue.sync {
            guard let f = self.file(folder, session), let st = self.refresh(f), !st.cwd.isEmpty else { return nil }
            let real = URL(fileURLWithPath: st.cwd).standardizedFileURL.path
            return real == folder || real.hasPrefix(folder + "/.claude/worktrees/") ? real : nil
        }
    }
}
#endif
