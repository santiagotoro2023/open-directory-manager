import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, api, terminalSocket } from "../api";

// The first byte of every message; the same three constants live in the
// agent (internal/shell) and the control plane (terminal.py).
const FRAME_DATA = 0;
const FRAME_CONTROL = 1;

const encoder = new TextEncoder();

function control(fields: Record<string, unknown>): Uint8Array {
  const body = encoder.encode(JSON.stringify(fields));
  const frame = new Uint8Array(body.length + 1);
  frame[0] = FRAME_CONTROL;
  frame.set(body, 1);
  return frame;
}

function data(text: string): Uint8Array {
  const body = encoder.encode(text);
  const frame = new Uint8Array(body.length + 1);
  frame[0] = FRAME_DATA;
  frame.set(body, 1);
  return frame;
}

type Phase = "opening" | "connected" | "ended" | "failed";

/**
 * A terminal on a machine — the real thing, not a command box.
 *
 * What is typed goes to a login shell on a pseudo-terminal on the machine,
 * and what it prints comes back, byte for byte, into a terminal emulator
 * here: prompts, colours, a pager, an editor, Ctrl-C, all of it, the way an
 * SSH session would. The session is root on that machine, its own right in
 * the delegation model, and the whole of it — typed and printed — is in the
 * audit log when it ends.
 */
export function Terminal({ dn, hostname }: { dn: string; hostname: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("opening");
  const [message, setMessage] = useState("");
  // Bumped to open a fresh session after one ends.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, monospace',
      scrollback: 5000,
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#e2e8f0",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();

    let socket: WebSocket | null = null;
    let closed = false;
    setPhase("opening");
    setMessage("");

    const send = (frame: Uint8Array) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame);
    };

    // What the keyboard produces, as the terminal encodes it — escape
    // sequences for arrows and function keys included.
    const typing = term.onData((text) => send(data(text)));
    const resizing = term.onResize(({ cols, rows }) => send(control({ type: "resize", cols, rows })));

    // The window changing size changes the terminal's, which tells the
    // machine, which tells whatever is running there.
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);

    (async () => {
      try {
        const opened = await api.servers.openTerminal(dn, term.cols, term.rows);
        if (closed) return;
        socket = terminalSocket(opened.session);
        socket.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
          const frame = new Uint8Array(event.data);
          if (frame.length === 0) return;
          if (frame[0] === FRAME_DATA) {
            term.write(frame.subarray(1));
            return;
          }
          let fields: { type?: string; text?: string; status?: number } = {};
          try {
            fields = JSON.parse(new TextDecoder().decode(frame.subarray(1)));
          } catch {
            return;
          }
          if (fields.type === "status") {
            setMessage(fields.text ?? "");
            if (!fields.text) {
              setPhase("connected");
              term.focus();
            }
          } else if (fields.type === "exit") {
            setPhase("ended");
            setMessage(
              fields.text ??
                (fields.status === undefined || fields.status === 0
                  ? "The shell exited."
                  : `The shell exited with status ${fields.status}.`),
            );
          }
        });
        socket.addEventListener("close", (event) => {
          if (closed) return;
          setPhase((was) => (was === "ended" ? was : "ended"));
          if (event.code === 4401 || event.code === 4403 || event.code === 4404) {
            setPhase("failed");
            setMessage("The console refused the terminal. Sign in again and retry.");
          } else {
            setMessage((was) => was || "The connection closed.");
          }
        });
        socket.addEventListener("error", () => {
          if (closed) return;
          setPhase("failed");
          setMessage("The connection to the console failed.");
        });
      } catch (err) {
        if (closed) return;
        setPhase("failed");
        setMessage(err instanceof ApiError ? err.message : String(err));
      }
    })();

    return () => {
      closed = true;
      typing.dispose();
      resizing.dispose();
      observer.disconnect();
      socket?.close();
      term.dispose();
    };
  }, [dn, attempt]);

  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="mono">root@{hostname.split(".")[0]}</span>
        <span className={`terminal-state terminal-state-${phase}`}>
          {phase === "opening" && (message || "Opening…")}
          {phase === "connected" && "Connected"}
          {phase === "ended" && (message || "Ended")}
          {phase === "failed" && (message || "Failed")}
        </span>
        {(phase === "ended" || phase === "failed") && (
          <button type="button" className="secondary small" onClick={() => setAttempt((n) => n + 1)}>
            New session
          </button>
        )}
      </div>
      <div
        className="terminal-screen"
        ref={host}
        onClick={() => host.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus()}
      />
    </div>
  );
}
