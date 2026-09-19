import { expect, test } from "bun:test";
import { verifyRelease } from "../.github/scripts/verify-release.ts";
import type { JsonValue } from "../bridge/json.ts";

const tag = "v1.10.1+ys.1";
const expected = { version: "1.10.1+ys.1", crewProtocol: 2 };
const body = `## Update

herdr plugin action invoke update --plugin herdr.collie
herdr plugin action invoke restart --plugin herdr.collie

## What changed

- A fix.
`;
const published = {
	tag_name: tag, draft: false, body,
	assets: [{ id: 42, name: "collie-release.json", state: "uploaded" }],
};

test("verifies the published sidecar semantically after a tag-before-publication wait", async () => {
	let waits = 0;
	const paths: string[] = [];
	await verifyRelease({
		tag, expected, attempts: 2,
		pause: async () => { waits++; },
		request: async (path, accept) => {
			paths.push(path);
			if (paths.length === 1) return new Response(null, { status: 404 });
			if (path.includes("/assets/")) {
				expect(accept).toBe("application/octet-stream");
				return Response.json({ crewProtocol: 2, version: "1.10.1+ys.1" });
			}
			return Response.json(published);
		},
	});
	expect(waits).toBe(1);
	expect(paths).toEqual([`/releases/tags/${encodeURIComponent(tag)}`, `/releases/tags/${encodeURIComponent(tag)}`, "/releases/assets/42"]);
});

function verify(metadata: JsonValue = published, sidecar: JsonValue = expected, generated: JsonValue = expected) {
	return verifyRelease({
		tag, expected: generated, attempts: 1,
		request: async (path) => Response.json(path.includes("/assets/") ? sidecar : metadata),
	});
}

test.each([
	["wrong version", { ...expected, version: "1.10.0+ys.1" }],
	["wrong protocol", { ...expected, crewProtocol: 1 }],
	["extra field", { ...expected, extra: true }],
	["spurious urgency", { ...expected, urgent: { reason: "Updating can leave the service stopped." } }],
	["missing protocol", { version: expected.version }],
])("refuses a sidecar with %s", async (_name, sidecar) => {
	await expect(verify(published, sidecar)).rejects.toThrow("differs from tagged source");
});

test("valid notes tolerate CRLF line endings", async () => {
	await expect(verify({ ...published, body: body.replaceAll("\n", "\r\n") })).resolves.toBeUndefined();
});

test("urgency must also match generated content", async () => {
	const urgent = { ...expected, urgent: { reason: "Updating can leave the service stopped." } };
	await expect(verify(published, expected, urgent)).rejects.toThrow("differs from tagged source");
	await expect(verify(published, urgent, urgent)).resolves.toBeUndefined();
});

test.each([
	["a draft", { ...published, draft: true }],
	["an absent sidecar", { ...published, assets: [] }],
	["an unfinished upload", { ...published, assets: [{ id: 42, name: "collie-release.json", state: "new" }] }],
])("bounded wait refuses %s and explains manual retry", async (_name, metadata) => {
	await expect(verify(metadata)).rejects.toThrow("Publish manually, then dispatch Verify release");
});

test("publication can finish after a draft or an unfinished sidecar", async () => {
	const pending = [
		{ ...published, draft: true },
		{ ...published, assets: [] },
		published,
	];
	let waits = 0;
	await verifyRelease({
		tag, expected, attempts: 3,
		pause: async () => { waits++; },
		request: async (path) => Response.json(path.includes("/assets/") ? expected : pending.shift()),
	});
	expect(waits).toBe(2);
});

test("404 publication timeout uses exactly the bounded wait", async () => {
	let waits = 0;
	await expect(verifyRelease({
		tag, expected, attempts: 3,
		pause: async () => { waits++; },
		request: async () => new Response(null, { status: 404 }),
	})).rejects.toThrow("after 3 checks");
	expect(waits).toBe(2);
});

test.each([401, 403, 429, 500])("HTTP %s fails immediately, not as missing publication", async (status) => {
	let waits = 0;
	await expect(verifyRelease({
		tag, expected,
		pause: async () => { waits++; },
		request: async () => new Response(null, { status }),
	})).rejects.toThrow(`HTTP ${status}`);
	expect(waits).toBe(0);
});

const invalidMetadata: JsonValue[] = [
	{ ...published, tag_name: "v1.10.0+ys.1" },
	{ ...published, body: "## What changed\n\n## Update\n" },
	{ ...published, body: body.replace("invoke restart", "invoke status") },
	{ ...published, body: `${body}\n<details>Verify a download</details>` },
	{ ...published, assets: [...published.assets, { id: 43, name: "binary.tar.gz", state: "uploaded" }] },
	{ ...published, assets: [...published.assets, ...published.assets] },
	{ ...published, draft: "false" },
	null,
];

test.each(invalidMetadata)("refuses invalid metadata or non-source-only publication: %j", async (metadata) => {
	await expect(verify(metadata)).rejects.toThrow();
});

test("a generated version mismatch fails before accessing GitHub", async () => {
	let requests = 0;
	await expect(verifyRelease({
		tag, expected: { ...expected, version: "1.10.0+ys.1" },
		request: async () => { requests++; return Response.json(published); },
	})).rejects.toThrow("Generated sidecar and tag disagree");
	expect(requests).toBe(0);
});

test("malformed downloaded JSON and download failures remain red", async () => {
	for (const response of [new Response("not JSON"), new Response(null, { status: 403 })]) {
		await expect(verifyRelease({
			tag, expected,
			request: async (path) => path.includes("/assets/") ? response : Response.json(published),
		})).rejects.toThrow();
	}
});
