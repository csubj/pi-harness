import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure } from "@hcflabs/pi-herdr";
import { resolveRepoTarget } from "@hcflabs/pi-repo";
import { Type } from "typebox";
import {
	createWorktree,
	errorMessage,
	launchPiAgent,
	prepareWorktreeLaunch,
	requiredString,
	resolveWorkspace,
	worktreeParentWorkspace,
} from "./worktree.ts";

const PROMPT_TIMEOUT_MS = 30_000;

const nonEmpty = (description: string) => Type.String({ description, minLength: 1, pattern: "\\S" });

const HandoffParams = Type.Object({
	branch: nonEmpty("New Git branch for the worktree, created from local main"),
	label: nonEmpty("Short Herdr workspace label"),
	// Herdr agent names must match this pattern; checking it here fails before any mutation.
	agentName: Type.String({
		description: "Unique Herdr agent name for the new Pi agent: lowercase letter, then up to 31 of a-z, 0-9, _ or -",
		pattern: "^[a-z][a-z0-9_-]{0,31}$",
	}),
	prompt: nonEmpty("Self-contained task prompt for the new agent"),
	repo: Type.Optional(nonEmpty(
		"Child Git repository for the worktree, as a path relative to the Pi working directory. Omit it to use the repository of the current Herdr workspace.",
	)),
});

/** Register `herdr_handoff` only inside Herdr, where it can run. */
export default function herdrHandoffExtension(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	const herdr = createHerdrClient<{ cwd: string }>(pi.exec.bind(pi));

	pi.registerTool({
		name: "herdr_handoff",
		label: "Herdr Handoff",
		description: "Create a Herdr worktree from local main, start Pi in it, and submit a self-contained task prompt. Focus does not change.",
		promptSnippet: "Hand off a separate task to a new Pi agent in a new Herdr worktree from local main",
		promptGuidelines: [
			"Use herdr_handoff for a separate task that the user authorized, for example through /handoff-worktree. A handoff has no checked integration: the new agent works unsupervised.",
			"When the Pi working directory holds several repositories, set repo to the child repository of the task. herdr_handoff never selects a repository automatically.",
		],
		parameters: HandoffParams,
		executionMode: "sequential",

		async execute(_toolCallId, { branch, label, agentName, prompt, repo }, signal, _onUpdate, ctx) {
			const paneId = requiredString(process.env.HERDR_PANE_ID, "HERDR_PANE_ID");
			const git = (cwd: string, args: string[]) => pi.exec("git", args, { cwd });
			let gitCwd: string;
			let location: string[];
			if (repo === undefined) {
				const workspace = await resolveWorkspace(herdr, ctx.cwd, paneId);
				if (!workspace.checkout) {
					throw new Error(
						`herdr_handoff: Herdr workspace ${workspace.workspaceId} has no Git checkout. Set repo to a child repository relative to ${ctx.cwd}; nothing was created.`,
					);
				}
				const repository = async (cwd: string) => {
					const result = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
					if (result.code !== 0 || result.killed) throw new Error(`herdr_handoff: ${cwd} is not in a Git repository; nothing was created.`);
					return result.stdout.trim();
				};
				// The worktree comes from the pane's workspace, so it must be the repository checked here.
				if (await repository(ctx.cwd) !== await repository(workspace.checkout)) {
					throw new Error(`herdr_handoff: ${ctx.cwd} and Herdr workspace ${workspace.workspaceId} (${workspace.checkout}) are different Git repositories; nothing was created.`);
				}
				gitCwd = ctx.cwd;
				location = ["--workspace", await worktreeParentWorkspace(herdr, ctx.cwd, workspace)];
			} else {
				// Herdr opens or creates the repository's primary workspace when it gets --cwd.
				const target = await resolveRepoTarget(ctx.cwd, repo, {
					signal,
					runProcess: (command, args, options) => pi.exec(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs ?? undefined }),
				}).catch((error: unknown) => {
					throw new Error(`herdr_handoff: ${errorMessage(error)} Nothing was created.`, { cause: error });
				});
				gitCwd = target.root;
				location = ["--cwd", target.root];
			}
			const main = await git(gitCwd, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
			if (main.code !== 0 || main.killed) {
				throw new Error(`herdr_handoff requires a local main branch in ${gitCwd}; nothing was created.`);
			}
			// Herdr checks out an existing branch instead of creating it from --base.
			const existing = await git(gitCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			if (existing.code !== 1 || existing.killed) {
				throw new Error(`herdr_handoff: branch ${branch} already exists or could not be checked; choose a new branch. Nothing was created.`);
			}

			signal?.throwIfAborted();
			const worktree = await createWorktree(herdr, ctx.cwd, [
				"worktree", "create", ...location,
				"--branch", branch, "--base", "main", "--label", label, "--no-focus",
			], "Handoff");
			const { workspaceId, checkoutPath } = worktree;
			const { target, onPaneBusy } = await prepareWorktreeLaunch(herdr, ctx.cwd, worktree).catch((error: unknown) => {
				throw new Error(
					`Handoff launch preparation failed; retained Herdr workspace ${workspaceId}, tab ${worktree.tabId}, root pane ${worktree.rootPaneId}, branch ${branch}, checkout ${checkoutPath}: ${errorMessage(error)}`,
					{ cause: error },
				);
			});
			const retained = () =>
				`Herdr workspace ${workspaceId}, tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}`;
			if (signal?.aborted) throw new Error(`Handoff was cancelled before agent start; retained ${retained()}.`);
			await launchPiAgent(herdr, ctx.cwd, { action: "Handoff", name: agentName, pane: target.paneId, args: [], retained, onPaneBusy });

			const promptArgs = [
				"agent", "prompt", agentName, prompt, "--wait", "--until", "working", "--timeout", String(PROMPT_TIMEOUT_MS),
			];
			if (signal?.aborted) throw new Error(`Handoff was cancelled before prompt delivery; retained ${retained()}, and agent ${agentName}.`);
			const delivered = await herdr.exec(promptArgs, { cwd: ctx.cwd });
			if (delivered.code !== 0 || delivered.killed) {
				throw new Error(
					`Handoff prompt was not confirmed for agent ${agentName}; retained ${retained()}, and agent ${agentName}: ${herdrCommandFailure(promptArgs, delivered)}`,
				);
			}

			const details = { workspaceId, tabId: target.tabId, paneId: target.paneId, branch, checkoutPath, agentName, ...(repo === undefined ? {} : { repo }) };
			return {
				content: [{
					type: "text" as const,
					text: `Handed off to agent ${agentName}, which is working in Herdr workspace ${workspaceId} (tab ${target.tabId}, pane ${target.paneId}, branch ${branch}, checkout ${checkoutPath}). Focus did not change.`,
				}],
				details,
			};
		},
	});
}
