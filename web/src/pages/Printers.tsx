import { useCallback, useEffect, useState } from "react";
import { Plus, Printer as PrinterIcon } from "lucide-react";
import { ApiError, api, type Printer } from "../api";
import { useContextMenu } from "../components/ContextMenu";
import { Field, Modal } from "../components/Modal";
import { PickerField } from "../components/Picker";
import Select from "../components/Select"

const STATE_BADGE: Record<string, string> = {
  active: "success",
  failed: "failure",
  applying: "",
  pending: "",
};

export function Printers() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [open, setOpen] = useState<Printer | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Printer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { bind, menu } = useContextMenu();

  const load = useCallback(async () => {
    setError(null);
    try {
      setPrinters((await api.printers.list()).printers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A printer becomes real on the print server's next check-in.
  useEffect(() => {
    if (!printers.some((printer) => printer.state === "applying")) return;
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [printers, load]);

  return (
    <main className="content">
      <div className="page-header">
        <h1>Printers</h1>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          <Plus size={15} aria-hidden="true" />
          New printer
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <table className="data">
        <thead>
          <tr>
            <th scope="col">Printer</th>
            <th scope="col">Server</th>
            <th scope="col">Where</th>
            <th scope="col">Driver</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {printers.map((printer) => (
            <tr
              key={printer.id}
              onClick={() => setOpen(printer)}
              {...bind([
                { label: printer.name, heading: true },
                { label: "Settings…", onSelect: () => setOpen(printer) },
                { separator: true },
                { label: "Remove", danger: true, onSelect: () => setRemoving(printer) },
              ])}
            >
              <td>
                <PrinterIcon size={15} aria-hidden="true" />
                {printer.name}
                {printer.description && <p className="muted">{printer.description}</p>}
              </td>
              <td className="mono">{printer.node_fqdn}</td>
              <td>{printer.location || "—"}</td>
              <td>{printer.has_ppd ? printer.ppd_name || "PPD" : "Driverless"}</td>
              <td>
                <span className={`badge ${STATE_BADGE[printer.state] ?? ""}`}>{printer.state}</span>
                {printer.last_error && <p className="muted">{printer.last_error}</p>}
              </td>
            </tr>
          ))}
          {printers.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                No printers yet. A server needs the print-server role before it can carry one.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">Handing printers out</h3>
      <p className="muted">
        A printer here exists on its server. Which people get it is a policy decision:{" "}
        <strong>Group Policy</strong> → the policy object → <strong>User</strong> →{" "}
        <strong>Printers</strong>, naming the printer and the group it is for.
      </p>

      {menu}

      {(creating || open) && (
        <PrinterDialog
          printer={open ?? undefined}
          onClose={() => {
            setCreating(false);
            setOpen(null);
          }}
          onSaved={() => {
            setCreating(false);
            setOpen(null);
            void load();
          }}
        />
      )}

      {removing && (
        <Modal
          title={`Remove ${removing.name}?`}
          submitLabel="Remove"
          onClose={() => setRemoving(null)}
          onSubmit={async () => {
            await api.printers.remove(removing.id).catch(() => undefined);
            setRemoving(null);
            void load();
          }}
        >
          <p>
            The queue is removed from {removing.node_fqdn}. Policy objects that hand this printer
            out still name it, so check them if the printer is not being replaced.
          </p>
        </Modal>
      )}
    </main>
  );
}

function PrinterDialog({
  printer,
  onClose,
  onSaved,
}: {
  printer?: Printer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = printer !== undefined;
  const [node, setNode] = useState(printer?.node_fqdn ?? "");
  const [name, setName] = useState(printer?.name ?? "");
  const [deviceUri, setDeviceUri] = useState(printer?.device_uri ?? "");
  const [devices, setDevices] = useState<{ uri: string; description: string }[]>([]);

  // Whatever the chosen server can currently see. Re-asked when the server
  // changes, because the answer belongs to that machine.
  useEffect(() => {
    if (!node) {
      setDevices([]);
      return;
    }
    api.printers
      .devices(node)
      .then((result) => setDevices(result.devices))
      .catch(() => setDevices([]));
  }, [node]);
  const [description, setDescription] = useState(printer?.description ?? "");
  const [location, setLocation] = useState(printer?.location ?? "");
  const [driverless, setDriverless] = useState(!printer?.has_ppd);
  const [ppd, setPpd] = useState("");
  const [ppdName, setPpdName] = useState(printer?.ppd_name ?? "");
  const [duplex, setDuplex] = useState(printer?.duplex ?? false);
  const [colour, setColour] = useState(printer?.colour ?? true);
  const [shared, setShared] = useState(printer?.shared ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readPpd(file: File) {
    setPpdName(file.name);
    setPpd(await file.text());
  }

  return (
    <Modal
      title={editing ? printer.name : "New printer"}
      submitLabel={editing ? "Save" : "Create"}
      busy={busy}
      error={error}
      wide
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const shape = {
            description,
            location,
            ppd: driverless ? null : ppd || null,
            ppd_name: driverless ? "" : ppdName,
            duplex,
            colour,
            shared,
          };
          if (editing) {
            await api.printers.update({ id: printer.id, device_uri: deviceUri, ...shape });
          } else {
            await api.printers.create({
              node_fqdn: node,
              name,
              device_uri: deviceUri,
              ...shape,
            });
          }
          onSaved();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {editing ? (
        <p className="mono muted">{printer.uri}</p>
      ) : (
        <>
          <Field label="Print server" hint="A machine carrying the print-server role">
            <PickerField
              kind="computer"
              as="host"
              ariaLabel="Print server"
              value={node}
              required
              placeholder="print01.corp.example.internal"
              onChange={setNode}
            />
          </Field>
          <Field label="Name" hint="What people see, and part of the printer's address">
            <input
              value={name}
              required
              placeholder="finance-mfp"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </>
      )}

      {/* What that server can actually see, reported with its inventory. The
          field stays typeable: a printer that is off, or on another subnet,
          will not be in the list and still has a working address. */}
      <Field
        label="Device address"
        hint={
          devices.length > 0
            ? "Choose one the server found, or type an address."
            : "How the server reaches the printer, e.g. ipp://10.10.0.31/ipp/print"
        }
      >
        <div className="with-suggestions">
          <input
            value={deviceUri}
            required
            placeholder="ipp://10.10.0.31/ipp/print"
            onChange={(e) => setDeviceUri(e.target.value)}
          />
          <Select
            aria-label="Printers this server found"
            value=""
            disabled={devices.length === 0}
            onChange={(e) => e.target.value && setDeviceUri(e.target.value)}
          >
            <option value="">
              {devices.length === 0 ? "None found" : `Found (${devices.length})`}
            </option>
            {devices.map((device) => (
              <option key={device.uri} value={device.uri}>
                {device.description || device.uri}
              </option>
            ))}
          </Select>
        </div>
      </Field>

      <div className="inline-fields">
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Location">
          <input
            value={location}
            placeholder="Second floor, east"
            onChange={(e) => setLocation(e.target.value)}
          />
        </Field>
      </div>

      <h3 className="section-title">Driver</h3>
      <label className="checkbox">
        <input type="radio" checked={driverless} onChange={() => setDriverless(true)} />
        Driverless — the server works the printer out itself
      </label>
      <label className="checkbox">
        <input type="radio" checked={!driverless} onChange={() => setDriverless(false)} />
        Upload a PPD
      </label>
      {!driverless && (
        <Field label="PPD file" hint={ppdName || "The printer's .ppd, from its manufacturer"}>
          <input
            type="file"
            accept=".ppd,.PPD,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readPpd(file);
            }}
          />
        </Field>
      )}

      <h3 className="section-title">Defaults</h3>
      <label className="checkbox">
        <input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} />
        Print on both sides
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={colour} onChange={(e) => setColour(e.target.checked)} />
        Colour
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Visible to the network
      </label>
    </Modal>
  );
}
