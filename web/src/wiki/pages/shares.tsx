import {
  C,
  Details,
  Example,
  Note,
  Quickstart,
  Reference,
  Section,
  Steps,
  Where,
} from "../components";
import type { WikiPageMeta } from "../types";

export const meta: WikiPageMeta = {
  id: "file-shares",
  title: "File shares",
  section: "Administration",
  summary: "Shared directories on any file server, and who may reach them.",
  keywords: ["share", "smb", "cifs", "acl", "permission", "file server", "samba", "setfacl"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          A share is a directory on a server, published over SMB and reachable by name as{" "}
          <C>//server/share</C>. ODM holds the definition; the server&rsquo;s agent renders it into
          the file server&rsquo;s configuration and into the directory&rsquo;s permissions on its
          next check-in.
        </p>

        <Example title="Publish a directory">
          <Steps>
            <li>
              <strong>Server Roles</strong> → <strong>File server</strong> →{" "}
              <strong>Install on a server</strong>, if that server does not carry the role yet.
            </li>
            <li>
              <strong>File Shares</strong> → <strong>New share</strong> → pick the server, name the
              share, give the directory it publishes.
            </li>
            <li>
              Add permission entries: a user or group, and one of <strong>Read</strong>,{" "}
              <strong>Read &amp; write</strong> or <strong>Full control</strong>.
            </li>
            <li>
              <strong>Create</strong>. The state moves from <C>applying</C> to <C>active</C> when
              the server&rsquo;s agent has done it.
            </li>
          </Steps>
        </Example>

        <Example title="Give a group access to an existing share">
          Open the share → <strong>Add entry</strong> → <strong>Select…</strong> → choose the group
          → set the access level → <strong>Save</strong>.
        </Example>

        <Example title="Map the share to a drive at login">
          <strong>Group Policy</strong> → the policy object → <strong>Settings</strong> →{" "}
          <strong>User</strong> → <strong>Drive maps</strong> → point it at the share&rsquo;s{" "}
          <C>//server/share</C>.
        </Example>

        <Example title="Stop sharing a directory">
          Right-click the share → <strong>Stop sharing</strong>. The directory and its contents stay
          on the server.
        </Example>

        <Example title="Choose where the share lives">
          <strong>Directory on the server</strong> → <strong>Browse…</strong> walks the server&rsquo;s
          own folders, a click at a time. <strong>New folder here</strong> creates one where you are.
          Typing a path still works; it is created if it does not exist.
        </Example>

        <Where>File Shares. The section appears once a server carries the file-server role.</Where>
      </Quickstart>

      <Details>
        <Section title="Access levels">
          <p>
            Each level is a fixed set of permissions. <strong>Applies to new files</strong> adds the
            matching default entry, so files created in the share afterwards carry it too.
          </p>
          <Reference
            headers={["Level", "On the directory", "What it allows"]}
            rows={[
              ["Read", <C key="r">r-x</C>, "List the directory and open files in it."],
              [
                "Read & write",
                <C key="w">rwx</C>,
                "Create, change and delete files in the directory.",
              ],
              [
                "Full control",
                <C key="f">rwx</C>,
                "The same, and the owner of a file may change its permissions.",
              ],
            ]}
          />
          <Note>
            Anyone not named in the list, and not the owner or in the owning group, gets nothing.
          </Note>
        </Section>

        <Section title="Where a share ends up on the server">
          <Reference
            headers={["What", "Where"]}
            rows={[
              ["The share definition", <C key="a">/etc/samba/odm-shares.conf</C>],
              ["Included from", <C key="b">/etc/samba/smb.conf</C>],
              ["Permissions", "POSIX access lists on the directory, set with setfacl"],
              ["Applied by", "the server's own agent, on its check-in interval"],
            ]}
          />
          <p>
            The include file is rewritten in full each time, so a share edited by hand on the server
            is replaced by what the console holds. Everything else in <C>smb.conf</C> is left alone.
          </p>
        </Section>

        <Section title="Clients">
          <p>
            Domain members mount shares with <C>sec=krb5</C>, so a workstation uses the user&rsquo;s
            existing Kerberos ticket and no share credential is stored on it. A drive-map policy is
            the usual way to mount one.
          </p>
        </Section>

        <Section title="If a share stays in applying">
          <Reference
            headers={["Check", "How"]}
            rows={[
              [
                "Has the server's agent checked in?",
                "Servers → the machine → Agent last reported.",
              ],
              [
                "Does the server carry the file-server role?",
                "Server Roles → File server. Without it there is no smb.conf to add the share to.",
              ],
              [
                "What did the agent say?",
                <>
                  On the server: <C key="c">journalctl -u odm-agent</C>, or{" "}
                  <C key="d">odm-agent apply --force</C> to make it try now.
                </>,
              ],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
