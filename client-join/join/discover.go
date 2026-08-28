package join

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
)

var hostnamePattern = regexp.MustCompile(
	`^(?i)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$`,
)

func validHostname(name string) bool {
	return len(name) > 0 && len(name) <= 253 && hostnamePattern.MatchString(name)
}

// Controller is one domain controller found through DNS.
type Controller struct {
	Host     string
	Port     int
	Priority uint16
	Weight   uint16
}

// DiscoverControllers resolves the domain's LDAP service records, which is
// how a client locates a domain it has only been given the name of.
func DiscoverControllers(ctx context.Context, domain string) ([]Controller, error) {
	resolver := net.Resolver{}
	_, records, err := resolver.LookupSRV(ctx, "ldap", "tcp", domain)
	if err != nil {
		return nil, fmt.Errorf(
			"cannot find %s: no _ldap._tcp service records (%w)", domain, err,
		)
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("cannot find %s: no domain controllers advertised", domain)
	}

	found := SelectControllers(records)
	if len(found) == 0 {
		return nil, fmt.Errorf("cannot find %s: no usable service records", domain)
	}
	return found, nil
}

// SelectControllers turns service records into an ordered list: lowest
// priority first, then highest weight, as SRV selection requires. Records
// naming something that is not a host name are dropped.
func SelectControllers(records []*net.SRV) []Controller {
	found := make([]Controller, 0, len(records))
	for _, record := range records {
		if record == nil {
			continue
		}
		host := strings.TrimSuffix(record.Target, ".")
		if !validHostname(host) {
			continue
		}
		found = append(found, Controller{
			Host:     host,
			Port:     int(record.Port),
			Priority: record.Priority,
			Weight:   record.Weight,
		})
	}
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].Priority != found[j].Priority {
			return found[i].Priority < found[j].Priority
		}
		return found[i].Weight > found[j].Weight
	})
	return found
}
