export const supportsVisionInput = (provider, modelId) => {
    const model = modelId.toLowerCase();
    if (provider === "gemini") {
        return !model.includes("embedding");
    }
    if (provider === "bedrock") {
        return model.includes("nova") || model.includes("claude-3") || model.includes("claude-4");
    }
    return true;
};
export const stripImagesForUnsupportedModel = (messages, provider, modelId) => {
    if (supportsVisionInput(provider, modelId)) {
        return messages;
    }
    return messages.map((message) => (message.images?.length ? { ...message, images: [] } : message));
};
export const gatewayMessagesToModelMessages = (messages, systemPrompt) => {
    const mappedMessages = [];
    if (systemPrompt) {
        mappedMessages.push({
            role: "system",
            parts: [{ type: "text", text: systemPrompt }]
        });
    }
    for (const message of messages) {
        mappedMessages.push({
            role: message.role,
            parts: [
                { type: "text", text: message.content },
                ...((message.images ?? []).map((image) => ({
                    type: "image",
                    image: image.dataUrl,
                    mediaType: image.mimeType
                })) ?? [])
            ]
        });
    }
    return mappedMessages;
};
export const createRouteDecision = (mode, intent, orderedTargets) => ({
    mode,
    intent,
    orderedTargets,
    reason: `Ordered by ${mode} mode with ${intent} intent.`
});
//# sourceMappingURL=compat.js.map