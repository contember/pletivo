import { describe, test, expect } from "bun:test";
import { dispatchMiddlewares } from "../../packages/pletivo/src/astro-host/connect-bridge";
import type { ConnectMiddleware } from "../../packages/pletivo/src/astro-host/types";

function get(url = "http://localhost/"): Request {
  return new Request(url);
}

describe("connect bridge — res.end", () => {
  test("ends the response with the written body", async () => {
    const mw: ConnectMiddleware = (_req, res) => {
      res.statusCode = 201;
      res.setHeader("content-type", "text/plain");
      res.end("done");
    };
    const response = await dispatchMiddlewares(get(), [mw]);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);
    expect(await response!.text()).toBe("done");
  });

  // Node runs `end`'s callback once the stream finishes; middleware sequences
  // cleanup off it (release a lock, close a span). Dropping it stranded that
  // work with no error anywhere.
  test("runs the completion callback passed as end(chunk, cb)", async () => {
    let called = false;
    const mw: ConnectMiddleware = (_req, res) => {
      res.end("body", () => {
        called = true;
      });
    };
    await dispatchMiddlewares(get(), [mw]);
    await Bun.sleep(1);
    expect(called).toBe(true);
  });

  test("runs the completion callback passed as end(cb)", async () => {
    let called = false;
    const mw: ConnectMiddleware = (_req, res) => {
      res.end(() => {
        called = true;
      });
    };
    await dispatchMiddlewares(get(), [mw]);
    await Bun.sleep(1);
    expect(called).toBe(true);
  });

  test("runs the completion callback passed as end(chunk, encoding, cb)", async () => {
    let called = false;
    const mw: ConnectMiddleware = (_req, res) => {
      res.end("body", "utf8", () => {
        called = true;
      });
    };
    await dispatchMiddlewares(get(), [mw]);
    await Bun.sleep(1);
    expect(called).toBe(true);
  });

  test("still runs the callback when the response already ended", async () => {
    let second = false;
    const mw: ConnectMiddleware = (_req, res) => {
      res.end("first");
      res.end("second", () => {
        second = true;
      });
    };
    const response = await dispatchMiddlewares(get(), [mw]);
    await Bun.sleep(1);
    expect(await response!.text()).toBe("first");
    expect(second).toBe(true);
  });
});
