package apply

import (
	"os"
	"strings"
)

const (
	blockStart = "# BEGIN ODM MANAGED BLOCK"
	blockEnd   = "# END ODM MANAGED BLOCK"
)

// ReplaceBlock rewrites only ODM's marked section of a file that other
// software also owns (/etc/security/access.conf, /etc/pam.d/common-session).
// Everything outside the markers is preserved exactly. An empty body removes
// the section entirely.
func (e Env) ReplaceBlock(path, body string, mode os.FileMode) error {
	full := e.Path(path)
	existing, err := os.ReadFile(full)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	kept := stripBlock(string(existing))
	if body == "" {
		if len(existing) == 0 {
			return nil
		}
		// Removing the block is not owning the file either.
		err := e.WriteFile(path, kept, mode, "", "")
		e.State.OwnBlock(path)
		delete(e.State.Blocks, path)
		return err
	}

	section := blockStart + "\n" + body
	if !strings.HasSuffix(section, "\n") {
		section += "\n"
	}
	section += blockEnd + "\n"

	if kept != "" && !strings.HasSuffix(kept, "\n") {
		kept += "\n"
	}
	if err := e.WriteFile(path, kept+section, mode, "", ""); err != nil {
		return err
	}
	// After the write, because WriteFile records the path as a file ODM owns
	// and this one is not: pruning it must take the block out, not delete a
	// file the system owns.
	e.State.OwnBlock(path)
	return nil
}

func stripBlock(content string) string {
	start := strings.Index(content, blockStart)
	if start == -1 {
		return content
	}
	end := strings.Index(content[start:], blockEnd)
	if end == -1 {
		return content[:start]
	}
	tail := content[start+end+len(blockEnd):]
	return content[:start] + strings.TrimPrefix(tail, "\n")
}
