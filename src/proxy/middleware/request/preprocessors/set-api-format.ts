import { Request } from "express";
import { APIFormat } from "../../../../shared/key-management";
import { LLMService } from "../../../../shared/models";
import { RequestPreprocessor } from "../index";

export const setApiFormat = (api: {
  /**
   * The API format the user made the request in and expects the response to be
   * in.
   */
  inApi: Request["inboundApi"];
  /**
   * The API format the proxy will make the request in and expects the response
   * to be in. If different from `inApi`, the proxy will transform the user's
   * request body to this format, and will transform the response body or stream
   * events from this format.
   */
  outApi: APIFormat;
  /**
   * The service the request will be sent to, which determines authentication
   * and possibly the streaming transport.
   */
  service: LLMService;
}): RequestPreprocessor => {
  return function configureRequestApiFormat(req) {
    req.inboundApi = api.inApi;
    req.outboundApi = api.outApi;
    req.service = api.service;
  };
};
