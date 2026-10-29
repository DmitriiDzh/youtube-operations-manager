// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057): the one place that knows the WAV container. Both speech providers can deliver raw 16-bit PCM
// (Gemini TTS historically answers `audio/L16;codec=pcm;rate=24000`; ElevenLabs' `pcm_*` output formats), which becomes a
// playable `.wav` here; a `.wav` that already has its header is read for its real sample rate and length. Pure, no I/O
// (AGENTS.md §M: shared by `gemini-media` and `elevenlabs-speech`, owned by neither).
// ---------------------------------------------------------------------------

export type PcmFormat = { sampleRateHz: number; channels: number; bitsPerSample: number };

export type WavInfo = PcmFormat & { dataBytes: number; durationSeconds: number };

/** The PCM parameters a mime type names (`audio/L16;codec=pcm;rate=24000`, `audio/pcm;rate=16000`), or null when it is not raw PCM. */
export function pcmFormatOfMime(mimeType: string, fallbackRateHz: number): PcmFormat | null {
  const [base, ...params] = mimeType.toLowerCase().split(";").map((part) => part.trim());
  if (!(base === "audio/l16" || base === "audio/pcm" || base === "audio/x-pcm" || base === "audio/raw")) return null;
  let sampleRateHz = fallbackRateHz;
  let channels = 1;
  for (const param of params) {
    const [key, value] = param.split("=").map((s) => s.trim());
    const n = Number(value);
    if (key === "rate" && Number.isInteger(n) && n >= 8000 && n <= 192000) sampleRateHz = n;
    if (key === "channels" && Number.isInteger(n) && n >= 1 && n <= 8) channels = n;
  }
  return { sampleRateHz, channels, bitsPerSample: 16 };
}

/** A canonical 44-byte RIFF/WAVE header followed by the little-endian PCM samples. */
export function pcmToWav(pcm: Buffer, format: PcmFormat): Buffer {
  const blockAlign = format.channels * (format.bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRateHz, 24);
  header.writeUInt32LE(format.sampleRateHz * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The format and length of a WAV file (its `fmt ` and `data` chunks), or null when the bytes are not a readable PCM WAV. */
export function wavInfo(wav: Buffer): WavInfo | null {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format: PcmFormat | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= wav.length) {
      const channels = wav.readUInt16LE(body + 2);
      const sampleRateHz = wav.readUInt32LE(body + 4);
      const bitsPerSample = wav.readUInt16LE(body + 14);
      if (channels < 1 || sampleRateHz < 1 || bitsPerSample < 8) return null;
      format = { channels, sampleRateHz, bitsPerSample };
    } else if (id === "data" && format) {
      // A streamed WAV may declare 0 / 0xFFFFFFFF as its data size: the bytes that are there count.
      const dataBytes = size === 0 || size === 0xffffffff || body + size > wav.length ? wav.length - body : size;
      const bytesPerSecond = format.sampleRateHz * format.channels * (format.bitsPerSample / 8);
      return { ...format, dataBytes, durationSeconds: dataBytes / bytesPerSecond };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * Audio a provider returned, as a file to save: a WAV stays as it is, raw PCM is wrapped in a WAV header (no resampling: the
 * provider's own rate is kept, owner msg 3815), anything else (mp3, flac, ogg) is kept with its own extension.
 */
export function audioFileOf(audio: { mimeType: string; data: Buffer }, fallbackRateHz: number): { data: Buffer; extension: string; mimeType: string; sampleRateHz: number | null; durationSeconds: number | null } {
  const mime = audio.mimeType.toLowerCase();
  const pcm = pcmFormatOfMime(mime, fallbackRateHz);
  if (pcm) {
    const wav = pcmToWav(audio.data, pcm);
    return { data: wav, extension: "wav", mimeType: "audio/wav", sampleRateHz: pcm.sampleRateHz, durationSeconds: audio.data.length / (pcm.sampleRateHz * pcm.channels * 2) };
  }
  const info = wavInfo(audio.data);
  if (info || mime.startsWith("audio/wav") || mime.startsWith("audio/x-wav") || mime.startsWith("audio/wave")) {
    return { data: audio.data, extension: "wav", mimeType: "audio/wav", sampleRateHz: info?.sampleRateHz ?? null, durationSeconds: info?.durationSeconds ?? null };
  }
  const extension = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("flac") ? "flac" : mime.includes("ogg") || mime.includes("opus") ? "ogg" : "bin";
  return { data: audio.data, extension, mimeType: mime.split(";")[0] || "application/octet-stream", sampleRateHz: null, durationSeconds: null };
}
