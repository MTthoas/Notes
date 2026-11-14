// Site web d'un projet, lancé en local depuis le Mac (onglet Site).
//
// Studio cherche un site dans le dossier du projet, à des emplacements connus (racine, site/, web/, docs/, dist/…) :
//   - un dossier avec un index.html est servi par Studio lui-même (serveur de fichiers ci-dessous) ;
//   - un projet Next.js, Astro, Vite… est lancé avec son propre script (« npm run dev »), et Studio lit l'adresse
//     qu'il annonce.
//
// Garde-fous : la page ne fournit jamais de chemin ni de commande. Elle désigne un emplacement relatif, qui doit
// figurer dans la liste que Studio vient de détecter ; la commande est toujours « <npm|pnpm|yarn|bun> run <script> ».
// Le serveur de fichiers n'écoute que sur 127.0.0.1, ne sort jamais du dossier servi (liens symboliques compris)
// et refuse les fichiers cachés (.env, .git…). Lancer un script de développement exécute le code du projet : seul
// le Mac peut le demander (« project.local » n'est pas dans REMOTE_ALLOWED, link.ts). Tout s'arrête avec l'app.
import Foundation
#if os(macOS)
import Network

final class Sites {
    static let shared = Sites()
    private let lock = NSLock()
    private var live: [String: Live] = [:]

    /// Un site trouvé dans le dossier du projet.
    struct Candidate {
        let rel: String
        let dir: String
        /// « static » (servi par Studio) ou « dev » (script du projet).
        let kind: String
        let label: String
        let tool: String
        let script: String
    }

    /// Un site en cours d'exécution.
    final class Live {
        let rel: String
        let kind: String
        let label: String
        let started = Date()
        var status = "starting"
        var url = ""
        var port = 0
        var log = ""
        var requests = 0
        var pages = 0
        var bytes = 0
        var process: Process?
        var server: StaticServer?
        init(rel: String, kind: String, label: String) { self.rel = rel; self.kind = kind; self.label = label }
    }

    private static let places = ["", "site", "website", "web", "www", "landing", "docs", "frontend", "client",
                                 "apps/web", "apps/site", "apps/www", "apps/landing", "packages/web", "packages/site",
                                 "dist", "build", "out", "_site", "public"]
    private static let builds: Set<String> = ["dist", "build", "out", "_site"]
    private static let frameworks: [(String, String)] = [
        ("next", "Next.js"), ("astro", "Astro"), ("nuxt", "Nuxt"), ("@sveltejs/kit", "SvelteKit"), ("@remix-run/dev", "Remix"),
        ("gatsby", "Gatsby"), ("@11ty/eleventy", "Eleventy"), ("vitepress", "VitePress"), ("@docusaurus/core", "Docusaurus"),
        ("react-scripts", "Create React App"), ("@angular/cli", "Angular"), ("vite", "Vite"), ("parcel", "Parcel"),
    ]

    /// Gestionnaire de paquets du projet, d'après son fichier de verrou (dans le dossier du site, sinon à la racine).
    private static func tool(_ dir: String, _ root: String) -> String {
        let fm = FileManager.default
        for d in [dir, root] {
            if fm.fileExists(atPath: d + "/pnpm-lock.yaml") { return "pnpm" }
            if fm.fileExists(atPath: d + "/yarn.lock") { return "yarn" }
            if fm.fileExists(atPath: d + "/bun.lockb") || fm.fileExists(atPath: d + "/bun.lock") { return "bun" }
            if fm.fileExists(atPath: d + "/package-lock.json") { return "npm" }
        }
        return "npm"
    }

    func candidates(_ root: String) -> [Candidate] {
        let fm = FileManager.default
        var out: [Candidate] = []
        for rel in Self.places {
            let dir = rel.isEmpty ? root : root + "/" + rel
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { continue }
            var hasPackage = false, isDev = false
            if let data = fm.contents(atPath: dir + "/package.json"), data.count < 2_000_000,
               let pkg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                hasPackage = true
                let scripts = pkg["scripts"] as? [String: Any] ?? [:]
                var deps = Set<String>()
                for k in ["dependencies", "devDependencies"] {
                    if let d = pkg[k] as? [String: Any] { deps.formUnion(d.keys) }
                }
                if let fw = Self.frameworks.first(where: { deps.contains($0.0) }),
                   let script = ["dev", "start", "serve"].first(where: { scripts[$0] is String }) {
                    out.append(Candidate(rel: rel, dir: dir, kind: "dev", label: fw.1, tool: Self.tool(dir, root), script: script))
                    isDev = true
                }
            }
            // À la racine, un package.json sans framework connu désigne une app à construire, pas un site à servir tel quel.
            if isDev || (hasPackage && rel.isEmpty) { continue }
            if fm.fileExists(atPath: dir + "/index.html") {
                out.append(Candidate(rel: rel, dir: dir, kind: "static", label: Self.builds.contains(rel) ? "Build statique" : "Site statique", tool: "", script: ""))
            }
        }
        return out
    }

    /// Où chercher npm, pnpm… : les dossiers réglés pour les agents, puis les emplacements habituels, puis le PATH de l'app.
    private static func searchPath() -> [String] {
        let home = NSHomeDirectory()
        let base = (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        let all = AgentPermissions.path + ["/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.bun/bin", home + "/.volta/bin", home + "/Library/pnpm"] + base
        var seen = Set<String>()
        var out: [String] = []
        for d in all where !seen.contains(d) { seen.insert(d); out.append(d) }
        return out
    }
    private static func find(_ tool: String) -> String? {
        for d in searchPath() {
            let p = d + "/" + tool
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    /// Retire les séquences de couleur du terminal.
    private static func clean(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }
    /// Adresse locale annoncée par un serveur de développement dans sa sortie.
    private static func address(in log: String) -> (scheme: String, port: Int)? {
        guard let r = log.range(of: #"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):[0-9]{2,5}"#, options: .regularExpression) else { return nil }
        let m = String(log[r])
        guard let colon = m.lastIndex(of: ":"), let port = Int(m[m.index(after: colon)...]) else { return nil }
        return (m.hasPrefix("https") ? "https" : "http", port)
    }

    /// Ce que l'onglet Site affiche : les sites trouvés, et celui qui tourne.
    func state(_ pid: String) -> [String: Any] {
        guard let root = ProjectFolders.shared.path(pid) else { return ["ok": true, "folder": false, "sites": [[String: String]]()] }
        let found: [[String: String]] = candidates(root).map { c in
            ["rel": c.rel, "kind": c.kind, "label": c.label, "command": c.kind == "dev" ? c.tool + " run " + c.script : ""]
        }
        var r: [String: Any] = ["ok": true, "folder": true, "sites": found]
        lock.lock(); defer { lock.unlock() }
        if let l = live[pid] {
            let info: [String: Any] = [
                "rel": l.rel, "kind": l.kind, "label": l.label, "status": l.status, "url": l.url, "port": l.port,
                "since": Int(l.started.timeIntervalSince1970 * 1000), "requests": l.requests, "pages": l.pages, "bytes": l.bytes,
                "log": String(l.log.suffix(2500)),
            ]
            r["live"] = info
        }
        return r
    }

    func start(_ pid: String, rel: String) -> [String: Any] {
        guard let root = ProjectFolders.shared.path(pid) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        guard let c = candidates(root).first(where: { $0.rel == rel }) else { return ["ok": false, "message": "Aucun site trouvé à cet emplacement."] }
        stop(pid)
        let l = Live(rel: c.rel, kind: c.kind, label: c.label)
        if c.kind == "static" {
            let server = StaticServer(root: URL(fileURLWithPath: c.dir, isDirectory: true))
            server.onResponse = { [weak self, weak l] code, type, size in
                guard let self = self, let l = l else { return }
                self.lock.lock()
                l.requests += 1; l.bytes += size
                if code == 200 && type.hasPrefix("text/html") { l.pages += 1 }
                self.lock.unlock()
            }
            guard server.start() else { return ["ok": false, "message": "Aucun port libre entre 4321 et 4350 pour servir le site."] }
            l.server = server; l.port = Int(server.port); l.url = "http://localhost:\(server.port)/"; l.status = "running"
        } else {
            guard let exe = Self.find(c.tool) else {
                return ["ok": false, "message": "« \(c.tool) » est introuvable sur ce Mac. Ajoute son dossier dans Réglages → Autorisations des agents → Dossiers des outils."]
            }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = ["run", c.script]
            p.currentDirectoryURL = URL(fileURLWithPath: c.dir, isDirectory: true)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = Self.searchPath().joined(separator: ":")
            env["BROWSER"] = "none"; env["NO_COLOR"] = "1"; env["FORCE_COLOR"] = "0"
            p.environment = env
            let out = Pipe()
            p.standardOutput = out; p.standardError = out; p.standardInput = FileHandle.nullDevice
            out.fileHandleForReading.readabilityHandler = { [weak self, weak l] handle in
                let data = handle.availableData
                guard !data.isEmpty, let self = self, let l = l else { handle.readabilityHandler = nil; return }
                let text = Sites.clean(String(decoding: data, as: UTF8.self))
                self.lock.lock()
                l.log = String((l.log + text).suffix(6000))
                if l.port == 0, let a = Sites.address(in: l.log) {
                    l.port = a.port; l.url = "\(a.scheme)://localhost:\(a.port)/"
                    if l.status == "starting" { l.status = "running" }
                }
                self.lock.unlock()
            }
            p.terminationHandler = { [weak self, weak l] _ in
                guard let self = self, let l = l else { return }
                self.lock.lock()
                if l.status != "stopped" { l.status = "error" }
                l.process = nil
                self.lock.unlock()
            }
            do { try p.run() } catch { return ["ok": false, "message": "Impossible de lancer « \(c.tool) run \(c.script) »."] }
            l.process = p
        }
        lock.lock(); live[pid] = l; lock.unlock()
        return state(pid)
    }

    @discardableResult
    func stop(_ pid: String) -> [String: Any] {
        lock.lock()
        let l = live.removeValue(forKey: pid)
        l?.status = "stopped"
        let process = l?.process, server = l?.server
        lock.unlock()
        server?.stop()
        if let p = process, p.isRunning {
            // Le script lance d'autres processus (node, esbuild…) : on arrête toute la descendance, pas seulement npm.
            for child in Self.descendants(of: p.processIdentifier) { kill(child, SIGTERM) }
            p.terminate()
        }
        return ["ok": true]
    }

    /// À la fermeture de l'app : aucun serveur ne doit lui survivre.
    func stopAll() {
        lock.lock(); let ids = Array(live.keys); lock.unlock()
        for id in ids { stop(id) }
    }

    private static func descendants(of root: Int32) -> [Int32] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-axo", "pid=,ppid="]
        let out = Pipe()
        p.standardOutput = out; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return [] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        var children: [Int32: [Int32]] = [:]
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let f = line.split(separator: " ", omittingEmptySubsequences: true)
            if f.count == 2, let pid = Int32(f[0]), let parent = Int32(f[1]) { children[parent, default: []].append(pid) }
        }
        var all: [Int32] = [], stack: [Int32] = [root]
        while let x = stack.popLast() {
            for k in children[x] ?? [] { all.append(k); stack.append(k) }
        }
        return all
    }
}

/// Serveur de fichiers minimal (GET et HEAD), limité à la machine : il n'écoute que sur 127.0.0.1.
final class StaticServer {
    private let root: URL
    private let rootPath: String
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "studio.site.static")
    private(set) var port: UInt16 = 0
    /// Appelé à chaque réponse : code, type du contenu, taille du corps.
    var onResponse: ((Int, String, Int) -> Void)?

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8", "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8", "webmanifest": "application/manifest+json; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2",
        "ttf": "font/ttf", "otf": "font/otf", "txt": "text/plain; charset=utf-8", "xml": "application/xml; charset=utf-8",
        "pdf": "application/pdf", "mp4": "video/mp4", "webm": "video/webm", "mp3": "audio/mpeg", "wasm": "application/wasm",
    ]
    private static let reasons: [Int: String] = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large"]

    init(root: URL) {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL
        self.rootPath = self.root.path
    }

    /// Écoute sur le premier port libre à partir de `first`.
    func start(from first: UInt16 = 4321) -> Bool {
        for candidate in first..<(first + 30) {
            guard let p = NWEndpoint.Port(rawValue: candidate) else { continue }
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host.ipv4(IPv4Address.loopback), port: p)
            guard let l = try? NWListener(using: params) else { continue }
            let ready = DispatchSemaphore(value: 0)
            let result = Outcome()
            l.stateUpdateHandler = { state in
                switch state {
                case .ready: result.ok = true; ready.signal()
                case .failed, .cancelled: ready.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in
                guard let self = self else { c.cancel(); return }
                c.start(queue: self.queue)
                self.read(c, Data())
            }
            l.start(queue: queue)
            _ = ready.wait(timeout: .now() + 2)
            if result.ok { l.stateUpdateHandler = nil; listener = l; port = candidate; return true }
            l.stateUpdateHandler = nil
            l.cancel()
        }
        return false
    }
    private final class Outcome { var ok = false }

    func stop() { listener?.cancel(); listener = nil }

    /// Lit l'en-tête de la requête (32 Ko au plus), puis répond et ferme.
    private func read(_ c: NWConnection, _ acc: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, done, error in
            guard let self = self else { c.cancel(); return }
            var buf = acc
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(c, head: String(decoding: buf.subdata(in: 0..<end.lowerBound), as: UTF8.self))
            } else if done || error != nil || buf.count > 32_768 {
                c.cancel()
            } else {
                self.read(c, buf)
            }
        }
    }

    private func respond(_ c: NWConnection, head: String) {
        let parts = (head.components(separatedBy: "\r\n").first ?? "").components(separatedBy: " ")
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return send(c, 405, "text/plain; charset=utf-8", Data("Méthode refusée.".utf8), bodyless: false) }
        let bodyless = parts[0] == "HEAD"
        var path = parts[1]
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
        path = path.removingPercentEncoding ?? path
        let names = path.components(separatedBy: "/").filter { !$0.isEmpty }
        // Ni remontée (..), ni fichier caché (.env, .git…), ni caractère de contrôle.
        guard path.hasPrefix("/"), !names.contains(where: { $0.hasPrefix(".") }), path.rangeOfCharacter(from: .controlCharacters) == nil else {
            return notFound(c, bodyless)
        }
        let fm = FileManager.default
        var file = names.reduce(root) { $0.appendingPathComponent($1) }
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: file.path, isDirectory: &isDir), isDir.boolValue { file = file.appendingPathComponent("index.html") }
        else if !fm.fileExists(atPath: file.path), file.pathExtension.isEmpty { file = file.appendingPathExtension("html") }
        // Un lien symbolique ne fait pas sortir du dossier servi.
        let real = file.resolvingSymlinksInPath().standardizedFileURL.path
        guard real == rootPath || real.hasPrefix(rootPath + "/"), fm.fileExists(atPath: real, isDirectory: &isDir), !isDir.boolValue else { return notFound(c, bodyless) }
        let size = ((try? fm.attributesOfItem(atPath: real))?[.size] as? NSNumber)?.intValue ?? 0
        guard size <= 80_000_000 else { return send(c, 413, "text/plain; charset=utf-8", Data("Fichier trop volumineux.".utf8), bodyless: bodyless) }
        guard let body = fm.contents(atPath: real) else { return notFound(c, bodyless) }
        let type = Self.types[(real as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
        send(c, 200, type, body, bodyless: bodyless)
    }

    private func notFound(_ c: NWConnection, _ bodyless: Bool) {
        if let page = FileManager.default.contents(atPath: rootPath + "/404.html") { return send(c, 404, "text/html; charset=utf-8", page, bodyless: bodyless) }
        send(c, 404, "text/plain; charset=utf-8", Data("Page introuvable.".utf8), bodyless: bodyless)
    }

    private func send(_ c: NWConnection, _ code: Int, _ type: String, _ body: Data, bodyless: Bool) {
        let reason = Self.reasons[code] ?? "OK"
        var out = Data("HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n".utf8)
        if !bodyless { out.append(body) }
        onResponse?(code, type, body.count)
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }
}
#endif
