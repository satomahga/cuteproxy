import axios, { AxiosInstance } from "axios";
import http from "http";
import https from "https";
import os from "os";
import { ProxyAgent } from "proxy-agent";
import { config } from "../config";
import { logger } from "../logger";
import crypto from "crypto";

const log = logger.child({ module: "network" });

export type HttpAgent = http.Agent | https.Agent;

let httpAgent: HttpAgent;
let httpsAgent: HttpAgent;
let axiosInstance: AxiosInstance;

type AgentPool = {
  addresses: string[];
  httpAgents: Map<string, http.Agent>;
  httpsAgents: Map<string, https.Agent>;
};

let cachedPool: AgentPool | null = null;

function getInterfaceAddresses(iface: string): string[] {
  const ifaces = os.networkInterfaces();
  if (!ifaces[iface]) {
    throw new Error(`Interface ${iface} not found.`);
  }
  return (ifaces[iface] || [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address as string);
}

function getConfiguredEgressAddresses(): string[] {
  const { interface: iface } = config.httpAgent || {};
  const localAddresses: string[] | undefined = (config.httpAgent as any)?.localAddresses;
  if (typeof process.env.HTTP_AGENT_LOCAL_ADDRESSES === "string") {
    return process.env.HTTP_AGENT_LOCAL_ADDRESSES
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(localAddresses) && localAddresses.length > 0) {
    return localAddresses;
  }
  if (iface) {
    return getInterfaceAddresses(iface);
  }
  return [];
}


/**
 * Returns a pool of keep-alive agents keyed by the local egress IP.
 * If no egress IPs are configured, returns a single default agent (no localAddress).
 */
export function getAgentPool(): AgentPool {
  if (cachedPool) return cachedPool;

  const addresses = getConfiguredEgressAddresses();

  // If a proxy URL is set, we don't bind localAddress (the proxy decides the egress).
  const proxyUrl = config.httpAgent?.proxyUrl;
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.WS_PROXY = proxyUrl;
    process.env.WSS_PROXY = proxyUrl;
    const agent = new ProxyAgent();
    cachedPool = {
      addresses: ["proxy"],
      httpAgents: new Map([["proxy", agent as any]]),
      httpsAgents: new Map([["proxy", agent as any]]),
    };
    const redacted = proxyUrl.replace(/:.*@/, ":******@");
    log.info({ proxy: redacted }, "Using upstream proxy server for egress.");
    return cachedPool;
  }

  if (addresses.length === 0) {
    // Fallback: single default Agent (kernel chooses source IP)
    const defHttp = new http.Agent({ keepAlive: true });
    const defHttps = new https.Agent({ keepAlive: true });
    cachedPool = {
      addresses: ["default"],
      httpAgents: new Map([["default", defHttp]]),
      httpsAgents: new Map([["default", defHttps]]),
    };
    log.info("No explicit egress IPs configured; using default Agents.");
    return cachedPool;
  }

  const httpAgents = new Map<string, http.Agent>();
  const httpsAgents = new Map<string, https.Agent>();

  for (const addr of addresses) {
    httpAgents.set(addr, new http.Agent({ localAddress: addr, keepAlive: true }));
    httpsAgents.set(addr, new https.Agent({ localAddress: addr, keepAlive: true }));
  }
  cachedPool = { addresses, httpAgents, httpsAgents };
  log.info({ addresses }, "Initialized egress Agent pool.");
  return cachedPool;
}

export function getEgressPoolSize(): number {
  return getAgentPool().addresses.length || 1;
}

/**
 * Consistent-hash a key to one egress IP for stable, even distribution.
 * If you want true round-robin per request, toggle the strategy below.
 */
export function pickEgressAddress(keyLike: string): string {
  const pool = getAgentPool();
  const addrs = pool.addresses;
  if (addrs.length <= 1) return addrs[0];
  try {
    const h = crypto.createHash("sha1").update(String(keyLike)).digest("hex");
    const n = parseInt(h.slice(0, 8), 16);
    return addrs[n % addrs.length];
  } catch {
    // fallback: round-robin-ish by time
    const idx = Math.floor(Date.now() / 1000) % addrs.length;
    return addrs[idx];
  }
}

// Backward compatibility for other modules
export function getHttpAgents() {
  if (httpAgent) return [httpAgent, httpsAgent];
  const { interface: iface, proxyUrl } = config.httpAgent || {};

  if (iface) {
    const address = getInterfaceAddresses(iface)[0];
    httpAgent = new http.Agent({ localAddress: address, keepAlive: true });
    httpsAgent = new https.Agent({ localAddress: address, keepAlive: true });
    log.info({ address }, "Using first address on configured interface for outgoing requests.");
  } else if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.WS_PROXY = proxyUrl;
    process.env.WSS_PROXY = proxyUrl;
    httpAgent = new ProxyAgent();
    httpsAgent = httpAgent; // ProxyAgent handles HTTPS
    const proxy = proxyUrl.replace(/:.*@/, ":******@");
    log.info({ proxy }, "Using proxy server for outgoing requests.");
  } else {
    httpAgent = new http.Agent({ keepAlive: true });
    httpsAgent = new https.Agent({ keepAlive: true });
  }
  return [httpAgent, httpsAgent];
}

export function getAxiosInstance() {
  if (axiosInstance) return axiosInstance;
  const [httpAgent, httpsAgent] = getHttpAgents();
  axiosInstance = axios.create({ httpAgent, httpsAgent, proxy: false });
  return axiosInstance;
}
