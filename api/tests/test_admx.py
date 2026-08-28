"""Phase 5: ADMX/ADML parsing and expansion.

The fixtures below are shaped like the files Chrome and Firefox actually
ship, cut down to the constructs that matter.
"""

from __future__ import annotations

import base64

import pytest
from conftest import BASE_DN  # noqa: F401  (keeps env setup ordering explicit)

from odm import admx

CHROME_ADMX = b"""<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0"
    xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="chrome" namespace="Google.Policies.Chrome"/>
    <using prefix="windows" namespace="Microsoft.Policies.Windows"/>
  </policyNamespaces>
  <resources minRequiredRevision="1.0"/>
  <supportedOn>
    <definitions>
      <definition name="SUPPORTED_WIN7" displayName="$(string.SUPPORTED_WIN7)"/>
    </definitions>
  </supportedOn>
  <categories>
    <category name="googlechrome" displayName="$(string.googlechrome)"/>
    <category name="startup" displayName="$(string.startup)">
      <parentCategory ref="googlechrome"/>
    </category>
  </categories>
  <policies>
    <policy name="HomepageLocation" class="Both" displayName="$(string.HomepageLocation)"
            explainText="$(string.HomepageLocation_Explain)"
            presentation="$(presentation.HomepageLocation)"
            key="Software\\Policies\\Google\\Chrome" valueName="HomepageLocation">
      <parentCategory ref="startup"/>
      <supportedOn ref="SUPPORTED_WIN7"/>
      <elements>
        <text id="HomepageLocation" valueName="HomepageLocation" required="true" maxLength="1000"/>
      </elements>
    </policy>
    <policy name="IncognitoModeAvailability" class="Machine"
            displayName="$(string.IncognitoModeAvailability)"
            presentation="$(presentation.IncognitoModeAvailability)"
            key="Software\\Policies\\Google\\Chrome" valueName="IncognitoModeAvailability">
      <parentCategory ref="googlechrome"/>
      <supportedOn ref="SUPPORTED_WIN7"/>
      <elements>
        <enum id="IncognitoModeAvailability" valueName="IncognitoModeAvailability" required="true">
          <item displayName="$(string.Enabled)"><value><decimal value="0"/></value></item>
          <item displayName="$(string.Disabled)"><value><decimal value="1"/></value></item>
        </enum>
      </elements>
    </policy>
    <policy name="URLBlocklist" class="Machine" displayName="$(string.URLBlocklist)"
            presentation="$(presentation.URLBlocklist)"
            key="Software\\Policies\\Google\\Chrome\\URLBlocklist">
      <parentCategory ref="googlechrome"/>
      <supportedOn ref="SUPPORTED_WIN7"/>
      <elements>
        <list id="URLBlocklistDesc" key="Software\\Policies\\Google\\Chrome\\URLBlocklist"
              valueName="URLBlocklist"/>
      </elements>
    </policy>
    <policy name="MetricsReportingEnabled" class="Machine"
            displayName="$(string.MetricsReportingEnabled)"
            key="Software\\Policies\\Google\\Chrome" valueName="MetricsReportingEnabled">
      <parentCategory ref="googlechrome"/>
      <supportedOn ref="SUPPORTED_WIN7"/>
      <enabledValue><decimal value="1"/></enabledValue>
      <disabledValue><decimal value="0"/></disabledValue>
    </policy>
    <policy name="WindowsOnlyThing" class="Machine" displayName="$(string.WindowsOnlyThing)"
            key="Software\\Policies\\Microsoft\\Windows\\System" valueName="Something">
      <parentCategory ref="googlechrome"/>
      <supportedOn ref="SUPPORTED_WIN7"/>
      <enabledValue><decimal value="1"/></enabledValue>
    </policy>
  </policies>
</policyDefinitions>
"""

CHROME_ADML = b"""<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources revision="1.0" schemaVersion="1.0"
    xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>Google Chrome</displayName>
  <resources>
    <stringTable>
      <string id="googlechrome">Google Chrome</string>
      <string id="startup">Startup, Home page and New Tab page</string>
      <string id="HomepageLocation">Configure the home page URL</string>
      <string id="HomepageLocation_Explain">Configures the default home page URL.</string>
      <string id="IncognitoModeAvailability">Incognito mode availability</string>
      <string id="URLBlocklist">Block access to a list of URLs</string>
      <string id="MetricsReportingEnabled">Enable reporting of usage metrics</string>
      <string id="WindowsOnlyThing">A Windows-only setting</string>
      <string id="SUPPORTED_WIN7">Microsoft Windows 7 or later</string>
      <string id="Enabled">Incognito mode available</string>
      <string id="Disabled">Incognito mode disabled</string>
    </stringTable>
    <presentationTable>
      <presentation id="HomepageLocation">
        <textBox refId="HomepageLocation"><label>Home page URL:</label></textBox>
      </presentation>
      <presentation id="IncognitoModeAvailability">
        <dropdownList refId="IncognitoModeAvailability">Availability:</dropdownList>
      </presentation>
      <presentation id="URLBlocklist">
        <listBox refId="URLBlocklistDesc">Blocked URLs</listBox>
      </presentation>
    </presentationTable>
  </resources>
</policyDefinitionResources>
"""

FIREFOX_ADMX = b"""<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0"
    xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="firefox" namespace="Mozilla.Policies.Firefox"/>
  </policyNamespaces>
  <resources minRequiredRevision="1.0"/>
  <categories><category name="firefox" displayName="Firefox"/></categories>
  <policies>
    <policy name="HomepageURL" class="Machine" displayName="Home page"
            key="Software\\Policies\\Mozilla\\Firefox\\Homepage" valueName="URL">
      <parentCategory ref="firefox"/>
      <elements>
        <text id="URL" valueName="URL"/>
      </elements>
    </policy>
  </policies>
</policyDefinitions>
"""


@pytest.fixture
def chrome() -> admx.Template:
    return admx.parse(CHROME_ADMX, CHROME_ADML, "chrome.admx")


# ------------------------------------------------------------------ parsing ---


def test_namespace_categories_and_localisation(chrome):
    assert chrome.namespace == "Google.Policies.Chrome"
    assert chrome.prefix == "chrome"
    assert chrome.display_name == "Google Chrome"

    categories = {c.name: c for c in chrome.categories}
    assert categories["chrome:googlechrome"].display_name == "Google Chrome"
    assert categories["chrome:startup"].parent == "chrome:googlechrome"


def test_policies_resolve_their_adml_strings(chrome):
    policies = {p.id: p for p in chrome.policies}
    homepage = policies["Google.Policies.Chrome:HomepageLocation"]
    assert homepage.display_name == "Configure the home page URL"
    assert homepage.explain_text == "Configures the default home page URL."
    assert homepage.supported_on == "Microsoft Windows 7 or later"
    assert homepage.category == "chrome:startup"
    assert homepage.registry_key == r"Software\Policies\Google\Chrome"


def test_element_types_and_presentation_labels(chrome):
    policies = {p.id: p for p in chrome.policies}

    text = policies["Google.Policies.Chrome:HomepageLocation"].elements[0]
    assert (text.type, text.required, text.max_length) == ("text", True, 1000)
    assert text.label == "Home page URL"  # trailing colon trimmed

    enum = policies["Google.Policies.Chrome:IncognitoModeAvailability"].elements[0]
    assert enum.type == "enum"
    assert enum.items == [
        {"label": "Incognito mode available", "value": 0},
        {"label": "Incognito mode disabled", "value": 1},
    ]

    listing = policies["Google.Policies.Chrome:URLBlocklist"].elements[0]
    assert listing.type == "list"


def test_enabled_and_disabled_values(chrome):
    metrics = next(p for p in chrome.policies if p.name == "MetricsReportingEnabled")
    assert (metrics.enabled_value, metrics.disabled_value) == (1, 0)


def test_parsing_without_adml_still_works():
    template = admx.parse(CHROME_ADMX, None, "chrome.admx")
    assert len(template.policies) == 5
    # Without a string table, the raw reference is kept rather than invented.
    assert template.display_name == "chrome.admx"


@pytest.mark.parametrize(
    "payload",
    [
        b"not xml at all",
        b"<policyDefinitions/>",  # no target namespace
        b"<somethingElse/>",
    ],
)
def test_malformed_templates_are_rejected(payload):
    with pytest.raises(admx.AdmxError):
        admx.parse(payload, None, "bad.admx")


def test_entity_expansion_is_refused():
    # A billion-laughs payload must not be expanded by the parser.
    bomb = b"""<?xml version="1.0"?>
    <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
    <policyDefinitions><policyNamespaces>
    <target prefix="x" namespace="X.Y">&lol2;</target>
    </policyNamespaces></policyDefinitions>"""
    with pytest.raises(admx.AdmxError):
        admx.parse(bomb, None, "bomb.admx")


def test_oversized_upload_is_refused():
    with pytest.raises(admx.AdmxError):
        admx.parse(b"x" * (admx.MAX_BYTES + 1), None, "huge.admx")


# ---------------------------------------------------------------- expansion ---


def definitions(*templates: admx.Template) -> dict[str, admx.Policy]:
    return {p.id: p for template in templates for p in template.policies}


def test_text_element_becomes_a_chromium_policy(chrome):
    settings, notes = admx.expand(
        [
            {
                "policy_id": "Google.Policies.Chrome:HomepageLocation",
                "state": "enabled",
                "values": {"HomepageLocation": "https://intranet.example.org"},
            }
        ],
        definitions(chrome),
    )
    assert settings == {"chromium": {"HomepageLocation": "https://intranet.example.org"}}
    assert notes == []


def test_list_element_becomes_a_json_array(chrome):
    settings, _ = admx.expand(
        [
            {
                "policy_id": "Google.Policies.Chrome:URLBlocklist",
                "state": "enabled",
                "values": {"URLBlocklistDesc": ["example.com", "gambling.example"]},
            }
        ],
        definitions(chrome),
    )
    assert settings["chromium"]["URLBlocklist"] == ["example.com", "gambling.example"]


def test_policy_without_elements_uses_its_enabled_value(chrome):
    enabled, _ = admx.expand(
        [{"policy_id": "Google.Policies.Chrome:MetricsReportingEnabled", "state": "enabled"}],
        definitions(chrome),
    )
    disabled, _ = admx.expand(
        [{"policy_id": "Google.Policies.Chrome:MetricsReportingEnabled", "state": "disabled"}],
        definitions(chrome),
    )
    assert enabled["chromium"]["MetricsReportingEnabled"] == 1
    assert disabled["chromium"]["MetricsReportingEnabled"] == 0


def test_firefox_subkeys_nest_the_way_firefox_expects():
    firefox = admx.parse(FIREFOX_ADMX, None, "firefox.admx")
    settings, notes = admx.expand(
        [
            {
                "policy_id": "Mozilla.Policies.Firefox:HomepageURL",
                "state": "enabled",
                "values": {"URL": "https://intranet.example.org"},
            }
        ],
        definitions(firefox),
    )
    assert settings == {"firefox": {"Homepage": {"URL": "https://intranet.example.org"}}}
    assert notes == []


def test_windows_only_policies_are_reported_not_silently_dropped(chrome):
    settings, notes = admx.expand(
        [{"policy_id": "Google.Policies.Chrome:WindowsOnlyThing", "state": "enabled"}],
        definitions(chrome),
    )
    assert settings == {}
    assert len(notes) == 1 and "no Debian equivalent" in notes[0]["reason"]


def test_selection_for_a_removed_template_is_reported(chrome):
    _, notes = admx.expand([{"policy_id": "Gone.Namespace:Policy"}], definitions(chrome))
    assert notes == [{"policy": "Gone.Namespace:Policy", "reason": "template not imported"}]


def test_base64_round_trip_matches_what_the_upload_endpoint_receives(chrome):
    decoded = base64.b64decode(base64.b64encode(CHROME_ADMX), validate=True)
    assert len(admx.parse(decoded, CHROME_ADML, "chrome.admx").policies) == len(chrome.policies)
