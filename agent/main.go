// Command odm-agent applies effective policy handed down by the ODM control
// plane. The API resolves GPO precedence, inheritance blocking, enforcement
// and item-level targeting; the agent only applies what it is given and
// reports Resultant Set of Policy back (CLAUDE.md §5.2).
//
// Phase 3 implements the pull/apply/report loop and the appliers. This file
// exists so the module, its toolchain and its CI stage are wired up now.
package main

import (
	"flag"
	"fmt"
	"os"
)

const version = "0.1.0"

func main() {
	showVersion := flag.Bool("version", false, "print the agent version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("odm-agent", version)
		return
	}

	fmt.Fprintln(os.Stderr, "odm-agent: policy application is not implemented yet (Phase 3)")
	os.Exit(1)
}
