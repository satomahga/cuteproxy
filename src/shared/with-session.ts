import cookieParser from "cookie-parser";
import expressSession from "express-session";
import MemoryStore from "memorystore";
import { config, SECRET_SIGNING_KEY } from "../config";

const ONE_WEEK = 1000 * 60 * 60 * 24 * 7;

const cookieParserMiddleware = cookieParser(SECRET_SIGNING_KEY);

const sessionMiddleware = expressSession({
  secret: SECRET_SIGNING_KEY,
  resave: false,
  saveUninitialized: false,
  store: new (MemoryStore(expressSession))({ checkPeriod: ONE_WEEK }),
  cookie: {
    sameSite: "strict",
    maxAge: ONE_WEEK,
    signed: true,
    secure: !config.useInsecureCookies,
  },
});

const withSession = [cookieParserMiddleware, sessionMiddleware];

export { withSession };
