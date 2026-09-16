package main

import (
	"fmt"
	"log/syslog"
)

// noteActivity writes one line to the machine's own journal, under this
// agent's name, in the shape inventory.ParseActivity reads back:
//
//	second factor: approved for alice (login)
//
// The journal is the record on the machine — the same place sudo and sshd
// put theirs — and the inventory pass is what carries it to the console, so
// a second factor approved while the console was unreachable still arrives,
// in order, when the machine next reports. Best effort: a machine without a
// syslog socket loses the line and nothing else.
func noteActivity(format string, args ...any) {
	writer, err := syslog.New(syslog.LOG_AUTH|syslog.LOG_NOTICE, "odm-agent")
	if err != nil {
		return
	}
	defer writer.Close()
	_ = writer.Notice(fmt.Sprintf(format, args...))
}
