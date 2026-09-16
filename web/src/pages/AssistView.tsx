import { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb.js";
import { ApiError, api, assistSocket } from "../api";

type Phase = "loading" | "connecting" | "connected" | "ended" | "failed";

/**
 * Somebody's screen, full screen, in its own tab.
 *
 * Opened from a computer object once the person has agreed. The page reads
 * the offer back over the session that made it — whose screen, which
 * machine, the one-time credential — opens the console's end of the shared
 * screen, and hands the socket to a VNC viewer that draws it. Nothing to
 * install, nothing to type: the administrator is looking at the screen a
 * few seconds after the person said yes. Closing the tab ends the viewing;
 * the offer itself stands until its time runs out, so the tab can be opened
 * again.
 */
export function AssistView({ session }: { session: string }) {
  const screen = useRef<HTMLDivElement | null>(null);
  const viewer = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const [about, setAbout] = useState<{ hostname: string; username: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [viewOnly, setViewOnly] = useState(false);
  // Bumped to attach again after a viewing ended.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    let closed = false;
    let socket: WebSocket | null = null;
    setPhase("loading");
    setMessage("");

    (async () => {
      let offer: Awaited<ReturnType<typeof api.servers.assistSession>>;
      try {
        offer = await api.servers.assistSession(session);
      } catch (err) {
        if (closed) return;
        setPhase("failed");
        setMessage(
          err instanceof ApiError && err.status === 404
            ? "This offer has ended, or it was made from another sign-in."
            : err instanceof ApiError
              ? err.message
              : String(err),
        );
        return;
      }
      if (closed) return;
      setAbout({
        hostname: offer.hostname,
        username: offer.username,
        until: Date.now() + offer.seconds_left * 1000,
      });
      document.title = `${offer.username} on ${offer.hostname.split(".")[0]} — Open Directory Manager`;
      setPhase("connecting");
      setMessage("Connecting to the machine…");

      socket = assistSocket(session);
      const opened = socket;
      const closedEarly = (event: CloseEvent) => {
        if (closed) return;
        setPhase("failed");
        setMessage(
          event.reason ||
            (event.code === 4401 || event.code === 4403
              ? "The console refused the viewer. Sign in again and retry."
              : event.code === 4404
                ? "This offer has ended."
                : "The connection to the console closed."),
        );
      };
      opened.addEventListener("close", closedEarly);
      opened.addEventListener("error", () => {
        if (closed) return;
        setPhase("failed");
        setMessage("The connection to the console failed.");
      });
      // The first text frame says the machine is on the line; from then on
      // the socket carries VNC, and the viewer owns it.
      const ready = (event: MessageEvent) => {
        if (typeof event.data !== "string" || event.data !== "ready") return;
        opened.removeEventListener("message", ready);
        opened.removeEventListener("close", closedEarly);
        const rfb = new RFB(element, opened, {
          credentials: { password: offer.password },
          shared: true,
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.focusOnClick = true;
        rfb.background = "#0f172a";
        rfb.qualityLevel = 7;
        rfb.compressionLevel = 3;
        rfb.addEventListener("connect", () => {
          if (closed) return;
          setPhase("connected");
          setMessage("");
          rfb.focus();
        });
        rfb.addEventListener("credentialsrequired", () => {
          rfb.sendCredentials({ password: offer.password });
        });
        rfb.addEventListener("securityfailure", (event: Event) => {
          if (closed) return;
          const detail = (event as CustomEvent<{ reason?: string }>).detail;
          setPhase("failed");
          setMessage(`The machine refused the credential${detail?.reason ? `: ${detail.reason}` : "."}`);
        });
        rfb.addEventListener("disconnect", (event: Event) => {
          if (closed) return;
          const detail = (event as CustomEvent<{ clean?: boolean }>).detail;
          setPhase((was) => (was === "failed" ? was : "ended"));
          setMessage((was) => was || (detail?.clean ? "The viewing ended." : "The connection to the machine was lost."));
        });
        viewer.current = rfb;
      };
      opened.addEventListener("message", ready);
    })();

    return () => {
      closed = true;
      if (viewer.current) {
        try {
          viewer.current.disconnect();
        } catch {
          /* already gone */
        }
        viewer.current = null;
      }
      socket?.close();
    };
  }, [session, attempt]);

  useEffect(() => {
    if (viewer.current) viewer.current.viewOnly = viewOnly;
  }, [viewOnly, phase]);

  const secondsLeft = about ? Math.max(0, Math.round((about.until - now) / 1000)) : 0;
  const clock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  const ctrlAltDel = useCallback(() => viewer.current?.sendCtrlAltDel(), []);
  const end = useCallback(() => {
    viewer.current?.disconnect();
    setPhase("ended");
    setMessage("The viewing ended.");
  }, []);

  return (
    <div className="assist-view">
      <div className="assist-bar">
        <span className="assist-who">
          {about ? (
            <>
              <strong>{about.username}</strong> on <span className="mono">{about.hostname.split(".")[0]}</span>
            </>
          ) : (
            "Remote assistance"
          )}
        </span>
        <span className={`assist-state assist-state-${phase}`}>
          {phase === "connected" ? `Watching · ${clock} left` : message || "…"}
        </span>
        <span className="assist-tools">
          {phase === "connected" && (
            <>
              <label className="assist-toggle">
                <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
                View only
              </label>
              <button type="button" className="secondary small" onClick={ctrlAltDel}>
                Ctrl+Alt+Del
              </button>
              <button type="button" className="danger small" onClick={end}>
                End
              </button>
            </>
          )}
          {(phase === "ended" || phase === "failed") && secondsLeft > 0 && (
            <button type="button" className="secondary small" onClick={() => setAttempt((n) => n + 1)}>
              Connect again
            </button>
          )}
        </span>
      </div>
      <div className="assist-screen" ref={screen} />
    </div>
  );
}
