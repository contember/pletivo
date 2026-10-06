const port = Number(process.argv[2]);
const nonce = process.argv[3];

if (!Number.isInteger(port) || port < 1 || nonce === undefined || nonce === "") {
  throw new Error("usage: sidecar.ts <port> <nonce>");
}

let hits = 0;
let proxyHits = 0;
let directHits = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ready") return new Response("ready");
    if (url.pathname === "/hits" && url.searchParams.get("nonce") === nonce) {
      return Response.json({ hits, proxy: proxyHits, direct: directHits });
    }
    if (url.pathname !== "/probe" || url.searchParams.get("nonce") !== nonce) {
      return new Response("invalid sidecar request", { status: 400 });
    }
    hits++;
    const proxied = request.headers.get("x-pletivo-workerd-proxy") === "1";
    if (proxied) proxyHits++;
    else directHits++;
    return new Response(`sidecar:${nonce}:${proxied ? "proxy" : "direct"}`);
  },
});

console.log(`sidecar ready on ${server.port}`);
