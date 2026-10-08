import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEDIA_SETTINGS, MEDIA_CUDA_VERSIONS } from "./contracts";
import { allowedCudaVersionsFor, comfyCudaDevice, compareCudaVersions, higherCudaVersion, hostCudaTooOld, jobErrorCode, withJobErrorCode } from "./cuda-host";

// BL-155 (docs/roadmap/plans/CUDA_HOSTS_PLAN.md, AC-CU-01/02/04), written before the module. Expected values are stated by
// hand from the plan and RunPod's documented list of CUDA versions (11.8, 12.0-12.9, 13.0; "the host driver's maximum").

test("AC-CU-01: the known CUDA versions are RunPod's list, and the default minimum is 12.8 (the template image is -cuda12.8)", () => {
  assert.deepEqual([...MEDIA_CUDA_VERSIONS], ["11.8", "12.0", "12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9", "13.0"]);
  assert.equal(DEFAULT_MEDIA_SETTINGS.minCudaVersion, "12.8");
});

test("AC-CU-01: versions compare numerically (major, then minor), never as text", () => {
  assert.equal(compareCudaVersions("12.4", "12.8"), -1);
  assert.equal(compareCudaVersions("12.8", "12.8"), 0);
  assert.equal(compareCudaVersions("13.0", "12.9"), 1);
  assert.equal(compareCudaVersions("12.10", "12.9"), 1, "as text 12.10 < 12.9; as numbers it is newer");
  assert.equal(compareCudaVersions("11.8", "12.0"), -1);
  assert.equal(compareCudaVersions("12.4.1", "12.4"), 0, "a patch level is not part of the comparison");
  assert.equal(compareCudaVersions("cuda", "12.8"), null);
  assert.equal(compareCudaVersions("", "12.8"), null);
});

test("AC-CU-01: allowedCudaVersions = every known version at or above the minimum; no minimum = no filter", () => {
  assert.deepEqual(allowedCudaVersionsFor("12.8"), ["12.8", "12.9", "13.0"]);
  assert.deepEqual(allowedCudaVersionsFor("13.0"), ["13.0"]);
  assert.deepEqual(allowedCudaVersionsFor("11.8"), ["11.8", "12.0", "12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9", "13.0"]);
  assert.equal(allowedCudaVersionsFor(null), null);
});

test("AC-CU-02: a host is too old only when its CUDA version is known and below the minimum", () => {
  assert.equal(hostCudaTooOld("12.4", "12.8"), true);
  assert.equal(hostCudaTooOld("12.8", "12.8"), false);
  assert.equal(hostCudaTooOld("13.0", "12.8"), false);
  assert.equal(hostCudaTooOld(null, "12.8"), false, "unknown (the read failed) does not block");
  assert.equal(hostCudaTooOld("n/a", "12.8"), false, "an unreadable value is unknown");
  assert.equal(hostCudaTooOld("11.8", null), false, "no minimum = no check");
});

test("AC-CU-02: ComfyUI's /system_stats must list a cuda device with VRAM; an unreadable device list is unknown", () => {
  const cuda = { name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", type: "cuda", index: 0, vram_total: 25_386_352_640, vram_free: 24_000_000_000 };
  assert.equal(comfyCudaDevice({ system: {}, devices: [cuda] }), "ok");
  assert.equal(comfyCudaDevice({ system: {}, devices: [{ name: "cpu", type: "cpu", index: null, vram_total: 67_000_000_000 }] }), "none");
  assert.equal(comfyCudaDevice({ system: {}, devices: [{ ...cuda, vram_total: 0 }] }), "none");
  assert.equal(comfyCudaDevice({ system: {}, devices: [] }), "none");
  assert.equal(comfyCudaDevice({ system: {}, devices: [{ name: "cpu", type: "cpu" }, cuda] }), "ok");
  assert.equal(comfyCudaDevice({ system: {} }), "unknown");
  assert.equal(comfyCudaDevice({ system: {}, devices: "cuda" }), "unknown");
});

test("AC-CU-04: a job error saying the CUDA driver is too old carries media_gpu_host_incompatible; any other error none", () => {
  // The two texts the CUDA runtime / PyTorch print for a driver older than the image's CUDA.
  assert.equal(jobErrorCode("ComfyUI reported an error: RuntimeError: CUDA error: CUDA driver version is insufficient for CUDA runtime version"), "media_gpu_host_incompatible");
  assert.equal(jobErrorCode("The NVIDIA driver on your system is too old (found version 12040). Please update your GPU driver"), "media_gpu_host_incompatible");
  // A GPU architecture the image has no kernel for is not a driver age problem: another host of that GPU type fails alike.
  assert.equal(jobErrorCode("CUDA error: no kernel image is available for execution on the device"), null);
  assert.equal(jobErrorCode("cuda DRIVER VERSION IS INSUFFICIENT"), "media_gpu_host_incompatible", "case does not matter");
  assert.equal(jobErrorCode("CUDA out of memory. Tried to allocate 2.00 GiB"), null);
  assert.equal(jobErrorCode("Prompt outputs failed validation"), null);
  assert.equal(jobErrorCode(null), null);
  assert.equal(jobErrorCode(""), null);
});

test("AC-CU-04: the factory's job view adds errorCode next to the job's own fields, derived from its error, nothing stored", () => {
  const job = { jobId: "j1", status: "failed", error: "CUDA driver version is insufficient for CUDA runtime version" };
  assert.deepEqual(withJobErrorCode(job), { ...job, errorCode: "media_gpu_host_incompatible" });
  assert.deepEqual(withJobErrorCode({ jobId: "j2", status: "done", error: null }), { jobId: "j2", status: "done", error: null, errorCode: null });
  assert.equal("errorCode" in job, false, "the input is not changed");
});

// ---- BL-159 (FO-REQ-0011; owner, msgs 2188-2189: the operator may only raise the minimum, the owner's value is the floor) ----

test("AC-SC-01: a session's own minimum only raises the owner's -- the plan's examples", () => {
  assert.equal(higherCudaVersion("12.8", "13.0"), "13.0", "owner 12.8, session 13.0 -> 13.0");
  assert.equal(higherCudaVersion("12.8", "12.4"), "12.8", "owner 12.8, session 12.4 -> clamped to 12.8, not refused");
  assert.equal(higherCudaVersion("12.8", null), "12.8", "no session value -> the owner's");
  assert.equal(higherCudaVersion(null, "13.0"), "13.0", "no owner setting -> the session's alone");
  assert.equal(higherCudaVersion(null, null), null, "neither -> no filter");
  assert.equal(higherCudaVersion("12.8", "12.8"), "12.8");
});

test("AC-SC-01: the comparison is numeric (12.10 is above 12.9), never text order", () => {
  assert.equal(higherCudaVersion("12.9", "12.10"), "12.10");
  assert.equal(higherCudaVersion("12.10", "12.9"), "12.10");
});
