import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createRunpodS3Client, parseListObjectsXml, runpodS3Endpoint } from "./runpod-s3";

// Expected behaviour from docs.runpod.io/storage/s3-api (endpoint per datacenter, bucket = volume
// id, path-style keys, 500 MB single-PUT limit) and PHASE_14_PLAN.md AC-P14-13/14.

const CONFIG = { datacenterId: "EU-RO-1", volumeId: "vol123", accessKeyId: "user_abc", secretAccessKey: "rps_secret" };
const noAuth = async () => {};

type Call = { url: URL; init: RequestInit };
function fakeFetch(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("endpoint is https://s3api-<datacenter>.runpod.io/ and rejects a malformed datacenter id", () => {
  assert.equal(runpodS3Endpoint("EU-RO-1").toString(), "https://s3api-eu-ro-1.runpod.io/");
  assert.equal(runpodS3Endpoint("EUR-IS-1").host, "s3api-eur-is-1.runpod.io");
  assert.throws(() => runpodS3Endpoint("evil.example.com/"), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
});

test("listObjects is a signed path-style ListObjectsV2 on the volume bucket, parsed into summaries", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>vol123</Name><Prefix>exchange/</Prefix><IsTruncated>true</IsTruncated>
<NextContinuationToken>tok&amp;1</NextContinuationToken>
<Contents><Key>exchange/job1/out.png</Key><LastModified>2026-10-05T10:00:00.000Z</LastModified><ETag>"abc"</ETag><Size>1234</Size></Contents>
<Contents><Key>exchange/job1/a &amp; b.wav</Key><Size>99</Size></Contents>
</ListBucketResult>`;
  const authorized: string[] = [];
  const { fetchImpl, calls } = fakeFetch(() => new Response(xml, { status: 200 }));
  const client = createRunpodS3Client(CONFIG, {
    fetchImpl,
    now: () => new Date("2026-10-05T10:00:00Z"),
    authorize: async (c) => {
      authorized.push(c);
    },
  });
  const page = await client.listObjects({ prefix: "exchange/", maxKeys: 50 });
  assert.deepEqual(authorized, ["runpod_s3"]);
  assert.equal(calls[0].url.host, "s3api-eu-ro-1.runpod.io");
  assert.equal(calls[0].url.pathname, "/vol123");
  assert.equal(calls[0].url.searchParams.get("list-type"), "2");
  assert.equal(calls[0].url.searchParams.get("prefix"), "exchange/");
  assert.equal(calls[0].url.searchParams.get("max-keys"), "50");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=user_abc\/20261005\/EU-RO-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(page, {
    isTruncated: true,
    nextContinuationToken: "tok&1",
    objects: [
      { key: "exchange/job1/out.png", size: 1234, lastModified: "2026-10-05T10:00:00.000Z", etag: '"abc"' },
      { key: "exchange/job1/a & b.wav", size: 99, lastModified: null, etag: null },
    ],
  });
});

test("listAllObjects follows continuation tokens", async () => {
  let page = 0;
  const { fetchImpl, calls } = fakeFetch(() => {
    page++;
    return new Response(
      page === 1
        ? "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>b</Key><Size>2</Size></Contents></ListBucketResult>",
      { status: 200 }
    );
  });
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  const all = await client.listAllObjects("exchange/");
  assert.deepEqual(all.map((o) => o.key), ["a", "b"]);
  assert.equal(calls[1].url.searchParams.get("continuation-token"), "t2");
});

test("object keys are placed under /<volumeId>/ with each segment encoded; headObject maps 404 to null", async () => {
  const { fetchImpl, calls } = fakeFetch((call) =>
    call.url.pathname.endsWith("/missing.png") ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "content-length": "42", etag: '"e"' } })
  );
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  assert.deepEqual(await client.headObject("exchange/job 1/out.png"), { size: 42, etag: '"e"', lastModified: null });
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(calls[0].url.pathname, "/vol123/exchange/job%201/out.png");
  assert.equal(await client.headObject("exchange/missing.png"), null);
});

test("getObjectToFile streams to a temp file then renames; a failed download leaves no partial file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "runpod-s3-test-"));
  try {
    const { fetchImpl } = fakeFetch((call) =>
      call.url.pathname.endsWith("/bad") ? new Response("nope", { status: 500 }) : new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 })
    );
    const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
    const dest = path.join(dir, "nested", "out.bin");
    // sha256 of bytes 01 02 03 04 05, computed independently (`printf '\x01\x02\x03\x04\x05' | shasum -a 256`).
    assert.deepEqual(await client.getObjectToFile("exchange/j/out.bin", dest), {
      bytes: 5,
      sha256: "74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0",
    });
    assert.deepEqual([...(await readFile(dest))], [1, 2, 3, 4, 5]);
    await assert.rejects(client.getObjectToFile("exchange/j/bad", path.join(dir, "bad.bin")), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable");
    await assert.rejects(readFile(path.join(dir, "bad.bin")));
    await assert.rejects(readFile(path.join(dir, "bad.bin.part")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteObject is idempotent (404 = deleted); 403 is media_credentials_invalid", async () => {
  const { fetchImpl, calls } = fakeFetch((call) => new Response(null, { status: call.url.pathname.endsWith("/gone") ? 404 : call.url.pathname.endsWith("/forbidden") ? 403 : 204 }));
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  await client.deleteObject("exchange/j/a");
  await client.deleteObject("exchange/j/gone");
  assert.equal(calls[0].init.method, "DELETE");
  await assert.rejects(client.deleteObject("exchange/j/forbidden"), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid");
});

test("putObject refuses a body over the 500 MB single-PUT limit without calling the network", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  const big = { byteLength: 500 * 1024 * 1024 + 1 } as unknown as Uint8Array;
  await assert.rejects(client.putObject("exchange/x", big), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable");
  assert.equal(calls.length, 0);
  await client.putObject("exchange/in/ref.txt", "hello", "text/plain");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "text/plain");
});

test("parseListObjectsXml on an empty listing", () => {
  assert.deepEqual(parseListObjectsXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"), {
    objects: [],
    isTruncated: false,
    nextContinuationToken: null,
  });
});

test("review 3: Montreal-style datacenter ids are accepted; a stale .part file from a killed download does not block the next one", async () => {
  assert.equal(runpodS3Endpoint("CA-MTL-3").host, "s3api-ca-mtl-3.runpod.io");
  const dir = await mkdtemp(path.join(tmpdir(), "runpod-s3-part-"));
  try {
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array([7, 7]), { status: 200 }));
    const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
    const dest = path.join(dir, "out.bin");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dest}.part`, "stale");
    assert.equal((await client.getObjectToFile("exchange/j/out.bin", dest)).bytes, 2);
    assert.deepEqual([...(await readFile(dest))], [7, 7]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review 5: the client's methods work when destructured (no `this` dependency)", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 }));
  const { listAllObjects, testAccess } = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  assert.deepEqual(await listAllObjects("exchange/"), []);
  assert.deepEqual(await testAccess(), { ok: true });
});

test("review 7: a key with the five characters encodeURIComponent leaves raw (!'()*) is sent exactly as the SigV4 canonical path encodes it", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200, headers: { "content-length": "1" } }));
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  await client.headObject("exchange/job1/final (v2)*!'_00001_.png");
  assert.equal(calls[0].url.pathname, "/vol123/exchange/job1/final%20%28v2%29%2A%21%27_00001_.png");
});

test("review 8: query values are encoded by the SigV4 encoder too (a space is %20, never a form '+'), so the wire query matches the signed canonical query", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 }));
  const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
  await client.listObjects({ prefix: "exchange/my job/~x", maxKeys: 5 });
  assert.ok(calls[0].url.search.includes("prefix=exchange%2Fmy%20job%2F~x"), calls[0].url.search);
  assert.ok(!calls[0].url.search.includes("+"));
  assert.equal(calls[0].url.searchParams.get("prefix"), "exchange/my job/~x");
});

// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.4): a job input file is uploaded by streaming it from disk -- never buffered
// whole in memory -- in two passes: the file's SHA-256 is computed first and signed as x-amz-content-sha256 (SigV4 needs
// the payload hash before the body is sent), then the body is streamed with its exact Content-Length.
test("putObjectFromFile streams the file with its SHA-256 signed and its Content-Length set; returns bytes and hash", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-s3-put-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const file = path.join(dir, "ref image.png");
    const content = Buffer.from("PNG-bytes-".repeat(1000));
    await writeFile(file, content);
    const expectedSha = createHash("sha256").update(content).digest("hex");
    let received = Buffer.alloc(0);
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as ReadableStream<Uint8Array> | undefined;
      if (body && typeof (body as ReadableStream).getReader === "function") {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received = Buffer.concat([received, Buffer.from(value)]);
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const client = createRunpodS3Client(CONFIG, { fetchImpl: wrapped, authorize: noAuth, now: () => new Date("2026-10-06T10:00:00Z") });
    const result = await client.putObjectFromFile("exchange/in/job-1/image-ref image.png", file, "image/png");
    assert.deepEqual(result, { bytes: content.length, sha256: expectedSha });
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].url.pathname, "/vol123/exchange/in/job-1/image-ref%20image.png");
    assert.equal(headers["x-amz-content-sha256"], expectedSha);
    assert.equal(headers["content-length"], String(content.length));
    assert.equal(headers["content-type"], "image/png");
    assert.match(headers.authorization, /SignedHeaders=[^,]*x-amz-content-sha256/);
    assert.ok(received.equals(content), "the body on the wire is the file");
    assert.equal((calls[0].init as { duplex?: string }).duplex, "half");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("putObjectFromFile refuses a file over the single-PUT limit without calling the network; an S3 error is runpod_s3_unavailable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-s3-put-"));
  try {
    const { writeFile, truncate } = await import("node:fs/promises");
    const big = path.join(dir, "big.mp4");
    await writeFile(big, "");
    await truncate(big, 500 * 1024 * 1024 + 1);
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
    await assert.rejects(client.putObjectFromFile("exchange/in/j/big.mp4", big), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable");
    assert.equal(calls.length, 0);
    const small = path.join(dir, "s.wav");
    await writeFile(small, "abc");
    const failing = createRunpodS3Client(CONFIG, { fetchImpl: fakeFetch(() => new Response("nope", { status: 500 })).fetchImpl, authorize: noAuth });
    await assert.rejects(failing.putObjectFromFile("exchange/in/j/s.wav", small), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BL-132 review: putObjectFromFile reads one descriptor -- a file whose identity differs from the checked one, a symlink, or one over its own maxBytes is refused before any request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-s3-put-"));
  try {
    const { writeFile, stat, symlink } = await import("node:fs/promises");
    const file = path.join(dir, "a.png");
    await writeFile(file, "0123456789");
    const real = await stat(file);
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const client = createRunpodS3Client(CONFIG, { fetchImpl, authorize: noAuth });
    await assert.rejects(client.putObjectFromFile("exchange/in/x", file, "image/png", { expectedIdentity: { dev: real.dev, ino: real.ino + 1 } }), (e: unknown) => isDomainError(e) && /changed after it was checked/.test(e.message));
    await assert.rejects(client.putObjectFromFile("exchange/in/x", file, "image/png", { maxBytes: 9 }), (e: unknown) => isDomainError(e) && /over its limit of 9/.test(e.message));
    const link = path.join(dir, "link.png");
    await symlink(file, link);
    await assert.rejects(client.putObjectFromFile("exchange/in/x", link, "image/png"));
    assert.equal(calls.length, 0);
    assert.deepEqual(await client.putObjectFromFile("exchange/in/x", file, "image/png", { expectedIdentity: { dev: real.dev, ino: real.ino }, maxBytes: 10 }), {
      bytes: 10,
      sha256: (await import("node:crypto")).createHash("sha256").update("0123456789").digest("hex"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// BL-136: S3 CopyObject (AWS S3 API reference): PUT on the destination key with `x-amz-copy-source: <source-bucket>/<key>` (the
// key URL-encoded), signed like every request; a 200 response can still carry an <Error> body, which is a failed copy.
test("copyObjectFrom PUTs the destination key with a signed x-amz-copy-source naming the source volume and key", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("<CopyObjectResult><ETag>\"e\"</ETag></CopyObjectResult>", { status: 200 }));
  const client = createRunpodS3Client(CONFIG, { fetchImpl, now: () => new Date("2026-10-06T10:00:00Z"), authorize: noAuth });
  await client.copyObjectFrom("srcvol", "models/checkpoints/a b.safetensors", "ytm-probe/models/checkpoints/a b.safetensors");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].url.pathname, "/vol123/ytm-probe/models/checkpoints/a%20b.safetensors");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-amz-copy-source"], "srcvol/models/checkpoints/a%20b.safetensors");
  assert.match(headers.authorization, /SignedHeaders=[^,]*x-amz-copy-source/);
  assert.equal(calls[0].init.body, undefined);
});

test("copyObjectFrom fails on an HTTP error and on a 200 response with an <Error> body", async () => {
  const failing = createRunpodS3Client(CONFIG, { fetchImpl: fakeFetch(() => new Response("<Error><Code>NoSuchBucket</Code><Message>nope</Message></Error>", { status: 404 })).fetchImpl, authorize: noAuth });
  await assert.rejects(failing.copyObjectFrom("srcvol", "a", "b"), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable" && /NoSuchBucket/.test(e.message));
  const late = createRunpodS3Client(CONFIG, { fetchImpl: fakeFetch(() => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 })).fetchImpl, authorize: noAuth });
  await assert.rejects(late.copyObjectFrom("srcvol", "a", "b"), (e: unknown) => isDomainError(e) && e.code === "runpod_s3_unavailable");
  const denied = createRunpodS3Client(CONFIG, { fetchImpl: fakeFetch(() => new Response("", { status: 403 })).fetchImpl, authorize: noAuth });
  await assert.rejects(denied.copyObjectFrom("srcvol", "a", "b"), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid");
});
