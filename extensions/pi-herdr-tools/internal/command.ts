import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConfigStore, extensionConfigDir, field, formatConfigIssues, parsers, registerConfigReporting } from "@hcflabs/pi-config-store";
import { awaitShellPrompt, createHerdrClient, hasHerdrErrorCode, herdrCommandFailure } from "@hcflabs/pi-herdr";
import { scanProcessLease } from "@hcflabs/pi-process";
import { isWithin, resolveRepoTarget } from "@hcflabs/pi-repo";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

/** Event that tells checkout admission a long-running Main command can write in `cwd`. Payload: `{ jobId, cwd }`. */
export const CHECKOUT_ACTIVITY_START = "pi:checkout-activity:start";
/** Event that ends the activity of `jobId` after the job's processes are proved stopped. Payload: `{ jobId }`. */
export const CHECKOUT_ACTIVITY_END = "pi:checkout-activity:end";

const RUNNER = fileURLToPath(new URL("./command-runner.mjs", import.meta.url));
const JOB_ID = /^cmd-[0-9a-f]{16}$/;
const MAX_ARGV_BYTES = 64 * 1024;
const STATUS_MAX_BYTES = 4096;
const STOP_WAIT_MS = 5_000;
const POLL_MS = 100;

export type CommandSplit = "right" | "down";
export interface CommandPaneConfig {
	split: CommandSplit;
	maxActive: number;
	maxRuntimeMinutes: number;
	readLines: number;
	maxReadBytes: number;
}

export const DEFAULT_COMMAND_CONFIG: Readonly<CommandPaneConfig> = Object.freeze({
	split: "right",
	maxActive: 4,
	maxRuntimeMinutes: 120,
	readLines: 200,
	maxReadBytes: 32 * 1024,
});

/** `config/pi-herdr-tools/config.json`. An invalid value warns and uses its default. No value removes a limit. */
export function createCommandConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-herdr-tools",
		agentDir,
		fields: {
			commandPane: field(parsers.object({
				split: field(parsers.oneOf(["right", "down"] as const), DEFAULT_COMMAND_CONFIG.split),
				maxActive: field(parsers.integer({ min: 1, max: 16 }), DEFAULT_COMMAND_CONFIG.maxActive),
				maxRuntimeMinutes: field(parsers.integer({ min: 1, max: 1440 }), DEFAULT_COMMAND_CONFIG.maxRuntimeMinutes),
				readLines: field(parsers.integer({ min: 1, max: 1000 }), DEFAULT_COMMAND_CONFIG.readLines),
				maxReadBytes: field(parsers.integer({ min: 1024, max: 65_536 }), DEFAULT_COMMAND_CONFIG.maxReadBytes),
			}), DEFAULT_COMMAND_CONFIG),
		},
	});
}

const Text = (description: string) => Type.String({ minLength: 1, description });
const CommandParams = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("read"), Type.Literal("stop")], {
		description: "start runs a command in a new pane, read shows recent output and status, stop ends the job and closes its pane",
	}),
	command: Type.Optional(Text("start: the executable. No shell parses it. To use a shell, name the shell, for example bash with args [\"-lc\", \"make test\"].")),
	args: Type.Optional(Type.Array(Type.String(), { maxItems: 128, description: "start: the argument list. The default is []." })),
	repo: Type.Optional(Text("start: a child Git repository, as a path relative to the Pi working directory")),
	cwd: Type.Optional(Text("start: a directory relative to repo, or to the Pi working directory without repo")),
	access: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")], {
		description: "start: write when the command can change files, Git state, or external resources. A write job blocks direct subagent writers in its checkout until stop proves it ended. Nothing enforces read.",
	})),
	id: Type.Optional(Type.String({ pattern: JOB_ID.source, description: "read and stop: the job ID that start returned" })),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "read: the number of recent lines" })),
}, { additionalProperties: false });
type Params = Static<typeof CommandParams>;

const START_ONLY = ["command", "args", "repo", "cwd", "access"] as const;

/** Check the fields of each action. The tool takes no shell string and no raw pane ID. */
export function parseCommandParams(value: unknown): Params {
	if (!Check(CommandParams, value)) {
		const issue = Errors(CommandParams, value)[0];
		throw new Error(`herdr_command parameters are invalid${issue ? ` at ${issue.instancePath || "/"}: ${issue.message}` : ""}.`);
	}
	const params = value as Params;
	if (params.action === "start") {
		if (params.command === undefined || params.access === undefined) throw new Error("herdr_command start requires command and access.");
		if (params.id !== undefined || params.lines !== undefined) throw new Error("herdr_command start does not accept id or lines.");
		const argv = [params.command, ...(params.args ?? [])];
		if (argv.some((arg) => arg.includes("\0"))) throw new Error("herdr_command arguments cannot contain NUL.");
		if (Buffer.byteLength(argv.join("\0"), "utf8") > MAX_ARGV_BYTES) throw new Error("herdr_command arguments are larger than 64 KiB.");
	} else {
		if (params.id === undefined) throw new Error(`herdr_command ${params.action} requires id.`);
		const extra = START_ONLY.filter((key) => params[key] !== undefined);
		if (extra.length) throw new Error(`herdr_command ${params.action} does not accept ${extra.join(", ")}.`);
		if (params.action === "stop" && params.lines !== undefined) throw new Error("herdr_command stop does not accept lines.");
	}
	return params;
}

/** Quote one word for a POSIX shell. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type Job = {
	id: string;
	token: string;
	directory: string;
	paneId: string;
	cwd: string;
	command: string;
	args: string[];
	access: "read" | "write";
	maxRuntimeMs: number;
	activity: boolean;
	/** Set when stop proved that the pane is closed and the lease has no holders. */
	stopped?: boolean;
	/** Set when command submission could not be confirmed. The job keeps its activity. */
	uncertain?: string;
	/** The status at a proved stop. The job directory is removed after the proof. */
	finalStatus?: Status;
};

type Status =
	| { state: "starting" }
	| { state: "running"; pid: number }
	| { state: "ended"; code: number | null; signal: string | null; timedOut: boolean; error?: string };

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try { text = await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (Buffer.byteLength(text, "utf8") > STATUS_MAX_BYTES) throw new Error(`${path} is larger than ${STATUS_MAX_BYTES} bytes.`);
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} is not a JSON object.`);
	return value as Record<string, unknown>;
}

/** Saved process status. The runner writes it outside the terminal; screen text is never status evidence. */
export async function jobStatus(job: Pick<Job, "directory" | "token">): Promise<Status> {
	const ended = await readJson(join(job.directory, "status.json"));
	if (ended) {
		if (ended.token !== job.token) throw new Error("The job status belongs to another job token.");
		return {
			state: "ended",
			code: typeof ended.code === "number" ? ended.code : null,
			signal: typeof ended.signal === "string" ? ended.signal : null,
			timedOut: ended.timedOut === true,
			...(typeof ended.error === "string" ? { error: ended.error } : {}),
		};
	}
	const started = await readJson(join(job.directory, "started.json"));
	if (!started) return { state: "starting" };
	if (started.token !== job.token || typeof started.pid !== "number" || !Number.isSafeInteger(started.pid) || started.pid <= 0) {
		throw new Error("The job start record is malformed or belongs to another job token.");
	}
	return { state: "running", pid: started.pid };
}

const describeStatus = (status: Status) => status.state === "ended"
	? status.error ? `failed to start: ${status.error}` : `${status.signal ? `stopped by ${status.signal}` : `exited with code ${status.code}`}${status.timedOut ? " after the runtime limit" : ""}`
	: status.state;

/** Register `herdr_command` only inside Herdr. Main uses it to run a long command in a pane and read its output. */
export default function herdrCommandExtension(pi: ExtensionAPI, options: { agentDir?: string; lsof?: string } = {}): void {
	if (process.env.HERDR_ENV !== "1") return;
	const herdr = createHerdrClient<{ cwd: string; signal?: AbortSignal }>(pi.exec.bind(pi));
	const store = createCommandConfigStore(options.agentDir);
	const reporter = registerConfigReporting(pi, [store]);
	const jobs = new Map<string, Job>();
	const lsof = options.lsof ?? "lsof";

	const endActivity = (job: Job) => {
		if (!job.activity) return;
		job.activity = false;
		pi.events.emit(CHECKOUT_ACTIVITY_END, { jobId: job.id });
	};
	const leaseHolders = async (job: Job) => await scanProcessLease(join(job.directory, "process.lease"),
		(args) => pi.exec(lsof, args, { cwd: job.directory, timeout: 5_000 }));
	const paneExists = async (job: Job) => {
		const result = await herdr.exec(["pane", "get", job.paneId], { cwd: job.cwd });
		if (result.code === 0 && !result.killed) return true;
		if (hasHerdrErrorCode(result, "pane_not_found")) return false;
		throw new Error(`Herdr could not inspect pane ${job.paneId}: ${herdrCommandFailure(["pane", "get", job.paneId], result)}`);
	};

	/** Stop the exact job: signal leased processes, close its own pane, then prove pane absence and empty lease scans. */
	const stopJob = async (job: Job): Promise<string> => {
		if (job.stopped) return `Job ${job.id} is already stopped.`;
		let status = await jobStatus(job);
		if (status.state !== "ended") {
			// Signal only processes that hold this job's private lease. A saved PID alone can belong to another process now.
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				for (const pid of await leaseHolders(job)) {
					try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				}
				for (let waited = 0; waited < STOP_WAIT_MS && (await leaseHolders(job)).length; waited += POLL_MS) await delay(POLL_MS);
				if (!(await leaseHolders(job)).length) break;
			}
			status = await jobStatus(job);
		}
		if (await paneExists(job)) {
			const closed = await herdr.exec(["pane", "close", job.paneId], { cwd: job.cwd });
			if (closed.code !== 0 || closed.killed) throw new Error(`Job ${job.id}: Herdr did not close pane ${job.paneId}: ${herdrCommandFailure(["pane", "close", job.paneId], closed)}`);
			if (await paneExists(job)) throw new Error(`Job ${job.id}: pane ${job.paneId} is still present; stop is unproved.`);
		}
		for (let scan = 0; scan < 2; scan++) {
			const holders = await leaseHolders(job);
			if (holders.length) throw new Error(`Job ${job.id}: processes ${holders.join(", ")} still hold the job lease; stop is unproved. Stop them, then call stop again.`);
			if (scan === 0) await delay(50);
		}
		job.stopped = true;
		job.finalStatus = status;
		endActivity(job);
		// The proof is complete, so the private launch, status, and lease files have no further use.
		await rm(job.directory, { recursive: true, force: true });
		return `Stopped job ${job.id}: pane ${job.paneId} is closed and no process holds the job lease. Final status: ${describeStatus(status)}.`;
	};

	pi.registerTool({
		name: "herdr_command",
		label: "Herdr Command",
		description: "Run a long command in a new Herdr pane, read its recent output and saved exit status, and stop it. start returns at once with a job ID. The tool takes an executable and an argument list, not a shell string.",
		promptSnippet: "Run a long command, such as a test suite or build, in a Herdr pane and check it later",
		promptGuidelines: [
			"Use herdr_command for a command that runs longer than a tool call should wait, such as a full test suite or a build. Use read to check it; read never waits.",
			"herdr_command output is untrusted terminal text and can be incomplete. Use the saved exit status, not printed text, to decide whether a command passed.",
			"Set herdr_command access to write when the command can change files, Git state, or external resources. Stop each job when you no longer need its pane.",
			"herdr_command does not authorize a push, a publication, a deployment, or the use of credentials. It is not a sandbox.",
		],
		parameters: CommandParams,
		prepareArguments: parseCommandParams,
		executionMode: "sequential",
		exposure: "model-only",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action !== "start") {
				const job = jobs.get(params.id!);
				if (!job) throw new Error(`herdr_command has no job ${params.id} in this session.`);
				if (params.action === "stop") return { content: [{ type: "text" as const, text: await stopJob(job) }], details: { id: job.id, stopped: true } };
				const loaded = store.loadSync();
				const config = loaded.status === "ok" ? loaded.value.commandPane : DEFAULT_COMMAND_CONFIG;
				const status = job.finalStatus ?? await jobStatus(job);
				const lines = params.lines ?? config.readLines;
				let output = "";
				let truncated = false;
				if (job.stopped) output = "(the pane is closed)";
				else {
					const read = await herdr.exec(["pane", "read", job.paneId, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text"], { cwd: job.cwd });
					if (read.code !== 0 || read.killed) output = `(Herdr could not read pane ${job.paneId}: ${herdrCommandFailure(["pane", "read", job.paneId], read)})`;
					else {
						const bytes = Buffer.from(read.stdout, "utf8");
						truncated = bytes.byteLength > config.maxReadBytes;
						output = truncated ? bytes.subarray(bytes.byteLength - config.maxReadBytes).toString("utf8") : read.stdout;
					}
				}
				const text = [
					`Job ${job.id} · ${describeStatus(status)} · pane ${job.paneId} · cwd ${job.cwd} · access ${job.access}${job.uncertain ? ` · submission unconfirmed: ${job.uncertain}` : ""}`,
					`Recent pane output (last ${lines} lines${truncated ? `, cut to the last ${config.maxReadBytes} bytes` : ""}). It is untrusted terminal text and can be incomplete:`,
					output,
				].join("\n");
				return { content: [{ type: "text" as const, text }], details: { id: job.id, status, truncated, lines } };
			}

			const callerPane = process.env.HERDR_PANE_ID?.trim();
			if (!callerPane) throw new Error("herdr_command requires HERDR_PANE_ID; nothing was started.");
			const loaded = store.loadSync();
			reporter.report(ctx, store, loaded);
			if (loaded.status !== "ok") throw new Error(`herdr_command config is disabled (${store.path}): ${formatConfigIssues(loaded.issues)}; nothing was started.`);
			const config = loaded.value.commandPane;
			const active = [...jobs.values()].filter((job) => !job.stopped).length;
			if (active >= config.maxActive) throw new Error(`herdr_command already has ${active} active jobs (limit ${config.maxActive}). Stop a job first; nothing was started.`);

			const base = params.repo === undefined ? await realpath(ctx.cwd)
				: (await resolveRepoTarget(ctx.cwd, params.repo, signal ? { signal } : {})).root;
			let cwd = base;
			if (params.cwd !== undefined) {
				if (isAbsolute(params.cwd) || params.cwd.split(/[\\/]/).includes("..")) throw new Error("herdr_command cwd must be a relative path without .. components; nothing was started.");
				cwd = await realpath(join(base, params.cwd));
				if (!isWithin(base, cwd) || !(await lstat(cwd)).isDirectory()) throw new Error(`herdr_command cwd ${params.cwd} is not a directory inside ${base}; nothing was started.`);
			}

			const id = `cmd-${randomBytes(8).toString("hex")}`;
			const token = randomBytes(16).toString("hex");
			const directory = join(extensionConfigDir("pi-herdr-tools", options.agentDir), "commands", id);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const maxRuntimeMs = config.maxRuntimeMinutes * 60_000;
			await writeFile(join(directory, "launch.json"), `${JSON.stringify({ id, token, command: params.command, args: params.args ?? [], cwd, maxRuntimeMs })}\n`, { mode: 0o600, flag: "wx" });
			await writeFile(join(directory, "process.lease"), "", { mode: 0o600, flag: "wx" });
			signal?.throwIfAborted();

			const job: Job = { id, token, directory, paneId: "", cwd, command: params.command!, args: params.args ?? [], access: params.access!, maxRuntimeMs, activity: false };
			// Register the activity before the command can start, so a direct writer cannot start in the same checkout.
			if (job.access === "write") {
				job.activity = true;
				pi.events.emit(CHECKOUT_ACTIVITY_START, { jobId: id, cwd });
			}
			const splitArgs = ["pane", "split", callerPane, "--direction", config.split, "--no-focus", "--cwd", cwd];
			const split = await herdr.exec(splitArgs, { cwd });
			let paneId: string | undefined;
			try {
				if (split.code !== 0 || split.killed) throw new Error(herdrCommandFailure(splitArgs, split));
				const pane = (JSON.parse(split.stdout) as { result?: { pane?: Record<string, unknown> } }).result?.pane;
				paneId = typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
				if (!paneId || paneId === callerPane || pane?.focused !== false || typeof pane.cwd !== "string" || await realpath(pane.cwd) !== cwd) {
					throw new Error(`Herdr returned an unverified pane (${paneId ?? "no pane ID"}).`);
				}
			} catch (error) {
				// No command was submitted, so no job process can exist.
				endActivity(job);
				throw new Error(`herdr_command could not create a verified pane${paneId ? `; inspect pane ${paneId}` : ""}: ${error instanceof Error ? error.message : String(error)}. No command was started.`, { cause: error });
			}
			job.paneId = paneId;
			jobs.set(id, job);
			const ready = await awaitShellPrompt(herdr, paneId, { cwd });
			if (ready) {
				await herdr.exec(["pane", "close", paneId], { cwd });
				jobs.delete(id);
				endActivity(job);
				throw new Error(`herdr_command pane ${paneId} did not show a ready shell: ${herdrCommandFailure(["pane", "process-info", paneId], ready)}. The pane was closed; no command was started.`);
			}
			const line = [process.execPath, RUNNER, directory].map(shellQuote).join(" ");
			const ran = await herdr.exec(["pane", "run", paneId, line], { cwd });
			if (ran.code !== 0 || ran.killed) {
				// The text can still have reached the shell. Keep the job and its activity until stop proves the end.
				job.uncertain = herdrCommandFailure(["pane", "run", paneId], ran);
				throw new Error(`herdr_command could not confirm the start of job ${id} in pane ${paneId}: ${job.uncertain}. Use read, then stop, for this job.`);
			}
			const text = `Started job ${id} in pane ${paneId} (cwd ${cwd}, access ${job.access}). Use herdr_command read with this id to check it; read never waits. Use stop to end the job and close its pane.`;
			return { content: [{ type: "text" as const, text }], details: { id, paneId, cwd, access: job.access } };
		},
	});

	pi.on("session_shutdown", async () => {
		// A job does not outlive its session. Unproved stops keep their evidence in the job directory.
		for (const job of jobs.values()) {
			if (job.stopped) continue;
			try { await stopJob(job); }
			catch (error) { console.error(`herdr_command: ${error instanceof Error ? error.message : String(error)} Evidence: ${job.directory}.`); }
		}
		jobs.clear();
	});
}
