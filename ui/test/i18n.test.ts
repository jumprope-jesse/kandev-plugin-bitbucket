import { describe, expect, it } from "vitest";
import { translateEnglish, translationCatalogs } from "../src/i18n";

describe("plugin translation catalogs", () => {
  it("keeps pseudo messages structurally aligned with English", () => {
    expect(Object.keys(translationCatalogs.pseudo).sort()).toEqual(
      Object.keys(translationCatalogs.en).sort(),
    );
    for (const [key, english] of Object.entries(translationCatalogs.en)) {
      const pseudo = translationCatalogs.pseudo[key];
      expect(pseudo).toBeDefined();
      expect(pseudo.match(/\{\{[^}]+\}\}/g) ?? []).toEqual(
        english.match(/\{\{[^}]+\}\}/g) ?? [],
      );
    }
  });

  it("uses count-aware English fallback messages", () => {
    expect(translateEnglish("watchDeleteWarning", { count: 1 })).toContain(
      "1 plugin-owned task.",
    );
    expect(translateEnglish("watchDeleteWarning", { count: 2 })).toContain(
      "2 plugin-owned tasks.",
    );
  });
});
