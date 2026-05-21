import React, { useEffect, useState } from "react";
import {
  Cloud,
  AlertTriangle,
  ClipboardPaste,
  LogOut,
  Mail,
  RefreshCw,
} from "lucide-react";
import {
  bambuAuth,
  BambuAuthApiError,
  BambuAuthStatus,
} from "../../services/custom-bambu/auth";

// Fork-only: Bambu Cloud sign-in panel. Drives the four observable
// states described in the design doc (signed_out / code_sent /
// signed_in / expired). No global auth-state store — this component
// refetches /api/makerworld/auth/status on mount and after every
// state-changing action. The URL-import modal does its own status
// check on action; both consumers are independent.

type Phase = "loading" | "signed_out" | "code_sent" | "signed_in" | "expired";

const formatExpiry = (ms: number | null): string => {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
};

const CloudSettings: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<BambuAuthStatus | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Alternative sign-in for users on Bambu social login (no email/password):
  // paste an access token captured from the browser DevTools.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteToken, setPasteToken] = useState("");
  const [pasteRefresh, setPasteRefresh] = useState("");
  const [pasteEmail, setPasteEmail] = useState("");

  const refreshStatus = async () => {
    try {
      const s = await bambuAuth.getStatus();
      setStatus(s);
      if (!s.signedIn) {
        setPhase((prev) => (prev === "code_sent" ? "code_sent" : "signed_out"));
      } else if (s.expired) {
        setPhase("expired");
      } else {
        setPhase("signed_in");
      }
    } catch (e) {
      setError(
        e instanceof BambuAuthApiError ? e.message : "Failed to load status",
      );
      setPhase("signed_out");
    }
  };

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bambuAuth.sendCode(email);
      setPhase("code_sent");
    } catch (e) {
      if (e instanceof BambuAuthApiError && e.status === 400) {
        setError(
          `${e.message}\n\nBambu Cloud rate-limits sign-in. Wait ~10 minutes and try again.`,
        );
      } else {
        setError(e instanceof Error ? e.message : "Send-code failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !code || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bambuAuth.login(email, code);
      setCode("");
      await refreshStatus();
    } catch (e) {
      if (e instanceof BambuAuthApiError) {
        setError(`${e.message}\n\nCode didn't work — request a new one and try again.`);
      } else {
        setError(e instanceof Error ? e.message : "Sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePasteToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteToken.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bambuAuth.pasteToken({
        accessToken: pasteToken.trim(),
        refreshToken: pasteRefresh.trim() || undefined,
        accountEmail: pasteEmail.trim() || undefined,
      });
      setPasteToken("");
      setPasteRefresh("");
      setPasteEmail("");
      setPasteOpen(false);
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Paste-token failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await bambuAuth.signOut();
      setEmail("");
      setCode("");
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-out failed");
    } finally {
      setBusy(false);
    }
  };

  const handleUseDifferentEmail = () => {
    setCode("");
    setError(null);
    setPhase("signed_out");
  };

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Cloud className="w-5 h-5 text-blue-400" />
        <h3 className="text-lg font-semibold text-white">Bambu Cloud</h3>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        Sign in with your Bambu Lab account to download Makerworld print
        profiles. Your access token is stored in <code>data.db</code> on this
        server alongside the email address you sign in with — treat that
        file as sensitive. Tokens expire after ~3 months; you'll need to
        sign in again then.
      </p>

      {phase === "loading" && (
        <div className="p-4 bg-vault-800 rounded-lg border border-vault-700 text-sm text-slate-400">
          Loading sign-in status…
        </div>
      )}

      {phase === "expired" && (
        <div className="mb-4 p-4 bg-red-900/30 border border-red-700/50 rounded-lg flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-200">
            <p className="font-semibold mb-1">Bambu Cloud sign-in expired</p>
            <p className="text-red-300/90">
              Your access token has expired. Sign in again to keep importing
              from Makerworld.
            </p>
          </div>
        </div>
      )}

      {(phase === "signed_out" || phase === "expired") && (
        <>
          <form onSubmit={handleSendCode} className="space-y-3">
            <label className="block text-sm font-medium text-slate-400">
              Bambu account email
            </label>
            <input
              type="email"
              required
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none placeholder:text-slate-600"
            />
            <button
              type="submit"
              disabled={busy || !email}
              className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <Mail className="w-4 h-4" />
              Send verification code
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-vault-700">
            <button
              type="button"
              onClick={() => setPasteOpen((v) => !v)}
              className="text-sm text-slate-400 hover:text-slate-200 inline-flex items-center gap-2 transition-colors"
            >
              <ClipboardPaste className="w-4 h-4" />
              {pasteOpen
                ? "Hide paste-token option"
                : "Use social login? Paste an access token instead"}
            </button>

            {pasteOpen && (
              <form onSubmit={handlePasteToken} className="mt-4 space-y-3">
                <div className="p-3 bg-vault-800 rounded-lg border border-vault-700 text-xs text-slate-400 leading-relaxed">
                  <p className="font-semibold text-slate-300 mb-1">
                    For Bambu accounts using Google / Apple / other social
                    login
                  </p>
                  <p>
                    1. Sign into{" "}
                    <a
                      href="https://bambulab.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 hover:underline"
                    >
                      bambulab.com
                    </a>{" "}
                    in another tab.
                    <br />
                    2. Open DevTools → Application → Cookies → look for{" "}
                    <code>token</code> (or check Network for an{" "}
                    <code>Authorization: Bearer …</code> header on a request
                    to <code>api.bambulab.com</code>).
                    <br />
                    3. Paste the value below. The expiry is read from the JWT
                    automatically.
                  </p>
                </div>
                <label className="block text-sm font-medium text-slate-400">
                  Access token (required)
                </label>
                <textarea
                  required
                  disabled={busy}
                  value={pasteToken}
                  onChange={(e) => setPasteToken(e.target.value)}
                  placeholder="eyJhbGciOi..."
                  rows={3}
                  className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none placeholder:text-slate-600 font-mono text-xs"
                />
                <label className="block text-sm font-medium text-slate-400">
                  Refresh token (optional — paste if you have it)
                </label>
                <textarea
                  disabled={busy}
                  value={pasteRefresh}
                  onChange={(e) => setPasteRefresh(e.target.value)}
                  placeholder="(leave blank if you only have the access token)"
                  rows={2}
                  className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none placeholder:text-slate-600 font-mono text-xs"
                />
                <label className="block text-sm font-medium text-slate-400">
                  Account email (optional — just for display)
                </label>
                <input
                  type="email"
                  disabled={busy}
                  value={pasteEmail}
                  onChange={(e) => setPasteEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none placeholder:text-slate-600"
                />
                <button
                  type="submit"
                  disabled={busy || !pasteToken.trim()}
                  className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  <ClipboardPaste className="w-4 h-4" />
                  Save token
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {phase === "code_sent" && (
        <form onSubmit={handleLogin} className="space-y-3">
          <p className="text-sm text-slate-400">
            Code sent to <span className="text-white font-medium">{email}</span>
            . Check your inbox.
          </p>
          <label className="block text-sm font-medium text-slate-400">
            6-digit verification code
          </label>
          <input
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{4,8}"
            disabled={busy}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="w-full bg-vault-900 border border-vault-700 rounded-md px-3 py-2 text-white focus:border-indigo-500 outline-none placeholder:text-slate-600 tracking-widest"
          />
          <div className="flex gap-3 flex-wrap">
            <button
              type="submit"
              disabled={busy || !code}
              className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Verify & sign in
            </button>
            <button
              type="button"
              onClick={handleUseDifferentEmail}
              disabled={busy}
              className="py-2 px-4 rounded-lg bg-vault-700 hover:bg-vault-600 text-slate-200 font-medium transition-colors"
            >
              Didn't receive a code? Use a different email
            </button>
          </div>
        </form>
      )}

      {phase === "signed_in" && status && (
        <div className="p-4 bg-vault-800 rounded-lg border border-vault-700 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-400">Signed in as</p>
              <p className="text-white font-medium">{status.signedInAs || "—"}</p>
              <p className="text-xs text-slate-500 mt-1">
                Token expires {formatExpiry(status.accessExpiresAt)}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void refreshStatus()}
                disabled={busy}
                className="p-2 rounded-lg bg-vault-700 hover:bg-vault-600 text-slate-300"
                aria-label="Refresh status"
                title="Refresh status"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={() => void handleSignOut()}
                disabled={busy}
                className="py-2 px-3 rounded-lg bg-vault-700 hover:bg-red-900/40 text-slate-200 hover:text-red-200 font-medium transition-colors inline-flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-sm text-red-200 whitespace-pre-line">
          {error}
        </div>
      )}
    </div>
  );
};

export default CloudSettings;
