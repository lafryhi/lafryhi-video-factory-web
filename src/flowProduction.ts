export type Audience = "Preschool / kids" | "General" | "Educational" | "Entertainment";
export type FlowStyle = {
  visualStyle: string; colors: string; lighting: string; animationStyle: string;
  cameraStyle: string; ageAppropriateness: string; safetyConstraints: string;
};
export type FlowScene = {
  title: string; duration: number; visualDescription: string; cameraDirection: string;
  action: string; environment: string; lighting: string; audio: string;
  narration: string; negativeGuidance: string; transition: string;
};
export type FlowPackage = {
  version: 1; idea: string; audience: Audience; format: "9:16" | "16:9";
  targetDuration: number; masterCharacter: string; style: FlowStyle; scenes: FlowScene[];
};
export const preschoolStyle: FlowStyle = {
  visualStyle: "Cheerful 3D animation with friendly characters and rounded shapes",
  colors: "Bright, clean colors; consistent character and environment palette",
  lighting: "Bright daylight, soft shadows, warm faces",
  animationStyle: "Smooth movement, simple actions, readable expressions",
  cameraStyle: "Gentle cinematic movement at character eye level; strong visual continuity",
  ageAppropriateness: "Ages 3–8; simple language, patient pacing, one clear action at a time",
  safetyConstraints: "Safe behavior only; no scary content, violence, dangerous imitation, or distress. No text inside the video unless explicitly requested in the idea.",
};
export const generalStyle: FlowStyle = {
  visualStyle: "Cinematic illustration with consistent materials and believable proportions",
  colors: "Balanced warm colors with a consistent palette",
  lighting: "Soft natural light with consistent direction",
  animationStyle: "Natural, smooth movement and clear actions",
  cameraStyle: "Stable cinematic framing and deliberate camera movement",
  ageAppropriateness: "Accessible to a general audience",
  safetyConstraints: "Safe, respectful behavior; no graphic violence. No text inside the video unless explicitly requested in the idea.",
};
export const styleLabels: Record<keyof FlowStyle, string> = {
  visualStyle: "Visual style", colors: "Colors", lighting: "Lighting", animationStyle: "Animation style",
  cameraStyle: "Camera style", ageAppropriateness: "Age appropriateness", safetyConstraints: "Safety constraints",
};
export const sceneLabels: Record<Exclude<keyof FlowScene, "duration">, string> = {
  title: "Scene title", visualDescription: "Visual description", cameraDirection: "Camera direction",
  action: "Action", environment: "Environment", lighting: "Lighting", audio: "Audio / SFX suggestion",
  narration: "Narration or dialogue", negativeGuidance: "Negative guidance", transition: "Transition to next scene",
};

export function suggestCharacter(idea: string): string {
  const subject = idea.trim().split(/\b(?:learns?|learning|teaches?|teaching|discovers?|explores?|exploring|finds?|visits?|standing|walks?|helps?)\b/i)[0].replace(/[.!?].*$/, "").trim();
  return `Main subject: ${subject || "a friendly guide"}. Use the same recognizable appearance in every shot: warm brown eyes, rounded friendly face, consistent proportions, identical colors and clothing. Keep all distinguishing features, voice, size, and handedness unchanged. Supporting characters must also retain their appearance. No character substitutions between scenes.`;
}

export function preparePackage(input: Omit<FlowPackage, "version" | "scenes">): FlowPackage {
  const idea = input.idea.trim();
  if (!idea) throw new Error("Enter a video idea in English.");
  if (!Number.isInteger(input.targetDuration) || input.targetDuration < 4 || input.targetDuration > 600) {
    throw new Error("Choose a whole-number duration between 4 and 600 seconds.");
  }
  if (!input.masterCharacter.trim() || Object.values(input.style).some(value => !value.trim())) {
    throw new Error("Complete the master character and all global style fields.");
  }
  // Local story-beat templates: no external model, network call, or video generation.
  const beats = idea.split(/(?:[.!?;\n]+|\bthen\b)/i).map(s => s.trim().replace(/,$/, "")).filter(Boolean);
  if (!beats.length) throw new Error("Enter a descriptive video idea in English.");
  const count = Math.ceil(input.targetDuration / 8);
  const base = Math.floor(input.targetDuration / count);
  const extra = input.targetDuration % count;
  const phases = ["Establish", "Discover", "Demonstrate", "Practice", "Celebrate"];
  const cameras = ["Wide establishing shot; slow push toward the main subject", "Medium eye-level shot; gentle tracking movement", "Close-up of the main action; steady framing", "Medium shot; follow the action without crossing the screen axis", "Wide closing shot; gentle pull back"];
  const scenes = Array.from({ length: count }, (_, i): FlowScene => {
    const phase = count === 1 ? 2 : Math.floor(i / (count - 1) * 4);
    const start = Math.floor(i * beats.length / count);
    const end = Math.max(start + 1, Math.floor((i + 1) * beats.length / count));
    const beat = beats.slice(start, end).join(". ");
    const actions = [
      `Introduce the main subject and show the setting for: ${beat}. Hold a readable opening pose.`,
      `The main subject notices the key object or situation in: ${beat}. Show a clear, curious reaction.`,
      `Show one concrete action from: ${beat}. Present its beginning, movement, and visible result.`,
      `Continue the activity from: ${beat}. Repeat its key action slowly with a clear successful result.`,
      `Resolve the activity from: ${beat}. Show a satisfied reaction and hold a calm final pose.`,
    ];
    const educational = input.audience === "Educational" || input.audience === "Preschool / kids";
    return {
      title: `${i + 1}. ${phases[phase]} — ${beat.slice(0, 70)}`,
      duration: base + (i < extra ? 1 : 0),
      visualDescription: `${beat}. Show the same main subject, following the Global Style. Keep the important action clearly visible in ${input.format} framing.`,
      cameraDirection: cameras[phase], action: actions[phase],
      environment: `Use the setting described by the idea: ${idea}. If no location is specified, use a simple uncluttered courtyard. Preserve the same layout, props, and spatial relationships across shots.`,
      lighting: "Match the Global Style lighting exactly; preserve its direction and exposure between shots.",
      audio: "Soft ambient sound matching the setting; gentle movement sounds. Keep music low under speech, with no sudden loud effects.",
      narration: phase === 0 ? `Let's discover: ${beat}.` : phase === 4 ? `What a lovely moment! ${educational ? "Let's remember what we learned." : "See you next time!"}` : `${educational ? "Watch carefully: " : "Look! "}${beat}.`,
      negativeGuidance: "Avoid flicker, distorted anatomy, changing faces or costumes, extra limbs, abrupt camera jumps, logos, and watermarks. Follow the global age and safety constraints. Omit on-screen text unless explicitly requested in the idea.",
      transition: i === count - 1 ? "Hold the final pose, then fade out in editing." : "End on a stable pose. Match the subject position, gaze, props, and lighting in the next scene; use a clean cut in editing.",
    };
  });
  return { ...input, idea, version: 1, scenes };
}

export function styleText(style: FlowStyle): string {
  return (Object.keys(styleLabels) as (keyof FlowStyle)[]).map(key => `${styleLabels[key]}: ${style[key]}`).join("\n");
}
export function scenePrompt(pkg: FlowPackage, scene: FlowScene, index: number): string {
  return [
    `Scene ${index + 1} of ${pkg.scenes.length}: ${scene.title}`,
    `Production idea: ${pkg.idea}`,
    `Audience: ${pkg.audience}. Aspect ratio: ${pkg.format}. Planned edited duration: ${scene.duration} seconds.`,
    `Master Character Description / character continuity:\n${pkg.masterCharacter}`,
    `Global Style:\n${styleText(pkg.style)}`,
    ...Object.entries(sceneLabels).filter(([key]) => key !== "title").map(([key, label]) => `${label}: ${scene[key as Exclude<keyof FlowScene, "duration">]}`),
    index === 0 ? "Establish the visual reference for all subsequent scenes." : `Continue from scene ${index}; reuse the approved character and setting references, preserving the previous ending pose.`,
  ].join("\n\n");
}
export function allPrompts(pkg: FlowPackage): string {
  return pkg.scenes.map((scene, i) => scenePrompt(pkg, scene, i)).join("\n\n--------------------\n\n");
}
export function workflowText(pkg: FlowPackage): string {
  return `1. Review the Master Prompt as the whole-video brief.\n2. Paste Scene 1 Prompt first when creating the first clip; it already includes the master character and global style.\n3. Review that clip and retain an approved character/setting reference.\n4. Continue in order: ${pkg.scenes.map((_, i) => `Scene ${i + 1}`).join(" → ")}. Paste each complete scene prompt and reuse the same Master Character Description verbatim and the approved visual references.\n5. Match each previous ending pose before proceeding. Regenerate inconsistent shots before continuing.\n6. Scene durations are editing targets, not a guarantee of Flow output. Select an available clip length and trim or extend to the planned duration. Assemble clips in order in your editing workflow; add narration, music, captions, and transitions there as needed.`;
}
export function masterPrompt(pkg: FlowPackage): string {
  return `WHOLE-VIDEO PRODUCTION BRIEF\n${pkg.idea}\n\nAudience: ${pkg.audience}\nFormat: ${pkg.format}\nTarget runtime: ${pkg.targetDuration} seconds\n\nMaster Character Description:\n${pkg.masterCharacter}\n\nGlobal Style:\n${styleText(pkg.style)}\n\nScene-by-scene direction:\n${allPrompts(pkg)}\n\nMaintain one coherent story, stable character identity, and consistent visual geography throughout. This brief covers multiple clips; prepare them scene by scene.`;
}
export function exportPackage(pkg: FlowPackage, format: "txt" | "md" | "json"): string {
  if (format === "json") return JSON.stringify({ ...pkg, scenes: pkg.scenes.map((s, i) => ({ ...s, characterContinuity: pkg.masterCharacter, prompt: scenePrompt(pkg, s, i) })), masterPrompt: masterPrompt(pkg), workflow: workflowText(pkg) }, null, 2);
  const heading = format === "md" ? "# " : "";
  return `${heading}Google Flow Production Assistant\n\nPrepared locally using editable story templates. No video is generated.\n\n${heading}Master Prompt\n\n${masterPrompt(pkg)}\n\n${heading}Recommended Flow workflow\n\n${workflowText(pkg)}\n`;
}
