import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrCommandExtension, { CHECKOUT_ACTIVITY_END, CHECKOUT_ACTIVITY_START, jobStatus, parseCommandParams } from "../internal/command.ts";
import { shellProbe, success, withPane, type ExecResult } from "./helper.ts";

const RUNNER = fileURLToPath(new URL("../internal/command-runner.mjs", import.meta.url));
const hasLsof = spawnSync("lsof", ["-v"]).status === 0;

async function tempDir(t: { after: (callback: () => Promise<void>) => void }, prefix: string) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function job(t: { after: (callback: () => Promise<void>) => void }, command: string, args: string[], maxRuntimeMs = 60_000) {
	const directory = await tempDir(t, "pi-herdr-command-job-");
	const token = "t".repeat(32);
	await writeFile(join(directory, "launch.json"), JSON.stringify({ id: "cmd-test", token, command, args, cwd: directory, maxRuntimeMs }), { mode: 0o600 });
	await writeFile(join(directory, "process.lease"), "", { mode: 0o600 });
	return { directory, token };
}

async function runRunner(directory: string) {
	const child = spawn(process.execPath, [RUNNER, directory], { stdio: "ignore" });
	await new Promise((resolve) => child.once("exit", resolve));
}

test("parseCommandParams accepts each action only with its own fields", () => {
	assert.deepEqual(parseCommandParams({ action: "start", command: "make", args: ["test"], access: "write" }),
		{ action: "start", command: "make", args: ["test"], access: "write" });
	assert.deepEqual(parseCommandParams({ action: "read", id: "cmd-0123456789abcdef", lines: 20 }), { action: "read", id: "cmd-0123456789abcdef", lines: 20 });
	for (const [value, pattern] of [
		[{ action: "start", command: "make" }, /requires command and access/],
		[{ action: "start", command: "make", access: "read", id: "cmd-0123456789abcdef" }, /does not accept id or lines/],
		[{ action: "read" }, /requires id/],
		[{ action: "read", id: "cmd-0123456789abcdef", command: "make" }, /does not accept command/],
		[{ action: "stop", id: "cmd-0123456789abcdef", lines: 5 }, /does not accept lines/],
		[{ action: "stop", id: "w1:p2" }, /parameters are invalid/],
		[{ action: "start", command: "make", access: "read", shell: "make test" }, /parameters are invalid/],
		[{ action: "start", command: "make", args: ["a\0b"], access: "read" }, /cannot contain NUL/],
	] as const) assert.throws(() => parseCommandParams(value), pattern, JSON.stringify(value));
});

test("the runner saves the exit code, a start failure, and the runtime limit outside the terminal", async (t) => {
	const exited = await job(t, process.execPath, ["-e", "process.exit(3)"]);
	await runRunner(exited.directory);
	assert.deepEqual(await jobStatus(exited), { state: "ended", code: 3, signal: null, timedOut: false });

	const missing = await job(t, join(exited.directory, "no-such-command"), []);
	await runRunner(missing.directory);
	const failed = await jobStatus(missing);
	assert.equal(failed.state === "ended" && /ENOENT/.test(failed.error ?? ""), true);

	const slow = await job(t, process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 200);
	await runRunner(slow.directory);
	assert.deepEqual(await jobStatus(slow), { state: "ended", code: null, signal: "SIGTERM", timedOut: true });
	assert.rejects(jobStatus({ directory: slow.directory, token: "other" }), /another job token/);
});

test("the runner and its command hold the job lease until they end", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	const running = await job(t, process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
	const child = spawn(process.execPath, [RUNNER, running.directory], { stdio: "ignore" });
	t.after(() => { child.kill("SIGKILL"); });
	for (let attempt = 0; attempt < 100 && (await jobStatus(running)).state !== "running"; attempt++) await delay(20);
	const status = await jobStatus(running);
	assert.equal(status.state, "running");
	const holders = () => {
		const result = spawnSync("lsof", ["-w", "-nP", "-a", "-F", "p", "--", join(running.directory, "process.lease")], { encoding: "utf8" });
		return result.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)));
	};
	assert.ok(holders().includes(status.state === "running" ? status.pid : -1));
	assert.ok(holders().includes(child.pid!));
	process.kill(status.state === "running" ? status.pid : 0, "SIGTERM");
	for (let attempt = 0; attempt < 100 && (await jobStatus(running)).state !== "ended"; attempt++) await delay(20);
	assert.deepEqual(await jobStatus(running), { state: "ended", code: null, signal: "SIGTERM", timedOut: false });
	for (let attempt = 0; attempt < 100 && holders().length; attempt++) await delay(20);
	assert.deepEqual(holders(), []);
});

test("start runs the runner in a verified pane, read reports saved status, and stop proves the end", { skip: !hasLsof && "lsof is not installed" }, async (t) => {
	const agentDir = await tempDir(t, "pi-herdr-command-agent-");
	const repoParent = await tempDir(t, "pi-herdr-command-parent-");
	const repo = join(repoParent, "team", "service");
	await mkdir(join(repo, "src"), { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	await withPane("w1:p1", async () => {
		const events: Array<[string, unknown]> = [];
		const calls: string[][] = [];
		const panes = new Set<string>();
		let submitted = false;
		let execute: ((...args: any[]) => Promise<any>) | undefined;
		let prepare: ((value: unknown) => unknown) | undefined;
		const api = {
			on() {},
			events: { emit: (channel: string, data: unknown) => events.push([channel, data]), on: () => () => {} },
			registerTool(tool: { name: string; execute: typeof execute; prepareArguments: typeof prepare }) {
				if (tool.name === "herdr_command") { execute = tool.execute; prepare = tool.prepareArguments; }
			},
			exec: async (command: string, args: string[], options: { cwd: string }): Promise<ExecResult> => {
				if (command !== "herdr") return await new Promise((resolve) => {
					const child = spawn(command, args, { cwd: options.cwd });
					let stdout = ""; let stderr = "";
					child.stdout.on("data", (chunk) => { stdout += chunk; });
					child.stderr.on("data", (chunk) => { stderr += chunk; });
					child.once("exit", (code) => resolve({ stdout, stderr, code: code ?? 1, killed: false }));
				});
				calls.push(args);
				if (args[0] === "pane" && args[1] === "split") {
					panes.add("w1:p2");
					return success({ result: { pane: { pane_id: "w1:p2", workspace_id: "w1", focused: false, cwd: args[args.indexOf("--cwd") + 1] } } });
				}
				if (args[0] === "pane" && args[1] === "run" && args[3]!.includes("command-runner.mjs")) {
					// The fake shell runs the quoted runner line without a shell.
					const words = [...args[3]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
					spawn(words[0]!, words.slice(1), { stdio: "ignore", detached: true }).unref();
					submitted = true;
					return success();
				}
				if (submitted && args[0] === "pane" && args[1] === "read" && args[2] === "w1:p2") return success("make: all tests passed\n");
				if (args[0] === "pane" && args[1] === "get") {
					return panes.has(args[2]!) ? success({ result: { pane: { pane_id: args[2] } } })
						: { stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "", code: 1, killed: false };
				}
				if (args[0] === "pane" && args[1] === "close") { panes.delete(args[2]!); return success(); }
				return shellProbe(args) ?? success();
			},
		} as unknown as ExtensionAPI;
		herdrCommandExtension(api, { agentDir });
		assert.ok(execute && prepare);
		const ctx = { cwd: repoParent, hasUI: false };
		const started = await execute!("call-1", prepare!({ action: "start", repo: "team/service", cwd: "src", command: process.execPath, args: ["-e", "process.exit(0)"], access: "write" }), undefined, undefined, ctx);
		const { id, cwd } = started.details as { id: string; cwd: string };
		assert.equal(cwd, join(repo, "src"));
		assert.deepEqual(events, [[CHECKOUT_ACTIVITY_START, { jobId: id, cwd }]]);
		assert.deepEqual(calls.find((args) => args[1] === "split"), ["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", cwd]);
		const launch = JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-tools", "commands", id, "launch.json"), "utf8"));
		assert.deepEqual([launch.command, launch.args, launch.cwd], [process.execPath, ["-e", "process.exit(0)"], cwd]);

		let read = await execute!("call-2", prepare!({ action: "read", id }), undefined, undefined, ctx);
		for (let attempt = 0; attempt < 100 && (read.details as { status: { state: string } }).status.state !== "ended"; attempt++) {
			await delay(20);
			read = await execute!("call-2", prepare!({ action: "read", id }), undefined, undefined, ctx);
		}
		assert.match(read.content[0].text, new RegExp(`^Job ${id} · exited with code 0 · pane w1:p2`));
		assert.match(read.content[0].text, /untrusted terminal text[\s\S]*make: all tests passed/);

		const stopped = await execute!("call-3", prepare!({ action: "stop", id }), undefined, undefined, ctx);
		assert.match(stopped.content[0].text, /pane w1:p2 is closed and no process holds the job lease/);
		assert.deepEqual(events.at(-1), [CHECKOUT_ACTIVITY_END, { jobId: id }]);
		await assert.rejects(execute!("call-4", prepare!({ action: "start", repo: "team/service", cwd: "../..", command: "true", access: "read" }), undefined, undefined, ctx),
			/relative path without \.\. components/);
	});
});
