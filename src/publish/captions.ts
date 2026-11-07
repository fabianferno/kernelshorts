import { z } from "zod";

/**
 * What gets posted alongside the video. Written after Gate 3 (with the
 * instagram-marketing skill's ig-caption-writer for Instagram) and approved by
 * the user at Gate 4 — nothing here is generated at publish time.
 *
 * Limits are the platforms' own:
 *  - Instagram: caption ≤ 2200 chars, ≤ 30 hashtags, ≤ 20 @mentions
 *    (developers.facebook.com, IG User Media reference).
 *  - YouTube: title ≤ 100 chars, description ≤ 5000 bytes, no "<" or ">" in
 *    either, tags ≤ 500 chars in total (YouTube Data API videos resource).
 */
export const PostCaptions = z.object({
  instagram: z
    .object({
      caption: z.string().min(1),
    })
    .optional(),
  youtube: z
    .object({
      title: z.string().min(1),
      description: z.string().default(""),
      tags: z.array(z.string().min(1)).default([]),
    })
    .optional(),
});
export type PostCaptions = z.infer<typeof PostCaptions>;

/** Every problem with the captions, so one fix pass covers them all. */
export function captionProblems(c: PostCaptions): string[] {
  const out: string[] = [];
  if (!c.instagram && !c.youtube) out.push("captions name neither instagram nor youtube");

  if (c.instagram) {
    const cap = c.instagram.caption;
    if ([...cap].length > 2200) out.push(`instagram caption is ${[...cap].length} chars (max 2200)`);
    const tags = cap.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
    if (tags.length > 30) out.push(`instagram caption has ${tags.length} hashtags (max 30)`);
    const mentions = cap.match(/(^|\s)@[\w.]+/g) ?? [];
    if (mentions.length > 20) out.push(`instagram caption has ${mentions.length} @mentions (max 20)`);
  }

  if (c.youtube) {
    const { title, description, tags } = c.youtube;
    if ([...title].length > 100) out.push(`youtube title is ${[...title].length} chars (max 100)`);
    if (/[<>]/.test(title)) out.push("youtube title contains < or >");
    if (Buffer.byteLength(description, "utf8") > 5000)
      out.push(`youtube description is ${Buffer.byteLength(description, "utf8")} bytes (max 5000)`);
    if (/[<>]/.test(description)) out.push("youtube description contains < or >");
    // YouTube counts a tag with spaces as if it were quoted (+2) plus a comma between tags.
    const tagChars = tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
    if (tagChars > 500) out.push(`youtube tags total ${tagChars} chars (max 500)`);
  }
  return out;
}
