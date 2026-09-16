import { useEffect, useState } from "react";
import { ApiError, api, type DirectoryObject } from "../api";
import { FileInput } from "./FileInput";
import { Field, Modal } from "./Modal";
import { PhotoCropper } from "./PhotoCropper";
import { ContainerPicker } from "./Picker";

const UF_ACCOUNTDISABLE = 0x0002;

export function isDisabled(object: DirectoryObject): boolean {
  const uac = Number(object.userAccountControl ?? 0);
  return Boolean(uac & UF_ACCOUNTDISABLE);
}

export const GROUP_SCOPES: Record<number, string> = {
  [-2147483646]: "Global",
  [-2147483644]: "Domain local",
  [-2147483640]: "Universal",
};

export const GROUP_KIND_LABELS: Record<string, string> = {
  user: "User group",
  computer: "Computer group",
};

// Mirrors the per-type allow-lists the API enforces; anything else is
// rejected server-side, so the form never offers it.
export const EDITABLE: Record<string, { attribute: string; label: string }[]> = {
  user: [
    { attribute: "givenName", label: "First name" },
    { attribute: "sn", label: "Last name" },
    { attribute: "displayName", label: "Display name" },
    { attribute: "userPrincipalName", label: "User principal name" },
    { attribute: "mail", label: "E-mail" },
    { attribute: "telephoneNumber", label: "Telephone" },
    { attribute: "title", label: "Title" },
    { attribute: "department", label: "Department" },
    { attribute: "company", label: "Company" },
    { attribute: "physicalDeliveryOfficeName", label: "Office" },
    { attribute: "description", label: "Description" },
  ],
  group: [
    { attribute: "description", label: "Description" },
    { attribute: "mail", label: "E-mail" },
  ],
  computer: [
    { attribute: "dNSHostName", label: "DNS host name" },
    { attribute: "description", label: "Description" },
  ],
  ou: [{ attribute: "description", label: "Description" }],
};

export function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The picture every machine shows for this person.
 *
 * It lives on the account in the directory, so it is the same picture wherever
 * they sign in — a picture set in a desktop's own settings stays on that
 * desktop. */
export function PhotoDialog({
  dn,
  onClose,
  onSaved,
}: {
  dn: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [chosen, setChosen] = useState<File | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <Modal
      title="Picture"
      submitLabel={removing ? "Remove" : "Save"}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.setPhoto(dn, removing ? "" : (photo ?? ""));
          onSaved();
          onClose();
        })
      }
    >
      <Field
        label="Picture"
        hint="Shown at the login screen and in the desktop, on every machine they sign in to"
      >
        <FileInput
          accept="image/jpeg,image/png"
          placeholder={chosen?.name ?? "No picture chosen"}
          onChoose={(file) => {
            setChosen(file);
            setRemoving(false);
          }}
        />
      </Field>

      {chosen && !removing && <PhotoCropper file={chosen} onCropped={setPhoto} />}

      {removing && <p className="muted">The picture will be removed when this is saved.</p>}

      <div className="actions-row">
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setRemoving(true);
            setChosen(null);
            setPhoto(null);
          }}
        >
          Remove the picture
        </button>
      </div>
    </Modal>
  );
}

export function PasswordDialog({ dn, onClose }: { dn: string; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const { busy, error, run } = useAction();

  return (
    <Modal
      title="Reset password"
      submitLabel="Reset"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.setPassword(dn, password, mustChange);
          onClose();
        })
      }
    >
      <Field label="New password">
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          required
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={mustChange}
          onChange={(e) => setMustChange(e.target.checked)}
        />
        User must change password at next logon
      </label>
    </Modal>
  );
}

/** A message on the screens of whoever is signed in at one machine or many
 *  — what `msg` did on Windows. */
export function MessageDialog({
  dns,
  label,
  onClose,
  onDone,
}: {
  dns: string[];
  /** What the dialog says it is sending to: a host name, or "12 machines". */
  label: string;
  onClose: () => void;
  onDone?: (summary: string) => void;
}) {
  const [title, setTitle] = useState("Message from IT");
  const [text, setText] = useState("");
  const [urgency, setUrgency] = useState<"normal" | "critical">("normal");
  const { busy, error, run } = useAction();

  return (
    <Modal
      title={`Send a message to ${label}`}
      submitLabel="Send"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          const result = await api.servers.message(dns, title, text, urgency);
          const summary =
            `Sent to ${result.queued.length} machine${result.queued.length === 1 ? "" : "s"}` +
            (result.missing.length ? `; ${result.missing.length} never reported and got nothing.` : ".");
          onDone?.(summary);
          onClose();
        })
      }
    >
      <p className="muted">
        A notification on every desktop that is signed in, and a line on every terminal, within a
        second. It is in the audit log; nothing stays on the machine.
      </p>
      <Field label="Title">
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Message">
        <textarea
          value={text}
          rows={4}
          maxLength={1000}
          required
          placeholder="The file server restarts at 18:00. Save your work before then."
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={urgency === "critical"}
          onChange={(e) => setUrgency(e.target.checked ? "critical" : "normal")}
        />
        Stays on screen until dismissed
      </label>
    </Modal>
  );
}

export function OffboardDialog({
  dn,
  name,
  onClose,
  onDone,
}: {
  dn: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [disable, setDisable] = useState(true);
  const [stripGroups, setStripGroups] = useState(true);
  const [scramble, setScramble] = useState(true);
  const [moveTo, setMoveTo] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string[] | null>(null);
  const { busy, error, run } = useAction();

  if (done) {
    return (
      <Modal title={`${name} has left`} submitLabel="Close" onClose={onDone} onSubmit={onDone}>
        <p className="muted">
          {done.length === 0
            ? "The account was left in no groups."
            : `Taken out of ${done.length} group${done.length === 1 ? "" : "s"}:`}
        </p>
        {done.length > 0 && <p className="mono">{done.join(", ")}</p>}
        <p className="muted">
          Everything here is in the audit log, and the account still owns what it owned.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Offboard ${name}`}
      submitLabel="Offboard"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          const result = await api.directory.offboard({
            dn,
            disable,
            strip_groups: stripGroups,
            scramble_password: scramble,
            move_to: moveTo,
            note,
          });
          setDone(result.left_groups);
        })
      }
    >
      <p className="muted">
        The account is kept, not deleted: it still owns its files and its history.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={disable} onChange={(e) => setDisable(e.target.checked)} />
        Disable the account
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={stripGroups}
          onChange={(e) => setStripGroups(e.target.checked)}
        />
        Remove from every group
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={scramble} onChange={(e) => setScramble(e.target.checked)} />
        Set a password nobody knows
      </label>
      <Field label="Move to" hint="Optional. Where leavers are kept.">
        <input
          value={moveTo}
          placeholder="OU=Leavers,DC=corp,DC=example,DC=internal"
          onChange={(e) => setMoveTo(e.target.value)}
        />
      </Field>
      <Field label="Note" hint="Recorded in the audit log">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function MoveDialog({
  object,
  onClose,
  onMoved,
}: {
  object: DirectoryObject;
  onClose: () => void;
  onMoved: (moved: DirectoryObject) => void;
}) {
  const dn = object.distinguishedName;
  const { busy, error, run } = useAction();

  return (
    <ContainerPicker
      title={`Move ${String(object.ou ?? object.cn ?? object.name ?? "")}`}
      submitLabel="Move here"
      exclude={dn}
      busy={busy}
      error={error}
      onClose={onClose}
      onPick={(target) => void run(async () => onMoved(await api.directory.move(dn, target)))}
    />
  );
}

export function MembersDialog({
  group,
  onClose,
  onChanged,
}: {
  group: DirectoryObject;
  onClose: () => void;
  onChanged: (updated: DirectoryObject) => void;
}) {
  const dn = group.distinguishedName;
  const [members, setMembers] = useState<string[]>((group.member as string[] | undefined) ?? []);
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<DirectoryObject[]>([]);
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (search.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const wanted = group.groupKind === "computer" ? "computer" : "user";
    const timer = setTimeout(() => {
      void api.directory
        .list({ query: search, scope: "subtree" })
        .then((result) =>
          // A user group offers people and other groups; a computer group
          // offers machines and other groups.
          setCandidates(
            result.objects.filter(
              (object) => object.objectType === wanted || object.objectType === "group",
            ),
          ),
        )
        .catch(() => setCandidates([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, group.groupKind]);

  const pending = [...members.filter((m) => !remove.includes(m)), ...add];

  return (
    <Modal
      title={`Members of ${String(group.cn ?? "")}`}
      submitLabel="Apply"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          const updated = await api.directory.editMembers(dn, add, remove);
          setMembers((updated.member as string[] | undefined) ?? []);
          onChanged(updated);
          onClose();
        })
      }
    >
      <Field
        label="Add member"
        hint={
          group.groupKind === "computer"
            ? "Search computers and groups by name"
            : "Search users and groups by name"
        }
      >
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      {candidates.length > 0 && (
        <ul className="picker">
          {candidates.map((c) => (
            <li key={c.distinguishedName}>
              <button
                type="button"
                className="ghost"
                disabled={pending.includes(c.distinguishedName)}
                onClick={() => setAdd([...add, c.distinguishedName])}
              >
                {String(c.sAMAccountName ?? c.cn)} — {c.objectType}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="muted">{pending.length} members</p>
      <ul className="member-list">
        {pending.map((member) => (
          <li key={member}>
            <span className="mono">{member}</span>
            <button
              type="button"
              className="icon"
              aria-label={`Remove ${member}`}
              onClick={() =>
                add.includes(member)
                  ? setAdd(add.filter((m) => m !== member))
                  : setRemove([...remove, member])
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function DeleteDialog({
  object,
  onClose,
  onDeleted,
}: {
  object: DirectoryObject;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <Modal
      title="Delete object"
      submitLabel="Delete"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.remove(object.distinguishedName);
          onDeleted();
        })
      }
    >
      <p>
        Delete <strong>{String(object.cn ?? object.ou)}</strong>?
      </p>
      <p className="muted mono">{object.distinguishedName}</p>
      <p className="muted">
        The object is snapshotted to the recycle bin before removal and can be restored within the
        retention window.
      </p>
    </Modal>
  );
}

/** Take every second factor off one account — code and phone alike.
 *
 * The fresh start for somebody who has lost their phone, or set the wrong one
 * up: their next sign-in under a policy that asks for one walks them through
 * it again. Nothing to type; the confirmation is the whole dialog. */
export function SecondFactorResetDialog({
  dn,
  name,
  onClose,
}: {
  dn: string;
  name: string;
  onClose: () => void;
}) {
  const { busy, error, run } = useAction();
  const [state, setState] = useState<{ code: boolean; phone: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    api.directory
      .secondFactor(dn)
      .then((result) => current && setState(result))
      .catch(() => current && setState({ code: false, phone: false }));
    return () => {
      current = false;
    };
  }, [dn]);

  const has = state ? [state.code && "a code", state.phone && "a phone"].filter(Boolean) : [];

  return (
    <Modal
      title="Reset second factor"
      submitLabel="Reset"
      busy={busy || !state}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          await api.directory.resetSecondFactor(dn);
          onClose();
        })
      }
    >
      {!state ? (
        <p className="muted">Checking what is enrolled…</p>
      ) : has.length ? (
        <p>
          <strong>{name}</strong> has {has.join(" and ")} enrolled. Resetting removes{" "}
          {has.length > 1 ? "both" : "it"}; their next sign-in under a policy that asks for a
          second factor walks them through setting one up again.
        </p>
      ) : (
        <p>
          <strong>{name}</strong> has no second factor enrolled. Resetting changes nothing.
        </p>
      )}
    </Modal>
  );
}
