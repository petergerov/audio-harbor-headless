// Audio Harbor — macOS menu bar app for the headless host.
//
// Starts / stops the server installed under /usr/local/audio-harbor-headless
// (via its start.sh), shows its status, the QR code + pairing PIN for the
// iPhone remote, and opens the web remote / Settings.
//
// Build: packaging/macos/build-menubar.sh
import AppKit
import CoreImage
import ServiceManagement

// MARK: - Paths and settings

enum Paths {
    static let serverRoot: String =
        UserDefaults.standard.string(forKey: "ServerRoot") ?? "/usr/local/audio-harbor-headless"
    static var startScript: String { serverRoot + "/start.sh" }
    static let dataDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".audio-harbor-headless")
    static var config: URL { dataDir.appendingPathComponent("config.toml") }
    static var pairing: URL { dataDir.appendingPathComponent("pairing.json") }
    static var log: URL { dataDir.appendingPathComponent("harbor.log") }
}

enum Prefs {
    static let autoStartKey = "AutoStartServer"

    /// Start the server when the app opens (default on).
    static var autoStartServer: Bool {
        get { UserDefaults.standard.object(forKey: autoStartKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: autoStartKey) }
    }
}

/// A plain `key = value` from a `[section]` of config.toml (no inline tables), or nil.
func configValue(section: String, key: String) -> String? {
    guard let text = try? String(contentsOf: Paths.config, encoding: .utf8) else { return nil }
    var inSection = false
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
            .first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if line.hasPrefix("[") {
            inSection = line == "[\(section)]"
            continue
        }
        guard inSection else { continue }
        let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.count == 2, parts[0] == key { return parts[1] }
    }
    return nil
}

/// `[server] port` from config.toml, else the host's default.
func serverPort() -> Int {
    configValue(section: "server", key: "port").flatMap { Int($0.replacingOccurrences(of: "_", with: "")) } ?? 8787
}

/// `[remote] require_pairing`: remotes must enter the PIN. Off (the default) they connect without one.
func pairingRequired() -> Bool {
    configValue(section: "remote", key: "require_pairing") == "true"
}

func pairingPin() -> String? {
    guard let data = try? Data(contentsOf: Paths.pairing),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return json["pin"] as? String
}

// MARK: - Server control

enum ServerState: Equatable {
    case stopped
    case starting
    case running(url: String?)
    case stopping
    case failed
}

final class Server {
    private(set) var state: ServerState = .stopped
    /// The server process this app launched (nil when started elsewhere, e.g. Terminal).
    private var process: Process?
    private var expectingExit = false
    private var stopCompletions: [() -> Void] = []
    var onChange: (() -> Void)?

    var ownsProcess: Bool { process?.isRunning == true }

    var isInstalled: Bool { FileManager.default.isExecutableFile(atPath: Paths.startScript) }

    func start() {
        guard isInstalled else { return }
        switch state {
        case .running, .starting: return
        default: break
        }
        try? FileManager.default.createDirectory(at: Paths.dataDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: Paths.log.path) {
            FileManager.default.createFile(atPath: Paths.log.path, contents: nil)
        }
        guard let log = try? FileHandle(forWritingTo: Paths.log) else { return }
        log.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [Paths.startScript, "serve"]
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self else { return }
                let expected = self.expectingExit
                self.process = nil
                self.expectingExit = false
                self.state = (expected || proc.terminationStatus == 0) ? .stopped : .failed
                self.onChange?()
                self.poll()
                let completions = self.stopCompletions
                self.stopCompletions = []
                completions.forEach { $0() }
            }
        }
        do {
            try p.run()
            process = p
            set(.starting)
        } catch {
            set(.failed)
        }
    }

    /// Stops the server: our own child directly (start.sh execs node, so the
    /// child is the server), one started elsewhere via `start.sh stop`.
    func stop(completion: (() -> Void)? = nil) {
        expectingExit = true
        set(.stopping)
        if let process, process.isRunning {
            if let completion { stopCompletions.append(completion) }
            process.terminate()
            // Force it after 10 s, as `start.sh stop` does.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
            return
        }
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [Paths.startScript, "stop"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.async {
                self.poll()
                completion?()
            }
        }
    }

    /// Asks the host's health endpoint whether it is up (also catches Terminal starts).
    func poll() {
        let url = URL(string: "http://127.0.0.1:\(serverPort())/api/v1/health")!
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            var remote: String?
            if ok, let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                remote = json["url"] as? String
            }
            DispatchQueue.main.async { self.apply(healthy: ok, url: remote) }
        }.resume()
    }

    private func apply(healthy: Bool, url: String?) {
        if healthy {
            if case .stopping = state { return }
            set(.running(url: url))
            return
        }
        switch state {
        case .starting where ownsProcess: return // still booting
        case .stopping where ownsProcess: return
        case .failed: return
        default: set(.stopped)
        }
    }

    private func set(_ next: ServerState) {
        guard next != state else { return }
        state = next
        onChange?()
    }
}

// MARK: - QR window

final class QRWindowController: NSWindowController {
    private let imageView = NSImageView()
    private let urlLabel = NSTextField(labelWithString: "")
    private let pinLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(wrappingLabelWithString: "")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Audio Harbor — iPhone"
        window.isReleasedWhenClosed = false
        super.init(window: window)

        imageView.imageScaling = .scaleProportionallyUpOrDown
        urlLabel.alignment = .center
        urlLabel.isSelectable = true
        urlLabel.font = .systemFont(ofSize: 13)
        pinLabel.alignment = .center
        pinLabel.isSelectable = true
        pinLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        hint.alignment = .center
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 11)

        let stack = NSStackView(views: [imageView, urlLabel, pinLabel, hint])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        imageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 240),
            imageView.heightAnchor.constraint(equalToConstant: 240),
        ])
        window.contentView = stack
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(url: String) {
        imageView.image = Self.qrImage(for: url)
        urlLabel.stringValue = url
        // The PIN only matters with the code on (Settings → About → Require Pairing Code).
        let required = pairingRequired()
        pinLabel.stringValue = required ? pairingPin().map { "PIN \($0)" } ?? "" : ""
        pinLabel.isHidden = !required
        hint.stringValue = required
            ? "Scan with the iPhone camera, then enter the pairing PIN."
            : "Scan with the iPhone camera — no code needed on this network."
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    static func qrImage(for text: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        // Scale up without smoothing so the modules stay sharp.
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let server = Server()
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private lazy var qrWindow = QRWindowController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        server.onChange = { [weak self] in self?.updateIcon() }
        updateIcon()

        server.poll()
        // Give the first health check a moment, so a server already running is not started twice.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, Prefs.autoStartServer, self.server.state == .stopped else { return }
            self.server.start()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.server.poll()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Only stop a server this app started; one started in Terminal keeps running.
        guard server.ownsProcess else { return .terminateNow }
        server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let image = NSImage(systemSymbolName: "hifispeaker.fill", accessibilityDescription: "Audio Harbor")
        image?.isTemplate = true
        button.image = image
        if case .running = server.state {
            button.appearsDisabled = false
        } else {
            button.appearsDisabled = true
        }
    }

    // Rebuilt each time it opens, so it always shows the current state.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = server.state

        let status = NSMenuItem(title: statusText(state), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        if !server.isInstalled {
            let missing = NSMenuItem(title: "Server not found in \(Paths.serverRoot)", action: nil, keyEquivalent: "")
            missing.isEnabled = false
            menu.addItem(missing)
        } else {
            switch state {
            case .running, .starting:
                menu.addItem(item("Stop Server", #selector(stopServer), "s"))
            case .stopping:
                let stopping = NSMenuItem(title: "Stopping…", action: nil, keyEquivalent: "")
                stopping.isEnabled = false
                menu.addItem(stopping)
            case .stopped, .failed:
                menu.addItem(item("Start Server", #selector(startServer), "s"))
            }
        }

        let running: Bool
        if case .running = state { running = true } else { running = false }
        let qr = item("Show QR Code…", #selector(showQR), "q")
        qr.isEnabled = running
        menu.addItem(qr)
        let remote = item("Open Remote", #selector(openRemote), "o")
        remote.isEnabled = running
        menu.addItem(remote)
        let settings = item("Settings…", #selector(openSettings), ",")
        settings.isEnabled = running
        menu.addItem(settings)

        menu.addItem(.separator())
        menu.addItem(item("Open Config File", #selector(openConfig), ""))
        menu.addItem(item("Show Log", #selector(openLog), "l"))

        menu.addItem(.separator())
        let auto = item("Start Server When App Opens", #selector(toggleAutoStart), "")
        auto.state = Prefs.autoStartServer ? .on : .off
        menu.addItem(auto)
        if #available(macOS 13.0, *) {
            let login = item("Open at Login", #selector(toggleLogin), "")
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
        }

        menu.addItem(.separator())
        menu.addItem(item("Quit Audio Harbor", #selector(quit), ""))
    }

    private func statusText(_ state: ServerState) -> String {
        switch state {
        case .running(let url): return "● Running" + (url.map { " — \($0)" } ?? "")
        case .starting: return "Starting…"
        case .stopping: return "Stopping…"
        case .stopped: return "○ Stopped"
        case .failed: return "⚠︎ Stopped with an error — see log"
        }
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private var localBase: String { "http://localhost:\(serverPort())" }

    @objc private func startServer() { server.start() }
    @objc private func stopServer() { server.stop() }

    @objc private func showQR() {
        guard case .running(let url) = server.state else { return }
        qrWindow.show(url: url ?? localBase)
    }

    @objc private func openRemote() { open(localBase + "/") }
    @objc private func openSettings() { open(localBase + "/#settings") }

    @objc private func openConfig() {
        if FileManager.default.fileExists(atPath: Paths.config.path) {
            NSWorkspace.shared.open(Paths.config)
        } else {
            alert("No config file yet", "It is created at \(Paths.config.path) the first time the server starts.")
        }
    }

    @objc private func openLog() {
        if FileManager.default.fileExists(atPath: Paths.log.path) {
            NSWorkspace.shared.open(Paths.log)
        } else {
            alert("No log yet", "The log is written to \(Paths.log.path) once the server runs from this app.")
        }
    }

    @objc private func toggleAutoStart() { Prefs.autoStartServer.toggle() }

    @objc private func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            alert("Could not change Open at Login", error.localizedDescription)
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func open(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }

    private func alert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
