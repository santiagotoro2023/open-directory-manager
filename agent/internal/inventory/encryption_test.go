package inventory

import "testing"

func TestOneLineOfLsblkIsReadIntoItsFields(t *testing.T) {
	fields := lsblkFields(
		`NAME="sda1" PATH="/dev/sda1" FSTYPE="crypto_LUKS" TYPE="part" SIZE="512110190592" ` +
			`MOUNTPOINT="" PKNAME="sda"`)
	if fields["PATH"] != "/dev/sda1" || fields["FSTYPE"] != "crypto_LUKS" {
		t.Fatalf("read as %v", fields)
	}
	if fields["MOUNTPOINT"] != "" {
		t.Errorf("an empty value was not read as empty: %v", fields)
	}
	if lsblkFields("") != nil || lsblkFields("NAME=\"x\"") != nil {
		t.Error("a line with no path is not a device")
	}
}

func TestAMountPointWithASpaceInItIsOneValue(t *testing.T) {
	fields := lsblkFields(`PATH="/dev/sdb1" TYPE="part" MOUNTPOINT="/media/My Backup" SIZE="10"`)
	if fields["MOUNTPOINT"] != "/media/My Backup" {
		t.Errorf("the mount point was split: %q", fields["MOUNTPOINT"])
	}
	if fields["SIZE"] != "10" {
		t.Errorf("the fields after it were lost: %v", fields)
	}
}

func TestASizeIsReadAsFarAsItIsANumber(t *testing.T) {
	if parseInt("512110190592") != 512110190592 {
		t.Error("a size was misread")
	}
	if parseInt("") != 0 || parseInt("12G") != 12 {
		t.Error("a value that is not all digits was misread")
	}
}
