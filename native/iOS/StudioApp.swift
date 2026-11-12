// Studio pour iPhone et iPad : l'application embarquée en plein écran.
import SwiftUI
import WebKit

@main
struct StudioApp: App {
    @Environment(\.scenePhase) private var phase
    @StateObject private var model = WebModel()

    var body: some Scene {
        WindowGroup {
            WebContainer(model: model)
                .ignoresSafeArea()
                .background(Color(UIColor { $0.userInterfaceStyle == .dark ? WebModel.darkFrame : WebModel.lightFrame }).ignoresSafeArea())
                .preferredColorScheme(model.dark.map { $0 ? .dark : .light })
        }
        // En passant en arrière-plan, on enregistre ce qui est en cours de frappe.
        .onChange(of: phase) { newPhase in
            if newPhase != .active { model.shell.flush {} }
        }
    }
}

final class WebModel: ObservableObject {
    static let darkFrame = UIColor(red: 0x08 / 255, green: 0x09 / 255, blue: 0x0A / 255, alpha: 1)
    static let lightFrame = UIColor(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF3 / 255, alpha: 1)

    let shell = ShellCoordinator()
    @Published var dark: Bool?

    lazy var web: WKWebView = {
        Notifier.shared.setUp()
        let web = Shell.makeWebView(coordinator: shell)
        web.scrollView.contentInsetAdjustmentBehavior = .never // la page gère elle-même les zones sûres (encoche, barre d'accueil)
        web.isOpaque = false
        web.backgroundColor = .clear
        shell.onTheme = { [weak self] dark in DispatchQueue.main.async { self?.dark = dark } }
        web.load(URLRequest(url: Shell.start))
        return web
    }()
}

struct WebContainer: UIViewRepresentable {
    let model: WebModel
    func makeUIView(context: Context) -> WKWebView { model.web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
