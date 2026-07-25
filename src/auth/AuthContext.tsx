import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, signInWithCustomToken, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "../firebase";

interface AuthContextValue {
  ready: boolean;
  signedIn: boolean;
  error: string | null;
  loggingIn: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setSignedIn(!!user);
      setReady(true);
    });
  }, []);

  async function login(password: string) {
    setError(null);
    setLoggingIn(true);
    try {
      const loginCall = httpsCallable<{ password: string }, { token: string }>(
        functions,
        "login"
      );
      const result = await loginCall({ password });
      await signInWithCustomToken(auth, result.data.token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Login failed. Try again."
      );
      throw err;
    } finally {
      setLoggingIn(false);
    }
  }

  async function logout() {
    await signOut(auth);
  }

  return (
    <AuthContext.Provider
      value={{ ready, signedIn, error, loggingIn, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
