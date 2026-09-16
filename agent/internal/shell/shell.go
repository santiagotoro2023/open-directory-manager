// Package shell is a terminal on this machine for an operator at the console.
//
// The one-shot shell (tasks.runShell) runs a command line and hands back what
// it printed, which is enough for a quick look and useless the moment
// something asks a question, needs a pager, or wants to be watched. This is
// the other thing: a real pseudo-terminal with a login shell on it, its bytes
// carried both ways over one connection the agent opens to the control plane,
// and the console's own terminal emulator at the far end. Everything an SSH
// session would do — job control, curses, prompts — works, because to the
// shell it is one.
//
// The agent dials out, never listens: a machine behind NAT or a firewall is
// reachable exactly as far as it can reach the console, and that is the same
// authenticated, TLS-wrapped path every other call takes.
package shell

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Conn carries the session. Every message is a byte slice whose first byte
// says what the rest is; see the Frame* constants. One kind of frame, so the
// transport underneath does not have to distinguish text from binary — the
// browser, the control plane and this agent all read the same first byte.
type Conn interface {
	// Receive blocks for the next message from the console.
	Receive() ([]byte, error)
	// Send delivers one message to the console.
	Send([]byte) error
	Close() error
}

// What the first byte of a message means.
const (
	// FrameData is terminal bytes: keystrokes one way, output the other.
	FrameData byte = 0
	// FrameControl is a JSON object. The console sends {"type":"resize",
	// "cols":N,"rows":N}; the agent sends {"type":"exit","status":N} when the
	// shell has gone.
	FrameControl byte = 1
)

// control is what a FrameControl message decodes to.
type control struct {
	Type   string `json:"type"`
	Cols   int    `json:"cols,omitempty"`
	Rows   int    `json:"rows,omitempty"`
	Status int    `json:"status,omitempty"`
}

// Options shapes one session.
type Options struct {
	Cols, Rows int
	// Command is what runs on the terminal. Empty means the machine's login
	// shell for root, started the way PID 1 would start it — see command.
	Command []string
	// Systemd says whether to run the shell as a transient unit of its own,
	// outside this agent's own sandbox. Nil means "if this machine has one".
	Systemd *bool
}

// Serve runs one session until the shell exits, the console goes away, or
// ctx ends. It returns nil when the shell ended on its own.
func Serve(ctx context.Context, conn Conn, opts Options) error {
	master, slave, err := openPty()
	if err != nil {
		return err
	}
	defer master.Close()

	if opts.Cols > 0 && opts.Rows > 0 {
		_ = setSize(master, opts.Cols, opts.Rows)
	}

	cmd, cleanup := command(opts)
	defer cleanup()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	// A session of its own, with the pseudo-terminal as its controlling
	// terminal: that is what makes Ctrl-C reach the foreground job and a
	// closed terminal hang up the shell rather than leave it running.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		slave.Close()
		return fmt.Errorf("start shell: %w", err)
	}
	// The child holds the slave now; keeping it open here would stop the
	// master from ever reading EOF when the shell exits.
	slave.Close()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var output, input sync.WaitGroup
	var once sync.Once
	var reason error
	stop := func(err error) {
		once.Do(func() {
			reason = err
			cancel()
		})
	}

	// Output: the terminal to the console.
	output.Add(1)
	go func() {
		defer output.Done()
		buffer := make([]byte, 32*1024)
		for {
			n, err := master.Read(buffer)
			if n > 0 {
				frame := make([]byte, 0, n+1)
				frame = append(frame, FrameData)
				frame = append(frame, buffer[:n]...)
				if sendErr := conn.Send(frame); sendErr != nil {
					stop(fmt.Errorf("console went away: %w", sendErr))
					return
				}
			}
			if err != nil {
				// EIO is how a pty master says the last process on the
				// slave has gone: the shell exited. Not an error.
				stop(nil)
				return
			}
		}
	}()

	// Input: the console to the terminal, and resizes.
	input.Add(1)
	go func() {
		defer input.Done()
		for {
			message, err := conn.Receive()
			if err != nil {
				stop(fmt.Errorf("console went away: %w", err))
				return
			}
			if len(message) == 0 {
				continue
			}
			switch message[0] {
			case FrameData:
				if _, err := master.Write(message[1:]); err != nil {
					stop(nil)
					return
				}
			case FrameControl:
				var c control
				if json.Unmarshal(message[1:], &c) == nil && c.Type == "resize" {
					_ = setSize(master, c.Cols, c.Rows)
				}
			}
		}
	}()

	// The shell's own end, or something else's.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	var waitErr error
	select {
	case waitErr = <-exited:
		stop(nil)
	case <-ctx.Done():
		// Hang up, the way a closed terminal does, and give the shell a
		// moment to take the hint before insisting.
		_ = cmd.Process.Signal(syscall.SIGHUP)
		select {
		case waitErr = <-exited:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			waitErr = <-exited
		}
	}

	status := 0
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		status = exit.ExitCode()
	}
	// Closing the master unblocks the reader; the console hears why after
	// whatever output was still queued, and the input side — blocked on
	// the console — is released by closing the connection last.
	master.Close()
	output.Wait()
	body, _ := json.Marshal(control{Type: "exit", Status: status})
	_ = conn.Send(append([]byte{FrameControl}, body...))
	_ = conn.Close()
	input.Wait()
	return reason
}

// command is what the terminal runs: root's login shell, as a transient unit
// of its own where there is a systemd to ask, so that it carries none of the
// agent's own restrictions (CLAUDE.md: anything needing a capability
// odm-agent.service removes goes through PID 1, not this process). What an
// operator gets is a shell as ordinary as the one SSH would give them. A
// container or a test has no PID 1 to ask and runs the shell directly.
func command(opts Options) (*exec.Cmd, func()) {
	argv := opts.Command
	if len(argv) == 0 {
		argv = []string{"/bin/bash", "-l"}
	}
	systemd := opts.Systemd != nil && *opts.Systemd
	if opts.Systemd == nil {
		_, err := os.Stat("/run/systemd/system")
		systemd = err == nil
	}
	if systemd {
		// --pty gives the unit a terminal of its own, forwarded to ours;
		// --wait keeps this process alive as long as the shell, so its exit
		// is the shell's.
		unit := fmt.Sprintf("odm-shell-%d", time.Now().UnixNano()%1_000_000)
		run := []string{
			"--quiet", "--collect", "--wait", "--pty",
			"--unit=" + unit,
			"--description=Open Directory Manager console shell",
			"--setenv=TERM=xterm-256color",
			// What a login on a tty would have, and a transient unit does not:
			// a home, a name, a shell to name in $SHELL.
			"--setenv=HOME=/root", "--setenv=USER=root", "--setenv=LOGNAME=root",
			"--setenv=SHELL=/bin/bash",
			"--working-directory=/root",
			"--",
		}
		cmd := exec.Command("systemd-run", append(run, argv...)...)
		// A shell that ignored the hangup when the console went away is
		// still a unit PID 1 can be told to stop.
		return cmd, func() { _ = exec.Command("systemctl", "stop", "--no-block", unit+".service").Run() }
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = "/"
	cmd.Env = append(scrub(os.Environ()), "TERM=xterm-256color")
	return cmd, func() {}
}

// scrub drops TERM from an environment so the one appended after it wins.
func scrub(environ []string) []string {
	out := environ[:0:0]
	for _, entry := range environ {
		if !strings.HasPrefix(entry, "TERM=") {
			out = append(out, entry)
		}
	}
	return out
}

// openPty allocates a pseudo-terminal pair. Done by hand rather than through a
// library: it is three ioctls, and the agent carries no dependency it does not
// have to.
func openPty() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	var number uint32
	if err := ioctl(master.Fd(), syscall.TIOCGPTN, unsafe.Pointer(&number)); err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("TIOCGPTN: %w", err)
	}
	var unlock int32
	if err := ioctl(master.Fd(), syscall.TIOCSPTLCK, unsafe.Pointer(&unlock)); err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("TIOCSPTLCK: %w", err)
	}
	slave, err = os.OpenFile(fmt.Sprintf("/dev/pts/%d", number),
		os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("open pts: %w", err)
	}
	return master, slave, nil
}

// setSize tells the terminal how big the window at the far end is. The
// kernel passes that on to the foreground job as SIGWINCH, which is how a
// pager or an editor learns to redraw.
func setSize(master *os.File, cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		return errors.New("unreasonable terminal size")
	}
	size := struct{ Row, Col, X, Y uint16 }{Row: uint16(rows), Col: uint16(cols)}
	return ioctl(master.Fd(), syscall.TIOCSWINSZ, unsafe.Pointer(&size))
}

func ioctl(fd uintptr, request uint, argument unsafe.Pointer) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(request), uintptr(argument)); errno != 0 {
		return errno
	}
	return nil
}

// Pipe is a Conn over two in-memory channels, for tests and for anything
// that wants to drive a session without a network.
type Pipe struct {
	In  chan []byte
	Out chan []byte
	// Closed is closed once Close has been called.
	Closed chan struct{}
	once   sync.Once
}

func NewPipe() *Pipe {
	return &Pipe{In: make(chan []byte, 64), Out: make(chan []byte, 1024), Closed: make(chan struct{})}
}

func (p *Pipe) Receive() ([]byte, error) {
	select {
	case message, ok := <-p.In:
		if !ok {
			return nil, io.EOF
		}
		return message, nil
	case <-p.Closed:
		return nil, io.EOF
	}
}

func (p *Pipe) Send(message []byte) error {
	select {
	case p.Out <- message:
		return nil
	case <-p.Closed:
		return io.ErrClosedPipe
	}
}

func (p *Pipe) Close() error {
	p.once.Do(func() { close(p.Closed) })
	return nil
}
