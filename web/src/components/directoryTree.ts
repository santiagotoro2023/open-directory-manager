import type { DirectoryObject } from "../api";

/**
 * What the directory tree is made of, shared by everything that draws one.
 *
 * The tree in the Directory page and the tree in a Move dialog are the same
 * tree, so what counts as a container the directory keeps for itself is
 * decided here rather than once per component — a container hidden in one
 * place and shown in the other is the same object either way.
 */

// Containers the directory keeps for its own bookkeeping. Nothing an operator
// manages lives in them, so they are out of the way until asked for. Hiding
// the container hides what is inside it: CN=Policies, and with it a folder per
// policy object named after its GUID, lives under System.
const SYSTEM_CONTAINERS = new Set([
  "keys",
  "foreignsecurityprincipals",
  "managed service accounts",
  "program data",
  "system",
  "ntds quotas",
  "infrastructure",
  "lostandfound",
  "tpm devices",
  "deleted objects",
]);

export function parentOf(dn: string): string {
  const comma = dn.indexOf(",");
  return comma === -1 ? "" : dn.slice(comma + 1);
}

export function label(node: DirectoryObject): string {
  return String(node.ou ?? node.cn ?? node.name ?? node.distinguishedName);
}

export function isSystemContainer(node: DirectoryObject): boolean {
  return SYSTEM_CONTAINERS.has(label(node).toLowerCase());
}
