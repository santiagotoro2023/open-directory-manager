import { useCallback, useEffect, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { ApiError, api, type AdmxTemplate } from "../api";
import { Field, Modal } from "./Modal";
import { FileInput } from "./FileInput";

async function base64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function TemplateManager({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<AdmxTemplate[]>([]);
  const [admxFile, setAdmxFile] = useState<File | null>(null);
  const [admlFile, setAdmlFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api.admx.templates()).templates);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload() {
    if (!admxFile) return;
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      const result = await api.admx.upload(
        admxFile.name,
        await base64(admxFile),
        admlFile ? await base64(admlFile) : undefined,
      );
      setImported(
        `${result.namespace}: ${result.policy_count} settings, ${result.applicable_count} applicable on Debian`,
      );
      setAdmxFile(null);
      setAdmlFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(template: AdmxTemplate) {
    setError(null);
    try {
      await api.admx.removeTemplate(template.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <Modal
      title="Administrative templates"
      submitLabel={busy ? "Importing…" : "Import"}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={upload}
    >
      <p className="muted">
        Upload the ADMX and its matching ADML from the vendor. Re-importing a namespace replaces the
        previous version.
      </p>

      <Field label="ADMX file">
        <FileInput accept=".admx,application/xml,text/xml" onChoose={setAdmxFile} />
      </Field>
      <Field label="ADML file" hint="Language resources; without it settings show raw identifiers">
        <FileInput accept=".adml,application/xml,text/xml" onChoose={setAdmlFile} />
      </Field>

      {imported && (
        <p className="muted">
          <Upload size={14} aria-hidden="true" /> Imported {imported}
        </p>
      )}

      <h3>Imported</h3>
      <table className="data compact">
        <thead>
          <tr>
            <th scope="col">Template</th>
            <th scope="col">Settings</th>
            <th scope="col">Applicable</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr key={template.id}>
              <td>
                <strong>{template.display_name || template.file_name}</strong>
                <p className="mono muted">{template.namespace}</p>
              </td>
              <td>{template.policy_count}</td>
              <td>{template.applicable_count}</td>
              <td>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove ${template.namespace}`}
                  onClick={() => void remove(template)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {templates.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No templates imported yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
