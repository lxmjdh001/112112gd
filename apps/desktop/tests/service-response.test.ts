import test from "node:test";
import assert from "node:assert/strict";
import { readServiceResult, serviceConnectionError } from "../src/main/service-response.ts";

test("network failures produce useful messages without exposing raw transport errors", () => {
  const address = "https://api.d1scrm.com";
  assert.match(
    serviceConnectionError(new TypeError("fetch failed"), address).message,
    /无法连接服务器/,
  );
  assert.match(
    serviceConnectionError(new DOMException("aborted", "TimeoutError"), address).message,
    /超时/,
  );
  assert.match(serviceConnectionError(Error("net::ERR_NAME_NOT_RESOLVED"), address).message, /DNS/);
  assert.match(
    serviceConnectionError(Error("net::ERR_PROXY_CONNECTION_FAILED"), address).message,
    /系统代理连接失败/,
  );
  assert.match(
    serviceConnectionError(Error("net::ERR_CERT_AUTHORITY_INVALID"), address).message,
    /证书/,
  );
  assert(
    !serviceConnectionError(Error("token=private-detail"), address).message.includes(
      "private-detail",
    ),
  );
});

test("valid API responses preserve success data and invalid-code errors", async () => {
  const success = { code: 0, data: { label: "测试" } };
  assert.deepEqual(await readServiceResult(Response.json(success)), success);
  const failure = { code: 401, message: "登录码无效" };
  assert.deepEqual(await readServiceResult(Response.json(failure, { status: 401 })), failure);
});

test("gateway HTML and malformed API envelopes give readable errors", async () => {
  await assert.rejects(
    readServiceResult(new Response("<html>Bad Gateway</html>", { status: 502 })),
    /HTTP 502/,
  );
  await assert.rejects(readServiceResult(new Response("challenge", { status: 403 })), /拒绝了连接/);
  await assert.rejects(readServiceResult(new Response("rate limit", { status: 429 })), /过于频繁/);
  for (const body of [null, {}, { code: "0" }, { code: 0, message: {} }])
    await assert.rejects(readServiceResult(Response.json(body)), /响应异常/);
});
