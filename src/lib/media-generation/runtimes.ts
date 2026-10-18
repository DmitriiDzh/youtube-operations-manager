import { z } from "zod";
import type { RunpodS3Client } from "@/lib/media-gateway";
import { DomainError, RUNTIME_ID_PATTERN, type MediaSettings } from "./contracts";
import type { MediaControlEvent, PullActor } from "./models";
import { parseWithSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-200 (FO-REQ-0029, ADR 0043, docs/roadmap/plans/POD_RUNTIMES_PLAN.md) -- pod runtime profiles. A profile pins ComfyUI and
// custom-node packs to exact commits (plus pinned pip extras) and lives as ONE immutable JSON on the shared network volume:
//   ytm/runtimes/<runtimeId>/runtime.json   the profile (written once, never edited -- a change is a new profile)
//   ytm/runtimes/<runtimeId>/build.json     the build pod's verdict { ok, seconds, error } (stage 2)
//   ytm/runtimes/<runtimeId>/test.json      the app's test result: ComfyUI version, node list, per-template result (stage 3)
// Every computer already shares that volume, so profiles need no sync family of their own.
// ---------------------------------------------------------------------------

export const RUNTIMES_PREFIX = "ytm/runtimes/";
export const COMFYUI_REPO = "https://github.com/comfyanonymous/ComfyUI";
const COMMIT = /^[0-9a-f]{40}$/;

export const runtimeKey = (runtimeId: string, file: "runtime.json" | "build.json" | "test.json") => `${RUNTIMES_PREFIX}${runtimeId}/${file}`;

const repoUrlSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?\/?$/, "an https repository URL like https://github.com/owner/repo")
  .transform((url) => url.replace(/\/$/, "").replace(/\.git$/, ""));
const commitSchema = z.string().trim().toLowerCase().regex(COMMIT, "an exact commit: 40 hex characters (a tag or branch can move)");
const pipSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]{1,100}\])?==[A-Za-z0-9.!+_-]{1,64}$/, "a pinned package: name==version")
  // The runtime always uses the pod image's own torch stack (probe 1; the build pins it as a constraint).
  .refine((spec) => !/^(torch|torchvision|torchaudio)(\[|==)/i.test(spec), "torch, torchvision and torchaudio come from the pod image and cannot be pinned here");

export const createRuntimeInputSchema = z
  .object({
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN, "a runtime id is 3-63 lower-case letters, digits or '-'"),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    comfy: z
      .object({
        repo: repoUrlSchema.optional(),
        /** A tag or branch (resolved to its commit through GitHub now) or an exact commit. */
        ref: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, "a tag, branch or commit"),
      })
      .strict(),
    customNodes: z.array(z.object({ repo: repoUrlSchema, commit: commitSchema }).strict()).max(50).optional(),
    pip: z.array(pipSchema).max(100).optional(),
  })
  .strict();

const runtimeFileSchema = z
  .object({
    schema: z.literal("ytm.media-runtime"),
    schemaVersion: z.literal(1),
    runtimeId: z.string().regex(RUNTIME_ID_PATTERN),
    name: z.string().max(120).nullable(),
    description: z.string().max(1000).nullable(),
    comfy: z.object({ repo: z.string(), commit: z.string().regex(COMMIT), ref: z.string().nullable() }).strict(),
    customNodes: z.array(z.object({ repo: z.string(), commit: z.string().regex(COMMIT) }).strict()),
    pip: z.array(z.string()),
    createdAt: z.string(),
    createdBy: z.enum(["owner", "factory"]),
  })
  .strict();
export type RuntimeProfile = z.infer<typeof runtimeFileSchema>;

const buildFileSchema = z.object({ ok: z.boolean(), seconds: z.number().nullable().optional(), error: z.string().nullable().optional(), finishedAt: z.string().nullable().optional() }).passthrough();
const testFileSchema = z
  .object({
    ok: z.boolean(),
    testedAt: z.string(),
    comfyVersion: z.string().nullable(),
    nodes: z.array(z.string()),
    templates: z.array(
      z
        .object({
          templateId: z.string(),
          version: z.number(),
          ok: z.boolean(),
          missing: z.array(z.string()),
          /** FO-REQ-0030: the graph's inputs against the runtime's node definitions (absent in tests before it). */
          invalid: z.array(z.object({ nodeId: z.string(), classType: z.string(), input: z.string(), problem: z.enum(["required_missing", "unknown_input", "bad_value", "out_of_range"]), allowed: z.unknown().optional() }).strict()).optional(),
        })
        .strict()
    ),
    /** Whether every registry template was checked (not a chosen subset): only such a passed test makes a runtime activatable. */
    allTemplates: z.boolean().optional(),
    costUsd: z.number().nullable(),
    bootSeconds: z.number().nullable(),
    error: z.string().nullable().optional(),
  });
// Not `.passthrough()`: its index signature would erase the known keys from `Omit<RuntimeTestResult, ...>` below; a newer
// version's extra fields are simply not read.
export type RuntimeTestResult = z.infer<typeof testFileSchema>;

export type RuntimeStatus = "created" | "building" | "build_failed" | "built" | "test_failed" | "tested";

export type RuntimeView = RuntimeProfile & {
  status: RuntimeStatus;
  active: boolean;
  /** AC-RT-03: `.ready` on the volume -- the build's own last step; without it the runtime is not built, whatever build.json says. */
  ready: boolean;
  build: { ok: boolean; seconds: number | null; error: string | null; finishedAt: string | null } | null;
  test: Omit<RuntimeTestResult, "nodes"> & { nodeCount: number } | null;
};

/** Whether `repo` is under one of the owner's allowed prefixes (HTTPS, case-insensitive, a whole path segment). */
export function isAllowedSource(repo: string, allowlist: readonly string[]): boolean {
  const url = `${repo.toLowerCase().replace(/\/$/, "")}/`;
  return allowlist.some((prefix) => {
    const p = prefix.toLowerCase().endsWith("/") ? prefix.toLowerCase() : `${prefix.toLowerCase()}/`;
    return p.startsWith("https://") && url.startsWith(p);
  });
}

/** A GitHub https URL's owner and repository, or null for any other host. */
export function githubRepoOf(repo: string): { owner: string; repo: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(repo);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * BL-200 (AC-RT-05/07): the node types an API-format graph needs -- the `class_type` of every node. The graph itself states
 * exactly what it needs, so no separate `requiredNodes` field is kept (POD_RUNTIMES_PLAN.md stage 3); null = not a graph.
 */
export function requiredNodeTypes(workflowJson: string): string[] | null {
  let graph: unknown;
  try {
    graph = JSON.parse(workflowJson);
  } catch {
    return null;
  }
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
  const types = new Set<string>();
  for (const node of Object.values(graph as Record<string, unknown>)) {
    const classType = node && typeof node === "object" ? (node as Record<string, unknown>).class_type : undefined;
    if (typeof classType === "string" && classType) types.add(classType);
  }
  return [...types].sort();
}

/** The node types of `workflowJson` that `nodes` lacks (sorted); an unreadable graph lacks nothing that can be named. */
export function missingNodeTypes(workflowJson: string, nodes: ReadonlySet<string>): string[] {
  return (requiredNodeTypes(workflowJson) ?? []).filter((type) => !nodes.has(type));
}

/**
 * AC-RT-06: a settings save may resend `activeRuntimeId` unchanged, but never change it -- that is the activation's own action, which
 * checks the test (the settings sync applies a peer's value without this guard).
 */
export function assertActiveRuntimeUnchanged(update: unknown, current: string | null): void {
  const requested = update && typeof update === "object" ? (update as Record<string, unknown>).activeRuntimeId : undefined;
  if (requested !== undefined && requested !== current) {
    throw new DomainError({ code: "validation_failed", message: "The active pod runtime is set with its own action (Servers → Setup → Pod runtimes, or factory_media_activate_runtime), which checks its test.", details: { field: "activeRuntimeId" } });
  }
}

export type TestedRuntime = { nodes: Set<string>; comfyVersion: string | null; templates: RuntimeTestResult["templates"] };

/**
 * BL-200 AC-RT-07 + FO-REQ-0030: why a template cannot run on a tested runtime -- node types its graph needs that the runtime lacks,
 * and the blocking input problems the runtime's last test found in THIS version of the template (another version's are not its).
 */
export function templateRuntimeProblems(template: { templateId: string; version: number; workflowJson: string }, tested: TestedRuntime): { missing: string[]; invalid: NonNullable<RuntimeTestResult["templates"][number]["invalid"]> } {
  const missing = missingNodeTypes(template.workflowJson, tested.nodes);
  const result = tested.templates.find((t) => t.templateId === template.templateId && t.version === template.version);
  const invalid = (result?.invalid ?? []).filter((i) => i.problem !== "unknown_input");
  return { missing, invalid };
}

/** The refusal for those problems, or null when there are none. */
export function runtimeIncompatibleError(templateId: string, runtimeId: string, problems: ReturnType<typeof templateRuntimeProblems>, extra: Record<string, unknown> = {}): DomainError | null {
  if (problems.missing.length === 0 && problems.invalid.length === 0) return null;
  const parts = [
    problems.missing.length > 0 ? `node types it lacks: ${problems.missing.join(", ")}` : null,
    problems.invalid.length > 0 ? `inputs its test found wrong: ${problems.invalid.map((i) => `node ${i.nodeId} ${i.classType}.${i.input} ${i.problem}`).join("; ")}` : null,
  ].filter(Boolean);
  return new DomainError({
    code: "media_runtime_incompatible",
    message: `Template ${templateId} cannot run on runtime ${runtimeId} -- ${parts.join("; ")}. Fix the template (a new version) or use another runtime; no pod time was spent on it.`,
    details: { ...extra, templateId, runtimeId, missing: problems.missing, invalid: problems.invalid },
  });
}

export type RuntimeDeps = {
  s3(): Promise<RunpodS3Client>;
  github: {
    listReleases(owner: string, repo: string): Promise<Array<{ tag: string; name: string | null; publishedAt: string | null; prerelease: boolean }>>;
    resolveCommit(owner: string, repo: string, ref: string): Promise<{ commit: string; date: string | null }>;
  };
  getSettings(): Promise<MediaSettings>;
  events: { record(event: MediaControlEvent): Promise<void> };
  clock: { now(): Date };
  /** Stage 2: the runtime ids whose build is running on this computer (the build module's job list). */
  buildingRuntimeIds?: () => Promise<Set<string>>;
};

function parseJson<T>(schema: z.ZodType<T>, text: string | null): T | null {
  if (!text) return null;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function createRuntimeServices(deps: RuntimeDeps) {
  async function readProfile(s3: RunpodS3Client, runtimeId: string): Promise<RuntimeProfile | null> {
    return parseJson(runtimeFileSchema, await s3.getObjectText(runtimeKey(runtimeId, "runtime.json")));
  }

  async function view(s3: RunpodS3Client, profile: RuntimeProfile, settings: MediaSettings, building: Set<string> = new Set()): Promise<RuntimeView & { testDetail: RuntimeTestResult | null }> {
    const [buildText, testText, readyHead] = await Promise.all([
      s3.getObjectText(runtimeKey(profile.runtimeId, "build.json")),
      s3.getObjectText(runtimeKey(profile.runtimeId, "test.json")),
      s3.headObject(`${RUNTIMES_PREFIX}${profile.runtimeId}/.ready`),
    ]);
    const build = parseJson(buildFileSchema, buildText);
    const test = parseJson(testFileSchema, testText);
    const ready = readyHead !== null;
    const status: RuntimeStatus = building.has(profile.runtimeId)
      ? "building"
      : !ready
        ? build && !build.ok
          ? "build_failed"
          : "created"
        : test
          ? test.ok
            ? "tested"
            : "test_failed"
          : "built";
    return {
      ...profile,
      status,
      active: settings.activeRuntimeId === profile.runtimeId,
      ready,
      build: build ? { ok: build.ok, seconds: build.seconds ?? null, error: build.error ?? null, finishedAt: build.finishedAt ?? null } : null,
      test: test ? (({ nodes, ...rest }) => ({ ...rest, nodeCount: nodes.length }))(test) : null,
      testDetail: test,
    };
  }

  function stripDetail<T extends { testDetail: unknown }>(v: T): Omit<T, "testDetail"> {
    const { testDetail: _detail, ...rest } = v;
    void _detail;
    return rest;
  }

  return {
    /** Every profile on the volume, newest first, with its build / test state and whether it is the active one. */
    async listRuntimes(): Promise<{ runtimes: RuntimeView[]; activeRuntimeId: string | null }> {
      const [s3, settings, building] = await Promise.all([deps.s3(), deps.getSettings(), deps.buildingRuntimeIds?.() ?? new Set<string>()]);
      // FO-MSG-0019: only the folders one level down -- never the ~20 000 files of each runtime's venv (that listing timed out).
      const ids = (await s3.listFolders(RUNTIMES_PREFIX))
        .map((folder) => folder.slice(RUNTIMES_PREFIX.length).replace(/\/$/, ""))
        .filter((id) => RUNTIME_ID_PATTERN.test(id));
      const profiles = (await Promise.all(ids.map((id) => readProfile(s3, id)))).filter((p): p is RuntimeProfile => p !== null);
      const views = await Promise.all(profiles.map((p) => view(s3, p, settings, building).then(stripDetail)));
      views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { runtimes: views as RuntimeView[], activeRuntimeId: settings.activeRuntimeId };
    },

    /** One profile with its full test result (per template) -- the node list itself only as a count. */
    async getRuntime(runtimeId: string): Promise<RuntimeView & { templates: RuntimeTestResult["templates"] }> {
      const [s3, settings, building] = await Promise.all([deps.s3(), deps.getSettings(), deps.buildingRuntimeIds?.() ?? new Set<string>()]);
      const profile = await readProfile(s3, runtimeId);
      if (!profile) throw new DomainError({ code: "not_found", message: `No runtime profile ${runtimeId} on the network volume.`, details: { runtimeId } });
      const v = await view(s3, profile, settings, building);
      return { ...(stripDetail(v) as RuntimeView), templates: v.testDetail?.templates ?? [] };
    },

    /** The tested node list of a profile (null when it was never tested) -- for the pre-pod template check. */
    async testedNodes(runtimeId: string): Promise<TestedRuntime | null> {
      const s3 = await deps.s3();
      const test = parseJson(testFileSchema, await s3.getObjectText(runtimeKey(runtimeId, "test.json")));
      return test ? { nodes: new Set(test.nodes), comfyVersion: test.comfyVersion, templates: test.templates } : null;
    },

    /** Stage 3 (AC-RT-05): the test's result beside the profile (`test.json`); a newer test replaces it. */
    async writeTestResult(runtimeId: string, result: RuntimeTestResult): Promise<void> {
      const s3 = await deps.s3();
      await s3.putObject(runtimeKey(runtimeId, "test.json"), JSON.stringify(testFileSchema.parse(result), null, 2), "application/json");
    },

    /**
     * Stage 3 (AC-RT-06): whether `runtimeId` may become the active runtime. `null` (the image's built-in ComfyUI) always may --
     * it is the rollback of last resort. A profile needs a passed test. The Factory Operator needs the owner's switch on; the
     * owner never does. Returns the profile's id and the one it replaces.
     */
    async checkActivation(runtimeId: string | null, actor: PullActor): Promise<{ from: string | null; to: string | null }> {
      const settings = await deps.getSettings();
      if (actor === "factory" && !settings.factoryMayActivateRuntime) {
        throw new DomainError({ code: "media_runtime_activation_disabled", message: "The owner has switched off \"The Operator may make a runtime active\" (Servers → Setup); the Operator can still create and test runtimes.", details: { runtimeId } });
      }
      if (runtimeId !== null) {
        const s3 = await deps.s3();
        const profile = await readProfile(s3, runtimeId);
        if (!profile) throw new DomainError({ code: "not_found", message: `No runtime profile ${runtimeId} on the network volume.`, details: { runtimeId } });
        const v = await view(s3, profile, settings);
        if (v.status !== "tested" || v.testDetail?.allTemplates === false) {
          throw new DomainError({
            code: "media_runtime_not_ready",
            message:
              v.status === "tested"
                ? `Runtime ${runtimeId} was tested against chosen templates only; test it against every registry template (factory_media_test_runtime without templateIds) before it can become active.`
                : `Runtime ${runtimeId} is ${v.status}; only a runtime whose test passed can become active (factory_media_test_runtime).`,
            details: { runtimeId, status: v.status, templates: v.testDetail?.templates.filter((t) => !t.ok) ?? [] },
          });
        }
      }
      return { from: settings.activeRuntimeId, to: runtimeId };
    },

    /** ComfyUI's newest releases on GitHub (for choosing a `comfy.ref`). */
    async listComfyReleases() {
      const gh = githubRepoOf(COMFYUI_REPO)!;
      return { repo: COMFYUI_REPO, releases: await deps.github.listReleases(gh.owner, gh.repo) };
    },

    /**
     * AC-RT-01/02: a new immutable profile. Every repo must sit under the owner's allow-list; node packs name an exact commit; a
     * ComfyUI tag or branch is resolved to its commit now and only the commit is stored; pip extras are pinned. Nothing is built.
     */
    async createRuntime(input: unknown, options: { actor?: PullActor } = {}): Promise<RuntimeView> {
      const parsed = parseWithSchema(createRuntimeInputSchema, input, "runtime profile");
      const actor = options.actor ?? "owner";
      const settings = await deps.getSettings();
      const comfyRepo = parsed.comfy.repo ?? COMFYUI_REPO;
      const sources = [comfyRepo, ...(parsed.customNodes ?? []).map((n) => n.repo)];
      const refused = sources.filter((repo) => !isAllowedSource(repo, settings.runtimeSourceAllowlist));
      if (refused.length > 0) {
        throw new DomainError({
          code: "validation_failed",
          message: `These repositories are not in the owner's allowed sources (Servers → Setup): ${refused.join(", ")}.`,
          details: { refused, allowlist: settings.runtimeSourceAllowlist },
        });
      }
      const repos = (parsed.customNodes ?? []).map((n) => n.repo.toLowerCase());
      if (new Set(repos).size !== repos.length) throw new DomainError({ code: "validation_failed", message: "A node pack repository is listed twice.", details: { repos } });
      // Each pack is cloned into custom_nodes/<repo name>: two packs of the same name (different owners) would overwrite (review).
      const folders = repos.map((r) => r.split("/").pop()!);
      const clashing = folders.filter((f, i) => folders.indexOf(f) !== i);
      if (clashing.length > 0) throw new DomainError({ code: "validation_failed", message: `Two node packs share the folder name ${[...new Set(clashing)].join(", ")}; only one of them can be installed.`, details: { folders: [...new Set(clashing)] } });

      const s3 = await deps.s3();
      if (await s3.headObject(runtimeKey(parsed.runtimeId, "runtime.json"))) {
        throw new DomainError({ code: "validation_failed", message: `A runtime profile ${parsed.runtimeId} already exists; profiles are never edited -- create one with a new id.`, details: { runtimeId: parsed.runtimeId } });
      }

      let commit: string;
      if (COMMIT.test(parsed.comfy.ref.toLowerCase())) commit = parsed.comfy.ref.toLowerCase();
      else {
        const gh = githubRepoOf(comfyRepo);
        if (!gh) throw new DomainError({ code: "validation_failed", message: "Only a GitHub ComfyUI repository can be given a tag or branch; give an exact commit instead.", details: { repo: comfyRepo } });
        commit = (await deps.github.resolveCommit(gh.owner, gh.repo, parsed.comfy.ref)).commit;
      }

      const profile: RuntimeProfile = {
        schema: "ytm.media-runtime",
        schemaVersion: 1,
        runtimeId: parsed.runtimeId,
        name: parsed.name ?? null,
        description: parsed.description ?? null,
        comfy: { repo: comfyRepo, commit, ref: COMMIT.test(parsed.comfy.ref.toLowerCase()) ? null : parsed.comfy.ref },
        customNodes: (parsed.customNodes ?? []).map((n) => ({ repo: n.repo, commit: n.commit })),
        pip: parsed.pip ?? [],
        createdAt: deps.clock.now().toISOString(),
        createdBy: actor,
      };
      await s3.putObject(runtimeKey(profile.runtimeId, "runtime.json"), JSON.stringify(profile, null, 2), "application/json");
      await deps.events.record({ actor, action: "runtime_created", subject: profile.runtimeId, details: { comfyCommit: commit, comfyRef: profile.comfy.ref, customNodes: profile.customNodes.length, pip: profile.pip.length } });
      return stripDetail(await view(s3, profile, settings)) as RuntimeView;
    },
  };
}

export type RuntimeServices = ReturnType<typeof createRuntimeServices>;
