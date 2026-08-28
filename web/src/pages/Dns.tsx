import { useCallback, useEffect, useState } from "react";
import { Globe, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type DnsRecord, type DnsZone } from "../api";
import { Field, Modal } from "../components/Modal";

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "PTR", "SRV", "TXT"];

// Records Samba maintains itself; editing them by hand breaks the domain.
const READ_ONLY_TYPES = new Set(["SOA"]);

export function Dns() {
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [available, setAvailable] = useState(true);
  const [dialog, setDialog] = useState<"zone" | "record" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadZones = useCallback(async () => {
    setError(null);
    try {
      const status = await api.dns.status();
      setAvailable(status.available);
      if (!status.available) return;
      const result = await api.dns.zones();
      setZones(result.zones);
      setSelected((current) => current || result.zones[0]?.name || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const loadRecords = useCallback(async () => {
    if (!selected) return;
    setError(null);
    try {
      setRecords((await api.dns.zone(selected)).records);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setRecords([]);
    }
  }, [selected]);

  useEffect(() => {
    void loadZones();
  }, [loadZones]);
  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  async function removeRecord(record: DnsRecord) {
    setError(null);
    try {
      await api.dns.deleteRecord(selected, record.name, record.type, record.data);
      await loadRecords();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (!available) {
    return (
      <main className="content">
        <h1>DNS</h1>
        <p className="muted">
          DNS management needs the control plane to run on a domain controller, where samba-tool
          can reach the AD-integrated zones.
        </p>
      </main>
    );
  }

  return (
    <div className="directory">
      <nav className="tree" aria-label="DNS zones">
        <div className="toolbar">
          <button type="button" className="ghost" onClick={() => setDialog("zone")}>
            <Plus size={14} aria-hidden="true" />
            New zone
          </button>
        </div>
        <ul>
          {zones.map((zone) => (
            <li key={zone.name}>
              <button
                type="button"
                className={selected === zone.name ? "tree-label active" : "tree-label"}
                onClick={() => setSelected(zone.name)}
              >
                <Globe size={14} aria-hidden="true" />
                {zone.name}
              </button>
            </li>
          ))}
          {zones.length === 0 && <li className="muted">No zones.</li>}
        </ul>
      </nav>

      <section className="objects">
        <div className="toolbar">
          <h1>{selected || "DNS"}</h1>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            disabled={!selected}
            onClick={() => setDialog("record")}
          >
            <Plus size={14} aria-hidden="true" />
            New record
          </button>
        </div>

        {zones.find((zone) => zone.name === selected)?.dynamic_update && (
          <p className="muted">Secure dynamic updates are enabled on this zone.</p>
        )}

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <table className="data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Data</th>
              <th scope="col">TTL</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.name}-${record.type}-${index}`}>
                <td>{record.name}</td>
                <td>{record.type}</td>
                <td className="mono">{record.data}</td>
                <td>{record.ttl}</td>
                <td>
                  {!READ_ONLY_TYPES.has(record.type) && (
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Delete ${record.type} record ${record.name}`}
                      onClick={() => void removeRecord(record)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No records in this zone.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {dialog === "zone" && (
        <ZoneDialog
          onClose={() => setDialog(null)}
          onCreated={(zone) => {
            setDialog(null);
            setSelected(zone);
            void loadZones();
          }}
        />
      )}
      {dialog === "record" && (
        <RecordDialog
          zone={selected}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            void loadRecords();
          }}
        />
      )}
    </div>
  );
}

function ZoneDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (zone: string) => void;
}) {
  const [zone, setZone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="New DNS zone"
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.dns.createZone(zone);
          onCreated(zone);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Zone name" hint="Forward, e.g. lab.example.internal, or 10.in-addr.arpa">
        <input value={zone} required onChange={(e) => setZone(e.target.value)} />
      </Field>
    </Modal>
  );
}

const PLACEHOLDERS: Record<string, string> = {
  A: "10.10.0.10",
  AAAA: "2001:db8::10",
  CNAME: "dc1.corp.example.internal.",
  MX: "10 mail.corp.example.internal",
  NS: "dc1.corp.example.internal.",
  PTR: "ws01.corp.example.internal.",
  SRV: "0 100 389 dc1.corp.example.internal",
  TXT: "v=spf1 -all",
};

function RecordDialog({
  zone,
  onClose,
  onCreated,
}: {
  zone: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("A");
  const [data, setData] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`New record in ${zone}`}
      submitLabel="Create"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await api.dns.addRecord({ zone, name, type, data });
          onCreated();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" hint="Relative to the zone; @ for the zone itself">
        <input value={name} required onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {RECORD_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Data">
        <input
          value={data}
          required
          placeholder={PLACEHOLDERS[type]}
          onChange={(e) => setData(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
