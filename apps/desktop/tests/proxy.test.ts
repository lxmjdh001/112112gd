import { test } from "node:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import http from "node:http";
import { once } from "node:events";
import { socksBridge } from "../src/main/proxy.ts";

async function read(socket: Socket, n: number): Promise<Buffer> {
  for (;;) {
    const b = socket.read(n) as Buffer | null;
    if (b) return b;
    if (socket.destroyed) throw Error("closed");
    await once(socket, "readable");
  }
}
async function fixture() {
  const connections = new Set<Socket>();
  let destinations = 0;
  let forwarded = 0;
  const track = (s: Socket) => {
    connections.add(s);
    s.on("error", () => {});
    s.once("close", () => connections.delete(s));
    return s;
  };
  const server = net.createServer((s) => {
    track(s);
    void (async () => {
      try {
        const hello = await read(s, 2);
        await read(s, hello[1]!);
        s.write(Buffer.from([5, 2]));
        const auth = await read(s, 2);
        const user = await read(s, auth[1]!);
        const pwlen = await read(s, 1);
        const password = await read(s, pwlen[0]!);
        if (user.toString() !== "test-user" || password.toString() !== "test-pass") {
          s.end(Buffer.from([1, 1]));
          return;
        }
        s.write(Buffer.from([1, 0]));
        const head = await read(s, 4);
        let host: string;
        if (head[3] === 1) {
          host = [...(await read(s, 4))].join(".");
        } else if (head[3] === 3) {
          host = (await read(s, (await read(s, 1))[0]!)).toString();
        } else throw Error("address family");
        const port = (await read(s, 2)).readUInt16BE();
        destinations++;
        const upstream = track(net.connect(port, host));
        await once(upstream, "connect");
        s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        s.on("data", (b) => (forwarded += b.length));
        s.pipe(upstream);
        upstream.pipe(s);
        s.once("close", () => upstream.destroy());
        upstream.once("close", () => s.destroy());
      } catch {
        s.destroy();
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as net.AddressInfo).port,
    destinations: () => destinations,
    forwarded: () => forwarded,
    close: async () => {
      for (const s of connections) s.destroy();
      server.close();
      await once(server, "close");
    },
  };
}
function request(port: number, url: string, authorization: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: url, headers: { "Proxy-Authorization": authorization } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test("SOCKS credentials are used; HTTP traffic passes through bridge; unauthorized callers are rejected", async () => {
  const socks = await fixture();
  const origin = http.createServer((_req, res) => res.end("relayed"));
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const bridge = await socksBridge({
    protocol: "socks5",
    host: "127.0.0.1",
    port: socks.port,
    username: "test-user",
    password: "test-pass",
  });
  try {
    const url = `http://127.0.0.1:${(origin.address() as net.AddressInfo).port}/probe`;
    const auth = "Basic " + Buffer.from(bridge.username + ":" + bridge.password).toString("base64");
    assert.equal((await request(bridge.port, url, "")).status, 407);
    const result = await request(bridge.port, url, auth);
    assert.equal(result.text, "relayed");
    assert.equal(socks.destinations(), 1);
    assert(socks.forwarded() > 0, "request body must traverse SOCKS tunnel");
  } finally {
    await bridge.close();
    await socks.close();
    origin.close();
    await once(origin, "close");
  }
});
test("failed upstream authentication never falls back to a direct origin connection", async () => {
  const socks = await fixture();
  let directHits = 0;
  const origin = http.createServer((_req, res) => {
    directHits++;
    res.end("must not reach");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const bridge = await socksBridge({
    protocol: "socks5",
    host: "127.0.0.1",
    port: socks.port,
    username: "bad",
    password: "bad",
  });
  try {
    const auth = "Basic " + Buffer.from(bridge.username + ":" + bridge.password).toString("base64");
    const result = await request(
      bridge.port,
      `http://127.0.0.1:${(origin.address() as net.AddressInfo).port}`,
      auth,
    );
    assert.equal(result.status, 502);
    assert.equal(directHits, 0);
  } finally {
    await bridge.close();
    await socks.close();
    origin.close();
    await once(origin, "close");
  }
});
