import type firebase from "firebase-admin";
import { config } from "../config";
import { getHttpAgents } from "./network";

let firebaseApp: firebase.app.App | undefined;

export async function initializeFirebase() {
  const firebase = await import("firebase-admin");
  const firebaseKey = Buffer.from(config.firebaseKey!, "base64").toString();
  const app = firebase.initializeApp({
    // RTDB doesn't actually seem to use this but respects `WS_PROXY` if set,
    // so we do that in the network module.
    httpAgent: getHttpAgents()[0],
    credential: firebase.credential.cert(JSON.parse(firebaseKey)),
    databaseURL: config.firebaseRtdbUrl,
  });

  await app.database().ref("connection-test").set(Date.now());

  firebaseApp = app;
}

export function getFirebaseApp(): firebase.app.App {
  if (!firebaseApp) {
    throw new Error("Firebase app not initialized.");
  }
  return firebaseApp;
}
