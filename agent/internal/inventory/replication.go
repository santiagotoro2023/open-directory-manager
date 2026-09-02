package inventory

import (
	"context"
	"os"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// Replication state, collected by the controller it belongs to.
//
// Samba refuses DsReplicaGetInfo — what `samba-tool drs showrepl` calls — to
// any caller below domain-controller level, whatever access-control entries it
// holds. The control plane's account is deliberately neither a controller nor
// an administrator, so it cannot read replication state at all; the machine
// account can, and its password is in secrets.tdb, readable only by root.
//
// The agent is root on the controller. So it runs the command and reports the
// output, exactly as it reports the rest of the machine's state, and the
// control plane parses it. A machine that is not a controller reports nothing
// here, which is the right answer for one.
const (
	sambaTool = "/usr/bin/samba-tool"

	// Enough for a large forest's inbound and outbound sections; the control
	// plane refuses more, so there is no point sending more.
	maxReplicationOutput = 32 << 10
)

func replicationState(ctx context.Context, env apply.Env) string {
	if env.Run == nil {
		return ""
	}
	// Only a controller has the tool and the machine account behind it.
	if _, err := os.Stat(env.Path(sambaTool)); err != nil {
		return ""
	}
	// --machine-pass authenticates as this machine's own computer account,
	// which is what Samba requires here. Without it samba-tool has no
	// credentials in a service context and would sit waiting for a password.
	out, err := env.Run.Run(ctx, sambaTool, "drs", "showrepl", "--machine-pass")
	if err != nil {
		return ""
	}
	if len(out) > maxReplicationOutput {
		out = out[:maxReplicationOutput]
	}
	return strings.TrimSpace(out)
}
