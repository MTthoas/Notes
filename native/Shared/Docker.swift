// Docker sur ce Mac (lecture seule) : conteneurs (en cours et arrêtés) et images, rattachés aux projets Studio.
//
// Studio parle directement au moteur Docker par sa socket Unix (Docker Desktop, OrbStack, Colima, Rancher Desktop),
// sans lancer le programme `docker` : rien à trouver dans le PATH, aucun shell. Seules trois requêtes GET, fixes,
// partent vers le moteur (/version, /containers/json, /images/json) : la page ne fournit aucun chemin ni argument,
// et Studio ne peut ni lancer, ni arrêter, ni supprimer quoi que ce soit.
//
// Un conteneur appartient à un projet quand son dossier de travail Compose (com.docker.compose.project.working_dir),
// celui d'un devcontainer (devcontainer.local_folder) ou l'un de ses dossiers montés est le dossier du projet sur ce
// Mac, ou se trouve dedans — y compris la copie isolée d'un agent (.claude/worktrees/…). Une image appartient au
// projet quand un de ses conteneurs l'utilise, ou quand Compose l'a construite pour lui (étiquette
// com.docker.compose.project : celle de ses conteneurs, ou le nom que Compose déduit du dossier).
import Foundation
#if os(macOS)

enum Docker {
    private static let maxResponse = 16 << 20
    private static let timeout = 5

    /// Sockets connues du moteur Docker, dans l'ordre : DOCKER_HOST (unix:// seulement), puis les emplacements usuels.
    private static var sockets: [String] {
        let home = NSHomeDirectory()
        var list: [String] = []
        if let h = ProcessInfo.processInfo.environment["DOCKER_HOST"], h.hasPrefix("unix://") { list.append(String(h.dropFirst(7))) }
        list += [home + "/.docker/run/docker.sock", "/var/run/docker.sock", home + "/.orbstack/run/docker.sock",
                 home + "/.colima/default/docker.sock", home + "/.colima/docker.sock", home + "/.rd/docker.sock"]
        return list
    }

    /// Une requête GET au moteur, en HTTP/1.0 (réponse d'un bloc, sans découpage), ou nil s'il ne répond pas.
    private static func get(_ path: String, socket sockPath: String) -> (Int, Data)? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var tv = timeval(tv_sec: timeout, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(sockPath.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in raw.copyBytes(from: bytes); raw[bytes.count] = 0 }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) } }
        guard ok == 0 else { return nil }
        let request = Array("GET \(path) HTTP/1.0\r\nHost: docker\r\nUser-Agent: Studio\r\n\r\n".utf8)
        guard request.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) }) == request.count else { return nil }
        var data = Data(), buf = [UInt8](repeating: 0, count: 65536)
        while data.count <= maxResponse {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            data.append(contentsOf: buf[0..<n])
        }
        guard data.count <= maxResponse, let sep = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<sep.lowerBound], encoding: .utf8) else { return nil }
        let code = head.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0
        return (code, data[sep.upperBound...])
    }

    private static func json(_ path: String, _ sock: String) -> Any? {
        guard let (code, body) = get(path, socket: sock), code == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: body)
    }

    /// Nom que Compose donne à un projet d'après son dossier : minuscules, lettres, chiffres, « - » et « _ ».
    static func composeName(_ dir: String) -> String {
        let base = (dir as NSString).lastPathComponent.lowercased()
        return String(base.unicodeScalars.filter { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-_").contains($0) }.map(Character.init))
            .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
    }

    private static func inside(_ path: String, _ dir: String) -> Bool { path == dir || path.hasPrefix(dir + "/") }
    private static let tilde = { (p: String) -> String in p.hasPrefix(NSHomeDirectory() + "/") ? "~" + p.dropFirst(NSHomeDirectory().count) : p }

    /// Conteneurs et images de ce Mac ; `projects` : identifiants des projets Studio et leur dossier, pour les rattacher.
    static func status(projects: [(id: String, dir: String)]) -> [String: Any] {
        guard let sock = sockets.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            return ["ok": true, "available": false, "reason": "missing"]
        }
        guard let version = json("/version", sock) as? [String: Any] else {
            return ["ok": true, "available": false, "reason": "stopped"]
        }
        let platform = (version["Platform"] as? [String: Any])?["Name"] as? String ?? ""
        let rawContainers = json("/containers/json?all=1", sock) as? [[String: Any]] ?? []
        let rawImages = json("/images/json", sock) as? [[String: Any]] ?? []
        let dirs = projects.map { (id: $0.id, dir: (($0.dir as NSString).standardizingPath as NSString).resolvingSymlinksInPath) }

        var containers: [[String: Any]] = [], imageProjects: [String: Set<String>] = [:], composeOf: [String: Set<String>] = [:]
        for c in rawContainers {
            let labels = c["Labels"] as? [String: String] ?? [:]
            let workdir = labels["com.docker.compose.project.working_dir"] ?? labels["devcontainer.local_folder"] ?? ""
            // Docker Desktop préfixe les dossiers du Mac montés par « /host_mnt ».
            let mounts = (c["Mounts"] as? [[String: Any]] ?? []).filter { $0["Type"] as? String == "bind" }
                .compactMap { $0["Source"] as? String }.map { $0.hasPrefix("/host_mnt/") ? String($0.dropFirst(9)) : $0 }
            let owners = dirs.filter { d in (!workdir.isEmpty && inside(workdir, d.dir)) || mounts.contains { inside($0, d.dir) } }.map(\.id)
            let compose = labels["com.docker.compose.project"] ?? ""
            for id in owners {
                if let img = c["ImageID"] as? String { imageProjects[img, default: []].insert(id) }
                if !compose.isEmpty { composeOf[id, default: []].insert(compose) }
            }
            var ports: [[String: Any]] = [], seen = Set<String>()
            for p in c["Ports"] as? [[String: Any]] ?? [] {
                guard let pub = p["PublicPort"] as? Int, let priv = p["PrivatePort"] as? Int else { continue }
                let type = p["Type"] as? String ?? "tcp", key = "\(pub)/\(type)"
                if seen.insert(key).inserted { ports.append(["public": pub, "private": priv, "type": type]) }
            }
            let name = ((c["Names"] as? [String])?.first ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let worktree = workdir.range(of: "/.claude/worktrees/").map { String(workdir[$0.upperBound...]).split(separator: "/").first.map(String.init) ?? "" } ?? ""
            containers.append([
                "id": String((c["Id"] as? String ?? "").prefix(12)), "name": name, "image": c["Image"] as? String ?? "",
                "state": c["State"] as? String ?? "", "status": c["Status"] as? String ?? "", "created": c["Created"] as? Int ?? 0,
                "ports": ports.sorted { ($0["public"] as? Int ?? 0) < ($1["public"] as? Int ?? 0) },
                "compose": compose, "service": labels["com.docker.compose.service"] ?? "",
                "folder": workdir.isEmpty ? "" : tilde(workdir), "worktree": worktree, "projects": owners,
            ])
        }
        // Projets Compose de chaque projet Studio : ceux de ses conteneurs, et le nom déduit de son dossier.
        for d in dirs { composeOf[d.id, default: []].insert(composeName(d.dir)) }
        var images: [[String: Any]] = []
        for i in rawImages {
            let id = i["Id"] as? String ?? "", labels = i["Labels"] as? [String: String] ?? [:]
            let compose = labels["com.docker.compose.project"] ?? ""
            var owners = imageProjects[id] ?? []
            if !compose.isEmpty { for (pid, names) in composeOf where names.contains(compose) { owners.insert(pid) } }
            let tags = (i["RepoTags"] as? [String] ?? []).filter { $0 != "<none>:<none>" }
            images.append([
                "id": String(id.replacingOccurrences(of: "sha256:", with: "").prefix(12)), "tags": tags,
                "size": i["Size"] as? Int ?? 0, "created": i["Created"] as? Int ?? 0, "containers": i["Containers"] as? Int ?? -1,
                "compose": compose, "service": labels["com.docker.compose.service"] ?? "", "projects": Array(owners).sorted(),
            ])
        }
        return ["ok": true, "available": true, "engine": ["name": platform, "version": version["Version"] as? String ?? ""],
                "containers": containers, "images": images.sorted { ($0["created"] as? Int ?? 0) > ($1["created"] as? Int ?? 0) }]
    }
}
#endif
