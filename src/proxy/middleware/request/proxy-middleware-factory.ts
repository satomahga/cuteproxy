import { Request, Response } from "express";
import http from "http";
import ProxyServer from "http-proxy";
import { Readable } from "stream";
import {
  createProxyMiddleware,
  Options,
  debugProxyErrorsPlugin,
  proxyEventsPlugin,
} from "http-proxy-middleware";
import { ProxyReqMutator, stripHeaders } from "./index";
import { createOnProxyResHandler, ProxyResHandlerWithBody } from "../response";
import { createQueueMiddleware } from "../../queue";
import { getAgentPool, pickEgressAddress } from "../../../shared/network";
import { classifyErrorAndSend } from "../common";

export function createQueuedProxyMiddleware({
  target,
  mutations,
  blockingResponseHandler,
}: {
  mutations?: ProxyReqMutator[];
  target: string | Options<Request>["router"];
  blockingResponseHandler?: ProxyResHandlerWithBody;
}) {
  const hpmTarget = typeof target === "string" ? target : "https://setbyrouter";
  const hpmRouter = typeof target === "function" ? target : undefined;

  // Build one proxy per egress IP, each with its own Agent
  const pool = getAgentPool();
  const isHttp = hpmTarget.startsWith("http:");
  const proxies = new Map<string, ReturnType<typeof createProxyMiddleware<Request, Response>>>();

  for (const ip of pool.addresses) {
    const agent = isHttp ? pool.httpAgents.get(ip)! : pool.httpsAgents.get(ip)!;
    const hpm = createProxyMiddleware<Request, Response>({
      target: hpmTarget,
      router: hpmRouter,
      agent,
      changeOrigin: true,
      toProxy: true,
      selfHandleResponse: typeof blockingResponseHandler === "function",
      ejectPlugins: true,
      plugins: [debugProxyErrorsPlugin, pinoLoggerPlugin, proxyEventsPlugin] as any,
      on: {
        proxyRes: createOnProxyResHandler(
          blockingResponseHandler ? [blockingResponseHandler] : []
        ),
        error: classifyErrorAndSend,
      },
      buffer: ((req: Request) => {
        let payload = req.body;
        if (typeof payload === "string") {
          payload = Buffer.from(payload);
        }
        const stream = new Readable();
        stream.push(payload);
        stream.push(null);
        return stream;
      }) as any,
    });
    proxies.set(ip, hpm);
  }

  // Fallback when no IPs configured
  if (proxies.size === 0) {
    const hpm = createProxyMiddleware<Request, Response>({ /* your existing options using getHttpAgents() */ } as any);
    proxies.set("default", hpm);
  }

  // This proxyMiddleware will choose the right per-IP proxy at runtime
  const proxyMiddleware = (req: Request, res: Response, next: any) => {
    // Use the upstream key if available; otherwise user token/IP.
    // By here, your addKey mutator has already run (req.key is set).
    const keyish =
      req.key?.hash || req.user?.token || req.risuToken || req.ip || "default";
    const ip = pickEgressAddress(keyish);
    (req as any).egressIp = ip; // for logging/diagnostics
    const chosen = proxies.get(ip) || proxies.values().next().value;
    return chosen(req, res, next);
  };

  return createQueueMiddleware({
    mutations: [stripHeaders, ...(mutations ?? [])],
    proxyMiddleware,
  });
}

function pinoLoggerPlugin(proxyServer: ProxyServer<Request>) {
  proxyServer.on("error", (err, req, res, target) => {
    req.log.error(
      { originalUrl: req.originalUrl, targetUrl: String(target), err },
      "Error occurred while proxying request to target"
    );
  });
  proxyServer.on("proxyReq", (proxyReq, req) => {
    const { protocol, host, path } = proxyReq;
    req.log.info(
      {
        from: req.originalUrl,
        to: `${protocol}//${host}${path}`,
        egressIp: (req as any).egressIp,
      },
      "Sending request to upstream API..."
    );
  });
  proxyServer.on("proxyRes", (proxyRes: any, req) => {
    const { protocol, host, path } = proxyRes.req;
    req.log.info(
      {
        target: `${protocol}//${host}${path}`,
        status: proxyRes.statusCode,
        contentType: proxyRes.headers["content-type"],
        contentEncoding: proxyRes.headers["content-encoding"],
        contentLength: proxyRes.headers["content-length"],
        transferEncoding: proxyRes.headers["transfer-encoding"],
        egressIp: (req as any).egressIp,
      },
      "Got response from upstream API."
    );
  });
}
