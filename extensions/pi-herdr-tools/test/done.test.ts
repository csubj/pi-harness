import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { withWorktreeLock } from "@hcflabs/pi-herdr";
import herdrDoneExtension from "../internal/done.ts";

type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
type ExecCall = { command: string; args: string[]; options: { cwd: string } };
type Executor = (call: ExecCall) => ExecResult | Promise<ExecResult>;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const checkout = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-done-")));
const mainCheckoutDir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-done-main-")));
after(async () => {
	await rm(checkout, { recursive: true, force: true });
	await rm(mainCheckoutDir, { recursive: true, force: true });
});

function harness(executor: Executor = () => ok()) {
	let command: Command | undefined;
	const calls: ExecCall[] = [];
	const api = {
		registerCommand(name: string, options: { handler: Command }) {
			if (name === "done") command = options.handler;
		},
		exec: async (executable: string, args: string[], options: { cwd: string }) => {
			const call = { command: executable, args, options };
			calls.push(call);
			return executor(call);
		},
	} as unknown as ExtensionAPI;
	herdrDoneExtension(api);
	assert.ok(command);
	return { command, calls };
}

function snapshotExecutor(options: {
	toplevel?: string;
	paneWorkspace?: string;
	linked?: boolean;
	mainCheckout?: string;
	bareMain?: boolean;
	panes?: unknown[];
	tabs?: unknown[];
	removeResult?: ExecResult;
	pullResult?: ExecResult;
} = {}): Executor {
	return async ({ command, args }) => {
		if (command === "herdr" && args[0] === "pane" && args[1] === "get") {
			return ok(JSON.stringify({ result: { pane: { pane_id: args[2], workspace_id: options.paneWorkspace ?? "w1" } } }));
		}
		if (command === "herdr" && args[0] === "workspace" && args[1] === "get") {
			return ok(JSON.stringify({ result: { workspace: {
				workspace_id: args[2],
				worktree: {
					checkout_path: options.toplevel ?? checkout,
					repo_root: options.mainCheckout ?? mainCheckoutDir,
					is_linked_worktree: options.linked ?? true,
				},
			} } }));
		}
		if (command === "git" && args[0] === "worktree" && args[1] === "list") {
			assert.deepEqual(args, ["worktree", "list", "--porcelain", "-z"]);
			const main = options.mainCheckout ?? mainCheckoutDir;
			const bare = options.bareMain ? "bare\0" : "";
			return ok(`worktree ${main}\0${bare}HEAD s\0branch b\0\0worktree ${checkout}\0HEAD s\0branch b\0\0`);
		}
		if (command === "herdr" && args[0] === "api") {
			return ok(JSON.stringify({ result: { snapshot: { panes: options.panes ?? [] } } }));
		}
		if (command === "herdr" && args[0] === "tab") {
			return ok(JSON.stringify({ result: { tabs: [
				{ tab_id: "w1:t1", workspace_id: "w1" },
				...(options.tabs ?? []),
			] } }));
		}
		if (command === "git" && args[0] === "worktree") return options.removeResult ?? ok();
		if (command === "git" && args[0] === "pull") return options.pullResult ?? ok();
		return ok();
	};
}

async function withHerdrEnvironment(
	herdrEnv: string | undefined,
	tabId: string | undefined,
	run: () => Promise<void>,
	paneId: string | null | undefined = "w1:p1",
): Promise<void> {
	const setEnvironment = (values: Record<string, string | undefined>) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const environment = {
		HERDR_ENV: herdrEnv,
		HERDR_TAB_ID: tabId,
		HERDR_PANE_ID: paneId ?? undefined,
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	setEnvironment(environment);
	try {
		await run();
	} finally {
		setEnvironment(previous);
	}
}

const context = (events: string[] = [], confirmed = true) => ({
	cwd: "/repo/worktree/nested",
	waitForIdle: async () => { events.push("idle"); },
	ui: { confirm: async (title: string, message: string) => { events.push(`confirm:${title}:${message}`); return confirmed; } },
}) as unknown as ExtensionCommandContext;

test("/done resolves the checkout root, skips own tab, removes the checkout, then closes the tab", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor({
			panes: [
				{ tab_id: "w1:t1", cwd: checkout },
				{ tab_id: "w1:t1", cwd: `${checkout}/nested` },
			],
		}));
		const events: string[] = [];
		await app.command("", context(events));
		assert.deepEqual(events, [
			"confirm:Done:Close its Herdr tabs and remove the current worktree?",
			"idle",
		]);
		assert.deepEqual(app.calls, [
			{ command: "herdr", args: ["pane", "get", "w1:p1"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "herdr", args: ["workspace", "get", "w1"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], options: { cwd: checkout } },
			{ command: "herdr", args: ["api", "snapshot"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "herdr", args: ["tab", "list"], options: { cwd: "/repo/worktree/nested" } },
			{ command: "git", args: ["worktree", "remove", checkout], options: { cwd: mainCheckoutDir } },
			{ command: "git", args: ["pull", "--ff-only"], options: { cwd: mainCheckoutDir } },
			{ command: "herdr", args: ["tab", "close", "w1:t1"], options: { cwd: tmpdir() } },
		]);
	});
});

test("/done closes all other tabs in its workspace", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness(snapshotExecutor({
			panes: [
				{ tab_id: "w1:t2", cwd: checkout },
				{ tab_id: "w1:t3", cwd: `${checkout}/nested` },
			],
			tabs: [
				{ tab_id: "w1:t2", workspace_id: "w1", label: "Implementer" },
				{ tab_id: "w1:t3", workspace_id: "w1", label: "Reviewer" },
				{ tab_id: "w1:t4", workspace_id: "w1", label: "Different checkout" },
				{ tab_id: "w2:t1", workspace_id: "w2", label: "Other workspace" },
			],
		}));
		await app.command("", context());
		assert.deepEqual(
			app.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab").map((call) => call.args),
			[
				["tab", "list"],
				["tab", "close", "w1:t2"],
				["tab", "close", "w1:t3"],
				["tab", "close", "w1:t4"],
				["tab", "close", "w1:t1"],
			],
		);
		assert.ok(app.calls.findIndex((call) => call.args[1] === "remove") < app.calls.findIndex((call) => call.args[2] === "w1:t2"));
	});
});

test("/done --force and -f skip confirmation and dependents check, forwarding force to git", async () => {
	for (const flag of ["--force", "-f"]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				panes: [{ tab_id: "w2:t9", cwd: checkout }],
			}));
			const events: string[] = [];
			await app.command(flag, context(events));
			assert.deepEqual(events, ["idle"]);
			assert.equal(app.calls.some((c) => c.command === "herdr" && c.args[0] === "api"), false);
			assert.deepEqual(app.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "remove")?.args,
				["worktree", "remove", "--force", checkout]);
		});
	}
});

test("/done refuses with blocking tab labels when another Herdr tab uses the checkout", async () => {
	for (const cwd of [checkout, `${checkout}/sub`]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				panes: [{ tab_id: "w2:t9", cwd }, { tab_id: "w3:t4", cwd }],
				tabs: [
					{ tab_id: "w2:t9", workspace_id: "w2", label: "Fix puid pgid" },
					{ tab_id: "w3:t4", workspace_id: "w3" },
				],
			}));
			await assert.rejects(
				app.command("", context()),
				/still used by Herdr tabs Fix puid pgid, w3:t4/);
			assert.equal(app.calls.length, 5);
		});
	}
});

test("/done removes the checkout, pulls the parent, and closes its tab when another tab uses the parent", async () => {
	for (const cwd of [mainCheckoutDir, `${mainCheckoutDir}/sub`]) {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ panes: [{ tab_id: "w2:t9", cwd }] }));
			await app.command("", context());
			assert.ok(app.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove"));
			assert.ok(app.calls.some((c) => c.args[0] === "pull"));
			assert.deepEqual(app.calls.at(-1), {
				command: "herdr",
				args: ["tab", "close", "w1:t1"],
				options: { cwd: tmpdir() },
			});
		});
	}
});

test("/done does not check or remove while clone creation holds the checkout lock", async () => {
	await withHerdrEnvironment("1", "w1:t1", () => withWorktreeLock(checkout, async () => {
		const app = harness(snapshotExecutor());
		await assert.rejects(app.command("", context()), /already being held/);
		assert.deepEqual(app.calls.map((call) => call.args[0]), ["pane", "workspace", "worktree"]);
	}));
});

test("declined confirmation leaves the worktree untouched", async () => {
	await withHerdrEnvironment("1", "w1:t1", async () => {
		const app = harness();
		const events: string[] = [];
		await app.command("", context(events, false));
		assert.deepEqual(events, ["confirm:Done:Close its Herdr tabs and remove the current worktree?"]);
		assert.deepEqual(app.calls, []);
	});
});

test("/done fails safely before any execution and preserves removal errors", async (t) => {
	await t.test("rejects arguments and missing Herdr context before execution", async () => {
		for (const [args, herdrEnv, tabId, paneId, expected] of [
			["--yes", "1", "w1:t1", "w1:p1", /Usage: \/done \[--force\|-f\]/],
			["-f extra", "1", "w1:t1", "w1:p1", /Usage: \/done \[--force\|-f\]/],
			["", undefined, "w1:t1", "w1:p1", /inside Herdr/],
			["", "1", undefined, "w1:p1", /HERDR_TAB_ID/],
			["", "1", "w1:t1", null, /HERDR_PANE_ID/],
		] as const) {
			await withHerdrEnvironment(herdrEnv, tabId, async () => {
				const app = harness();
				await assert.rejects(app.command(args, context()), expected);
				assert.deepEqual(app.calls, []);
			}, paneId);
		}
	});

	await t.test("rejects mismatched Herdr tab and workspace context before removal", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ paneWorkspace: "w9" }));
			await assert.rejects(app.command("", context()), /does not belong to workspace w9/);
			assert.equal(app.calls.some((call) => call.args[1] === "remove"), false);
		});
	});

	await t.test("refuses a workspace that is not a linked worktree", async () => {
		for (const options of [{ linked: false }, { linked: false, toplevel: mainCheckoutDir }]) {
			await withHerdrEnvironment("1", "w1:t1", async () => {
				const app = harness(snapshotExecutor(options));
				await assert.rejects(app.command("--force", context()), /w1 is not a linked Git worktree\. Nothing was removed/);
				assert.deepEqual(app.calls.map((call) => call.args.slice(0, 2)), [["pane", "get"], ["workspace", "get"]]);
			});
		}
	});

	await t.test("skips the parent pull when the session is the main worktree", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ mainCheckout: checkout }));
			await app.command("--force", context());
			assert.equal(app.calls.some((c) => c.args[0] === "pull"), false);
		});
	});

	await t.test("skips the parent pull when the primary repository is bare", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({ bareMain: true }));
			await app.command("--force", context());
			assert.equal(app.calls.some((c) => c.args[0] === "pull"), false);
		});
	});

	await t.test("surfaces dirty-worktree refusal and skips tab close", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				tabs: [{ tab_id: "w1:t2", workspace_id: "w1" }],
				removeResult: { stdout: "", stderr: "error: the following file is dirty", code: 1 },
			}));
			await assert.rejects(app.command("", context()), /dirty/);
			assert.equal(app.calls.length, 6);
			assert.equal(app.calls.some((call) => call.args[1] === "close"), false);
		});
	});

	await t.test("surfaces a failed parent pull but closes the removed checkout's tab", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				tabs: [{ tab_id: "w1:t2", workspace_id: "w1" }],
				pullResult: { stdout: "", stderr: "error: Your local changes would be overwritten by merge", code: 1 },
			}));
			await assert.rejects(app.command("--force", context()), /overwritten by merge/);
			// --force skips the dependents check, so no herdr api snapshot call.
			assert.deepEqual(
				app.calls.filter((call) => call.args[1] === "close").map((call) => call.args[2]),
				["w1:t2", "w1:t1"],
			);
		});
	});

	await t.test("treats a killed removal as failure", async () => {
		await withHerdrEnvironment("1", "w1:t1", async () => {
			const app = harness(snapshotExecutor({
				removeResult: { stdout: "", stderr: "", code: 0, killed: true },
			}));
			await assert.rejects(app.command("", context()), /killed/);
			assert.equal(app.calls.length, 6);
		});
	});
});
