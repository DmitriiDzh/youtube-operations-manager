import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PAYLOAD_SHA256, awsUriEncode, signSigV4 } from "./sigv4";

// Expected values come from the official AWS SigV4 test suite (aws-sig-v4-test-suite, vectors
// `get-vanilla` and `get-vanilla-query-order-key-case`), not from running this implementation:
// credential AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, region us-east-1, service
// "service", host example.amazonaws.com, instant 2015-08-30T12:36:00Z.
const VECTOR = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  now: new Date("2015-08-30T12:36:00Z"),
};

test("get-vanilla: signature matches the AWS test-suite value", () => {
  const headers = signSigV4({
    ...VECTOR,
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(headers.host, "example.amazonaws.com");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
});

test("get-vanilla-query-order-key-case: query parameters are sorted by encoded key", () => {
  const headers = signSigV4({
    ...VECTOR,
    method: "GET",
    url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1"),
    headers: {},
    payloadHash: EMPTY_PAYLOAD_SHA256,
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, " +
      "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"
  );
});

test("S3 mode adds x-amz-content-sha256 to the signed headers", () => {
  const headers = signSigV4({
    ...VECTOR,
    method: "GET",
    url: new URL("https://s3api-eu-ro-1.runpod.io/vol123/exchange/a.png"),
    headers: {},
    payloadHash: "UNSIGNED-PAYLOAD",
    includeContentSha256Header: true,
  });
  assert.equal(headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
  assert.ok(headers.authorization.includes("SignedHeaders=host;x-amz-content-sha256;x-amz-date,"));
});

test("awsUriEncode leaves unreserved characters and encodes the ones encodeURIComponent skips", () => {
  assert.equal(awsUriEncode("a-b_c.d~e"), "a-b_c.d~e");
  assert.equal(awsUriEncode("x y/z*(!)'"), "x%20y%2Fz%2A%28%21%29%27");
});

test("a changed secret changes the signature (the key actually feeds the HMAC chain)", () => {
  const base = {
    ...VECTOR,
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: {},
    payloadHash: EMPTY_PAYLOAD_SHA256,
  };
  const a = signSigV4(base).authorization;
  const b = signSigV4({ ...base, secretAccessKey: "other" }).authorization;
  assert.notEqual(a, b);
});
