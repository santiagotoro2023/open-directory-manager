package inventory

import (
	"context"
	"fmt"
	"strings"

	"odm.example.org/agent/internal/apply"
)

// Finding printers on the network.
//
// lpinfo asks CUPS, and CUPS answers with the backends it has rather than the
// printers it can see: a Brother sitting on the same subnet, announcing
// itself over DNS-SD and visible to avahi, did not appear at all. So ask
// avahi as well and merge the two.
//
// The services are the ones a network printer announces: IPP and IPPS for
// anything driverless, and pdl-datastream for the raw port 9100 an older
// device offers.
var printerServices = map[string]string{
	"_ipp._tcp":            "ipp",
	"_ipps._tcp":           "ipps",
	"_pdl-datastream._tcp": "socket",
}

// BrowsedPrinters asks avahi what is announcing itself as a printer.
func BrowsedPrinters(ctx context.Context, env apply.Env) []PrintDevice {
	found := []PrintDevice{}
	if env.Run == nil {
		return found
	}
	seen := map[string]bool{}
	for service, scheme := range printerServices {
		// -p is the parseable form, -r resolves each to an address, -t stops
		// when the cache is exhausted rather than browsing for ever.
		out, err := env.Run.Run(ctx, "avahi-browse", "-prt", service)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			device, ok := parseBrowse(line, scheme)
			if !ok || seen[device.URI] {
				continue
			}
			seen[device.URI] = true
			found = append(found, device)
		}
	}
	return found
}

// parseBrowse reads one resolved line of avahi-browse -p output:
//
//	=;ens18;IPv4;Brother;_ipp._tcp;local;BRW.local;192.168.1.73;631;"rp=ipp/print"
func parseBrowse(line, scheme string) (PrintDevice, bool) {
	fields := strings.Split(line, ";")
	if len(fields) < 9 || fields[0] != "=" {
		return PrintDevice{}, false
	}
	// IPv6 link-local addresses are not something to print to.
	if fields[2] != "IPv4" {
		return PrintDevice{}, false
	}
	name, address, port := unescape(fields[3]), fields[7], fields[8]
	if address == "" || port == "" {
		return PrintDevice{}, false
	}

	path := ""
	if len(fields) > 9 {
		for _, entry := range strings.Fields(strings.Join(fields[9:], " ")) {
			entry = strings.Trim(entry, `"`)
			if value, ok := strings.CutPrefix(entry, "rp="); ok {
				path = strings.TrimPrefix(value, "/")
			}
		}
	}

	uri := fmt.Sprintf("%s://%s:%s", scheme, address, port)
	if scheme != "socket" {
		uri += "/" + path
	}
	return PrintDevice{URI: uri, Description: name}, true
}

// unescape undoes avahi's \\NNN escaping of a service name.
func unescape(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			number := 0
			valid := true
			for _, digit := range value[i+1 : i+4] {
				if digit < '0' || digit > '9' {
					valid = false
					break
				}
				number = number*10 + int(digit-'0')
			}
			if valid && number < 256 {
				out.WriteByte(byte(number))
				i += 3
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}
