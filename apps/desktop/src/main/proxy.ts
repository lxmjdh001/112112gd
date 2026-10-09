import http from "node:http";
import { Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SocksClient } from "socks";
import type { ProxyConfig } from "../shared/types.ts";

export interface Bridge {
  port: number;
  username: string;
  password: string;
  close(): Promise<void>;
}
// Chromium does not support SOCKS username/password itself. This authenticated
// loopback bridge tunnels every request through SOCKS; it never falls back to direct.
export async function socksBridge(config: ProxyConfig): Promise<Bridge> {
  const username = "gongdan";
  const password = randomBytes(24).toString("hex");
  const expected = Buffer.from(
    "Basic " + Buffer.from(username + ":" + password).toString("base64"),
  );
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    return s;
  };
  function authenticated(req: http.IncomingMessage) {
    const raw = Buffer.from(req.headers["proxy-authorization"] || "");
    return raw.length === expected.length && timingSafeEqual(raw, expected);
  }
  async function connect(host: string, port: number) {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: config.host,
        port: config.port,
        type: 5,
        userId: config.username,
        password: config.password,
      },
      command: "connect",
      destination: { host, port },
      timeout: 12000,
    });
    return track(socket);
  }
  const server = http.createServer(async (req, res) => {
    if (!authenticated(req)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="gongdan"' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "");
      if (url.protocol !== "http:") throw Error();
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      const socket = await connect(url.hostname, Number(url.port) || 80);
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const upstream = http.request(
        {
          method: req.method,
          host: url.hostname,
          port: Number(url.port) || 80,
          path: url.pathname + url.search,
          headers,
          agent,
        },
        (reply) => {
          res.writeHead(reply.statusCode || 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.once("close", () => {
        upstream.destroy();
        socket.destroy();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(502).end();
    }
  });
  server.on("connection", track);
  server.on("connect", async (req, client, head) => {
    if (!authenticated(req)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="gongdan"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    let dest: URL;
    try {
      dest = new URL("http://" + req.url);
      if (!dest.hostname || !dest.port) throw Error();
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    try {
      const upstream = await connect(dest.hostname.replace(/^\[|\]$/g, ""), Number(dest.port));
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("代理桥接启动失败");
  return {
    port: address.port,
    username,
    password,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
