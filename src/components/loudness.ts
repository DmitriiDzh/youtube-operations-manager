// BL-143 phase 3 (AC-GP3-04): integrated loudness (ITU-R BS.1770-4) of decoded audio, for loudness-matched playback when the
// validator gave no LUFS. Pure: K-weighting (a high shelf, then a high pass, coefficients for the actual sample rate), 400 ms
// blocks every 100 ms, an absolute gate at -70 LUFS and a relative gate 10 LU below the gated mean. Channel weights 1 (L, R).

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

// The bilinear-transform form of the two BS.1770 stages; at 48 kHz it reproduces the standard's published coefficients
// (shelf b = 1.53512485958697, -2.69169618940638, 1.19839281085285; a = -1.69065929318241, 0.73248077421585;
// high pass b = 1, -2, 1; a = -1.99004745483398, 0.99007225036621).
function highShelf(fs: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / fs);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return { b0: (vh + (vb * k) / q + k * k) / a0, b1: (2 * (k * k - vh)) / a0, b2: (vh - (vb * k) / q + k * k) / a0, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
}

function highPass(fs: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + k / q + k * k;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
}

/**
 * Both K-weighting stages in one pass over a channel, summing the squared output per 100 ms sub-block -- no copy of the audio
 * (independent review: a 48 kHz hour must not need gigabytes). Returns the sub-block sums.
 */
function weightedSubBlockSums(input: Float32Array, shelf: Biquad, pass: Biquad, subBlock: number): Float64Array {
  const sums = new Float64Array(Math.floor(input.length / subBlock));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1 state
  let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // stage 2 state
  const limit = sums.length * subBlock;
  for (let i = 0; i < limit; i++) {
    const x0 = input[i];
    const y0 = shelf.b0 * x0 + shelf.b1 * x1 + shelf.b2 * x2 - shelf.a1 * y1 - shelf.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    const v0 = pass.b0 * y0 + pass.b1 * u1 + pass.b2 * u2 - pass.a1 * v1 - pass.a2 * v2;
    u2 = u1;
    u1 = y0;
    v2 = v1;
    v1 = v0;
    sums[(i / subBlock) | 0] += v0 * v0;
  }
  return sums;
}

const blockLoudness = (sumOfMeanSquares: number) => -0.691 + 10 * Math.log10(sumOfMeanSquares);

/** Integrated loudness in LUFS of up to two channels; null for silence or audio shorter than one 400 ms block. */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number | null {
  if (channels.length === 0 || sampleRate <= 0) return null;
  const shelf = highShelf(sampleRate);
  const pass = highPass(sampleRate);
  // 400 ms blocks with a 100 ms step = four consecutive 100 ms sub-blocks.
  const subBlock = Math.round(0.1 * sampleRate);
  const sums = channels.slice(0, 2).map((c) => weightedSubBlockSums(c, shelf, pass, subBlock));
  const subCount = Math.min(...sums.map((s) => s.length));
  if (subCount < 4) return null;
  const blockLength = 4 * subBlock;
  const powers: number[] = [];
  for (let b = 0; b + 4 <= subCount; b++) {
    let z = 0;
    for (const s of sums) z += (s[b] + s[b + 1] + s[b + 2] + s[b + 3]) / blockLength;
    powers.push(z);
  }
  const aboveAbsolute = powers.filter((z) => z > 0 && blockLoudness(z) > -70);
  if (aboveAbsolute.length === 0) return null;
  const relativeGate = blockLoudness(aboveAbsolute.reduce((acc, z) => acc + z, 0) / aboveAbsolute.length) - 10;
  const gated = aboveAbsolute.filter((z) => blockLoudness(z) > relativeGate);
  if (gated.length === 0) return null;
  return blockLoudness(gated.reduce((acc, z) => acc + z, 0) / gated.length);
}

/** The loudness-matched volume (0..1): loud tracks are turned down to the target, none is boosted beyond its own level. */
export const LOUDNESS_TARGET_LUFS = -16;
export function matchedVolume(lufs: number | null, target = LOUDNESS_TARGET_LUFS): number {
  if (lufs === null || !Number.isFinite(lufs)) return 1;
  return Math.min(1, Math.pow(10, (target - lufs) / 20));
}
