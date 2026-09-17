import { C, Details, Example, Note, Quickstart, Reference, Section, Where } from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "monitoring",
  title: "Monitoring",
  section: "Network services",
  summary: "Metrics from every machine, rules that raise alerts, channels that carry them, dashboards to watch — and a screen on a wall.",
  keywords: [
    "monitoring", "metrics", "alerts", "dashboard", "probe", "ping", "maintenance window",
    "ntfy", "webhook", "cpu", "disk full", "temperature", "zabbix", "wall", "kiosk",
  ],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Install the <strong>Monitoring</strong> role on any joined server. From the next policy
          refresh every machine in the domain reports its processor, load, memory, swap, each
          filesystem, network rates, hottest sensor and uptime once a minute; the machine carrying
          the role also runs <em>probes</em> against things with no agent — a switch, a printer, a
          web page. Seven rules and an Overview dashboard are there from the first minute.
        </p>

        <Example title="Be told on your phone when a disk is nearly full">
          <strong>Monitoring → Channels → New channel</strong>, kind <em>Phone</em>, then{" "}
          <strong>Scan</strong> with the ntfy app. <strong>Rules</strong> → edit{" "}
          <em>Filesystem almost full</em> → tick the channel under <strong>Tell</strong>.
        </Example>
        <Example title="Watch the file servers on a screen">
          <strong>Hosts &amp; groups → New group</strong> with the file servers in it.{" "}
          <strong>Dashboards → New dashboard → Design</strong>, add charts scoped to the group,
          save, <strong>Share as a link</strong>, and open the link on the screen.
        </Example>
        <Example title="Patch a server without a page at 3 a.m.">
          <strong>Maintenance → New window</strong> for that machine and the hours of the work.
          Alerts are still recorded; nobody is told.
        </Example>

        <Where>Monitoring, once the role is installed anywhere.</Where>
      </Quickstart>

      <Details>
        <Section title="What is measured">
          <Reference
            headers={["Metric", "Read from", "Means"]}
            rows={[
              ["Processor busy %", "/proc/stat", "Busy jiffies over the interval, all cores together."],
              ["Load average", "/proc/loadavg", "The one-minute load, and the process count beside it."],
              ["Memory used %, Swap used %", "/proc/meminfo", "Against MemAvailable, which counts cache as free — a machine at 90% here is actually short."],
              ["Filesystem used %, free (per mount)", "statfs on each real filesystem", "One series per mount; tmpfs and the kernel's own filesystems are left out."],
              ["Network received / sent", "/proc/net/dev", "Bytes per second across every interface but loopback and container bridges."],
              ["Hottest sensor", "/sys/class/thermal, hwmon", "The highest temperature any sensor reports."],
              ["Reporting", "the report itself", "1 whenever a report arrives. The rule Machine not reporting watches its absence."],
              ["Probe answered, latency", "the monitoring node", "Whether the target answered, and how fast, reported under the target's name."],
            ]}
          />
          <p>
            Samples are kept for fourteen days. This is a working set, not an archive: enough to
            look back over a fortnight on a chart, and small enough that PostgreSQL answers
            &ldquo;draw the last six hours for these machines&rdquo; in the time the page takes to
            draw.
          </p>
        </Section>

        <Section title="Rules and alerts">
          <p>
            A rule is a metric, a comparison, a threshold, how long the condition has to hold, a
            severity, where it applies and who to tell. It is looked at every half minute. When
            every sample in the window breaks the rule — and the window is actually covered, so a
            single bad reading at the start of a gap is not read as an hour-long condition — an
            alert opens for that machine and that series; when the samples come back within
            limits, it resolves. Both transitions are told to the rule&rsquo;s channels.
          </p>
          <Reference
            headers={["Field", "Notes"]}
            rows={[
              ["Metric", <>A family ending in <C key="a">:</C> — <C key="b">disk_percent:</C> — alerts once per series. Narrow it to one by typing the suffix: <C key="c">disk_percent:/srv</C>.</>],
              ["For", "Seconds the condition must hold. 0 fires on the first sample that breaks it."],
              ["Where", "Every machine, a group, or one machine. A probe rule's machine is the probe's target."],
              ["Machine not reporting", "The one rule read the other way: it fires when a machine that used to report has sent nothing for the window."],
            ]}
          />
        </Section>

        <Section title="Channels">
          <p>
            A channel is who hears about an alert. A <strong>phone</strong> channel is an ntfy topic
            on the controller&rsquo;s own notification server &mdash; the same one that carries
            sign-in approvals &mdash; with a code to scan; every phone that scans it gets every
            alert sent there. A <strong>webhook</strong> posts JSON (<C>title</C>, <C>message</C>,{" "}
            <C>rule</C>, <C>severity</C>, <C>resolved</C>) to a URL. A channel set to{" "}
            <em>critical only</em> ignores warnings. <strong>Send test</strong> proves the path.
          </p>
          <Note>
            A phone channel needs phone approvals set up on the controller (setup does this).
            Without it the channel is listed as unavailable and nothing is sent. A phone that
            reaches the controller through a router rather than on the office network is given
            the public address instead &mdash; <strong>Address phones use</strong> on the channel,
            the name and the port forwarded to 8444 &mdash; the same setting the second-factor
            policy offers.
          </Note>
        </Section>

        <Section title="Dashboards">
          <p>
            A dashboard is a grid of widgets: a chart of a metric over time for every machine, a
            group or one machine; the current value; the machine table; open alerts; a block of
            text. <strong>Design</strong> adds, removes, reorders and resizes them with a live
            preview; the layout is saved as data, so what the designer shows is exactly what the
            page shows. One dashboard is the default and opens first.
          </p>
          <p>
            <strong>Share as a link</strong> gives a dashboard a URL of the form{" "}
            <C>/view/&lt;token&gt;</C> that works with no sign-in — for a screen on a wall. The
            token is as long as a session&rsquo;s, and what it reaches is the dashboard&rsquo;s
            numbers and nothing else: no names of people, nothing that can be acted on.{" "}
            <strong>Stop sharing</strong> withdraws it at once. <strong>Alerts on a phone</strong>{" "}
            shows the code for the channel the dashboard names, so whoever watches the screen can
            carry its alerts too.
          </p>
        </Section>

        <Section title="Probes">
          <p>
            Run from every node carrying the role: <em>ping</em>, a <em>TCP</em> port opening, or
            an <em>HTTP</em> fetch (anything under 500 counts as answered; the certificate is not
            checked &mdash; a probe asks whether the page is there, not whether to trust it).
            Results are reported under the target&rsquo;s name, one series per kind of check
            (<C>probe_up:ping</C>, <C>probe_up:tcp-8443</C>, <C>probe_up:http</C>), so a switch
            has a row in the machine table and a rule like <em>Probe failing</em> can watch it.
          </p>
        </Section>

        <Section title="Maintenance windows">
          <p>
            A window names a scope and a start and end. Inside it, alerts for those machines open
            and resolve as usual but no channel is told; the alert list shows them marked{" "}
            <em>in maintenance</em>. Planned work is not an incident, and an on-call phone that
            learns to ignore alerts is worse than one that never rang.
          </p>
        </Section>

        <Section title="Who may see it">
          <p>
            Reading needs <C>monitor.read</C> (helpdesk and auditor have it); rules, channels,
            windows, groups, probes and dashboards need <C>monitor.write</C>. Installing the role
            is a domain administrator&rsquo;s.
          </p>
        </Section>
      </Details>
    </>
  );
}
