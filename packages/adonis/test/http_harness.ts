import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

export type Handler = (ctx: never) => unknown;

/** A tiny router + HttpContext adapter: enough to run the control plane handlers over real HTTP. */
export function serve(
  routes: Array<{ method: string; pattern: string; handler: Handler }>,
): Promise<Server> {
  const match = (pattern: string, path: string) => {
    const names: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-z]+)/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      })}$`,
    );
    const m = re.exec(path);
    return m ? Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) : null;
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://x');
    for (const route of routes) {
      const params = route.method === req.method ? match(route.pattern, url.pathname) : null;
      if (!params) continue;
      let status = 200;
      const headers: Record<string, string> = {};
      let streamed = false;
      const response = {
        status(code: number) {
          status = code;
          return response;
        },
        header(name: string, value: string) {
          headers[name] = value;
          return response;
        },
        send(body: unknown) {
          res.writeHead(status, headers);
          if (Buffer.isBuffer(body) || body instanceof Uint8Array) res.end(body);
          else res.end(typeof body === 'string' ? body : JSON.stringify(body));
        },
        json(body: unknown) {
          headers['content-type'] = 'application/json';
          response.send(body);
        },
        stream(body: Readable) {
          streamed = true;
          res.writeHead(status, headers);
          body.pipe(res);
        },
      };
      const headerValue = (name: string) =>
        (req.headers[name.toLowerCase()] as string | undefined) ?? undefined;
      const ctx = {
        params,
        request: {
          header: headerValue,
          headers: () => req.headers as Record<string, string | string[] | undefined>,
          body: () => (raw ? JSON.parse(raw) : {}),
          qs: () => Object.fromEntries(url.searchParams),
          request: req,
        },
        response,
      };
      await route.handler(ctx as never);
      if (!streamed && !res.writableEnded) res.end();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The base URL of a listening server. */
export function addressOf(server: Server): string {
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('server is not listening');
  return `http://127.0.0.1:${address.port}`;
}
