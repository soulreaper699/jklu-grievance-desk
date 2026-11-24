import { useEffect, useRef } from "react";
import { PublicClientApplication } from "@azure/msal-browser";
import complaintPortal from "./imports/Grievance_Desk___JKLU_Complaint_Portal.html?raw";

const DEFAULT_MS_CLIENT_ID = "00c3f8b1-9886-4245-aa3d-dacb915aea46";
const DEFAULT_MS_TENANT_ID = "8695b83d-c692-47ef-ad7a-376cbce3664f";

function getOAuthConfig() {
  const clientId = (import.meta.env.VITE_MS_CLIENT_ID || DEFAULT_MS_CLIENT_ID).trim();
  const tenantId = (import.meta.env.VITE_MS_TENANT_ID || DEFAULT_MS_TENANT_ID).trim();
  return { clientId, tenantId };
}

export default function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const msalRef = useRef<{ key: string; app: PublicClientApplication } | null>(null);

  useEffect(() => {
    const redirectUri = `${window.location.origin}/oauth-callback.html`;

    const postToPortal = (payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(payload, "*");
    };

    const getMsalInstance = async (clientId: string, tenantId: string) => {
      const key = `${clientId}::${tenantId}`;
      if (msalRef.current && msalRef.current.key === key) {
        return msalRef.current.app;
      }
      const app = new PublicClientApplication({
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${tenantId}`,
          redirectUri,
        },
        cache: {
          cacheLocation: "sessionStorage",
        },
      });
      await app.initialize();
      msalRef.current = { key, app };
      return app;
    };

    const initOnLoad = async () => {
      const { clientId, tenantId } = getOAuthConfig();
      try {
        const app = await getMsalInstance(clientId, tenantId);
        const redirectResult = await app.handleRedirectPromise();
        if (redirectResult?.account) {
          postToPortal({
            type: "MS_OAUTH_SUCCESS",
            account: redirectResult.account,
            idTokenClaims: redirectResult.idTokenClaims || redirectResult.account.idTokenClaims || {},
          });
        }
      } catch (err) {
        console.warn("MSAL init/redirect check failed:", err);
        if (window.location.hash.includes("code=") || window.location.hash.includes("error=") || window.location.search.includes("code=")) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      }
    };

    void initOnLoad();

    const handleMessage = async (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "MS_OAUTH_LOGIN_REQUEST") {
        const { clientId, tenantId } = getOAuthConfig();
        try {
          const app = await getMsalInstance(clientId, tenantId);
          const result = await app.loginPopup({
            scopes: ["openid", "profile", "email"],
            prompt: "select_account",
          });
          postToPortal({
            type: "MS_OAUTH_SUCCESS",
            account: result.account,
            idTokenClaims: result.idTokenClaims || result.account?.idTokenClaims || {},
          });
        } catch (err: unknown) {
          const authErr = err as { errorCode?: string; errorMessage?: string; message?: string };
          postToPortal({
            type: "MS_OAUTH_ERROR",
            errorCode: authErr?.errorCode || "msal_login_error",
            errorMessage: authErr?.errorMessage || authErr?.message || "Microsoft sign-in failed.",
          });
        }
        return;
      }

      if (data.type === "MS_OAUTH_LOGOUT_REQUEST") {
        if (msalRef.current) {
          try {
            await msalRef.current.app.clearCache();
          } catch {
            // Ignore cache clear failure
          }
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className="block h-dvh w-full border-0"
      srcDoc={complaintPortal}
      title="Grievance Desk — JKLU Complaint Portal"
      sandbox="allow-forms allow-modals allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-downloads"
    />
  );
}
