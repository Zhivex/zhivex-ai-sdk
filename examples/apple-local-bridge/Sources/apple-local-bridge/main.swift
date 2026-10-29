import AppKit
import Foundation
import FoundationModels

// Experimental reference helper. Linux CI does not compile or run it.
// Build on a Mac with the macOS 26 SDK or newer:
//   swift run --package-path examples/apple-local-bridge
//
// Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
// Logs stay on stderr. See README.md for the Tauri v2 wrapping notes.
//
// API names below are taken from developer.apple.com. Two call sites are marked
// CERTIFY because the documentation lists the type but not the enum case label:
// Transcript.Segment's text case, and PromptBuilder's Attachment(_:) image form
// shown in WWDC26 session 241.

private let protocolVersion = 1

private struct BridgeRequest: Decodable {
    var protocolVersion: Int
    var id: String
    var method: String
    var params: BridgeParams

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case id
        case method
        case params
    }
}

private struct BridgeParams: Decodable {
    var modelId: String?
    var useCase: String?
    var guardrails: String?
    var locale: String?
    var instructions: String?
    var transcript: [BridgeEntry]?
    var prompt: BridgePrompt?
    var continuation: Bool?
    var tools: [BridgeToolSpec]?
    var toolCallingMode: String?
    var temperature: Double?
    var maximumResponseTokens: Int?
    var sampling: BridgeSampling?
    var responseSchema: AppleSchema?
    var includeSchemaInPrompt: Bool?
}

private struct BridgePrompt: Decodable {
    var text: String
    var images: [BridgeImage]?
}

private struct BridgeImage: Decodable {
    var mediaType: String
    var data: String
}

private struct BridgeToolSpec: Decodable {
    var name: String
    var description: String
    var parameters: AppleSchema
}

private struct BridgeSampling: Decodable {
    var mode: String
    var probabilityThreshold: Double?
    var top: Int?
    var seed: UInt64?
}

private struct BridgeEntry: Decodable {
    var type: String
    var id: String
    var text: String?
    var name: String?
    var output: String?
    var calls: [BridgeToolCall]?
}

private struct BridgeToolCall: Decodable {
    var id: String
    var name: String
    var arguments: [String: BridgeJSON]
}

private struct AppleSchema: Decodable {
    var type: String
    var description: String?
    var enumValues: [String]?
    var pattern: String?
    var minimum: Double?
    var maximum: Double?
    var items: Box<AppleSchema>?
    var minItems: Int?
    var maxItems: Int?
    var properties: [String: AppleSchema]?
    var required: [String]?

    enum CodingKeys: String, CodingKey {
        case type
        case description
        case enumValues = "enum"
        case pattern
        case minimum
        case maximum
        case items
        case minItems
        case maxItems
        case properties
        case required
    }
}

/// Codable cannot hold a recursive struct directly without a box.
private struct Box<Value: Decodable>: Decodable {
    var value: Value
    init(from decoder: Decoder) throws {
        value = try Value(from: decoder)
    }
}

private enum BridgeJSON: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: BridgeJSON])
    case array([BridgeJSON])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: BridgeJSON].self) {
            self = .object(value)
        } else if let value = try? container.decode([BridgeJSON].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    var jsonObject: Any {
        switch self {
        case let .string(value): return value
        case let .number(value): return value
        case let .bool(value): return value
        case let .object(value): return value.mapValues(\.jsonObject)
        case let .array(value): return value.map(\.jsonObject)
        case .null: return NSNull()
        }
    }
}

private struct DeferredToolCall: Error {
    var id: String
    var name: String
    var arguments: String
}

private final class ToolRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [DeferredToolCall] = []

    func record(_ call: DeferredToolCall) {
        lock.lock()
        calls.append(call)
        lock.unlock()
    }

    func snapshot() -> [DeferredToolCall] {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }
}

private struct JSONBridgeTool: Tool {
    let name: String
    let description: String
    let parameters: GenerationSchema
    let recorder: ToolRecorder
    var includesSchemaInInstructions: Bool { true }

    func call(arguments: GeneratedContent) async throws -> String {
        let id = arguments.id.map { String(describing: $0) } ?? UUID().uuidString
        let deferred = DeferredToolCall(id: id, name: name, arguments: arguments.jsonString)
        recorder.record(deferred)
        // The TypeScript provider loop executes tools. Throwing returns the
        // generated arguments instead of letting the framework continue the turn.
        throw deferred
    }
}

@main
struct AppleLocalBridge {
    static func main() async {
        while let line = readLine(strippingNewline: true) {
            let response = await handle(line: line)
            print(response)
            fflush(stdout)
        }
    }
}

private func handle(line: String) async -> String {
    do {
        let request = try JSONDecoder().decode(BridgeRequest.self, from: Data(line.utf8))
        guard request.protocolVersion == protocolVersion else {
            return errorLine(id: request.id, code: "protocol", message: "Unsupported Apple Local protocol version \(request.protocolVersion).")
        }
        switch request.method {
        case "status":
            return try encodeLine(id: request.id, result: try statusPayload(request.params))
        case "generate":
            return try await encodeLine(id: request.id, result: try generate(request.params, streamingID: nil))
        case "stream":
            return try await stream(request)
        default:
            return errorLine(id: request.id, code: "protocol", message: "Unknown Apple Local method \(request.method).")
        }
    } catch let error as BridgeFailure {
        return errorLine(id: error.id ?? "unknown", code: error.code, message: error.message, retryAt: error.retryAt)
    } catch {
        FileHandle.standardError.write(Data("apple-local-bridge: \(error)\n".utf8))
        return errorLine(id: "unknown", code: "bridge", message: String(describing: error))
    }
}

private struct BridgeFailure: Error {
    var id: String?
    var code: String
    var message: String
    var retryAt: String?
}

private func statusPayload(_ params: BridgeParams) throws -> [String: Any] {
    let model = try makeModel(params)
    let availability = availabilityFields(model.availability)
    var payload: [String: Any] = [
        "available": availability.available,
        "imageInput": imageInputSupported,
        "useCase": params.useCase == "contentTagging" ? "contentTagging" : "general"
    ]
    if let reason = availability.reason {
        payload["reason"] = reason
    }
    if availability.available {
        // contextSize is documented to throw when the model cannot report it.
        // https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize
        payload["contextSize"] = model.contextSize
        payload["supportedLanguages"] = model.supportedLanguages.map(\.minimalIdentifier).sorted()
    }
    if let locale = params.locale {
        payload["localeSupported"] = model.supportsLocale(Locale(identifier: locale))
    }
    return payload
}

private var imageInputSupported: Bool {
    if #available(macOS 27, *) {
        return true
    }
    return false
}

private func availabilityFields(_ availability: SystemLanguageModel.Availability) -> (available: Bool, reason: String?) {
    switch availability {
    case .available:
        return (true, nil)
    case .unavailable(.deviceNotEligible):
        return (false, "deviceNotEligible")
    case .unavailable(.appleIntelligenceNotEnabled):
        return (false, "appleIntelligenceNotEnabled")
    case .unavailable(.modelNotReady):
        return (false, "modelNotReady")
    case .unavailable:
        return (false, "unknown")
    }
}

private func generate(_ params: BridgeParams, streamingID: String?) async throws -> [String: Any] {
    guard let prompt = params.prompt else {
        throw BridgeFailure(code: "protocol", message: "generate requires a prompt.")
    }
    if let images = prompt.images, !images.isEmpty, !imageInputSupported {
        throw BridgeFailure(
            code: "unsupportedCapability",
            message: "This OS does not report on-device image attachments. Image input is documented for the OS 27 system model."
        )
    }
    let prepared = try makeSession(params)
    let options = try generationOptions(params)
    let promptValue = try makePrompt(prompt)
    do {
        if let schema = params.responseSchema {
            let generation = try GenerationSchema(root: convert(schema, name: "Response"), dependencies: [])
            let response = try await prepared.session.respond(
                to: promptValue,
                schema: generation,
                includeSchemaInPrompt: params.includeSchemaInPrompt ?? false,
                options: options
            )
            return [
                "text": response.content.jsonString,
                "finishReason": "stop",
                "usage": usagePayload(response.usage)
            ]
        }
        let response = try await prepared.session.respond(to: promptValue, options: options)
        if let streamingID {
            emit(id: streamingID, event: ["type": "text-delta", "textDelta": response.content])
        }
        return [
            "text": response.content,
            "finishReason": "stop",
            "usage": usagePayload(response.usage)
        ]
    } catch {
        let calls = prepared.recorder.snapshot()
        if !calls.isEmpty {
            let encoded = calls.map { call -> [String: Any] in
                [
                    "id": call.id,
                    "name": call.name,
                    "arguments": jsonObject(from: call.arguments)
                ]
            }
            if let streamingID {
                for call in encoded {
                    emit(id: streamingID, event: ["type": "tool-call", "toolCall": call])
                }
            }
            return ["finishReason": "tool-calls", "toolCalls": encoded]
        }
        throw mapGenerationError(error)
    }
}

private func stream(_ request: BridgeRequest) async throws -> String {
    let params = request.params
    if params.tools?.isEmpty == false || params.responseSchema != nil || params.prompt?.images?.isEmpty == false {
        let result = try await generate(params, streamingID: request.id)
        return try encodeLine(id: request.id, result: result)
    }
    guard let prompt = params.prompt else {
        throw BridgeFailure(id: request.id, code: "protocol", message: "stream requires a prompt.")
    }
    let prepared = try makeSession(params)
    let options = try generationOptions(params)
    let promptValue = try makePrompt(prompt)
    var previous = ""
    var finalUsage: [String: Int] = [:]
    do {
        let stream = prepared.session.streamResponse(to: promptValue, options: options)
        for try await snapshot in stream {
            let text = snapshot.content
            let delta = text.hasPrefix(previous) ? String(text.dropFirst(previous.count)) : text
            previous = text
            if !delta.isEmpty {
                emit(id: request.id, event: ["type": "text-delta", "textDelta": delta])
            }
            finalUsage = usagePayload(prepared.session.usage)
        }
    } catch {
        throw mapGenerationError(error, id: request.id)
    }
    return try encodeLine(id: request.id, result: [
        "text": previous,
        "finishReason": "stop",
        "usage": finalUsage
    ])
}

private func makeModel(_ params: BridgeParams) throws -> SystemLanguageModel {
    let permissive = params.guardrails == "permissiveContentTransformations"
    if params.useCase == "contentTagging" {
        return permissive
            ? SystemLanguageModel(useCase: .contentTagging, guardrails: .permissiveContentTransformations)
            : SystemLanguageModel(useCase: .contentTagging)
    }
    if params.useCase != nil && params.useCase != "general" {
        throw BridgeFailure(code: "protocol", message: "useCase must be general or contentTagging.")
    }
    return permissive
        ? SystemLanguageModel(guardrails: .permissiveContentTransformations)
        : .default
}

private struct PreparedSession {
    var session: LanguageModelSession
    var recorder: ToolRecorder
}

private func makeSession(_ params: BridgeParams) throws -> PreparedSession {
    let recorder = ToolRecorder()
    let tools: [any Tool] = try (params.tools ?? []).map { spec in
        let schema = try GenerationSchema(root: convert(spec.parameters, name: spec.name), dependencies: [])
        return JSONBridgeTool(name: spec.name, description: spec.description, parameters: schema, recorder: recorder)
    }
    let model = try makeModel(params)
    let entries = try transcriptEntries(params)
    let session: LanguageModelSession
    if entries.isEmpty {
        if let instructions = params.instructions, !instructions.isEmpty {
            session = LanguageModelSession(model: model, tools: tools, instructions: instructions)
        } else if tools.isEmpty {
            session = LanguageModelSession(model: model)
        } else {
            session = LanguageModelSession(model: model, tools: tools)
        }
    } else {
        session = LanguageModelSession(model: model, tools: tools, transcript: Transcript(entries: entries))
    }
    return PreparedSession(session: session, recorder: recorder)
}

private func transcriptEntries(_ params: BridgeParams) throws -> [Transcript.Entry] {
    var entries: [Transcript.Entry] = []
    if let instructions = params.instructions, !instructions.isEmpty {
        entries.append(.instructions(Transcript.Instructions(
            id: "instructions",
            segments: [textSegment("instructions-text", instructions)],
            toolDefinitions: []
        )))
    }
    for entry in params.transcript ?? [] {
        switch entry.type {
        case "prompt":
            entries.append(.prompt(Transcript.Prompt(
                id: entry.id,
                segments: [textSegment(entry.id + "-text", entry.text ?? "")],
                options: GenerationOptions(),
                responseFormat: nil
            )))
        case "response":
            entries.append(.response(Transcript.Response(
                id: entry.id,
                assetIDs: [],
                segments: [textSegment(entry.id + "-text", entry.text ?? "")]
            )))
        case "toolCalls":
            let calls = try (entry.calls ?? []).map { call in
                Transcript.ToolCall(
                    id: call.id,
                    toolName: call.name,
                    arguments: try GeneratedContent(json: jsonString(call.arguments))
                )
            }
            entries.append(.toolCalls(Transcript.ToolCalls(id: entry.id, calls)))
        case "toolOutput":
            entries.append(.toolOutput(Transcript.ToolOutput(
                id: entry.id,
                toolName: entry.name ?? "",
                segments: [textSegment(entry.id + "-text", entry.output ?? "")]
            )))
        default:
            throw BridgeFailure(code: "protocol", message: "Unknown transcript entry \(entry.type).")
        }
    }
    return entries
}

// CERTIFY: Transcript.Segment's text case label. TextSegment's initializer is documented.
// https://developer.apple.com/documentation/foundationmodels/transcript/textsegment
private func textSegment(_ id: String, _ content: String) -> Transcript.Segment {
    .text(Transcript.TextSegment(id: id, content: content))
}

private func makePrompt(_ prompt: BridgePrompt) throws -> Prompt {
    let images = prompt.images ?? []
    if images.isEmpty {
        return Prompt { prompt.text }
    }
    guard #available(macOS 27, *) else {
        throw BridgeFailure(code: "unsupportedCapability", message: "Image attachments require macOS 27 or newer.")
    }
    // CERTIFY: WWDC26 session 241 shows Attachment(UIImage) inside the prompt builder
    // and lists NSImage as an attachment source.
    // https://developer.apple.com/videos/play/wwdc2026/241/
    let decoded: [NSImage] = try images.map { image in
        guard image.mediaType.hasPrefix("image/"),
              let data = Data(base64Encoded: image.data),
              let nsImage = NSImage(data: data) else {
            throw BridgeFailure(code: "unsupportedTranscriptContent", message: "Could not decode an image attachment.")
        }
        return nsImage
    }
    return Prompt {
        prompt.text
        for image in decoded {
            Attachment(image)
        }
    }
}

private func generationOptions(_ params: BridgeParams) throws -> GenerationOptions {
    var sampling: GenerationOptions.SamplingMode?
    if let requested = params.sampling {
        switch requested.mode {
        case "greedy":
            sampling = .greedy
        case "random":
            guard let threshold = requested.probabilityThreshold, (0...1).contains(threshold) else {
                throw BridgeFailure(code: "protocol", message: "random sampling requires probabilityThreshold from 0 through 1.")
            }
            sampling = .random(probabilityThreshold: threshold, seed: requested.seed)
        case "top":
            guard let top = requested.top, top >= 1 else {
                throw BridgeFailure(code: "protocol", message: "top sampling requires a positive top count.")
            }
            sampling = .random(top: top, seed: requested.seed)
        default:
            throw BridgeFailure(code: "protocol", message: "Unknown sampling mode \(requested.mode).")
        }
    }
    var toolMode: GenerationOptions.ToolCallingMode?
    switch params.toolCallingMode {
    case "allowed":
        toolMode = .allowed
    case "required":
        toolMode = .required
    case "disallowed":
        toolMode = .disallowed
    case nil:
        toolMode = nil
    default:
        throw BridgeFailure(code: "protocol", message: "Unknown toolCallingMode \(params.toolCallingMode ?? "").")
    }
    return GenerationOptions(
        samplingMode: sampling,
        temperature: params.temperature,
        maximumResponseTokens: params.maximumResponseTokens,
        toolCallingMode: toolMode
    )
}

private func convert(_ schema: AppleSchema, name: String) throws -> DynamicGenerationSchema {
    switch schema.type {
    case "string":
        var guides: [GenerationGuide<String>] = []
        if let values = schema.enumValues, !values.isEmpty {
            guides.append(.anyOf(values))
        }
        if let pattern = schema.pattern {
            do {
                guides.append(.pattern(try Regex(pattern)))
            } catch {
                throw BridgeFailure(code: "unsupportedGenerationGuide", message: "Could not compile pattern \(pattern).")
            }
        }
        return DynamicGenerationSchema(type: String.self, guides: guides)
    case "integer":
        var guides: [GenerationGuide<Int>] = []
        if let minimum = schema.minimum { guides.append(.minimum(Int(minimum))) }
        if let maximum = schema.maximum { guides.append(.maximum(Int(maximum))) }
        return DynamicGenerationSchema(type: Int.self, guides: guides)
    case "number":
        var guides: [GenerationGuide<Double>] = []
        if let minimum = schema.minimum { guides.append(.minimum(minimum)) }
        if let maximum = schema.maximum { guides.append(.maximum(maximum)) }
        return DynamicGenerationSchema(type: Double.self, guides: guides)
    case "boolean":
        return DynamicGenerationSchema(type: Bool.self, guides: [GenerationGuide<Bool>]())
    case "array":
        guard let items = schema.items?.value else {
            throw BridgeFailure(code: "protocol", message: "Array schemas require items.")
        }
        return DynamicGenerationSchema(
            arrayOf: try convert(items, name: name + "Item"),
            minimumElements: schema.minItems,
            maximumElements: schema.maxItems
        )
    case "object":
        let properties = try (schema.properties ?? [:]).map { key, child in
            try DynamicGenerationSchema.Property(
                name: key,
                description: child.description,
                schema: convert(child, name: key),
                isOptional: !(schema.required?.contains(key) ?? false)
            )
        }
        return DynamicGenerationSchema(name: name, description: schema.description, properties: properties)
    default:
        throw BridgeFailure(code: "protocol", message: "Unknown schema type \(schema.type).")
    }
}

private func usagePayload(_ usage: LanguageModelSession.Usage) -> [String: Int] {
    // Property path shown in WWDC26 session 241, "Inspecting usage".
    // https://developer.apple.com/videos/play/wwdc2026/241/
    [
        "inputTokens": usage.input.totalTokenCount,
        "cachedInputTokens": usage.input.cachedTokenCount,
        "outputTokens": usage.output.totalTokenCount,
        "reasoningTokens": usage.output.reasoningTokenCount,
        "totalTokens": usage.totalTokenCount
    ]
}

private func mapGenerationError(_ error: Error, id: String? = nil) -> BridgeFailure {
    if #available(macOS 27, *), let modelError = error as? LanguageModelError {
        switch modelError {
        case let .rateLimited(info):
            let retryAt = info.resetDate.map { ISO8601DateFormatter().string(from: $0) }
            return BridgeFailure(id: id, code: "rateLimited", message: info.debugDescription, retryAt: retryAt)
        case .contextSizeExceeded:
            return BridgeFailure(id: id, code: "contextSizeExceeded", message: "The session exceeded the on-device context size.")
        case .refusal:
            return BridgeFailure(id: id, code: "refusal", message: "The on-device model refused the request.")
        case .guardrailViolation:
            return BridgeFailure(id: id, code: "guardrailViolation", message: "The on-device guardrail rejected the input or output.")
        case .unsupportedLanguageOrLocale:
            return BridgeFailure(id: id, code: "unsupportedLanguageOrLocale", message: "The on-device model does not support a language in the request.")
        case .unsupportedCapability:
            return BridgeFailure(id: id, code: "unsupportedCapability", message: "The on-device model does not support this capability.")
        case .timeout:
            return BridgeFailure(id: id, code: "timeout", message: "The on-device model timed out.")
        case .unsupportedTranscriptContent:
            return BridgeFailure(id: id, code: "unsupportedTranscriptContent", message: "The transcript contains content the model cannot process.")
        case .unsupportedGenerationGuide:
            return BridgeFailure(id: id, code: "unsupportedGenerationGuide", message: "A generation guide is not supported by this model.")
        @unknown default:
            return BridgeFailure(id: id, code: "bridge", message: String(describing: modelError))
        }
    }
    if let generation = error as? LanguageModelSession.GenerationError {
        switch generation {
        case .exceededContextWindowSize:
            return BridgeFailure(id: id, code: "contextSizeExceeded", message: generation.localizedDescription)
        case .rateLimited:
            return BridgeFailure(id: id, code: "rateLimited", message: generation.localizedDescription)
        case .refusal:
            return BridgeFailure(id: id, code: "refusal", message: generation.localizedDescription)
        case .guardrailViolation:
            return BridgeFailure(id: id, code: "guardrailViolation", message: generation.localizedDescription)
        case .unsupportedLanguageOrLocale:
            return BridgeFailure(id: id, code: "unsupportedLanguageOrLocale", message: generation.localizedDescription)
        case .unsupportedGuide:
            return BridgeFailure(id: id, code: "unsupportedGenerationGuide", message: generation.localizedDescription)
        case .assetsUnavailable:
            return BridgeFailure(id: id, code: "assetsUnavailable", message: generation.localizedDescription)
        case .concurrentRequests:
            return BridgeFailure(id: id, code: "concurrentRequests", message: generation.localizedDescription)
        case .decodingFailure:
            return BridgeFailure(id: id, code: "decodingFailure", message: generation.localizedDescription)
        @unknown default:
            return BridgeFailure(id: id, code: "bridge", message: generation.localizedDescription)
        }
    }
    return BridgeFailure(id: id, code: "bridge", message: String(describing: error))
}

private func jsonString(_ arguments: [String: BridgeJSON]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: arguments.mapValues(\.jsonObject))
    guard let text = String(data: data, encoding: .utf8) else {
        throw BridgeFailure(code: "protocol", message: "Tool arguments were not UTF-8 JSON.")
    }
    return text
}

private func jsonObject(from text: String) -> Any {
    guard let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) else {
        return [:]
    }
    return object
}

private func emit(id: String, event: [String: Any]) {
    if let line = try? encodeLine(id: id, event: event) {
        print(line)
        fflush(stdout)
    }
}

private func encodeLine(id: String, result: [String: Any]) throws -> String {
    try encode(["id": id, "result": result])
}

private func encodeLine(id: String, event: [String: Any]) throws -> String {
    try encode(["id": id, "event": event])
}

private func errorLine(id: String, code: String, message: String, retryAt: String? = nil) -> String {
    var error: [String: Any] = ["code": code, "message": message]
    if let retryAt { error["retryAt"] = retryAt }
    return (try? encode(["id": id, "error": error])) ?? #"{"id":"unknown","error":{"code":"bridge","message":"Could not encode the bridge error."}}"#
}

private func encode(_ object: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object)
    guard let line = String(data: data, encoding: .utf8), !line.contains("\n") else {
        throw BridgeFailure(code: "bridge", message: "Could not encode a single-line bridge message.")
    }
    return line
}
