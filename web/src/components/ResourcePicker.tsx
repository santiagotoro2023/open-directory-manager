import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderOpen, MonitorSmartphone, Printer as PrinterIcon, Search } from "lucide-react";
import { ApiError, api, type FileShare, type Printer, type RdCollection } from "../api";
import { Loading } from "./Loading";
import { Modal } from "./Modal";

/**
 * Choosing something a server publishes, rather than typing what it is
 * probably called.
 *
 * A policy entry names a resource on a machine — a print queue, a share — and
 * the name has to be the one that machine really publishes. Typed from memory
 * it often is not: the device address where the queue name goes, the right
 * share on the wrong server, an smb:// prefix the mount does not take. These
 * pickers list what the servers report, and filling one in fills in what goes
 * with it.
 */
function PickerModal({
  title,
  searchLabel,
  placeholder,
  loading,
  error,
  count,
  empty,
  search,
  onSearch,
  onClose,
  children,
}: {
  title: string;
  searchLabel: string;
  placeholder: string;
  loading: boolean;
  error: string | null;
  count: number;
  empty: ReactNode;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} submitLabel="Close" error={error} onClose={onClose} onSubmit={onClose}>
      <div className="search">
        <Search size={15} aria-hidden="true" />
        <input
          aria-label={searchLabel}
          placeholder={placeholder}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>

      {loading ? (
        <Loading />
      ) : (
        <ul className="picker-results">
          {children}
          {count === 0 && <li className="empty">{empty}</li>}
        </ul>
      )}
    </Modal>
  );
}

/** Matches every word typed against everything the row shows. */
function matcher(search: string) {
  const needle = search.trim().toLowerCase();
  return (haystack: string[]) =>
    !needle || haystack.join(" ").toLowerCase().includes(needle);
}

export function PrinterPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (printer: { name: string; server: string }) => void;
}) {
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.printers
      .list()
      .then((result) => setPrinters(result.printers))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : String(err));
        setPrinters([]);
      });
  }, []);

  const matches = useMemo(() => {
    const ok = matcher(search);
    return (printers ?? []).filter((printer) =>
      ok([printer.name, printer.node_fqdn, printer.location, printer.description]),
    );
  }, [printers, search]);

  return (
    <PickerModal
      title="Choose a printer"
      searchLabel="Search printers"
      placeholder="Name, server or location"
      loading={printers === null}
      error={error}
      count={matches.length}
      empty="No printer here. Add one under Printers first; its server needs the print-server role."
      search={search}
      onSearch={setSearch}
      onClose={onClose}
    >
      {matches.map((printer) => (
        <li key={printer.id}>
          <button
            type="button"
            onClick={() => onPick({ name: printer.name, server: printer.node_fqdn })}
          >
            <PrinterIcon size={15} aria-hidden="true" />
            {printer.name}
            <span className="secondary">
              {printer.node_fqdn}
              {printer.location ? ` · ${printer.location}` : ""}
            </span>
          </button>
        </li>
      ))}
    </PickerModal>
  );
}

export function SharePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (share: { unc: string; name: string; server: string }) => void;
}) {
  const [shares, setShares] = useState<FileShare[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shares
      .list()
      .then((result) => setShares(result.shares))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : String(err));
        setShares([]);
      });
  }, []);

  const matches = useMemo(() => {
    const ok = matcher(search);
    return (shares ?? []).filter((share) =>
      ok([share.name, share.node_fqdn, share.path, share.comment]),
    );
  }, [shares, search]);

  return (
    <PickerModal
      title="Choose a share"
      searchLabel="Search shares"
      placeholder="Name, server or path"
      loading={shares === null}
      error={error}
      count={matches.length}
      empty="No share here. Add one under File Shares first; its server needs the file-server role."
      search={search}
      onSearch={setSearch}
      onClose={onClose}
    >
      {matches.map((share) => (
        <li key={share.id}>
          <button
            type="button"
            onClick={() =>
              onPick({
                // What the server publishes it as, so the mount is the one the
                // console can see rather than one spelled from memory.
                unc: share.unc || `//${share.node_fqdn}/${share.name}`,
                name: share.name,
                server: share.node_fqdn,
              })
            }
          >
            <FolderOpen size={15} aria-hidden="true" />
            {share.name}
            <span className="secondary">
              {share.node_fqdn}
              {share.read_only ? " · read-only" : ""}
              {share.state !== "active" ? ` · ${share.state}` : ""}
            </span>
          </button>
        </li>
      ))}
    </PickerModal>
  );
}

export function CollectionPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (collection: { name: string; address: string; application: string }) => void;
}) {
  const [collections, setCollections] = useState<RdCollection[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.rd
      .list()
      .then((result) => setCollections(result.collections))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : String(err));
        setCollections([]);
      });
  }, []);

  const matches = useMemo(() => {
    const ok = matcher(search);
    return (collections ?? []).filter((collection) =>
      ok([collection.name, collection.broker_fqdn, collection.description, collection.app_name]),
    );
  }, [collections, search]);

  return (
    <PickerModal
      title="Choose a collection"
      searchLabel="Search collections"
      placeholder="Name, broker or application"
      loading={collections === null}
      error={error}
      count={matches.length}
      empty="No collection yet. Add one under Remote Desktop first."
      search={search}
      onSearch={setSearch}
      onClose={onClose}
    >
      {matches.map((collection) => (
        <li key={collection.id}>
          <button
            type="button"
            onClick={() =>
              onPick({
                name: collection.name,
                address: collection.broker_fqdn,
                // A published application rather than a whole desktop: the
                // file has to say which, and the collection knows.
                application: collection.kind === "remoteapp" ? collection.app_name : "",
              })
            }
          >
            <MonitorSmartphone size={15} aria-hidden="true" />
            {collection.name}
            <span className="secondary">
              {collection.broker_fqdn || "no broker yet"}
              {collection.kind === "remoteapp" ? " · application" : " · desktop"}
            </span>
          </button>
        </li>
      ))}
    </PickerModal>
  );
}
