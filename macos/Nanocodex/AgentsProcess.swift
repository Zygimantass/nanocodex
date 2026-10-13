import Combine
import Foundation

/// Presentation only. Credentials, durable admission, and network clients stay
/// in AppModel/RuntimeClient and never enter the renderer's environment or IPC.
struct AgentsSnapshot: Codable, Equatable, Sendable {
    struct Agent: Codable, Equatable, Sendable {
        var id: String
        var title: String
        var lastUserMessageAt: Double
        var status: String
        var activity: String
        var prompt: String
    }
    struct Message: Codable, Equatable, Sendable { var id: String; var role: String; var text: String }
    struct Pending: Codable, Equatable, Sendable { var id: String; var text: String; var state: String }
    var version = 1
    var scope: String
    var theme: String
    var connected: Bool
    var busy: Bool
    var error: String?
    var selectedId: String?
    var agents: [Agent]
    var messages: [Message]
    var draft: String
    var modelLabel: String
    var running: Bool
    var pending: [Pending]
    var canLoadOlder: Bool
}

enum AgentsAction: Decodable, Sendable {
    enum SendMode: String, Decodable { case send, queue, steer }
    enum Destination: String, Decodable { case home, account, tools }
    case select(String), new, draft(id: String, text: String)
    case send(id: String, text: String, mode: SendMode)
    case cancel(String), cancelPending(id: String, pendingId: String)
    case navigate(Destination), refresh, older(String), theme

    private enum CodingKeys: String, CodingKey { case type, id, text, mode, pendingId, destination }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        switch try fields.decode(String.self, forKey: .type) {
        case "select": self = .select(try fields.decode(String.self, forKey: .id))
        case "new": self = .new
        case "draft": self = .draft(id: try fields.decode(String.self, forKey: .id), text: try fields.decode(String.self, forKey: .text))
        case "send": self = .send(id: try fields.decode(String.self, forKey: .id), text: try fields.decode(String.self, forKey: .text), mode: try fields.decode(SendMode.self, forKey: .mode))
        case "cancel": self = .cancel(try fields.decode(String.self, forKey: .id))
        case "cancelPending": self = .cancelPending(id: try fields.decode(String.self, forKey: .id), pendingId: try fields.decode(String.self, forKey: .pendingId))
        case "navigate": self = .navigate(try fields.decode(Destination.self, forKey: .destination))
        case "refresh": self = .refresh
        case "older": self = .older(try fields.decode(String.self, forKey: .id))
        case "theme": self = .theme
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: fields, debugDescription: "Unknown Agents action")
        }
    }
}

/// One account per process. Closing the renderer never closes the managed
/// runtime. Tokens also fence callbacks already queued when a child exits.
@MainActor final class AgentsProcess: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var error: String?
    private var child: Process?
    private var writer: AgentsSnapshotWriter?
    private var output: FileHandle?
    private var diagnostics: FileHandle?
    private var token: UUID?
    private var scope: String?
    private var lastSnapshot: AgentsSnapshot?
    private var exitStatus: Int32?
    private var outputEnded = false
    var processIdentifier: Int32? { child?.processIdentifier }

    func start(executable: URL, snapshot: AgentsSnapshot, onAction: @escaping (AgentsAction) -> Void) {
        stop()
        error = nil
        let process = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        let identity = UUID()
        token = identity; scope = snapshot.scope
        process.executableURL = executable; process.arguments = ["--stdio"]
        // The renderer cannot inherit the host's API keys or .env overrides.
        process.environment = ProcessInfo.processInfo.environment.filter { ["HOME", "TMPDIR", "LANG", "PATH"].contains($0.key) }
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        let reader = AgentsActionReader()
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                reader.finish { [weak self] in
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.token == identity else { return }
                        self.outputEnded = true; self.finish()
                    }
                }
                return
            }
            reader.receive(data) { [weak self] actions in
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.token == identity else { return }
                    for action in actions {
                        guard self.token == identity else { return }
                        if let action { onAction(action) }
                        else { self.error = "Shared Agents sent an invalid action." }
                    }
                }
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            // Drain diagnostics without copying arbitrary subprocess text into
            // the transcript, UI, or logs that could contain private content.
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.token == identity else { return }
                self.exitStatus = process.terminationStatus; self.finish()
            }
        }
        do {
            try process.run()
            child = process; output = stdout.fileHandleForReading; diagnostics = stderr.fileHandleForReading
            writer = AgentsSnapshotWriter(stdin.fileHandleForWriting)
            isRunning = true
            update(snapshot)
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            token = nil; scope = nil
            self.error = "Couldn’t open Shared Agents. Rebuild the app with nanocodex-ui bundled."
        }
    }

    func update(_ snapshot: AgentsSnapshot) {
        guard isRunning else { return }
        guard snapshot.scope == scope else { stop(); return }
        guard snapshot != lastSnapshot else { return }
        do {
            var data = try JSONEncoder().encode(snapshot); data.append(0x0a)
            lastSnapshot = snapshot
            writer?.send(data)
        } catch { self.error = "Couldn’t update Shared Agents." }
    }

    func stop() {
        let process = child
        release()
        if process?.isRunning == true { process?.terminate() }
    }

    private func finish() {
        // Process exit can precede the final stdout read. Preserve a last draft
        // action written while the user closes the renderer window.
        guard let exitStatus, outputEnded else { return }
        if exitStatus != 0 { error = "Shared Agents stopped unexpectedly. Open Agents to retry." }
        release()
    }

    private func release() {
        token = nil; scope = nil; lastSnapshot = nil
        exitStatus = nil; outputEnded = false
        writer?.close(); writer = nil
        output?.readabilityHandler = nil; output = nil
        diagnostics?.readabilityHandler = nil; diagnostics = nil
        child = nil; isRunning = false
    }
}

private final class AgentsActionReader: @unchecked Sendable {
    private let queue = DispatchQueue(label: "nanocodex.agents.actions")
    private var buffer = Data()
    func finish(_ completion: @escaping @Sendable () -> Void) { queue.async(execute: completion) }
    func receive(_ data: Data, deliver: @escaping @Sendable ([AgentsAction?]) -> Void) {
        queue.async {
            self.buffer.append(data)
            var actions: [AgentsAction?] = []
            while let newline = self.buffer.firstIndex(of: 0x0a) {
                actions.append(try? JSONDecoder().decode(AgentsAction.self, from: self.buffer[..<newline]))
                self.buffer.removeSubrange(...newline)
            }
            deliver(actions)
        }
    }
}

/// Keep only the latest unsent snapshot if a renderer is slow. Writes and close
/// are serialized off the UI thread, independently of action reads.
private final class AgentsSnapshotWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "nanocodex.agents.snapshots")
    private let lock = NSLock()
    private let input: FileHandle
    private var latest: Data?
    private var scheduled = false
    private var closed = false
    init(_ input: FileHandle) { self.input = input }
    func send(_ data: Data) {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        latest = data
        let start = !scheduled; scheduled = true
        lock.unlock()
        if start { queue.async { self.drain() } }
    }
    private func drain() {
        while true {
            lock.lock()
            let data = latest; latest = nil
            if data == nil || closed { scheduled = false; lock.unlock(); return }
            lock.unlock()
            do { try input.write(contentsOf: data!) }
            catch { close(); return }
        }
    }
    func close() {
        lock.lock(); closed = true; latest = nil; lock.unlock()
        queue.async { try? self.input.close() }
    }
}
