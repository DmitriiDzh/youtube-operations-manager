import { createHash, createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// AWS Signature Version 4 request signing, written here (about 100 lines) instead of pulling in
// the AWS SDK: RunPod's S3-compatible API (docs.runpod.io/storage/s3-api) supports only plain
// object operations, every one of which is a single signed HTTP request. Pure: no I/O, every
// input (including the clock) is a parameter, so the signature is testable against the official
// AWS test vectors (`sigv4.test.ts`).
// ---------------------------------------------------------------------------

export type SigV4Input = {
  method: string;
  /** Absolute URL; its path and query are canonicalized here. */
  url: URL;
  /** Headers to sign; `host` is added automatically. Names are lowercased. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or `"UNSIGNED-PAYLOAD"`. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** The signing instant (UTC). */
  now: Date;
  /** S3 requires `x-amz-content-sha256` on every request; other services do not use it. */
  includeContentSha256Header?: boolean;
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const EMPTY_PAYLOAD_SHA256 = sha256Hex("");

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding as AWS wants it: `encodeURIComponent` plus the five characters it leaves alone. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Each path segment encoded once; S3 paths are never normalized (`..` is data, not navigation). */
function canonicalUri(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  return pathname
    .split("/")
    .map((segment) => awsUriEncode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) pairs.push([awsUriEncode(key), awsUriEncode(value)]);
  pairs.sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Returns the headers to send: the caller's headers plus `host`, `x-amz-date`, `authorization`
 * and (for S3) `x-amz-content-sha256`. Never mutates the input.
 */
export function signSigV4(input: SigV4Input): Record<string, string> {
  const { amzDate: dateTime, dateStamp } = amzDate(input.now);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  headers.host = input.url.host;
  headers["x-amz-date"] = dateTime;
  if (input.includeContentSha256Header) headers["x-amz-content-sha256"] = input.payloadHash;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
