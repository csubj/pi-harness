import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AdmittedFullSuite, CheckCommand } from "./schema.ts";

export type { AdmittedFullSuite };

/** Make reads the first of these files that exists. */
const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"] as const;
const MANIFEST_MAX_BYTES = 1024 * 1024;


function readOptional(path: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw new Error(`Full suite detection cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) throw new Error(`Full suite detection refuses ${path}: the file is larger than 1 MiB.`);
	return text;
}

/** The root `package.json` test script, or `undefined` when the file or the script is absent. A malformed file throws. */
export function packageTestScript(root: string): string | undefined {
	const path = join(root, "package.json");
	const text = readOptional(path);
	if (text === undefined) return undefined;
	let manifest: unknown;
	try { manifest = JSON.parse(text); }
	catch (error) { throw new Error(`Full suite detection cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Full suite detection found no JSON object in ${path}.`);
	const scripts = (manifest as { scripts?: unknown }).scripts;
	if (scripts === undefined) return undefined;
	if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) throw new Error(`Full suite detection found a malformed scripts field in ${path}.`);
	const test = (scripts as { test?: unknown }).test;
	if (test === undefined) return undefined;
	if (typeof test !== "string") throw new Error(`Full suite detection found a test script that is not text in ${path}.`);
	return test.trim() ? test : undefined;
}

/**
 * Return true when the Makefile text declares a literal `test` target, for example `test:` or `test check::`.
 * This is a static check. It never runs Make, because Make can run repository code while it reads a file.
 * Generated, included, or pattern targets are not found. Configure `repoSuites` for them.
 */
export function declaresMakeTest(text: string): boolean {
	let continued = false;
	for (const line of text.split(/\r?\n/)) {
		const previous = continued;
		continued = /(^|[^\\])(\\\\)*\\$/.test(line);
		// Recipe lines start with a tab. Continuation lines belong to the line before them.
		if (previous || line.startsWith("\t")) continue;
		const rule = /^([^#:=]+?)::?(?![=:])/.exec(line);
		if (!rule) continue;
		if (rule[1]!.trim().split(/\s+/).includes("test")) return true;
	}
	return false;
}

/** The Makefile that Make would read in `root`, with its content hash. `undefined` when no Makefile exists. */
export function makefileIdentity(root: string): { file: (typeof MAKEFILE_NAMES)[number]; text: string; sha256: string } | undefined {
	// Compare exact names. A case-insensitive file system would otherwise report Makefile as makefile.
	let names: Set<string>;
	try { names = new Set(readdirSync(root)); }
	catch (error) { throw new Error(`Full suite detection cannot list ${root}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
	for (const file of MAKEFILE_NAMES) {
		if (!names.has(file)) continue;
		const text = readOptional(join(root, file));
		if (text !== undefined) return { file, text, sha256: createHash("sha256").update(text).digest("hex") };
	}
	return undefined;
}

/**
 * Select the Full suite for `root`. The order is: the configured suite, then `pnpm test` when the root
 * `package.json` has a non-empty `scripts.test`, then `make test` when the root Makefile declares `test`.
 * A read or parse error throws. It never counts as an absent source.
 */
export function resolveFullSuite(root: string, configured?: CheckCommand): AdmittedFullSuite {
	if (configured) return { check: { command: configured.command, args: [...configured.args] }, source: { kind: "config" } };
	const testScript = packageTestScript(root);
	if (testScript !== undefined) return { check: { command: "pnpm", args: ["test"] }, source: { kind: "package-json", testScript } };
	const makefile = makefileIdentity(root);
	if (makefile && declaresMakeTest(makefile.text)) {
		return { check: { command: "make", args: ["test"] }, source: { kind: "makefile", file: makefile.file, sha256: makefile.sha256 } };
	}
	throw new Error(`No Full suite is available for ${root}. Configure repoSuites in config/pi-subagent/config.json, add a package.json scripts.test, or add a Makefile test target.`);
}

/** Throw when the checkout at `root` changed the source of an admitted Full suite. A configured suite has no source file. */
export function assertFullSuiteSource(suite: AdmittedFullSuite, root: string): void {
	const { source } = suite;
	if (source.kind === "package-json" && packageTestScript(root) !== source.testScript) {
		throw new Error("Combined tip changed the admitted root package.json test script.");
	}
	if (source.kind === "makefile") {
		const makefile = makefileIdentity(root);
		if (makefile?.file !== source.file || makefile.sha256 !== source.sha256) throw new Error(`Combined tip changed the admitted root ${source.file}.`);
	}
}

export const sameCheck = (left: CheckCommand, right: CheckCommand): boolean =>
	left.command === right.command && left.args.length === right.args.length && left.args.every((arg, index) => arg === right.args[index]);

/** A human-readable source label for plans and status. */
export function describeFullSuite(suite: AdmittedFullSuite): string {
	const command = [suite.check.command, ...suite.check.args].join(" ");
	return suite.source.kind === "config" ? `${command} (from repoSuites config)`
		: suite.source.kind === "package-json" ? `${command} (from package.json scripts.test)`
		: `${command} (from ${suite.source.file} test target)`;
}

/**
 * The `repoSuites` entry for the primary checkout `primary`. Keys are compared by real path.
 * Two keys for the same checkout throw, because the choice between them is not defined.
 */
export function configuredSuiteFor(repoSuites: Readonly<Record<string, CheckCommand>>, primary: string): CheckCommand | undefined {
	const matches = Object.entries(repoSuites).filter(([key]) => {
		try { return realpathSync.native(key) === primary; }
		catch { return key === primary; }
	});
	if (matches.length > 1) throw new Error(`repoSuites has ${matches.length} entries for ${primary}: ${matches.map(([key]) => key).join(", ")}. Keep one entry.`);
	return matches[0]?.[1];
}
