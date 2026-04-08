import { STATUS_CODES } from "node:http";
import { URLSearchParams } from "node:url";
import { types } from "node:util";
import { request, Headers, type HeadersInit } from "undici";

type UndiciRequestOptions = NonNullable<Parameters<typeof request>[1]>;

async function resolveBody(body: UndiciRequestOptions["body"]): Promise<UndiciRequestOptions["body"]> {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (types.isUint8Array(body)) {
    return body;
  }
  if (types.isArrayBuffer(body)) {
    return new Uint8Array(body);
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof DataView) {
    return new Uint8Array(body.buffer);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof FormData) {
    return body;
  }
  if (typeof body === "object" && body !== null && Symbol.iterator in body) {
    const chunks = [...(body as Iterable<Buffer>)];
    return Buffer.concat(chunks);
  }
  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError("Unable to resolve body.");
}

export async function discordUndiciMakeRequest(url: string, init: UndiciRequestOptions) {
  const options: UndiciRequestOptions = {
    ...init,
    body: await resolveBody(init.body),
  };
  const res = await request(url, options);
  return {
    body: res.body,
    async arrayBuffer() {
      return res.body.arrayBuffer();
    },
    async json() {
      return res.body.json();
    },
    async text() {
      return res.body.text();
    },
    get bodyUsed() {
      return res.body.bodyUsed;
    },
    headers: new Headers(res.headers as HeadersInit),
    status: res.statusCode,
    statusText: STATUS_CODES[res.statusCode] ?? "",
    ok: res.statusCode >= 200 && res.statusCode < 300,
  };
}
