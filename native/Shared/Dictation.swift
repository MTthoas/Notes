// Notes vocales : transcription faite sur l'appareil (jamais envoyée à un serveur).
// La page demande { type: "voice", action: "start" | "stop" | "cancel" } et reçoit window.carnet.voice({...}).
import Foundation
import Speech
import AVFoundation

final class Dictation {
    static let shared = Dictation()
    var send: (([String: Any]) -> Void)?

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var committed = ""
    private var current = ""
    private var running = false
    private var failures = 0

    private var text: String { [committed, current].filter { !$0.isEmpty }.joined(separator: " ") }

    func start(locale: String) {
        guard !running else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { return self.fail("Autorise la reconnaissance vocale pour Studio dans les Réglages du système.") }
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { ok ? self.begin(locale) : self.fail("Autorise le micro pour Studio dans les Réglages du système.") }
            }
        }
    }

    private func begin(_ locale: String) {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)), r.isAvailable else { return fail("La reconnaissance vocale n'est pas disponible pour cette langue.") }
        // Confidentialité : sans modèle sur l'appareil, on refuse plutôt que d'envoyer la voix à un serveur.
        guard r.supportsOnDeviceRecognition else { return fail("La dictée hors ligne n'est pas installée pour le français. Active la dictée dans les réglages du clavier, puis réessaie.") }
        recognizer = r
        committed = ""; current = ""; failures = 0
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { return fail("Aucun micro disponible.") }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in self?.request?.append(buffer) }
            engine.prepare()
            try engine.start()
        } catch { return fail("Impossible d'ouvrir le micro : \(error.localizedDescription)") }
        running = true
        newTask()
        send?(["state": "listening"])
    }

    // Le système clôt parfois une reconnaissance après un silence : on enchaîne sur une nouvelle en gardant le texte.
    private func newTask() {
        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        if #available(iOS 16, macOS 13, *) { req.addsPunctuation = true }
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.request === req else { return }
                if let result {
                    self.failures = 0
                    self.current = result.bestTranscription.formattedString
                    if self.running { self.send?(["state": "partial", "text": self.text]) }
                    if result.isFinal { self.commit(); if self.running { self.newTask() } }
                } else if error != nil {
                    self.commit()
                    self.failures += 1
                    if self.running { self.failures < 4 ? self.newTask() : self.finish(error: "La reconnaissance vocale s'est interrompue.") }
                }
            }
        }
    }

    private func commit() {
        if !current.isEmpty { committed = text; current = "" }
    }

    func stop(cancel: Bool) {
        guard running else { return }
        if cancel { running = false; teardown(); task?.cancel(); send?(["state": "cancelled"]); return }
        running = false
        engine.stop(); engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // Laisse au moteur le temps de rendre les derniers mots.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.finish(error: nil) }
    }

    private func finish(error: String?) {
        running = false
        commit()
        teardown()
        task?.cancel(); task = nil; request = nil
        if let error, committed.isEmpty { send?(["state": "error", "message": error]) } else { send?(["state": "final", "text": committed]) }
    }

    private func teardown() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func fail(_ message: String) {
        DispatchQueue.main.async { self.running = false; self.send?(["state": "error", "message": message]) }
    }
}
