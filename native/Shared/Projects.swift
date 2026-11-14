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
        // GIT_OPTIONAL_LOCKS=0 : les lectures (status, diff) ne prennent plus le verrou de l'index, ce qui évitait
        // les échecs « index.lock exists » quand l'orchestrateur écrit dans une copie pendant le rafraîchissement de l'écran.
        var env = ["GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C", "PATH": "\(binDir):/usr/bin:/bin", "HOME": NSHomeDirectory()]
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

    /// Copies isolées du projet : branche, changements, commits d'avance sur la branche principale,
    /// et ce qui a déjà été livré. Une copie dont le travail est fusionné dans la branche principale repart
    /// d'elle-même de sa dernière version, sur une nouvelle branche : Studio ne la propose plus à la publication.
    func worktrees(_ id: String) -> [String: Any] {
        guard let dir = path(id) else { return ["ok": true, "worktrees": []] }
        // La fusion se passe sur GitHub : il faut relire le dépôt distant pour la voir (au plus toutes les 90 s).
        fetchIfStale(dir)
        let raw = git(["worktree", "list", "--porcelain"], in: dir) ?? ""
        let base = baseRef(dir, fetch: false)
        var found: [(path: String, name: String, branch: String)] = []
        for block in raw.components(separatedBy: "\n\n") {
            var wtPath = "", branch = ""
            for l in block.split(separator: "\n") {
                if l.hasPrefix("worktree ") { wtPath = String(l.dropFirst(9)) }
                if l.hasPrefix("branch ") { branch = String(l.dropFirst(7)).replacingOccurrences(of: "refs/heads/", with: "") }
            }
            guard wtPath.hasPrefix(dir + "/.claude/worktrees/") else { continue }
            let name = (wtPath as NSString).lastPathComponent
            guard Self.validWorktree(name) else { continue }
            found.append((wtPath, name, branch))
        }
        // Copies dont le travail est déjà fusionné : remises sur la branche principale, une à la fois
        // (elles partagent la configuration du dépôt), jamais pendant qu'un agent ou une publication y travaille.
        var recycled: [[String: String]] = []
        for (i, f) in found.enumerated() where !Agents.shared.busy(project: id, worktree: f.name) && !Orchestrator.shared.busy(project: id, worktree: f.name) {
            if let old = recycleIfDelivered(f.path, fetch: false) {
                recycled.append(["worktree": f.name, "branch": old])
                found[i].branch = currentBranch(f.path) ?? f.branch
            }
        }
        // Chaque copie est examinée en parallèle (plusieurs commandes git par copie : en série, l'écran ralentissait).
        var rows = [[String: Any]?](repeating: nil, count: found.count); let rowsLock = NSLock()
        DispatchQueue.concurrentPerform(iterations: found.count) { i in
            let (wtPath, name, branch) = found[i]
            let status = git(["status", "--porcelain"], in: wtPath) ?? ""
            let changes = status.split(separator: "\n").count
            let counts = git(["rev-list", "--left-right", "--count", "\(base)...HEAD"], in: wtPath)?.split(whereSeparator: { $0 == "\t" || $0 == " " || $0 == "\n" }).compactMap { Int($0) } ?? []
            let ahead = counts.count > 1 ? counts[1] : 0
            // Poussée : la branche a sa propre branche distante (pas la branche principale, que Git donne parfois comme suivi).
            let published = wasPublished(wtPath, branch: branch, base: base)
            let head = git(["rev-parse", "HEAD"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let remote = published ? (git(["rev-parse", "-q", "--verify", "@{upstream}"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") : ""
            // Déjà fusionnée dans la branche principale (le travail en cours éventuel est du nouveau travail).
            let merged = published && delivered(wtPath, rev: "HEAD", base: base)
            // Titre du commit de la copie (pour le titre de sa PR) : seulement si elle a ses propres commits.
            let subject = ahead > 0 ? (git(["log", "-1", "--format=%s"], in: wtPath)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") : ""
            let row: [String: Any] = ["name": name, "branch": branch, "changes": changes, "behind": counts.first ?? 0, "ahead": ahead,
                                      "pushed": published, "upToDate": published && !remote.isEmpty && remote == head, "merged": merged,
                                      "conflicts": status.isEmpty ? [] : conflictFiles(wtPath), "subject": subject,
                                      "history": history(dir, name: name, base: base)]
            rowsLock.lock(); rows[i] = row; rowsLock.unlock()
        }
        let out = rows.compactMap { $0 }
        return ["ok": true, "worktrees": out, "base": base, "recycled": recycled]
    }

    // MARK: Travail déjà livré, plusieurs branches par copie

    private var lastFetch: [String: Date] = [:]
    private let fetchLock = NSLock()
    /// Relit le dépôt distant si ça n'a pas été fait depuis `every` secondes (la liste des copies est relue souvent).
    func fetchIfStale(_ dir: String, every: TimeInterval = 90) {
        // Une seule clé par dépôt : les copies partagent le même dossier .git.
        let common = git(["rev-parse", "--git-common-dir"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let key = common.isEmpty ? dir : common.hasPrefix("/") ? common : dir + "/" + common
        fetchLock.lock()
        let due = lastFetch[key].map { Date().timeIntervalSince($0) >= every } ?? true
        if due { lastFetch[key] = Date() }
        fetchLock.unlock()
        if due { _ = gitRun(["fetch", "-q", "--prune", "origin"], in: dir, timeout: 15) }
    }

    func currentBranch(_ wt: String) -> String? {
        guard let b = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty, b != "HEAD" else { return nil }
        return b
    }

    /// La branche a-t-elle été poussée sous son propre nom (même si sa branche distante a été supprimée après la fusion) ?
    /// Une copie créée depuis origin/main peut « suivre » origin/main : ce n'est pas une publication.
    func wasPublished(_ wt: String, branch: String, base: String) -> Bool {
        guard !branch.isEmpty else { return false }
        let merge = git(["config", "--get", "branch.\(branch).merge"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let baseName = base.hasPrefix("origin/") ? String(base.dropFirst(7)) : base
        return !merge.isEmpty && merge != "refs/heads/" + baseName && merge != "refs/heads/main" && merge != "refs/heads/master"
    }

    /// Tout le travail commité jusqu'à `rev` est-il déjà dans `base` ? Fusion classique ou rebase (ancêtre),
    /// squash (fusionner `rev` dans `base` ne changerait rien), ou chaque commit a son équivalent dans `base`.
    func delivered(_ dir: String, rev: String, base: String) -> Bool {
        guard base != "HEAD", gitRun(["cat-file", "-e", rev + "^{commit}"], in: dir).ok else { return false }
        if gitRun(["merge-base", "--is-ancestor", rev, base], in: dir).ok { return true }
        let mt = gitRun(["merge-tree", "--write-tree", base, rev], in: dir, timeout: 15)
        if mt.ok, let tree = mt.out.split(separator: "\n").first.map({ $0.trimmingCharacters(in: .whitespaces) }),
           let bt = git(["rev-parse", base + "^{tree}"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines), tree == bt { return true }
        // Git trop ancien pour merge-tree, ou la branche principale a encore modifié les mêmes lignes depuis.
        guard let cherry = git(["cherry", base, rev], in: dir, timeout: 15) else { return false }
        let lines = cherry.split(separator: "\n")
        return !lines.isEmpty && lines.allSatisfy { $0.hasPrefix("-") }
    }

    /// Branches déjà livrées par une copie (les plus récentes d'abord), avec leur état : fusionnée ou en attente.
    /// Gardées dans la configuration locale du dépôt (studio.<copie>.delivered), jamais commitées.
    private var mergedShas = Set<String>()
    func history(_ dir: String, name: String, base: String) -> [[String: Any]] {
        let raw = git(["config", "--get-all", "studio.\(name).delivered"], in: dir) ?? ""
        let entries = raw.split(separator: "\n").compactMap { l -> (String, String, String, String)? in
            let f = l.split(separator: "\t", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            return f.count >= 3 ? (f[0], f[1], f[2], f.count > 3 ? f[3] : "") : nil
        }
        return entries.suffix(8).reversed().map { e -> [String: Any] in
            let (branch, sha, state, subject) = e
            var merged = state == "merged"
            if !merged {
                fetchLock.lock(); merged = mergedShas.contains(sha); fetchLock.unlock()
                if !merged && delivered(dir, rev: sha, base: base) {
                    merged = true
                    fetchLock.lock(); mergedShas.insert(sha); fetchLock.unlock()
                    _ = gitRun(["config", "--replace-all", "studio.\(name).delivered", [branch, sha, "merged", subject].joined(separator: "\t"), sha], in: dir)
                }
            }
            return ["branch": branch, "subject": subject, "merged": merged]
        }
    }

    /// Fait repartir une copie propre de la dernière version de la branche principale, sur une nouvelle branche.
    /// L'ancienne branche est notée dans l'historique de la copie ; supprimée en local si elle est fusionnée,
    /// gardée sinon (sa PR attend encore). Renvoie l'ancienne branche.
    func startNewBranch(_ wt: String, base: String, merged: Bool) -> String? {
        guard base != "HEAD", let old = currentBranch(wt), let sha = git(["rev-parse", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        let name = (wt as NSString).lastPathComponent
        let subject = (git(["log", "-1", "--format=%s"], in: wt) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\t", with: " ")
        var next = "worktree-" + name, n = 1
        while next == old || gitRun(["rev-parse", "-q", "--verify", "refs/heads/" + next], in: wt).ok { n += 1; next = "worktree-\(name)-\(n)" }
        let sw = gitRun(["checkout", "-q", "--no-track", "-b", next, base], in: wt, timeout: 30)
        guard sw.ok else { return nil }
        recordDelivery(wt, branch: old, sha: sha, merged: merged, subject: subject)
        let baseName = base.hasPrefix("origin/") ? String(base.dropFirst(7)) : base
        if merged && old != baseName && old != "main" && old != "master" { _ = gitRun(["branch", "-D", old], in: wt) }
        return old
    }

    /// Note une branche livrée dans l'historique de la copie.
    func recordDelivery(_ wt: String, branch: String, sha: String, merged: Bool, subject: String) {
        let name = (wt as NSString).lastPathComponent
        let clean = subject.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
        _ = gitRun(["config", "--add", "studio.\(name).delivered", [branch, sha, merged ? "merged" : "pending", clean].joined(separator: "\t")], in: wt)
    }

    /// Le travail poussé de la copie est fusionné et rien n'est en cours : elle repart de la branche principale.
    /// Rien ne peut être perdu (copie propre, tout son travail commité est dans la branche principale).
    @discardableResult
    func recycleIfDelivered(_ wt: String, fetch: Bool) -> String? {
        if fetch { fetchIfStale(wt, every: 0) }
        let base = baseRef(wt, fetch: false)
        guard base != "HEAD", let branch = currentBranch(wt), wasPublished(wt, branch: branch, base: base) else { return nil }
        guard let status = git(["status", "--porcelain", "--untracked-files=all"], in: wt), status.isEmpty else { return nil }
        guard delivered(wt, rev: "HEAD", base: base) else { return nil }
        return startNewBranch(wt, base: base, merged: true)
    }

    /// Demande de l'utilisateur : garder la branche poussée pour sa PR et repartir de la branche principale
    /// sur une nouvelle branche, dans la même copie (la discussion avec l'agent continue).
    func newBranch(_ id: String, name: String) -> [String: Any] {
        guard let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        if let s = git(["status", "--porcelain", "--untracked-files=all"], in: wt), !s.isEmpty {
            return ["ok": false, "message": "La copie a des changements non publiés : publie-les ou supprime-les d'abord."]
        }
        fetchIfStale(wt, every: 0)
        let base = baseRef(wt, fetch: false)
        guard let branch = currentBranch(wt), wasPublished(wt, branch: branch, base: base) else { return ["ok": false, "message": "Cette branche n'a pas encore été poussée."] }
        guard let old = startNewBranch(wt, base: base, merged: delivered(wt, rev: "HEAD", base: base)) else { return ["ok": false, "message": "Nouvelle branche impossible."] }
        return ["ok": true, "previous": old, "branch": currentBranch(wt) ?? ""]
    }

    /// Branche principale distante (origin/main en général), à jour si `fetch` ; HEAD du dépôt à défaut de dépôt distant.
    func baseRef(_ dir: String, fetch: Bool) -> String {
        if fetch { _ = gitRun(["fetch", "-q", "--prune", "origin"], in: dir, timeout: 60) }
        if let b = git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], in: dir)?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty { return b }
        for b in ["origin/main", "origin/master"] where gitRun(["rev-parse", "-q", "--verify", b], in: dir).ok { return b }
        return "HEAD"
    }

    /// Crée la copie isolée d'un agent à partir de la dernière version de la branche principale distante,
    /// jamais de la branche sur laquelle se trouve le dossier de l'utilisateur (sinon l'agent part d'une base périmée
    /// ou d'une autre branche, et sa PR arrive avec des conflits).
    func createWorktree(_ dir: String, name: String) -> (path: String?, error: String) {
        guard Self.validWorktree(name) else { return (nil, "Nom de copie invalide.") }
        excludeWorktrees(dir)
        let base = baseRef(dir, fetch: true), wt = dir + "/.claude/worktrees/" + name
        // --no-track : la branche de l'agent ne « suit » pas la branche principale (sinon elle paraîtrait déjà poussée).
        let r = gitRun(["worktree", "add", "-q", "--no-track", "-b", "worktree-" + name, wt, base], in: dir, timeout: 60)
        return r.ok ? (wt, "") : (nil, "Copie isolée impossible : \(Self.gitError(r.err))")
    }

    /// Recrée, à son ancien emplacement, la copie isolée d'une discussion qui a été supprimée (souvent après publication),
    /// pour pouvoir la reprendre : Claude Code retrouve la session par son dossier. La copie reprend la branche de la
    /// discussion si elle existe encore (en local, sinon poussée sur GitHub et pas encore supprimée après fusion) ;
    /// à défaut, elle part de la dernière version de la branche principale, sur une nouvelle branche.
    func restoreWorktree(_ dir: String, name: String, branch: String) -> (branch: String?, reused: Bool, error: String) {
        guard Self.validWorktree(name) else { return (nil, false, "Nom de copie invalide.") }
        excludeWorktrees(dir)
        // Une copie effacée à la main reste inscrite dans le dépôt et bloquerait son emplacement.
        _ = gitRun(["worktree", "prune"], in: dir)
        let base = baseRef(dir, fetch: true), wt = dir + "/.claude/worktrees/" + name
        let baseName = base.hasPrefix("origin/") ? String(base.dropFirst(7)) : base
        if Self.validBranch(branch) && branch != baseName && branch != "main" && branch != "master" {
            if gitRun(["rev-parse", "-q", "--verify", "refs/heads/" + branch], in: dir).ok {
                if gitRun(["worktree", "add", "-q", wt, branch], in: dir, timeout: 60).ok { return (branch, true, "") }
            } else if gitRun(["rev-parse", "-q", "--verify", "refs/remotes/origin/" + branch], in: dir).ok {
                if gitRun(["worktree", "add", "-q", "--track", "-b", branch, wt, "origin/" + branch], in: dir, timeout: 60).ok { return (branch, true, "") }
            }
        }
        var next = "worktree-" + name, n = 1
        while gitRun(["rev-parse", "-q", "--verify", "refs/heads/" + next], in: dir).ok { n += 1; next = "worktree-\(name)-\(n)" }
        let r = gitRun(["worktree", "add", "-q", "--no-track", "-b", next, wt, base], in: dir, timeout: 60)
        return r.ok ? (next, false, "") : (nil, false, "Copie isolée impossible : \(Self.gitError(r.err))")
    }

    /// Fichiers modifiés de la copie qui contiennent encore des marqueurs de conflit.
    func conflictFiles(_ wt: String) -> [String] {
        let status = git(["status", "--porcelain", "--untracked-files=all"], in: wt) ?? ""
        var out: [String] = []
        for line in status.split(separator: "\n") where line.count > 3 {
            var f = String(line.dropFirst(3))
            if let r = f.range(of: " -> ") { f = String(f[r.upperBound...]) }
            if f.hasPrefix("\"") { continue } // nom exotique : ignoré
            guard let data = FileManager.default.contents(atPath: wt + "/" + f), data.count < 2_000_000, let text = String(data: data, encoding: .utf8) else { continue }
            if text.split(separator: "\n", omittingEmptySubsequences: false).contains(where: { $0.hasPrefix("<<<<<<< ") || $0.hasPrefix(">>>>>>> ") }) { out.append(f) }
        }
        return out
    }

    /// Remet le travail de la copie (commits et changements en cours) par-dessus la dernière version de la branche principale.
    /// Tout le travail de l'agent devient des changements non commités sur cette base : jamais de commit de fusion,
    /// et le commit final portera le vrai message. En cas de conflit, les fichiers gardent les marqueurs <<<<<<< / >>>>>>>,
    /// que l'agent sait corriger avec ses outils d'édition (il n'a pas accès à git).
    func syncWorktree(_ wt: String) -> [String: Any] {
        let base = baseRef(wt, fetch: true)
        if base == "HEAD" { return ["ok": true, "base": base, "updated": false, "conflicts": []] }
        if gitRun(["merge-base", "--is-ancestor", base, "HEAD"], in: wt).ok { return ["ok": true, "base": base, "updated": false, "conflicts": conflictFiles(wt)] }
        let left = conflictFiles(wt)
        if !left.isEmpty { return ["ok": false, "base": base, "conflicts": left, "message": "Résous d'abord les conflits en cours."] }
        guard let mb = git(["merge-base", "HEAD", base], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !mb.isEmpty else {
            return ["ok": false, "base": base, "conflicts": [], "message": "Aucun ancêtre commun avec \(base)."]
        }
        // Toute erreur après ce point remet la copie exactement dans son état de départ (contenu identique, sur `mb`).
        let restore: (String) -> [String: Any] = { why in
            _ = self.gitRun(["reset", "-q", "--hard", mb], in: wt, timeout: 30)
            let back = self.gitRun(["stash", "pop", "-q"], in: wt, timeout: 30)
            return ["ok": false, "base": base, "conflicts": [], "message": why + (back.ok ? " La copie n'a pas été modifiée." : " Ton travail est conservé dans « git stash list ».")]
        }
        let steps: [[String]] = [["add", "-A"], ["reset", "-q", "--soft", mb]]
        for a in steps { let r = gitRun(a, in: wt, timeout: 30); if !r.ok { return ["ok": false, "base": base, "conflicts": [], "message": Self.gitError(r.err)] } }
        let hasWork = !gitRun(["diff", "--cached", "--quiet"], in: wt).ok
        if !hasWork {
            let r = gitRun(["reset", "-q", "--hard", base], in: wt, timeout: 30)
            return r.ok ? ["ok": true, "base": base, "updated": true, "conflicts": []] : ["ok": false, "base": base, "conflicts": [], "message": Self.gitError(r.err)]
        }
        let stash = gitRun(["stash", "push", "-q", "-m", "studio: synchronisation de la copie"], in: wt, timeout: 30)
        guard stash.ok else { return ["ok": false, "base": base, "conflicts": [], "message": Self.gitError(stash.err)] }
        let reset = gitRun(["reset", "-q", "--hard", base], in: wt, timeout: 30)
        guard reset.ok else { return restore("Mise à jour impossible : \(Self.gitError(reset.err)).") }
        let pop = gitRun(["stash", "pop", "-q"], in: wt, timeout: 30)
        if pop.ok { return ["ok": true, "base": base, "updated": true, "conflicts": []] }
        // Conflit : les marqueurs sont dans les fichiers ; on sort de l'état « non fusionné » (le travail reste dans les fichiers).
        let unmerged = (git(["diff", "--name-only", "--diff-filter=U"], in: wt) ?? "").split(separator: "\n").map(String.init)
        if unmerged.isEmpty { return restore("Mise à jour impossible : \(Self.gitError(pop.err)).") }
        _ = gitRun(["reset", "-q"], in: wt, timeout: 30)
        _ = gitRun(["stash", "drop", "-q"], in: wt, timeout: 30)
        return ["ok": true, "base": base, "updated": true, "conflicts": unmerged]
    }

    /// Valide les changements d'une copie isolée et pousse sa branche (identifiants Git habituels de l'utilisateur).
    /// Nom de branche accepté : feat/mon-sujet, fix/…, minuscules, chiffres, « . _ - / », sans « .. » ni « / » en bord.
    static func validBranch(_ b: String) -> Bool {
        !b.isEmpty && b.count <= 90 && !b.contains("..") && !b.contains("//") && b.first != "/" && b.first != "-" && b.last != "/" && !b.hasSuffix(".lock")
            && b.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || "._-/".contains($0) }
    }

    func commitPush(_ id: String, name: String, message: String, branch wanted: String = "") -> [String: Any] {
        guard let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        if !wanted.isEmpty && !Self.validBranch(wanted) { return ["ok": false, "message": "Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf)."] }
        let msg = String(message.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        let left = conflictFiles(wt)
        if !left.isEmpty { return ["ok": false, "conflicts": left, "message": "Conflits non résolus : \(left.joined(separator: ", "))."] }
        if !(git(["status", "--porcelain"], in: wt) ?? "").isEmpty {
            guard !msg.isEmpty else { return ["ok": false, "message": "Message de commit vide."] }
            let add = gitRun(["add", "-A"], in: wt, timeout: 30)
            let commit = add.ok ? gitRun(["commit", "-q", "-m", msg], in: wt, timeout: 30) : add
            guard commit.ok else { return ["ok": false, "message": "Le commit a échoué : \(Self.gitError(commit.err))"] }
        }
        guard var branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty, branch != "HEAD" else {
            return ["ok": false, "message": "Branche introuvable."]
        }
        // Nom lisible (feat/…, fix/…) à la place de « worktree-studio-… » donné par Claude Code.
        if !wanted.isEmpty && wanted != branch {
            let mv = gitRun(["branch", "-m", wanted], in: wt)
            guard mv.ok else { return ["ok": false, "message": "Renommage de la branche impossible : \(Self.gitError(mv.err))"] }
            branch = wanted
        }
        // La copie a pu être remise sur la dernière version de la branche principale : son historique a changé.
        // --force-with-lease ne remplace la branche distante que si personne d'autre ne l'a modifiée entre-temps.
        let push = gitRun(["push", "-u", "--force-with-lease", "origin", branch], in: wt, timeout: 90)
        guard push.ok else {
            let why = Self.gitError(push.err)
            let auth = why.lowercased().contains("auth") || why.contains("403") || why.contains("could not read") || why.contains("Permission denied")
            return ["ok": false, "message": "Le push a échoué" + (why.isEmpty ? "." : " : \(why)") + (auth ? " — dans le Terminal, lance une fois « git push » dans ce dépôt pour enregistrer tes identifiants." : "")]
        }
        return ["ok": true, "branch": branch]
    }

    /// Supprime une copie isolée et sa branche locale (la branche poussée sur GitHub reste).
    func removeWorktree(_ id: String, name: String) -> [String: Any] {
        guard let dir = path(id), let wt = worktreeDir(id, name) else { return ["ok": false, "message": "Copie introuvable."] }
        let branch = git(["rev-parse", "--abbrev-ref", "HEAD"], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        _ = git(["worktree", "unlock", wt], in: dir)
        guard git(["worktree", "remove", "--force", wt], in: dir, timeout: 30) != nil else { return ["ok": false, "message": "Suppression impossible."] }
        // La copie « studio-… » a été créée par Studio : sa branche locale aussi (même renommée en feat/…).
        if name.hasPrefix("studio-") && !branch.isEmpty && branch != "HEAD" { _ = git(["branch", "-D", branch], in: dir) }
        // Branches livrées plus tôt par cette copie : déjà poussées, leurs copies locales ne servent plus.
        if name.hasPrefix("studio-") {
            let raw = git(["config", "--get-all", "studio.\(name).delivered"], in: dir) ?? ""
            for l in raw.split(separator: "\n") {
                guard let b = l.split(separator: "\t").first.map(String.init), b != "main", b != "master" else { continue }
                _ = git(["branch", "-D", b], in: dir)
            }
        }
        _ = git(["config", "--remove-section", "studio.\(name)"], in: dir)
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
