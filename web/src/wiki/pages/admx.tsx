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
  id: "administrative-templates",
  title: "Administrative templates",
  section: "Managing the domain",
  summary: "Import vendor ADMX and ADML files and configure their settings from generated forms.",
  keywords: ["admx", "adml", "template", "chrome", "chromium", "firefox", "vendor", "import"],
};

export function Content() {
  return (
    <>
      <Quickstart>
        <p>
          Vendors ship their policy definitions as an ADMX file and a matching ADML file of
          localised strings. Importing the pair adds those settings to the policy editor with
          controls generated from the vendor&rsquo;s own schema.
        </p>

        <Example title="Import a template">
          <Steps>
            <li>
              <strong>Group Policy</strong> → <strong>Administrative templates</strong>.
            </li>
            <li>
              Choose the <C>.admx</C> file and its <C>.adml</C>.
            </li>
            <li>
              <strong>Import</strong>. The result reports how many settings were found and how many
              apply on Debian.
            </li>
          </Steps>
        </Example>

        <Example title="Configure a setting from a template">
          Open a policy object → <strong>Settings</strong> →{" "}
          <strong>Administrative templates</strong> → <strong>Add setting</strong> → search →{" "}
          <strong>Add</strong> → set it to Enabled or Disabled and fill in its fields.
        </Example>

        <Where>
          Group Policy → Administrative templates to import; the Settings tab to configure.
        </Where>
      </Quickstart>

      <Details>
        <Section title="What is parsed">
          <Reference
            headers={["From the ADMX", "Used for"]}
            rows={[
              [
                "Target namespace and prefix",
                "Identifies the template; re-importing it supersedes the previous version.",
              ],
              ["Categories and their parents", "The category filter in the setting picker."],
              ["Policies", "One configurable setting each, with its registry key and value name."],
              [
                "Enabled and disabled values",
                "What a setting with no fields writes in each state.",
              ],
              [
                "Elements",
                "The form controls: text, multi-line text, number, checkbox, dropdown, list.",
              ],
              ["supportedOn", "The platform note shown against a setting."],
            ]}
          />
          <Reference
            headers={["From the ADML", "Used for"]}
            rows={[
              ["String table", "Setting names, category names and explanatory text."],
              ["Presentation table", "The label on each individual field."],
            ]}
          />
          <Note>
            A template imported without its ADML still works; settings appear under their raw
            identifiers instead of readable names.
          </Note>
        </Section>

        <Section title="Element types">
          <Reference
            headers={["Element", "Control", "Written as"]}
            rows={[
              ["text", "Single-line input", "A string"],
              ["multiText", "Multi-line input", "A string"],
              ["decimal", "Number input with the declared range", "A number"],
              ["boolean", "Checkbox", "true or false"],
              ["enum", "Dropdown of the declared items", "The item's value"],
              ["list", "One entry per line", "An array"],
            ]}
          />
        </Section>

        <Section title="What applies on Debian">
          <p>
            Administrative templates describe Windows registry keys. Settings under the keys below
            are translated into the managed-policy documents the browsers read. This is how browser
            policy is configured: import the template Chrome or Firefox publishes, and every setting
            arrives with its name, type and description.
          </p>
          <Reference
            headers={["Registry key", "Applied as"]}
            rows={[
              [
                <C key="1">Software\\Policies\\Google\\Chrome</C>,
                "Chromium and Chrome managed policy",
              ],
              [<C key="2">Software\\Policies\\Chromium</C>, "Chromium managed policy"],
              [<C key="3">Software\\Policies\\Mozilla\\Firefox</C>, "Firefox policies.json"],
            ]}
          />
          <p>
            Chromium reads one flat document, so a setting under a sub-key is written at the top
            level under its value name. Firefox nests, so a sub-key becomes a nested object.
          </p>
          <Note>
            A setting under any other key can still be configured, and is reported in Resultant Set
            of Policy as having no Debian equivalent rather than silently doing nothing. The setting
            picker hides these by default; clear &ldquo;Only settings ODM can apply&rdquo; to see
            them.
          </Note>
        </Section>

        <Section title="Managing templates">
          <Reference
            headers={["Action", "Effect"]}
            rows={[
              ["Import", "Adds or replaces the namespace. A newer file supersedes the older one."],
              [
                "Remove",
                "Deletes the definitions. Policy objects keep any settings that referenced them, and those settings report as belonging to a template that is not imported.",
              ],
            ]}
          />
        </Section>

        <Section title="Limits">
          <Reference
            headers={["Limit", "Value"]}
            rows={[
              ["File size", "8 MB per file"],
              ["Settings per template", "5000"],
              ["Fields per setting", "64"],
              ["Configured settings per policy object", "500"],
            ]}
          />
        </Section>
      </Details>
    </>
  );
}
