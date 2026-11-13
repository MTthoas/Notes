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
    }
    private var states: [String: State] = [:]
    private let queue = DispatchQueue(label: "studio.sessions")

    /// Dossier des sessions de Claude Code pour un dossier de projet.
    private func dir(for project: String) -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects", isDirectory: true)
        let encoded = String(project.map { $0.isLetter || $0.isNumber ? $0 : "-" })
        let direct = home.appendingPathComponent(encoded, isDirectory: true)
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        return nil
    }

    private func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) + "…" : s }

    private func ingest(_ e: [String: Any], into st: State) {
        let ts = e["timestamp"] as? String ?? ""
        if !ts.isEmpty { if st.started.isEmpty { st.started = ts }; st.updated = ts }
        if let b = e["gitBranch"] as? String, !b.isEmpty { st.branch = b }
        if let q = e["quotaLimits"] as? [String: Any] { st.quota = q }
        switch e["type"] as? String ?? "" {
        case "ai-title": if let t = e["aiTitle"] as? String { st.title = t }
        case "user":
            guard (e["isMeta"] as? Bool) != true, let m = e["message"] as? [String: Any], let c = m["content"] as? String else { return }
            let text = c.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, !text.hasPrefix("<") else { return }
            st.prompts += 1; st.lastPrompt = clip(text, 300)
            push(st, Action(at: ts, kind: "prompt", text: clip(text, 400)))
        case "assistant":
            guard let m = e["message"] as? [String: Any] else { return }
            let id = m["id"] as? String ?? UUID().uuidString
            if let model = m["model"] as? String, !model.hasPrefix("<") { st.models.insert(model) }
            if !st.seen.contains(id), let u = m["usage"] as? [String: Any] {
                st.seen.insert(id)
                st.tokIn += u["input_tokens"] as? Int ?? 0; st.tokOut += u["output_tokens"] as? Int ?? 0
                st.tokCacheRead += u["cache_read_input_tokens"] as? Int ?? 0; st.tokCacheWrite += u["cache_creation_input_tokens"] as? Int ?? 0
            }
            for b in m["content"] as? [[String: Any]] ?? [] {
                if b["type"] as? String == "text", let t = b["text"] as? String, !t.isEmpty { push(st, Action(at: ts, kind: "text", text: clip(t, 400))) }
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
        let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return ["id": url.deletingPathExtension().lastPathComponent, "title": st.title.isEmpty ? (st.lastPrompt.isEmpty ? "Session" : clip(st.lastPrompt, 80)) : st.title,
                "branch": st.branch, "started": st.started, "updated": st.updated, "live": Date().timeIntervalSince(mtime) < 45,
                "models": Array(st.models).sorted(), "prompts": st.prompts, "lastPrompt": st.lastPrompt,
                "tokens": ["input": st.tokIn, "output": st.tokOut, "cacheRead": st.tokCacheRead, "cacheWrite": st.tokCacheWrite],
                "tools": st.tools, "files": Array(st.files.prefix(15))]
    }

    /// Sessions du dossier, les plus récentes d'abord, et l'état de la limite d'utilisation de Claude Code.
    func list(project folder: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let d = self.dir(for: folder) else { return done(["ok": true, "sessions": [], "found": false]) }
            let files = ((try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
                .filter { $0.pathExtension == "jsonl" }
                .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
                .prefix(20)
            var out: [[String: Any]] = [], quota: [String: Any]? = nil
            for f in files { if let st = self.refresh(f) { out.append(self.summary(f, st)); if quota == nil { quota = st.quota } } }
            done(["ok": true, "found": true, "sessions": out, "quota": quota ?? NSNull()])
        }
    }

    /// Fil d'une session : ses dernières actions (prompts, réponses, outils).
    func detail(project folder: String, session: String, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard session.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }), let d = self.dir(for: folder) else { return done(["ok": false, "message": "Session introuvable."]) }
            let f = d.appendingPathComponent(session + ".jsonl")
            guard let st = self.refresh(f) else { return done(["ok": false, "message": "Session introuvable."]) }
            var r = self.summary(f, st)
            r["ok"] = true
            r["actions"] = st.actions.suffix(80).map { ["at": $0.at, "kind": $0.kind, "text": $0.text] }
            done(r)
        }
    }
}
#endif
