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
