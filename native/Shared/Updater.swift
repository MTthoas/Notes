// Mise à jour de l'app Mac depuis les Releases GitHub du dépôt (Mac uniquement).
//
// La version web se met à jour seule ; l'app, elle, embarque ses fichiers : il lui faut un nouveau paquet.
// Studio lit la dernière Release publiée par la CI et, seulement à la demande de l'utilisateur, télécharge
// Studio-macOS.zip, vérifie le paquet, remplace l'app en place et la relance.
//
// Garde-fous : adresses fixes (ce dépôt, en HTTPS, redirections limitées à GitHub), rien n'est installé sans clic ;
// le paquet doit porter le même identifiant que l'app en cours et une signature intacte ; l'app actuelle n'est
// remplacée qu'une fois le nouveau paquet prêt (en cas d'échec avant cela, rien n'a changé).
import Foundation
#if os(macOS)
import AppKit

final class Updater {
    static let shared = Updater()

    private static let latestURL = URL(string: "https://api.github.com/repos/MTthoas/Studio/releases/latest")!
    private static let assetPrefix = "https://github.com/MTthoas/Studio/releases/download/"
    private static let assetName = "Studio-macOS.zip"

    private struct Release { let tag: String; let commit: String; let published: Date; let asset: URL; let notes: String; let page: String }
    private let queue = DispatchQueue(label: "studio.updater")
    private var latest: Release?
    private var checkedAt = Date.distantPast
    private var installing = false

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

    // MARK: Recherche

    private func state(_ r: Release?) -> [String: Any] {
        var out: [String: Any] = ["ok": true, "current": version, "commit": String(commit.prefix(7)), "available": false]
        guard let r else { return out }
        // Plus récente que cette app : construite depuis un autre commit, et publiée après ce build
        // (une app reconstruite en local depuis des sources plus récentes n'est donc pas « en retard »).
        out["available"] = r.commit != commit && r.published > built
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

    // MARK: Installation

    /// Télécharge la dernière version, la vérifie, remplace l'app et la relance. Toujours à la demande de l'utilisateur.
    func install(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if self.installing { return done(["ok": false, "message": "Une mise à jour est déjà en cours."]) }
            guard let rel = self.latest else { return done(["ok": false, "message": "Cherche d'abord une mise à jour."]) }
            self.installing = true
            func fail(_ m: String) { self.installing = false; done(["ok": false, "message": m]) }

            let fm = FileManager.default, app = Bundle.main.bundleURL.standardizedFileURL
            guard app.pathExtension == "app", !app.path.contains("/AppTranslocation/"), fm.isWritableFile(atPath: app.deletingLastPathComponent().path) else {
                return fail("Studio ne peut pas se remplacer à cet endroit : place l'app dans le dossier Applications, puis réessaie.")
            }
            // Dossier temporaire sur le même volume que l'app, pour un remplacement direct.
            guard let tmp = try? fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true) else {
                return fail("Impossible de préparer la mise à jour.")
            }
            defer { try? fm.removeItem(at: tmp) }

            let dl = self.get(rel.asset, accept: "application/octet-stream", timeout: 180)
            guard dl.code == 200, let data = dl.data, data.count > 10_000, data.count < 200_000_000 else {
                return fail(dl.code == 0 ? "Téléchargement impossible : vérifie ta connexion." : "Téléchargement de la mise à jour impossible (réponse \(dl.code)).")
            }
            let zip = tmp.appendingPathComponent("Studio.zip"), out = tmp.appendingPathComponent("new", isDirectory: true)
            guard (try? data.write(to: zip)) != nil, Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path]) == 0 else {
                return fail("Le paquet téléchargé est illisible : rien n'a été changé.")
            }
            let fresh = out.appendingPathComponent("Studio.app", isDirectory: true)
            guard let info = NSDictionary(contentsOf: fresh.appendingPathComponent("Contents/Info.plist")),
                  let bid = info["CFBundleIdentifier"] as? String, bid == Bundle.main.bundleIdentifier,
                  Self.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", fresh.path]) == 0 else {
                return fail("Le paquet téléchargé n'est pas une app Studio intacte : rien n'a été changé.")
            }
            do { _ = try fm.replaceItemAt(app, withItemAt: fresh) }
            catch { return fail("Remplacement de l'app impossible : \(error.localizedDescription)") }

            // Relance : un petit script attend la fin de cette instance, puis rouvre l'app.
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$2\"", "sh",
                           String(ProcessInfo.processInfo.processIdentifier), app.path]
            p.standardInput = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            let relaunch = (try? p.run()) != nil
            self.installing = false
            self.checkedAt = .distantPast
            done(["ok": true, "restarting": relaunch, "tag": rel.tag])
            if relaunch { DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.terminate(nil) } }
        }
    }
}
#endif
