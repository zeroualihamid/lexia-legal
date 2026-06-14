import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";

const OFFICIAL_OPENCODE_URL =
  import.meta.env.VITE_OFFICIAL_OPENCODE_APP_URL || "http://127.0.0.1:4173";

const OpencodeView: React.FC = () => {
  const navigate = useNavigate();
  const [iframeKey, setIframeKey] = useState(0);
  const [isReachable, setIsReachable] = useState<boolean | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const healthUrl = useMemo(() => {
    try {
      return new URL("/", OFFICIAL_OPENCODE_URL).toString();
    } catch {
      return OFFICIAL_OPENCODE_URL;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await fetch(healthUrl, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        });

        if (cancelled) return;
        setIsReachable(true);
        setLastError(null);
        void response;
      } catch (error) {
        if (cancelled) return;
        setIsReachable(false);
        setLastError(
          error instanceof Error
            ? error.message
            : "Unable to reach the official OpenCode frontend.",
        );
      }
    }

    void probe();
    return () => {
      cancelled = true;
    };
  }, [healthUrl, iframeKey]);

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/agent");
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#f5f3ef]">
      <div className="absolute left-4 top-4 z-20 flex items-center gap-2">
        <Button
          variant="outline"
          className="h-10 rounded-full border-black/10 bg-white/92 px-4 shadow-sm backdrop-blur"
          onClick={handleBack}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <Button
          variant="outline"
          className="h-10 rounded-full border-black/10 bg-white/92 px-4 shadow-sm backdrop-blur"
          onClick={() => setIframeKey((current) => current + 1)}
        >
          <RefreshCw className="h-4 w-4" />
          Reload
        </Button>

        <Button
          variant="outline"
          className="h-10 rounded-full border-black/10 bg-white/92 px-4 shadow-sm backdrop-blur"
          onClick={() => window.open(OFFICIAL_OPENCODE_URL, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-4 w-4" />
          Open
        </Button>
      </div>

      {isReachable === false && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#f5f3ef]/92 px-6">
          <div className="max-w-xl rounded-3xl border border-black/10 bg-white p-8 shadow-xl">
            <h1 className="text-2xl font-semibold tracking-tight text-[#1f1f1f]">
              Official OpenCode frontend is not reachable
            </h1>
            <p className="mt-3 text-sm leading-7 text-[#5e5a55]">
              This route now embeds the real upstream frontend from
              <span className="mx-1 rounded bg-black/5 px-2 py-1 font-mono text-[12px]">
                {OFFICIAL_OPENCODE_URL}
              </span>
              instead of a React reimplementation.
            </p>
            {lastError && (
              <p className="mt-3 text-sm text-[#8a3b32]">{lastError}</p>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => setIframeKey((current) => current + 1)}>
                Retry
              </Button>
              <Button
                variant="outline"
                onClick={() => window.open(OFFICIAL_OPENCODE_URL, "_blank", "noopener,noreferrer")}
              >
                Open frontend directly
              </Button>
            </div>
          </div>
        </div>
      )}

      <iframe
        key={iframeKey}
        src={OFFICIAL_OPENCODE_URL}
        title="Official OpenCode"
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
};

export default OpencodeView;
