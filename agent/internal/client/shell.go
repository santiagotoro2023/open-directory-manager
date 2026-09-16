package client

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jcmturner/gokrb5/v8/spnego"
	"golang.org/x/net/websocket"

	"odm.example.org/agent/internal/shell"
)

// DialShell opens the connection a console shell session runs over: a
// WebSocket to the control plane, authenticated the same way every request
// is — with this machine's Kerberos ticket, on the handshake — and carrying
// the session's bytes both ways from then on. The session id names which
// operator's terminal is waiting at the other end; the control plane checks
// that it was asked for on this machine before it joins the two.
func (c *Client) DialShell(ctx context.Context, session string) (shell.Conn, error) {
	location := strings.Replace(c.base, "http", "ws", 1) + "/api/v1/agent/shell/" + session
	config, err := websocket.NewConfig(location, c.base+"/")
	if err != nil {
		return nil, err
	}
	config.TlsConfig = c.tls

	// The ticket goes on the handshake. There is no second round trip here
	// for a challenge, so the header is set up front rather than in answer
	// to a 401 the way the HTTP client does it.
	request, err := http.NewRequest(http.MethodGet, c.base, nil)
	if err != nil {
		return nil, err
	}
	if err := spnego.SetSPNEGOHeader(c.krb, request, c.spn); err != nil {
		return nil, fmt.Errorf("kerberos: %w", err)
	}
	config.Header.Set("Authorization", request.Header.Get("Authorization"))
	config.Header.Set("User-Agent", "odm-agent/"+c.version)

	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ws, err := config.DialContext(dialCtx)
	if err != nil {
		return nil, fmt.Errorf("shell connection: %w", err)
	}
	return &socket{ws: ws}, nil
}

// socket is shell.Conn over a WebSocket. Every message is one binary frame,
// so nothing here has to distinguish frame types — the first byte of the
// payload does that, on every side.
type socket struct {
	ws *websocket.Conn
}

func (s *socket) Receive() ([]byte, error) {
	var message []byte
	if err := websocket.Message.Receive(s.ws, &message); err != nil {
		return nil, err
	}
	return message, nil
}

func (s *socket) Send(message []byte) error {
	return websocket.Message.Send(s.ws, message)
}

func (s *socket) Close() error {
	return s.ws.Close()
}
