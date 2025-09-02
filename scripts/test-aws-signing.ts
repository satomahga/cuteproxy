// uses the aws sdk to sign a request, then uses axios to send it to the bedrock REST API manually
import axios from "axios";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID!;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY!;

// Copied from amazon bedrock docs

// List models
// ListFoundationModels
// Service: Amazon Bedrock
// List of Bedrock foundation models that you can use. For more information, see Foundation models in the
// Bedrock User Guide.
//   Request Syntax
// GET /foundation-models?
//   byCustomizationType=byCustomizationType&byInferenceType=byInferenceType&byOutputModality=byOutputModality&byProvider=byProvider
//   HTTP/1.1
// URI Request Parameters
// The request uses the following URI parameters.
// byCustomizationType (p. 38)
// List by customization type.
//   Valid Values: FINE_TUNING
// byInferenceType (p. 38)
// List by inference type.
//   Valid Values: ON_DEMAND | PROVISIONED
// byOutputModality (p. 38)
// List by output modality type.
//   Valid Values: TEXT | IMAGE | EMBEDDING
// byProvider (p. 38)
// A Bedrock model provider.
//   Pattern: ^[a-z0-9-]{1,63}$
// Request Body
// The request does not have a request body

// Run inference on a text model
// Send an invoke request to run inference on a Titan Text G1 - Express model. We set the accept
// parameter to accept any content type in the response.
//   POST https://bedrock.us-east-1.amazonaws.com/model/amazon.titan-text-express-v1/invoke
//   -H accept: */*
// -H content-type: application/json
// Payload
// {"inputText": "Hello world"}
// Example response
// Response for the above request.
// -H content-type: application/json
// Payload
// <the model response>

const AMZ_REGION = "us-east-1";
const AMZ_HOST = "invoke-bedrock.us-east-1.amazonaws.com";

async function listModels() {
  const httpRequest = new HttpRequest({
    method: "GET",
    protocol: "https:",
    hostname: AMZ_HOST,
    path: "/foundation-models",
    headers: { ["Host"]: AMZ_HOST },
  });

  const signedRequest = await signRequest(httpRequest);
  const response = await axios.get(
    `https://${signedRequest.hostname}${signedRequest.path}`,
    { headers: signedRequest.headers }
  );
  console.log(response.data);
}

async function invokeModel() {
  const model = "anthropic.claude-v1";
  const httpRequest = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: AMZ_HOST,
    path: `/model/${model}/invoke`,
    headers: {
      ["Host"]: AMZ_HOST,
      ["accept"]: "*/*",
      ["content-type"]: "application/json",
    },
    body: JSON.stringify({
      temperature: 0.5,
      prompt: "\n\nHuman:Hello world\n\nAssistant:",
      max_tokens_to_sample: 10,
    }),
  });
  console.log("httpRequest", httpRequest);

  const signedRequest = await signRequest(httpRequest);
  const response = await axios.post(
    `https://${signedRequest.hostname}${signedRequest.path}`,
    signedRequest.body,
    { headers: signedRequest.headers }
  );
  console.log(response.status);
  console.log(response.headers);
  console.log(response.data);
  console.log("full url", response.request.res.responseUrl);
}

async function signRequest(request: HttpRequest) {
  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    region: AMZ_REGION,
    service: "bedrock",
  });
  return await signer.sign(request, { signingDate: new Date() });
}

// listModels();
// invokeModel();
