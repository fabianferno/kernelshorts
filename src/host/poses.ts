/**
 * The host's pose library — one still drawing per pose, swapped on trigger
 * words in the voiceover, plus a mouth-open twin of each so the mouth can flap
 * with the audio. (Technique from the OnePrompt teardown, docs/oneprompt-teardown.md §1.)
 *
 * This catalog is the single source of truth for BOTH sides:
 *  - scripts/gen-host.ts asks the image generator for every pose listed here;
 *  - the compositor maps VO words → pose with `poseForWord`.
 *
 * Files live in vault/host/poses/ (gitignored):
 *   <id>.png        mouth closed, transparent background
 *   <id>-open.png   mouth open,   transparent background
 *   <id>.green.jpg  the raw generator output, kept so re-keying never needs a re-generate
 */

export interface PoseSpec {
  id: string;
  /** What the image generator is asked to draw. */
  prompt: string;
  /**
   * Lowercased words/phrases in the VO that switch the host to this pose.
   * Matched against the word stream; multi-word phrases match consecutive words.
   */
  triggers: string[];
}

export const DEFAULT_POSE = "talk";

export const POSES: PoseSpec[] = [
  {
    id: "talk",
    prompt: "relaxed explaining gesture: right hand open palm-up at chest height, left arm relaxed at side",
    triggers: [],
  },
  {
    id: "idle",
    prompt: "neutral standing, both arms relaxed down at the sides, calm confident expression",
    triggers: [],
  },
  {
    id: "point-up",
    prompt: "raising the right index finger straight up beside the head, like making a first point",
    triggers: ["first", "one", "did you know"],
  },
  {
    id: "two",
    prompt: "holding up the right hand showing two fingers (index and middle) to count 'two'",
    triggers: ["second", "two"],
  },
  {
    id: "three",
    prompt: "holding up the right hand showing three fingers to count 'three'",
    triggers: ["third", "three"],
  },
  {
    id: "shrug",
    prompt: "shrug: both palms up at shoulder height, slight head tilt",
    triggers: ["why", "so why", "how"],
  },
  {
    id: "stop",
    prompt: "right hand raised flat with the palm facing the viewer, like a firm 'stop'",
    triggers: ["not", "no", "never", "don't", "isn't", "wasn't"],
  },
  {
    id: "thumbs-up",
    prompt: "right thumb up at chest height, confident smile",
    triggers: ["yes", "approved", "works", "right", "good"],
  },
  {
    id: "wave",
    prompt: "friendly wave with the right hand raised beside the head, open palm",
    triggers: ["follow", "hi", "hello"],
  },
  {
    id: "point-stage",
    prompt:
      "pointing up and to the viewer's left with the right index finger, as if pointing at something above the head",
    triggers: ["this", "look", "here", "meet", "these"],
  },
  {
    id: "think",
    prompt: "thinking: right hand on the chin, head slightly tilted, looking curious",
    triggers: ["imagine", "think", "wonder", "guess"],
  },
  {
    id: "catch",
    prompt: "one eyebrow raised over the sunglasses, right index finger raised to the side as in 'but wait'",
    triggers: ["but", "catch", "twist", "wait", "however"],
  },
  {
    id: "wide",
    prompt: "both arms spread wide apart, palms open, impressed expression, as if showing something huge",
    triggers: ["billion", "million", "huge", "biggest", "every", "entire"],
  },
  {
    id: "hand-chest",
    prompt: "right hand flat on the chest, sincere expression, as in 'me'",
    triggers: ["i", "my", "me", "i'm"],
  },
  {
    id: "phone",
    prompt: "holding a smartphone in the right hand at chest height, screen facing the viewer, smiling",
    triggers: ["comment", "send", "share", "link"],
  },
  {
    id: "ok",
    prompt: "making an OK sign with the right hand at chest height",
    triggers: ["exactly", "perfect", "okay", "ok"],
  },
  // ── second batch: the reference creator runs ~25 poses; frequent, relevant
  //    swaps are what make the host feel alive rather than pasted on. ─────────
  {
    id: "talk-2",
    prompt: "explaining with the LEFT hand open at chest height, right arm relaxed — mirror of a casual talking gesture",
    triggers: [],
  },
  {
    id: "four",
    prompt: "holding up the right hand showing four fingers (thumb folded) to count 'four'",
    triggers: ["fourth", "four"],
  },
  {
    id: "point-viewer",
    prompt: "pointing straight at the viewer with the right index finger, foreshortened toward the camera, confident grin",
    triggers: ["you", "your", "you're"],
  },
  {
    id: "arms-crossed",
    prompt: "arms crossed over the chest, skeptical expression",
    triggers: ["problem", "wrong", "fails", "fail"],
  },
  {
    id: "facepalm",
    prompt: "right palm pressed to the forehead above the sunglasses in a facepalm",
    triggers: ["mistake", "oops", "failed", "glitch"],
  },
  {
    id: "pinch",
    prompt: "right thumb and index finger held a few millimetres apart at eye level, as if showing something tiny",
    triggers: ["tiny", "small", "little", "only"],
  },
  {
    id: "money",
    prompt: "right hand raised rubbing thumb against fingertips in the 'money' gesture, knowing smile",
    triggers: ["money", "dollars", "price", "cost", "francs", "paid", "paying"],
  },
  {
    id: "mind-blown",
    prompt: "both hands at the temples, fingers spread outward as if mind-blown, mouth in a surprised smile",
    triggers: ["insane", "crazy", "actually", "unbelievable"],
  },
  {
    id: "secret",
    prompt: "leaning slightly forward with the right hand cupped beside the mouth, as if telling a secret",
    triggers: ["secret", "trick", "nobody", "quietly"],
  },
];

/**
 * Poses the host cycles through when no trigger word fires, so the host never
 * holds one drawing for long. The reference creator changes pose every
 * ~1.5–2.5 s; at 2.8 s ours read as frozen ("looks absurd"), so HOLD_MAX_S is
 * 1.7 s.
 */
export const IDLE_CYCLE = ["talk", "talk-2", "idle"];
/**
 * When fewer than 3 idle poses are drawn, these neutral gestures also fill
 * the cycle — a gesture that matches no word still beats a frozen host.
 */
export const SOFT_POSES = ["talk", "talk-2", "idle", "shrug", "point-stage", "think", "hand-chest", "ok", "wide"];
export const HOLD_MAX_S = 1.7;
/** Shortest a pose may stay up, so back-to-back triggers don't strobe. */
export const HOLD_MIN_S = 0.5;

const BY_ID = new Map(POSES.map((p) => [p.id, p]));

export function getPose(id: string): PoseSpec {
  const pose = BY_ID.get(id);
  if (!pose) throw new Error(`unknown pose "${id}"`);
  return pose;
}

/** Normalizes a VO token for trigger matching: lowercase, strip punctuation. */
export function normalizeToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, "");
}

/**
 * Walks a word stream and returns the pose each word index switches to, or
 * undefined where nothing triggers. Multi-word triggers win over single words
 * (so "so why" beats "why"), and the longest phrase is tried first.
 */
export function posesForWords(words: string[]): Array<string | undefined> {
  const tokens = words.map(normalizeToken);
  const phrases = POSES.flatMap((p) =>
    p.triggers.map((t) => ({ pose: p.id, parts: t.split(/\s+/) })),
  ).sort((a, b) => b.parts.length - a.parts.length);

  const out: Array<string | undefined> = new Array(tokens.length).fill(undefined);
  for (let i = 0; i < tokens.length; i++) {
    for (const { pose, parts } of phrases) {
      if (parts.every((part, k) => tokens[i + k] === part)) {
        out[i] = pose;
        break;
      }
    }
  }
  return out;
}
