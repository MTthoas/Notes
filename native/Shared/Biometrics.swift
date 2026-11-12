// Touch ID / Face ID pour ouvrir le coffre.
// Principe : au moment de l'activation, la page génère un secret aléatoire de 256 bits qui emballe la clé du coffre.
// Ce secret est gardé dans le trousseau du système et n'est rendu à la page qu'après une vérification biométrique.
// Le mot de passe du coffre n'est jamais stocké, et reste toujours utilisable.
//   iPhone / iPad : l'élément du trousseau est lié à la biométrie (ajouter une empreinte l'invalide).
//   Mac : le trousseau « session » protège l'élément pour cette app ; la biométrie est demandée par l'app avant la lecture.
import Foundation
import LocalAuthentication
import Security

final class Biometrics {
    static let shared = Biometrics()
    private let service = "app.carnet.notes.vault"
    private let account = "biometric-unlock"

    struct Failure: Error { let code: String; let message: String }

    // MARK: État
    func status() -> [String: Any] {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            return ["ok": true, "available": false, "kind": "", "reason": Self.reason(err)]
        }
        return ["ok": true, "available": true, "kind": Self.kind(ctx), "reason": ""]
    }

    private static func kind(_ ctx: LAContext) -> String {
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default:
            if #available(iOS 17, macOS 14, *), ctx.biometryType == .opticID { return "Optic ID" }
            return "biométrie"
        }
    }

    private static func reason(_ e: NSError?) -> String {
        guard let e, let code = LAError.Code(rawValue: e.code) else { return "La biométrie n'est pas disponible sur cet appareil." }
        switch code {
        case .biometryNotEnrolled: return "Aucune empreinte ou visage n'est enregistré dans les réglages du système."
        case .biometryLockout: return "La biométrie est verrouillée : déverrouille d'abord l'appareil avec son code."
        case .passcodeNotSet: return "Définis d'abord un code de verrouillage sur cet appareil."
        default: return "La biométrie n'est pas disponible sur cet appareil."
        }
    }

    // MARK: Trousseau
    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func remove() { SecItemDelete(query() as CFDictionary) }

    func store(_ secret: Data) throws {
        // Vérifie d'abord que la personne peut s'authentifier : on n'active pas ce qu'on ne pourra pas utiliser.
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else { throw Failure(code: "unavailable", message: Self.reason(err)) }
        remove()
        var q = query()
        q[kSecValueData as String] = secret
        #if os(iOS)
        var cf: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &cf) else {
            throw Failure(code: "unavailable", message: "Définis d'abord un code de verrouillage sur cet appareil.")
        }
        q[kSecAttrAccessControl as String] = access
        #endif
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure(code: "keychain", message: "Le trousseau a refusé l'enregistrement (code \(status)).") }
    }

    // MARK: Déverrouillage
    func unlock(reason: String, done: @escaping (Result<Data, Failure>) -> Void) {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "" // pas de repli sur le mot de passe du système : le mot de passe du coffre reste dans la page
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else { return done(.failure(Failure(code: "unavailable", message: Self.reason(err)))) }
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
            guard ok else {
                let code = (error as? LAError)?.code
                let cancelled = code == .userCancel || code == .appCancel || code == .systemCancel || code == .userFallback
                return done(.failure(Failure(code: cancelled ? "cancel" : "denied", message: cancelled ? "Authentification annulée." : "Empreinte ou visage non reconnu.")))
            }
            var q = self.query()
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            q[kSecUseAuthenticationContext as String] = ctx
            var item: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &item)
            if status == errSecSuccess, let data = item as? Data { return done(.success(data)) }
            if status == errSecItemNotFound { return done(.failure(Failure(code: "notfound", message: "Le déverrouillage biométrique n'est plus valable (empreintes modifiées ?). Réactive-le dans Réglages → Sécurité."))) }
            done(.failure(Failure(code: "keychain", message: "Le trousseau n'a pas rendu le secret (code \(status)).")))
        }
    }
}
