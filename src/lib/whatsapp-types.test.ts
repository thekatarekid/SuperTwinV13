import { describe, it, expect } from "vitest";
import { displayName, isMaskedNumber, prettyPhone } from "./whatsapp-types";

// The frontend must recover a readable phone number from a chat's / actor's JID
// (source_ext_id) when the name is empty/placeholder — never show "Unknown" or a
// raw JID for a WhatsApp Business / @lid / notification sender.
describe("displayName", () => {
  it("keeps a real resolved name unchanged (JID ignored)", () => {
    expect(displayName("Mom", "919731006976@s.whatsapp.net")).toBe("Mom");
    // A real name with digits/letters (contract §1: has letters → REAL).
    expect(displayName("Shop 24x7", "12345@s.whatsapp.net")).toBe("Shop 24x7");
    expect(displayName("A1 Traders", null)).toBe("A1 Traders");
  });

  it("prettyPhones the source_ext_id when the name is null/empty", () => {
    // The headline case: nameless business chat → format its JID, not "Unknown".
    expect(displayName(null, "919731006976@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
    expect(displayName("", "919731006976@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
    expect(displayName("   ", "919731006976@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
  });

  it("prettyPhones a number/JID stored as the name (older worker / pre-fix rows)", () => {
    expect(displayName("919731006976@s.whatsapp.net")).toBe("+91 97310 06976");
    expect(displayName("919731006976")).toBe("+91 97310 06976");
    // Name is number-ish but a JID fallback is also present → still formats.
    expect(displayName("+919731006976", "somethingelse@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
  });

  it("falls back to the placeholder when there is no usable name or number", () => {
    // A group with no name + a group JID (18+ digit local part → not a phone).
    expect(displayName(null, "120363000000000000@g.us")).toBe("Unknown");
    expect(displayName(null, null)).toBe("Unknown");
    expect(displayName(null, undefined)).toBe("Unknown");
    // Honours a custom fallback (3rd arg).
    expect(displayName(null, "120363000000000000@g.us", "Unknown chat")).toBe(
      "Unknown chat",
    );
    // Empty-string fallback (actor labels): nothing to show → "".
    expect(displayName(null, "120363000000000000@g.us", "")).toBe("");
  });

  it("never fabricates a number from a non-phone JID server", () => {
    // A @lid JID's local part is a WhatsApp privacy identifier, NOT a phone
    // number — pretty-printing it would fabricate a bogus "+19 6024…" number.
    expect(displayName(null, "19602432098323@lid")).toBe("Unknown");
    expect(displayName("", "19602432098323@lid")).toBe("Unknown");
    // Groups, newsletters and broadcasts are likewise not phone numbers.
    expect(displayName(null, "120363000000000000@g.us")).toBe("Unknown");
    expect(displayName(null, "120363000000000000@newsletter")).toBe("Unknown");
    expect(displayName(null, "status@broadcast")).toBe("Unknown");
    // A real phone-number JID (s.whatsapp.net) still formats.
    expect(displayName(null, "919731006976@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
    // A resolved name always wins, even over a @lid JID.
    expect(displayName("Acme Corp", "19602432098323@lid")).toBe("Acme Corp");
  });

  it("labels WhatsApp's own system accounts, which carry no name", () => {
    // "0" is the PSA/announcements account. Its local part is not a phone
    // number, so prettyPhone() refuses it and there is nothing else to show.
    expect(displayName(null, "0@s.whatsapp.net")).toBe("WhatsApp");
    expect(displayName("", "0@c.us")).toBe("WhatsApp");
    // The official WhatsApp business number too.
    expect(displayName(null, "16505361212@s.whatsapp.net")).toBe("WhatsApp");
    // Rows written before the daemon fix stored the JID AS the name.
    expect(displayName("0@s.whatsapp.net")).toBe("WhatsApp");
    // Case-insensitive.
    expect(displayName(null, "0@S.WhatsApp.Net")).toBe("WhatsApp");
    // A real name still wins over the well-known label.
    expect(displayName("WhatsApp Support", "0@s.whatsapp.net")).toBe(
      "WhatsApp Support",
    );
    // Status/Stories is NOT the WhatsApp account — still the placeholder.
    expect(displayName(null, "status@broadcast")).toBe("Unknown");
  });

  it("does not render a privacy-masked number as raw stars", () => {
    // Masked name, no JID → placeholder; masked name + JID → the real number.
    expect(displayName("+91••••••15", null)).toBe("Unknown");
    expect(displayName("+91••••••15", "919731006976@s.whatsapp.net")).toBe(
      "+91 97310 06976",
    );
  });
});

describe("isMaskedNumber", () => {
  it("flags masked numbers but never real names", () => {
    expect(isMaskedNumber("+91••••••15")).toBe(true);
    expect(isMaskedNumber("Mom")).toBe(false);
    expect(isMaskedNumber("Shop 24x7")).toBe(false); // has letters
  });
});

describe("prettyPhone", () => {
  it("formats an Indian number and rejects group JIDs", () => {
    expect(prettyPhone("919731006976@s.whatsapp.net")).toBe("+91 97310 06976");
    expect(prettyPhone("120363000000000000@g.us")).toBeNull();
  });
});
