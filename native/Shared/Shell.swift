// Studio — coquille native commune à macOS et iOS.
// L'application web est embarquée dans le paquet (dossier « web ») et servie par un schéma interne
// carnet://app : rien n'est téléchargé, aucun serveur, les données restent dans le conteneur de l'app.
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Sert les fichiers embarqués. Refuse tout chemin qui sortirait du dossier « web ».
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "woff2": "font/woff2", "json": "application/json",
        "webmanifest": "application/manifest+json",
    ]

    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didFinish()
            return
        }
        let mime = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

enum Shell {
    static let scheme = "carnet"
    static let start = URL(string: "carnet://app/index.html")!

    static func makeWebView(coordinator: ShellCoordinator, ephemeral: Bool = false) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        cfg.setURLSchemeHandler(AppSchemeHandler(root: root), forURLScheme: scheme)
        if ephemeral { cfg.websiteDataStore = .nonPersistent() }
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.userContentController.add(coordinator, name: "carnet")
        // Signale à la page qu'elle tourne dans l'app native (avant tout autre script).
        #if os(macOS)
        let platform = "mac"
        #else
        let platform = "ios"
        #endif
        cfg.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.native = '\(platform)';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: .zero, configuration: cfg)
        if #available(macOS 13.3, iOS 16.4, *) {
            web.isInspectable = ProcessInfo.processInfo.environment["CARNET_DEBUG"] != nil
        }
        coordinator.web = web
        web.navigationDelegate = coordinator
        web.uiDelegate = coordinator
        return web
    }
}

/// Liens, téléchargements, fichiers et messages de la page.
final class ShellCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    weak var web: WKWebView?
    var onTheme: ((Bool) -> Void)?
    var onLoad: (() -> Void)?
    private var pending: [WKDownload: URL] = [:]

    // Messages envoyés par la page : window.webkit.messageHandlers.carnet.postMessage({...})
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "theme", let dark = body["dark"] as? Bool { onTheme?(dark) }
        if type == "notify", let title = body["title"] as? String {
            Notifier.shared.post(title: String(title.prefix(200)), body: String((body["body"] as? String ?? "").prefix(500)), url: body["url"] as? String)
        }
        if type == "badge", let n = body["count"] as? Int { Notifier.shared.badge(max(0, n)) }
        if type == "bio", let action = body["action"] as? String, let id = body["id"] as? Int { biometric(action, id: id, body: body) }
        if type == "project", let action = body["action"] as? String, let id = body["id"] as? Int { project(action, id: id, body: body) }
        if type == "agent", let action = body["action"] as? String, let id = body["id"] as? Int { agent(action, id: id, body: body) }
        if type == "claude", let action = body["action"] as? String, let id = body["id"] as? Int { claude(action, id: id, body: body) }
        if type == "update", let action = body["action"] as? String, let id = body["id"] as? Int { update(action, id: id) }
        if type == "voice", let action = body["action"] as? String {
            Dictation.shared.send = { [weak self] payload in
                guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async { self?.web?.evaluateJavaScript("window.carnet && window.carnet.voice && window.carnet.voice(\(json))", completionHandler: nil) }
            }
            if action == "start" { Dictation.shared.start(locale: "fr-FR") } else { Dictation.shared.stop(cancel: action == "cancel") }
        }
    }

    // Réponse à la page : window.carnet.bio({ id, ok, ... })
    private func reply(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web?.evaluateJavaScript("window.carnet && window.carnet.bio && window.carnet.bio(\(json))", completionHandler: nil) }
    }

    // Réponse générique à une demande de la page : window.carnet.reply({ id, ok, ... })
    private func answer(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web?.evaluateJavaScript("window.carnet && window.carnet.reply && window.carnet.reply(\(json))", completionHandler: nil) }
    }

    private func project(_ action: String, id: Int, body: [String: Any]) {
        #if os(macOS)
        let folders = ProjectFolders.shared
        let pid = body["project"] as? String ?? ""
        switch action {
        case "pick":
            folders.pick(pid) { path in self.answer(["id": id, "ok": path != nil, "path": path ?? NSNull()]) }
        case "info":
            DispatchQueue.global(qos: .userInitiated).async { var r = folders.info(pid); r["id"] = id; self.answer(r) }
        case "open":
            do { try folders.open(pid, with: body["app"] as? String ?? "", worktree: body["worktree"] as? String); answer(["id": id, "ok": true]) }
            catch let e as ProjectFolders.Failure { answer(["id": id, "ok": false, "message": e.message]) }
            catch { answer(["id": id, "ok": false, "message": error.localizedDescription]) }
        case "forget":
            folders.forget(pid); answer(["id": id, "ok": true])
        case "diff":
            let scope = body["scope"] as? String ?? "working"
            let wt = body["worktree"] as? String
            DispatchQueue.global(qos: .userInitiated).async { var r = folders.diff(pid, scope: scope, worktree: wt); r["id"] = id; self.answer(r) }
        case "branches":
            DispatchQueue.global(qos: .userInitiated).async { var r = folders.branches(pid); r["id"] = id; self.answer(r) }
        case "site":
            SiteCheck.run(body["url"] as? String ?? "") { var r = $0; r["id"] = id; self.answer(r) }
        case "local":
            // Site du projet lancé en local (voir Sites.swift) : état, démarrage, arrêt.
            let op = body["op"] as? String ?? "", rel = body["rel"] as? String ?? ""
            DispatchQueue.global(qos: .userInitiated).async {
                var r: [String: Any]
                switch op {
                case "start": r = Sites.shared.start(pid, rel: rel)
                case "stop": r = Sites.shared.stop(pid)
                default: r = Sites.shared.state(pid)
                }
                r["id"] = id; self.answer(r)
            }
        case "sessions":
            guard let dir = folders.path(pid) else { answer(["id": id, "ok": true, "sessions": [], "found": false]); return }
            ClaudeSessions.shared.list(project: dir) { var r = $0; r["id"] = id; self.answer(r) }
        case "session":
            guard let dir = folders.path(pid) else { answer(["id": id, "ok": false, "message": "Choisis d'abord le dossier du projet."]); return }
            ClaudeSessions.shared.detail(project: dir, session: body["session"] as? String ?? "") { var r = $0; r["id"] = id; self.answer(r) }
        case "subagent":
            guard let dir = folders.path(pid) else { answer(["id": id, "ok": false, "message": "Choisis d'abord le dossier du projet."]); return }
            ClaudeSessions.shared.subagent(project: dir, session: body["session"] as? String ?? "", agent: body["agent"] as? String ?? "") { var r = $0; r["id"] = id; self.answer(r) }
        case "journal":
            // Journal des demandes : seulement les projets dont le dossier a été choisi sur ce Mac.
            let ids = (body["projects"] as? [String] ?? []).prefix(60)
            let list = ids.compactMap { p in folders.path(p).map { (id: p, dir: $0) } }
            let since = body["since"] as? String ?? ""
            guard since.count == 10 else { answer(["id": id, "ok": false, "message": "Date invalide."]); return }
            ClaudeSessions.shared.journal(projects: list, since: since) { var r = $0; r["id"] = id; self.answer(r) }
        case "deleteSession":
            // Supprime une conversation : son journal part dans la corbeille, et ses agents terminés sont oubliés.
            let sid = body["session"] as? String ?? ""
            if Agents.shared.busy(project: pid, session: sid) { answer(["id": id, "ok": false, "message": "Arrête d'abord l'agent qui travaille dans cette conversation."]); return }
            let forgotten = Agents.shared.forget(project: pid, session: sid)
            guard let dir = folders.path(pid) else { answer(["id": id, "ok": forgotten > 0, "message": "Choisis d'abord le dossier du projet."]); return }
            // Session d'un agent sur serveur : pas de journal sur ce Mac, l'oublier suffit.
            ClaudeSessions.shared.delete(project: dir, session: sid) { var r = $0; if forgotten > 0 { r["ok"] = true }; r["id"] = id; self.answer(r) }
        default:
            answer(["id": id, "ok": false, "message": "Action inconnue."])
        }
        #else
        answer(["id": id, "ok": false, "message": "Disponible dans l'app Mac."])
        #endif
    }

    /// Agents Claude Code d'un projet (voir Agents.swift) et leurs copies isolées.
    private func agent(_ action: String, id: Int, body: [String: Any]) {
        #if os(macOS)
        let pid = body["project"] as? String ?? "", folders = ProjectFolders.shared
        let send: ([String: Any]) -> Void = { var r = $0; r["id"] = id; self.answer(r) }
        let bg: (@escaping () -> [String: Any]) -> Void = { work in DispatchQueue.global(qos: .userInitiated).async { send(work()) } }
        switch action {
        case "start":
            // « internal » est réservé à l'orchestrateur (reprise sans passer par la file des messages en attente).
            var b = body; b["internal"] = nil
            DispatchQueue.global(qos: .userInitiated).async { Agents.shared.start(project: pid, body: b, done: send) }
        case "list": send(Agents.shared.list(project: pid))
        // Consignes et réglages de contexte des agents (Réglages → Consignes et contexte) : lecture, modification, retour à l'origine.
        case "tuning": AgentTuning.apply(body); send(AgentTuning.state())
        // Ce que les agents ont le droit de faire (Réglages → Autorisations) : lecture, modification, retour à l'origine.
        case "permissions": send(AgentPermissions.apply(body))
        case "unqueue": send(Agents.shared.unqueue(project: pid, id: body["queued"] as? String ?? ""))
        case "stop": send(Agents.shared.stop(body["run"] as? String ?? ""))
        case "worktrees": bg { folders.worktrees(pid) }
        case "pushcheck": bg { folders.pushCheck(pid) }
        case "push": bg { folders.commitPush(pid, name: body["worktree"] as? String ?? "", message: body["message"] as? String ?? "", branch: body["branch"] as? String ?? "") }
        case "discard":
            let name = body["worktree"] as? String ?? ""
            if Orchestrator.shared.busy(project: pid, worktree: name) { send(["ok": false, "message": "Une publication est en cours sur cette copie."]); return }
            bg { folders.removeWorktree(pid, name: name) }
        case "newbranch":
            let name = body["worktree"] as? String ?? ""
            if Orchestrator.shared.busy(project: pid, worktree: name) || Agents.shared.busy(project: pid, worktree: name) { send(["ok": false, "message": "Un agent ou une publication travaille encore dans cette copie."]); return }
            bg { folders.newBranch(pid, name: name) }
        // Orchestrateur : publication ou mise à jour d'une copie, de bout en bout (voir Orchestrator.swift).
        case "publish": bg { Orchestrator.shared.start(kind: "publish", project: pid, worktree: body["worktree"] as? String ?? "", message: body["message"] as? String ?? "", branch: body["branch"] as? String ?? "") }
        case "sync": bg { Orchestrator.shared.start(kind: "sync", project: pid, worktree: body["worktree"] as? String ?? "") }
        case "job": send(Orchestrator.shared.job(body["job"] as? String ?? ""))
        case "jobs": send(Orchestrator.shared.list(project: pid))
        case "commits": bg { folders.commits(pid, days: body["days"] as? Int ?? 30) }
        case "run": send(Agents.shared.detail(body["run"] as? String ?? ""))
        case "server":
            switch body["op"] as? String ?? "" {
            case "hosts": bg { Servers.shared.hosts() }
            case "set": bg { Servers.shared.set(pid, host: body["host"] as? String ?? "", path: body["path"] as? String ?? "") }
            case "forget": Servers.shared.forget(pid); Monitors.shared.stop(pid); send(["ok": true])
            case "terminal": send(Servers.shared.terminal(pid))
            // Monitoring en direct (Monitor.swift) et terminal intégré (Terminals.swift).
            case "monitor": bg { Monitors.shared.poll(pid, since: body["since"] as? Double ?? 0) }
            case "term-open":
                Terminals.shared.emit = { [weak self] payload in
                    guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
                    DispatchQueue.main.async { self?.web?.evaluateJavaScript("window.carnet && window.carnet.term && window.carnet.term(\(json))", completionHandler: nil) }
                }
                bg { Terminals.shared.open(pid, cols: body["cols"] as? Int ?? 80, rows: body["rows"] as? Int ?? 24) }
            case "term-write": send(Terminals.shared.input(body["term"] as? String ?? "", body["data"] as? String ?? ""))
            case "term-resize": send(Terminals.shared.resize(body["term"] as? String ?? "", cols: body["cols"] as? Int ?? 80, rows: body["rows"] as? Int ?? 24))
            case "term-close": send(Terminals.shared.stop(body["term"] as? String ?? ""))
            case "term-list": send(Terminals.shared.list(pid))
            default: bg { Servers.shared.status(pid) }
            }
        case "daily":
            guard let dir = folders.path(pid) else { send(["ok": true, "tokens": [:], "sessions": [:]]); return }
            ClaudeSessions.shared.daily(project: dir, days: body["days"] as? Int ?? 30, done: send)
        default: send(["ok": false, "message": "Action inconnue."])
        }
        #else
        answer(["id": id, "ok": false, "message": "Les agents tournent sur le Mac."])
        #endif
    }

    /// Claude Code installé sur ce Mac, utilisé comme fournisseur d'IA (voir ClaudeCode.swift).
    private func claude(_ action: String, id: Int, body: [String: Any]) {
        #if os(macOS)
        let cc = ClaudeCode.shared
        let send: ([String: Any]) -> Void = { var r = $0; r["id"] = id; self.answer(r) }
        switch action {
        case "status": cc.status(done: send)
        case "login": cc.login(done: send)
        case "run": cc.run(body, done: send)
        case "cancel": cc.cancel(body["run"] as? String ?? ""); send(["ok": true])
        // Utilisation de l'abonnement (voir ClaudeUsage.swift) : tokens des journaux locaux, et limites si l'utilisateur les a activées.
        case "usage": ClaudeUsage.shared.local(done: send)
        case "limits": ClaudeUsage.shared.limits(op: body["op"] as? String ?? "", done: send)
        default: send(["ok": false, "message": "Action inconnue."])
        }
        #else
        answer(["id": id, "ok": false, "message": "Claude Code s'utilise depuis l'app Mac."])
        #endif
    }

    /// Mise à jour de l'app Mac depuis les Releases du dépôt (voir Updater.swift).
    private func update(_ action: String, id: Int) {
        #if os(macOS)
        let send: ([String: Any]) -> Void = { var r = $0; r["id"] = id; self.answer(r) }
        switch action {
        case "info": send(Updater.shared.info())
        case "check": Updater.shared.check(done: send)
        case "download": Updater.shared.download(done: send)
        case "discard": Updater.shared.discard(done: send)
        case "install": Updater.shared.install(done: send)
        default: send(["ok": false, "message": "Action inconnue."])
        }
        #else
        answer(["id": id, "ok": false, "message": "La mise à jour depuis l'app concerne l'app Mac."])
        #endif
    }

    private func biometric(_ action: String, id: Int, body: [String: Any]) {
        let bio = Biometrics.shared
        let fail: (Biometrics.Failure) -> Void = { self.reply(["id": id, "ok": false, "error": $0.code, "message": $0.message]) }
        switch action {
        case "status":
            var r = bio.status(); r["id"] = id; reply(r)
        case "enable":
            guard let b64 = body["secret"] as? String, let secret = Data(base64Encoded: b64), secret.count == 32 else { return fail(.init(code: "invalid", message: "Secret invalide.")) }
            do { try bio.store(secret); reply(["id": id, "ok": true]) } catch let e as Biometrics.Failure { fail(e) } catch { fail(.init(code: "keychain", message: error.localizedDescription)) }
        case "unlock":
            let why = String((body["reason"] as? String ?? "Ouvrir Studio").prefix(120))
            bio.unlock(reason: why) { result in
                switch result {
                case .success(let data): self.reply(["id": id, "ok": true, "secret": data.base64EncodedString()])
                case .failure(let e): fail(e)
                }
            }
        case "remove":
            bio.remove(); reply(["id": id, "ok": true])
        default:
            fail(.init(code: "invalid", message: "Action inconnue."))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoad?() }

    /// Sites qu'un cadre de la page peut afficher (frame-src de index.html) : leur navigation reste dans le cadre.
    private static func framable(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return host == "figma.com" || host.hasSuffix(".figma.com")
    }

    // Tout ce qui sort de carnet:// s'ouvre dans le navigateur du système (sauf dans un cadre autorisé) ;
    // les téléchargements sont gérés ici.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if let frame = action.targetFrame, !frame.isMainFrame, Self.framable(url) { decisionHandler(.allow); return }
        switch url.scheme?.lowercased() {
        case Shell.scheme, "about", "blob", "data":
            decisionHandler(.allow)
        default:
            openExternally(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    // target="_blank" : ouvrir à l'extérieur, jamais de nouvelle fenêtre web.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    private func openExternally(_ url: URL) {
        guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }

    // ---- Téléchargements (exports, sauvegardes, paquets chiffrés) ----
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        #if os(macOS)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.begin { completionHandler($0 == .OK ? panel.url : nil) }
        #else
        // iOS : fichier temporaire, puis feuille de partage (Fichiers, AirDrop…) une fois terminé.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(suggestedFilename)
        pending[download] = dest
        completionHandler(dest)
        #endif
    }

    func downloadDidFinish(_ download: WKDownload) {
        #if os(iOS)
        guard let url = pending.removeValue(forKey: download), let web else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = web
        sheet.popoverPresentationController?.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 1, height: 1)
        web.window?.rootViewController?.topMost.present(sheet, animated: true)
        #endif
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { pending[download] = nil }

    #if os(macOS)
    // <input type="file"> (import de notes, de sauvegardes, de paquets).
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    #endif

    /// Enregistre les modifications en attente (avant de quitter ou de passer en arrière-plan).
    func flush(_ done: @escaping () -> Void) {
        guard let web else { done(); return }
        web.callAsyncJavaScript("await window.carnet?.flush?.()", arguments: [:], in: nil, in: .page) { _ in done() }
    }
}

#if os(iOS)
extension UIViewController {
    var topMost: UIViewController { presentedViewController?.topMost ?? self }
}
#endif
