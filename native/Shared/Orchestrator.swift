// Orchestrateur des copies d'agents (Mac uniquement).
// Publier ou mettre à jour une copie n'est plus une suite de gestes à la main : Studio enchaîne seul
//   1. la mise à jour de la copie sur la dernière version de la branche principale distante (sans commit de fusion) ;
//   2. en cas de conflit, la reprise de la session de l'agent qui a écrit la copie pour qu'il les résolve (2 essais) ;
//   3. la vérification qu'aucun marqueur de conflit ne reste ;
//   4. un seul commit avec le vrai message, puis le push (--force-with-lease).
// Si l'agent ne peut pas résoudre, la tâche s'arrête en « à toi de jouer » avec la liste des fichiers.
// Une seule tâche à la fois par copie ; elle continue même si la fenêtre de publication est fermée.
import Foundation
#if os(macOS)

final class Orchestrator {
    static let shared = Orchestrator()

    final class Job {
        let id = UUID().uuidString, project: String, worktree: String, kind: String   // kind : publish | sync
        var status = "running"                 // running | done | error | blocked
        var step = "Préparation"
        var log: [String] = []
        var conflicts: [String] = []
        var branch = "", message = "", run = ""
        init(project: String, worktree: String, kind: String) { self.project = project; self.worktree = worktree; self.kind = kind }
    }
    private var jobs: [String: Job] = [:]
    private let lock = NSLock()
    private let maxAttempts = 2
    private let agentTimeout: TimeInterval = 30 * 60

    private func summary(_ j: Job) -> [String: Any] {
        ["ok": true, "job": j.id, "kind": j.kind, "worktree": j.worktree, "status": j.status, "step": j.step,
         "log": j.log, "conflicts": j.conflicts, "branch": j.branch, "message": j.message, "run": j.run]
    }
    private func set(_ j: Job, _ change: (Job) -> Void) { lock.lock(); change(j); lock.unlock() }
    private func note(_ j: Job, _ step: String) { set(j) { $0.step = step; $0.log.append(step) } }

    /// Une tâche est-elle en cours sur cette copie ? (on ne la supprime pas en plein travail)
    func busy(project: String, worktree: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return jobs.values.contains { $0.project == project && $0.worktree == worktree && $0.status == "running" }
    }

    func job(_ id: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let j = jobs[id] else { return ["ok": false, "message": "Tâche introuvable."] }
        return summary(j)
    }
    /// Tâches en cours ou récentes d'un projet (la plus récente par copie).
    func list(project: String) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["ok": true, "jobs": jobs.values.filter { $0.project == project }.map(summary)]
    }

    /// Lance une publication (message et branche choisis par l'utilisateur) ou une simple mise à jour.
    func start(kind: String, project pid: String, worktree name: String, message: String = "", branch: String = "") -> [String: Any] {
        let folders = ProjectFolders.shared
        guard let dir = folders.path(pid), let wt = folders.worktreeDir(pid, name) else { return ["ok": false, "message": "Copie introuvable."] }
        if !branch.isEmpty && !ProjectFolders.validBranch(branch) { return ["ok": false, "message": "Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf)."] }
        if kind == "publish" && message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return ["ok": false, "message": "Message de commit vide."] }
        if Agents.shared.busy(project: pid, worktree: name) { return ["ok": false, "message": "Un agent travaille encore dans cette copie : attends qu'il ait fini, ou arrête-le."] }
        lock.lock()
        if let busy = jobs.values.first(where: { $0.project == pid && $0.worktree == name && $0.status == "running" }) { lock.unlock(); return summary(busy) }
        jobs = jobs.filter { $0.value.project != pid || $0.value.worktree != name }
        let j = Job(project: pid, worktree: name, kind: kind)
        jobs[j.id] = j
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { self.execute(j, dir: dir, wt: wt, message: message, branch: branch) }
        return job(j.id)
    }

    private func execute(_ j: Job, dir: String, wt: String, message: String, branch: String) {
        let folders = ProjectFolders.shared
        let fail: (String) -> Void = { m in self.set(j) { $0.status = "error"; $0.step = m; $0.log.append(m) } }

        // Copie déjà publiée : son message d'origine servira à re-valider le travail après la mise à jour.
        let pushed = folders.gitRun(["rev-parse", "--abbrev-ref", "@{upstream}"], in: wt).ok
        let dirty = !(folders.git(["status", "--porcelain"], in: wt) ?? "").isEmpty
        let base0 = folders.baseRef(wt, fetch: false)
        let firstCommit = folders.git(["rev-list", "--reverse", "\(base0)..HEAD"], in: wt)?.split(separator: "\n").first.map(String.init)
        let previous = firstCommit.flatMap { folders.git(["log", "-1", "--format=%B", $0], in: wt)?.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""

        note(j, "Mise à jour sur la dernière version de la branche principale…")
        var sync = folders.syncWorktree(wt)
        guard sync["ok"] as? Bool == true else { return fail(sync["message"] as? String ?? "Mise à jour impossible.") }
        let base = sync["base"] as? String ?? "origin/main"
        var conflicts = sync["conflicts"] as? [String] ?? []
        note(j, sync["updated"] as? Bool == true ? "Copie remise sur \(base)." : "Copie déjà à jour avec \(base).")

        var attempt = 0
        while !conflicts.isEmpty {
            set(j) { $0.conflicts = conflicts }
            guard attempt < maxAttempts else { break }
            attempt += 1
            guard let session = ClaudeSessions.shared.latest(project: dir, worktree: j.worktree) else {
                note(j, "Aucune session d'agent pour cette copie : résolution à la main."); break
            }
            note(j, "Conflits dans \(conflicts.count) fichier\(conflicts.count > 1 ? "s" : "") : l'agent les résout (essai \(attempt)/\(maxAttempts))…")
            let started = startAgent(project: j.project, session: session, prompt: Self.resolvePrompt(base: base, files: conflicts))
            guard let runId = started["run"] as? String, started["ok"] as? Bool == true else {
                note(j, "L'agent n'a pas pu être relancé : \(started["message"] as? String ?? "raison inconnue")."); break
            }
            set(j) { $0.run = runId }
            let end = Agents.shared.wait(runId, timeout: agentTimeout)
            if end["status"] as? String != "done" { note(j, "L'agent s'est arrêté avant la fin (\(end["status"] as? String ?? "?"))."); break }
            conflicts = folders.conflictFiles(wt)
            // La branche principale a pu bouger pendant ce temps : on remet la copie à jour une fois de plus.
            if conflicts.isEmpty {
                sync = folders.syncWorktree(wt)
                guard sync["ok"] as? Bool == true else { return fail(sync["message"] as? String ?? "Mise à jour impossible.") }
                conflicts = sync["conflicts"] as? [String] ?? []
            }
        }
        if !conflicts.isEmpty {
            set(j) { $0.status = "blocked"; $0.conflicts = conflicts; $0.step = "À toi de jouer : conflits à résoudre dans \(conflicts.joined(separator: ", "))."; $0.log.append($0.step) }
            return
        }
        set(j) { $0.conflicts = [] }

        // Publication : un seul commit avec le message choisi. Mise à jour d'une copie déjà publiée : même message qu'avant.
        let msg = j.kind == "publish" ? message : previous
        // Mise à jour : on ne republie automatiquement que ce qui l'était déjà (pas de travail en cours non relu).
        if j.kind == "sync" && !(pushed && !dirty && !msg.isEmpty) {
            set(j) { $0.status = "done"; $0.step = "Copie à jour, prête à être publiée."; $0.log.append($0.step) }
            return
        }
        note(j, "Commit et push…")
        let r = folders.commitPush(j.project, name: j.worktree, message: msg, branch: j.kind == "publish" ? branch : "")
        guard r["ok"] as? Bool == true else {
            if let c = r["conflicts"] as? [String], !c.isEmpty { set(j) { $0.status = "blocked"; $0.conflicts = c } }
            return fail(r["message"] as? String ?? "Échec du push.")
        }
        let b = r["branch"] as? String ?? ""
        set(j) { $0.status = "done"; $0.branch = b; $0.message = msg; $0.step = "Branche \(b) poussée, à jour avec \(base)."; $0.log.append($0.step) }
    }

    private func startAgent(project: String, session: String, prompt: String) -> [String: Any] {
        let sem = DispatchSemaphore(value: 0); var out: [String: Any] = [:]
        Agents.shared.start(project: project, body: ["session": session, "prompt": prompt]) { r in out = r; sem.signal() }
        _ = sem.wait(timeout: .now() + 90)
        return out
    }

    static func resolvePrompt(base: String, files: [String]) -> String {
        """
        Studio a remis ta copie sur la dernière version de \(base) pour la publier, et des conflits sont apparus dans :
        \(files.map { "- " + $0 }.joined(separator: "\n"))

        Dans chacun de ces fichiers, entre les marqueurs : « <<<<<<< Updated upstream » … « ======= » est la version de \(base), \
        « ======= » … « >>>>>>> Stashed changes » est ton travail. Fusionne les deux à la main en gardant les intentions des deux côtés \
        (ne jette pas les changements de \(base)), puis retire tous les marqueurs. Ne modifie rien d'autre.
        Termine par un compte rendu très court, puis la ligne « Commit: … » qui décrit l'ensemble de ton travail sur cette copie.
        """
    }
}
#endif
