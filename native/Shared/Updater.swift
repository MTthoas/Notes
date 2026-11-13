// Mise à jour de l'app Mac depuis les Releases GitHub du dépôt (Mac uniquement).
//
// La version web se met à jour seule ; l'app, elle, embarque ses fichiers : il lui faut un nouveau paquet.
// Studio lit la dernière Release publiée par la CI, puis :
//   - « download » télécharge Studio-macOS.zip en arrière-plan, le vérifie et le garde prêt ;
//   - « install » remplace l'app par le paquet prêt (ou le prépare d'abord) et la relance ;
//   - à la fermeture de l'app, un paquet prêt est installé sans rien demander (voir applyOnQuit).
// La page ne demande « download » que si l'installation automatique est activée dans les réglages.
//
// Garde-fous : adresses fixes (ce dépôt, en HTTPS, redirections limitées à GitHub) ; le paquet doit porter
// le même identifiant que l'app en cours et une signature intacte ; l'app actuelle n'est remplacée
// qu'une fois le nouveau paquet prêt (en cas d'échec avant cela, rien n'a changé).
import Foundation
#if os(macOS)
import AppKit

final class Updater {
    static let shared = Updater()

    private static let latestURL = URL(string: "https://api.github.com/repos/MTthoas/Studio/releases/latest")!
    private static let assetPrefix = "https://github.com/MTthoas/Studio/releases/download/"
    private static let assetName = "Studio-macOS.zip"

    private struct Release { let tag: String; let commit: String; let published: Date; let asset: URL; let notes: String; let page: String }
    /// Paquet téléchargé et vérifié, prêt à remplacer l'app. `tmp` est son dossier temporaire, à supprimer ensuite.
    private struct Staged { let tag: String; let app: URL; let tmp: URL }
    private enum Prepared { case ready(Staged); case failed(String) }

    private let queue = DispatchQueue(label: "studio.updater")
    private var latest: Release?
    private var checkedAt = Date.distantPast
    private var replaced = false // l'app a été remplacée : elle se relance
    // Le paquet prêt est lu depuis la file de l'updater et, à la fermeture, depuis le fil principal.
    private let lock = NSLock()
    private var staged: Staged?

    // Inscrits dans Info.plist à la construction (voir build-mac.sh) : le commit et l'heure du build.
    private var commit: String { Bundle.main.object(forInfoDictionaryKey: "StudioCommit") as? String ?? "" }
    private var built: Date { Date(timeIntervalSince1970: TimeInterval(Bundle.main.object(forInfoDictionaryKey: "StudioBuilt") as? String ?? "") ?? 0) }
    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    // MARK: Réseau

    /// Ne suit une redirection que vers GitHub, en HTTPS (les fichiers des Releases sont servis par githubusercontent.com).
    private final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            let host = request.url?.host?.lowercased() ?? ""
            let ok = request.url?.scheme == "https" && (host == "github.com" || host.hasSuffix(".github.com") || host.hasSuffix(".githubusercontent.com"))
            completionHandler(ok ? request : nil)
        }
    }
    private final class Box { var data: Data?; var code = 0 }

    private func get(_ url: URL, accept: String, timeout: TimeInterval) -> (data: Data?, code: Int) {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "GET"
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("Studio-Updater", forHTTPHeaderField: "User-Agent")
        let session = URLSession(configuration: .ephemeral, delegate: Redirects(), delegateQueue: nil)
        let box = Box(), sem = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { d, r, _ in box.data = d; box.code = (r as? HTTPURLResponse)?.statusCode ?? 0; sem.signal() }.resume()
        sem.wait()
        session.finishTasksAndInvalidate()
        return (box.data, box.code)
    }

    private static func run(_ tool: String, _ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }

    // MARK: Paquet prêt

    private func stagedTag() -> String? { lock.lock(); defer { lock.unlock() }; return staged?.tag }
    private func setStaged(_ s: Staged) { lock.lock(); staged = s; lock.unlock() }
    /// Retire le paquet prêt et le rend : un seul appelant peut ainsi l'installer.
    private func takeStaged() -> Staged? { lock.lock(); defer { lock.unlock() }; let s = staged; staged = nil; return s }
    private func dropStaged() { if let s = takeStaged() { try? FileManager.default.removeItem(at: s.tmp) } }

    // MARK: Recherche

    /// Version de l'app en cours, sans rien demander au réseau.
    func info() -> [String: Any] { ["ok": true, "current": version, "commit": String(commit.prefix(7))] }

    private func state(_ r: Release?) -> [String: Any] {
        var out: [String: Any] = ["ok": true, "current": version, "commit": String(commit.prefix(7)), "available": false, "staged": false]
        guard let r else { return out }
        // Plus récente que cette app : construite depuis un autre commit, et publiée après ce build
        // (une app reconstruite en local depuis des sources plus récentes n'est donc pas « en retard »).
        let available = r.commit != commit && r.published > built
        out["available"] = available
        out["staged"] = available && stagedTag() == r.tag
        out["tag"] = r.tag; out["notes"] = r.notes; out["page"] = r.page
        out["published"] = ISO8601DateFormatter().string(from: r.published)
        return out
    }

    /// Dernière version publiée, et si elle est plus récente que cette app. Gardée 5 minutes en mémoire.
    func check(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if Date().timeIntervalSince(self.checkedAt) < 300 { return done(self.state(self.latest)) }
            let r = self.get(Self.latestURL, accept: "application/vnd.github+json", timeout: 15)
            if r.code == 404 { self.latest = nil; self.checkedAt = Date(); return done(self.state(nil)) } // aucune version publiée
            guard r.code == 200, let d = r.data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                var s = self.state(nil)
                s["ok"] = false
                s["message"] = r.code == 0 ? "Impossible de joindre GitHub pour chercher une mise à jour."
                    : r.code == 403 || r.code == 429 ? "GitHub limite les demandes pour l'instant : réessaie dans quelques minutes."
                    : "GitHub n'a pas donné la dernière version (réponse \(r.code))."
                return done(s)
            }
            self.checkedAt = Date()
            let assets = j["assets"] as? [[String: Any]] ?? []
            guard let tag = j["tag_name"] as? String,
                  let asset = assets.first(where: { $0["name"] as? String == Self.assetName }),
                  let link = asset["browser_download_url"] as? String, link.hasPrefix(Self.assetPrefix), let url = URL(string: link) else {
                self.latest = nil
                return done(self.state(nil)) // version sans paquet pour Mac
            }
            let published = (j["published_at"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) } ?? .distantPast
            let rel = Release(tag: String(tag.prefix(40)), commit: j["target_commitish"] as? String ?? "", published: published, asset: url,
                              notes: String((j["body"] as? String ?? "").prefix(4000)), page: j["html_url"] as? String ?? "")
            self.latest = rel
            done(self.state(rel))
        }
    }

    // MARK: Téléchargement

    /// Télécharge le paquet d'une version et le vérifie. Ne touche pas à l'app en cours.
    private func prepare(_ rel: Release) -> Prepared {
        let fm = FileManager.default, app = Bundle.main.bundleURL.standardizedFileURL
        guard app.pathExtension == "app", !app.path.contains("/AppTranslocation/"), fm.isWritableFile(atPath: app.deletingLastPathComponent().path) else {
            return .failed("Studio ne peut pas se remplacer à cet endroit : place l'app dans le dossier Applications, puis réessaie.")
        }
        // Dossier temporaire sur le même volume que l'app, pour un remplacement direct.
        guard let tmp = try? fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true) else {
            return .failed("Impossible de préparer la mise à jour.")
        }
        var keep = false
        defer { if !keep { try? fm.removeItem(at: tmp) } }

        let dl = get(rel.asset, accept: "application/octet-stream", timeout: 180)
        guard dl.code == 200, let data = dl.data, data.count > 10_000, data.count < 200_000_000 else {
            return .failed(dl.code == 0 ? "Téléchargement impossible : vérifie ta connexion." : "Téléchargement de la mise à jour impossible (réponse \(dl.code)).")
        }
        let zip = tmp.appendingPathComponent("Studio.zip"), out = tmp.appendingPathComponent("new", isDirectory: true)
        guard (try? data.write(to: zip)) != nil, Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path]) == 0 else {
            return .failed("Le paquet téléchargé est illisible : rien n'a été changé.")
        }
        try? fm.removeItem(at: zip)
        let fresh = out.appendingPathComponent("Studio.app", isDirectory: true)
        guard let info = NSDictionary(contentsOf: fresh.appendingPathComponent("Contents/Info.plist")),
              let bid = info["CFBundleIdentifier"] as? String, bid == Bundle.main.bundleIdentifier,
              Self.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", fresh.path]) == 0 else {
            return .failed("Le paquet téléchargé n'est pas une app Studio intacte : rien n'a été changé.")
        }
        keep = true
        return .ready(Staged(tag: rel.tag, app: fresh, tmp: tmp))
    }

    /// Remplace l'app en cours par le paquet prêt. Rend un message en cas d'échec.
    private func swap(_ s: Staged) -> String? {
        let fm = FileManager.default
        defer { try? fm.removeItem(at: s.tmp) }
        do { _ = try fm.replaceItemAt(Bundle.main.bundleURL.standardizedFileURL, withItemAt: s.app); return nil }
        catch { return error.localizedDescription }
    }

    /// Télécharge et vérifie la dernière version en arrière-plan : elle sera installée à la relance ou à la fermeture.
    func download(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if self.replaced { return done(["ok": true, "staged": true]) }
            guard let rel = self.latest else { return done(["ok": false, "message": "Cherche d'abord une mise à jour."]) }
            if self.stagedTag() == rel.tag { return done(["ok": true, "staged": true, "tag": rel.tag]) }
            self.dropStaged() // une version plus ancienne attendait encore
            switch self.prepare(rel) {
            case .failed(let m): done(["ok": false, "message": m])
            case .ready(let s): self.setStaged(s); done(["ok": true, "staged": true, "tag": rel.tag])
            }
        }
    }

    /// Oublie le paquet prêt (l'installation automatique vient d'être désactivée).
    func discard(done: @escaping ([String: Any]) -> Void) {
        queue.async { self.dropStaged(); done(["ok": true]) }
    }

    // MARK: Installation

    /// Installe la dernière version (déjà prête, ou téléchargée ici), puis relance l'app.
    func install(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if self.replaced { return done(["ok": true, "restarting": true]) }
            guard let rel = self.latest else { return done(["ok": false, "message": "Cherche d'abord une mise à jour."]) }
            var ready = self.takeStaged()
            if let old = ready, old.tag != rel.tag { try? FileManager.default.removeItem(at: old.tmp); ready = nil }
            if ready == nil {
                switch self.prepare(rel) {
                case .failed(let m): return done(["ok": false, "message": m])
                case .ready(let s): ready = s
                }
            }
            guard let pack = ready else { return done(["ok": false, "message": "Impossible de préparer la mise à jour."]) }
            if let err = self.swap(pack) { return done(["ok": false, "message": "Remplacement de l'app impossible : \(err)"]) }
            self.replaced = true

            // Relance : un petit script attend la fin de cette instance, puis rouvre l'app.
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$2\"", "sh",
                           String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.standardizedFileURL.path]
            p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            let relaunch = (try? p.run()) != nil
            self.checkedAt = .distantPast
            done(["ok": true, "restarting": relaunch, "tag": pack.tag])
            if relaunch { DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.terminate(nil) } }
        }
    }

    /// À la fermeture de l'app : installe le paquet prêt, sans relancer. Appelé depuis le fil principal ;
    /// ne passe pas par la file de l'updater, qui peut être occupée par un téléchargement.
    func applyOnQuit() {
        guard let s = takeStaged() else { return }
        _ = swap(s)
    }
}
#endif
