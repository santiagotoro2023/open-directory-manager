import type { SearchOption } from "../components/SearchSelect";

/**
 * What the regional-settings editor offers to choose from. Names come from
 * the browser's own locale data (Intl.DisplayNames), so the list here is
 * codes only: the glibc locales Debian's locales package generates, the XKB
 * layouts and their common variants from xkeyboard-config, and the IANA time
 * zones the browser knows.
 */

const LOCALE_CODES = [
  "en_US", "en_GB", "en_AU", "en_CA", "en_IE", "en_NZ", "en_ZA", "en_IN", "en_SG",
  "de_DE", "de_AT", "de_CH", "de_LI", "de_LU", "de_BE",
  "fr_FR", "fr_CH", "fr_BE", "fr_CA", "fr_LU",
  "it_IT", "it_CH", "rm_CH",
  "es_ES", "es_MX", "es_AR", "es_CL", "es_CO", "es_US",
  "pt_PT", "pt_BR",
  "nl_NL", "nl_BE",
  "da_DK", "sv_SE", "nb_NO", "nn_NO", "fi_FI", "is_IS",
  "pl_PL", "cs_CZ", "sk_SK", "hu_HU", "ro_RO", "bg_BG", "hr_HR", "sl_SI", "sr_RS",
  "el_GR", "tr_TR",
  "ru_RU", "uk_UA", "be_BY", "lt_LT", "lv_LV", "et_EE",
  "ga_IE", "cy_GB", "eu_ES", "ca_ES", "gl_ES",
  "he_IL", "ar_SA", "ar_EG", "ar_AE", "ar_MA", "fa_IR",
  "hi_IN", "bn_BD", "ta_IN", "te_IN", "ur_PK",
  "zh_CN", "zh_TW", "zh_HK", "ja_JP", "ko_KR", "th_TH", "vi_VN", "id_ID", "ms_MY", "fil_PH",
  "sw_KE", "af_ZA", "am_ET",
];

const languageNames = safeDisplayNames("language");
const regionNames = safeDisplayNames("region");

function safeDisplayNames(type: "language" | "region"): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames(["en"], { type });
  } catch {
    return null;
  }
}

function describeLocale(code: string): string {
  const [language, region] = code.split("_");
  const lang = languageNames?.of(language) ?? language;
  const reg = region ? regionNames?.of(region) ?? region : "";
  return reg ? `${lang} (${reg})` : lang;
}

export const LOCALE_OPTIONS: SearchOption[] = LOCALE_CODES.map((code) => ({
  value: `${code}.UTF-8`,
  label: describeLocale(code),
  hint: `${code}.UTF-8`,
})).sort((a, b) => a.label.localeCompare(b.label));

/** XKB layouts (xkeyboard-config base.lst), with their common variants. */
export const KEYBOARD_LAYOUTS: { code: string; name: string; variants: [string, string][] }[] = [
  { code: "us", name: "English (US)", variants: [["intl", "International, with dead keys"], ["altgr-intl", "International, AltGr dead keys"], ["dvorak", "Dvorak"], ["colemak", "Colemak"], ["mac", "Macintosh"], ["euro", "Euro on 5"]] },
  { code: "gb", name: "English (UK)", variants: [["extd", "Extended, Windows"], ["intl", "International, with dead keys"], ["dvorak", "Dvorak"], ["mac", "Macintosh"]] },
  { code: "de", name: "German", variants: [["nodeadkeys", "No dead keys"], ["deadgraveacute", "Dead grave and acute"], ["deadacute", "Dead acute"], ["neo", "Neo 2"], ["mac", "Macintosh"], ["dvorak", "Dvorak"], ["qwerty", "QWERTY"], ["T3", "T3"]] },
  { code: "ch", name: "German (Switzerland)", variants: [["de_nodeadkeys", "German, no dead keys"], ["fr", "French"], ["fr_nodeadkeys", "French, no dead keys"], ["de_mac", "German, Macintosh"], ["fr_mac", "French, Macintosh"], ["legacy", "Legacy"]] },
  { code: "at", name: "German (Austria)", variants: [["nodeadkeys", "No dead keys"], ["mac", "Macintosh"]] },
  { code: "fr", name: "French", variants: [["nodeadkeys", "No dead keys"], ["oss", "Alternative"], ["oss_nodeadkeys", "Alternative, no dead keys"], ["latin9", "Legacy, alternative"], ["bepo", "BEPO"], ["azerty", "AZERTY"], ["mac", "Macintosh"], ["dvorak", "Dvorak"]] },
  { code: "be", name: "Belgian", variants: [["oss", "Alternative"], ["nodeadkeys", "No dead keys"], ["wang", "Wang 724"]] },
  { code: "ca", name: "French (Canada)", variants: [["fr-dvorak", "Dvorak"], ["fr-legacy", "Legacy"], ["multix", "Multilingual"], ["eng", "English"]] },
  { code: "it", name: "Italian", variants: [["nodeadkeys", "No dead keys"], ["winkeys", "Windows"], ["mac", "Macintosh"], ["us", "US, with Italian letters"]] },
  { code: "es", name: "Spanish", variants: [["nodeadkeys", "No dead keys"], ["winkeys", "Windows"], ["deadtilde", "Dead tilde"], ["dvorak", "Dvorak"], ["mac", "Macintosh"], ["cat", "Catalan, with middle-dot L"], ["ast", "Asturian"]] },
  { code: "latam", name: "Spanish (Latin America)", variants: [["nodeadkeys", "No dead keys"], ["deadtilde", "Dead tilde"], ["dvorak", "Dvorak"], ["colemak", "Colemak"]] },
  { code: "pt", name: "Portuguese", variants: [["nodeadkeys", "No dead keys"], ["mac", "Macintosh"], ["nativo", "Nativo"]] },
  { code: "br", name: "Portuguese (Brazil)", variants: [["nodeadkeys", "No dead keys"], ["dvorak", "Dvorak"], ["nativo", "Nativo"], ["thinkpad", "ThinkPad"]] },
  { code: "nl", name: "Dutch", variants: [["us", "US, with Dutch letters"], ["mac", "Macintosh"], ["std", "Standard"]] },
  { code: "dk", name: "Danish", variants: [["nodeadkeys", "No dead keys"], ["winkeys", "Windows"], ["mac", "Macintosh"], ["dvorak", "Dvorak"]] },
  { code: "se", name: "Swedish", variants: [["nodeadkeys", "No dead keys"], ["mac", "Macintosh"], ["dvorak", "Dvorak"], ["svdvorak", "Svdvorak"], ["us", "US, with Swedish letters"]] },
  { code: "no", name: "Norwegian", variants: [["nodeadkeys", "No dead keys"], ["winkeys", "Windows"], ["mac", "Macintosh"], ["dvorak", "Dvorak"], ["colemak", "Colemak"]] },
  { code: "fi", name: "Finnish", variants: [["nodeadkeys", "No dead keys"], ["winkeys", "Windows"], ["mac", "Macintosh"], ["classic", "Classic"]] },
  { code: "is", name: "Icelandic", variants: [["mac", "Macintosh"], ["dvorak", "Dvorak"]] },
  { code: "ie", name: "Irish", variants: [["UnicodeExpert", "Unicode expert"], ["CloGaelach", "CloGaelach"]] },
  { code: "pl", name: "Polish", variants: [["legacy", "Legacy"], ["qwertz", "QWERTZ"], ["dvorak", "Dvorak"], ["dvp", "Programmer Dvorak"]] },
  { code: "cz", name: "Czech", variants: [["qwerty", "QWERTY"], ["qwerty_bksl", "QWERTY, extended backslash"], ["ucw", "UCW"], ["dvorak-ucw", "Dvorak UCW"]] },
  { code: "sk", name: "Slovak", variants: [["qwerty", "QWERTY"], ["bksl", "Extended backslash"], ["qwerty_bksl", "QWERTY, extended backslash"]] },
  { code: "hu", name: "Hungarian", variants: [["standard", "Standard"], ["nodeadkeys", "No dead keys"], ["qwerty", "QWERTY"], ["101_qwertz_comma_dead", "101, QWERTZ, comma, dead keys"]] },
  { code: "ro", name: "Romanian", variants: [["std", "Standard"], ["winkeys", "Windows"]] },
  { code: "bg", name: "Bulgarian", variants: [["phonetic", "Traditional phonetic"], ["bas_phonetic", "New phonetic"]] },
  { code: "hr", name: "Croatian", variants: [["us", "US, with Croatian letters"], ["unicode", "Unicode"], ["alternatequotes", "Alternate quotes"]] },
  { code: "si", name: "Slovenian", variants: [["us", "US, with Slovenian letters"], ["alternatequotes", "Alternate quotes"]] },
  { code: "rs", name: "Serbian", variants: [["latin", "Latin"], ["latinunicode", "Latin, Unicode"], ["yz", "Latin, QWERTY"]] },
  { code: "gr", name: "Greek", variants: [["simple", "Simple"], ["extended", "Extended"], ["nodeadkeys", "No dead keys"], ["polytonic", "Polytonic"]] },
  { code: "tr", name: "Turkish", variants: [["f", "F"], ["alt", "Alt-Q"], ["intl", "International, with dead keys"]] },
  { code: "ru", name: "Russian", variants: [["phonetic", "Phonetic"], ["typewriter", "Typewriter"], ["legacy", "Legacy"], ["mac", "Macintosh"]] },
  { code: "ua", name: "Ukrainian", variants: [["phonetic", "Phonetic"], ["typewriter", "Typewriter"], ["winkeys", "Windows"], ["legacy", "Legacy"]] },
  { code: "by", name: "Belarusian", variants: [["legacy", "Legacy"], ["latin", "Latin"]] },
  { code: "lt", name: "Lithuanian", variants: [["std", "Standard"], ["us", "US, with Lithuanian letters"], ["ibm", "IBM LST 1205-92"]] },
  { code: "lv", name: "Latvian", variants: [["apostrophe", "Apostrophe"], ["tilde", "Tilde"], ["fkey", "F"], ["modern", "Modern"]] },
  { code: "ee", name: "Estonian", variants: [["nodeadkeys", "No dead keys"], ["dvorak", "Dvorak"], ["us", "US, with Estonian letters"]] },
  { code: "il", name: "Hebrew", variants: [["lyx", "lyx"], ["phonetic", "Phonetic"], ["biblical", "Biblical, Tiro"]] },
  { code: "ara", name: "Arabic", variants: [["azerty", "AZERTY"], ["azerty_digits", "AZERTY, Eastern Arabic numerals"], ["qwerty", "QWERTY"], ["qwerty_digits", "QWERTY, Eastern Arabic numerals"], ["mac", "Macintosh"]] },
  { code: "ir", name: "Persian", variants: [["pes_keypad", "Keypad"]] },
  { code: "in", name: "Indian", variants: [["deva", "Hindi, Devanagari"], ["bolnagri", "Hindi, Bolnagri"], ["hin-wx", "Hindi, Wx"], ["tam", "Tamil"], ["tel", "Telugu"], ["ben", "Bengali"], ["guj", "Gujarati"], ["urd-phonetic", "Urdu, phonetic"], ["eng", "English, with rupee"]] },
  { code: "cn", name: "Chinese", variants: [["tib", "Tibetan"], ["ug", "Uyghur"], ["mon_trad", "Mongolian, traditional"]] },
  { code: "tw", name: "Taiwanese", variants: [["indigenous", "Indigenous"], ["saisiyat", "Saisiyat"]] },
  { code: "jp", name: "Japanese", variants: [["kana", "Kana"], ["OADG109A", "OADG 109A"], ["mac", "Macintosh"], ["dvorak", "Dvorak"]] },
  { code: "kr", name: "Korean", variants: [["kr104", "101/104-key compatible"]] },
  { code: "th", name: "Thai", variants: [["tis", "TIS-820.2538"], ["pat", "Pattachote"]] },
  { code: "vn", name: "Vietnamese", variants: [["us", "US, with Vietnamese letters"], ["fr", "French, with Vietnamese letters"]] },
  { code: "za", name: "South African", variants: [] },
  { code: "ke", name: "Swahili (Kenya)", variants: [["kik", "Kikuyu"]] },
  { code: "et", name: "Amharic", variants: [] },
  { code: "epo", name: "Esperanto", variants: [["legacy", "Legacy"]] },
];

export const KEYBOARD_LAYOUT_OPTIONS: SearchOption[] = KEYBOARD_LAYOUTS.map((layout) => ({
  value: layout.code,
  label: layout.name,
  hint: layout.code,
})).sort((a, b) => a.label.localeCompare(b.label));

export function keyboardVariantOptions(layout: string): SearchOption[] {
  const found = KEYBOARD_LAYOUTS.find((entry) => entry.code === layout);
  return (found?.variants ?? []).map(([code, name]) => ({ value: code, label: name, hint: code }));
}

function timeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    if (supported) return supported("timeZone");
  } catch {
    // an older browser: the short list below
  }
  return [
    "Etc/UTC", "Europe/Zurich", "Europe/Berlin", "Europe/Vienna", "Europe/Paris", "Europe/Rome",
    "Europe/Madrid", "Europe/Lisbon", "Europe/London", "Europe/Dublin", "Europe/Amsterdam",
    "Europe/Brussels", "Europe/Copenhagen", "Europe/Stockholm", "Europe/Oslo", "Europe/Helsinki",
    "Europe/Warsaw", "Europe/Prague", "Europe/Budapest", "Europe/Athens", "Europe/Istanbul",
    "Europe/Moscow", "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo", "America/Mexico_City",
    "Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "Asia/Kolkata", "Asia/Dubai",
    "Australia/Sydney", "Pacific/Auckland", "Africa/Johannesburg", "Africa/Cairo",
  ];
}

function offsetOf(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date());
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export const TIMEZONE_OPTIONS: SearchOption[] = timeZones()
  .filter((zone) => zone.includes("/") || zone === "UTC")
  .map((zone) => ({
    value: zone === "UTC" ? "Etc/UTC" : zone,
    label: zone.replace(/_/g, " "),
    hint: offsetOf(zone),
    keywords: zone.split("/").pop()?.replace(/_/g, " ") ?? "",
  }));

if (!TIMEZONE_OPTIONS.some((option) => option.value === "Etc/UTC")) {
  TIMEZONE_OPTIONS.unshift({ value: "Etc/UTC", label: "UTC", hint: "GMT" });
}
