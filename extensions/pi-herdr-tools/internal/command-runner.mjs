#!/usr/bin/env node
// Run one herdr_command job in its pane. Usage: node command-runner.mjs <job-directory>
// The runner reads the command from launch.json, so the shell never parses the argument list.
// It saves the exit status in status.json, outside the terminal, because pane output can imitate any text.
// The command and its children inherit the open process lease file. An empty lsof scan of that file proves they stopped.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KILL_GRACE_MS = 10_000;
const directory = process.argv[2];
if (!directory) {
	console.error("herdr_command runner: the job directory is missing.");
	process.exit(2);
}

function save(name, value) {
	const path = join(directory, name);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
}

const launch = JSON.parse(readFileSync(join(directory, "launch.json"), "utf8"));
const lease = openSync(join(directory, "process.lease"), "r");
let timedOut = false;
let finished = false;
let killTimer;

const child = spawn(launch.command, launch.args, {
	cwd: launch.cwd,
	stdio: ["inherit", "inherit", "inherit", lease],
});

function finish(status) {
	if (finished) return;
	finished = true;
	clearTimeout(runtimeTimer);
	clearTimeout(killTimer);
	save("status.json", { token: launch.token, ...status, timedOut, endedAt: Date.now() });
	closeSync(lease);
	const outcome = status.error ? `failed to start: ${status.error}` : status.signal ? `stopped by ${status.signal}` : `exited with code ${status.code}`;
	console.log(`\n[herdr_command ${launch.id}] ${outcome}${timedOut ? " after the runtime limit" : ""}.`);
}

const runtimeTimer = setTimeout(() => {
	timedOut = true;
	child.kill("SIGTERM");
	killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
}, launch.maxRuntimeMs);

child.once("spawn", () => save("started.json", { token: launch.token, pid: child.pid, startedAt: Date.now() }));
child.once("error", (error) => finish({ error: error.message.slice(0, 500) }));
child.once("exit", (code, signal) => finish({ code, signal }));

// Ctrl-C reaches the whole foreground group. The runner stays alive to save the child's status.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGHUP", () => child.kill("SIGHUP"));
