import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "../../bridge/json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "../../bridge/stt/json.ts";

function releaseMetadata(value: JsonValue) {
	const record = jsonRecord(value);
	assert(record, "Invalid release metadata");
	const tag = jsonStringField(record.tag_name);
	const body = jsonStringField(record.body);
	assert(tag, "Missing release tag");
	assert(record.draft === true || record.draft === false, "Missing draft status");
	assert(record.body === null || body !== null, "Invalid notes");
	assert(Array.isArray(record.assets), "Missing release assets");
	const assets = record.assets.map((entry: JsonValue) => {
		const asset = jsonRecord(entry);
		assert(asset, "Invalid release asset");
		const id = jsonNumberField(asset.id);
		const name = jsonStringField(asset.name);
		const state = jsonStringField(asset.state);
		assert(id !== null && Number.isSafeInteger(id) && id > 0, "Invalid asset ID");
		assert(name && state, "Missing asset name or state");
		return { id, name, state };
	});
	return { tag, draft: record.draft, body: body ?? "", assets };
}

function checkNotes(body: string) {
	const headings = body.match(/^## .+$/gm) ?? [];
	assert(headings[0] === "## Update" && headings[1] === "## What changed", "Notes must put Update before What changed");
	for (const action of ["update", "restart"]) {
		assert(body.includes(`herdr plugin action invoke ${action} --plugin herdr.collie`), `Notes lack the Herdr ${action} action`);
	}
	assert(!/<details\b|collie-[^\s/]+\.tar\.(?:gz|xz)|sha256sum/i.test(body), "Source-only notes must not contain the binary verification recipe");
}

type Request = (path: string, accept?: string) => Promise<Response>;

/** Only GET requests. Retry publication races, never authentication or server errors. */
export async function verifyRelease({
	tag,
	expected,
	request,
	attempts = 21,
	pause = async () => { await Bun.sleep(30_000); },
}: {
	tag: string;
	expected: JsonValue;
	request: Request;
	attempts?: number;
	pause?: () => Promise<void>;
}): Promise<void> {
	assert(jsonRecord(expected)?.version === tag.slice(1), "Generated sidecar and tag disagree");
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const response = await request(`/releases/tags/${encodeURIComponent(tag)}`);
		if (response.status !== 404) {
			assert(response.ok, `Release lookup failed: HTTP ${response.status}`);
			const metadata: JsonValue = await response.json();
			const release = releaseMetadata(metadata);
			assert(release.tag === tag, "Published release tag disagrees");
			if (!release.draft) {
				checkNotes(release.body);
				assert(release.assets.every((asset) => asset.name === "collie-release.json"), "Source-only release has unexpected assets");
				assert(release.assets.length <= 1, "Duplicate release sidecars");
				const asset = release.assets[0];
				if (asset?.state === "uploaded") {
					const sidecar = await request(`/releases/assets/${asset.id}`, "application/octet-stream");
					assert(sidecar.ok, `Sidecar download failed: HTTP ${sidecar.status}`);
					const actual: unknown = await sidecar.json();
					assert(isDeepStrictEqual(actual, expected), "Published collie-release.json differs from tagged source");
					return;
				}
			}
		}
		if (attempt < attempts) await pause();
	}
	throw new Error(`No published release with an uploaded collie-release.json after ${attempts} checks. Publish manually, then dispatch Verify release with tag ${tag}; do not move the tag.`);
}

if (import.meta.main) {
	const [tag, expectedPath] = process.argv.slice(2);
	assert(tag && expectedPath, "Usage: verify-release.ts TAG EXPECTED_JSON");
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GH_TOKEN;
	assert(repository && token, "GITHUB_REPOSITORY and GH_TOKEN are required");
	const expected: JsonValue = JSON.parse(readFileSync(expectedPath, "utf8"));
	await verifyRelease({
		tag, expected,
		request: (path, accept = "application/vnd.github+json") => fetch(`https://api.github.com/repos/${repository}${path}`, {
			headers: { accept, authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
			signal: AbortSignal.timeout(30_000),
		}),
	});
	const message = `Verified manually published source-only release ${tag}: notes and collie-release.json match the release contract. No release or asset was created or changed.\n`;
	process.stdout.write(message);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
}
