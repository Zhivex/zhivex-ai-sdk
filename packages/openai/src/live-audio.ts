import { ValidationError, decodeBase64WithLimit, encodeAudioFrame, type RealtimeSessionConfig, type RealtimeSessionCallbacks } from "@zhivex-ai/core/provider";
/** Node/server audio codec. Kept outside the browser protocol graph. */
export function liveAudioCallbacks(resolved: RealtimeSessionConfig): Pick<RealtimeSessionCallbacks, "buildAudioPayloads"> & { parseOutputAudio: RealtimeSessionCallbacks["parseEvent"] } {
  const parseOutputAudio: RealtimeSessionCallbacks["parseEvent"] = payload => {
    if (typeof payload.delta !== "string") throw new ValidationError("Invalid GPT-Live audio delta.");
    const audio = decodeBase64WithLimit(payload.delta, { maxBytes: 16 * 1024 * 1024, provider: "openai", endpoint: "live/sessions" });
    if (resolved.outputAudioMediaType === "audio/pcm" && audio.byteLength % 2) throw new ValidationError("GPT-Live PCM output must contain complete 16-bit samples.");
    return [{ type: "realtime-audio-output", audio, mediaType: resolved.outputAudioMediaType ?? "audio/pcm",
      sampleRateHz: resolved.outputSampleRateHz, channels: 1 }];
  };
  return { parseOutputAudio, buildAudioPayloads: frame => {
      if (frame.mediaType !== resolved.inputAudioMediaType || (frame.sampleRateHz !== undefined && frame.sampleRateHz !== resolved.inputSampleRateHz) || (frame.channels !== undefined && frame.channels !== 1)) throw new ValidationError("Audio frame does not match the GPT-Live session format; resample it before sending.");
      const audio = encodeAudioFrame(frame);
      const bytes = decodeBase64WithLimit(audio, { maxBytes: 16 * 1024 * 1024, provider: "openai", endpoint: "live/sessions" });
      if (resolved.inputAudioMediaType === "audio/pcm" && bytes.byteLength % 2) throw new ValidationError("GPT-Live PCM input must contain complete 16-bit samples.");
      return [{ type: "session.input_audio.append", audio }];
  } };
}
