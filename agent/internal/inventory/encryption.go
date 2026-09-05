package inventory

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// Whether this machine's disks are encrypted.
//
// Read from the machine rather than asked of it: lsblk names every block
// device and says which are LUKS, and the crypttab says which the machine
// unlocks at boot. Nothing here can unlock or read anything — it is the
// answer to "is this laptop encrypted", which is a question somebody is
// eventually made to answer about every machine in the estate.

// Volume is one block device and what is known about its encryption.
type Volume struct {
	// The device as the kernel names it, e.g. /dev/nvme0n1p3.
	Device string `json:"device"`
	// LUKS1, LUKS2, or empty for a device that is not encrypted.
	Format string `json:"format,omitempty"`
	// Where it ends up when unlocked, e.g. /dev/mapper/nvme0n1p3_crypt.
	Holder string `json:"holder,omitempty"`
	// What is mounted from it, so an operator can tell the root disk from a
	// memory stick somebody left in.
	MountPoint string `json:"mount_point,omitempty"`
	SizeBytes  int64  `json:"size_bytes,omitempty"`
	Encrypted  bool   `json:"encrypted"`
	// Whether it is unlocked at boot from crypttab, which is what makes it
	// the machine's own disk rather than something plugged in.
	AtBoot bool `json:"at_boot"`
	// Free key slots, so the console can say whether a recovery key could be
	// escrowed without trying.
	FreeKeySlots int `json:"free_key_slots,omitempty"`
}

// Encryption walks the machine's block devices. Never fails the check-in: a
// machine with no cryptsetup on it reports no encrypted volumes, which is
// true.
func Encryption(ctx context.Context, env apply.Env) []Volume {
	if env.Run == nil {
		return nil
	}
	out, err := env.Run.Run(ctx, "lsblk", "-b", "-P", "-o",
		"NAME,PATH,FSTYPE,TYPE,SIZE,MOUNTPOINT,PKNAME")
	if err != nil {
		return nil
	}
	booted := crypttabDevices(env)

	var volumes []Volume
	holders := map[string]string{} // parent device -> the mapper name over it
	rows := []map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		fields := lsblkFields(line)
		if len(fields) == 0 {
			continue
		}
		rows = append(rows, fields)
		if fields["TYPE"] == "crypt" && fields["PKNAME"] != "" {
			holders["/dev/"+fields["PKNAME"]] = fields["PATH"]
		}
	}
	for _, fields := range rows {
		if fields["TYPE"] != "part" && fields["TYPE"] != "disk" {
			continue
		}
		encrypted := strings.HasPrefix(strings.ToLower(fields["FSTYPE"]), "crypto_luks")
		if !encrypted && fields["MOUNTPOINT"] == "" && fields["TYPE"] == "disk" {
			continue // a whole disk whose partitions are the interesting part
		}
		volume := Volume{
			Device:     fields["PATH"],
			Encrypted:  encrypted,
			MountPoint: fields["MOUNTPOINT"],
			SizeBytes:  parseInt(fields["SIZE"]),
		}
		if encrypted {
			volume.Holder = holders[fields["PATH"]]
			volume.Format, volume.FreeKeySlots = luksDetail(ctx, env, fields["PATH"])
			volume.AtBoot = booted[fields["PATH"]] ||
				booted[filepath.Base(fields["PATH"])]
		}
		volumes = append(volumes, volume)
	}
	return volumes
}

// luksDetail asks cryptsetup what the header says. Header only — it never
// touches a key.
func luksDetail(ctx context.Context, env apply.Env, device string) (string, int) {
	out, err := env.Run.Run(ctx, "cryptsetup", "luksDump", device)
	if err != nil {
		return "LUKS", 0
	}
	format := "LUKS"
	used := 0
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Version:") {
			if strings.Contains(trimmed, "2") {
				format = "LUKS2"
			} else {
				format = "LUKS1"
			}
		}
		// LUKS1 prints "Key Slot 0: ENABLED"; LUKS2 lists slots by number
		// under "Keyslots:".
		if strings.HasPrefix(trimmed, "Key Slot") && strings.Contains(trimmed, "ENABLED") {
			used++
		}
		if format == "LUKS2" && strings.HasSuffix(trimmed, ": luks2") {
			used++
		}
	}
	// Both formats have eight usable slots in the layouts Debian creates.
	free := 8 - used
	if free < 0 {
		free = 0
	}
	return format, free
}

// crypttabDevices is what the machine unlocks for itself at boot.
func crypttabDevices(env apply.Env) map[string]bool {
	found := map[string]bool{}
	file, err := os.Open(env.Path("/etc/crypttab"))
	if err != nil {
		return found
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		source := fields[1]
		found[source] = true
		// UUID=... is the usual form; resolve it the way the machine does.
		if value, ok := strings.CutPrefix(source, "UUID="); ok {
			if resolved, err := os.Readlink(env.Path("/dev/disk/by-uuid/" + value)); err == nil {
				found[filepath.Base(resolved)] = true
			}
		}
	}
	return found
}

// lsblkFields reads one KEY="value" line of lsblk -P output.
func lsblkFields(line string) map[string]string {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	fields := map[string]string{}
	for _, pair := range splitQuoted(line) {
		key, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		fields[key] = strings.Trim(value, `"`)
	}
	if fields["PATH"] == "" {
		return nil
	}
	return fields
}

// splitQuoted splits on spaces that are not inside quotes, because a mount
// point can legitimately contain one.
func splitQuoted(line string) []string {
	var parts []string
	var current strings.Builder
	inQuotes := false
	for _, r := range line {
		switch {
		case r == '"':
			inQuotes = !inQuotes
			current.WriteRune(r)
		case r == ' ' && !inQuotes:
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	return parts
}

func parseInt(value string) int64 {
	var out int64
	for _, r := range value {
		if r < '0' || r > '9' {
			return out
		}
		out = out*10 + int64(r-'0')
	}
	return out
}
