import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFullSuiteSource, configuredSuiteFor, declaresMakeTest, describeFullSuite, resolveFullSuite } from "../src/full-suite.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-suite-")));
	try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("declaresMakeTest finds only a literal test target outside recipes", () => {
	for (const text of ["test:", "test: build", "test::", "build test check: deps", ".PHONY: test\ntest:\n\tgo test ./..."]) {
		assert.equal(declaresMakeTest(text), true, text);
	}
	for (const text of [
		"", "tests:", "test := 1", "test ::= 1", "test = value", "# test:", "build:\n\ttest: not a rule",
		"build: \\\n  test: continued", "$(TARGETS): test-deps", "%test: x",
	]) {
		assert.equal(declaresMakeTest(text), false, text);
	}
});

test("resolveFullSuite prefers config, then package.json scripts.test, then a Makefile test target", async () => {
	await withRoot(async (root) => {
		assert.throws(() => resolveFullSuite(root), /No Full suite is available for .*Configure repoSuites/);
		await writeFile(join(root, "Makefile"), "test:\n\tgo test ./...\n");
		const make = resolveFullSuite(root);
		assert.deepEqual(make.check, { command: "make", args: ["test"] });
		assert.equal(make.source.kind, "makefile");
		assert.match(describeFullSuite(make), /^make test \(from Makefile test target\)$/);
		// A manifest without scripts.test falls through to the Makefile.
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
		assert.equal(resolveFullSuite(root).source.kind, "makefile");
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		assert.deepEqual(resolveFullSuite(root), { check: { command: "pnpm", args: ["test"] }, source: { kind: "package-json", testScript: "node --test" } });
		const configured = resolveFullSuite(root, { command: "uv", args: ["run", "pytest"] });
		assert.deepEqual(configured, { check: { command: "uv", args: ["run", "pytest"] }, source: { kind: "config" } });
		// A read or parse error never counts as an absent source.
		await writeFile(join(root, "package.json"), "{ not json");
		assert.throws(() => resolveFullSuite(root), /cannot parse .*package\.json/);
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: 1 } }));
		assert.throws(() => resolveFullSuite(root), /test script that is not text/);
	});
});

test("assertFullSuiteSource rejects a changed package test script or Makefile", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		const pnpm = resolveFullSuite(root);
		assertFullSuiteSource(pnpm, root);
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
		assert.throws(() => assertFullSuiteSource(pnpm, root), /changed the admitted root package\.json test script/);

		await rm(join(root, "package.json"));
		await writeFile(join(root, "Makefile"), "test:\n\tgo test ./...\n");
		const make = resolveFullSuite(root);
		assertFullSuiteSource(make, root);
		await writeFile(join(root, "Makefile"), "test:\n\ttrue\n");
		assert.throws(() => assertFullSuiteSource(make, root), /changed the admitted root Makefile/);
		// Make reads GNUmakefile first, so a new GNUmakefile also changes the source.
		await writeFile(join(root, "Makefile"), "test:\n\tgo test ./...\n");
		await writeFile(join(root, "GNUmakefile"), "test:\n\tgo test ./...\n");
		assert.throws(() => assertFullSuiteSource(make, root), /changed the admitted root Makefile/);
		assertFullSuiteSource({ check: { command: "uv", args: [] }, source: { kind: "config" } }, root);
	});
});

test("configuredSuiteFor matches keys by real path and refuses two keys for one checkout", async () => {
	await withRoot(async (root) => {
		const primary = join(root, "service");
		await mkdir(primary);
		await symlink(primary, join(root, "alias"));
		const suite = { command: "make", args: ["check"] };
		assert.deepEqual(configuredSuiteFor({ [join(root, "alias")]: suite }, primary), suite);
		assert.equal(configuredSuiteFor({ [join(root, "other")]: suite }, primary), undefined);
		assert.throws(() => configuredSuiteFor({ [primary]: suite, [join(root, "alias")]: suite }, primary), /2 entries for .*Keep one entry/);
	});
});
