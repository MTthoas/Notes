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

    // Tout ce qui sort de carnet:// s'ouvre dans le navigateur du système ; les téléchargements sont gérés ici.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
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
