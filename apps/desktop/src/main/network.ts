import { net, type Session } from "electron";
export interface ProxyAuth {
  host: string;
  port: number;
  username: string;
  password: string;
}
export function throughSession(ses: Session, auth: ProxyAuth) {
  return (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const request = net.request({
        url,
        session: ses,
        redirect: "error",
        useSessionCookies: false,
      });
      request.setHeader("Cache-Control", "no-store");
      request.setHeader("Pragma", "no-cache");
      let attempts = 0;
      let done = false;
      const finish = (e?: Error, response?: Response) => {
        if (done) return;
        done = true;
        init?.signal?.removeEventListener("abort", abort);
        if (e) reject(e);
        else resolve(response!);
      };
      const abort = () => {
        request.abort();
        finish(new Error("request aborted"));
      };
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener("abort", abort, { once: true });
      request.on("login", (info, callback) => {
        if (info.isProxy && info.host === auth.host && info.port === auth.port && attempts++ < 1)
          callback(auth.username, auth.password);
        else callback();
      });
      request.on("error", () => finish(new Error("proxy request failed")));
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            abort();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", () => finish(new Error("response failed")));
        response.on("end", () =>
          finish(undefined, new Response(Buffer.concat(chunks), { status: response.statusCode })),
        );
      });
      request.end();
    });
}
