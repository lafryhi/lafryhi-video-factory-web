import { describe, expect, it } from "vitest";
import { exportPackage, masterPrompt, preparePackage, preschoolStyle, scenePrompt, suggestCharacter } from "./flowProduction";

const input = { idea: "A red fox learns colors. Then the fox sorts blocks. The fox celebrates.", audience: "Preschool / kids" as const, format: "9:16" as const, targetDuration: 30, masterCharacter: "Red fox cub, blue scarf, white tail tip.", style: preschoolStyle };
describe("Flow production planning", () => {
  it.each([4, 5, 8, 9, 30, 45, 60, 77, 600])("allocates exactly %i seconds with no empty or oversized scenes", targetDuration => {
    const pkg = preparePackage({ ...input, targetDuration });
    expect(pkg.scenes.reduce((sum, scene) => sum + scene.duration, 0)).toBe(targetDuration);
    expect(pkg.scenes.every(scene => scene.duration > 0 && scene.duration <= 8)).toBe(true);
  });
  it.each([0, -1, 3, 600.5, 601, NaN, Infinity])("rejects invalid runtime %s", targetDuration => {
    expect(() => preparePackage({ ...input, targetDuration })).toThrow("duration");
  });
  it("rejects an empty idea or continuity definition", () => {
    expect(() => preparePackage({ ...input, idea: " " })).toThrow("idea");
    expect(() => preparePackage({ ...input, masterCharacter: " " })).toThrow("character");
  });
  it("keeps all story beats, shared identity, safety, and format in the prompts", () => {
    const pkg = preparePackage(input);
    const master = masterPrompt(pkg);
    expect(master).toContain("sorts blocks");
    expect(master).toContain("celebrates");
    pkg.scenes.forEach((scene, i) => {
      const prompt = scenePrompt(pkg, scene, i);
      expect(prompt).toContain(input.masterCharacter);
      expect(prompt).toContain("Ages 3–8");
      expect(prompt).toContain("no scary content");
      expect(prompt).toContain("9:16");
      expect(Object.values(scene).every(Boolean)).toBe(true);
    });
  });
  it("exports updated scene fields and continuity in all three formats", () => {
    const pkg = preparePackage(input);
    pkg.masterCharacter = "The same green turtle with a yellow hat.";
    pkg.scenes[0].action = "The turtle points to a red block.";
    for (const format of ["txt", "md", "json"] as const) {
      const output = exportPackage(pkg, format);
      expect(output).toContain(pkg.masterCharacter);
      expect(output).toContain(pkg.scenes[0].action);
      expect(output).toContain("Paste Scene 1 Prompt first");
    }
    const json = JSON.parse(exportPackage(pkg, "json"));
    expect(json.scenes[0].prompt).toBe(scenePrompt(pkg, pkg.scenes[0], 0));
    expect(json.targetDuration).toBe(30);
  });
  it("suggests a subject from the idea without discarding its identity", () => {
    expect(suggestCharacter("A red fox learns colors.")).toContain("Main subject: A red fox.");
  });
});
