// Utilisation de l'abonnement Claude sur ce Mac (Mac uniquement).
//
// Deux sources, toutes deux en lecture seule :
// - les journaux locaux de Claude Code (~/.claude/projects/…) : tokens consommés sur les 5 dernières heures,
//   aujourd'hui et sur 7 jours, tous projets confondus. Rien ne quitte la machine ;
// - les limites de l'abonnement (session de 5 heures, semaine), telles que les affiche « /usage » dans Claude Code.
//   Anthropic ne les donne qu'au compte connecté : Studio lit alors le jeton de connexion de Claude Code dans le
//   trousseau et interroge api.anthropic.com. Désactivé par défaut, à activer explicitement dans les réglages.
//
// Garde-fous pour les limites : le jeton ne sort jamais de ce fichier (ni vers la page, ni sur le disque, ni dans
// un journal), il ne part que vers l'adresse fixe ci-dessous, en GET, sans suivre de redirection ; il n'est jamais
// renouvelé ici (c'est le rôle de Claude Code) ; un refus du trousseau n'est pas redemandé sans action de l'utilisateur.
import Foundation
import Security
#if os(macOS)

final class ClaudeUsage {
    static let shared = ClaudeUsage()

    // MARK: Dates

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static func date(_ s: String) -> Date? {
        if let d = isoFrac.date(from: s) ?? iso.date(from: s) { return d }
        // Fraction de seconde plus longue que prévu : on la retire.
        return iso.date(from: s.replacingOccurrences(of: "\\.\\d+", with: "", options: .regularExpression))
    }

    // MARK: Tokens consommés (journaux locaux)

    private struct Entry { let id: String; let at: TimeInterval; let model: String; let input: Int; let output: Int; let cacheRead: Int; let cacheWrite: Int }
    private struct Sum {
        var input = 0, output = 0, cacheRead = 0, cacheWrite = 0, calls = 0
        mutating func add(_ e: Entry) { input += e.input; output += e.output; cacheRead += e.cacheRead; cacheWrite += e.cacheWrite; calls += 1 }
        var json: [String: Any] { ["input": input, "output": output, "cacheRead": cacheRead, "cacheWrite": cacheWrite, "calls": calls] }
    }
    private final class FileState { var offset: UInt64 = 0; var entries: [Entry] = []; var index: [String: Int] = [:] }

    private var states: [String: FileState] = [:]
    private var cached: (at: Date, value: [String: Any])?
    private let queue = DispatchQueue(label: "studio.claude-usage")
    private static let keep: TimeInterval = 8 * 86400
    private static let needle = Data("\"usage\"".utf8)

    /// Journaux de session modifiés depuis `limit`, tous projets confondus.
    private func journals(since limit: Date) -> [URL] {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects", isDirectory: true)
        guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) else { return [] }
        var out: [URL] = []
        for case let u as URL in walk where u.pathExtension == "jsonl" {
            let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if m > limit { out.append(u) }
        }
        return out
    }

    /// Lit seulement la fin ajoutée du fichier depuis la dernière lecture.
    private func read(_ url: URL, since limit: TimeInterval) -> FileState? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        var st = states[url.path] ?? FileState()
        let size = (try? h.seekToEnd()) ?? 0
        if size < st.offset { st = FileState() } // fichier réécrit : on repart de zéro
        states[url.path] = st
        guard size > st.offset else { return st }
        try? h.seek(toOffset: st.offset)
        let data = h.readDataToEndOfFile()
        guard let lastNL = data.lastIndex(of: 0x0A) else { return st } // ligne incomplète : on attend
        let chunk = data[data.startIndex...lastNL]
        for line in chunk.split(separator: 0x0A) where line.range(of: Self.needle) != nil {
            guard let e = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  e["type"] as? String == "assistant",
                  let m = e["message"] as? [String: Any], let u = m["usage"] as? [String: Any],
                  let ts = e["timestamp"] as? String, let at = Self.date(ts)?.timeIntervalSince1970, at >= limit else { continue }
            let model = m["model"] as? String ?? ""
            if model.isEmpty || model.hasPrefix("<") { continue }
            let mid = m["id"] as? String ?? "", rid = e["requestId"] as? String ?? ""
            let id = mid.isEmpty && rid.isEmpty ? UUID().uuidString : mid + ":" + rid
            let entry = Entry(id: id, at: at, model: model, input: u["input_tokens"] as? Int ?? 0, output: u["output_tokens"] as? Int ?? 0,
                              cacheRead: u["cache_read_input_tokens"] as? Int ?? 0, cacheWrite: u["cache_creation_input_tokens"] as? Int ?? 0)
            // Une même réponse est écrite sur plusieurs lignes (une par bloc) : on garde la plus complète.
            if let i = st.index[id] { if entry.output >= st.entries[i].output { st.entries[i] = entry } }
            else { st.index[id] = st.entries.count; st.entries.append(entry) }
        }
        st.offset += UInt64(chunk.count)
        return st
    }

    /// Tokens consommés par Claude Code sur ce Mac : 5 dernières heures, aujourd'hui, 7 jours, et par modèle sur 7 jours.
    func local(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if let c = self.cached, Date().timeIntervalSince(c.at) < 20 { return done(c.value) }
            let now = Date(), t = now.timeIntervalSince1970, limit = t - Self.keep
            var best: [String: Entry] = [:], alive = Set<String>()
            for f in self.journals(since: now.addingTimeInterval(-Self.keep)) {
                alive.insert(f.path)
                guard let st = self.read(f, since: limit) else { continue }
                // Une session reprise recopie son historique : chaque réponse n'est comptée qu'une fois.
                for e in st.entries { if let o = best[e.id], o.output >= e.output { continue }; best[e.id] = e }
            }
            self.states = self.states.filter { alive.contains($0.key) }
            let h5 = t - 5 * 3600, day = Calendar.current.startOfDay(for: now).timeIntervalSince1970, d7 = t - 7 * 86400
            var last5 = Sum(), today = Sum(), week = Sum(), models: [String: Sum] = [:]
            for e in best.values where e.at >= d7 {
                week.add(e); models[e.model, default: Sum()].add(e)
                if e.at >= day { today.add(e) }
                if e.at >= h5 { last5.add(e) }
            }
            let rows: [[String: Any]] = models.sorted { ($0.value.input + $0.value.output + $0.value.cacheWrite) > ($1.value.input + $1.value.output + $1.value.cacheWrite) }
                .prefix(8).map { var r = $0.value.json; r["model"] = $0.key; return r }
            let value: [String: Any] = ["ok": true, "local": ["h5": last5.json, "today": today.json, "d7": week.json, "models": rows]]
            self.cached = (at: now, value: value)
            done(value)
        }
    }

    // MARK: Limites de l'abonnement

    private static let enabledKey = "claude.limits.enabled"
    private static let endpoint = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    private let net = DispatchQueue(label: "studio.claude-limits")
    private var token: (value: String, expires: TimeInterval)?
    private var denied = false
    private var last: (at: Date, value: [String: Any])?
    private enum Failure: Error { case denied, missing, noSubscription }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private final class Box { var data: Data?; var code = 0 }

    /// Lecture de l'élément « Claude Code-credentials » par `/usr/bin/security`, et non par SecItemCopyMatching.
    /// Claude Code crée (et recrée à chaque renouvellement du jeton) cet élément avec cet outil, qui figure donc
    /// d'office dans ses autorisations : aucune demande de mot de passe. Lu directement par Studio, l'accord
    /// « Toujours autoriser » serait perdu à chaque reconstruction (signature ad hoc) et à chaque renouvellement.
    /// Renvoie nil si l'élément n'existe pas ; lève `denied` si le trousseau refuse ou ne répond pas.
    private func keychainItem() throws -> Data? {
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        p.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        // Trousseau verrouillé : macOS peut demander de le déverrouiller ; au-delà d'une minute, on abandonne.
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit(); killer.cancel()
        if p.terminationReason == .uncaughtSignal { throw Failure.denied }
        if p.terminationStatus == 44 { return nil } // errSecItemNotFound
        guard p.terminationStatus == 0 else { throw Failure.denied }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : Data(text.utf8)
    }

    /// Jeton de connexion de Claude Code (abonnement) : trousseau de macOS, sinon son fichier d'identifiants.
    private func credentials() throws -> (value: String, expires: TimeInterval) {
        var raw = try keychainItem()
        if raw == nil { raw = try? Data(contentsOf: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/.credentials.json")) }
        guard let raw, let j = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { throw Failure.missing }
        guard let o = j["claudeAiOauth"] as? [String: Any], let t = o["accessToken"] as? String, !t.isEmpty, t.utf8.count < 4096,
              t.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }) else { throw Failure.noSubscription }
        let ms = (o["expiresAt"] as? NSNumber)?.doubleValue ?? 0
        return (value: t, expires: ms > 0 ? ms / 1000 : Date().timeIntervalSince1970 + 3600)
    }

    private func fetch() -> [String: Any] {
        func fail(_ m: String) -> [String: Any] { ["ok": true, "enabled": true, "ready": false, "message": m] }
        let refused = "Accès au trousseau refusé : Studio n'a pas lu la connexion de Claude Code. Clique sur Actualiser pour réessayer."
        let expired = "La connexion de Claude Code a expiré : lance Claude Code une fois pour la renouveler, puis actualise."
        if denied { return fail(refused) }
        let now = Date().timeIntervalSince1970
        if (token?.expires ?? 0) <= now + 30 {
            do { token = try credentials() }
            catch Failure.denied { denied = true; return fail(refused) }
            catch Failure.noSubscription { return fail("Claude Code n'est pas connecté à un abonnement Claude sur ce Mac.") }
            catch { return fail("Connexion de Claude Code introuvable sur ce Mac.") }
        }
        guard let tk = token, tk.expires > now else { token = nil; return fail(expired) }

        var req = URLRequest(url: Self.endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        req.httpMethod = "GET"
        req.setValue("Bearer " + tk.value, forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        let box = Box(), sem = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { d, r, _ in box.data = d; box.code = (r as? HTTPURLResponse)?.statusCode ?? 0; sem.signal() }.resume()
        sem.wait()
        session.finishTasksAndInvalidate()

        if box.code == 401 || box.code == 403 { token = nil; return fail(expired) }
        if box.code == 0 { return fail("Impossible de joindre Anthropic pour lire les limites.") }
        guard box.code == 200, let d = box.data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            return fail("Anthropic n'a pas donné les limites (réponse \(box.code)).")
        }
        var windows: [[String: Any]] = []
        for key in ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] {
            guard let w = j[key] as? [String: Any], let pct = (w["utilization"] as? NSNumber)?.doubleValue else { continue }
            let reset = (w["resets_at"] as? String).flatMap(Self.date)
            // Les limites par modèle ne sont affichées que si elles sont entamées.
            if key.hasPrefix("seven_day_") && pct <= 0 && reset == nil { continue }
            var row: [String: Any] = ["key": key, "pct": max(0, min(100, pct))]
            if let reset { row["resetsAt"] = reset.timeIntervalSince1970 }
            windows.append(row)
        }
        if let x = j["extra_usage"] as? [String: Any], x["is_enabled"] as? Bool == true, let pct = (x["utilization"] as? NSNumber)?.doubleValue {
            windows.append(["key": "extra", "pct": max(0, min(100, pct))])
        }
        if windows.isEmpty { return fail("Réponse inattendue d'Anthropic : aucune limite lisible.") }
        return ["ok": true, "enabled": true, "ready": true, "windows": windows]
    }

    /// Limites de l'abonnement. `op` : "enable" (accord de l'utilisateur), "disable", "refresh" (sans cache), ou vide.
    func limits(op: String, done: @escaping ([String: Any]) -> Void) {
        net.async {
            let d = UserDefaults.standard
            if op == "enable" { d.set(true, forKey: Self.enabledKey); self.denied = false; self.last = nil }
            if op == "disable" { d.set(false, forKey: Self.enabledKey); self.token = nil; self.last = nil; self.denied = false }
            if op == "refresh" { self.denied = false; self.last = nil }
            guard d.bool(forKey: Self.enabledKey) else { return done(["ok": true, "enabled": false]) }
            if let l = self.last, Date().timeIntervalSince(l.at) < 60 { return done(l.value) }
            let r = self.fetch()
            if r["ready"] as? Bool == true { self.last = (at: Date(), value: r) }
            done(r)
        }
    }
}
#endif
