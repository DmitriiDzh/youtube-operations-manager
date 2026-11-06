import assert from "node:assert/strict";
import test from "node:test";
import { attachmentRefusalOf, CLIP_ATTACHMENT_LIMITS, declaredTypeFits, headMatchesKind, pastedNameOf, sanitizeAttachmentName, textLooksValid, uniqueAttachmentNames } from "./attachments";

// BL-246 (CLIP_REVIEWS_PLAN.md items 11-12, AC-CR-17/18/19). Every expected value is written by hand from the plan.

const bytes = (...values: Array<number | string>) => new Uint8Array(values.flatMap((v) => (typeof v === "string" ? Array.from(v, (c) => c.charCodeAt(0)) : [v])));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);

test("AC-CR-17: 50 MiB is 52,428,800 bytes; exactly that is allowed, one more byte and 0 bytes are not; at most 10 files", () => {
  assert.equal(CLIP_ATTACHMENT_LIMITS.bytes, 52_428_800);
  assert.equal(CLIP_ATTACHMENT_LIMITS.files, 10);
  assert.equal(attachmentRefusalOf({ name: "a.png", type: "image/png", size: 52_428_800 }), null);
  assert.equal(attachmentRefusalOf({ name: "a.png", type: "image/png", size: 52_428_801 }), "too_large");
  assert.equal(attachmentRefusalOf({ name: "a.png", type: "image/png", size: 0 }), "empty");
  // The pieces stay well under the proxy's 40 MB body buffer (next.config.ts).
  assert.ok(CLIP_ATTACHMENT_LIMITS.pieceBytes <= 40 * 1000 * 1000);
});

test("AC-CR-18: only the listed extensions; the declared type must fit the extension (empty / octet-stream = not declared)", () => {
  for (const name of ["x.svg", "x.exe", "x.html", "noextension", "x.png.exe", "x.mkv"]) assert.equal(attachmentRefusalOf({ name, type: "", size: 10 }), "type_not_allowed", name);
  for (const name of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.pdf", "a.txt", "a.md", "a.json", "a.mp4", "a.webm", "a.MOV"]) {
    assert.equal(attachmentRefusalOf({ name, type: "", size: 10 }), null, name);
  }
  assert.equal(attachmentRefusalOf({ name: "a.png", type: "application/pdf", size: 10 }), "type_mismatch");
  assert.equal(attachmentRefusalOf({ name: "a.mp4", type: "video/quicktime", size: 10 }), "type_mismatch");
  assert.equal(declaredTypeFits("a.png", "application/octet-stream"), true);
  assert.equal(declaredTypeFits("a.md", "text/plain"), true);
  assert.equal(declaredTypeFits("a.json", "application/json; charset=utf-8"), true);
});

test("AC-CR-18: the first bytes must be the extension's kind", () => {
  assert.equal(headMatchesKind("a.png", PNG), true);
  assert.equal(headMatchesKind("a.png", bytes("%PDF-1.7")), false);
  assert.equal(headMatchesKind("a.pdf", bytes("%PDF-1.7")), true);
  assert.equal(headMatchesKind("a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(headMatchesKind("a.jpg", PNG), false);
  assert.equal(headMatchesKind("a.webp", bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")), true);
  assert.equal(headMatchesKind("a.webp", bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")), false);
  assert.equal(headMatchesKind("a.gif", bytes("GIF89a")), true);
  assert.equal(headMatchesKind("a.gif", bytes("GIF90a")), false);
  assert.equal(headMatchesKind("a.mp4", bytes(0, 0, 0, 0x20, "ftypisom")), true);
  assert.equal(headMatchesKind("a.mov", bytes(0, 0, 0, 0x14, "ftypqt  ")), true);
  assert.equal(headMatchesKind("a.mov", bytes(0, 0, 0, 0x08, "wide")), true);
  assert.equal(headMatchesKind("a.mp4", bytes(0x1a, 0x45, 0xdf, 0xa3)), false);
  assert.equal(headMatchesKind("a.webm", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)), true);
});

test("AC-CR-18: text files are UTF-8 without NUL; a .json must parse", () => {
  const utf8 = new TextEncoder();
  assert.equal(textLooksValid(utf8.encode("привет, мир\n"), false), true);
  assert.equal(textLooksValid(bytes("ab", 0, "c"), false), false);
  assert.equal(textLooksValid(bytes(0xc3, 0x28), false), false);
  assert.equal(textLooksValid(utf8.encode('{"a": [1, 2]}'), true), true);
  assert.equal(textLooksValid(utf8.encode('\uFEFF{"a": 1}'), true), true);
  assert.equal(textLooksValid(utf8.encode("{not json"), true), false);
});

test("AC-CR-19: names are sanitized exactly as the plan's table says", () => {
  const cases: Array<[string, number, string]> = [
    ["photo.PNG", 1, "photo.png"],
    ["../../etc/passwd.png", 1, "passwd.png"],
    ["C:\\Users\\x\\shot.jpg", 1, "shot.jpg"],
    ["a\u0000b\u001f.txt", 1, "ab.txt"],
    ["what?<now>.md", 1, "what__now_.md"],
    ["..png", 1, "file-1.png"],
    [".png", 3, "file-3.png"],
    ["CON.txt", 1, "_CON.txt"],
    ["lpt9.pdf", 1, "_lpt9.pdf"],
    [`${"x".repeat(300)}.pdf`, 1, `${"x".repeat(100)}.pdf`],
    ["  report   final .pdf", 1, "report final.pdf"],
    ["a...b.json", 1, "a.b.json"],
    ["e\u0301.txt", 1, "\u00e9.txt"],
    ["shot.png. ", 1, "shot.png"],
    // 3 bytes each in UTF-8: 66 of them are 198 bytes, a 67th would be 201 (over 200).
    [`${"\u6f22".repeat(90)}.txt`, 1, `${"\u6f22".repeat(66)}.txt`],
  ];
  for (const [raw, position, expected] of cases) assert.equal(sanitizeAttachmentName(raw, position), expected, JSON.stringify(raw));
});

test("AC-CR-19: a pasted image is pasted-<n> by its type; colliding names get -2, -3 ignoring case", () => {
  assert.equal(pastedNameOf(2, "image/png"), "pasted-2.png");
  assert.equal(pastedNameOf(1, "image/jpeg"), "pasted-1.jpg");
  assert.equal(pastedNameOf(4, "image/webp"), "pasted-4.webp");
  assert.deepEqual(uniqueAttachmentNames(["shot.png", "Shot.png", "shot.png"]), ["shot.png", "Shot-2.png", "shot-3.png"]);
  assert.deepEqual(uniqueAttachmentNames(["a.txt", "b.txt"]), ["a.txt", "b.txt"]);
});
