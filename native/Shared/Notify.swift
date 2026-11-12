// Notifications système et pastille de l'icône, demandées par la page (notifications Linear).
// Tout est local : la page interroge Linear elle-même, l'app ne fait qu'afficher.
import Foundation
import UserNotifications
#if os(macOS)
import AppKit
#else
import UIKit
#endif

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private var asked = false

    func setUp() { UNUserNotificationCenter.current().delegate = self }

    func post(title: String, body: String, url: String?) {
        let center = UNUserNotificationCenter.current()
        let send = {
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.sound = .default
            c.threadIdentifier = "linear"
            if let url, url.hasPrefix("https://linear.app/") { c.userInfo = ["url": url] }
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
        if asked { send(); return }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            self.asked = true
            if ok { send() }
        }
    }

    func badge(_ count: Int) {
        DispatchQueue.main.async {
            #if os(macOS)
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
            #else
            if #available(iOS 17, *) { UNUserNotificationCenter.current().setBadgeCount(count) }
            else { UIApplication.shared.applicationIconBadgeNumber = count }
            #endif
        }
    }

    // Afficher aussi quand l'app est au premier plan (la page décide d'appeler ou non).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }

    // Clic sur une notification : ouvre l'issue dans Linear (navigateur ou app Linear).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s) {
            DispatchQueue.main.async {
                #if os(macOS)
                NSWorkspace.shared.open(url)
                #else
                UIApplication.shared.open(url)
                #endif
            }
        }
        done()
    }
}
