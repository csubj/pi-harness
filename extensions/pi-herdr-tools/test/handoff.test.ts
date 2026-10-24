import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrHandoffExtension from "../internal/handoff.ts";
import { shellProbe, success, withPane, type ExecResult } from "./helper.ts";

type Execute = (id: string, params: Record<string, string>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: { cwd: string }) =>
	Promise<{ content: Array<{ text: string }>; details: Record<string, string> }>;

const params = { branch: "fix/login", label: "Fix login", agentName: "login-fixer", prompt: "Fix the login bug.\nRun npm test." };

function harness(respond: (command: string, args: string[], cwd?: string) => ExecResult | undefined, cwd = "/repos/main-wt") {
	let execute: Execute | undefined;
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const api = {
		registerTool(tool: { name: string; execute: Execute }) {
			if (tool.name === "herdr_handoff") execute = tool.execute;
		},
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			calls.push({ command, args, cwd: options?.cwd });
			return respond(command, args, options?.cwd) ?? shellProbe(args) ?? success();
		},
	} as unknown as ExtensionAPI;
	herdrHandoffExtension(api);
	assert.ok(execute);
	const run = (signal?: AbortSignal, extra: Record<string, string> = {}) => execute!("call-1", { ...params, ...extra }, signal, undefined, { cwd });
	const created = () => calls.some((call) => call.args[0] === "worktree" && call.args[1] === "create");
	return { run, calls, created };
}

const failure: ExecResult = { stdout: "", stderr: "", code: 1, killed: false };

function linkedWorktree(command: string, args: string[], rootAgent?: string): ExecResult | undefined {
	if (command === "git") {
		if (args[0] === "show-ref") return failure;
		return success(args.includes("--git-common-dir") ? "/repos/main/.git\n" : "abc123\n");
	}
	if (args[0] === "pane" && args[1] === "get") {
		return args[2] === "pane-root"
			? success({ result: { pane: { pane_id: "pane-root", workspace_id: "workspace-new", agent: rootAgent } } })
			: success({ result: { pane: { pane_id: "pane-linked", workspace_id: "workspace-linked" } } });
	}
	if (args[0] === "workspace" && args[1] === "get") {
		return success({ result: { workspace: {
			workspace_id: args[2],
			worktree: { checkout_path: "/repos/main-wt", repo_root: "/repos/main", is_linked_worktree: true },
		} } });
	}
	if (args[0] === "workspace" && args[1] === "list") {
		return success({ result: { workspaces: [
			{ workspace_id: "workspace-parent", worktree: { checkout_path: "/repos/main", is_linked_worktree: false } },
			{ workspace_id: "workspace-linked", worktree: { checkout_path: "/repos/main-wt", repo_root: "/repos/main", is_linked_worktree: true } },
		] } });
	}
	if (args[0] === "worktree" && args[1] === "create") {
		return success({ result: {
			workspace: { workspace_id: "workspace-new", worktree: { checkout_path: "/repos/fix-login" } },
			tab: { tab_id: "tab-new" },
			root_pane: { pane_id: "pane-root" },
		} });
	}
	if (args[0] === "tab" && args[1] === "create") {
		return success({ result: { tab: { tab_id: "tab-extra" }, root_pane: { pane_id: "pane-extra" } } });
	}
	return undefined;
}

test("herdr_handoff creates the worktree from main through the parent workspace and delivers the prompt", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) => linkedWorktree(command, args));
		const result = await app.run();

		const herdrArgs = app.calls.filter((call) => call.command === "herdr").map((call) => call.args);
		assert.deepEqual(herdrArgs.find((args) => args[0] === "worktree"), [
			"worktree", "create", "--workspace", "workspace-parent",
			"--branch", "fix/login", "--base", "main", "--label", "Fix login", "--no-focus",
		]);
		assert.deepEqual(herdrArgs.find((args) => args[1] === "start"), [
			"agent", "start", "login-fixer", "--kind", "pi", "--pane", "pane-root", "--",
		]);
		assert.deepEqual(herdrArgs.at(-1), [
			"agent", "prompt", "login-fixer", params.prompt, "--wait", "--until", "working", "--timeout", "30000",
		]);
		assert.equal(herdrArgs.some((args) => args[1] === "focus"), false);
		assert.deepEqual(result.details, {
			workspaceId: "workspace-new", tabId: "tab-new", paneId: "pane-root",
			branch: "fix/login", checkoutPath: "/repos/fix-login", agentName: "login-fixer",
		});
	});
});

test("herdr_handoff creates nothing when a precondition fails or the call is cancelled", async () => {
	let commonDirCalls = 0;
	const cases: Array<[string, (command: string, args: string[]) => ExecResult | undefined, RegExp, AbortSignal?]> = [
		["no local main", (command, args) => command === "git" && args.includes("refs/heads/main") ? failure : undefined, /local main branch/],
		["existing branch", (command, args) => command === "git" && args[0] === "show-ref" ? success() : undefined, /fix\/login already exists/],
		["other repository", (command, args) => command === "git" && args.includes("--git-common-dir")
			? success(`/repos/${++commonDirCalls === 1 ? "other" : "main"}/.git\n`)
			: undefined, /different Git repositories/],
		["cancelled", () => undefined, /abort/i, AbortSignal.abort()],
	];
	for (const [name, override, pattern, signal] of cases) {
		await withPane("pane-linked", async () => {
			const app = harness((command, args) => override(command, args) ?? linkedWorktree(command, args));
			await assert.rejects(app.run(signal), pattern, name);
			assert.equal(app.created(), false, name);
		});
	}
});

test("herdr_handoff names the retained worktree when launch preparation fails", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) => args[0] === "tab" && args[1] === "create"
			? { stdout: "", stderr: "tab create failed", code: 1, killed: false }
			: linkedWorktree(command, args, "pi"));
		await assert.rejects(app.run(), (error: Error) => {
			for (const pattern of [/workspace-new/, /tab-new/, /pane-root/, /fix\/login/, /\/repos\/fix-login/, /tab create failed/]) {
				assert.match(error.message, pattern);
			}
			return true;
		});
	});
});

test("herdr_handoff names every retained resource when prompt delivery fails", async () => {
	await withPane("pane-linked", async () => {
		const app = harness((command, args) => args[0] === "agent" && args[1] === "prompt"
			? { stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }), stderr: "", code: 1, killed: false }
			: linkedWorktree(command, args, "pi"));
		await assert.rejects(app.run(), (error: Error) => {
			for (const pattern of [
				/workspace-new/, /tab-extra/, /pane-extra/, /fix\/login/, /\/repos\/fix-login/, /agent login-fixer/, /agent_prompt_stalled/,
			]) assert.match(error.message, pattern);
			return true;
		});
	});
});

async function withParent(run: (parent: string, repoRoot: string) => Promise<void>): Promise<void> {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-handoff-parent-")));
	const repoRoot = join(parent, "team", "service");
	await mkdir(join(repoRoot, "src"), { recursive: true });
	try {
		await run(parent, repoRoot);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

function childRepository(repoRoot: string) {
	return (command: string, args: string[], cwd?: string): ExecResult | undefined => {
		if (command === "git" && args.includes("--show-toplevel")) {
			return cwd?.startsWith(repoRoot) ? success(`${repoRoot}\n`) : failure;
		}
		return linkedWorktree(command, args);
	};
}

test("herdr_handoff with repo creates the worktree in the child repository through --cwd", async () => {
	await withParent(async (parent, repoRoot) => {
		await withPane("pane-parent", async () => {
			const app = harness(childRepository(repoRoot), parent);
			const result = await app.run(undefined, { repo: "team/service" });

			const herdrArgs = app.calls.filter((call) => call.command === "herdr").map((call) => call.args);
			assert.deepEqual(herdrArgs.find((args) => args[0] === "worktree"), [
				"worktree", "create", "--cwd", repoRoot,
				"--branch", "fix/login", "--base", "main", "--label", "Fix login", "--no-focus",
			]);
			assert.equal(herdrArgs.some((args) => args[0] === "workspace"), false);
			for (const check of ["rev-parse", "show-ref"]) {
				const call = app.calls.find((entry) => entry.command === "git" && entry.args[0] === check && !entry.args.includes("--show-toplevel"));
				assert.equal(call?.cwd, repoRoot, check);
			}
			assert.equal(result.details.repo, "team/service");
		});
	});
});

test("herdr_handoff rejects an invalid repo before it creates anything", async () => {
	await withParent(async (parent, repoRoot) => {
		const cases: Array<[string, RegExp]> = [
			["../outside", /\.\. component/],
			["missing", /does not exist/],
			["team/service/src", /not a Git top-level directory/],
		];
		for (const [repo, pattern] of cases) {
			await withPane("pane-parent", async () => {
				const app = harness(childRepository(repoRoot), parent);
				await assert.rejects(app.run(undefined, { repo }), (error: Error) => {
					assert.match(error.message, pattern, repo);
					assert.match(error.message, /Nothing was created/, repo);
					return true;
				});
				assert.equal(app.created(), false, repo);
			});
		}
	});
});

test("herdr_handoff without repo asks for one when the workspace has no Git checkout", async () => {
	await withPane("pane-parent", async () => {
		const app = harness((command, args) => args[0] === "workspace" && args[1] === "get"
			? success({ result: { workspace: { workspace_id: args[2], worktree: null } } })
			: linkedWorktree(command, args), "/code/group");
		await assert.rejects(app.run(), /has no Git checkout\. Set repo/);
		assert.equal(app.created(), false);
	});
});
