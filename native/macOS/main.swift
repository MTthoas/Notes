// Studio pour macOS : une fenêtre, l'application embarquée, des menus natifs.
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private let shell = ShellCoordinator()
    private let selfTest = ProcessInfo.processInfo.environment["CARNET_SELFTEST"] != nil

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        Notifier.shared.setUp()
        web = Shell.makeWebView(coordinator: shell, ephemeral: selfTest)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Studio"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 420, height: 480)
        // La barre de titre prend la couleur du cadre de l'application, en clair comme en sombre.
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x08 / 255, green: 0x09 / 255, blue: 0x0A / 255, alpha: 1)
                : NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF3 / 255, alpha: 1)
        }
        web.setValue(false, forKey: "drawsBackground")
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("Studio")
        // Le thème choisi dans Studio (clair, sombre, système) pilote aussi la fenêtre.
        shell.onTheme = { [weak self] dark in self?.window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        if selfTest { shell.onLoad = { [weak self] in self?.runSelfTest() } }
        web.load(URLRequest(url: Shell.start))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Avant de quitter : on laisse la page enregistrer ce qui est en cours de frappe.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        shell.flush { NSApp.reply(toApplicationShouldTerminate: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    @objc private func openSettings() { web.evaluateJavaScript("window.carnet?.settings?.()") }
    @objc private func reload() { web.reload() }

    private func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(); let menu = NSMenu(title: title)
            items.forEach(menu.addItem); item.submenu = menu; main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key); i.keyEquivalentModifierMask = mods; i.target = target; return i
        }
        submenu("Studio", [
            item("À propos de Studio", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Réglages…", #selector(openSettings), ",", target: self),
            .separator(),
            item("Masquer Studio", #selector(NSApplication.hide(_:)), "h"),
            item("Masquer les autres", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Tout afficher", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quitter Studio", #selector(NSApplication.terminate(_:)), "q"),
        ])
        // Sans ce menu, ⌘C / ⌘V / ⌘Z ne fonctionnent pas dans la vue web.
        submenu("Édition", [
            item("Annuler", Selector(("undo:")), "z"),
            item("Rétablir", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Couper", #selector(NSText.cut(_:)), "x"),
            item("Copier", #selector(NSText.copy(_:)), "c"),
            item("Coller", #selector(NSText.paste(_:)), "v"),
            item("Tout sélectionner", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("Présentation", [
            item("Recharger", #selector(reload), "r", [.command, .shift], target: self),
            item("Plein écran", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        submenu("Fenêtre", [
            item("Réduire", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Fermer", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }

    // Auto-test (CARNET_SELFTEST=1) : vérifie dans la vraie vue web que le chiffrement, le stockage
    // et le démarrage fonctionnent, sur un stockage éphémère, puis quitte.
    private func runSelfTest() {
        let js = """
        const r = { secure: isSecureContext, subtle: !!(crypto && crypto.subtle), webrtc: 'RTCPeerConnection' in window };
        await new Promise(res => setTimeout(res, 800));
        r.booted = !!document.querySelector('#sidebar .ws');
        try { localStorage.setItem('t', '1'); r.localStorage = localStorage.getItem('t') === '1'; } catch (e) { r.localStorage = String(e); }
        try {
          const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), iv = crypto.getRandomValues(new Uint8Array(12));
          const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode('ok'));
          r.aes = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct)) === 'ok';
        } catch (e) { r.aes = String(e); }
        r.indexedDB = await new Promise(res => { const q = indexedDB.open('carnet'); q.onsuccess = () => res(q.result.objectStoreNames.contains('notes')); q.onerror = () => res(String(q.error)); });
        r.notesShown = document.querySelectorAll('#list .note-item, .hm-note').length;
        try { r.github = (await fetch('https://api.github.com/zen', { credentials: 'omit' })).status; } catch (e) { r.github = String(e); }
        const pid = '\(ProcessInfo.processInfo.environment["CARNET_SELFTEST_PROJECT"] ?? "")';
        let seq = 424240;
        const ask = (action, extra, type = 'project', wait = 15000) => new Promise(res => {
          const id = ++seq, prev = window.carnet.reply;
          window.carnet.reply = p => { if (p && p.id === id) { window.carnet.reply = prev; res(p); } else prev(p); };
          window.webkit.messageHandlers.carnet.postMessage({ type, action, id, project: pid, ...extra });
          setTimeout(() => res('pas de réponse'), wait);
        });
        if ('\(ProcessInfo.processInfo.environment["CARNET_SELFTEST_AGENT"] ?? "")' && pid) {
          const st = await ask('start', { mode: 'edit', prompt: 'Crée le fichier hello.md contenant « Bonjour de Studio ». Puis essaie de lancer la commande « touch pirate.txt ».', model: 'haiku' }, 'agent', 120000);
          r.agentStart = { ok: st.ok, status: st.status, session: !!st.session, worktree: st.worktree, message: st.message };
          let fin = null;
          for (let i = 0; i < 90 && st.ok; i++) { await new Promise(z => setTimeout(z, 2000)); const l = await ask('list', {}, 'agent'); fin = (l.runs || []).find(x => x.run === st.run); if (fin && !['running', 'starting'].includes(fin.status)) break; }
          r.agentEnd = fin && { status: fin.status, turns: fin.turns, denials: fin.denials, result: (fin.result || '').slice(0, 160) };
          const w = await ask('worktrees', {}, 'agent'); r.worktrees = w.worktrees;
          const ss = await ask('sessions', {}); r.agentSessions = (ss.sessions || []).map(x => ({ title: x.title, worktree: x.worktree }));
          const dly = await ask('daily', { days: 30 }, 'agent'); r.daily = dly.tokens;
          const cm = await ask('commits', { days: 30 }, 'agent'); r.commits = cm.days;
          const df = await ask('diff', { scope: 'working', worktree: st.worktree }); r.wtDiff = df.ok ? { untracked: df.untracked } : df.message;
          if (st.worktree) { const del = await ask('discard', { worktree: st.worktree }, 'agent'); r.discard = del.ok; }
        }
        if ('\(ProcessInfo.processInfo.environment["CARNET_SELFTEST_CLAUDE"] ?? "")') {
          const st = await ask('status', {}, 'claude', 40000); r.claudeStatus = { installed: st.installed, loggedIn: st.loggedIn, plan: st.plan, version: st.version, source: st.source, path: st.path };
          const t0 = Date.now(), x = await ask('run', { run: 'selftest-1', system: 'Tu es concis.', prompt: 'Réponds uniquement : ok', model: 'haiku' }, 'claude', 120000);
          r.claudeRun = { ok: x.ok, text: x.text, models: x.models, message: x.message, ms: Date.now() - t0 };
          const y = await ask('run', { run: 'selftest-2', system: 'Outils : creer_tache(texte).', prompt: 'Crée la tâche « Tester Studio ». Si tu appelles un outil, laisse reponse vide.', model: 'haiku', tools: true }, 'claude', 120000);
          r.claudeTools = { ok: y.ok, structured: y.structured, message: y.message };
        }
        if (pid) {
          r.project = await ask('info', {});
          const b = await ask('branches', {}); r.branches = b.ok ? (b.branches || []).length : b;
          const d = await ask('diff', { scope: 'working' }); r.diff = d.ok ? { lines: String(d.patch || '').split('\\n').length, base: d.base } : d;
          const s = await ask('sessions', {}); r.sessions = s.ok ? { found: s.found, count: (s.sessions || []).length, first: s.sessions && s.sessions[0] ? { title: s.sessions[0].title, live: s.sessions[0].live, output: s.sessions[0].tokens.output } : null, quota: s.quota ? s.quota.status : null } : s;
          if (s.sessions && s.sessions[0]) { const one = await ask('session', { session: s.sessions[0].id }); r.session = one.ok ? { actions: (one.actions || []).length, files: (one.files || []).length } : one; }
          const w = await ask('site', { url: 'https://github.com' }); r.site = w.ok ? { up: w.up, status: w.status } : w;
          const bad = await ask('site', { url: 'http://127.0.0.1' }); r.siteRefusesLocal = !bad.ok;
        }
        try { r.ntfy = (await fetch('https://ntfy.sh/carnet-autotest-' + crypto.randomUUID(), { method: 'POST', body: 'x', headers: { Cache: 'no' } })).status; } catch (e) { r.ntfy = String(e); }
        try { r.anthropic = (await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-api-key': 'cle-invalide', 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' } })).status; } catch (e) { r.anthropic = String(e); }
        return JSON.stringify(r);
        """
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): print("SELFTEST", v)
            case .failure(let e): print("SELFTEST-ERROR", e)
            }
            fflush(stdout)
            exit(0)
        }
    }
}

@main
enum StudioMain {
    private static let delegate = AppDelegate() // NSApplication ne garde qu'une référence faible
    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
