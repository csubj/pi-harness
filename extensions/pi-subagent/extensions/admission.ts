import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWithin, resolveRepoTarget } from "@hcflabs/pi-repo";

// Main's own tools that never change a checkout; every other Main call may write.
// `codemode` mutates nothing itself: its nested tool calls are admitted by their own names.
const MAIN_NON_WRITING_TOOLS = new Set([
	"read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "subagent_repos", "codemode",
]);

/**
 * Classification of a `delegate_task` call. `false` means the call does not write.
 * `true` means a writer in the Pi working directory. A list names the Repository target of each task.
 * `undefined` in the list means the Pi working directory.
 */
export type DirectAdmission = boolean | ReadonlyArray<string | undefined>;

async function checkoutKey(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const cwd = await realpath(ctx.cwd);
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	if (result.code !== 0 || result.killed) return cwd;
	const root = result.stdout.replace(/\r?\n$/, "");
	if (!root || /[\r\n\0]/.test(root)) throw new Error("Git returned a malformed checkout root during delegation admission.");
	return await realpath(root);
}

/** Two scopes conflict when one contains the other. A non-Git parent directory covers its whole subtree. */
const overlaps = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);

/**
 * Reserve checkouts only for direct writers. Main writes can run together, but
 * each call must finish before a direct writer can start in an overlapping checkout.
 * A direct writer reserves the checkout of each task target at one time.
 * External processes and trusted extension lifecycle code are not intercepted.
 */
export type CheckoutAdmission = ((toolCallId: string) => () => void) & {
	/** The real checkout paths that admission reserved for a direct writer call. */
	admitted(toolCallId: string): readonly string[] | undefined;
};

export function registerCheckoutAdmission(pi: ExtensionAPI, classifyDirect: (input: unknown) => DirectAdmission): CheckoutAdmission {
	const heldCalls = new Set<string>();
	const calls = new Map<string, { direct: boolean; keys?: readonly string[] }>();
	// One Git lookup per working directory per session; a failed lookup is retried.
	const checkouts = new Map<string, Promise<string>>();
	const lookup = (ctx: ExtensionContext) => {
		const cached = checkouts.get(ctx.cwd);
		if (cached) return cached;
		const key = checkoutKey(pi, ctx);
		checkouts.set(ctx.cwd, key);
		key.catch(() => { if (checkouts.get(ctx.cwd) === key) checkouts.delete(ctx.cwd); });
		return key;
	};
	const targetKey = async (ctx: ExtensionContext, repo: string | undefined) => {
		if (repo === undefined) return await lookup(ctx);
		const target = await resolveRepoTarget(ctx.cwd, repo, {
			runProcess: (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? undefined, ...(options.signal ? { signal: options.signal } : {}) }),
		});
		return target.root;
	};
	const release = (toolCallId: string) => {
		if (heldCalls.has(toolCallId)) return;
		calls.delete(toolCallId);
	};
	pi.on("tool_call", async (event, ctx) => {
		const direct = event.toolName === "delegate_task";
		const classified = direct ? classifyDirect(event.input) : !MAIN_NON_WRITING_TOOLS.has(event.toolName);
		if (classified === false) return;
		const repos: ReadonlyArray<string | undefined> = classified === true ? [undefined] : classified;
		const call: { direct: boolean; keys?: readonly string[] } = { direct };
		calls.set(event.toolCallId, call);
		let keys: string[];
		try {
			keys = [...new Set(await Promise.all(repos.map((repo) => targetKey(ctx, repo))))];
		} catch (error) {
			release(event.toolCallId);
			if (!direct || repos.every((repo) => repo === undefined)) throw error;
			return { block: true, reason: `Repository target check failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (calls.get(event.toolCallId) !== call) {
			return { block: true, reason: `Call ${event.toolCallId} already settled; use mode: isolated to keep Main free.` };
		}
		// A direct writer conflicts with every overlapping call. A Main call conflicts only with a direct writer.
		const conflict = [...calls].find(([id, active]) => id !== event.toolCallId && active.keys
			&& (direct || active.direct)
			&& active.keys.some((held) => keys.some((key) => overlaps(held, key))));
		if (conflict) {
			const [owner, active] = conflict;
			const key = active.keys!.find((held) => keys.some((candidate) => overlaps(held, candidate)))!;
			release(event.toolCallId);
			return {
				block: true,
				reason: `Checkout ${key} has ${active.direct ? `an admitted direct writer (${owner})` : `a Main potentially-writing call in flight (${owner})`}; retry after it stops, or use mode: isolated to keep Main free.`,
			};
		}
		call.keys = keys;
	});
	pi.on("tool_result", (event) => release(event.toolCallId));
	pi.on("tool_execution_end", (event) => release(event.toolCallId));
	pi.on("session_start", () => checkouts.clear());
	pi.on("session_shutdown", () => {
		checkouts.clear();
		// Session replacement is not proof that a held direct worker stopped.
		for (const toolCallId of calls.keys()) release(toolCallId);
	});
	// The tool returns a handle before its worker stops. Release only after verified termination.
	const hold = (toolCallId: string) => {
		const call = calls.get(toolCallId);
		if (!call?.direct || !call.keys) {
			throw new Error(`Direct call ${toolCallId} was not admitted as a checkout writer; delegate again.`);
		}
		heldCalls.add(toolCallId);
		return () => { heldCalls.delete(toolCallId); release(toolCallId); };
	};
	return Object.assign(hold, {
		admitted: (toolCallId: string) => {
			const call = calls.get(toolCallId);
			return call?.direct ? call.keys : undefined;
		},
	});
}
