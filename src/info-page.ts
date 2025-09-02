/*  ──────────────────────────────────────────────────────────────
    Login-gated info page
    drop-in replacement for src/info-page.ts
    ──────────────────────────────────────────────────────────── */

import fs from "fs";
import express, { Router, Request, Response } from "express";
import showdown from "showdown";
import { config } from "./config";
import { buildInfo, ServiceInfo } from "./service-info";
import { getLastNImages } from "./shared/file-storage/image-history";
import { keyPool } from "./shared/key-management";
import { MODEL_FAMILY_SERVICE, ModelFamily } from "./shared/models";
import { withSession } from "./shared/with-session";
import { injectCsrfToken, checkCsrfToken } from "./shared/inject-csrf";
import { getUser } from "./shared/users/user-store";

/* ────────────────  TYPES: extend express-session  ──────────── */
declare module "express-session" {
  interface Session {
    infoPageAuthed?: boolean;
  }
}

/* ────────────────  misc constants  ─────────────────────────── */
const INFO_PAGE_TTL = 2_000; // ms
const LOGIN_ROUTE   = "/";

const MODEL_FAMILY_FRIENDLY_NAME: { [f in ModelFamily]: string } = {
  qwen: "Qwen",
  cohere: "Cohere",
  deepseek: "Deepseek",
  xai: "Grok",
  moonshot: "Moonshot",
  turbo: "GPT-4o Mini / 3.5 Turbo",
  gpt4: "GPT-4",
  "gpt4-32k": "GPT-4 32k",
  "gpt4-turbo": "GPT-4 Turbo",
  gpt4o: "GPT-4o",
  gpt41: "GPT-4.1",
  "gpt41-mini": "GPT-4.1 Mini",
  "gpt41-nano": "GPT-4.1 Nano",
  gpt5: "GPT-5",
  "gpt5-mini": "GPT-5 Mini",
  "gpt5-nano": "GPT-5 Nano",
  "gpt5-chat-latest": "GPT-5 Chat Latest",
  gpt45: "GPT-4.5",
  o1: "OpenAI o1",
  "o1-mini": "OpenAI o1 mini",
  "o1-pro": "OpenAI o1 pro",
  "o3-pro": "OpenAI o3 pro",
  "o3-mini": "OpenAI o3 mini",
  "o3": "OpenAI o3",
  "o4-mini": "OpenAI o4 mini",
  "codex-mini": "OpenAI Codex Mini",
  "dall-e": "DALL-E",
  "gpt-image": "GPT Image",
  claude: "Claude (Sonnet)",
  "claude-opus": "Claude (Opus)",
  "gemini-flash": "Gemini Flash",
  "gemini-pro": "Gemini Pro",
  "gemini-ultra": "Gemini Ultra",
  "mistral-tiny": "Mistral 7B",
  "mistral-small": "Mistral Nemo",
  "mistral-medium": "Mistral Medium",
  "mistral-large": "Mistral Large",
  "aws-claude": "AWS Claude (Sonnet)",
  "aws-claude-opus": "AWS Claude (Opus)",
  "aws-mistral-tiny": "AWS Mistral 7B",
  "aws-mistral-small": "AWS Mistral Nemo",
  "aws-mistral-medium": "AWS Mistral Medium",
  "aws-mistral-large": "AWS Mistral Large",
  "gcp-claude": "GCP Claude (Sonnet)",
  "gcp-claude-opus": "GCP Claude (Opus)",
  "azure-turbo": "Azure GPT-3.5 Turbo",
  "azure-gpt4": "Azure GPT-4",
  "azure-gpt4-32k": "Azure GPT-4 32k",
  "azure-gpt4-turbo": "Azure GPT-4 Turbo",
  "azure-gpt4o": "Azure GPT-4o",
  "azure-gpt45": "Azure GPT-4.5",
  "azure-gpt41": "Azure GPT-4.1",
  "azure-gpt41-mini": "Azure GPT-4.1 Mini",
  "azure-gpt41-nano": "Azure GPT-4.1 Nano",
  "azure-gpt5": "Azure GPT-5",
  "azure-gpt5-mini": "Azure GPT-5 Mini",
  "azure-gpt5-nano": "Azure GPT-5 Nano",
  "azure-gpt5-chat-latest": "Azure GPT-5 Chat Latest",
  "azure-o1": "Azure o1",
  "azure-o1-mini": "Azure o1 mini",
  "azure-o1-pro": "Azure o1 pro",
  "azure-o3-pro": "Azure o3 pro",
  "azure-o3-mini": "Azure o3 mini",
  "azure-o3": "Azure o3",
  "azure-o4-mini": "Azure o4 mini",
  "azure-codex-mini": "Azure Codex Mini",
  "azure-dall-e": "Azure DALL-E",
  "azure-gpt-image": "Azure GPT Image",
};


const converter = new showdown.Converter();

/* optional markdown greeting */
const customGreeting = fs.existsSync("greeting.md")
  ? `<div id="servergreeting">${fs.readFileSync("greeting.md", "utf8")}</div>`
  : "";

/* ────────────────  Login page  ──────────────────────── */
function renderLoginPage(csrf: string, error?: string) {
  const errBlock = error
    ? `<div class="error-message">${escapeHtml(error)}</div>`
    : "";
  const pageTitle = getServerTitle();
  return `<!DOCTYPE html>
<html>
<head>
  <title>${pageTitle} – Login</title>
  <style>
    body{font-family:Arial, sans-serif;display:flex;justify-content:center;
         align-items:center;height:100vh;margin:0;padding:20px;background:#f5f5f5;}
    .login-container{background:#fff;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,.1);
         padding:30px;width:100%;max-width:400px;text-align:center;}
    .logo-image{max-width:200px;margin-bottom:20px;}
    .form-group{margin-bottom:20px;}
    input[type=text], input[type=password]{width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;
         box-sizing:border-box;font-size:16px;}
    button{background:#4caf50;color:#fff;border:none;padding:12px 20px;border-radius:4px;
         cursor:pointer;font-size:16px;width:100%;}
    button:hover{background:#45a049;}
    .error-message{color:#f44336;margin-bottom:15px;}

    @media (prefers-color-scheme: dark) {
      body { background: #2c2c2c; color: #e0e0e0; }
      .login-container { background: #383838; box-shadow: 0 4px 12px rgba(0,0,0,0.4); border: 1px solid #4a4a4a; }
      input[type=text], input[type=password] { background: #4a4a4a; color: #e0e0e0; border: 1px solid #5a5a5a; }
      input[type=text]::placeholder, input[type=password]::placeholder { color: #999; }
      button { background: #007bff; } /* Using a blue for dark mode button */
      button:hover { background: #0056b3; }
      .error-message { color: #ff8a80; } /* Lighter red for errors in dark mode */
    }
  </style>
</head>
<body>
  <div class="login-container">
    ${config.loginImageUrl ? `<img src="${config.loginImageUrl}" alt="Logo" class="logo-image">` : ''}
    ${errBlock}
    <form method="POST" action="${LOGIN_ROUTE}">
      <div class="form-group">
        ${config.serviceInfoAuthMode === "password"
          ? `<input type="password" id="password" name="password" required placeholder="Service Password">`
          : `<input type="text" id="token" name="token" required placeholder="Your token">`}
        <input type="hidden" name="_csrf" value="${csrf}">
      </div>
      <button type="submit">Access Dashboard</button>
    </form>
  </div>
</body>
</html>`;
}

/* ────────────────  login-required middleware  ──────────────── */
function requireLogin(
  req: Request,
  res: Response,
  next: express.NextFunction
) {
  if (req.session?.infoPageAuthed) return next();
  return res.send(renderLoginPage(res.locals.csrfToken));
}

/* ────────────────  INFO PAGE CACHING  ──────────────────────── */
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

export function handleInfoPage(req: Request, res: Response) {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    return res.send(infoPageHtml);
  }

  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");

  const info = buildInfo(baseUrl + config.proxyEndpointRoute);
  infoPageHtml = renderPage(info);
  infoPageLastUpdated = Date.now();

  res.send(infoPageHtml);
}

/* ────────────────  RENDER FULL INFO PAGE  ──────────────────── */
export function renderPage(info: ServiceInfo) {
  const title = getServerTitle();
  const startTime = Date.now() - (process.uptime() * 1000); // Real server start time

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Comfortaa:wght@300;400;500;600;700&family=Poppins:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Poppins', sans-serif;
    background: linear-gradient(135deg, #fdf2f8 0%, #fce7f3 30%, #f8d7e3 60%, #f3c5d1 100%);
    min-height: 100vh;
    color: #7c2d5a;
    padding: 20px;
    line-height: 1.6;
    position: relative;
}

body::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: 
        radial-gradient(circle at 20% 80%, rgba(244, 114, 182, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(251, 113, 133, 0.06) 0%, transparent 50%),
        radial-gradient(circle at 40% 40%, rgba(249, 168, 212, 0.05) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    text-align: center;
}

.main-header {
    margin: 40px 0 30px 0;
}

.main-title {
    font-family: 'Silkscreen', monospace;
    font-size: 5.5rem;
    font-weight: 700;
    color: #ec4899;
    text-shadow: 3px 3px 6px rgba(236, 72, 153, 0.3), 0 0 30px rgba(244, 114, 182, 0.4);
    margin-bottom: 20px;
    letter-spacing: 4px;
    background: linear-gradient(135deg, #ec4899 0%, #f472b6 50%, #f9a8d4 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 20px;
}

.title-icon {
    width: 80px;
    height: 80px;
    object-fit: contain;
    filter: drop-shadow(2px 2px 4px rgba(236, 72, 153, 0.3));
}

.subtitle {
    font-family: 'Comfortaa', cursive;
    font-size: 1.8rem;
    font-weight: 600;
    color: #be185d;
    margin-bottom: 30px;
    text-shadow: 1px 1px 3px rgba(190, 24, 93, 0.2);
    letter-spacing: 1px;
}

.uptime-section {
    margin: 30px 0;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 60px;
}

.uptime-content {
    display: flex;
    flex-direction: column;
    align-items: center;
}

.uptime-title {
    font-family: 'Space Mono', monospace;
    font-size: 1.2rem;
    color: #be185d;
    margin-bottom: 10px;
    font-weight: 600;
    letter-spacing: 1px;
}

.uptime-counter {
    font-family: 'Space Mono', monospace;
    font-size: 2.2rem;
    color: #ec4899;
    font-weight: 700;
    letter-spacing: 2px;
    text-shadow: 1px 1px 3px rgba(236, 72, 153, 0.2);
}

.uptime-unicorn-left {
    width: 180px;
    height: 180px;
    object-fit: contain;
    filter: drop-shadow(2px 2px 6px rgba(236, 72, 153, 0.2));
    animation: floatLeft 4s ease-in-out infinite;
    margin-top: 40px;
}

.uptime-unicorn-right {
    width: 180px;
    height: 180px;
    object-fit: contain;
    filter: drop-shadow(2px 2px 6px rgba(236, 72, 153, 0.2));
    animation: floatRight 4s ease-in-out infinite;
    margin-top: 40px;
}

@keyframes floatLeft {
    0%, 100% { transform: translateY(0px) rotate(-1deg); }
    50% { transform: translateY(-8px) rotate(1deg); }
}

@keyframes floatRight {
    0%, 100% { transform: translateY(0px) rotate(1deg); }
    50% { transform: translateY(-8px) rotate(-1deg); }
}

.header-telegram-link {
    display: inline-block;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(249, 168, 212, 0.3) 100%);
    border-radius: 30px;
    padding: 15px 30px;
    text-decoration: none;
    color: #be185d;
    font-family: 'Comfortaa', cursive;
    font-size: 1.1rem;
    font-weight: 600;
    margin: 20px 0 40px 0;
    transition: all 0.3s ease;
    border: 2px solid rgba(244, 114, 182, 0.4);
    box-shadow: 0 8px 25px rgba(244, 114, 182, 0.15);
}

.header-telegram-link:hover {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.5) 100%);
    transform: translateY(-3px);
    box-shadow: 0 12px 35px rgba(244, 114, 182, 0.25);
    border-color: rgba(244, 114, 182, 0.6);
}

.self-service-links {
    display: flex;
    justify-content: center;
    margin: 30px 0;
    padding: 0.5em;
    font-size: 1rem;
}

.self-service-links a {
    display: inline-block;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(249, 168, 212, 0.3) 100%);
    border-radius: 25px;
    padding: 12px 25px;
    text-decoration: none;
    color: #be185d;
    font-family: 'Poppins', sans-serif;
    font-weight: 600;
    margin: 0 10px;
    transition: all 0.3s ease;
    border: 2px solid rgba(244, 114, 182, 0.4);
    box-shadow: 0 6px 20px rgba(244, 114, 182, 0.15);
}

.self-service-links a:hover {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.5) 100%);
    transform: translateY(-2px);
    box-shadow: 0 10px 30px rgba(244, 114, 182, 0.25);
    border-color: rgba(244, 114, 182, 0.6);
}

.user-token-section {
    margin: 30px 0;
    text-align: center;
}

.user-token-link {
    display: inline-block;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(249, 168, 212, 0.3) 100%);
    border-radius: 25px;
    padding: 12px 25px;
    text-decoration: none;
    color: #be185d;
    font-family: 'Poppins', sans-serif;
    font-size: 1rem;
    font-weight: 600;
    transition: all 0.3s ease;
    border: 2px solid rgba(244, 114, 182, 0.4);
    box-shadow: 0 6px 20px rgba(244, 114, 182, 0.15);
}

.user-token-link:hover {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.5) 100%);
    transform: translateY(-2px);
    box-shadow: 0 10px 30px rgba(244, 114, 182, 0.25);
    border-color: rgba(244, 114, 182, 0.6);
}

.endpoints-section {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(251, 113, 133, 0.08) 100%);
    border-radius: 30px;
    padding: 40px;
    margin: 50px 0;
    backdrop-filter: blur(15px);
    border: 2px solid rgba(244, 114, 182, 0.25);
    box-shadow: 0 15px 45px rgba(244, 114, 182, 0.1);
}

.endpoints-title {
    font-family: 'Poppins', sans-serif;
    font-size: 2.5rem;
    font-weight: 700;
    color: #ec4899;
    margin-bottom: 35px;
    letter-spacing: 2px;
    text-shadow: 1px 1px 3px rgba(236, 72, 153, 0.2);
}

.endpoint-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 30px;
    margin-bottom: 20px;
}

.endpoint-card {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.15) 100%);
    border-radius: 20px;
    padding: 30px;
    border: 2px solid rgba(244, 114, 182, 0.3);
    transition: all 0.3s ease;
    cursor: pointer;
    box-shadow: 0 8px 25px rgba(244, 114, 182, 0.1);
}

.endpoint-card:hover {
    box-shadow: 0 20px 50px rgba(244, 114, 182, 0.3);
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.7) 0%, rgba(249, 168, 212, 0.25) 100%);
    border-color: rgba(244, 114, 182, 0.5);
}

.endpoint-name {
    font-family: 'Poppins', sans-serif;
    font-size: 1.4rem;
    color: #be185d;
    font-weight: 700;
    margin-bottom: 10px;
}

.endpoint-url {
    color: #a8336b;
    font-size: 0.9rem;
    margin-bottom: 15px;
    word-break: break-all;
    font-family: 'Space Mono', monospace;
}

.endpoint-status {
    color: #22c55e;
    font-size: 1rem;
    font-weight: 600;
}

.endpoint-models {
    margin-top: 25px;
    padding-top: 25px;
    border-top: 2px solid rgba(244, 114, 182, 0.2);
    display: none;
    transition: all 0.4s ease;
}

.endpoint-card.expanded .endpoint-models {
    display: block;
    animation: fadeIn 0.4s ease;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(-15px); }
    to { opacity: 1; transform: translateY(0); }
}

.model-item {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.9) 0%, rgba(254, 240, 247, 0.8) 50%, rgba(253, 229, 240, 0.6) 100%);
    border-radius: 12px;
    padding: 12px 18px;
    margin: 8px 0;
    font-size: 0.9rem;
    color: #7c2d5a;
    font-weight: 500;
    border: 1px solid rgba(244, 114, 182, 0.25);
    font-family: 'Space Mono', monospace;
    transition: all 0.2s ease;
}

.model-item:hover {
    background: linear-gradient(135deg, rgba(255, 255, 255, 1) 0%, rgba(254, 240, 247, 0.9) 50%, rgba(253, 229, 240, 0.8) 100%);
    box-shadow: 0 4px 12px rgba(244, 114, 182, 0.15);
    transform: translateY(-1px);
}

.active-keys-section {
    margin: 50px 0;
}

.provider-card {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(236, 72, 153, 0.06) 100%);
    border-radius: 30px;
    padding: 35px;
    margin: 30px 0;
    backdrop-filter: blur(15px);
    border: 2px solid rgba(244, 114, 182, 0.25);
    box-shadow: 0 12px 35px rgba(244, 114, 182, 0.1);
}

.provider-title {
    font-family: 'Poppins', sans-serif;
    font-size: 1.8rem;
    font-weight: 700;
    color: #be185d;
    margin-bottom: 25px;
    text-transform: uppercase;
    letter-spacing: 2px;
}

.key-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 20px;
}

.key-stat {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.2) 100%);
    border-radius: 18px;
    padding: 20px;
    border: 2px solid rgba(244, 114, 182, 0.2);
    transition: all 0.3s ease;
}

.key-stat:hover {
    box-shadow: 0 10px 30px rgba(244, 114, 182, 0.15);
}

.stat-label {
    font-family: 'Poppins', sans-serif;
    font-size: 0.9rem;
    color: #be185d;
    margin-bottom: 10px;
    font-weight: 600;
}

.stat-value {
    font-family: 'Space Mono', monospace;
    font-size: 1.5rem;
    font-weight: 700;
    color: #ec4899;
    letter-spacing: 1px;
}

.max-output-section {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(249, 168, 212, 0.08) 100%);
    border-radius: 30px;
    padding: 40px;
    margin: 50px 0;
    backdrop-filter: blur(15px);
    border: 2px solid rgba(244, 114, 182, 0.25);
    box-shadow: 0 15px 45px rgba(244, 114, 182, 0.1);
}

.max-output-title {
    font-family: 'Poppins', sans-serif;
    font-size: 2.5rem;
    font-weight: 700;
    color: #ec4899;
    margin-bottom: 35px;
    letter-spacing: 2px;
    text-shadow: 1px 1px 3px rgba(236, 72, 153, 0.2);
}

.token-limits {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 30px;
}

.token-limit {
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(249, 168, 212, 0.2) 100%);
    border-radius: 20px;
    padding: 30px;
    border: 2px solid rgba(244, 114, 182, 0.2);
    transition: all 0.3s ease;
}

.token-limit:hover {
    box-shadow: 0 12px 35px rgba(244, 114, 182, 0.15);
}

.token-type {
    font-family: 'Poppins', sans-serif;
    font-size: 1rem;
    color: #be185d;
    margin-bottom: 15px;
    font-weight: 600;
}

.token-value {
    font-family: 'Space Mono', monospace;
    font-size: 1.8rem;
    font-weight: 700;
    color: #ec4899;
    letter-spacing: 1px;
}

.footer {
    margin-top: 50px;
    padding: 30px 0;
    text-align: center;
}

.footer-image {
    max-width: 400px;
    width: 100%;
    border-radius: 25px;
    box-shadow: 0 15px 40px rgba(244, 114, 182, 0.25);
    transition: transform 0.4s ease;
    border: 3px solid rgba(244, 114, 182, 0.3);
}

.footer-image:hover {
    transform: scale(1.05);
    box-shadow: 0 20px 50px rgba(244, 114, 182, 0.35);
}

@media (max-width: 768px) {
    .main-title {
        font-size: 4rem;
        flex-direction: column;
        gap: 15px;
    }
    
    .title-icon {
        width: 60px;
        height: 60px;
    }
    
    .subtitle {
        font-size: 1.4rem;
    }
    
    .uptime-section {
        flex-direction: column;
        gap: 30px;
    }
    
    .uptime-counter {
        font-size: 2rem;
    }
    
    .uptime-unicorn-left, .uptime-unicorn-right {
        width: 120px;
        height: 120px;
    }
    
    .container {
        padding: 0 10px;
    }
    
    .endpoint-grid {
        grid-template-columns: 1fr;
    }
    
    .key-stats {
        grid-template-columns: repeat(2, 1fr);
    }
    
    .token-limits {
        grid-template-columns: 1fr;
    }
    
    .footer-image {
        max-width: 300px;
    }
}

@media (max-width: 480px) {
    .main-title {
        font-size: 3rem;
        flex-direction: column;
        gap: 10px;
    }
    
    .title-icon {
        width: 50px;
        height: 50px;
    }
    
    .uptime-counter {
        font-size: 1.8rem;
    }
    
    .uptime-unicorn-left, .uptime-unicorn-right {
        width: 100px;
        height: 100px;
    }
    
    .key-stats {
        grid-template-columns: 1fr;
    }
    
    .footer-image {
        max-width: 250px;
    }
}
  </style>
</head>
<body>
  <div class="container">
    <!-- Main Header -->
    <div class="main-header">
      <h1 class="main-title">
        CUTE PROXY
        <img src="https://files.catbox.moe/n9xw5g.png" alt="Cute Icon" class="title-icon">
      </h1>
      <p class="subtitle">твоя милая прокси ^.^</p>
    </div>

    <!-- Uptime Section -->
    <div class="uptime-section">
      <img src="https://files.catbox.moe/frc1hf.png" alt="Left Unicorn" class="uptime-unicorn-left">
      <div class="uptime-content">
        <h2 class="uptime-title">UPTIME</h2>
        <div class="uptime-counter" id="uptime">00:00:00</div>
      </div>
      <img src="https://files.catbox.moe/w1dmqj.png" alt="Right Unicorn" class="uptime-unicorn-right">
    </div>

    <!-- Header Telegram Link -->
    <a href="https://t.me/cuteproxy" class="header-telegram-link" target="_blank">
      💬 Наш телеграм <3
    </a>

    <!-- Self-service links -->
    ${getSelfServiceLinks()}

    <!-- Endpoints Section -->
    <div class="endpoints-section">
      <h2 class="endpoints-title">Endpoints</h2>
      <div class="endpoint-grid">
        ${buildEndpointCards(info)}
      </div>
    </div>

    <!-- Active Keys Section -->
    <div class="active-keys-section">
      ${buildActiveKeysSection(info)}
    </div>

    <!-- Max Output Section -->
    <div class="max-output-section">
      <h2 class="max-output-title">Max Output</h2>
      <div class="token-limits">
        ${buildTokenLimits(info)}
      </div>
    </div>

    <!-- Footer with large image -->
    <div class="footer">
      <img src="https://files.catbox.moe/9q6nlj.png" alt="Cute Proxy Mascot" class="footer-image">
    </div>
  </div>

  <script>
    // Real-time uptime counter using server start time
    const serverStartTime = ${startTime};
    
    function updateUptime() {
      const now = Date.now();
      const uptime = Math.floor((now - serverStartTime) / 1000);
      
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = uptime % 60;
      
      let formattedTime = '';
      if (days > 0) {
        formattedTime = days + 'd ' + String(hours).padStart(2, '0') + ':' + 
                       String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
      } else {
        formattedTime = String(hours).padStart(2, '0') + ':' + 
                       String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
      }
      
      document.getElementById('uptime').textContent = formattedTime;
    }

    // Toggle endpoint expansion
    function toggleEndpoint(card) {
      card.classList.toggle('expanded');
    }

    // Update uptime every second
    setInterval(updateUptime, 1000);
    updateUptime(); // Initialize immediately

    // Add cute animations
    document.addEventListener('DOMContentLoaded', function() {
      
      const title = document.querySelector('.main-title');
      if (title) {
        title.addEventListener('mouseover', function() {
          this.style.textShadow = '3px 3px 6px rgba(236, 72, 153, 0.3), 0 0 40px rgba(244, 114, 182, 0.6)';
        });
        
        title.addEventListener('mouseout', function() {
          this.style.textShadow = '3px 3px 6px rgba(236, 72, 153, 0.3), 0 0 30px rgba(244, 114, 182, 0.4)';
        });
      }
    });
  </script>
</body>
</html>`;
}

/* ────────────────  DYNAMIC CONTENT FUNCTIONS  ──────────────── */
function buildEndpointCards(info: ServiceInfo): string {
  const endpointMappings = [
    { 
      name: "Google AI", 
      urlPath: "/google-ai", 
      modelFamilies: ["gemini-pro", "gemini-flash", "gemini-ultra"],
      fallbackModels: [
        "gemini-2.5-pro",
        "gemini-2.5-pro-preview-06-05", 
        "gemini-2.5-flash",
        "gemini-2.5-flash-preview-05-20",
        "gemini-2.5-flash-lite"
      ]
    },
    { 
      name: "Mistral AI", 
      urlPath: "/mistral-ai", 
      modelFamilies: ["mistral-tiny", "mistral-small", "mistral-medium", "mistral-large"],
      fallbackModels: [
        "open-mistral-nemo", "open-mistral-7b", "open-mixtral-8x7b", "open-mixtral-8x22b",
        "open-codestral-mamba", "ministral-3b-latest", "ministral-8b-latest", 
        "mistral-tiny-latest", "mistral-small-latest", "mistral-medium-latest", 
        "mistral-large-latest", "mistral-saba-latest", "codestral-latest",
        "codestral-mamba-latest", "pixtral-12b-latest", "pixtral-large-latest",
        "devstral-small-latest", "magistral-small-latest", "magistral-medium-latest"
      ]
    },
    { 
      name: "Deepseek", 
      urlPath: "/deepseek", 
      modelFamilies: ["deepseek"],
      fallbackModels: ["deepseek-reasoner", "deepseek-chat"]
    },
    { 
      name: "XAI", 
      urlPath: "/xai", 
      modelFamilies: ["xai"],
      fallbackModels: ["grok-3", "grok-3-mini", "grok-4"]
    }
  ];

  const baseUrl = config.proxyEndpointRoute || '';

  return endpointMappings.map(endpoint => {
    // Get real models from config or use fallback
    let availableModels = endpoint.fallbackModels;
    
    if (config.allowedModelFamilies) {
      const relevantFamilies = config.allowedModelFamilies.filter(family => 
        endpoint.modelFamilies.some(ef => family.includes(ef) || ef.includes(family))
      );
      if (relevantFamilies.length > 0) {
        availableModels = relevantFamilies;
      }
    }

    // Get queue time from info if available
    const queueTime = endpoint.modelFamilies
      .map(family => (info as any)[family]?.estimatedQueueTime)
      .find(time => time) || "no wait";

    return `
      <div class="endpoint-card" onclick="toggleEndpoint(this)">
        <div class="endpoint-name">${endpoint.name}</div>
        <div class="endpoint-url">${baseUrl}${endpoint.urlPath}</div>
        <div class="endpoint-status">${queueTime}</div>
        <div class="endpoint-models">
          <strong>Available Models:</strong>
          ${availableModels.map(model => `<div class="model-item">${model}</div>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function buildActiveKeysSection(info: ServiceInfo): string {
  const providers = [
    { name: "Google AI", services: ["google", "googleai", "gemini"] },
    { name: "Mistral AI", services: ["mistral", "mistralai"] },
    { name: "Deepseek", services: ["deepseek"] },
    { name: "XAI", services: ["xai", "grok"] }
  ];
  
  return providers.map(provider => {
    const providerKeys = keyPool.list().filter(key => {
      const service = (key.service || '').toLowerCase();
      return provider.services.some(s => service.includes(s));
    });

    // Use safe property access
    const activeKeys = providerKeys.filter(k => !(k as any).isDisabled && !(k as any).isRevoked).length;
    const revokedKeys = providerKeys.filter(k => (k as any).isRevoked).length;
    const queueKeys = providerKeys.filter(k => (k as any).isDisabled && !(k as any).isRevoked).length;
    const totalTokens = providerKeys.reduce((sum, k) => sum + ((k as any).promptCount || (k as any).usage || 0), 0);

    // Format total tokens
    const formatTokens = (tokens: number) => {
      if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
      if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
      return tokens.toString();
    };

    return `
      <div class="provider-card">
        <h3 class="provider-title">${provider.name}</h3>
        <div class="key-stats">
          <div class="key-stat">
            <div class="stat-label">Active Keys</div>
            <div class="stat-value">${activeKeys}</div>
          </div>
          <div class="key-stat">
            <div class="stat-label">Revoked</div>
            <div class="stat-value">${revokedKeys}</div>
          </div>
          <div class="key-stat">
            <div class="stat-label">In Queue</div>
            <div class="stat-value">${queueKeys}</div>
          </div>
          <div class="key-stat">
            <div class="stat-label">Total Tokens</div>
            <div class="stat-value">${formatTokens(totalTokens)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function buildTokenLimits(info: ServiceInfo): string {
  // Try to get real config values or use fallbacks
  const maxContextOpenAI = (config as any).maxContextTokensOpenAI || (config as any).maxContextTokens || 65536;
  const maxContextAnthropic = (config as any).maxContextTokensAnthropic || (config as any).maxContextTokens || 32768;
  const maxOutputOpenAI = (config as any).maxOutputTokensOpenAI || (config as any).maxOutputTokens || 8192;
  const maxOutputAnthropic = (config as any).maxOutputTokensAnthropic || (config as any).maxOutputTokens || 1024;

  return `
    <div class="token-limit">
      <div class="token-type">Max Context Tokens OpenAI</div>
      <div class="token-value">${maxContextOpenAI.toLocaleString()}</div>
    </div>
    <div class="token-limit">
      <div class="token-type">Max Context Tokens Anthropic</div>
      <div class="token-value">${maxContextAnthropic.toLocaleString()}</div>
    </div>
    <div class="token-limit">
      <div class="token-type">Max Output Tokens OpenAI</div>
      <div class="token-value">${maxOutputOpenAI.toLocaleString()}</div>
    </div>
    <div class="token-limit">
      <div class="token-type">Max Output Tokens Anthropic</div>
      <div class="token-value">${maxOutputAnthropic.toLocaleString()}</div>
    </div>
  `;
}

/* ────────────────  ORIGINAL HELPER FUNCTIONS  ──────────────── */
function buildInfoPageHeader(info: ServiceInfo) {
  const title = getServerTitle();
  let infoBody = `# ${title}`;

  if (config.staticServiceInfo) {
    return converter.makeHtml(infoBody + customGreeting);
  }

  const waits: string[] = [];

  for (const modelFamily of config.allowedModelFamilies) {
    const service = MODEL_FAMILY_SERVICE[modelFamily];

    const hasKeys = keyPool.list().some(
      (k) => k.service === service && k.modelFamilies.includes(modelFamily)
    );

    const wait = info[modelFamily]?.estimatedQueueTime;
    if (hasKeys && wait) {
      waits.push(
        `**${MODEL_FAMILY_FRIENDLY_NAME[modelFamily] || modelFamily}**: ${wait}`
      );
    }
  }

  infoBody += "\n\n" + waits.join(" / ");
  infoBody += customGreeting;
  infoBody += buildRecentImageSection();

  return converter.makeHtml(infoBody);
}

function getSelfServiceLinks() {
  if (config.gatekeeper !== "user_token") return "";
  const links = [["Проверить свой токен", "/user/lookup"]];
  if (config.captchaMode !== "none") {
    links.unshift(["Запросить токен", "/user/captcha"]);
  }
  return `<div class="self-service-links">${links
    .map(([t, l]) => `<a href="${l}">${t}</a>`)
    .join(" | ")}</div>`;
}

function getServerTitle() {
  if (process.env.SERVER_TITLE) return process.env.SERVER_TITLE;
  if (process.env.SPACE_ID)
    return `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`;
  if (process.env.RENDER)
    return `Render / ${process.env.RENDER_SERVICE_NAME}`;
  return "Tunnel";
}

function buildRecentImageSection() {
  const imageModels: ModelFamily[] = [
    "azure-dall-e",
    "dall-e",
    "gpt-image",
    "azure-gpt-image",
  ];
  // Condition 1: Is the feature enabled via config?
  // Condition 2: Is at least one relevant image model family allowed in config?
  if (
    !config.showRecentImages ||
    imageModels.every((f) => !config.allowedModelFamilies.includes(f))
  ) {
    return ""; // Exit if feature is disabled or no relevant models are allowed
  }

  // Condition 3: Are there any actual images to display?
  const recentImages = getLastNImages(12).reverse();
  if (recentImages.length === 0) {
    // If the feature is enabled and models are allowed, but no images exist,
    // do not render the section, including its title.
    return "";
  }

  // If all conditions pass (feature enabled, models allowed, images exist), build and return the HTML
  let html = `<h2>Recent Image Generations</h2>`;
  html += `<div style="display:flex;flex-wrap:wrap;" id="recent-images">`;
  for (const { url, prompt } of recentImages) {
    const thumbUrl = url.replace(/\.png$/, "_t.jpg");
    const escapedPrompt = escapeHtml(prompt);
    html += `<div style="margin:0.5em" class="recent-image">
<a href="${url}" target="_blank"><img src="${thumbUrl}" title="${escapedPrompt}"
 alt="${escapedPrompt}" style="max-width:150px;max-height:150px;"/></a></div>`;
  }
  html += `</div><p style="clear:both;text-align:center;">
<a href="/user/image-history">View all recent images</a></p>`;
  return html;
}

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\[/g, "&#91;")
    .replace(/]/g, "&#93;");
}

function getExternalUrlForHuggingfaceSpaceId(spaceId: string) {
  try {
    const [u, s] = spaceId.split("/");
    return `https://${u}-${s.replace(/_/g, "-")}.hf.space`;
  } catch {
    return "";
  }
}

/* ────────────────  ROUTER  ─────────────────────────────────── */
const infoPageRouter = Router();

infoPageRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" }),
  withSession,
  injectCsrfToken,
  checkCsrfToken
);

/* login attempt */
infoPageRouter.post(LOGIN_ROUTE, (req, res) => {
  if (config.serviceInfoAuthMode === "password") {
    const password = (req.body.password || "").trim();
    // Simple string comparison; for production, consider a timing-safe comparison library
    if (config.serviceInfoPassword && password === config.serviceInfoPassword) {
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else {
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid password. Please try again."));
    }
  } else {
    // Token-based authentication (using any valid user token)
    const token = (req.body.token || "").trim();
    const user = getUser(token); // returns undefined if invalid
    if (user && !user.disabledAt) {
      // Only allow access if user exists AND is not disabled
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else if (user && user.disabledAt) {
      // User exists but is disabled
      const reason = user.disabledReason || "Your account has been disabled";
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, `Access denied: ${reason}`));
    } else {
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid token. Please try again."));
    }
  }
});

/* GET /  – either login form or info page */
if (config.enableInfoPageLogin) {
  infoPageRouter.get(LOGIN_ROUTE, requireLogin, handleInfoPage);
} else {
  infoPageRouter.get(LOGIN_ROUTE, handleInfoPage);
}

/*  ─── Removed the public /status route :  simply not added ─── */

export { infoPageRouter };
