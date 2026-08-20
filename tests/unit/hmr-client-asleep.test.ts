import { describe, expect, test } from "bun:test";
import { hmrClientScript } from "../../packages/pletivo/src/runtime/hmr-client";

/**
 * The HMR client is browser JS shipped as a string, so it is exercised here by evaluating it
 * against hand-rolled stubs — enough DOM and network surface for the transport ladder to run,
 * and nothing more. No DOM library: the script touches a small, stable set of globals.
 *
 * What is under test is one rule. A server that answers with an error is not sending a message.
 * Before this, `poll()` handed the body of a 5xx to `handleMessage`, which recognised none of its
 * types and fell through to `location.reload()` — and a reload is ordinary page traffic, so a
 * proxy that had just declined to wake a sleeping workspace got woken by the very client it had
 * turned away, on repeat, for as long as the tab stayed open.
 */

interface Harness {
	reloads: number;
	requests: string[];
	/** Run every timer whose delay has come due, oldest first, advancing a virtual clock. */
	runTimers: (untilMs: number) => Promise<void>;
}

/** `null` means "the server is holding this one open" — what a real long-poll does. */
type Reply = { ok: boolean; status: number; body: string } | null;

function evaluateClient(respond: (url: string) => Reply): Harness {
	const script = hmrClientScript()
		.replace(/^\s*<script type="module">/, "")
		.replace(/<\/script>\s*$/, "");

	const requests: string[] = [];
	let reloads = 0;
	let navigating = false;
	let clock = 0;
	let seq = 0;
	const timers: { at: number; seq: number; fn: () => void }[] = [];

	const listener = () => {};
	const element = {
		addEventListener: listener,
		removeEventListener: listener,
		querySelector: () => null,
		querySelectorAll: () => [],
		hasAttribute: () => false,
	};

	const scope = {
		console: { log: listener, warn: listener },
		location: {
			origin: "https://preview.example",
			protocol: "https:",
			host: "preview.example",
			href: "https://preview.example/",
			reload: () => {
				// A real reload tears the page down, so nothing the old script had in flight ever
				// comes back. Modelling that is what makes a client that reloads STOP here instead
				// of spinning — the failure then reads as "it reloaded", not as a hung test.
				reloads++;
				navigating = true;
			},
		},
		document: { ...element, hidden: false, body: element, head: element },
		MutationObserver: class {
			observe() {}
			takeRecords() {
				return [];
			}
		},
		// Both transports are refused outright by a proxy fronting a sleeping workspace, which is
		// what pushes the client down to long-polling — the path that used to reload.
		WebSocket: class {
			onopen: (() => void) | null = null;
			onmessage: (() => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				queueMicrotask(() => this.onclose?.());
			}
			close() {}
		},
		EventSource: class {
			onopen: (() => void) | null = null;
			onmessage: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				queueMicrotask(() => this.onerror?.());
			}
			close() {}
		},
		fetch: (url: string) => {
			if (navigating) return new Promise(() => {});
			requests.push(url);
			const reply = respond(url);
			if (!reply) return new Promise(() => {});
			return Promise.resolve({ ok: reply.ok, status: reply.status, text: () => Promise.resolve(reply.body) });
		},
		setTimeout: (fn: () => void, ms: number) => {
			timers.push({ at: clock + (ms ?? 0), seq: seq++, fn });
			return timers.length;
		},
		clearTimeout: listener,
	};

	const keys = Object.keys(scope);
	// biome-ignore lint/security/noGlobalEval: the client is a string of browser JS; running it is the point
	new Function(...keys, script)(...keys.map(k => scope[k as keyof typeof scope]));

	return {
		get reloads() {
			return reloads;
		},
		requests,
		runTimers: async (untilMs: number) => {
			// Bounded so a client that schedules without ever advancing fails the test instead of
			// hanging the suite.
			for (let fired = 0; fired < 500; fired++) {
				await Bun.sleep(0);
				const next = timers
					.filter(t => t.at <= untilMs)
					.sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
				if (!next) return;
				timers.splice(timers.indexOf(next), 1);
				clock = next.at;
				next.fn();
			}
			throw new Error("timer budget exhausted — the client is scheduling without making progress");
		},
	};
}

const asleep = () => ({ ok: false, status: 503, body: "Preview is asleep" });

describe("HMR client against a sleeping server", () => {
	test("never reloads the page, however long the tab is left open", async () => {
		const harness = evaluateClient(asleep);

		await harness.runTimers(10 * 60_000);

		// One reload is all it takes: it is a plain page request, so it wakes the workspace.
		expect(harness.reloads).toBe(0);
	});

	test("backs off instead of probing once a second forever", async () => {
		const harness = evaluateClient(asleep);

		await harness.runTimers(60_000);

		// A fixed 1 s retry would be ~60 pings in this window; the widening interval caps it far
		// below that. The exact count is not the point — the order of magnitude is.
		const pings = harness.requests.filter(url => url.endsWith("/__hmr_ping"));
		expect(pings.length).toBeLessThan(12);
	});

	test("a server that answers normally is still driven by its messages", async () => {
		let answered = false;
		const harness = evaluateClient(() => {
			if (answered) return null; // hold the next poll open, as a real long-poll does
			answered = true;
			return { ok: true, status: 200, body: "reload" };
		});

		await harness.runTimers(5_000);

		// The reload path must survive: an OK response saying "reload" still means reload. Only an
		// ERROR response stops being treated as a message.
		expect(harness.reloads).toBe(1);
	});
});
