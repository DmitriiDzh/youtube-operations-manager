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

function filter(input: Float32Array, f: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

const blockLoudness = (sumOfMeanSquares: number) => -0.691 + 10 * Math.log10(sumOfMeanSquares);

/** Integrated loudness in LUFS of up to two channels; null for silence or audio shorter than one 400 ms block. */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number | null {
  if (channels.length === 0 || sampleRate <= 0) return null;
  const shelf = highShelf(sampleRate);
  const pass = highPass(sampleRate);
  const weighted = channels.slice(0, 2).map((c) => {
    const once = filter(c, shelf);
    return filter(Float32Array.from(once), pass);
  });
  const length = Math.min(...weighted.map((c) => c.length));
  const block = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  if (length < block) return null;
  // Running sums of squares per channel, so each block is O(1).
  const prefix = weighted.map((c) => {
    const p = new Float64Array(length + 1);
    for (let i = 0; i < length; i++) p[i + 1] = p[i] + c[i] * c[i];
    return p;
  });
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += step) {
    let z = 0;
    for (const p of prefix) z += (p[start + block] - p[start]) / block;
    powers.push(z);
  }
  const aboveAbsolute = powers.filter((z) => z > 0 && blockLoudness(z) > -70);
  if (aboveAbsolute.length === 0) return null;
  const relativeGate = blockLoudness(aboveAbsolute.reduce((s, z) => s + z, 0) / aboveAbsolute.length) - 10;
  const gated = aboveAbsolute.filter((z) => blockLoudness(z) > relativeGate);
  if (gated.length === 0) return null;
  return blockLoudness(gated.reduce((s, z) => s + z, 0) / gated.length);
}

/** The loudness-matched volume (0..1): loud tracks are turned down to the target, none is boosted beyond its own level. */
export const LOUDNESS_TARGET_LUFS = -16;
export function matchedVolume(lufs: number | null, target = LOUDNESS_TARGET_LUFS): number {
  if (lufs === null || !Number.isFinite(lufs)) return 1;
  return Math.min(1, Math.pow(10, (target - lufs) / 20));
}
