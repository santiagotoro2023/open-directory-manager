// Package relay carries a shared screen between the console and the VNC
// server on this machine.
//
// When somebody agrees to be helped, a VNC server starts on the machine's
// own loopback and nothing else; the network never sees it. This is what
// makes it reachable anyway: one connection the agent opens to the control
// plane — the same outbound, Kerberos-authenticated socket a console
// terminal uses — with the server's bytes on it. The console's viewer speaks
// VNC to the far end; the agent copies bytes and understands none of them.
//
// One connection carries one viewer. The agent connects as soon as sharing
// is up and waits for the word "open", which is the console saying a viewer
// has attached; only then does it connect to the server, so the server's
// greeting goes to somebody who is there to read it. When either side hangs
// up it closes the other and connects again, ready for the next tab, until
// the offer's time is up or the control plane says the offer is over.
package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"odm.example.org/agent/internal/shell"
)

// Dialer opens one connection to the control plane for an offer.
type Dialer func(ctx context.Context) (shell.Conn, error)

// The word the console sends when a viewer has attached.
const Open = "open"

// How long to wait before connecting again after a connection that ended
// without a viewer having been served — a control plane restarting, say.
const retryAfter = 2 * time.Second

// Serve carries viewers for one offer until `until`, ctx ends, or the
// control plane refuses the connection (which is how "the offer is over" is
// said). address is the VNC server, "127.0.0.1:5900" ordinarily.
func Serve(ctx context.Context, dial Dialer, address string, until time.Time) error {
	for ctx.Err() == nil && time.Now().Before(until) {
		conn, err := dial(ctx)
		if err != nil {
			// Refused: the offer is over, or the console is unreachable.
			// Either way there is nothing to carry.
			return err
		}
		served, err := carryOne(ctx, conn, address)
		conn.Close()
		if err != nil && !served {
			// Ended before a viewer came, which is not the ordinary way a
			// connection ends: give the console a moment and try again.
			select {
			case <-ctx.Done():
			case <-time.After(retryAfter):
			}
		}
	}
	return nil
}

// carryOne waits for a viewer on one connection and carries it until one
// side hangs up. served says whether a viewer was actually attached.
func carryOne(ctx context.Context, conn shell.Conn, address string) (served bool, err error) {
	first, err := conn.Receive()
	if err != nil {
		return false, fmt.Errorf("waiting for a viewer: %w", err)
	}
	if string(first) != Open {
		return false, fmt.Errorf("unexpected first message %q", string(first))
	}
	server, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		return true, fmt.Errorf("the VNC server: %w", err)
	}
	defer server.Close()
	return true, Pump(ctx, conn, server)
}

// Pump copies bytes both ways between the console's connection and the
// server until either ends. It returns nil when the console hung up (the
// viewer closed its tab) and the server's error otherwise.
func Pump(ctx context.Context, conn shell.Conn, server io.ReadWriteCloser) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 2)

	go func() {
		// Server → console.
		buffer := make([]byte, 32*1024)
		for {
			n, err := server.Read(buffer)
			if n > 0 {
				frame := make([]byte, n)
				copy(frame, buffer[:n])
				if sendErr := conn.Send(frame); sendErr != nil {
					errs <- nil // the console went away; that is the end, not a fault
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					errs <- errors.New("the VNC server closed the connection")
				} else {
					errs <- err
				}
				return
			}
		}
	}()
	go func() {
		// Console → server.
		for {
			message, err := conn.Receive()
			if err != nil {
				errs <- nil
				return
			}
			if len(message) == 0 {
				continue
			}
			if _, err := server.Write(message); err != nil {
				errs <- err
				return
			}
		}
	}()

	var first error
	select {
	case first = <-errs:
	case <-ctx.Done():
		first = nil
	}
	// Closing both ends unblocks whichever goroutine is still reading.
	server.Close()
	conn.Close()
	return first
}
