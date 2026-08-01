import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();

export const OWNER_UID = "owner";

export const ASSETS = ["btc", "tech", "ai", "china", "btc4h"] as const;
export type Asset = (typeof ASSETS)[number];
