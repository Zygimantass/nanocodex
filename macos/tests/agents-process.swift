// Headless IPC journey. The executable is also its synthetic renderer child;
// neither mode links AppKit nor starts a window/event loop.
import Foundation

@main struct AgentsProcessJourney {
    static func require(_ condition: Bool, _ message: String) throws {
        guard condition else { throw NSError(domain: "AgentsProcessJourney", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        print("PASS: " + message)
    }
    static func snapshot(scope: String) -> AgentsSnapshot {
        AgentsSnapshot(scope: scope, theme: "dark", connected: true, busy: false,
            selectedId: "agent-a", agents: [
                .init(id: "agent-a", title: "Release review", lastUserMessageAt: 2000, status: "completed", activity: "", prompt: "Check the release"),
                .init(id: "agent-b", title: "Research", lastUserMessageAt: 1000, status: "running", activity: "Reading files", prompt: "Compare the results")
            ], messages: [.init(id: "message-a", role: "assistant", text: "Ready.\nSecond line.")],
            draft: "Unsent 🌍 draft", modelLabel: "GPT", running: false, pending: [], canLoadOlder: true)
    }
    static func write(_ text: String) throws { try FileHandle.standardOutput.write(contentsOf: Data(text.utf8)) }
    static func renderer() throws {
        guard let line = readLine() else { exit(71) }
        let value = try JSONDecoder().decode(AgentsSnapshot.self, from: Data(line.utf8))
        guard value.version == 1, value.agents.map(\.id) == ["agent-a", "agent-b"],
              value.messages.first?.text == "Ready.\nSecond line.", value.draft == "Unsent 🌍 draft",
              ProcessInfo.processInfo.environment["NANOCODEX_API_KEY"] == nil else { exit(72) }
        if value.scope == "failure" { exit(7) }
        if value.scope == "stale" {
            for _ in 0..<20 { try write("{\"type\":\"draft\",\"id\":\"agent-a\",\"text\":\"old account\"}\n") }
            while readLine() != nil { }
            return
        }
        // Diagnostics must never be interpreted as actions.
        try FileHandle.standardError.write(contentsOf: Data("{\"type\":\"new\"}\n".utf8))
        try write("not-json\n{\"type\":\"unknown\"}\n{\"type\":\"send\",\"id\":\"agent-a\",\"text\":\"x\",\"mode\":\"invalid\"}\n")
        let actions = [
            #"{"type":"select","id":"agent-b"}"#,
            #"{"type":"new"}"#,
            #"{"type":"send","id":"agent-a","text":"queued","mode":"queue"}"#,
            #"{"type":"cancel","id":"agent-a"}"#,
            #"{"type":"cancelPending","id":"agent-a","pendingId":"pending-a"}"#,
            #"{"type":"navigate","destination":"tools"}"#,
            #"{"type":"refresh"}"#,
            #"{"type":"older","id":"agent-a"}"#,
            #"{"type":"theme"}"#,
            #"{"type":"draft","id":"agent-a","text":"ack 🌍"}"#
        ]
        let bytes = Data((actions.joined(separator: "\n") + "\n").utf8)
        let split = bytes.count - 4 // Split within the final Unicode draft frame.
        try FileHandle.standardOutput.write(contentsOf: bytes.prefix(split))
        Thread.sleep(forTimeInterval: 0.02)
        try FileHandle.standardOutput.write(contentsOf: bytes.suffix(from: split))
        guard let next = readLine(), try JSONDecoder().decode(AgentsSnapshot.self, from: Data(next.utf8)).draft == "ack 🌍" else { exit(73) }
        try write("{\"type\":\"draft\",\"id\":\"agent-a\",\"text\":\"final draft before exit\"}\n")
    }
    @MainActor static func wait(_ description: String, until condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { try require(true, description); return }
            try await Task.sleep(for: .milliseconds(10))
        }
        try require(false, description)
    }
    @MainActor static func main() async throws {
        if CommandLine.arguments.contains("--stdio") { try renderer(); return }
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let bridge = AgentsProcess()
        var current = snapshot(scope: "account-a"), received: [String] = []
        bridge.start(executable: executable, snapshot: current) { action in
            switch action {
            case .select(let id): received.append("select:" + id)
            case .new: received.append("new")
            case .send(let id, let text, let mode): received.append("send:\(id):\(text):\(mode.rawValue)")
            case .cancel(let id): received.append("cancel:" + id)
            case .cancelPending(let id, let pending): received.append("cancelPending:\(id):\(pending)")
            case .navigate(let destination): received.append("navigate:" + destination.rawValue)
            case .refresh: received.append("refresh")
            case .older(let id): received.append("older:" + id)
            case .theme: received.append("theme")
            case .draft(_, let text):
                received.append("draft:" + text)
                if text == "ack 🌍" { current.draft = text; bridge.update(current) }
            }
        }
        try await wait("renderer exits without dropping its final draft") { !bridge.isRunning && received.last == "draft:final draft before exit" }
        try require(received == ["select:agent-b", "new", "send:agent-a:queued:queue", "cancel:agent-a", "cancelPending:agent-a:pending-a", "navigate:tools", "refresh", "older:agent-a", "theme", "draft:ack 🌍", "draft:final draft before exit"], "exact action order; malformed/unknown actions and stderr rejected")
        try require(bridge.error != nil, "invalid action is visible without killing the next valid action")

        var oldActions = 0
        bridge.start(executable: executable, snapshot: snapshot(scope: "stale")) { _ in
            oldActions += 1
            bridge.update(snapshot(scope: "account-b"))
        }
        try await wait("account change releases the renderer") { !bridge.isRunning }
        try require(oldActions == 1, "buffered old-account actions are fenced after scope change")
        bridge.start(executable: executable, snapshot: snapshot(scope: "failure")) { _ in }
        try await wait("abnormal renderer exit releases pipes") { !bridge.isRunning }
        try require(bridge.error?.contains("unexpectedly") == true, "abnormal exit offers recovery")
        bridge.start(executable: URL(fileURLWithPath: "/nonexistent/nanocodex-ui"), snapshot: current) { _ in }
        try require(!bridge.isRunning && bridge.error != nil, "missing renderer fails without affecting the host")
        print("HEADLESS IPC JOURNEY COMPLETE; no GUI or service was launched")
    }
}
