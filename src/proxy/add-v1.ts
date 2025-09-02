import { NextFunction, Request, Response } from "express";

export function addV1(req: Request, res: Response, next: NextFunction) {
  // Clients don't consistently use the /v1 prefix so we'll add it for them.
  if (!req.path.startsWith("/v1/") && !req.path.match(/^\/(v1alpha|v1beta)\//)) {
    req.url = `/v1${req.url}`;
  }
  next();
}
