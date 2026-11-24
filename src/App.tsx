import { useEffect, useRef } from "react";
import complaintPortal from "./imports/Grievance_Desk___JKLU_Complaint_Portal.html?raw";

export default function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Relay OAuth responses from top window or popup to the embedded portal
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "MS_OAUTH_RESPONSE") {
        iframeRef.current?.contentWindow?.postMessage(e.data, "*");
      }
    };
    window.addEventListener("message", handleMessage);

    // If top window received hash or search parameters from Microsoft OAuth redirect
    if (
      window.location.hash.includes("id_token") ||
      window.location.hash.includes("code") ||
      window.location.search.includes("code")
    ) {
      const payload = {
        type: "MS_OAUTH_RESPONSE",
        hash: window.location.hash,
        search: window.location.search,
      };
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage(payload, "*");
      }, 500);
    }

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

