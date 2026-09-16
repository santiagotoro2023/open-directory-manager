package relay

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"odm.example.org/agent/internal/shell"
)

// pipeConn is shell.Conn over two channels, the console's side of a fake
// WebSocket.
type pipeConn struct {
	in     chan []byte
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func newPipeConn() *pipeConn {
	return &pipeConn{in: make(chan []byte, 16), out: make(chan []byte, 16), closed: make(chan struct{})}
}

func (p *pipeConn) Receive() ([]byte, error) {
	select {
	case m := <-p.in:
		return m, nil
	case <-p.closed:
		return nil, io.EOF
	}
}

func (p *pipeConn) Send(m []byte) error {
	select {
	case p.out <- m:
		return nil
	case <-p.closed:
		return errors.New("closed")
	}
}

func (p *pipeConn) Close() error {
	p.once.Do(func() { close(p.closed) })
	return nil
}

func TestPumpCarriesBothWaysAndEndsWhenTheConsoleHangsUp(t *testing.T) {
	console := newPipeConn()
	near, far := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- Pump(context.Background(), console, near) }()

	// The server greets; the console sees the greeting.
	go far.Write([]byte("RFB 003.008\n"))
	select {
	case got := <-console.out:
		if string(got) != "RFB 003.008\n" {
			t.Fatalf("console got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the greeting never reached the console")
	}

	// The console answers; the server sees the answer.
	console.in <- []byte("RFB 003.008\n")
	buffer := make([]byte, 64)
	far.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := far.Read(buffer)
	if err != nil || string(buffer[:n]) != "RFB 003.008\n" {
		t.Fatalf("server got %q, %v", buffer[:n], err)
	}

	// The viewer closes its tab: the pump ends cleanly and the server side
	// is closed too.
	console.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("a console hanging up is not an error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the pump did not end when the console hung up")
	}
	far.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := far.Read(buffer); err == nil {
		t.Fatal("the server end should have been closed")
	}
}

func TestServeWaitsForOpenBeforeConnectingAndComesBackForTheNextViewer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 4)
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("hello"))
			accepted <- c
		}
	}()

	conns := make(chan *pipeConn, 4)
	dials := 0
	dial := func(ctx context.Context) (shell.Conn, error) {
		dials++
		if dials > 2 {
			return nil, errors.New("refused: the offer is over")
		}
		c := newPipeConn()
		conns <- c
		return c, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- Serve(ctx, dial, listener.Addr().String(), time.Now().Add(time.Minute)) }()

	first := <-conns
	select {
	case <-accepted:
		t.Fatal("connected to the server before any viewer attached")
	case <-time.After(200 * time.Millisecond):
	}
	first.in <- []byte(Open)
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("did not connect to the server after open")
	}
	if got := <-first.out; string(got) != "hello" {
		t.Fatalf("viewer got %q", got)
	}
	first.Close()

	// The agent comes back for the next viewer without being asked.
	second := <-conns
	second.in <- []byte(Open)
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("did not serve a second viewer")
	}
	second.Close()

	// The third dial is refused, which ends the loop.
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("a refused dial should be reported")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve did not stop when the control plane refused")
	}
}
