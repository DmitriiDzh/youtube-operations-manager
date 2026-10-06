import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { awsUriEncode, EMPTY_PAYLOAD_SHA256, sha256Hex, signSigV4 } from "./sigv4";

// ---------------------------------------------------------------------------
// Phase 14 -- the single funnel for RunPod's S3-compatible network-volume API
// (docs.runpod.io/storage/s3-api, checked 2026-10-05): endpoint `https://s3api-<dc>.runpod.io/`,
// region = the datacenter id, bucket = the network volume id, object key = the file path on the
// volume. Supported there: Get/Put/Delete/Copy/Head/List + multipart; NOT supported: pre-signed
// URLs, DeleteObjects, bucket creation. Single PUT must stay under 500 MB (multipart above --
// not implemented here; models are pulled onto the volume by a pod, never uploaded from here).
// ---------------------------------------------------------------------------

export const RUNPOD_S3_MAX_SINGLE_PUT_BYTES = 500 * 1024 * 1024;
/** Metadata calls (HEAD/LIST/DELETE) are quick; a body transfer (GET/PUT of up to 500 MB) gets a long budget --
 * the signal also aborts the body stream in Node, so a short one would cut every large file off mid-transfer. */
const METADATA_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

export type RunpodS3Config = {
  datacenterId: string;
  volumeId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3ObjectSummary = { key: string; size: number; lastModified: string | null; etag: string | null };

export type RunpodS3Client = ReturnType<typeof createRunpodS3Client>;

/** RunPod datacenter ids: `EU-RO-1`, `EUR-IS-1`, `US-TX-3`, `CA-MTL-3` -- the ONE pattern every validation in this app uses. */
export const RUNPOD_DATACENTER_ID_PATTERN = /^[A-Z]{2,4}-[A-Z]{2,4}-\d{1,2}$/;

export function runpodS3Endpoint(datacenterId: string): URL {
  if (!RUNPOD_DATACENTER_ID_PATTERN.test(datacenterId)) {
    throw new DomainError({ code: "media_settings_invalid", message: `Not a RunPod datacenter id: ${datacenterId}` });
  }
  return new URL(`https://s3api-${datacenterId.toLowerCase()}.runpod.io/`);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlText(match[1]) : null;
}

/** `ListObjectsV2` result XML -> summaries. A tiny purpose-built parser: the shape is fixed and small. */
export function parseListObjectsXml(xml: string): { objects: S3ObjectSummary[]; isTruncated: boolean; nextContinuationToken: string | null } {
  const objects: S3ObjectSummary[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const key = xmlTag(block, "Key");
    if (key === null) continue;
    objects.push({
      key,
      size: Number(xmlTag(block, "Size") ?? "0") || 0,
      lastModified: xmlTag(block, "LastModified"),
      etag: xmlTag(block, "ETag"),
    });
  }
  return {
    objects,
    isTruncated: xmlTag(xml, "IsTruncated") === "true",
    nextContinuationToken: xmlTag(xml, "NextContinuationToken"),
  };
}

export function createRunpodS3Client(config: RunpodS3Config, deps: { fetchImpl?: typeof fetch; authorize?: Authorize; now?: () => Date } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const authorize = deps.authorize ?? assertMediaGatewayAuthorized;
  const now = deps.now ?? (() => new Date());
  const endpoint = runpodS3Endpoint(config.datacenterId);

  function objectUrl(key: string, query?: Record<string, string>): URL {
    const url = new URL(endpoint);
    // The same encoder as the SigV4 canonical URI (`!'()*` included), so the bytes on the wire and the signed
    // path never diverge for a key like `exchange/<job>/final (v2)_00001_.png` (review round 7).
    url.pathname = `/${config.volumeId}${key ? `/${key.split("/").map(awsUriEncode).join("/")}` : ""}`;
    // The query is encoded by the SigV4 encoder as well (`URLSearchParams` would form-encode a space as `+` and `~`
    // as `%7E`, diverging from the signed canonical query -- review round 8).
    const pairs = Object.entries(query ?? {}).map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`);
    url.search = pairs.length > 0 ? `?${pairs.join("&")}` : "";
    return url;
  }

  async function signedFetch(method: string, url: URL, options: { body?: Uint8Array | string; contentType?: string; timeoutMs?: number } = {}): Promise<Response> {
    await authorize("runpod_s3");
    const payloadHash = options.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(options.body);
    const headers = signSigV4({
      method,
      url,
      headers: options.contentType ? { "content-type": options.contentType } : {},
      payloadHash,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.datacenterId,
      service: "s3",
      now: now(),
      includeContentSha256Header: true,
    });
    try {
      return await fetchImpl(url, { method, headers, body: options.body as BodyInit | undefined, signal: AbortSignal.timeout(options.timeoutMs ?? METADATA_TIMEOUT_MS) });
    } catch (error) {
      throw new DomainError({
        code: "runpod_s3_unavailable",
        message: `RunPod S3 request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { method, host: url.host },
      });
    }
  }

  function failure(response: Response, method: string, key: string): DomainError {
    if (response.status === 401 || response.status === 403) {
      return new DomainError({
        code: "media_credentials_invalid",
        message: `RunPod S3 rejected the key pair (HTTP ${response.status}).`,
        details: { method, key, status: response.status },
      });
    }
    return new DomainError({
      code: "runpod_s3_unavailable",
      message: `RunPod S3 returned HTTP ${response.status} for ${method} ${key || "/"}.`,
      details: { method, key, status: response.status },
    });
  }

  async function listObjects(args: { prefix?: string; maxKeys?: number; continuationToken?: string } = {}) {
    const query: Record<string, string> = { "list-type": "2", "max-keys": String(args.maxKeys ?? 1000) };
    if (args.prefix) query.prefix = args.prefix;
    if (args.continuationToken) query["continuation-token"] = args.continuationToken;
    const response = await signedFetch("GET", objectUrl("", query));
    if (!response.ok) throw failure(response, "GET", args.prefix ?? "");
    return parseListObjectsXml(await response.text());
  }

  return {
    endpointHost: endpoint.host,
    listObjects,

    /** Every object under a prefix, following continuation tokens. */
    async listAllObjects(prefix: string): Promise<S3ObjectSummary[]> {
      const all: S3ObjectSummary[] = [];
      let token: string | undefined;
      do {
        const page = await listObjects({ prefix, continuationToken: token });
        all.push(...page.objects);
        token = page.isTruncated && page.nextContinuationToken ? page.nextContinuationToken : undefined;
      } while (token);
      return all;
    },

    async headObject(key: string): Promise<{ size: number; etag: string | null; lastModified: string | null } | null> {
      const response = await signedFetch("HEAD", objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response, "HEAD", key);
      return {
        size: Number(response.headers.get("content-length") ?? "0") || 0,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    },

    /** Streams the object to `destinationPath` via a temp file + rename; returns the bytes written and their SHA-256. */
    async getObjectToFile(key: string, destinationPath: string): Promise<{ bytes: number; sha256: string }> {
      const response = await signedFetch("GET", objectUrl(key), { timeoutMs: TRANSFER_TIMEOUT_MS });
      if (!response.ok || !response.body) throw failure(response, "GET", key);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      const tmpPath = `${destinationPath}.part`;
      let bytes = 0;
      const hash = createHash("sha256");
      try {
        // A `.part` left by a killed earlier download is ours to replace (the final name is only ever reached by
        // rename). Done BEFORE the stream gets its data listener: attaching one starts the flow at once.
        await rm(tmpPath, { force: true });
        const counting = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
        counting.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        await pipeline(counting, createWriteStream(tmpPath, { flags: "wx" }));
        await rename(tmpPath, destinationPath);
      } catch (error) {
        await rm(tmpPath, { force: true });
        throw error;
      }
      return { bytes, sha256: hash.digest("hex") };
    },

    async getObjectText(key: string): Promise<string | null> {
      const response = await signedFetch("GET", objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response, "GET", key);
      return await response.text();
    },

    async putObject(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): Promise<void> {
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      if (size > RUNPOD_S3_MAX_SINGLE_PUT_BYTES) {
        throw new DomainError({
          code: "runpod_s3_unavailable",
          message: "Objects over 500 MB need a multipart upload, which this client does not implement.",
          details: { key, size },
        });
      }
      const response = await signedFetch("PUT", objectUrl(key), { body, contentType, timeoutMs: TRANSFER_TIMEOUT_MS });
      if (!response.ok) throw failure(response, "PUT", key);
    },

    /**
     * BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.4): uploads a local file by STREAMING it -- never buffered whole in memory.
     * SigV4 signs the payload hash, so the file is read twice: once to hash it, once as the body (with its exact
     * Content-Length; a file that changes between the passes fails S3's own hash check). Same 500 MB single-PUT limit.
     */
    async putObjectFromFile(key: string, filePath: string, contentType = "application/octet-stream"): Promise<{ bytes: number; sha256: string }> {
      const { size } = await stat(filePath);
      if (size > RUNPOD_S3_MAX_SINGLE_PUT_BYTES) {
        throw new DomainError({
          code: "runpod_s3_unavailable",
          message: "Objects over 500 MB need a multipart upload, which this client does not implement.",
          details: { key, size },
        });
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
      const payloadHash = hash.digest("hex");
      await authorize("runpod_s3");
      const url = objectUrl(key);
      const headers = signSigV4({
        method: "PUT",
        url,
        headers: { "content-type": contentType },
        payloadHash,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.datacenterId,
        service: "s3",
        now: now(),
        includeContentSha256Header: true,
      });
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "PUT",
          headers: { ...headers, "content-length": String(size) },
          body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
          // Node's fetch needs this for a streamed request body.
          duplex: "half",
          signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        } as RequestInit & { duplex: "half" });
      } catch (error) {
        throw new DomainError({ code: "runpod_s3_unavailable", message: `RunPod S3 request failed: ${error instanceof Error ? error.message : String(error)}`, details: { method: "PUT", host: url.host } });
      }
      if (!response.ok) throw failure(response, "PUT", key);
      return { bytes: size, sha256: payloadHash };
    },

    /** Idempotent: a 404 counts as deleted. */
    async deleteObject(key: string): Promise<void> {
      const response = await signedFetch("DELETE", objectUrl(key));
      if (response.status === 404 || response.status === 204 || response.ok) return;
      throw failure(response, "DELETE", key);
    },

    /** The cheapest authenticated call: one key of the listing. */
    async testAccess(): Promise<{ ok: true }> {
      await listObjects({ maxKeys: 1 });
      return { ok: true };
    },
  };
}
