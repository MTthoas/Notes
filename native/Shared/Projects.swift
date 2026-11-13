// Dossiers de projet (Mac uniquement). La page ne fournit jamais de chemin : elle désigne un projet par
// son identifiant, et le dossier a été choisi par la personne dans le sélecteur de macOS.
// Les chemins restent dans les réglages de l'app, sur ce Mac : ils ne sont ni dans les notes ni synchronisés.
import Foundation
#if os(macOS)
import AppKit

final class ProjectFolders {
    static let shared = ProjectFolders()
    private let key = "studio.projectFolders"
    struct Failure: Error { let message: String }

    private var folders: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
    /// Identifiant de projet : celui d'une note (UUID ou hexadécimal), rien d'autre.
    private func valid(_ id: String) -> Bool { !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" } }

    func path(_ id: String) -> String? {
        guard valid(id), let p = folders[id], FileManager.default.fileExists(atPath: p) else { return nil }
        return p
    }

    func pick(_ id: String, done: @escaping (String?) -> Void) {
        guard valid(id) else { return done(nil) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choisir ce dossier"
        panel.message = "Dossier du projet sur ce Mac (souvent le dépôt Git)"
        if let p = path(id) { panel.directoryURL = URL(fileURLWithPath: p) }
        panel.begin { r in
            guard r == .OK, let url = panel.url else { return done(nil) }
            var f = self.folders; f[id] = url.path; self.folders = f
            done(url.path)
        }
    }

    func forget(_ id: String) { var f = folders; f.removeValue(forKey: id); folders = f }

    /// Git de l'utilisateur : celui de Homebrew s'il existe (même configuration et mêmes identifiants que dans
    /// le Terminal), sinon celui d'Apple. Emplacements fixes, jamais le PATH.
    static let gitPath: String = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/git"

    /// Lance git sans shell, avec un délai et une taille de sortie maximaux ; renvoie aussi le message d'erreur.
    /// Les deux sorties sont lues pendant l'exécution : une sortie volumineuse ne peut pas bloquer le processus.
    func gitRun(_ args: [String], in dir: String, timeout: TimeInterval = 5, maxBytes: Int = 400_000) -> (ok: Bool, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.gitPath)
        p.arguments = ["-C", dir, "--no-pager"] + args
        // HOME : configuration Git de l'utilisateur (identité, gestionnaire d'identifiants) ; agent SSH s'il existe.
        let binDir = (Self.gitPath as NSString).deletingLastPathComponent
        var env = ["GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", "PATH": "\(binDir):/usr/bin:/bin", "HOME": NSHomeDirectory()]
        if let sock = ProcessInfo.processInfo.environment["SSH_AUTH_SOCK"] { env["SSH_AUTH_SOCK"] = sock }
        p.environment = env
        let out = Pipe(), err = Pipe(); p.standardOutput = out; p.standardError = err
        var data = Data(), edata = Data(); let lock = NSLock(); let reading = DispatchGroup()
        for (pipe, isErr) in [(out, false), (err, true)] {
            reading.enter()
            DispatchQueue.global(qos: .utility).async {
                while true {
                    let chunk = pipe.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    lock.lock()
                    if isErr { if edata.count < 20_000 { edata.append(chunk) } } else if data.count < maxBytes { data.append(chunk) }
                    lock.unlock()
                }
                reading.leave()
            }
        }
        do { try p.run() } catch { return (false, "", "Git introuvable.") }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        let timedOut = p.isRunning
        if timedOut { p.terminate() }
        _ = reading.wait(timeout: .now() + 2)
        lock.lock(); defer { lock.unlock() }
        let e = String(decoding: edata, as: UTF8.self)
        return (!timedOut && p.terminationStatus == 0, String(decoding: data.prefix(maxBytes), as: UTF8.self), timedOut ? "Délai dépassé." : e)
    }
    func git(_ args: [String], in dir: String, timeout: TimeInterval = 5, maxBytes: Int = 400_000) -> String? {
        let r = gitRun(args, in: dir, timeout: timeout, maxBytes: maxBytes)
        return r.ok ? r.out : nil
    }
    /// Dernière ligne utile d'un message d'erreur Git (sans adresse contenant des identifiants).
    static func gitError(_ e: String) -> String {
        let lines = e.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && !$0.hasPrefix("hint:") }
        let line = lines.last(where: { $0.hasPrefix("fatal:") || $0.hasPrefix("error:") || $0.contains("denied") || $0.contains("rejected") }) ?? lines.last ?? ""
        return String(line.replacingOccurrences(of: #"https://[^@\s]+@"#, with: "https://", options: .regularExpression).prefix(300))
    }

    /// Vérifie que le push est possible (push à blanc : rien n'est envoyé ni modifié sur le dépôt distant).
    func pushCheck(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        let r = gitRun(["push", "--dry-run", "origin", "HEAD"], in: dir, timeout: 60)
        return r.ok ? ["ok": true, "git": Self.gitPath] : ["ok": false, "git": Self.gitPath, "message": Self.gitError(r.err)]
    }

    /// Changements à relire : non commités (par rapport à HEAD) ou ceux de la branche (par rapport à la branche principale).
    func diff(_ id: String, scope: String, worktree: String? = nil) -> [String: Any] {
        guard let dir = worktree.map({ worktreeDir(id, $0) }) ?? path(id) else { return ["ok": false, "message": "Choisis d'abord le dossier du projet."] }
        if scope == "branch" {
            let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "origin/main"
            let stat = git(["diff", "--stat", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            let patch = git(["diff", "--unified=3", "\(base)...HEAD"], in: dir, timeout: 15) ?? ""
            return ["ok": true, "base": base, "stat": stat, "patch": patch, "truncated": patch.utf8.count >= 400_000]
        }
        // Copie d'agent : les fichiers créés sont marqués « à ajouter » pour apparaître dans le diff (index de la copie seulement).
        if worktree != nil { _ = git(["add", "--intent-to-add", "-A"], in: dir, timeout: 15) }
        let stat = git(["diff", "--stat", "HEAD"], in: dir, timeout: 15) ?? ""
        let patch = git(["diff", "--unified=3", "HEAD"], in: dir, timeout: 15) ?? ""
        let untracked = git(["ls-files", "--others", "--exclude-standard"], in: dir) ?? ""
        var r: [String: Any] = ["ok": true, "base": "HEAD", "stat": stat, "patch": patch, "untracked": untracked, "truncated": patch.utf8.count >= 400_000]
        // Copie d'agent : les derniers messages de commit du dépôt, pour proposer un message dans le même style.
        if worktree != nil { r["log"] = git(["log", "-10", "--format=%s"], in: dir) ?? "" }
        return r
    }

    /// Branches locales et leur position par rapport à la branche principale (pour le suivi du flux).
    func branches(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "branches": []] }
        let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "origin/main"
        let raw = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(upstream:short)", "refs/heads/"], in: dir) ?? ""
        var out: [[String: Any]] = []
        for line in raw.split(separator: "\n").prefix(25) {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let name = f.first else { continue }
            let counts = git(["rev-list", "--left-right", "--count", "\(base)...\(name)"], in: dir)?.split(whereSeparator: { $0 == "\t" || $0 == " " || $0 == "\n" }).compactMap { Int($0) } ?? []
            out.append(["name": name, "date": f.count > 1 ? f[1] : "", "upstream": f.count > 2 ? f[2] : "", "behind": counts.first ?? 0, "ahead": counts.count > 1 ? counts[1] : 0])
        }
        return ["ok": true, "base": base, "branches": out]
    }

    // MARK: Copies isolées (worktrees) créées par les agents

    /// Nom de copie isolée accepté : minuscules, chiffres et tirets (jamais un chemin).
    static func validWorktree(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 64 && name.first != "-" && name.allSatisfy { ($0.isLowercase && $0.isASCII) || $0.isNumber || $0 == "-" }
    }
    func worktreeDir(_ id: String, _ name: String) -> String? {
        guard Self.validWorktree(name), let dir = path(id) else { return nil }
        let wt = dir + "/.claude/worktrees/" + name
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: wt, isDirectory: &isDir) && isDir.boolValue ? wt : nil
    }
    /// Les copies isolées n'apparaissent pas dans `git status` du dépôt (exclusion locale, jamais commitée).
    func excludeWorktrees(_ dir: String) {
        guard let gitDir = git(["rev-parse", "--git-common-dir"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines), !gitDir.isEmpty else { return }
        let base = gitDir.hasPrefix("/") ? gitDir : dir + "/" + gitDir
        let file = base + "/info/exclude", line = ".claude/worktrees/"
        let cur = (try? String(contentsOfFile: file, encoding: .utf8)) ?? ""
        if cur.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == line }) { return }
        try? FileManager.default.createDirectory(atPath: base + "/info", withIntermediateDirectories: true)
        try? (cur + (cur.isEmpty || cur.hasSuffix("\n") ? "" : "\n") + line + "\n").write(toFile: file, atomically: true, encoding: .utf8)
    }
    func isRepo(_ dir: String) -> Bool { git(["rev-parse", "--is-inside-work-tree"], in: dir)?.hasPrefix("true") == true }

    // MARK: Continuer une branche existante

    /// Branche principale du dépôt distant, sans « origin/ » (« main » à défaut).
    func defaultBranch(_ dir: String) -> String {
        let ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ref.hasPrefix("origin/") && ref.count > 7 ? String(ref.dropFirst(7)) : "main"
    }
    /// Nom de branche existante passé tel quel à Git : jamais une option, un chemin ni une expression de révision.
    static func validRef(_ b: String) -> Bool {
        !b.isEmpty && b.count <= 200 && !b.contains("..") && !b.contains("//") && b.first != "/" && b.first != "-" && b.first != "."
            && b.last != "/" && b.last != "." && !b.hasSuffix(".lock") && b != "HEAD"
            && b.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-/".contains($0)) }
    }
    private func refExists(_ ref: String, in dir: String) -> Bool { gitRun(["rev-parse", "--verify", "--quiet", ref + "^{commit}"], in: dir).ok }

    /// Branches qu'un agent peut continuer : locales et distantes, les plus récentes d'abord,
    /// hors branche principale et branches de travail des copies.
    func agentBranches(_ id: String) -> [String: Any] {
        guard let dir = path(id), isRepo(dir) else { return ["ok": true, "branches": [], "base": ""] }
        let base = defaultBranch(dir), remotePrefix = "refs/remotes/origin/"
        let raw = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads/", remotePrefix], in: dir) ?? ""
        var seen = Set<String>(), out: [String] = []
        for line in raw.split(separator: "\n") {
            let ref = String(line)
            let name = ref.hasPrefix("refs/heads/") ? String(ref.dropFirst(11)) : ref.hasPrefix(remotePrefix) ? String(ref.dropFirst(remotePrefix.count)) : ""
            guard name != base, !name.hasPrefix("worktree-"), Self.validRef(name), seen.insert(name).inserted else { continue }
            out.append(name)
            if out.count >= 40 { break }
        }
        return ["ok": true, "branches": out, "base": base]
    }

    /// Prépare une copie isolée qui continue une branche existante. La copie reçoit sa propre branche de travail
    /// (la branche d'origine peut rester ouverte ailleurs), partant de la version la plus avancée de la branche,
    /// locale ou distante. Avec `merge`, la branche principale y est fusionnée sans validation : en cas de conflit,
    /// les fichiers gardent leurs marqueurs pour que l'agent les résolve, et la publication valide la fusion.
    /// `message` : l'erreur en cas d'échec, sinon l'état de la copie à transmettre à l'agent.
    func prepareWorktree(_ dir: String, name: String, branch: String, merge: Bool) -> (ok: Bool, path: String, message: String) {
        guard Self.validWorktree(name), Self.validRef(branch) else { return (false, "", "Nom de branche non pris en charge (lettres, chiffres, . _ - / uniquement).") }
        let base = defaultBranch(dir)
        if branch == base { return (false, "", "« \(branch) » est la branche principale : lance une consigne sans branche, Studio en créera une nouvelle.") }
        // Dernier état du dépôt distant ; hors ligne, on continue avec ce qui est déjà sur le Mac.
        let fetched = gitRun(["fetch", "--quiet", "origin"], in: dir, timeout: 25).ok
        let local = "refs/heads/" + branch, remote = "refs/remotes/origin/" + branch
        let hasLocal = refExists(local, in: dir), hasRemote = refExists(remote, in: dir)
        guard hasLocal || hasRemote else { return (false, "", "Branche « \(branch) » introuvable dans ce dépôt.") }
        // La version locale n'est retenue que si elle contient déjà la version distante (commits pas encore poussés).
        let start = hasLocal && (!hasRemote || gitRun(["merge-base", "--is-ancestor", remote, local], in: dir).ok) ? local : remote
        let wt = dir + "/.claude/worktrees/" + name, work = "worktree-" + name
        let add = gitRun(["worktree", "add", "--quiet", "--no-track", "-b", work, wt, start], in: dir, timeout: 60)
        guard add.ok else { return (false, "", "Impossible de créer la copie : \(Self.gitError(add.err))") }
        _ = gitRun(["config", "branch.\(work).studiotarget", branch], in: wt)
        var note = fetched ? "" : "Le dépôt distant n'a pas pu être consulté : la copie part de l'état connu sur ce Mac. "
        guard merge else { return (true, wt, note) }

        let onto = refExists("refs/remotes/origin/" + base, in: dir) ? "origin/" + base : base
        let m = gitRun(["merge", "--no-commit", "--no-ff", onto], in: wt, timeout: 60)
        let conflicts = (git(["diff", "--name-only", "--diff-filter=U"], in: wt) ?? "").split(separator: "\n").map(String.init)
        if !conflicts.isEmpty {
            note += "Une fusion de « \(onto) » dans cette branche est en cours, pas encore validée. Fichiers en conflit : \(conflicts.prefix(40).joined(separator: ", ")). "
                + "Chacun contient les marqueurs de conflit de Git (<<<<<<<, =======, >>>>>>>) : résous-les en éditant les fichiers, en gardant ce qui doit l'être "
                + "des deux côtés, sans laisser aucun marqueur. Ne lance aucune commande Git : Studio validera la fusion à la publication."
        } else if !m.ok {
            // Fusion impossible pour une autre raison : on ne laisse pas une copie à moitié préparée.
            _ = git(["worktree", "remove", "--force", wt], in: dir, timeout: 30)
            _ = git(["branch", "-D", work], in: dir)
            return (false, "", "La fusion de « \(onto) » a échoué : \(Self.gitError(m.err.isEmpty ? m.out : m.err))")
        } else if gitRun(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], in: wt).ok {
            note += "« \(onto) » a été fusionnée dans cette branche sans conflit ; la fusion sera validée à la publication."
        } else {
            note += "La branche contient déjà « \(onto) » : il n'y a rien à fusionner ni aucun conflit à résoudre."
        }
        return (true, wt, note)
    }

    /// Branche existante que continue une copie (voir prepareWorktree), ou chaîne vide.
    func worktreeTarget(_ wt: String) -> String {
        guard let b = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty, b != "HEAD" else { return "" }
        let t = git(["config", "--get", "branch.\(b).studiotarget"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Self.validRef(t) ? t : ""
    }

    /// Fichiers où `git diff --check` signale encore un marqueur de conflit (début ou fin de bloc).
    static func leftoverConflicts(_ check: String) -> [String] {
        let lines = check.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        for (i, l) in lines.enumerated() where l.hasSuffix(": leftover conflict marker") && i + 1 < lines.count {
            let next = lines[i + 1]
            guard next.hasPrefix("+<<<<<<<") || next.hasPrefix("+>>>>>>>") || next.hasPrefix("+|||||||") else { continue }
            let file = String(l.split(separator: ":", omittingEmptySubsequences: false).first ?? "")
            if !file.isEmpty && !out.contains(file) { out.append(file) }
        }
        return out
    }

    /// Copies isolées du projet : branche, changements, commits d'avance sur la branche principale.
    func worktrees(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "worktrees": []] }
        let raw = git(["worktree", "list", "--porcelain"], in: dir) ?? ""
        let base = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "HEAD"
        var out: [[String: Any]] = []
        for block in raw.components(separatedBy: "\n\n") {
            var wtPath = "", branch = ""
            for l in block.split(separator: "\n") {
                if l.hasPrefix("worktree ") { wtPath = String(l.dropFirst(9)) }
                if l.hasPrefix("branch ") { branch = String(l.dropFirst(7)).replacingOccurrences(of: "refs/heads/", with: "") }
            }
            guard wtPath.hasPrefix(dir + "/.claude/worktrees/") else { continue }
            let name = (wtPath as NSString).lastPathComponent
            guard Self.validWorktree(name) else { continue }
            let changes = (git(["status", "--porcelain"], in: wtPath) ?? "").split(separator: "\n").count
            let ahead = Int(git(["rev-list", "--count", "\(base)..HEAD"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
            let upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            out.append(["name": name, "branch": branch, "changes": changes, "ahead": ahead, "pushed": !upstream.isEmpty, "target": worktreeTarget(wtPath)])
        }
        return ["ok": true, "worktrees": out, "base": base]
    }

    /// Valide les changements d'une copie isolée et pousse sa branche (identifiants Git habituels de l'utilisateur).
    /// Nom de branche accepté : feat/mon-sujet, fix/…, minuscules, chiffres, « . _ - / », sans « .. » ni « / » en bord.
    static func validBranch(_ b: String) -> Bool {
        !b.isEmpty && b.count <= 90 && !b.contains("..") && !b.contains("//") && b.first != "/" && b.first != "-" && b.last != "/" && !b.hasSuffix(".lock")
            && b.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || "._-/".contains($0) }
    }

    func commitPush(_ id: String, name: String, message: String, branch wanted: String = "") -> [String: Any] {
        guard let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        // Copie qui continue une branche existante : sans autre nom demandé, le travail est poussé sur cette branche.
        let target = worktreeTarget(wt), onTarget = !target.isEmpty && (wanted.isEmpty || wanted == target)
        if !wanted.isEmpty && !onTarget && !Self.validBranch(wanted) { return ["ok": false, "message": "Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf)."] }
        let msg = String(message.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        if !(git(["status", "--porcelain"], in: wt) ?? "").isEmpty {
            guard !msg.isEmpty else { return ["ok": false, "message": "Message de commit vide."] }
            let add = gitRun(["add", "-A"], in: wt, timeout: 30)
            // Fusion en cours : pas de validation tant qu'un fichier contient encore un marqueur de conflit.
            if add.ok && gitRun(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], in: wt).ok {
                let left = Self.leftoverConflicts(gitRun(["diff", "--cached", "--check"], in: wt, timeout: 30).out)
                if !left.isEmpty { return ["ok": false, "message": "Il reste des marqueurs de conflit dans : \(left.prefix(8).joined(separator: ", ")). Reprends la session pour finir de les résoudre."] }
            }
            let commit = add.ok ? gitRun(["commit", "-q", "-m", msg], in: wt, timeout: 30) : add
            guard commit.ok else { return ["ok": false, "message": "Le commit a échoué : \(Self.gitError(commit.err))"] }
        }
        guard var branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty, branch != "HEAD" else {
            return ["ok": false, "message": "Branche introuvable."]
        }
        // Nom lisible (feat/…, fix/…) à la place de « worktree-studio-… » donné par Claude Code.
        if !onTarget && !wanted.isEmpty && wanted != branch {
            let mv = gitRun(["branch", "-m", wanted], in: wt)
            guard mv.ok else { return ["ok": false, "message": "Renommage de la branche impossible : \(Self.gitError(mv.err))"] }
            branch = wanted
            // Publiée sous un autre nom : la copie ne suit plus la branche d'origine.
            if !target.isEmpty { _ = gitRun(["config", "--unset", "branch.\(branch).studiotarget"], in: wt) }
        }
        // Sur une branche existante, la branche de travail de la copie est poussée vers elle (jamais de push forcé).
        let push = gitRun(["push", "-u", "origin", onTarget ? "HEAD:refs/heads/\(target)" : branch], in: wt, timeout: 90)
        guard push.ok else {
            let why = Self.gitError(push.err)
            let auth = why.lowercased().contains("auth") || why.contains("403") || why.contains("could not read") || why.contains("Permission denied")
            let moved = onTarget && (why.contains("rejected") || why.contains("non-fast-forward") || why.contains("fetch first"))
            return ["ok": false, "message": "Le push a échoué" + (why.isEmpty ? "." : " : \(why)")
                + (moved ? " — la branche « \(target) » a avancé sur GitHub depuis le lancement de l'agent : publie sous un autre nom de branche, ou relance l'agent sur la branche." : "")
                + (auth ? " — dans le Terminal, lance une fois « git push » dans ce dépôt pour enregistrer tes identifiants." : "")]
        }
        return ["ok": true, "branch": onTarget ? target : branch]
    }

    /// Supprime une copie isolée et sa branche locale (la branche poussée sur GitHub reste).
    func removeWorktree(_ id: String, name: String) -> [String: Any] {
        guard let dir = path(id), let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        _ = git(["worktree", "unlock", wt], in: dir)
        guard git(["worktree", "remove", "--force", wt], in: dir, timeout: 30) != nil else { return ["ok": false, "message": "Suppression impossible."] }
        // La copie « studio-… » a été créée par Studio : sa branche locale aussi (même renommée en feat/…).
        if name.hasPrefix("studio-") && !branch.isEmpty && branch != "HEAD" { _ = git(["branch", "-D", branch], in: dir) }
        return ["ok": true]
    }

    /// Commits par jour sur les `days` derniers jours (toutes branches), pour les graphiques.
    func commits(_ id: String, days: Int) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "days": [:], "found": false] }
        let raw = git(["log", "--all", "--since=\(max(1, min(days, 365))).days", "--format=%cs"], in: dir, timeout: 15) ?? ""
        var out: [String: Int] = [:]
        for d in raw.split(separator: "\n") { out[String(d), default: 0] += 1 }
        return ["ok": true, "days": out, "found": true]
    }

    /// État du dépôt : branche, avance/retard, fichiers modifiés, dépôt GitHub d'origine.
    func info(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "path": NSNull()] }
        var r: [String: Any] = ["ok": true, "path": dir, "name": (dir as NSString).lastPathComponent, "git": false]
        if let s = git(["status", "--porcelain=v1", "--branch"], in: dir) {
            let lines = s.split(separator: "\n").map(String.init)
            r["git"] = true
            if let head = lines.first, head.hasPrefix("## ") {
                let h = String(head.dropFirst(3))
                r["branch"] = String(h.split(separator: ".").first ?? Substring(h)).replacingOccurrences(of: "No commits yet on ", with: "")
                if let a = h.range(of: #"ahead (\d+)"#, options: .regularExpression) { r["ahead"] = Int(h[a].split(separator: " ").last ?? "0") ?? 0 }
                if let b = h.range(of: #"behind (\d+)"#, options: .regularExpression) { r["behind"] = Int(h[b].split(separator: " ").last ?? "0") ?? 0 }
            }
            r["changes"] = lines.dropFirst().filter { !$0.isEmpty }.count
        }
        if let url = git(["remote", "get-url", "origin"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines),
           let m = url.range(of: #"github\.com[:/]([\w.-]+/[\w.-]+?)(\.git)?$"#, options: .regularExpression) {
            r["remote"] = String(url[m]).replacingOccurrences(of: #"^github\.com[:/]"#, with: "", options: .regularExpression).replacingOccurrences(of: ".git", with: "")
        }
        return r
    }

    /// Ouvre le dossier dans le Finder, VS Code ou le Terminal.
    func open(_ id: String, with app: String, worktree: String? = nil) throws {
        guard let dir = worktree.map({ worktreeDir(id, $0) }) ?? path(id) else { throw Failure(message: "Choisis d'abord le dossier du projet.") }
        let url = URL(fileURLWithPath: dir, isDirectory: true)
        let ws = NSWorkspace.shared
        switch app {
        case "finder":
            ws.activateFileViewerSelecting([url])
        case "vscode":
            let ids = ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.vscodium"]
            guard let appURL = ids.lazy.compactMap({ ws.urlForApplication(withBundleIdentifier: $0) }).first else {
                throw Failure(message: "VS Code n'est pas installé sur ce Mac.")
            }
            ws.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
        case "terminal":
            guard let term = ws.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { throw Failure(message: "Terminal introuvable.") }
            ws.open([url], withApplicationAt: term, configuration: NSWorkspace.OpenConfiguration())
        default:
            throw Failure(message: "Application inconnue.")
        }
    }
}
#endif

#if os(macOS)
/// Vérifie qu'un site répond (HTTPS public uniquement, sans cookies) : code, temps de réponse, adresse finale.
enum SiteCheck {
    static func isPublicHTTPS(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".internal") { return false }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4 {
            if parts[0] == 10 || parts[0] == 127 || parts[0] == 0 || (parts[0] == 169 && parts[1] == 254) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1])) { return false }
        }
        return !host.contains(":")
    }
    static func run(_ raw: String, done: @escaping ([String: Any]) -> Void) {
        guard let url = URL(string: raw), isPublicHTTPS(url) else { return done(["ok": false, "message": "Adresse invalide : seul un site public en https:// est vérifié."]) }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.httpCookieStorage = nil
        var req = URLRequest(url: url); req.httpMethod = "GET"; req.setValue("Studio (vérification du site)", forHTTPHeaderField: "User-Agent")
        let start = Date()
        let session = URLSession(configuration: cfg, delegate: Redirects(), delegateQueue: nil)
        session.dataTask(with: req) { _, resp, err in
            session.finishTasksAndInvalidate()
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            if let err { return done(["ok": true, "up": false, "ms": ms, "message": err.localizedDescription]) }
            let http = resp as? HTTPURLResponse
            done(["ok": true, "up": (200..<400).contains(http?.statusCode ?? 0), "status": http?.statusCode ?? 0, "ms": ms, "final": http?.url?.absoluteString ?? raw])
        }.resume()
    }
    /// Une redirection ne suit que vers un autre site public en https (jamais vers le réseau local).
    private final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(request.url.map(SiteCheck.isPublicHTTPS) == true ? request : nil)
        }
    }
}
#endif
