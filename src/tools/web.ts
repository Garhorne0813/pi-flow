import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import { Fault } from "../domain.js";
const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
export function publicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // Only global unicast v6 is eligible; exclude documentation and transition ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0:|db8:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
export async function webFetch(
  raw: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ url: string; text: string; truncated: boolean }> {
  signal.throwIfAborted();
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Fault(403, "WEB_URL_DENIED");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Fault(403, "WEB_PRIVATE_ADDRESS_DENIED");
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          "User-Agent": "pi-flow/0.1",
          Accept: "text/plain,text/html,application/json",
        },
        lookup: (_h, options, callback) => {
          if (options.all)
            callback(null, [
              { address: selected.address, family: selected.family },
            ]);
          else callback(null, selected.address, selected.family);
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 3)
            return reject(new Fault(502, "WEB_TOO_MANY_REDIRECTS"));
          void webFetch(
            new URL(res.headers.location, url).href,
            signal,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Fault(502, "WEB_FETCH_FAILED"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0,
          truncated = false;
        res.on("data", (chunk: Buffer) => {
          const remaining = 262144 - size;
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(remaining, chunk.length);
          }
          if (chunk.length > remaining) {
            truncated = true;
            res.destroy();
            resolve({
              url: url.href,
              text: Buffer.concat(chunks).toString("utf8"),
              truncated,
            });
          }
        });
        res.on("end", () =>
          resolve({
            url: url.href,
            text: Buffer.concat(chunks).toString("utf8"),
            truncated,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function webSearch(query: string, signal: AbortSignal) {
  const configured = process.env.WEB_SEARCH_URL;
  if (!configured) throw new Fault(503, "WEB_SEARCH_NOT_CONFIGURED");
  const url = new URL(configured);
  url.searchParams.set("q", query);
  return webFetch(url.href, signal);
}
