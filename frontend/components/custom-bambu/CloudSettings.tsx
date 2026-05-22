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

  const inputCls =
    "w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-fg outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15 transition-all placeholder:text-fg-3";
  const labelCls = "block text-[12.5px] font-medium text-fg-2 mb-1.5";
  const primaryBtnCls =
    "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent text-accent-fg text-[13px] font-semibold hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed";
  const secondaryBtnCls =
    "inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-[13px] text-fg-2 transition-colors disabled:opacity-50";

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Cloud className="w-4 h-4 text-accent" />
        <h4 className="text-[14px] font-semibold text-fg m-0">Bambu Cloud</h4>
      </div>
      <p className="text-[13px] text-fg-3 mb-4">
        Sign in with your Bambu Lab account to download Makerworld print
        profiles. Your access token is stored in{" "}
        <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
          data.db
        </code>{" "}
        on this server alongside the email address you sign in with — treat
        that file as sensitive. Tokens expire after ~3 months; you'll need to
        sign in again then.
      </p>

      {phase === "loading" && (
        <div className="px-3.5 py-2.5 rounded-lg border border-border-soft bg-bg-3 text-[13px] text-fg-3">
          Loading sign-in status…
        </div>
      )}

      {phase === "expired" && (
        <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-danger mt-0.5 flex-shrink-0" />
          <div className="text-[12.5px]">
            <p className="font-semibold text-fg mb-0.5">
              Bambu Cloud sign-in expired
            </p>
            <p className="text-fg-2">
              Your access token has expired. Sign in again to keep importing
              from Makerworld.
            </p>
          </div>
        </div>
      )}

      {(phase === "signed_out" || phase === "expired") && (
        <>
          <form onSubmit={handleSendCode} className="space-y-3 max-w-[480px]">
            <div>
              <label htmlFor="bambu-email" className={labelCls}>
                Bambu account email
              </label>
              <input
                id="bambu-email"
                type="email"
                required
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
              />
            </div>
            <button
              type="submit"
              disabled={busy || !email}
              className={primaryBtnCls}
            >
              <Mail className="w-4 h-4" />
              Send verification code
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-border-soft">
            <button
              type="button"
              onClick={() => setPasteOpen((v) => !v)}
              className="text-[13px] text-fg-3 hover:text-fg inline-flex items-center gap-2 transition-colors"
            >
              <ClipboardPaste className="w-4 h-4" />
              {pasteOpen
                ? "Hide paste-token option"
                : "Use social login? Paste an access token instead"}
            </button>

            {pasteOpen && (
              <form
                onSubmit={handlePasteToken}
                className="mt-4 space-y-3 max-w-[480px]"
              >
                <div className="px-3.5 py-2.5 bg-bg-3 border border-border-soft border-l-[3px] border-l-accent rounded-lg text-[12.5px] text-fg-2 leading-relaxed">
                  <p className="font-semibold text-fg mb-1">
                    For Bambu accounts using Google / Apple / other social
                    login
                  </p>
                  <p>
                    1. Sign into{" "}
                    <a
                      href="https://bambulab.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      bambulab.com
                    </a>{" "}
                    in another tab.
                    <br />
                    2. Open DevTools → Application → Cookies → look for{" "}
                    <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
                      token
                    </code>{" "}
                    (or check Network for an{" "}
                    <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
                      Authorization: Bearer …
                    </code>{" "}
                    header on a request to{" "}
                    <code className="font-mono text-[11.5px] bg-bg-2 px-1 py-0.5 rounded">
                      api.bambulab.com
                    </code>
                    ).
                    <br />
                    3. Paste the value below. The expiry is read from the JWT
                    automatically.
                  </p>
                </div>
                <div>
                  <label htmlFor="bambu-paste-token" className={labelCls}>
                    Access token (required)
                  </label>
                  <textarea
                    id="bambu-paste-token"
                    required
                    disabled={busy}
                    value={pasteToken}
                    onChange={(e) => setPasteToken(e.target.value)}
                    placeholder="eyJhbGciOi..."
                    rows={3}
                    className={`${inputCls} font-mono text-[12px]`}
                  />
                </div>
                <div>
                  <label htmlFor="bambu-paste-refresh" className={labelCls}>
                    Refresh token{" "}
                    <span className="font-normal text-fg-3">
                      (optional — paste if you have it)
                    </span>
                  </label>
                  <textarea
                    id="bambu-paste-refresh"
                    disabled={busy}
                    value={pasteRefresh}
                    onChange={(e) => setPasteRefresh(e.target.value)}
                    placeholder="(leave blank if you only have the access token)"
                    rows={2}
                    className={`${inputCls} font-mono text-[12px]`}
                  />
                </div>
                <div>
                  <label htmlFor="bambu-paste-email" className={labelCls}>
                    Account email{" "}
                    <span className="font-normal text-fg-3">
                      (optional — just for display)
                    </span>
                  </label>
                  <input
                    id="bambu-paste-email"
                    type="email"
                    disabled={busy}
                    value={pasteEmail}
                    onChange={(e) => setPasteEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={inputCls}
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy || !pasteToken.trim()}
                  className={primaryBtnCls}
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
        <form onSubmit={handleLogin} className="space-y-3 max-w-[480px]">
          <p className="text-[13px] text-fg-3">
            Code sent to{" "}
            <span className="text-fg font-medium">{email}</span>. Check your
            inbox.
          </p>
          <div>
            <label htmlFor="bambu-code" className={labelCls}>
              6-digit verification code
            </label>
            <input
              id="bambu-code"
              type="text"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4,8}"
              disabled={busy}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className={`${inputCls} tracking-widest`}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="submit"
              disabled={busy || !code}
              className={primaryBtnCls}
            >
              Verify & sign in
            </button>
            <button
              type="button"
              onClick={handleUseDifferentEmail}
              disabled={busy}
              className={secondaryBtnCls}
            >
              Didn't receive a code? Use a different email
            </button>
          </div>
        </form>
      )}

      {phase === "signed_in" && status && (
        <div className="px-4 py-3 rounded-lg border border-border-soft bg-bg-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[12px] text-fg-3">Signed in as</p>
              <p className="text-[14px] text-fg font-medium">
                {status.signedInAs || "—"}
              </p>
              <p className="text-[11.5px] text-fg-3 mt-1">
                Token expires {formatExpiry(status.accessExpiresAt)}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void refreshStatus()}
                disabled={busy}
                className="p-2 rounded-lg border border-border bg-surface hover:bg-surface-2 text-fg-2 transition-colors disabled:opacity-50"
                aria-label="Refresh status"
                title="Refresh status"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                disabled={busy}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-danger-soft hover:border-danger/40 hover:text-danger text-[13px] text-fg-2 font-medium transition-colors disabled:opacity-50"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 px-3.5 py-2.5 rounded-lg bg-danger-soft border border-danger/40 border-l-[3px] border-l-danger text-[12.5px] text-fg-2 whitespace-pre-line">
          {error}
        </div>
      )}
    </div>
  );
};

export default CloudSettings;
