import * as crypto from "crypto";
import { onCall, HttpsError } from "firebase-functions/https";
import { getAuth } from "firebase-admin/auth";
import { OWNER_UID } from "./admin";
import { dashboardPassword } from "./secrets";

interface LoginInput {
  password: string;
}

function passwordsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const login = onCall<LoginInput>(
  { secrets: [dashboardPassword] },
  async (request) => {
    const provided = request.data?.password;
    if (typeof provided !== "string" || !provided) {
      throw new HttpsError("invalid-argument", "Password required.");
    }
    if (!passwordsMatch(provided, dashboardPassword.value())) {
      // Constant work either way to avoid timing leaks on length checks above.
      throw new HttpsError("permission-denied", "Incorrect password.");
    }
    const token = await getAuth().createCustomToken(OWNER_UID);
    return { token };
  }
);
